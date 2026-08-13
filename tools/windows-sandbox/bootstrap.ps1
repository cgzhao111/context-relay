[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$EvidenceDirectory,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-f]{40}$')]
    [string]$HarnessCommit,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-f]{64}$')]
    [string]$PartialReportHelperSha256
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$NodeVersion = "22.23.2"
$NodeArchiveSha256 = "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97"
$CodexVersion = "0.144.5"
$CodexNpmIntegrity = "sha512-jjB+K+OMv572mKhS+2QuLxWXDJNdpwbPenf+V+8bdq7wg4Scqt3cn6WEekD8wPqDVZqck0HSX17K9rD9kbDJQA=="
$CodexWindowsNpmIntegrity = "sha512-DnsSTlnnzleTxvLwIGnBitKInscxn2I7qASqosS8Fv+qysBygd+ZiBn/SQsRCgQ28PAlsNzmd3Gf3ZTecolAmg=="
$Repository = "cgzhao111/context-relay"
$RepositoryCommit = "dd3cbfb1f10c29808193dee167f4d595e7046f38"
$RepositoryArchiveSha256 = "2423268ab7a048114506695980bca783cf8f7a943901e669363650aba433caa7"
$MarketplaceName = "context-relay"
$script:CurrentStage = "initialize"

function Remove-DownloadArtifact {
    param([string]$Name, [string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    try {
        Remove-Item -LiteralPath $Path -Force
    }
    catch {
        throw "Download cleanup failed for step '$Name'."
    }
}

function Invoke-DownloadWithRetry {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][uri]$Uri,
        [Parameter(Mandatory = $true)][string]$OutFile,
        [ValidateRange(1, 6)][int]$MaxAttempts = 4
    )

    $script:CurrentStage = $Name
    if ($Uri.Scheme -ne [Uri]::UriSchemeHttps -or [string]::IsNullOrWhiteSpace($Uri.Host)) {
        throw "Download step '$Name' requires a valid HTTPS source."
    }
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        Remove-DownloadArtifact -Name $Name -Path $OutFile
        try {
            Invoke-WebRequest -UseBasicParsing -Uri $Uri.AbsoluteUri -OutFile $OutFile
            $downloaded = Get-Item -LiteralPath $OutFile -ErrorAction Stop
            if ($downloaded.Length -le 0) {
                throw "The downloaded file was empty."
            }
            return
        }
        catch {
            Remove-DownloadArtifact -Name $Name -Path $OutFile
            if ($attempt -eq $MaxAttempts) {
                throw "Download step '$Name' failed after $MaxAttempts attempts from host '$($Uri.Host)'."
            }
            if ($attempt -eq 1) {
                # Fresh Windows PowerShell 5.1 images can require an explicit
                # TLS 1.2 fallback after the system-default negotiation fails.
                [System.Net.ServicePointManager]::SecurityProtocol =
                    [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
            }
            Start-Sleep -Seconds ([Math]::Min(8, [Math]::Pow(2, $attempt)))
        }
    }
}

function Write-Utf8NoBom {
    param([string]$Path, [AllowEmptyString()][string]$Value)
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Value, $encoding)
}

function Write-JsonEvidence {
    param([string]$Name, [object]$Value)
    Write-Utf8NoBom -Path (Join-Path $script:RunRoot $Name) -Value (($Value | ConvertTo-Json -Depth 15) + "`n")
}

