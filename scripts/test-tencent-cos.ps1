[CmdletBinding()]
param(
    [string]$EnvFile = (Join-Path (Split-Path -Parent $PSScriptRoot) '.secrets\tencent-cos-smoke.env'),
    [string]$ReportPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'out\tencent-cos-smoke\report.json')
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$serverRoot = Join-Path $repoRoot 'server'
$allowedNames = @(
    'WHAT_THE_REPO_COS_BUCKET',
    'WHAT_THE_REPO_COS_REGION',
    'WHAT_THE_REPO_COS_SECRET_ID',
    'WHAT_THE_REPO_COS_SECRET_KEY',
    'WHAT_THE_REPO_COS_SECRET_KEY_FILE',
    'WHAT_THE_REPO_COS_SECURITY_TOKEN',
    'WHAT_THE_REPO_COS_SECURITY_TOKEN_FILE',
    'WHAT_THE_REPO_COS_PREFIX',
    'WHAT_THE_REPO_COS_DOMAIN',
    'WTR_COS_SMOKE_RUN_ID'
)

if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
    throw "COS smoke environment file was not found: $EnvFile"
}

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($null -eq $npm) {
    throw 'npm.cmd was not found. Install the repository Node.js runtime before running the COS smoke.'
}

$original = @{}
foreach ($name in $allowedNames + @('WHAT_THE_REPO_LOAD_LOCAL_ENV', 'WTR_COS_SMOKE_REPORT_PATH')) {
    $original[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

try {
    foreach ($name in $allowedNames) {
        [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
    foreach ($rawLine in Get-Content -LiteralPath $EnvFile) {
        $line = $rawLine.Trim()
        if (-not $line -or $line.StartsWith('#')) { continue }
        $separator = $line.IndexOf('=')
        if ($separator -le 0) { throw "Invalid environment line in ${EnvFile}." }
        $name = $line.Substring(0, $separator).Trim()
        if ($allowedNames -notcontains $name) {
            throw "Unexpected variable '${name}' in COS smoke environment file."
        }
        $value = $line.Substring($separator + 1).Trim()
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
            ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
    [Environment]::SetEnvironmentVariable('WHAT_THE_REPO_LOAD_LOCAL_ENV', '0', 'Process')
    [Environment]::SetEnvironmentVariable('WTR_COS_SMOKE_REPORT_PATH', $ReportPath, 'Process')

    Push-Location $serverRoot
    try {
        & $npm.Source run smoke:cos
        if ($LASTEXITCODE -ne 0) {
            throw "Tencent COS smoke failed with exit code $LASTEXITCODE."
        }
    } finally {
        Pop-Location
    }
    Write-Host "Tencent COS smoke report: $ReportPath"
} finally {
    foreach ($name in $original.Keys) {
        [Environment]::SetEnvironmentVariable($name, $original[$name], 'Process')
    }
}
