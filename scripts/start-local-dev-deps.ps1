[CmdletBinding()]
param(
    [switch]$SkipDependencies,
    [switch]$RebuildMigration,
    [string]$LanAddress
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot '.secrets\local.env'
$composeFile = Join-Path $repoRoot 'compose.dev-deps.yaml'
$runtimeDir = Join-Path $repoRoot 'out\runtime-dev-deps'
$pidFile = Join-Path $runtimeDir 'processes.json'

function Resolve-DockerCommand {
    $command = Get-Command docker.exe -ErrorAction SilentlyContinue
    if ($null -ne $command) {
        return $command.Source
    }

    $candidates = @()
    if ($env:ProgramFiles) {
        $candidates += Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe'
        $candidates += Join-Path $env:ProgramFiles 'Docker Desktop\resources\bin\docker.exe'
    }
    if ($env:LOCALAPPDATA) {
        $candidates += Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe'
    }
    $desktopCommand = $candidates |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
        Select-Object -First 1
    if ($desktopCommand) {
        return [string]$desktopCommand
    }
    throw 'Docker CLI was not found. Start Docker Desktop and put docker.exe on PATH.'
}

function Resolve-NodeCommand {
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -ne $command) {
        return $command
    }
    throw 'Node.js was not found on PATH. Install Node.js 22.19 or newer.'
}

function Import-LocalEnvironment {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Missing $Path. Copy .env.example to .secrets/local.env and fill in your own development credentials first."
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

function Get-ConfiguredSecret {
    param([Parameter(Mandatory)][string]$Name)

    $direct = [Environment]::GetEnvironmentVariable($Name, 'Process')
    $fileName = "${Name}_FILE"
    $configuredPath = [Environment]::GetEnvironmentVariable($fileName, 'Process')
    if ($direct -and $configuredPath) {
        throw "Set only $Name or $fileName in the ignored local environment file."
    }
    if ($configuredPath) {
        $path = if ([IO.Path]::IsPathRooted($configuredPath)) {
            $configuredPath
        } else {
            Join-Path $repoRoot $configuredPath
        }
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "$fileName does not point to a readable file."
        }
        return (Get-Content -LiteralPath $path -Raw).Trim()
    }
    if ($null -eq $direct) {
        return ''
    }
    return $direct.Trim()
}

function Set-ComposeSecret {
    param(
        [Parameter(Mandatory)][string]$Name,
        [AllowNull()][string]$Value
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return
    }
    [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
    # Compose receives the resolved value from the process environment. Clear
    # the file variant so a host-only path is never passed into a container.
    [Environment]::SetEnvironmentVariable("${Name}_FILE", '', 'Process')
}

function Normalize-ComposeSecrets {
    $adminPassword = Get-ConfiguredSecret -Name 'POSTGRES_PASSWORD'
    Set-ComposeSecret -Name 'POSTGRES_PASSWORD' -Value $adminPassword

    $runtimePassword = Get-ConfiguredSecret -Name 'POSTGRES_RUNTIME_PASSWORD'
    if (-not $runtimePassword) {
        $runtimePassword = $adminPassword
    }
    Set-ComposeSecret -Name 'POSTGRES_RUNTIME_PASSWORD' -Value $runtimePassword

    $sessionSecret = Get-ConfiguredSecret -Name 'WHAT_THE_REPO_SESSION_SECRET'
    # The migration image cannot read a Windows-only *_FILE path. Materialize
    # the already-validated value only in this PowerShell process so Compose
    # can interpolate it without writing or printing the secret.
    Set-ComposeSecret -Name 'WHAT_THE_REPO_SESSION_SECRET' -Value $sessionSecret
    $encryptionSecret = Get-ConfiguredSecret -Name 'WHAT_THE_REPO_KEY_ENCRYPTION_SECRET'
    if (-not $encryptionSecret) {
        $encryptionSecret = $sessionSecret
    }
    Set-ComposeSecret -Name 'WHAT_THE_REPO_KEY_ENCRYPTION_SECRET' -Value $encryptionSecret
}

function Resolve-PositivePort {
    param(
        [AllowNull()][string]$Value,
        [Parameter(Mandatory)][int]$Fallback
    )
    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $Fallback
    }
    $parsed = 0
    if (-not [int]::TryParse($Value, [ref]$parsed) -or $parsed -lt 1 -or $parsed -gt 65535) {
        throw "Invalid development dependency port: $Value"
    }
    return $parsed
}

