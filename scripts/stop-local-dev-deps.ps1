[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot '.secrets\local.env'
$composeFile = Join-Path $repoRoot 'compose.dev-deps.yaml'

if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
    throw "Missing $envFile. The development dependency Compose needs the ignored local environment file."
}
if (-not (Test-Path -LiteralPath $composeFile -PathType Leaf)) {
    throw "Missing $composeFile."
}

$dockerPath = $null
$dockerCommand = Get-Command docker.exe -ErrorAction SilentlyContinue
if ($null -ne $dockerCommand) {
    $dockerPath = $dockerCommand.Source
} else {
    $candidates = @()
    if ($env:ProgramFiles) {
        $candidates += Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe'
        $candidates += Join-Path $env:ProgramFiles 'Docker Desktop\resources\bin\docker.exe'
    }
    if ($env:LOCALAPPDATA) {
        $candidates += Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe'
    }
    $dockerPath = $candidates |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
        Select-Object -First 1
    if (-not $dockerPath) {
        throw 'Docker CLI was not found. Start Docker Desktop and put docker.exe on PATH.'
    }
}

& $dockerPath compose --ansi never --project-name what-the-repo-dev-deps `
    --env-file $envFile -f $composeFile down --remove-orphans
if ($LASTEXITCODE -ne 0) {
    throw "Docker Compose cleanup failed with exit code $LASTEXITCODE."
}

Write-Host 'Development dependency containers and network stopped.'
Write-Host 'Persistent volumes were kept: what-the-repo-dev-deps-postgres-data and what-the-repo-dev-deps-redis-data.'
