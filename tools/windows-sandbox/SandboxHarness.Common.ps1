Set-StrictMode -Version Latest

function Get-CanonicalPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [switch]$MustExist
    )

    if ($MustExist -and -not (Test-Path -LiteralPath $Path)) {
        throw "Required path does not exist."
    }

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if ($fullPath.Length -gt 3) {
        $fullPath = $fullPath.TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    }
    return $fullPath
}

function Test-IsSameOrDescendantPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Candidate,

        [Parameter(Mandatory = $true)]
        [string]$Root
    )

    $candidatePath = Get-CanonicalPath -Path $Candidate
    $rootPath = Get-CanonicalPath -Path $Root
    if ([string]::Equals($candidatePath, $rootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }

    $rootPrefix = $rootPath.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    return $candidatePath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-PathsOverlap {
    param(
        [Parameter(Mandatory = $true)]
        [string]$First,

        [Parameter(Mandatory = $true)]
        [string]$Second
    )

    return (Test-IsSameOrDescendantPath -Candidate $First -Root $Second) -or
        (Test-IsSameOrDescendantPath -Candidate $Second -Root $First)
}

function Assert-NoReparsePointInPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $current = Get-Item -LiteralPath $Path -Force
    while ($null -ne $current) {
        if (($current.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Reparse points are not accepted for mapped evidence paths."
        }

        $parentPath = Split-Path -Parent $current.FullName
        if ([string]::IsNullOrWhiteSpace($parentPath) -or $parentPath -eq $current.FullName) {
            break
        }
        $current = Get-Item -LiteralPath $parentPath -Force
    }
}

function Assert-SafeEvidenceDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$RepositoryRoot,

        [switch]$RequireEmpty
    )

    $resolved = Get-CanonicalPath -Path $Path -MustExist
    $item = Get-Item -LiteralPath $resolved -Force
    if (-not $item.PSIsContainer) {
        throw "Evidence path must be an existing directory."
    }

    $volumeRoot = [System.IO.Path]::GetPathRoot($resolved)
    if ([string]::Equals($resolved, $volumeRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "A volume root cannot be mapped as evidence output."
    }

    Assert-NoReparsePointInPath -Path $resolved

    $restrictedRoots = New-Object System.Collections.Generic.List[string]
    $restrictedRoots.Add((Get-CanonicalPath -Path $RepositoryRoot))
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        $restrictedRoots.Add((Get-CanonicalPath -Path (Join-Path $env:USERPROFILE ".codex")))
    }
    if (-not [string]::IsNullOrWhiteSpace($env:WINDIR)) {
        $restrictedRoots.Add((Get-CanonicalPath -Path $env:WINDIR))
    }
    if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
        $restrictedRoots.Add((Get-CanonicalPath -Path $env:ProgramFiles))
    }
    $programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
    if (-not [string]::IsNullOrWhiteSpace($programFilesX86)) {
        $restrictedRoots.Add((Get-CanonicalPath -Path $programFilesX86))
    }

    foreach ($restrictedRoot in $restrictedRoots) {
        if (Test-PathsOverlap -First $resolved -Second $restrictedRoot) {
            throw "Evidence output cannot overlap a protected host location."
        }
    }

    $segments = $resolved -split '[\\/]'
    if ($segments | Where-Object { $_ -ieq ".codex" }) {
        throw "Evidence output cannot be inside a .codex directory."
    }

    if ($RequireEmpty) {
        $entry = Get-ChildItem -LiteralPath $resolved -Force | Select-Object -First 1
        if ($null -ne $entry) {
            throw "Evidence output must be empty before it is mapped into Windows Sandbox."
        }
    }

    return $resolved
}

function Assert-SafeHostArtifactPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$RepositoryRoot
    )

    $resolved = Get-CanonicalPath -Path $Path
    $parent = Split-Path -Parent $resolved
    if ([string]::IsNullOrWhiteSpace($parent) -or -not (Test-Path -LiteralPath $parent -PathType Container)) {
        throw "Artifact parent directory must already exist."
    }
    Assert-NoReparsePointInPath -Path $parent

    $existingLeaf = Get-Item -LiteralPath $resolved -Force -ErrorAction SilentlyContinue
    if ($null -ne $existingLeaf -and
        ($existingLeaf.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Reparse points are not accepted for host artifact files."
    }

    if (Test-IsSameOrDescendantPath -Candidate $resolved -Root $RepositoryRoot) {
        throw "Generated host artifacts must remain outside the repository."
    }
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        $codexRoot = Join-Path $env:USERPROFILE ".codex"
        if (Test-IsSameOrDescendantPath -Candidate $resolved -Root $codexRoot) {
            throw "Generated host artifacts must not be written into the host .codex directory."
        }
    }

    return $resolved
}

function Assert-NewHostArtifactPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$RepositoryRoot
    )

    $resolved = Assert-SafeHostArtifactPath -Path $Path -RepositoryRoot $RepositoryRoot
    if ($null -ne (Get-Item -LiteralPath $resolved -Force -ErrorAction SilentlyContinue)) {
        throw "Generated host artifact path must not already exist."
    }

    return $resolved
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Value
    )

    $encoding = New-Object System.Text.UTF8Encoding($false)
    $bytes = $encoding.GetBytes($Value)
    $stream = [System.IO.File]::Open(
        $Path,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None
    )
    try {
        $stream.Write($bytes, 0, $bytes.Length)
    }
    finally {
        $stream.Dispose()
    }
}

function Get-TextSha256 {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
        return ([System.BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
    }
}

function Get-NormalizedPluginInventory {
    param(
        [string]$InventoryJsonPath
    )

    if ([string]::IsNullOrWhiteSpace($InventoryJsonPath)) {
        $raw = (& codex plugin list --available --json 2>&1 | Out-String)
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to read the host Codex plugin inventory."
        }
    }
    else {
        $raw = [System.IO.File]::ReadAllText((Get-CanonicalPath -Path $InventoryJsonPath -MustExist))
    }

    try {
        $inventory = $raw | ConvertFrom-Json
    }
    catch {
        throw "Codex plugin inventory was not valid JSON."
    }

    $installed = @($inventory.installed | ForEach-Object {
        [ordered]@{
            plugin_id = [string]$_.pluginId
            version = [string]$_.version
            enabled = [bool]$_.enabled
        }
    } | Sort-Object plugin_id)

    $targets = @("async-wait-guard@context-relay", "context-relay@context-relay", "execution-budget@context-relay")
    $allRecords = @($inventory.installed) + @($inventory.available)
    $targetPlugins = @($allRecords | Where-Object { $targets -contains [string]$_.pluginId } | ForEach-Object {
        [ordered]@{
            plugin_id = [string]$_.pluginId
            version = [string]$_.version
            installed = [bool]$_.installed
            enabled = [bool]$_.enabled
        }
    } | Sort-Object plugin_id)

    return [ordered]@{
        schema_version = "1.0"
        installed = $installed
        target_plugins = $targetPlugins
    }
}

function ConvertTo-StableInventoryJson {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Inventory
    )

    return ($Inventory | ConvertTo-Json -Depth 8 -Compress)
}