function Invoke-Docker {
    param(
        [Parameter(Mandatory)][string[]]$Arguments,
        [switch]$Capture
    )

    $previousErrorActionPreference = $ErrorActionPreference
    try {
        # Windows PowerShell can surface Docker progress on stderr as an error
        # record even when Docker exits successfully.
        $ErrorActionPreference = 'Continue'
        $output = & $docker @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($exitCode -ne 0) {
        $details = ($output | Out-String).Trim()
        throw "Docker command failed with exit code ${exitCode}: $details"
    }
    if ($Capture) {
        return ($output | Out-String).Trim()
    }
    $output | ForEach-Object { Write-Host $_ }
}

function Invoke-Compose {
    param(
        [Parameter(Mandatory)][string[]]$Arguments,
        [switch]$Capture
    )
    return Invoke-Docker -Arguments ($composePrefix + $Arguments) -Capture:$Capture
}

function Test-DockerImage {
    param([Parameter(Mandatory)][string]$Image)
    try {
        Invoke-Docker -Arguments @('image', 'inspect', $Image) -Capture | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Assert-RequiredConfiguration {
    $adminPassword = Get-ConfiguredSecret -Name 'POSTGRES_PASSWORD'
    $runtimePassword = Get-ConfiguredSecret -Name 'POSTGRES_RUNTIME_PASSWORD'
    if (-not $runtimePassword) {
        $runtimePassword = $adminPassword
    }
    if (-not $adminPassword -or -not $runtimePassword) {
        throw 'POSTGRES_PASSWORD and POSTGRES_RUNTIME_PASSWORD (or its documented fallback) are required.'
    }

    $sessionSecret = Get-ConfiguredSecret -Name 'WHAT_THE_REPO_SESSION_SECRET'
    $encryptionSecret = Get-ConfiguredSecret -Name 'WHAT_THE_REPO_KEY_ENCRYPTION_SECRET'
    if (-not $encryptionSecret) {
        $encryptionSecret = $sessionSecret
    }
    if ($sessionSecret.Length -lt 32) {
        throw 'WHAT_THE_REPO_SESSION_SECRET must contain at least 32 characters.'
    }
    if ($encryptionSecret.Length -lt 16) {
        throw 'WHAT_THE_REPO_KEY_ENCRYPTION_SECRET or SESSION_SECRET must contain at least 16 characters.'
    }
}

function Assert-HostPortsAvailable {
    $ports = 5307, 8307
    $patterns = $ports | ForEach-Object { ":$_\s" }
    $listeners = netstat -ano -p TCP | Select-String -Pattern $patterns | Where-Object {
        $_.Line -match '\sLISTENING\s'
    }
    if ($listeners) {
        $details = ($listeners.Line.Trim() -join [Environment]::NewLine)
        throw "A local Web/API port is already in use. Stop the old instance first:`n$details"
    }
}

function Assert-LocalDependencies {
    $required = @(
        (Join-Path $repoRoot 'server\package.json'),
        (Join-Path $repoRoot 'server\node_modules\tsx\package.json'),
        (Join-Path $repoRoot 'web\package.json'),
        (Join-Path $repoRoot 'web\node_modules\vite\package.json')
    )
    $missing = @($required | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) })
    if ($missing.Count -gt 0) {
        $relative = $missing | ForEach-Object { $_.Substring($repoRoot.Length + 1) }
        throw "TypeScript dependencies are missing ($($relative -join ', ')). Run npm ci once in both server and web."
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

function Wait-ForHttp {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][scriptblock]$Validate,
        [Parameter(Mandatory)][string]$FailureMessage
    )
    for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
        Start-Sleep -Milliseconds 500
        try {
            $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 2
            if (& $Validate $response) {
                return
            }
        } catch {
            continue
        }
    }
    throw $FailureMessage
}

function Wait-ForProcessLog {
    param(
        [Parameter(Mandatory)][System.Diagnostics.Process]$Process,
        [Parameter(Mandatory)][string]$LogPath,
        [Parameter(Mandatory)][string]$Pattern,
        [Parameter(Mandatory)][string]$FailureMessage
    )
    for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
        Start-Sleep -Milliseconds 500
        $Process.Refresh()
        if ($Process.HasExited) {
            throw $FailureMessage
        }
        if (Test-Path -LiteralPath $LogPath -PathType Leaf) {
            $log = Get-Content -LiteralPath $LogPath -Raw -ErrorAction SilentlyContinue
            if ($log -match $Pattern) {
                return
            }
        }
    }
    throw $FailureMessage
}

$docker = Resolve-DockerCommand
$nodeCommand = Resolve-NodeCommand
$nodeVersion = (& $nodeCommand.Source --version).Trim().TrimStart('v').Split('.')
if ($nodeVersion.Count -lt 2 -or
    [int]$nodeVersion[0] -lt 22 -or
    ([int]$nodeVersion[0] -eq 22 -and [int]$nodeVersion[1] -lt 19)) {
    throw "Pi requires Node.js 22.19 or newer; found $(& $nodeCommand.Source --version)."
}
$composePrefix = @(
    'compose', '--ansi', 'never', '--project-name', 'what-the-repo-dev-deps',
    '--env-file', $envFile, '-f', $composeFile
)

