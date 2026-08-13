[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Capture", "Compare")]
    [string]$Mode,

    [Parameter(Mandatory = $true)]
    [string]$BaselinePath,

    [string]$ReportPath,

    [string]$InventoryJsonPath,

    [switch]$Force
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot "SandboxHarness.Common.ps1")

$repositoryRoot = Get-CanonicalPath -Path (Join-Path $PSScriptRoot "..\..")
$resolvedBaseline = Assert-SafeHostArtifactPath -Path $BaselinePath -RepositoryRoot $repositoryRoot

if ($Mode -eq "Capture") {
    if ((Test-Path -LiteralPath $resolvedBaseline) -and -not $Force) {
        throw "Baseline already exists. Choose a new path or pass -Force intentionally."
    }

    $inventory = Get-NormalizedPluginInventory -InventoryJsonPath $InventoryJsonPath
    $stableInventory = ConvertTo-StableInventoryJson -Inventory $inventory
    $codexVersion = "offline-fixture"
    if ([string]::IsNullOrWhiteSpace($InventoryJsonPath)) {
        $codexVersion = (& codex --version 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to read the host Codex CLI version."
        }
    }

    $baseline = [ordered]@{
        schema_version = "1.0"
        evidence_class = "private-host-baseline"
        captured_at_utc = [DateTime]::UtcNow.ToString("o")
        codex_cli_version = $codexVersion
        inventory_sha256 = Get-TextSha256 -Value $stableInventory
        inventory = $inventory
    }
    Write-Utf8NoBom -Path $resolvedBaseline -Value (($baseline | ConvertTo-Json -Depth 10) + "`n")
    Write-Output "HOST_BASELINE_CAPTURED"
    exit 0
}

if ([string]::IsNullOrWhiteSpace($ReportPath)) {
    throw "ReportPath is required in Compare mode."
}
if (-not (Test-Path -LiteralPath $resolvedBaseline -PathType Leaf)) {
    throw "Baseline file does not exist."
}

$resolvedReport = Assert-SafeHostArtifactPath -Path $ReportPath -RepositoryRoot $repositoryRoot
$baseline = [System.IO.File]::ReadAllText($resolvedBaseline) | ConvertFrom-Json
$currentInventory = Get-NormalizedPluginInventory -InventoryJsonPath $InventoryJsonPath
$currentStable = ConvertTo-StableInventoryJson -Inventory $currentInventory
$currentHash = Get-TextSha256 -Value $currentStable
$unchanged = [string]::Equals(
    [string]$baseline.inventory_sha256,
    $currentHash,
    [System.StringComparison]::OrdinalIgnoreCase
)

$baselineStateById = @{}
foreach ($record in @($baseline.inventory.installed)) {
    $baselineStateById[[string]$record.plugin_id] = [ordered]@{
        version = [string]$record.version
        installed = $true
        enabled = [bool]$record.enabled
    }
}
foreach ($record in @($baseline.inventory.target_plugins)) {
    $baselineStateById[[string]$record.plugin_id] = [ordered]@{
        version = [string]$record.version
        installed = [bool]$record.installed
        enabled = [bool]$record.enabled
    }
}

$currentStateById = @{}
foreach ($record in @($currentInventory.installed)) {
    $currentStateById[[string]$record.plugin_id] = [ordered]@{
        version = [string]$record.version
        installed = $true
        enabled = [bool]$record.enabled
    }
}
foreach ($record in @($currentInventory.target_plugins)) {
    $currentStateById[[string]$record.plugin_id] = [ordered]@{
        version = [string]$record.version
        installed = [bool]$record.installed
        enabled = [bool]$record.enabled
    }
}

$allPluginIds = @($baselineStateById.Keys) + @($currentStateById.Keys) | Sort-Object -Unique
$changedPluginStates = @($allPluginIds | ForEach-Object {
    $pluginId = [string]$_
    $hasBaseline = $baselineStateById.ContainsKey($pluginId)
    $hasCurrent = $currentStateById.ContainsKey($pluginId)
    $baselineState = if ($hasBaseline) { $baselineStateById[$pluginId] } else { $null }
    $currentState = if ($hasCurrent) { $currentStateById[$pluginId] } else { $null }
    $changed = -not $hasBaseline -or -not $hasCurrent
    if ($hasBaseline -and $hasCurrent) {
        $changed =
            -not [string]::Equals([string]$baselineState.version, [string]$currentState.version, [System.StringComparison]::Ordinal) -or
            [bool]$baselineState.installed -ne [bool]$currentState.installed -or
            [bool]$baselineState.enabled -ne [bool]$currentState.enabled
    }
    if ($changed) {
        [ordered]@{
            plugin_id = $pluginId
            change_type = if (-not $hasBaseline) { "added" } elseif (-not $hasCurrent) { "removed" } else { "modified" }
            baseline_version = if ($hasBaseline) { [string]$baselineState.version } else { $null }
            current_version = if ($hasCurrent) { [string]$currentState.version } else { $null }
            baseline_installed = if ($hasBaseline) { [bool]$baselineState.installed } else { $null }
            current_installed = if ($hasCurrent) { [bool]$currentState.installed } else { $null }
            baseline_enabled = if ($hasBaseline) { [bool]$baselineState.enabled } else { $null }
            current_enabled = if ($hasCurrent) { [bool]$currentState.enabled } else { $null }
        }
    }
})
$changedPluginIds = @($changedPluginStates | ForEach-Object { [string]$_.plugin_id })

$comparison = [ordered]@{
    schema_version = "1.0"
    evidence_class = "private-host-baseline-comparison"
    compared_at_utc = [DateTime]::UtcNow.ToString("o")
    host_inventory_unchanged = $unchanged
    baseline_inventory_sha256 = [string]$baseline.inventory_sha256
    current_inventory_sha256 = $currentHash
    changed_plugin_ids = $changedPluginIds
    changed_plugin_states = $changedPluginStates
    note = "This read-only comparison does not establish causality; it only compares normalized host plugin inventory before and after the isolated run."
}
Write-Utf8NoBom -Path $resolvedReport -Value (($comparison | ConvertTo-Json -Depth 8) + "`n")

if (-not $unchanged) {
    [Console]::Error.WriteLine("HOST_BASELINE_MISMATCH")
    exit 3
}

Write-Output "HOST_BASELINE_UNCHANGED"
exit 0
