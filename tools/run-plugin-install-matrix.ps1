[CmdletBinding()]
param(
  [ValidatePattern('^[0-9a-f]{40}$')]
  [string]$SourceCommit = 'dd3cbfb1f10c29808193dee167f4d595e7046f38',

  [ValidatePattern('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')]
  [string]$Repository = 'cgzhao111/context-relay',

  [ValidatePattern('^[a-z0-9-]+$')]
  [string]$MarketplaceName = 'context-relay',

  [string]$OutputDirectory = (Join-Path (Get-Location) 'plugin-isolation-evidence'),

  [string]$CodexExecutable = 'codex',

  [switch]$FinalizeOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$expectedCodexVersion = '0.144.5'
$expectedNodeVersion = '22.23.2'
$pluginNames = @('context-relay', 'execution-budget', 'async-wait-guard')
$stage = 'initialization'
$failure = $null

if (Test-Path Env:CODEX_HOME) {
  throw 'CODEX_HOME must be unset: this evidence run uses the clean runner profile without a home override.'
}
if (-not $env:USERPROFILE) {
  throw 'USERPROFILE is required to verify the default Codex plugin cache location.'
}
if (-not $FinalizeOnly) {
  if ($env:GITHUB_ACTIONS -ne 'true' -or [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
    throw 'Installation evidence may run only on an ephemeral GitHub Actions runner. Use -FinalizeOnly for local artifact validation.'
  }
  $resolvedRunnerTemp = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')
  $resolvedOutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
  $runnerPrefix = $resolvedRunnerTemp + '\'
  if (-not $resolvedOutputDirectory.StartsWith($runnerPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'OutputDirectory must be a child of RUNNER_TEMP for an installation evidence run.'
  }
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$reportPath = Join-Path $OutputDirectory 'report.json'
$detailsPath = Join-Path $OutputDirectory 'matrix-details.json'
$eventsPath = Join-Path $OutputDirectory 'matrix-events.jsonl'
$scanResultPath = Join-Path $OutputDirectory 'privacy-scan.txt'
$checksumsPath = Join-Path $OutputDirectory 'checksums.sha256'
$cacheNamespace = Join-Path (Join-Path (Join-Path $env:USERPROFILE '.codex') 'plugins\cache') $MarketplaceName

$details = [ordered]@{
  schemaVersion = '1.0.0'
  evidenceType = 'codex-plugin-installation-isolation'
  status = 'running'
  startedAt = [DateTimeOffset]::UtcNow.ToString('o')
  completedAt = $null
  source = [ordered]@{
    repository = "https://github.com/$Repository"
    commit = $SourceCommit
  }
  environment = [ordered]@{
    os = if ($env:RUNNER_OS) { $env:RUNNER_OS } else { 'Windows' }
    nodeVersion = $null
    codexCliVersion = $null
  }
  boundaries = [ordered]@{
    codexHomeOverrideUsed = $false
    loginUsed = $false
    runtimeTriggerVerified = $false
    verifiedClaims = @('marketplace-source-commit', 'plugin-list-state', 'plugin-cache-state', 'independent-plugin-removal')
  }
  marketplace = [ordered]@{
    name = $MarketplaceName
    sourceCommitVerified = $false
    pluginVersions = [ordered]@{}
    sourceTrees = [ordered]@{}
  }
  diagnostics = [ordered]@{
    lastSnapshot = $null
  }
  steps = [System.Collections.Generic.List[object]]::new()
  failure = $null
}

$report = $null
$publicEvidenceScanPassed = $false
$finalizationFailure = $null
$temporaryScanDirectory = $null

if ($FinalizeOnly) {
  try {
    if (-not (Test-Path -LiteralPath $detailsPath -PathType Leaf)) {
      throw 'The sanitized matrix details are required before finalization.'
    }
    if (-not (Test-Path -LiteralPath $eventsPath -PathType Leaf)) {
      throw 'The sanitized matrix event log is required before finalization.'
    }
    $details = Get-Content -Raw -LiteralPath $detailsPath | ConvertFrom-Json
    $stage = 'public-evidence-scan'
    $temporaryScanDirectory = Join-Path 'evaluation\compatibility' '.plugin-isolation-scan'
    if (Test-Path -LiteralPath $temporaryScanDirectory) {
      Remove-Item -LiteralPath $temporaryScanDirectory -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $temporaryScanDirectory | Out-Null
    Copy-Item -LiteralPath $detailsPath -Destination (Join-Path $temporaryScanDirectory 'matrix-details.json')
    Copy-Item -LiteralPath $eventsPath -Destination (Join-Path $temporaryScanDirectory 'matrix-events.jsonl')
    $scanOutput = & node -e @'
import { formatFindings, scanPublicEvidence } from './evaluation/scripts/check-public-evidence.mjs';
const result = scanPublicEvidence({ scanRoots: ['evaluation/compatibility/.plugin-isolation-scan'] });
for (const line of formatFindings(result)) console.log(line);
if (result.findings.length > 0) process.exitCode = 1;
'@
    if ($LASTEXITCODE -ne 0 -or ($scanOutput -join "`n") -notmatch 'PUBLIC_EVIDENCE_CHECK_OK') {
      throw 'The generated public evidence failed the privacy scan.'
    }
    [IO.File]::WriteAllText($scanResultPath, (@($scanOutput) -join [Environment]::NewLine) + [Environment]::NewLine, $utf8NoBom)
    $publicEvidenceScanPassed = $true
  }
  catch {
    $finalizationFailure = $_
  }
  finally {
    if ($temporaryScanDirectory) {
      Remove-Item -LiteralPath $temporaryScanDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

function Invoke-CodexJson {
  param(
    [Parameter(Mandatory)]
    [string[]]$CommandArguments
  )

  $stdoutPath = [IO.Path]::GetTempFileName()
  $stderrPath = [IO.Path]::GetTempFileName()
  try {
    & $CodexExecutable @CommandArguments 1> $stdoutPath 2> $stderrPath
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
      throw "Codex command failed with exit code $exitCode."
    }
    $stdout = [IO.File]::ReadAllText($stdoutPath)
    try {
      return $stdout | ConvertFrom-Json
    }
    catch {
      throw 'Codex command returned invalid JSON.'
    }
  }
  finally {
    Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
  }
}

function Assert-SetEqual {
  param(
    [Parameter(Mandatory)]
    [AllowEmptyCollection()]
    [string[]]$Actual,

    [Parameter(Mandatory)]
    [AllowEmptyCollection()]
    [string[]]$Expected,

    [Parameter(Mandatory)]
    [string]$Label
  )

  $actualValue = (@($Actual | Sort-Object -Unique) -join ',')
  $expectedValue = (@($Expected | Sort-Object -Unique) -join ',')
  if ($actualValue -ne $expectedValue) {
    throw "$Label did not match the expected set."
  }
}

function Get-PluginTree {
  param(
    [Parameter(Mandatory)]
    [string]$Root
  )

  $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  if (-not (Test-Path -LiteralPath $resolvedRoot -PathType Container)) {
    throw 'A plugin tree root was not found.'
  }
  $reparsePoints = @(Get-ChildItem -LiteralPath $resolvedRoot -Recurse -Force | Where-Object {
    ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  })
  if ($reparsePoints.Count -ne 0) {
    throw 'Plugin trees with reparse points cannot be used as installation evidence.'
  }

  $pathMap = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::Ordinal)
  foreach ($file in @(Get-ChildItem -LiteralPath $resolvedRoot -Recurse -File -Force)) {
    $fullName = [IO.Path]::GetFullPath($file.FullName)
    $prefix = $resolvedRoot + '\'
    if (-not $fullName.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'A plugin file resolved outside its expected tree root.'
    }
    $relativePath = $fullName.Substring($prefix.Length).Replace('\', '/')
    if ($pathMap.ContainsKey($relativePath)) {
      throw 'A plugin tree contained duplicate relative file paths.'
    }
    $pathMap.Add($relativePath, $fullName)
  }

  $relativePaths = [string[]]@($pathMap.Keys)
  [Array]::Sort($relativePaths, [StringComparer]::Ordinal)
  $inventory = [System.Collections.Generic.List[object]]::new()
  $canonicalLines = [System.Collections.Generic.List[string]]::new()
  foreach ($relativePath in $relativePaths) {
    $fullName = $pathMap[$relativePath]
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $fullName).Hash.ToLowerInvariant()
    $length = (Get-Item -LiteralPath $fullName).Length
    $inventory.Add([ordered]@{
      path = $relativePath
      bytes = [long]$length
      sha256 = $hash
    })
    $canonicalLines.Add("$hash $length $relativePath")
  }

  $canonical = (@($canonicalLines) -join "`n") + "`n"
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $treeHashBytes = $sha256.ComputeHash($utf8NoBom.GetBytes($canonical))
  }
  finally {
    $sha256.Dispose()
  }
  $treeHash = ([BitConverter]::ToString($treeHashBytes)).Replace('-', '').ToLowerInvariant()
  return [ordered]@{
    treeSha256 = $treeHash
    fileCount = $inventory.Count
    files = @($inventory)
  }
}

function Write-MatrixEvents {
  $events = [System.Collections.Generic.List[string]]::new()
  $ordinal = 0
  foreach ($step in @($details.steps)) {
    $ordinal++
    $observedInstalled = @($step.list | Where-Object { $_.installed -eq $true } | ForEach-Object { [string]$_.name } | Sort-Object)
    $observedCached = @($step.cache | Where-Object { $_.present -eq $true } | ForEach-Object { [string]$_.name } | Sort-Object)
    $event = [ordered]@{
      schemaVersion = '1.0.0'
      event = 'state-snapshot'
      ordinal = $ordinal
      stepId = [string]$step.id
      expectedInstalled = @($step.expectedInstalled)
      observedInstalled = $observedInstalled
      observedCached = $observedCached
      status = 'pass'
    }
    $events.Add(($event | ConvertTo-Json -Compress -Depth 10))
  }
  $completion = [ordered]@{
    schemaVersion = '1.0.0'
    event = 'matrix-complete'
    ordinal = $ordinal + 1
    status = [string]$details.status
    failureCode = if ($null -ne $details.failure) { [string]$details.failure.code } else { $null }
    failureStage = if ($null -ne $details.failure) { [string]$details.failure.stage } else { $null }
  }
  $events.Add(($completion | ConvertTo-Json -Compress -Depth 10))
  [IO.File]::WriteAllText($eventsPath, (@($events) -join [Environment]::NewLine) + [Environment]::NewLine, $utf8NoBom)
}

function Get-MarketplaceListing {
  return Invoke-CodexJson -CommandArguments @('plugin', 'list', '--marketplace', $MarketplaceName, '--available', '--json')
}

function Get-PluginEntries {
  param(
    [Parameter(Mandatory)]
    [object]$Listing
  )

  $entries = [System.Collections.Generic.List[object]]::new()
  foreach ($entry in @($Listing.installed)) {
    if ($null -ne $entry) { $entries.Add($entry) }
  }
  foreach ($entry in @($Listing.available)) {
    if ($null -ne $entry) { $entries.Add($entry) }
  }
  return @($entries)
}

function Get-CacheState {
  param(
    [Parameter(Mandatory)]
    [string]$PluginName,

    [Parameter(Mandatory)]
    [string]$ExpectedVersion,

    [Parameter(Mandatory)]
    [object]$ExpectedTree
  )

  $pluginRoot = Join-Path $cacheNamespace $PluginName
  if (-not (Test-Path -LiteralPath $pluginRoot -PathType Container)) {
    return [ordered]@{
      name = $PluginName
      present = $false
      fileCount = 0
      skillCount = 0
      manifestSha256 = $null
      treeSha256 = $null
      contentMatchesSource = $false
      files = @()
      topLevelEntries = @()
    }
  }

  $files = @(Get-ChildItem -LiteralPath $pluginRoot -Recurse -File -Force)
  $skillFiles = @($files | Where-Object { $_.Name -eq 'SKILL.md' })
  $manifestFiles = @($files | Where-Object {
    $_.Name -eq 'plugin.json' -and $_.Directory.Name -eq '.codex-plugin'
  })
  if ($manifestFiles.Count -ne 1) {
    throw "Plugin cache manifest count was invalid for $PluginName."
  }
  $manifest = Get-Content -Raw -LiteralPath $manifestFiles[0].FullName | ConvertFrom-Json
  if ($manifest.name -ne $PluginName -or $manifest.version -ne $ExpectedVersion) {
    throw "Plugin cache manifest identity or version was invalid for $PluginName."
  }
  $versionDirectories = @(Get-ChildItem -LiteralPath $pluginRoot -Directory -Force | ForEach-Object { $_.Name })
  Assert-SetEqual -Actual $versionDirectories -Expected @($ExpectedVersion) -Label "$PluginName cached versions"
  $expectedVersionRoot = [IO.Path]::GetFullPath((Join-Path $pluginRoot $ExpectedVersion)).TrimEnd('\')
  $manifestRoot = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $manifestFiles[0].FullName))).TrimEnd('\')
  if ($manifestRoot -ne $expectedVersionRoot) {
    throw "Plugin cache manifest was not stored under the expected version directory for $PluginName."
  }
  $cacheTree = Get-PluginTree -Root $expectedVersionRoot
  if ($cacheTree.treeSha256 -ne $ExpectedTree.treeSha256 -or $cacheTree.fileCount -ne $ExpectedTree.fileCount) {
    throw "Plugin cache content did not match the pinned source tree for $PluginName."
  }

  return [ordered]@{
    name = $PluginName
    present = $true
    fileCount = $files.Count
    skillCount = $skillFiles.Count
    manifestSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifestFiles[0].FullName).Hash.ToLowerInvariant()
    treeSha256 = $cacheTree.treeSha256
    contentMatchesSource = $true
    files = @($cacheTree.files)
    topLevelEntries = $versionDirectories
  }
}

function Save-StateSnapshot {
  param(
    [Parameter(Mandatory)]
    [string]$StepId,

    [Parameter(Mandatory)]
    [AllowEmptyCollection()]
    [string[]]$ExpectedInstalled
  )

  $script:stage = "$StepId-listing"
  $listing = Get-MarketplaceListing
  $entries = @(Get-PluginEntries -Listing $listing)
  $script:stage = "$StepId-marketplace-inventory"
  $entryNames = @($entries | ForEach-Object { [string]$_.name })
  $details.diagnostics.lastSnapshot = [ordered]@{
    stepId = $StepId
    entryNames = @($entryNames | Sort-Object)
    entryCount = $entryNames.Count
    uniqueEntryCount = @($entryNames | Sort-Object -Unique).Count
    installedNames = @()
  }
  Assert-SetEqual -Actual $entryNames -Expected $pluginNames -Label "$StepId marketplace inventory"
  $script:stage = "$StepId-duplicate-entries"
  $duplicateGroups = @($entryNames | Group-Object | Where-Object { $_.Count -ne 1 })
  if ($duplicateGroups.Count -ne 0) {
    throw "$StepId marketplace inventory contained duplicate plugin entries."
  }

  $script:stage = "$StepId-installed-set"
  $installedEntries = @($entries | Where-Object { $_.installed -eq $true })
  $installedNames = @($installedEntries | ForEach-Object { [string]$_.name })
  $details.diagnostics.lastSnapshot.installedNames = @($installedNames | Sort-Object)
  Assert-SetEqual -Actual $installedNames -Expected $ExpectedInstalled -Label "$StepId installed plugins"

  $script:stage = "$StepId-entry-state"
  foreach ($entry in $entries) {
    $shouldBeInstalled = $ExpectedInstalled -contains [string]$entry.name
    if ([bool]$entry.installed -ne $shouldBeInstalled) {
      throw "$StepId list state was inconsistent for a plugin."
    }
    if ([bool]$entry.enabled -ne $shouldBeInstalled) {
      throw "$StepId enabled state was inconsistent for a plugin."
    }
    if ([string]$entry.marketplaceName -ne $MarketplaceName) {
      throw "$StepId returned a plugin from an unexpected marketplace."
    }
  }

  $script:stage = "$StepId-cache-state"
  $cacheStates = @($pluginNames | ForEach-Object {
    Get-CacheState `
      -PluginName $_ `
      -ExpectedVersion ([string]$details.marketplace.pluginVersions[$_]) `
      -ExpectedTree $details.marketplace.sourceTrees[$_]
  })
  $cachedNames = @($cacheStates | Where-Object present | ForEach-Object { [string]$_.name })
  Assert-SetEqual -Actual $cachedNames -Expected $ExpectedInstalled -Label "$StepId cached plugins"

  $script:stage = "$StepId-cache-namespace"
  $namespaceDirectories = @(
    if (Test-Path -LiteralPath $cacheNamespace -PathType Container) {
      Get-ChildItem -LiteralPath $cacheNamespace -Directory -Force | ForEach-Object { $_.Name }
    }
  )
  $details.diagnostics.lastSnapshot.cacheNamespaceEntries = @($namespaceDirectories | Sort-Object)
  Assert-SetEqual -Actual $namespaceDirectories -Expected $ExpectedInstalled -Label "$StepId cache namespace"

  $script:stage = "$StepId-record"
  $sanitizedEntries = @($entries | Sort-Object name | ForEach-Object {
    [ordered]@{
      pluginId = [string]$_.pluginId
      name = [string]$_.name
      marketplaceName = [string]$_.marketplaceName
      version = [string]$_.version
      installed = [bool]$_.installed
      enabled = [bool]$_.enabled
      installPolicy = [string]$_.installPolicy
      authPolicy = [string]$_.authPolicy
    }
  })

  $details.steps.Add([ordered]@{
    id = $StepId
    expectedInstalled = @($ExpectedInstalled | Sort-Object)
    list = $sanitizedEntries
    cache = $cacheStates
    assertions = @('complete-marketplace-inventory', 'exact-installed-set', 'exact-cache-set')
  })
}

function Install-Plugin {
  param(
    [Parameter(Mandatory)]
    [string]$PluginName
  )

  $result = Invoke-CodexJson -CommandArguments @('plugin', 'add', "$PluginName@$MarketplaceName", '--json')
  if ($result.pluginId -ne "$PluginName@$MarketplaceName" -or $result.name -ne $PluginName) {
    throw 'Codex returned an unexpected plugin installation identity.'
  }
  if (-not $result.version -or [string]$result.version -ne [string]$details.marketplace.pluginVersions[$PluginName]) {
    throw 'Codex returned an unexpected plugin installation version.'
  }
  $expectedCacheRoot = [IO.Path]::GetFullPath((Join-Path (Join-Path $cacheNamespace $PluginName) ([string]$result.version))).TrimEnd('\')
  $installedRoot = [IO.Path]::GetFullPath([string]$result.installedPath).TrimEnd('\')
  if ($installedRoot -ne $expectedCacheRoot) {
    throw 'Codex installed a plugin outside the expected default cache location.'
  }
}

function Remove-Plugin {
  param(
    [Parameter(Mandatory)]
    [string]$PluginName
  )

  $result = Invoke-CodexJson -CommandArguments @('plugin', 'remove', "$PluginName@$MarketplaceName", '--json')
  if ($result.pluginId -ne "$PluginName@$MarketplaceName" -or $result.name -ne $PluginName) {
    throw 'Codex returned an unexpected plugin removal identity.'
  }
}

try {
  if ($FinalizeOnly) {
    if ($null -ne $finalizationFailure) {
      throw $finalizationFailure
    }
  }
  else {
    $stage = 'version-verification'
  $nodeVersion = (& node --version).Trim()
  $codexVersion = (& $CodexExecutable --version).Trim()
  if ($nodeVersion -ne "v$expectedNodeVersion") {
    throw 'Node.js version did not match the evidence contract.'
  }
  if ($codexVersion -ne "codex-cli $expectedCodexVersion") {
    throw 'Codex CLI version did not match the evidence contract.'
  }
  $details.environment.nodeVersion = $nodeVersion
  $details.environment.codexCliVersion = $codexVersion

  $stage = 'marketplace-add'
  $marketplaceResult = Invoke-CodexJson -CommandArguments @(
    'plugin', 'marketplace', 'add', $Repository, '--ref', $SourceCommit, '--json'
  )
  if ($marketplaceResult.marketplaceName -ne $MarketplaceName -or [bool]$marketplaceResult.alreadyAdded) {
    throw 'The marketplace was not added as a fresh isolated source.'
  }
  $marketplaceRoot = [string]$marketplaceResult.installedRoot
  if (-not (Test-Path -LiteralPath $marketplaceRoot -PathType Container)) {
    throw 'The installed marketplace snapshot was not found.'
  }
  $resolvedCommit = (& git -C $marketplaceRoot rev-parse HEAD).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $resolvedCommit -ne $SourceCommit) {
    throw 'The installed marketplace snapshot did not resolve to the pinned source commit.'
  }
  $details.marketplace.sourceCommitVerified = $true

  $stage = 'initial-listing'
  $initialListing = Get-MarketplaceListing
  foreach ($entry in @(Get-PluginEntries -Listing $initialListing)) {
    if (-not $entry.version) {
      throw 'A marketplace plugin did not expose a version.'
    }
    $details.marketplace.pluginVersions[[string]$entry.name] = [string]$entry.version
  }
  foreach ($plugin in $pluginNames) {
    $stage = "source-tree-$plugin"
    $sourcePluginRoot = Join-Path $marketplaceRoot (Join-Path 'plugins' $plugin)
    $details.marketplace.sourceTrees[$plugin] = Get-PluginTree -Root $sourcePluginRoot
  }
  $stage = 'initial-state-snapshot'
  Save-StateSnapshot -StepId 'initial-none-installed' -ExpectedInstalled @()

  foreach ($plugin in $pluginNames) {
    $stage = "single-install-$plugin"
    Install-Plugin -PluginName $plugin
    Save-StateSnapshot -StepId "single-$plugin-installed" -ExpectedInstalled @($plugin)

    $stage = "single-remove-$plugin"
    Remove-Plugin -PluginName $plugin
    Save-StateSnapshot -StepId "single-$plugin-removed" -ExpectedInstalled @()
  }

  $stage = 'full-install'
  foreach ($plugin in $pluginNames) {
    Install-Plugin -PluginName $plugin
  }
  Save-StateSnapshot -StepId 'all-three-installed' -ExpectedInstalled $pluginNames

  $remaining = [System.Collections.Generic.List[string]]::new()
  foreach ($plugin in $pluginNames) { $remaining.Add($plugin) }
  foreach ($plugin in @('async-wait-guard', 'execution-budget', 'context-relay')) {
    $stage = "independent-remove-$plugin"
    Remove-Plugin -PluginName $plugin
    [void]$remaining.Remove($plugin)
    Save-StateSnapshot -StepId "removed-$plugin-independently" -ExpectedInstalled @($remaining)
  }

    $details.status = 'passed'
  }
}
catch {
  $failure = $_
  $details.status = 'failed'
  $details.failure = [ordered]@{
    code = 'MATRIX_FAILED'
    stage = $stage
  }
}
finally {
  if (-not $FinalizeOnly -or -not (Test-Path -LiteralPath $detailsPath -PathType Leaf)) {
    $details.completedAt = [DateTimeOffset]::UtcNow.ToString('o')
    [IO.File]::WriteAllText($detailsPath, ($details | ConvertTo-Json -Depth 30) + [Environment]::NewLine, $utf8NoBom)
    Write-MatrixEvents
  }
  $detailsHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $detailsPath).Hash.ToLowerInvariant()
  $eventsHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $eventsPath).Hash.ToLowerInvariant()

  $matrixPassed = $details.status -eq 'passed'
  $fullyPassed = $matrixPassed -and $publicEvidenceScanPassed
  $failedStage = if ($null -ne $details.failure) { [string]$details.failure.stage } else { $null }
  $stepSummaries = @($details.steps | ForEach-Object {
    [ordered]@{
      id = [string]$_.id
      action = "Verify plugin list and default cache at matrix state '$($_.id)'."
      expected = "Installed plugins and cache entries exactly match the state contract for '$($_.id)'."
      observed = "Marketplace inventory, installed set, enabled set, and cache set matched exactly."
      status = 'pass'
      evidence_ref = 'matrix-details.json'
    }
  })
  if (-not $matrixPassed) {
    $stepSummaries += [ordered]@{
      id = 'matrix-failure'
      action = 'Run the fail-closed marketplace installation matrix.'
      expected = 'All isolated installation and removal states pass.'
      observed = "The matrix stopped at sanitized stage '$failedStage'."
      status = 'fail'
      evidence_ref = 'matrix-details.json'
    }
  }
  if ($stepSummaries.Count -eq 0) {
    $stepSummaries = @([ordered]@{
      id = 'matrix-start'
      action = 'Start the fail-closed marketplace installation matrix.'
      expected = 'The pinned toolchain and marketplace source initialize successfully.'
      observed = if ($matrixPassed) { 'The matrix initialized successfully.' } else { "The matrix stopped at sanitized stage '$failedStage'." }
      status = if ($matrixPassed) { 'pass' } else { 'fail' }
      evidence_ref = 'matrix-details.json'
    })
  }

  $coreVersionProperty = $details.marketplace.pluginVersions.PSObject.Properties['context-relay']
  $bundleVersion = if ($null -ne $coreVersionProperty -and $coreVersionProperty.Value) {
    [string]$coreVersionProperty.Value
  }
  else {
    '0.0.0'
  }
  $evidenceItems = [System.Collections.Generic.List[object]]::new()
  $evidenceItems.Add([ordered]@{
    path = 'matrix-details.json'
    sha256 = $detailsHash
    media_type = 'application/json'
  })
  $evidenceItems.Add([ordered]@{
    path = 'matrix-events.jsonl'
    sha256 = $eventsHash
    media_type = 'application/jsonl'
  })
  if (Test-Path -LiteralPath $scanResultPath -PathType Leaf) {
    $scanResultHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $scanResultPath).Hash.ToLowerInvariant()
    $evidenceItems.Add([ordered]@{
      path = 'privacy-scan.txt'
      sha256 = $scanResultHash
      media_type = 'text/plain'
    })
  }
  $failureMessages = [System.Collections.Generic.List[string]]::new()
  if (-not $matrixPassed) {
    $failureMessages.Add("The installation matrix failed at sanitized stage '$failedStage'.")
  }
  $report = [ordered]@{
    schema_version = '1.0.0'
    report_id = 'gha-plugin-install-matrix'
    tested_at = ([DateTimeOffset]$details.completedAt).ToUniversalTime().ToString('o')
    reporter_kind = 'automation'
    plugin = [ordered]@{
      id = 'bundle'
      version = $bundleVersion
      repository_commit = $SourceCommit
    }
    host = [ordered]@{
      surface = 'github-actions-windows'
      version = if ($details.environment.codexCliVersion) { [string]$details.environment.codexCliVersion } else { 'codex-cli 0.144.5 not verified' }
      os = 'Windows'
      os_version = if ($env:ImageVersion) { "GitHub runner image $env:ImageVersion" } else { 'GitHub-hosted Windows runner' }
      architecture = 'x64'
    }
    model = [ordered]@{
      name = 'not-applicable'
      version = 'not-applicable'
      reasoning_effort = 'not-applicable'
    }
    installation = [ordered]@{
      method = 'marketplace'
      fresh_context = $true
      commands_or_actions = @(
        'Add the public marketplace at the pinned repository commit.',
        'Install each plugin independently, then install all three together.',
        'Remove each plugin and verify list and cache state after every transition.'
      )
      status = if ($matrixPassed) { 'success' } else { 'failure' }
    }
    input = [ordered]@{
      kind = 'public-repository'
      fixture_ref = 'matrix-details.json'
      source_completeness = 'NOT_APPLICABLE'
    }
    workflow = 'marketplace-install-matrix'
    trigger = [ordered]@{
      mode = 'not-applicable'
      status = 'not-applicable'
    }
    steps = $stepSummaries
    checks = @(
      [ordered]@{ name = 'source_commit'; status = if ($details.marketplace.sourceCommitVerified) { 'pass' } else { 'fail' }; value = [bool]$details.marketplace.sourceCommitVerified },
      [ordered]@{ name = 'list_state'; status = if ($matrixPassed) { 'pass' } else { 'fail' }; value = $matrixPassed },
      [ordered]@{ name = 'cache_state'; status = if ($matrixPassed) { 'pass' } else { 'fail' }; value = $matrixPassed },
      [ordered]@{ name = 'independent_removal'; status = if ($matrixPassed) { 'pass' } else { 'fail' }; value = $matrixPassed },
      [ordered]@{ name = 'public_evidence_scan'; status = if ($publicEvidenceScanPassed) { 'pass' } elseif ($FinalizeOnly) { 'fail' } else { 'not-verifiable' }; value = $publicEvidenceScanPassed }
    )
    result = if ($fullyPassed) { 'success' } elseif ($matrixPassed) { 'partial' } else { 'failure' }
    failures = $failureMessages
    unverified_boundaries = @(
      'This report verifies marketplace installation, list state, cache state, and removal only.',
      'Skill visibility, model triggering, and host wait behavior require separate fresh-task runtime evidence.'
    )
    privacy = [ordered]@{
      public_evidence_scan = if ($publicEvidenceScanPassed) { 'pass' } else { 'not-run' }
      redactions = @('Host paths and raw command output are excluded from public evidence.')
      raw_private_artifacts_excluded = $true
    }
    evidence = @($evidenceItems)
  }
  [IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 30) + [Environment]::NewLine, $utf8NoBom)
  $reportHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $reportPath).Hash.ToLowerInvariant()
  $checksumLines = @(
    "$detailsHash  matrix-details.json",
    "$eventsHash  matrix-events.jsonl",
    "$reportHash  report.json"
  )
  if (Test-Path -LiteralPath $scanResultPath -PathType Leaf) {
    $checksumLines += "$scanResultHash  privacy-scan.txt"
  }
  $checksumLines | Sort-Object | Set-Content -LiteralPath $checksumsPath -Encoding ascii
}

if ($null -ne $failure -and -not $FinalizeOnly) {
  throw "Plugin installation matrix failed at stage '$stage'."
}

if ($FinalizeOnly -and -not $publicEvidenceScanPassed) {
  throw 'Public evidence finalization did not complete.'
}

Write-Host "PLUGIN_INSTALL_MATRIX_OK report=report.json checksum=checksums.sha256"
