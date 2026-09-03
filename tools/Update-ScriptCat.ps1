[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$SyncScript = Join-Path $PSScriptRoot 'Sync-ScriptCat.ps1'

function Invoke-Git {
    param(
        [Parameter(Mandatory)]
        [string[]]$Arguments
    )

    & git @Arguments

    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
}

if (-not (Test-Path -LiteralPath $SyncScript)) {
    throw "Sync script does not exist: $SyncScript"
}

Push-Location $RepoRoot

try {
    $insideWorkTree = (& git rev-parse --is-inside-work-tree 2>$null)

    if (
        $LASTEXITCODE -ne 0 -or
        $insideWorkTree.Trim() -cne 'true'
    ) {
        throw "Not a Git working tree: $RepoRoot"
    }

    $branch = (& git branch --show-current)

    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to determine current Git branch.'
    }

    if ($branch.Trim() -cne 'main') {
        throw "Expected branch 'main', current branch is '$($branch.Trim())'."
    }

    # 必须在任何 fetch / pull 之前确认工作区完全干净。
    # 包括 tracked 与 untracked 文件。
    $dirty = @(
        & git status --porcelain=v1 --untracked-files=all
    )

    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to inspect Git working tree.'
    }

    if ($dirty.Count -gt 0) {
        throw @"
Git working tree is not clean.

Update aborted before fetch/pull.

Changes:
$($dirty -join [Environment]::NewLine)

Commit, discard, or otherwise resolve these changes manually first.
No stash/reset/clean was performed.
"@
    }

    Write-Host 'Fetching origin/main...' -ForegroundColor Cyan

    Invoke-Git -Arguments @(
        'fetch',
        'origin',
        'main'
    )

    # fetch 本身不会改变工作区，但仍确认没有意外变化。
    $dirtyAfterFetch = @(
        & git status --porcelain=v1 --untracked-files=all
    )

    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to re-check Git working tree after fetch.'
    }

    if ($dirtyAfterFetch.Count -gt 0) {
        throw @"
Working tree changed unexpectedly after fetch.

Pull aborted.

Changes:
$($dirtyAfterFetch -join [Environment]::NewLine)
"@
    }

    Write-Host 'Fast-forwarding from origin/main...' -ForegroundColor Cyan

    Invoke-Git -Arguments @(
        'pull',
        '--ff-only',
        'origin',
        'main'
    )

    Write-Host ''
    Write-Host 'Git update complete.' -ForegroundColor Green
    Write-Host 'Synchronizing ScriptCat...' -ForegroundColor Cyan

    & pwsh `
        -NoProfile `
        -File $SyncScript

    if ($LASTEXITCODE -ne 0) {
        throw "Sync-ScriptCat.ps1 failed with exit code $LASTEXITCODE."
    }

    Write-Host ''
    Write-Host 'Update + ScriptCat sync completed.' -ForegroundColor Green
}
finally {
    Pop-Location
}