function Get-RelativeEvidencePath {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Path
    )
    $rootUri = [Uri]::new(($Root.TrimEnd("\") + "\"))
    $pathUri = [Uri]::new($Path)
    return [Uri]::UnescapeDataString($rootUri.MakeRelativeUri($pathUri).ToString()).Replace("\", "/")
}

function Invoke-CapturedProcess {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [int[]]$AllowedExitCodes = @(0)
    )

    $script:CurrentStage = $Name
    $stdoutPath = Join-Path $script:RunRoot ($Name + ".stdout.private.txt")
    $stderrPath = Join-Path $script:RunRoot ($Name + ".stderr.private.txt")
    & $FilePath @Arguments 1> $stdoutPath 2> $stderrPath
    $exitCode = $LASTEXITCODE
    if ($AllowedExitCodes -notcontains $exitCode) {
        throw "Step '$Name' failed with exit code $exitCode. Review its private evidence files."
    }
    return $exitCode
}

function Invoke-ManualDeviceAuthentication {
    param(
        [Parameter(Mandatory = $true)][string]$CodexCommand,
        [Parameter(Mandatory = $true)][string]$NodeHome,
        [ValidateRange(1, 3600)][int]$TimeoutSeconds = 900,
        [string]$DesktopPath = [Environment]::GetFolderPath("Desktop")
    )

    $authRoot = Join-Path $script:WorkingRoot "manual-device-authentication"
    $authScriptPath = Join-Path $authRoot "device-authentication.ps1"
    $sentinelPath = Join-Path $authRoot "device-authentication-complete.sentinel"
    $failureSentinelPath = Join-Path $authRoot "device-authentication-failed.sentinel"
    if ([string]::IsNullOrWhiteSpace($DesktopPath) -or -not (Test-Path -LiteralPath $DesktopPath -PathType Container)) {
        throw "The Sandbox desktop was unavailable for the manual authentication launcher."
    }
    if ([string]::IsNullOrWhiteSpace($NodeHome) -or -not (Test-Path -LiteralPath $NodeHome -PathType Container)) {
        throw "The verified portable Node.js directory was unavailable for manual authentication."
    }
    $launcherPath = Join-Path $DesktopPath "1-CLICK-HERE-CODEX-AUTHORIZATION.cmd"
    New-Item -ItemType Directory -Force -Path $authRoot | Out-Null
    foreach ($marker in @($sentinelPath, $failureSentinelPath)) {
        if (Test-Path -LiteralPath $marker) {
            Remove-Item -LiteralPath $marker -Force
        }
    }

    $escapedCodexCommand = $CodexCommand.Replace("'", "''")
    $escapedNodeHome = $NodeHome.Replace("'", "''")
    $escapedSentinelPath = $sentinelPath.Replace("'", "''")
    $escapedFailureSentinelPath = $failureSentinelPath.Replace("'", "''")
    $authScript = @"
`$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
`$env:Path = '$escapedNodeHome;' + `$env:Path
try {
    Write-Host ''
    Write-Host 'MANUAL CODEX AUTHENTICATION' -ForegroundColor Yellow
    Write-Host 'First, complete device-code authorization yourself. Do not share the one-time code.' -ForegroundColor Yellow
    Write-Host 'If device-code authorization is unavailable, this same terminal will fall back to the official browser sign-in.' -ForegroundColor Yellow
    Write-Host 'This terminal and its login output are not redirected to the evidence directory.' -ForegroundColor Yellow
    & '$escapedCodexCommand' login --device-auth
    if (`$LASTEXITCODE -ne 0) {
        Write-Host 'Device-code authentication did not complete. Starting the official browser sign-in fallback.' -ForegroundColor Yellow
        & '$escapedCodexCommand' login
        if (`$LASTEXITCODE -ne 0) {
            throw 'Neither device-code authentication nor browser authentication completed.'
        }
    }
    & '$escapedCodexCommand' login status *> `$null
    if (`$LASTEXITCODE -ne 0) {
        throw 'The child login status check did not confirm authentication.'
    }
    [System.IO.File]::WriteAllText('$escapedSentinelPath', 'AUTHENTICATED')
    Write-Host 'Authentication was verified. This terminal will close automatically.' -ForegroundColor Green
    Start-Sleep -Seconds 2
    exit 0
}
catch {
    [System.IO.File]::WriteAllText('$escapedFailureSentinelPath', 'FAILED')
    Write-Host 'Authentication was not verified. No runtime probes will run.' -ForegroundColor Red
    Read-Host 'Press ENTER after noting this result'
    exit 1
}
"@
    Write-Utf8NoBom -Path $authScriptPath -Value $authScript

    if ($authScriptPath.Contains('"')) {
        throw "The generated authentication script path was invalid."
    }
    $launcher = @"
@echo off
title Codex Authentication
color 0E
set "PATH=$NodeHome;%PATH%"
echo Complete the Codex authorization yourself. This window is not recorded.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$authScriptPath"
exit /b %ERRORLEVEL%
"@
    Write-Utf8NoBom -Path $launcherPath -Value ($launcher + "`r`n")

    $script:CurrentStage = "manual-codex-authentication-await-user"
    Write-Host "On the Sandbox desktop, double-click: 1-CLICK-HERE-CODEX-AUTHORIZATION.cmd" -ForegroundColor Yellow
    Write-Host "The run will wait up to $TimeoutSeconds seconds. Device codes, browser-login output, and account output are not captured." -ForegroundColor Yellow
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while (-not (Test-Path -LiteralPath $sentinelPath -PathType Leaf)) {
        if (Test-Path -LiteralPath $failureSentinelPath -PathType Leaf) {
            $script:CurrentStage = "manual-codex-authentication-user-result"
            throw "The manual Codex authentication launcher reported failure after device-code and browser-login attempts."
        }
        if ([DateTime]::UtcNow -ge $deadline) {
            throw "Manual Codex authentication timed out after $TimeoutSeconds seconds."
        }
        Start-Sleep -Milliseconds 500
    }

    $script:CurrentStage = "manual-codex-authentication-user-result"
    if ([System.IO.File]::ReadAllText($sentinelPath) -ne "AUTHENTICATED") {
        throw "Manual Codex authentication did not produce a valid completion sentinel."
    }

    $script:CurrentStage = "manual-codex-authentication-parent-status"
    & $CodexCommand login status *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "The parent login status check did not confirm authentication."
    }
    Remove-Item -LiteralPath $sentinelPath, $launcherPath -Force
    $script:CurrentStage = "manual-codex-authentication-complete"
}

function Invoke-CodexJson {
    param([string]$Name, [string[]]$Arguments)
    Invoke-CapturedProcess -Name $Name -FilePath $script:CodexCommand -Arguments $Arguments | Out-Null
    $stdoutPath = Join-Path $script:RunRoot ($Name + ".stdout.private.txt")
    try {
        return ([System.IO.File]::ReadAllText($stdoutPath) | ConvertFrom-Json)
    }
    catch {
        throw "Step '$Name' did not return valid JSON."
    }
}

function Get-TargetPluginState {
    param([object]$Inventory)
    $targetIds = @(
        "context-relay@$MarketplaceName",
        "execution-budget@$MarketplaceName",
        "async-wait-guard@$MarketplaceName"
    )
    return @((@($Inventory.installed) + @($Inventory.available)) |
        Where-Object { $targetIds -contains [string]$_.pluginId } |
        ForEach-Object {
            [ordered]@{
                plugin_id = [string]$_.pluginId
                marketplace_name = [string]$_.marketplaceName
                version = [string]$_.version
                installed = [bool]$_.installed
                enabled = [bool]$_.enabled
            }
        } | Sort-Object plugin_id)
}

function Get-ExpectedPluginVersion {
    param([string]$Plugin)
    if ($Plugin -eq "context-relay") { return "0.3.0-rc.2" }
    return "0.1.0"
}

function Assert-InstalledSet {
    param([object]$Inventory, [string[]]$ExpectedInstalled)
    $states = Get-TargetPluginState -Inventory $Inventory
    if ($states.Count -ne 3) {
        throw "The fixed marketplace did not expose exactly three target plugins."
    }
    $actual = @($states | Where-Object installed | ForEach-Object { ([string]$_.plugin_id).Split("@")[0] } | Sort-Object)
    $expected = @($ExpectedInstalled | Sort-Object)
    if (($actual -join "|") -ne ($expected -join "|")) {
        throw "Installed target plugin set did not match the expected isolation state."
    }
    foreach ($state in $states) {
        $plugin = ([string]$state.plugin_id).Split("@")[0]
        $shouldBeInstalled = $ExpectedInstalled -contains $plugin
        if ([string]$state.marketplace_name -ne $MarketplaceName -or
            [string]$state.version -ne (Get-ExpectedPluginVersion -Plugin $plugin) -or
            [bool]$state.enabled -ne $shouldBeInstalled) {
            throw "A target plugin list entry did not match its marketplace, version, or enabled-state contract."
        }
    }
}

function Save-Inventory {
    param([string]$Name, [string[]]$ExpectedInstalled)
    $inventory = Invoke-CodexJson -Name $Name -Arguments @("plugin", "list", "--marketplace", $MarketplaceName, "--available", "--json")
    Assert-InstalledSet -Inventory $inventory -ExpectedInstalled $ExpectedInstalled
    Write-JsonEvidence -Name ($Name + ".normalized.private.json") -Value ([ordered]@{
        schema_version = "1.0"
        target_plugins = Get-TargetPluginState -Inventory $inventory
    })
}

function Test-PluginInstalled {
    param([object]$Inventory, [string]$Plugin)
    return [bool](Get-TargetPluginState -Inventory $Inventory | Where-Object {
        $_.plugin_id -eq "$Plugin@$MarketplaceName" -and $_.installed
    })
}

function Get-SkillNameForPlugin {
    param([string]$Plugin)
    if ($Plugin -eq "context-relay") { return "project-handoff" }
    return $Plugin
}

function Invoke-RemovedPluginNegativeProbe {
    param([string]$Plugin, [string[]]$RemainingPlugins = @())
    $inventory = Invoke-CodexJson -Name ("negative-inventory-" + $Plugin) -Arguments @("plugin", "list", "--available", "--json")
    $notInstalled = -not (Test-PluginInstalled -Inventory $inventory -Plugin $Plugin)
    $probeRoot = Join-Path $script:WorkingRoot ("negative-" + $Plugin)
    New-Item -ItemType Directory -Force -Path $probeRoot | Out-Null
    $lastMessage = Join-Path $script:RunRoot ("negative-" + $Plugin + ".last-message.private.txt")
    $removedSkill = '$' + (Get-SkillNameForPlugin -Plugin $Plugin)
    $remainingInstruction = if ($RemainingPlugins.Count -gt 0) {
        $remainingSkill = '$' + (Get-SkillNameForPlugin -Plugin $RemainingPlugins[0])
        " Then explicitly invoke $remainingSkill for a minimal read-only synthetic response so a human reviewer can check that a remaining plugin is unaffected."
    } else {
        ""
    }
    $negativePrompt = "This is a private negative-control task. Attempt to explicitly invoke $removedSkill, then state only whether that named skill is available.$remainingInstruction Do not modify files or include account, path, session, or credential information."
    Invoke-CapturedProcess -Name ("negative-" + $Plugin) -FilePath $script:CodexCommand -Arguments @(
        "exec", "--ephemeral", "--ignore-rules", "--skip-git-repo-check", "--sandbox", "read-only", "--json",
        "-C", $probeRoot, "-o", $lastMessage,
        $negativePrompt
    ) | Out-Null
    Write-JsonEvidence -Name ("negative-" + $Plugin + ".review.private.json") -Value ([ordered]@{
        schema_version = "1.0"
        evidence_class = "private-negative-control"
        plugin = $Plugin
        new_ephemeral_task = $true
        inventory_confirms_not_installed = $notInstalled
        remaining_plugins_expected = @($RemainingPlugins)
        remaining_runtime_check_requested = ($RemainingPlugins.Count -gt 0)
        model_response_human_review_required = $true
        automatically_certified = $false
    })
}

function Add-Plugin {
    param([string]$Plugin)
    $result = Invoke-CodexJson -Name ("add-" + $Plugin) -Arguments @("plugin", "add", "$Plugin@$MarketplaceName", "--json")
    $expectedVersion = Get-ExpectedPluginVersion -Plugin $Plugin
    $expectedPath = [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE ".codex\plugins\cache\$MarketplaceName\$Plugin\$expectedVersion")).TrimEnd('\')
    $actualPath = [System.IO.Path]::GetFullPath([string]$result.installedPath).TrimEnd('\')
    if ([string]$result.pluginId -ne "$Plugin@$MarketplaceName" -or
        [string]$result.name -ne $Plugin -or
        [string]$result.version -ne $expectedVersion -or
        $actualPath -ne $expectedPath) {
        throw "Codex returned an unexpected plugin installation identity, version, or cache path."
    }
}

function Remove-Plugin {
    param([string]$Plugin)
    $result = Invoke-CodexJson -Name ("remove-" + $Plugin) -Arguments @("plugin", "remove", "$Plugin@$MarketplaceName", "--json")
    if ([string]$result.pluginId -ne "$Plugin@$MarketplaceName" -or [string]$result.name -ne $Plugin) {
        throw "Codex returned an unexpected plugin removal identity."
    }
}

function Invoke-PrivateRuntimeProbe {
    param(
        [string]$Name,
        [string]$Plugin,
        [string]$Prompt,
        [string[]]$ExpectedMarkers,
        [ValidateSet("read-only", "workspace-write")]
        [string]$SandboxMode = "read-only"
    )

    $probeRoot = Join-Path $script:WorkingRoot ("probe-" + $Name)
    New-Item -ItemType Directory -Force -Path $probeRoot | Out-Null
    $lastMessage = Join-Path $script:RunRoot ($Name + ".last-message.private.txt")
    $arguments = @(
        "exec", "--ephemeral", "--ignore-rules", "--skip-git-repo-check",
        "--sandbox", $SandboxMode, "--json", "-C", $probeRoot,
        "-o", $lastMessage, $Prompt
    )
    $exitCode = Invoke-CapturedProcess -Name $Name -FilePath $script:CodexCommand -Arguments $arguments
    $response = if (Test-Path -LiteralPath $lastMessage) { [System.IO.File]::ReadAllText($lastMessage) } else { "" }
    $markerResults = @($ExpectedMarkers | ForEach-Object {
        [ordered]@{ marker = $_; observed = ($response.IndexOf($_, [System.StringComparison]::Ordinal) -ge 0) }
    })
    Write-JsonEvidence -Name ($Name + ".review.private.json") -Value ([ordered]@{
        schema_version = "1.0"
        evidence_class = "private-runtime-probe"
        plugin = $Plugin
        new_ephemeral_task = $true
        codex_exit_code = $exitCode
        response_markers = $markerResults
        human_review_required = $true
        automatically_certified = $false
        actual_host_wait_verified = if ($Plugin -eq "async-wait-guard") { $false } else { $null }
        limitation = if ($Plugin -eq "async-wait-guard") {
            "This probe checks the skill response only. It does not run or measure a host asynchronous wait."
        } else {
            "Model-produced content is retained as private evidence and requires human review before any pass claim."
        }
    })
}

function Get-VerifiedCodexPackage {
    $distPath = Join-Path $script:RunRoot "npm-dist.private.json"
    $errorPath = Join-Path $script:RunRoot "npm-dist.stderr.private.txt"
    $process = Start-Process -FilePath (Join-Path $script:NodeHome "npm.cmd") -ArgumentList @(
        "view", "@openai/codex@$CodexVersion", "dist", "--json"
    ) -NoNewWindow -Wait -PassThru -RedirectStandardOutput $distPath -RedirectStandardError $errorPath
    if ($process.ExitCode -ne 0) {
        throw "Unable to query npm distribution metadata for the fixed Codex package."
    }
    try {
        $dist = [System.IO.File]::ReadAllText($distPath) | ConvertFrom-Json
    }
    catch {
        throw "npm distribution metadata was not valid JSON."
    }
    $integrity = [string]$dist.integrity
    if ($integrity -notmatch '^sha512-[A-Za-z0-9+/]+={0,2}$') {
        throw "npm did not return a valid SHA-512 dist.integrity value."
    }
    if (-not [string]::Equals($integrity, $CodexNpmIntegrity, [System.StringComparison]::Ordinal)) {
        throw "Published Codex package integrity did not match the harness-pinned value."
    }
    $tarballUri = $null
    if (-not [Uri]::TryCreate([string]$dist.tarball, [UriKind]::Absolute, [ref]$tarballUri) -or
        $tarballUri.Scheme -ne "https" -or $tarballUri.Host -ne "registry.npmjs.org") {
        throw "npm returned an unexpected Codex package tarball URL."
    }
    $tarballPath = Join-Path $toolRoot "openai-codex-$CodexVersion.tgz"
    Invoke-DownloadWithRetry -Name "download-codex-package" -Uri $tarballUri -OutFile $tarballPath
    $script:CurrentStage = "verify-codex-package"
    $sha512 = [System.Security.Cryptography.SHA512]::Create()
    try {
        $stream = [System.IO.File]::OpenRead($tarballPath)
        try {
            $actualIntegrity = "sha512-" + [Convert]::ToBase64String($sha512.ComputeHash($stream))
        }
        finally {
            $stream.Dispose()
        }
    }
    finally {
        $sha512.Dispose()
    }
    if (-not [string]::Equals($actualIntegrity, $CodexNpmIntegrity, [System.StringComparison]::Ordinal)) {
        throw "Downloaded Codex package did not match the harness-pinned SHA-512 integrity."
    }
    $platformDistPath = Join-Path $script:RunRoot "npm-platform-dist.private.json"
    $platformErrorPath = Join-Path $script:RunRoot "npm-platform-dist.stderr.private.txt"
    $platformProcess = Start-Process -FilePath (Join-Path $script:NodeHome "npm.cmd") -ArgumentList @(
        "view", "@openai/codex@$CodexVersion-win32-x64", "dist", "--json"
    ) -NoNewWindow -Wait -PassThru -RedirectStandardOutput $platformDistPath -RedirectStandardError $platformErrorPath
    if ($platformProcess.ExitCode -ne 0) {
        throw "Unable to query npm distribution metadata for the fixed Windows Codex package."
    }
    try {
        $platformDist = [System.IO.File]::ReadAllText($platformDistPath) | ConvertFrom-Json
    }
    catch {
        throw "Windows Codex npm distribution metadata was not valid JSON."
    }
    $platformIntegrity = [string]$platformDist.integrity
    if (-not [string]::Equals($platformIntegrity, $CodexWindowsNpmIntegrity, [System.StringComparison]::Ordinal)) {
        throw "Published Windows Codex package integrity did not match the harness-pinned value."
    }
    $platformTarballUri = $null
    if (-not [Uri]::TryCreate([string]$platformDist.tarball, [UriKind]::Absolute, [ref]$platformTarballUri) -or
        $platformTarballUri.Scheme -ne "https" -or $platformTarballUri.Host -ne "registry.npmjs.org") {
        throw "npm returned an unexpected Windows Codex package tarball URL."
    }
    $platformTarballPath = Join-Path $toolRoot "openai-codex-$CodexVersion-win32-x64.tgz"
    Invoke-DownloadWithRetry -Name "download-codex-windows-package" -Uri $platformTarballUri -OutFile $platformTarballPath
    $script:CurrentStage = "verify-codex-windows-package"
    $platformSha512 = [System.Security.Cryptography.SHA512]::Create()
    try {
        $platformStream = [System.IO.File]::OpenRead($platformTarballPath)
        try {
            $actualPlatformIntegrity = "sha512-" + [Convert]::ToBase64String($platformSha512.ComputeHash($platformStream))
        }
        finally {
            $platformStream.Dispose()
        }
    }
    finally {
        $platformSha512.Dispose()
    }
    if (-not [string]::Equals($actualPlatformIntegrity, $CodexWindowsNpmIntegrity, [System.StringComparison]::Ordinal)) {
        throw "Downloaded Windows Codex package did not match the harness-pinned SHA-512 integrity."
    }
    return [ordered]@{
        path = $tarballPath
        integrity = $integrity
        platform_path = $platformTarballPath
        platform_integrity = $platformIntegrity
    }
}

function Invoke-ContextRelayArtifactProbe {
    $probeName = "probe-context-relay"
    $probeRoot = Join-Path $script:WorkingRoot $probeName
    $fixtureRoot = Join-Path $probeRoot "fixture"
    $outputRoot = Join-Path $probeRoot "synthetic-output"
    New-Item -ItemType Directory -Force -Path $fixtureRoot, $outputRoot | Out-Null

    $rawRoot = "https://raw.githubusercontent.com/$Repository/$RepositoryCommit"
    Invoke-DownloadWithRetry -Name "download-handoff-json-fixture" -Uri "$rawRoot/examples/basic/handoff.json" -OutFile (Join-Path $fixtureRoot "handoff.json")
    Invoke-DownloadWithRetry -Name "download-handoff-markdown-fixture" -Uri "$rawRoot/examples/basic/PROJECT_HANDOFF.md" -OutFile (Join-Path $fixtureRoot "PROJECT_HANDOFF.md")
    $validatorPath = Join-Path $probeRoot "validate-handoff.mjs"
    Invoke-DownloadWithRetry -Name "download-handoff-validator" -Uri "$rawRoot/plugins/context-relay/skills/project-handoff/scripts/validate-handoff.mjs" -OutFile $validatorPath

    $prompt = @'
Explicitly use $project-handoff. Read only fixture/handoff.json and fixture/PROJECT_HANDOFF.md, which are public synthetic inputs. Create a fresh, internally consistent handoff pack at synthetic-output/handoff.json and synthetic-output/PROJECT_HANDOFF.md. Keep every fact synthetic, preserve source completeness, distinguish VERIFIED, PLANNED, and UNKNOWN, and do not include account, absolute path, session, or credential data. Do not copy stale timestamps; use the current time. Do not perform publication or external actions. Finish by stating that deterministic strict and negative validation will be performed by the harness, not by your response. A response marker is not required and will not be used for certification.
'@
    $lastMessage = Join-Path $script:RunRoot "$probeName.last-message.private.txt"
    Invoke-CapturedProcess -Name $probeName -FilePath $script:CodexCommand -Arguments @(
        "exec", "--ephemeral", "--ignore-rules", "--skip-git-repo-check", "--sandbox", "workspace-write", "--json",
        "-C", $probeRoot, "-o", $lastMessage, $prompt
    ) | Out-Null

    $handoffPath = Join-Path $outputRoot "handoff.json"
    $handoffMarkdown = Join-Path $outputRoot "PROJECT_HANDOFF.md"
    if (-not (Test-Path -LiteralPath $handoffPath -PathType Leaf) -or -not (Test-Path -LiteralPath $handoffMarkdown -PathType Leaf)) {
        throw "Context Relay probe did not create both required handoff artifacts."
    }

    $strictExit = Invoke-CapturedProcess -Name "context-strict-validator" -FilePath (Join-Path $script:NodeHome "node.exe") -Arguments @(
        $validatorPath, $handoffPath, "--project-root", $outputRoot, "--max-age-hours", "1", "--strict", "--json"
    )

    $mainDocument = [System.IO.File]::ReadAllText($handoffPath) | ConvertFrom-Json
    $staleDocument = $mainDocument | ConvertTo-Json -Depth 30 | ConvertFrom-Json
    $staleDocument.generated_at = "2000-01-01T00:00:00Z"
    $staleDocument.snapshot.captured_at = "2000-01-01T00:00:00Z"
    $stalePath = Join-Path $outputRoot "handoff.stale.private.json"
    Write-Utf8NoBom -Path $stalePath -Value (($staleDocument | ConvertTo-Json -Depth 30) + "`n")
    $staleExit = Invoke-CapturedProcess -Name "context-stale-validator" -FilePath (Join-Path $script:NodeHome "node.exe") -Arguments @(
        $validatorPath, $stalePath, "--project-root", $outputRoot, "--max-age-hours", "1", "--strict", "--json"
    ) -AllowedExitCodes @(1)

    $credentialDocument = $mainDocument | ConvertTo-Json -Depth 30 | ConvertFrom-Json
    $credentialDocument.objective = [string]$credentialDocument.objective + " Synthetic credential canary: " + "sk-proj-" + (("A" * 24) -join "")
    $credentialPath = Join-Path $outputRoot "handoff.credential-canary.private.json"
    Write-Utf8NoBom -Path $credentialPath -Value (($credentialDocument | ConvertTo-Json -Depth 30) + "`n")
    $credentialExit = Invoke-CapturedProcess -Name "context-credential-validator" -FilePath (Join-Path $script:NodeHome "node.exe") -Arguments @(
        $validatorPath, $credentialPath, "--project-root", $outputRoot, "--strict", "--json"
    ) -AllowedExitCodes @(1)

    $artifactRoot = Join-Path $script:RunRoot "context-artifacts.private"
    New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null
    Copy-Item -LiteralPath $handoffPath -Destination (Join-Path $artifactRoot "handoff.json")
    Copy-Item -LiteralPath $handoffMarkdown -Destination (Join-Path $artifactRoot "PROJECT_HANDOFF.md")
    Write-JsonEvidence -Name "$probeName.review.private.json" -Value ([ordered]@{
        schema_version = "1.0"
        evidence_class = "private-runtime-probe"
        plugin = "context-relay"
        new_ephemeral_task = $true
        artifacts_created = $true
        strict_validator_exit_code = $strictExit
        stale_validator_exit_code = $staleExit
        synthetic_credential_validator_exit_code = $credentialExit
        deterministic_checks_passed = ($strictExit -eq 0 -and $staleExit -eq 1 -and $credentialExit -eq 1)
        model_response_human_review_required = $true
        marker_used_for_certification = $false
        automatically_certified = $false
    })
}

$resolvedEvidence = [System.IO.Path]::GetFullPath($EvidenceDirectory)
if (-not (Test-Path -LiteralPath $resolvedEvidence -PathType Container)) {
    throw "Mapped evidence directory is unavailable."
}
if ($resolvedEvidence -ne "C:\EvidenceOut") {
    throw "Bootstrap accepts only the dedicated C:\EvidenceOut Sandbox mapping."
}
if (Get-ChildItem -LiteralPath $resolvedEvidence -Force | Select-Object -First 1) {
    throw "Mapped evidence directory must be empty at the start of the run."
}

$runId = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ")
$script:RunRoot = Join-Path $resolvedEvidence ("private-runtime-" + $runId)
$script:WorkingRoot = Join-Path $env:USERPROFILE "context-relay-sandbox-work"
$toolRoot = Join-Path $env:USERPROFILE "context-relay-sandbox-tools"
New-Item -ItemType Directory -Force -Path $script:RunRoot, $script:WorkingRoot, $toolRoot | Out-Null

$summary = [ordered]@{
    schema_version = "1.0"
    evidence_class = "private-sandbox-run"
    started_at_utc = [DateTime]::UtcNow.ToString("o")
    completed_at_utc = $null
    status = "RUNNING"
    node_version = $NodeVersion
    node_archive_sha256 = $NodeArchiveSha256
    marketplace_source = "pinned-codeload-archive"
    repository_archive_sha256 = $RepositoryArchiveSha256
    codex_cli_version = $CodexVersion
    repository = $Repository
    repository_commit = $RepositoryCommit
    marketplace_name = $MarketplaceName
    authentication_gate = "MANUAL_DEVICE_THEN_BROWSER_AUTH_NO_TRANSCRIPT"
    automatic_inventory_transition_matrix_verified = $false
    automatic_cache_content_verified = $false
    cache_content_evidence_source = "separate-github-actions-plugin-isolation"
    runtime_probes_executed = $false
    runtime_probes_human_review_required = $true
    actual_async_host_wait_verified = $false
    publication_status = "PRIVATE_NOT_REVIEWED"
}
Write-JsonEvidence -Name "run-summary.private.json" -Value $summary

try {
    $script:PartialReportHelper = Join-Path $toolRoot "New-CompatibilityPartialReport.ps1"
    $partialReportHelperUri = "https://raw.githubusercontent.com/$Repository/$HarnessCommit/tools/windows-sandbox/New-CompatibilityPartialReport.ps1"
    Invoke-DownloadWithRetry -Name "download-partial-report-helper" -Uri $partialReportHelperUri -OutFile $script:PartialReportHelper
    $script:CurrentStage = "verify-partial-report-helper"
    $actualPartialReportHelperSha256 = (Get-FileHash -LiteralPath $script:PartialReportHelper -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualPartialReportHelperSha256 -ne $PartialReportHelperSha256) {
        throw "Downloaded partial report helper did not match the host-pinned SHA256."
    }

    $repositoryArchive = Join-Path $toolRoot "context-relay-$RepositoryCommit.zip"
    $repositoryArchiveUri = "https://codeload.github.com/$Repository/zip/$RepositoryCommit"
    Invoke-DownloadWithRetry -Name "download-repository-archive" -Uri $repositoryArchiveUri -OutFile $repositoryArchive
    $script:CurrentStage = "verify-repository-archive"
    $actualRepositoryArchiveHash = (Get-FileHash -LiteralPath $repositoryArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualRepositoryArchiveHash -ne $RepositoryArchiveSha256) {
        throw "Repository archive failed the fixed SHA256 check."
    }
    $repositoryExpanded = Join-Path $toolRoot "repository-source"
    New-Item -ItemType Directory -Force -Path $repositoryExpanded | Out-Null
    Invoke-CapturedProcess -Name "extract-repository-archive" -FilePath "tar.exe" -Arguments @(
        "-xf", $repositoryArchive, "-C", $repositoryExpanded
    ) | Out-Null
    $marketplaceSourceRoot = Join-Path $repositoryExpanded "context-relay-$RepositoryCommit"
    $marketplaceManifest = Join-Path $marketplaceSourceRoot ".agents\plugins\marketplace.json"
    if (-not (Test-Path -LiteralPath $marketplaceManifest -PathType Leaf)) {
        throw "The pinned repository archive did not contain the Marketplace manifest."
    }

    $nodeArchive = Join-Path $toolRoot "node.zip"
    $nodeUri = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
    Invoke-DownloadWithRetry -Name "download-node" -Uri $nodeUri -OutFile $nodeArchive
    $script:CurrentStage = "verify-node"
    $actualNodeHash = (Get-FileHash -LiteralPath $nodeArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualNodeHash -ne $NodeArchiveSha256) {
        throw "Node.js archive failed the fixed SHA256 check."
    }
    $nodeExpanded = Join-Path $toolRoot "node"
    New-Item -ItemType Directory -Force -Path $nodeExpanded | Out-Null
    Invoke-CapturedProcess -Name "extract-node" -FilePath "tar.exe" -Arguments @(
        "-xf", $nodeArchive, "-C", $nodeExpanded
    ) | Out-Null
    $nodeHome = Join-Path $nodeExpanded "node-v$NodeVersion-win-x64"
    $script:NodeHome = $nodeHome
    $env:Path = $nodeHome + ";" + $env:Path
    $env:npm_config_prefix = Join-Path $toolRoot "npm-global"
    New-Item -ItemType Directory -Force -Path $env:npm_config_prefix | Out-Null
    $env:Path = $env:npm_config_prefix + ";" + $env:Path

    $codexPackage = Get-VerifiedCodexPackage
    Invoke-CapturedProcess -Name "install-codex" -FilePath (Join-Path $nodeHome "npm.cmd") `
        -Arguments @("install", "--global", "--ignore-scripts", $codexPackage.path) | Out-Null
    $script:CodexCommand = Join-Path $env:npm_config_prefix "codex.cmd"
    Invoke-CapturedProcess -Name "codex-version" -FilePath $script:CodexCommand -Arguments @("--version") | Out-Null
    $installedVersion = ([System.IO.File]::ReadAllText((Join-Path $script:RunRoot "codex-version.stdout.private.txt"))).Trim()
    if ($installedVersion -ne "codex-cli $CodexVersion") {
        throw "Installed Codex CLI version did not match the fixed version."
    }
    $platformExpanded = Join-Path $toolRoot "codex-platform-expanded"
    New-Item -ItemType Directory -Force -Path $platformExpanded | Out-Null
    Invoke-CapturedProcess -Name "extract-codex-platform" -FilePath "tar.exe" -Arguments @(
        "-xf", $codexPackage.platform_path, "-C", $platformExpanded
    ) | Out-Null
    $verifiedPlatformBinary = Join-Path $platformExpanded "package\vendor\x86_64-pc-windows-msvc\bin\codex.exe"
    $installedPlatformRoot = Join-Path $env:npm_config_prefix "node_modules\@openai\codex\node_modules\@openai\codex-win32-x64"
    $installedPlatformPackage = Join-Path $installedPlatformRoot "package.json"
    $installedPlatformBinary = Join-Path $installedPlatformRoot "vendor\x86_64-pc-windows-msvc\bin\codex.exe"
    if (-not (Test-Path -LiteralPath $verifiedPlatformBinary -PathType Leaf) -or
        -not (Test-Path -LiteralPath $installedPlatformPackage -PathType Leaf) -or
        -not (Test-Path -LiteralPath $installedPlatformBinary -PathType Leaf)) {
        throw "The installed or verified Windows Codex platform payload was incomplete."
    }
    $platformPackageMetadata = [System.IO.File]::ReadAllText($installedPlatformPackage) | ConvertFrom-Json
    if ([string]$platformPackageMetadata.version -ne "$CodexVersion-win32-x64") {
        throw "Installed Windows Codex platform package version did not match the fixed version."
    }
    $verifiedBinaryHash = (Get-FileHash -LiteralPath $verifiedPlatformBinary -Algorithm SHA256).Hash.ToLowerInvariant()
    $installedBinaryHash = (Get-FileHash -LiteralPath $installedPlatformBinary -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($verifiedBinaryHash -ne $installedBinaryHash) {
        throw "Installed Codex binary did not match the checksum-verified Windows platform package."
    }
    $summary.codex_npm_dist_integrity = $codexPackage.integrity
    $summary.codex_windows_npm_dist_integrity = $codexPackage.platform_integrity
    $summary.codex_windows_binary_sha256 = $installedBinaryHash

    $marketplace = Invoke-CodexJson -Name "marketplace-add" -Arguments @(
        "plugin", "marketplace", "add", $marketplaceSourceRoot, "--json"
    )
    if ([string]$marketplace.marketplaceName -ne $MarketplaceName -or [bool]$marketplace.alreadyAdded) {
        throw "Marketplace name did not match the fixed expected value."
    }
    $marketplaceRoot = [System.IO.Path]::GetFullPath([string]$marketplace.installedRoot)
    if (-not (Test-Path -LiteralPath $marketplaceRoot -PathType Container)) {
        throw "The installed Marketplace source root was not found."
    }
    $installedMarketplaceManifest = Join-Path $marketplaceRoot ".agents\plugins\marketplace.json"
    if (-not (Test-Path -LiteralPath $installedMarketplaceManifest -PathType Leaf) -or
        (Get-FileHash -LiteralPath $installedMarketplaceManifest -Algorithm SHA256).Hash -ne
            (Get-FileHash -LiteralPath $marketplaceManifest -Algorithm SHA256).Hash) {
        throw "The installed Marketplace manifest did not match the pinned archive source."
    }

    Save-Inventory -Name "state-none" -ExpectedInstalled @()
    foreach ($plugin in @("context-relay", "execution-budget", "async-wait-guard")) {
        Add-Plugin -Plugin $plugin
        Save-Inventory -Name ("state-only-" + $plugin) -ExpectedInstalled @($plugin)
        Remove-Plugin -Plugin $plugin
        Save-Inventory -Name ("state-after-remove-" + $plugin) -ExpectedInstalled @()
    }
    foreach ($plugin in @("context-relay", "execution-budget", "async-wait-guard")) {
        Add-Plugin -Plugin $plugin
    }
    Save-Inventory -Name "state-all-three" -ExpectedInstalled @("context-relay", "execution-budget", "async-wait-guard")
    Remove-Plugin -Plugin "execution-budget"
    Save-Inventory -Name "state-after-independent-remove-execution-budget" -ExpectedInstalled @("context-relay", "async-wait-guard")
    Add-Plugin -Plugin "execution-budget"

    $summary.automatic_inventory_transition_matrix_verified = $true

    Write-Host ""
    Write-Host "MANUAL AUTHENTICATION GATE" -ForegroundColor Yellow
    Write-Host "A separate visible terminal will try Codex device-code authentication, then official browser sign-in if needed." -ForegroundColor Yellow
    Write-Host "Complete the authorization yourself. No authorization code, browser-login output, or account output is written to evidence." -ForegroundColor Yellow
    Invoke-ManualDeviceAuthentication -CodexCommand $script:CodexCommand -NodeHome $nodeHome

    foreach ($plugin in @("context-relay", "execution-budget", "async-wait-guard")) {
        Remove-Plugin -Plugin $plugin
    }
    Save-Inventory -Name "runtime-state-none" -ExpectedInstalled @()

    Add-Plugin -Plugin "context-relay"
    Save-Inventory -Name "runtime-state-only-context-relay" -ExpectedInstalled @("context-relay")
    Invoke-ContextRelayArtifactProbe
    Remove-Plugin -Plugin "context-relay"
    Save-Inventory -Name "runtime-state-context-relay-removed" -ExpectedInstalled @()
    Invoke-RemovedPluginNegativeProbe -Plugin "context-relay"

    Add-Plugin -Plugin "execution-budget"
    Save-Inventory -Name "runtime-state-only-execution-budget" -ExpectedInstalled @("execution-budget")
    Invoke-PrivateRuntimeProbe -Name "probe-execution-budget" -Plugin "execution-budget" -ExpectedMarkers @("BUDGET_PROBE", "no_write_authority=yes") -Prompt @'
Explicitly use $execution-budget for a preview-only synthetic documentation task. Do not execute or modify anything. Return an estimate, confidence, an execution tier, and a pause boundary, followed by one final line exactly: BUDGET_PROBE|skill_invoked=yes|no_write_authority=yes|human_review_required=yes. Do not include account, path, session, or credential information.
'@
    Remove-Plugin -Plugin "execution-budget"
    Save-Inventory -Name "runtime-state-execution-budget-removed" -ExpectedInstalled @()
    Invoke-RemovedPluginNegativeProbe -Plugin "execution-budget"

    Add-Plugin -Plugin "async-wait-guard"
    Save-Inventory -Name "runtime-state-only-async-wait-guard" -ExpectedInstalled @("async-wait-guard")
    Invoke-PrivateRuntimeProbe -Name "probe-async-wait-guard" -Plugin "async-wait-guard" -ExpectedMarkers @("WAIT_PROBE", "empty_wait_ms=300000", "outer_exec_ms=330000", "nonempty_input=send_now", "actual_host_wait_verified=no") -Prompt @'
Explicitly use $async-wait-guard. This is a reasoning-only synthetic probe: do not start, poll, sleep, or measure any real asynchronous process. Evaluate an empty wait, a nested 300000 ms inner wait, and non-empty Y input. Return one final line exactly: WAIT_PROBE|skill_invoked=yes|empty_wait_ms=300000|outer_exec_ms=330000|nonempty_input=send_now|actual_host_wait_verified=no|human_review_required=yes. Do not include account, path, session, or credential information.
'@
    Remove-Plugin -Plugin "async-wait-guard"
    Save-Inventory -Name "runtime-state-async-wait-guard-removed" -ExpectedInstalled @()
    Invoke-RemovedPluginNegativeProbe -Plugin "async-wait-guard"

    foreach ($plugin in @("context-relay", "execution-budget", "async-wait-guard")) { Add-Plugin -Plugin $plugin }
    Save-Inventory -Name "combined-state-all-three" -ExpectedInstalled @("context-relay", "execution-budget", "async-wait-guard")
    $remainingByRemoved = [ordered]@{
        "context-relay" = @("execution-budget", "async-wait-guard")
        "execution-budget" = @("context-relay", "async-wait-guard")
        "async-wait-guard" = @("context-relay", "execution-budget")
    }
    foreach ($plugin in @("context-relay", "execution-budget", "async-wait-guard")) {
        Remove-Plugin -Plugin $plugin
        $remaining = @($remainingByRemoved[$plugin])
        Save-Inventory -Name ("combined-state-removed-" + $plugin) -ExpectedInstalled $remaining
        Invoke-RemovedPluginNegativeProbe -Plugin $plugin -RemainingPlugins $remaining
        Write-JsonEvidence -Name ("combined-removal-" + $plugin + ".review.private.json") -Value ([ordered]@{
            schema_version = "1.0"
            evidence_class = "private-combined-removal-control"
            removed_plugin = $plugin
            remaining_plugins_expected = $remaining
            inventory_confirms_remaining_unaffected = $true
            negative_control_ran_in_new_ephemeral_task = $true
            remaining_skill_runtime_behavior_human_review_required = $true
            automatically_certified = $false
        })
        Add-Plugin -Plugin $plugin
    }
    Save-Inventory -Name "combined-state-restored-all-three" -ExpectedInstalled @("context-relay", "execution-budget", "async-wait-guard")

    & $script:PartialReportHelper -OutputDirectory (Join-Path $script:RunRoot "contract-probe-context-relay") -Plugin "context-relay" -Version "0.3.0-rc.2" -Workflow "handoff-create" -RepositoryCommit $RepositoryCommit -CodexVersion $CodexVersion -ReviewStatusPath (Join-Path $script:RunRoot "probe-context-relay.review.private.json") -UnverifiedBoundaries @(
        "Human review of the generated handoff artifacts and strict validator outputs is pending.",
        "The partial report must not be promoted to success until privacy scanning and reviewed public evidence are complete."
    )
    & $script:PartialReportHelper -OutputDirectory (Join-Path $script:RunRoot "contract-probe-execution-budget") -Plugin "execution-budget" -Version "0.1.0" -Workflow "budget-preview" -RepositoryCommit $RepositoryCommit -CodexVersion $CodexVersion -ReviewStatusPath (Join-Path $script:RunRoot "probe-execution-budget.review.private.json") -UnverifiedBoundaries @(
        "Human review must confirm the budget response used the installed skill rather than only following the probe text."
    )
    & $script:PartialReportHelper -OutputDirectory (Join-Path $script:RunRoot "contract-probe-async-wait-guard") -Plugin "async-wait-guard" -Version "0.1.0" -Workflow "wait-policy" -RepositoryCommit $RepositoryCommit -CodexVersion $CodexVersion -ReviewStatusPath (Join-Path $script:RunRoot "probe-async-wait-guard.review.private.json") -UnverifiedBoundaries @(
        "No actual host asynchronous wait was run or measured.",
        "Human review must confirm the policy response used the installed skill rather than only following the probe text."
    )

    $summary.runtime_probes_executed = $true
    $summary.status = "COMPLETED_PRIVATE_REVIEW_REQUIRED"
}
catch {
    $summary.status = "FAILED_PRIVATE_REVIEW_REQUIRED"
    $summary.failure_stage = $script:CurrentStage
    $summary.failure_class = $_.Exception.GetType().FullName
    $summary.failure_message = $_.Exception.Message
    throw
}
finally {
    $summary.completed_at_utc = [DateTime]::UtcNow.ToString("o")
    Write-JsonEvidence -Name "run-summary.private.json" -Value $summary
    $hashes = Get-ChildItem -LiteralPath $script:RunRoot -File -Recurse | Sort-Object FullName | ForEach-Object {
        [ordered]@{
            relative_path = Get-RelativeEvidencePath -Root $script:RunRoot -Path $_.FullName
            sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    Write-JsonEvidence -Name "sha256.private.json" -Value ([ordered]@{
        schema_version = "1.0"
        generated_at_utc = [DateTime]::UtcNow.ToString("o")
        files = @($hashes)
    })
}

Write-Host "Private evidence is ready for human review in the mapped evidence directory." -ForegroundColor Green
Write-Host "Do not publish this raw directory. Close Windows Sandbox after copying only reviewed, redacted evidence." -ForegroundColor Yellow
