[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,

    [Parameter(Mandatory = $true)]
    [ValidateSet("context-relay", "execution-budget", "async-wait-guard")]
    [string]$Plugin,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$')]
    [string]$Version,

    [Parameter(Mandatory = $true)]
    [ValidateSet("handoff-create", "budget-preview", "wait-policy")]
    [string]$Workflow,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-f]{40}$')]
    [string]$RepositoryCommit,

    [Parameter(Mandatory = $true)]
    [string]$CodexVersion,

    [Parameter(Mandatory = $true)]
    [string]$ReviewStatusPath,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string[]]$UnverifiedBoundaries
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Utf8NoBom {
    param([string]$Path, [AllowEmptyString()][string]$Value)
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Value, $encoding)
}

$review = [System.IO.Path]::GetFullPath($ReviewStatusPath)
if (-not (Test-Path -LiteralPath $review -PathType Leaf)) {
    throw "Review status artifact does not exist."
}
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) {
    throw "Compatibility report output directory must not already exist."
}
$outputParent = Split-Path -Parent $output
if ([string]::IsNullOrWhiteSpace($outputParent) -or -not (Test-Path -LiteralPath $outputParent -PathType Container)) {
    throw "Compatibility report output parent must already exist."
}

$evidenceDirectory = Join-Path $output "evidence"
New-Item -ItemType Directory -Path $evidenceDirectory -Force | Out-Null
$reviewCopy = Join-Path $evidenceDirectory "review-status.json"
Copy-Item -LiteralPath $review -Destination $reviewCopy
$digest = (Get-FileHash -LiteralPath $reviewCopy -Algorithm SHA256).Hash.ToLowerInvariant()

$report = [ordered]@{
    schema_version = "1.0.0"
    report_id = ("sandbox-" + $Plugin + "-" + [DateTime]::UtcNow.ToString("yyyyMMddHHmmss")).ToLowerInvariant()
    tested_at = [DateTime]::UtcNow.ToString("o")
    reporter_kind = "maintainer"
    plugin = [ordered]@{ id = $Plugin; version = $Version; repository_commit = $RepositoryCommit }
    host = [ordered]@{ surface = "codex-cli-windows-sandbox"; version = "codex-cli $CodexVersion"; os = "Windows"; os_version = "Windows Sandbox not publicly exposed"; architecture = "x64" }
    model = [ordered]@{ name = "account default"; version = "not publicly exposed"; reasoning_effort = "not publicly exposed" }
    installation = [ordered]@{
        method = "marketplace"
        fresh_context = $true
        commands_or_actions = @("Install the pinned public marketplace plugin inside a disposable Windows Sandbox.", "Run the probe in a new ephemeral Codex task.")
        status = "success"
    }
    input = [ordered]@{ kind = "synthetic"; fixture_ref = "examples/basic"; source_completeness = "VISIBLE_CONTEXT_ONLY" }
    workflow = $Workflow
    trigger = [ordered]@{ mode = "explicit"; status = "not-verifiable" }
    steps = @([ordered]@{
        id = "human-review-pending"
        action = "Inspect the private runtime response and its generated artifacts."
        expected = "A reviewer verifies actual skill behavior without relying on marker echo."
        observed = "The runtime probe completed, but no human review has certified its content."
        status = "not-verifiable"
        evidence_ref = "evidence/review-status.json"
    })
    checks = @([ordered]@{ name = "human_review_complete"; status = "not-verifiable"; value = $false })
    result = "partial"
    failures = @()
    unverified_boundaries = @($UnverifiedBoundaries)
    privacy = [ordered]@{ public_evidence_scan = "not-run"; redactions = @("Raw private transcripts and authorization data are excluded from this report artifact."); raw_private_artifacts_excluded = $true }
    evidence = @([ordered]@{ path = "evidence/review-status.json"; sha256 = $digest; media_type = "application/json" })
}

Write-Utf8NoBom -Path (Join-Path $output "report.json") -Value (($report | ConvertTo-Json -Depth 15) + "`n")
Write-Output "PARTIAL_COMPATIBILITY_REPORT_READY"
