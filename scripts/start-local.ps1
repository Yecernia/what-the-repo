[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot '.secrets\local.env'
$runtimeDir = Join-Path $repoRoot 'out\runtime'
$pidFile = Join-Path $repoRoot '.secrets\local-processes.json'

function Import-LocalEnvironment {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Missing $Path. Create it from the local credentials template first."
    }

    $lineNumber = 0
    foreach ($rawLine in Get-Content -LiteralPath $Path) {
        $lineNumber += 1
        $line = $rawLine.Trim()
        if (-not $line -or $line.StartsWith('#')) {
            continue
        }

        $separator = $line.IndexOf('=')
        if ($separator -le 0) {
            throw "Invalid environment entry at ${Path}:$lineNumber"
        }

        $name = $line.Substring(0, $separator).Trim()
        $value = $line.Substring($separator + 1).Trim()
        if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
            throw "Invalid environment variable name at ${Path}:$lineNumber"
        }
        if ($value.Length -ge 2) {
            $quoted = ($value.StartsWith('"') -and $value.EndsWith('"')) -or
                ($value.StartsWith("'") -and $value.EndsWith("'"))
            if ($quoted) {
                $value = $value.Substring(1, $value.Length - 2)
            }
        }
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
}

function Assert-RequiredConfiguration {
    $required = @(
        'GITHUB_OAUTH_CLIENT_ID',
        'GITHUB_OAUTH_CLIENT_SECRET',
        'GITHUB_OAUTH_CALLBACK_URL',
        'WHAT_THE_REPO_SESSION_SECRET'
    )
    $missing = @($required | Where-Object { -not [Environment]::GetEnvironmentVariable($_, 'Process') })
    if ($missing.Count -gt 0) {
        throw "Fill these values in .secrets/local.env: $($missing -join ', ')"
    }
    if ($env:WHAT_THE_REPO_SESSION_SECRET.Length -lt 32) {
        throw 'WHAT_THE_REPO_SESSION_SECRET must contain at least 32 characters.'
    }
    $freeProviderKey = $env:WHAT_THE_REPO_FREE_PROVIDER_API_KEY
    $freeProviderKeyFile = $env:WHAT_THE_REPO_FREE_PROVIDER_API_KEY_FILE
    if ($freeProviderKey -and $freeProviderKeyFile) {
        throw 'Set only one of WHAT_THE_REPO_FREE_PROVIDER_API_KEY and WHAT_THE_REPO_FREE_PROVIDER_API_KEY_FILE in .secrets/local.env.'
    }
    if (-not $freeProviderKey -and -not $freeProviderKeyFile) {
        Write-Warning 'WHAT_THE_REPO_FREE_PROVIDER_API_KEY is empty; the free experience model will be unavailable.'
    }
    $feedbackProviderKey = $env:WHAT_THE_REPO_FEEDBACK_PROVIDER_API_KEY
    $feedbackProviderKeyFile = $env:WHAT_THE_REPO_FEEDBACK_PROVIDER_API_KEY_FILE
    if ($feedbackProviderKey -and $feedbackProviderKeyFile) {
        throw 'Set only one of WHAT_THE_REPO_FEEDBACK_PROVIDER_API_KEY and WHAT_THE_REPO_FEEDBACK_PROVIDER_API_KEY_FILE in .secrets/local.env.'
    }
}

function Assert-PortsAvailable {
    $ports = 5307, 8307
    $patterns = $ports | ForEach-Object { ":$_\s" }
    $listeners = netstat -ano -p TCP | Select-String -Pattern $patterns | Where-Object {
        $_.Line -match '\sLISTENING\s'
    }
    if ($listeners) {
        $details = ($listeners.Line.Trim() -join [Environment]::NewLine)
        throw "A what-the-repo port is already in use. Stop the old instance first:`n$details"
    }
}

function Stop-ProcessTree {
    param([AllowNull()][System.Diagnostics.Process]$Process)

    if ($null -eq $Process) {
        return
    }
    $Process.Refresh()
    if (-not $Process.HasExited) {
        & taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null
    }
}

