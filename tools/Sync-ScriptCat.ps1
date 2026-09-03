[CmdletBinding()]
param(
    [switch]$CheckOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$MappingFile = Join-Path $env:LOCALAPPDATA 'ScriptCatGitSync\mapping.json'
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Normalize-Lf {
    param([Parameter(Mandatory)][string]$Text)

    return $Text.Replace("`r`n", "`n").Replace("`r", "`n")
}

function Get-TextSha256 {
    param([Parameter(Mandatory)][string]$Text)

    $bytes = $Utf8NoBom.GetBytes($Text)
    $hash = [System.Security.Cryptography.SHA256]::HashData($bytes)

    return [Convert]::ToHexString($hash).ToLowerInvariant()
}

function Invoke-Sctl {
    param(
        [Parameter(Mandatory)]
        [string[]]$Arguments
    )

    $sctl = (Get-Command sctl -ErrorAction Stop).Source

    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $sctl

    foreach ($arg in $Arguments) {
        $psi.ArgumentList.Add($arg)
    }

    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = $Utf8NoBom
    $psi.StandardErrorEncoding = $Utf8NoBom
    $psi.CreateNoWindow = $true

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $psi

    try {
        [void]$process.Start()

        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd()

        $process.WaitForExit()

        if ($process.ExitCode -ne 0) {
            throw @"
sctl failed with exit code $($process.ExitCode).

Arguments:
$($Arguments -join ' ')

stderr:
$stderr
"@
        }

        return $stdout
    }
    finally {
        $process.Dispose()
    }
}

function Test-UniqueLiteral {
    param(
        [Parameter(Mandatory)][string]$Haystack,
        [Parameter(Mandatory)][string]$Needle
    )

    if ($Needle.Length -eq 0) {
        return $false
    }

    $first = $Haystack.IndexOf(
        $Needle,
        [System.StringComparison]::Ordinal
    )

    if ($first -lt 0) {
        return $false
    }

    $second = $Haystack.IndexOf(
        $Needle,
        $first + 1,
        [System.StringComparison]::Ordinal
    )

    return ($second -lt 0)
}

function New-AnchoredEdit {
    param(
        [Parameter(Mandatory)][string]$Current,
        [Parameter(Mandatory)][string]$Desired
    )

    if ($Current -ceq $Desired) {
        throw 'New-AnchoredEdit was called for identical strings.'
    }

    $currentLength = $Current.Length
    $desiredLength = $Desired.Length
    $minimumLength = [Math]::Min($currentLength, $desiredLength)

    $prefix = 0

    while (
        $prefix -lt $minimumLength -and
        $Current[$prefix] -ceq $Desired[$prefix]
    ) {
        $prefix++
    }

    $suffix = 0

    while (
        $suffix -lt ($currentLength - $prefix) -and
        $suffix -lt ($desiredLength - $prefix) -and
        $Current[$currentLength - 1 - $suffix] -ceq
            $Desired[$desiredLength - 1 - $suffix]
    ) {
        $suffix++
    }

    $currentDifferenceEnd = $currentLength - $suffix
    $desiredDifferenceEnd = $desiredLength - $suffix

    # 加上下文，使 oldText 在当前源码中唯一。
    # 从较小上下文开始，必要时指数扩大。
    $context = 64

    while ($true) {
        $start = [Math]::Max(0, $prefix - $context)

        $currentEnd = [Math]::Min(
            $currentLength,
            $currentDifferenceEnd + $context
        )

        $desiredEnd = [Math]::Min(
            $desiredLength,
            $desiredDifferenceEnd + $context
        )

        $oldText = $Current.Substring(
            $start,
            $currentEnd - $start
        )

        $newText = $Desired.Substring(
            $start,
            $desiredEnd - $start
        )

        if (Test-UniqueLiteral -Haystack $Current -Needle $oldText) {
            return [pscustomobject]@{
                oldText = $oldText
                newText = $newText
            }
        }

        if (
            $start -eq 0 -and
            $currentEnd -eq $currentLength
        ) {
            throw 'Unable to construct a unique content anchor.'
        }

        $context *= 2
    }
}

function Assert-ScriptIdentity {
    param(
        [Parameter(Mandatory)]$Mapping,
        [Parameter(Mandatory)][string]$Source
    )

    $nameMatch = [regex]::Match(
        $Source,
        '(?m)^//\s*@name\s+(.+?)\s*$'
    )

    $namespaceMatch = [regex]::Match(
        $Source,
        '(?m)^//\s*@namespace\s+(.+?)\s*$'
    )

    if (-not $nameMatch.Success) {
        throw "Script $($Mapping.uuid) has no @name."
    }

    if (-not $namespaceMatch.Success) {
        throw "Script $($Mapping.uuid) has no @namespace."
    }

    $actualName = $nameMatch.Groups[1].Value.Trim()
    $actualNamespace = $namespaceMatch.Groups[1].Value.Trim()

    if ($actualName -cne $Mapping.name) {
        throw @"
Script identity mismatch.

UUID: $($Mapping.uuid)
Expected name: $($Mapping.name)
Actual name:   $actualName
"@
    }

    if ($actualNamespace -cne $Mapping.namespace) {
        throw @"
Script identity mismatch.

UUID: $($Mapping.uuid)
Expected namespace: $($Mapping.namespace)
Actual namespace:   $actualNamespace
"@
    }
}

if (-not (Test-Path -LiteralPath $MappingFile)) {
    throw "Mapping file does not exist: $MappingFile"
}

$status = Invoke-Sctl -Arguments @('status')

if ($status -notmatch '(?im)^extension connected:\s*true\s*$') {
    throw @"
ScriptCat is not connected to sctl.

$status
"@
}

$mapping = @(
    Get-Content -LiteralPath $MappingFile -Raw -Encoding UTF8 |
        ConvertFrom-Json
)

if ($mapping.Count -ne 2) {
    throw "Expected exactly 2 mapping entries; found $($mapping.Count)."
}

foreach ($item in $mapping) {
    Write-Host ''
    Write-Host '========================================' -ForegroundColor Cyan
    Write-Host $item.name -ForegroundColor Cyan
    Write-Host '========================================' -ForegroundColor Cyan

    $gitFile = Join-Path $RepoRoot $item.relativePath

    if (-not (Test-Path -LiteralPath $gitFile)) {
        throw "Git source does not exist: $gitFile"
    }

    # 读取 ScriptCat 当前源码。
    # 在“源码读取 = 需人工审批”策略下，这里可能要求浏览器批准。
    $scriptCatRaw = Invoke-Sctl -Arguments @(
        'get',
        $item.uuid,
        '-o',
        'source'
    )

    Assert-ScriptIdentity -Mapping $item -Source $scriptCatRaw

    $gitRaw = [System.IO.File]::ReadAllText(
        $gitFile,
        $Utf8NoBom
    )

    $gitNormalized = Normalize-Lf $gitRaw
    $scriptCatNormalized = Normalize-Lf $scriptCatRaw

    $gitHash = Get-TextSha256 $gitNormalized
    $scriptCatHash = Get-TextSha256 $scriptCatNormalized

    Write-Host "Git SHA256       : $gitHash"
    Write-Host "ScriptCat SHA256 : $scriptCatHash"

    if ($gitNormalized -ceq $scriptCatNormalized) {
        Write-Host 'UNCHANGED' -ForegroundColor Green
        continue
    }

    Write-Host 'DIFFERENT' -ForegroundColor Yellow

    if ($CheckOnly) {
        Write-Host 'CHECK-ONLY: no write performed.' -ForegroundColor Yellow
        continue
    }

    # sctl edit 必须匹配当前 ScriptCat 的真实文本。
    # Git 与 ScriptCat 仅换行不同的情况前面已经被判定为 UNCHANGED。
    # 真有内容差异时，让目标文本使用 ScriptCat 当前换行风格。
    if ($scriptCatRaw.Contains("`r`n")) {
        $desiredForEdit = $gitNormalized.Replace("`n", "`r`n")
    }
    else {
        $desiredForEdit = $gitNormalized
    }

    $edit = New-AnchoredEdit `
        -Current $scriptCatRaw `
        -Desired $desiredForEdit

    $tempPatch = Join-Path $env:TEMP (
        'scriptcat-edit-' +
        $item.uuid +
        '-' +
        [guid]::NewGuid().ToString('N') +
        '.json'
    )

    try {
        @(
            [ordered]@{
                oldText = $edit.oldText
                newText = $edit.newText
            }
        ) |
            ConvertTo-Json -Depth 4 |
            ForEach-Object {
                [System.IO.File]::WriteAllText(
                    $tempPatch,
                    $_,
                    $Utf8NoBom
                )
            }

        Write-Host 'Waiting for ScriptCat write approval...' -ForegroundColor Yellow

        $editResult = Invoke-Sctl -Arguments @(
            'edit',
            $item.uuid,
            '-f',
            $tempPatch
        )

        if ($editResult.Trim().Length -gt 0) {
            Write-Host $editResult.Trim()
        }
    }
    finally {
        Remove-Item -LiteralPath $tempPatch `
            -Force `
            -ErrorAction SilentlyContinue
    }

    # 写入后重新读取并验证。
    $verifiedRaw = Invoke-Sctl -Arguments @(
        'get',
        $item.uuid,
        '-o',
        'source'
    )

    Assert-ScriptIdentity -Mapping $item -Source $verifiedRaw

    $verifiedNormalized = Normalize-Lf $verifiedRaw
    $verifiedHash = Get-TextSha256 $verifiedNormalized

    Write-Host "Verified SHA256  : $verifiedHash"

    if ($verifiedNormalized -cne $gitNormalized) {
        throw @"
Verification failed after ScriptCat edit.

Git SHA256:       $gitHash
ScriptCat SHA256: $verifiedHash
"@
    }

    Write-Host 'UPDATED + VERIFIED' -ForegroundColor Green
}
