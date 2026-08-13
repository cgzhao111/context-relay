[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$EvidenceDirectory,

    [Parameter(Mandatory = $true)]
    [string]$ConfigPath,

    [Parameter(Mandatory = $true)]
    [string]$HostBaselinePath,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-f]{40}$')]
    [string]$HarnessCommit,

    [string]$HostInventoryJsonPath,

    [switch]$SkipWindowsSandboxCheck,

    [switch]$ForceHostBaseline
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot "SandboxHarness.Common.ps1")

function New-GitProcess {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$Arguments
    )

    $gitCommand = @(Get-Command git.exe -CommandType Application -ErrorAction Stop)[0]
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $gitCommand.Source
    $startInfo.WorkingDirectory = $RepositoryRoot
    $startInfo.Arguments = $Arguments
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    return $process
}

function Assert-HarnessCommit {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$Commit
    )

    $process = New-GitProcess -RepositoryRoot $RepositoryRoot -Arguments "--no-replace-objects cat-file -t $Commit"
    try {
        if (-not $process.Start()) {
            throw "Unable to start git while validating HarnessCommit."
        }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        $objectType = $stdoutTask.GetAwaiter().GetResult().Trim()
        $stderr = $stderrTask.GetAwaiter().GetResult().Trim()
        if ($process.ExitCode -ne 0) {
            throw "HarnessCommit '$Commit' is not a locally available Git object: $stderr"
        }
        if (-not [string]::Equals($objectType, "commit", [System.StringComparison]::Ordinal)) {
            throw "HarnessCommit '$Commit' must identify a Git commit; found '$objectType'."
        }
    }
    finally {
        $process.Dispose()
    }
}

function Get-CommittedFileSha256 {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$Commit,
        [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._/-]+$')][string]$RepositoryRelativePath
    )

    $process = New-GitProcess -RepositoryRoot $RepositoryRoot -Arguments "--no-replace-objects cat-file blob ${Commit}:$RepositoryRelativePath"
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        if (-not $process.Start()) {
            throw "Unable to start git while reading the fixed harness commit."
        }
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $digest = $sha256.ComputeHash($process.StandardOutput.BaseStream)
        $process.WaitForExit()
        $stderr = $stderrTask.GetAwaiter().GetResult().Trim()
        if ($process.ExitCode -ne 0) {
            throw "Unable to read '$RepositoryRelativePath' from HarnessCommit '$Commit': $stderr"
        }
        return ([BitConverter]::ToString($digest)).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
        $process.Dispose()
    }
}

$repositoryRoot = Get-CanonicalPath -Path (Join-Path $PSScriptRoot "..\..")
$resolvedEvidence = Assert-SafeEvidenceDirectory -Path $EvidenceDirectory -RepositoryRoot $repositoryRoot -RequireEmpty
$resolvedConfig = Assert-NewHostArtifactPath -Path $ConfigPath -RepositoryRoot $repositoryRoot
$resolvedBaseline = Assert-NewHostArtifactPath -Path $HostBaselinePath -RepositoryRoot $repositoryRoot

if ([string]::Equals($resolvedConfig, $resolvedBaseline, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "ConfigPath and HostBaselinePath must be different new files."
}

if ([System.IO.Path]::GetExtension($resolvedConfig) -ine ".wsb") {
    throw "ConfigPath must end in .wsb."
}
if (Test-PathsOverlap -First $resolvedEvidence -Second $resolvedConfig) {
    throw "The generated .wsb file must stay outside the mapped evidence directory."
}
if (Test-PathsOverlap -First $resolvedEvidence -Second $resolvedBaseline) {
    throw "The private host baseline must stay outside the mapped evidence directory."
}

$BootstrapUri = "https://raw.githubusercontent.com/cgzhao111/context-relay/$HarnessCommit/tools/windows-sandbox/bootstrap.ps1"

if (-not $SkipWindowsSandboxCheck) {
    $sandboxExecutable = Join-Path $env:WINDIR "System32\WindowsSandbox.exe"
    if (-not (Test-Path -LiteralPath $sandboxExecutable -PathType Leaf)) {
        throw "Windows Sandbox is not available. Enable Containers-DisposableClientVM and restart before generating the run configuration."
    }
}

Assert-HarnessCommit -RepositoryRoot $repositoryRoot -Commit $HarnessCommit
$bootstrapSha256 = Get-CommittedFileSha256 -RepositoryRoot $repositoryRoot -Commit $HarnessCommit -RepositoryRelativePath "tools/windows-sandbox/bootstrap.ps1"
$partialReportHelperSha256 = Get-CommittedFileSha256 -RepositoryRoot $repositoryRoot -Commit $HarnessCommit -RepositoryRelativePath "tools/windows-sandbox/New-CompatibilityPartialReport.ps1"

$baselineArguments = @(
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", (Join-Path $PSScriptRoot "Invoke-HostBaseline.ps1"),
    "-Mode", "Capture",
    "-BaselinePath", $resolvedBaseline
)
if (-not [string]::IsNullOrWhiteSpace($HostInventoryJsonPath)) {
    $baselineArguments += @("-InventoryJsonPath", $HostInventoryJsonPath)
}
if ($ForceHostBaseline) {
    $baselineArguments += "-Force"
}
& powershell.exe @baselineArguments
if ($LASTEXITCODE -ne 0) {
    throw "Host baseline capture failed."
}

$launcher = @"
`$ErrorActionPreference = 'Stop'
`$bootstrapRoot = 'C:\SandboxBootstrap'
New-Item -ItemType Directory -Force -Path `$bootstrapRoot | Out-Null
`$bootstrapPath = Join-Path `$bootstrapRoot 'bootstrap.ps1'
Invoke-WebRequest -UseBasicParsing -Uri '$BootstrapUri' -OutFile `$bootstrapPath
`$actualHash = (Get-FileHash -LiteralPath `$bootstrapPath -Algorithm SHA256).Hash.ToLowerInvariant()
if (`$actualHash -ne '$bootstrapSha256') { throw 'Downloaded bootstrap did not match the host-pinned SHA256.' }
& `$bootstrapPath -EvidenceDirectory 'C:\EvidenceOut' -HarnessCommit '$HarnessCommit' -PartialReportHelperSha256 '$partialReportHelperSha256'
if (`$LASTEXITCODE -ne 0) { throw 'Sandbox bootstrap failed.' }
Read-Host 'Evidence run complete. Export only after privacy review; press ENTER to close this window'
"@
$encodedLauncher = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($launcher))
$escapedEvidence = [System.Security.SecurityElement]::Escape($resolvedEvidence)

$configuration = @"
<Configuration>
  <VGpu>Disable</VGpu>
  <Networking>Enable</Networking>
  <AudioInput>Disable</AudioInput>
  <VideoInput>Disable</VideoInput>
  <ProtectedClient>Enable</ProtectedClient>
  <PrinterRedirection>Disable</PrinterRedirection>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <MemoryInMB>4096</MemoryInMB>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>$escapedEvidence</HostFolder>
      <SandboxFolder>C:\EvidenceOut</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encodedLauncher</Command>
  </LogonCommand>
</Configuration>
"@

Write-Utf8NoBom -Path $resolvedConfig -Value ($configuration + "`n")

Write-Output "WINDOWS_SANDBOX_CONFIG_READY"
Write-Output "The host baseline was captured without modifying Codex plugin state."
Write-Output "Open the generated .wsb file only after other long-running Codex tasks are stopped."
Write-Output "After the Sandbox closes, run Invoke-HostBaseline.ps1 in Compare mode and write its report into the evidence directory."