# These credential variables are mutually exclusive. Make the local file authoritative so a
# stale value inherited from an earlier PowerShell session cannot break startup.
foreach ($name in @(
    'WHAT_THE_REPO_FREE_PROVIDER_API_KEY',
    'WHAT_THE_REPO_FREE_PROVIDER_API_KEY_FILE',
    'WHAT_THE_REPO_FEEDBACK_PROVIDER_API_KEY',
    'WHAT_THE_REPO_FEEDBACK_PROVIDER_API_KEY_FILE',
    'WHAT_THE_REPO_EVOLUTION_PROVIDER_API_KEY',
    'WHAT_THE_REPO_EVOLUTION_PROVIDER_API_KEY_FILE'
)) {
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}
Import-LocalEnvironment -Path $envFile
if (-not $env:WHAT_THE_REPO_WEB_URL) {
    $env:WHAT_THE_REPO_WEB_URL = 'http://127.0.0.1:5307'
}
$env:WHAT_THE_REPO_SERVER_HOST = '127.0.0.1'
$env:WHAT_THE_REPO_SERVER_PORT = '8307'
Assert-RequiredConfiguration
Assert-PortsAvailable

$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($null -eq $npmCommand) {
    throw 'npm.cmd is not available on PATH.'
}
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) {
    throw 'Node.js is not available on PATH. Install Node.js 22.19 or newer.'
}
$nodeVersion = (& $nodeCommand.Source --version).Trim().TrimStart('v').Split('.')
if ($nodeVersion.Count -lt 2 -or
    [int]$nodeVersion[0] -lt 22 -or
    ([int]$nodeVersion[0] -eq 22 -and [int]$nodeVersion[1] -lt 19)) {
    throw "Pi requires Node.js 22.19 or newer; found $(& $nodeCommand.Source --version)."
}
$serverPackage = Join-Path $repoRoot 'server\package.json'
$serverModules = Join-Path $repoRoot 'server\node_modules'
$webPackage = Join-Path $repoRoot 'web\package.json'
$webModules = Join-Path $repoRoot 'web\node_modules'
if (-not (Test-Path -LiteralPath $serverPackage -PathType Leaf) -or
    -not (Test-Path -LiteralPath $serverModules -PathType Container) -or
    -not (Test-Path -LiteralPath $webPackage -PathType Leaf) -or
    -not (Test-Path -LiteralPath $webModules -PathType Container)) {
    throw 'TypeScript dependencies are missing. Run npm ci once in both server and web.'
}

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
$server = $null
$web = $null

try {
    $server = Start-Process -FilePath $npmCommand.Source -ArgumentList 'run', 'dev' `
        -WorkingDirectory (Join-Path $repoRoot 'server') -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $runtimeDir 'server.stdout.log') `
        -RedirectStandardError (Join-Path $runtimeDir 'server.stderr.log')

    $apiReady = $false
    for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
        Start-Sleep -Milliseconds 500
        $server.Refresh()
        if ($server.HasExited) {
            break
        }
        try {
            $response = Invoke-WebRequest -Uri 'http://127.0.0.1:8307/api/health' `
                -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) {
                $apiReady = $true
                break
            }
        } catch {
            continue
        }
    }
    if (-not $apiReady) {
        throw 'TypeScript server failed to start. Check out/runtime/server.stderr.log.'
    }

    $web = Start-Process -FilePath $npmCommand.Source -ArgumentList 'run', 'dev' `
        -WorkingDirectory (Join-Path $repoRoot 'web') -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $runtimeDir 'web.stdout.log') `
        -RedirectStandardError (Join-Path $runtimeDir 'web.stderr.log')

    $webReady = $false
    for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
        Start-Sleep -Milliseconds 500
        $web.Refresh()
        if ($web.HasExited) {
            break
        }
        try {
            $response = Invoke-WebRequest -Uri 'http://127.0.0.1:5307/' `
                -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) {
                $webReady = $true
                break
            }
        } catch {
            continue
        }
    }
    if (-not $webReady) {
        throw 'Web failed to start. Check out/runtime/web.stderr.log.'
    }

    @{
        server_pid = $server.Id
        web_pid = $web.Id
        started_at = [DateTimeOffset]::Now.ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding utf8

    Write-Host 'what-the-repo is running:'
    Write-Host '  Web: http://127.0.0.1:5307'
    Write-Host '  TypeScript API + Pi + MCP: http://127.0.0.1:8307'
    Write-Host 'Press Ctrl+C to stop all processes.'

    while ($true) {
        Start-Sleep -Seconds 1
        $server.Refresh()
        $web.Refresh()
        if ($server.HasExited -or $web.HasExited) {
            throw 'A local service exited unexpectedly. Check out/runtime/*.stderr.log.'
        }
    }
} finally {
    Stop-ProcessTree -Process $web
    Stop-ProcessTree -Process $server
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}