Import-LocalEnvironment -Path $envFile
# LAN is an explicit local-only mode; never rewrite saved credentials or production settings.
if ($LanAddress) {
    $parsedAddress = $null
    if (-not [Net.IPAddress]::TryParse($LanAddress, [ref]$parsedAddress) -or
        $parsedAddress.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or
        $parsedAddress.ToString() -ne $LanAddress) {
        throw 'LanAddress must be a literal local IPv4 address.'
    }
    $octets = $parsedAddress.GetAddressBytes()
    $privateAddress = $octets[0] -eq 10 -or
        ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or
        ($octets[0] -eq 192 -and $octets[1] -eq 168)
    $assigned = @(Get-NetIPAddress -AddressFamily IPv4 -IPAddress $LanAddress -ErrorAction SilentlyContinue)
    if (-not $privateAddress -or $assigned.Count -eq 0) {
        throw 'LanAddress must be a private IPv4 address assigned to this computer, not a proxy or public address.'
    }
    if ($env:NODE_ENV -eq 'production' -or $env:WHAT_THE_REPO_GITHUB_GATEWAY_URL) {
        throw 'LAN mode is only for local development with direct GitHub OAuth; production/gateway configuration was not changed.'
    }
}
Normalize-ComposeSecrets
Assert-RequiredConfiguration
Assert-LocalDependencies

$postgresPort = Resolve-PositivePort `
    -Value ([Environment]::GetEnvironmentVariable('WTR_DEV_DEPS_POSTGRES_PORT', 'Process')) `
    -Fallback 15432
$redisPort = Resolve-PositivePort `
    -Value ([Environment]::GetEnvironmentVariable('WTR_DEV_DEPS_REDIS_PORT', 'Process')) `
    -Fallback 16379
$env:WTR_DEV_DEPS_POSTGRES_PORT = "$postgresPort"
$env:WTR_DEV_DEPS_REDIS_PORT = "$redisPort"

$databaseName = [Environment]::GetEnvironmentVariable('POSTGRES_DB', 'Process')
if ([string]::IsNullOrWhiteSpace($databaseName)) { $databaseName = 'what_the_repo' }
$runtimeUser = [Environment]::GetEnvironmentVariable('POSTGRES_RUNTIME_USER', 'Process')
if ([string]::IsNullOrWhiteSpace($runtimeUser)) { $runtimeUser = 'what_the_repo_runtime' }
$runtimePassword = Get-ConfiguredSecret -Name 'POSTGRES_RUNTIME_PASSWORD'
if (-not $runtimePassword) { $runtimePassword = Get-ConfiguredSecret -Name 'POSTGRES_PASSWORD' }

# These URLs are for processes on Windows. The migration container uses the
# separate Docker-DNS URL declared in compose.dev-deps.yaml.
$escapedUser = [Uri]::EscapeDataString($runtimeUser)
$escapedPassword = [Uri]::EscapeDataString($runtimePassword)
$escapedDatabase = [Uri]::EscapeDataString($databaseName)
$env:DATABASE_URL = "postgresql://${escapedUser}:${escapedPassword}@127.0.0.1:${postgresPort}/${escapedDatabase}"
$env:DATABASE_URL_FILE = ''
$env:WHAT_THE_REPO_REDIS_URL = "redis://127.0.0.1:${redisPort}"
$env:WHAT_THE_REPO_ROOT = $repoRoot
$dataDir = [Environment]::GetEnvironmentVariable('WHAT_THE_REPO_DATA_DIR', 'Process')
if ([string]::IsNullOrWhiteSpace($dataDir) -or $dataDir.StartsWith('/')) {
    $dataDir = Join-Path $repoRoot '.local\what-the-repo-data'
}
$env:WHAT_THE_REPO_DATA_DIR = $dataDir
$env:WHAT_THE_REPO_SERVER_HOST = '127.0.0.1'
$env:WHAT_THE_REPO_SERVER_PORT = '8307'
$env:WHAT_THE_REPO_BACKEND_URL = 'http://127.0.0.1:8307'
$webUrl = $env:WHAT_THE_REPO_WEB_URL
if ([string]::IsNullOrWhiteSpace($webUrl)) {
    $webUrl = 'http://127.0.0.1:5307'
}
$env:WTR_DEV_LAN_ORIGIN = ''
if ($LanAddress) {
    $webUrl = 'http://' + $LanAddress + ':5307'
    $env:GITHUB_OAUTH_CALLBACK_URL = "$webUrl/api/auth/github/callback"
    $env:WTR_DEV_LAN_ORIGIN = $webUrl
}
$env:WHAT_THE_REPO_WEB_URL = $webUrl
# Retention is intentionally left to a separately deployed scheduler in the
# full Compose/k3s topologies; this dev script starts only API and Worker.
$env:WHAT_THE_REPO_RETENTION_ENABLED = 'false'

