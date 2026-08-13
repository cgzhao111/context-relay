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

$bootstrapPath = Join-Path $PSScriptRoot "bootstrap.ps1"
$bootstrapSha256 = (Get-FileHash -LiteralPath $bootstrapPath -Algorithm SHA256).Hash.ToLowerInvariant()
$partialReportHelperPath = Join-Path $PSScriptRoot "New-CompatibilityPartialReport.ps1"
$partialReportHelperSha256 = (Get-FileHash -LiteralPath $partialReportHelperPath -Algorithm SHA256).Hash.ToLowerInvariant()

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