Assert-HostPortsAvailable
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
$server = $null
$worker = $null
$web = $null

try {
    if (-not $SkipDependencies) {
        Write-Host "Starting PostgreSQL and Redis on 127.0.0.1:${postgresPort}/${redisPort}..."
        Invoke-Compose -Arguments @('up', '-d', '--wait', 'postgres', 'redis')

        $migrationImage = 'what-the-repo-dev-migration:local-v2'
        if ($RebuildMigration -or -not (Test-DockerImage -Image $migrationImage)) {
            Write-Host 'Building the one-shot migration image...'
            Invoke-Compose -Arguments @('build', 'migration')
        }
        Invoke-Compose -Arguments @('run', '--rm', '--no-deps', 'postgres-role-bootstrap')
        Invoke-Compose -Arguments @('run', '--rm', '--no-deps', 'migration')
    }

    $server = Start-Process -FilePath $nodeCommand.Source -ArgumentList '--import', 'tsx', 'src/main.ts' `
        -WorkingDirectory (Join-Path $repoRoot 'server') -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $runtimeDir 'server.stdout.log') `
        -RedirectStandardError (Join-Path $runtimeDir 'server.stderr.log')
    Wait-ForHttp -Uri 'http://127.0.0.1:8307/api/health' -FailureMessage `
        'TypeScript API failed to start. Check out/runtime-dev-deps/server.stderr.log.' -Validate {
        param($response)
        if ($response.StatusCode -ne 200) { return $false }
        $body = $response.Content | ConvertFrom-Json
        return $body.storage -eq 'postgres'
    }

    $worker = Start-Process -FilePath $nodeCommand.Source -ArgumentList '--import', 'tsx', 'src/analysis/worker-main.ts' `
        -WorkingDirectory (Join-Path $repoRoot 'server') -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $runtimeDir 'worker.stdout.log') `
        -RedirectStandardError (Join-Path $runtimeDir 'worker.stderr.log')
    Wait-ForProcessLog -Process $worker -LogPath (Join-Path $runtimeDir 'worker.stdout.log') `
        -Pattern 'analysis worker ready' `
        -FailureMessage 'Analysis worker failed to connect. Check out/runtime-dev-deps/worker.stderr.log.'

    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($null -eq $npmCommand) {
        throw 'npm.cmd is not available on PATH.'
    }
    $web = Start-Process -FilePath $npmCommand.Source -ArgumentList 'run', 'dev' `
        -WorkingDirectory (Join-Path $repoRoot 'web') -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $runtimeDir 'web.stdout.log') `
        -RedirectStandardError (Join-Path $runtimeDir 'web.stderr.log')
    Wait-ForHttp -Uri 'http://127.0.0.1:5307/' -FailureMessage `
        'Vite Web failed to start. Check out/runtime-dev-deps/web.stderr.log.' -Validate {
        param($response)
        return $response.StatusCode -eq 200
    }

    @{
        server_pid = $server.Id
        worker_pid = $worker.Id
        web_pid = $web.Id
        started_at = [DateTimeOffset]::Now.ToString('o')
        postgres_port = $postgresPort
        redis_port = $redisPort
        web_url = $webUrl
        lan_mode = [bool]$LanAddress
    } | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding utf8

    Write-Host 'what-the-repo local development stack is running:'
    Write-Host "  Web (Vite): $webUrl"
    if ($LanAddress) {
        Write-Host "  Add this GitHub OAuth callback without removing existing callbacks: $env:GITHUB_OAUTH_CALLBACK_URL"
        Write-Host '  Use the Web address above on both computer and phone; browser sessions are separate per host.'
    }
    Write-Host '  API (TypeScript + Pi + MCP): http://127.0.0.1:8307'
    Write-Host "  PostgreSQL (Docker): 127.0.0.1:${postgresPort}"
    Write-Host "  Redis (Docker): 127.0.0.1:${redisPort}"
    Write-Host 'Press Ctrl+C to stop the Windows API, Worker, and Web processes.'

    while ($true) {
        Start-Sleep -Seconds 1
        $server.Refresh()
        $worker.Refresh()
        $web.Refresh()
        if ($server.HasExited -or $worker.HasExited -or $web.HasExited) {
            throw 'A local service exited unexpectedly. Check out/runtime-dev-deps/*.stderr.log.'
        }
    }
} finally {
    Stop-ProcessTree -Process $web
    Stop-ProcessTree -Process $worker
    Stop-ProcessTree -Process $server
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}
