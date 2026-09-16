[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)][int]$WebPort = 15327,
    [switch]$ConfigOnly,
    [switch]$KeepArtifacts
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$project = "wtr-runtime-smoke-$([DateTimeOffset]::UtcNow.ToString('yyyyMMddHHmmss'))-$PID".ToLowerInvariant()
$reportRoot = Join-Path (Join-Path $repoRoot 'out\runtime-compose-smoke') $project
$secretRoot = Join-Path $reportRoot 'secrets'
$envPath = Join-Path $reportRoot 'runtime.env'
$reportPath = Join-Path $reportRoot 'report.json'
$startedAt = [DateTimeOffset]::UtcNow
$succeeded = $false
$resourcesStarted = $false

function Resolve-DockerCommand {
    $command = Get-Command docker -ErrorAction SilentlyContinue
    if ($null -ne $command) {
        return $command.Source
    }
    $desktopCommand = (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe')
    if (Test-Path -LiteralPath $desktopCommand -PathType Leaf) {
        return $desktopCommand
    }
    throw 'Docker CLI was not found.'
}

$docker = Resolve-DockerCommand
$dockerEndpoint = $env:DOCKER_HOST
if (-not $dockerEndpoint) {
    $dockerEndpoint = (& $docker context inspect --format '{{.Endpoints.docker.Host}}' | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the Docker context.' }
}
if ($dockerEndpoint -notmatch '^(npipe|unix)://') {
    throw 'Runtime smoke tests require a local Docker daemon; remote contexts are not used.'
}
$composePrefix = @(
    'compose', '--ansi', 'never', '--project-name', $project,
    '--env-file', $envPath,
    '-f', (Join-Path $repoRoot 'compose.runtime.yaml'),
    '-f', (Join-Path $repoRoot 'compose.runtime-secrets.yaml'),
    '-f', (Join-Path $repoRoot 'infra\docker\compose.runtime-smoke.yaml')
)

function Invoke-Docker {
    param(
        [Parameter(Mandatory)][string[]]$Arguments,
        [switch]$Capture
    )

    # Shell variables override --env-file in Compose. Never inherit instance settings.
    $savedEnvironment = @{}
    foreach ($entry in @(Get-ChildItem Env:)) {
        if ($entry.Name -match '^(WHAT_THE_REPO_|GITHUB_|DATABASE_|POSTGRES_|WTR_|WALG_|AWS_|GRAFANA_|GF_|PROMETHEUS_|VITE_|COMPOSE_|NODE_ENV$)') {
            $savedEnvironment[$entry.Name] = $entry.Value
            [Environment]::SetEnvironmentVariable($entry.Name, $null, 'Process')
        }
    }
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = & $docker @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
        foreach ($name in $savedEnvironment.Keys) {
            [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
        }
    }
    if ($exitCode -ne 0) {
        throw "Docker command failed with exit code ${exitCode}: $(($output | Out-String).Trim())"
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

function Write-Secret {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Value
    )
    [IO.File]::WriteAllText((Join-Path $secretRoot $Name), $Value, [Text.UTF8Encoding]::new($false))
}

New-Item -ItemType Directory -Force -Path $secretRoot | Out-Null
$adminPassword = 'AdminSmoke_012345678901234567890123'
$runtimePassword = 'RuntimeSmoke_01234567890123456789'
$database = 'what_the_repo'
$adminUser = 'what_the_repo'
$runtimeUser = 'what_the_repo_runtime'

Write-Secret -Name 'postgres-admin-password' -Value $adminPassword
Write-Secret -Name 'postgres-runtime-password' -Value $runtimePassword
Write-Secret -Name 'postgres-admin-database-url' -Value "postgresql://${adminUser}:${adminPassword}@postgres:5432/${database}"
Write-Secret -Name 'postgres-runtime-database-url' -Value "postgresql://${runtimeUser}:${runtimePassword}@postgres:5432/${database}"
Write-Secret -Name 'github-oauth-client-secret' -Value 'github-smoke-secret'
Write-Secret -Name 'session-secret' -Value 'session-smoke-secret-01234567890123456789'
Write-Secret -Name 'key-encryption-secret' -Value 'encryption-smoke-secret-0123456789012345'
Write-Secret -Name 'free-provider-api-key' -Value 'free-provider-smoke-key'
Write-Secret -Name 'analysis-provider-api-key' -Value 'analysis-smoke-only'
Write-Secret -Name 'web-search-api-key' -Value 'search-smoke-only'
Write-Secret -Name 'evolution-provider-api-key' -Value 'evolution-smoke-only'
Write-Secret -Name 'feedback-provider-api-key' -Value 'feedback-provider-smoke-key'
Write-Secret -Name 'cos-secret-id' -Value 'unused-cos-secret-id'
Write-Secret -Name 'cos-secret-key' -Value 'unused-cos-secret-key'
Write-Secret -Name 'mcp-token' -Value 'mcp-smoke-token-0123456789012345678901'
Write-Secret -Name 'metrics-token' -Value 'metrics-smoke-token-012345678901234567'
Write-Secret -Name 'grafana-admin-password' -Value 'grafana-smoke-password'
Write-Secret -Name 'postgres-backup-access-key-id' -Value 'unused-backup-access-key'
Write-Secret -Name 'postgres-backup-secret-access-key' -Value 'unused-backup-secret-key'
Write-Secret -Name 'alertmanager.yml' -Value @"
route:
  receiver: production-webhook
receivers:
  - name: production-webhook
    webhook_configs:
      - url: https://example.invalid/alert
        send_resolved: true
"@

$runtimeEnvironment = @"
POSTGRES_DB=$database
POSTGRES_USER=$adminUser
POSTGRES_RUNTIME_USER=$runtimeUser
POSTGRES_MAX_CONNECTIONS=100
POSTGRES_INITDB_ARGS=--data-checksums
POSTGRES_ARCHIVE_MODE=on
POSTGRES_ARCHIVE_TIMEOUT=60s
POSTGRES_BACKUP_FILE_PREFIX=/var/lib/postgresql/backup
POSTGRES_BACKUP_S3_PREFIX=s3://unused-runtime-smoke/postgresql/production
POSTGRES_BACKUP_RETAIN_FULL=2
POSTGRES_BACKUP_PREVENT_WAL_OVERWRITE=true
POSTGRES_BACKUP_S3_SSE=AES256
POSTGRES_BACKUP_AWS_ENDPOINT=https://storage.example.invalid
POSTGRES_BACKUP_AWS_REGION=test-region
POSTGRES_BACKUP_AWS_FORCE_PATH_STYLE=false
WHAT_THE_REPO_REDIS_URL=redis://redis:6379
WHAT_THE_REPO_REDIS_PREFIX=$project
WHAT_THE_REPO_ANALYSIS_QUEUE_CONCURRENCY=1
WHAT_THE_REPO_PROVIDER_CONCURRENCY=2
WHAT_THE_REPO_API_DB_POOL_MAX=4
WHAT_THE_REPO_ANALYSIS_DB_POOL_MAX=4
WHAT_THE_REPO_SCHEDULER_DB_POOL_MAX=2
WHAT_THE_REPO_MIGRATION_DB_POOL_MAX=2
WHAT_THE_REPO_DB_CONNECTION_RESERVE=10
WHAT_THE_REPO_COS_BUCKET=unused-smoke-bucket
WHAT_THE_REPO_COS_REGION=test-region
WHAT_THE_REPO_COS_PREFIX=what-the-repo/runtime-smoke
GITHUB_OAUTH_CLIENT_ID=runtime-smoke-client-id
GITHUB_OAUTH_CALLBACK_URL=https://example.com/api/auth/github/callback
WHAT_THE_REPO_WEB_URL=https://example.com
WHAT_THE_REPO_PUBLIC_DOMAIN=example.com
WHAT_THE_REPO_FREE_PROVIDER_BASE_URL=https://provider.example.invalid
WHAT_THE_REPO_FREE_PROVIDER_MODEL=smoke-model
WHAT_THE_REPO_FEEDBACK_PROVIDER_ID=deepseek
WHAT_THE_REPO_FEEDBACK_PROVIDER_BASE_URL=https://provider.example.invalid
WHAT_THE_REPO_FEEDBACK_PROVIDER_MODEL=smoke-model
WHAT_THE_REPO_MCP_OWNER_ID=github:runtime-smoke
WHAT_THE_REPO_QUOTA_PROVIDER_DEPLOYMENT_CALLS_PER_MINUTE=20
WTR_IMAGE_TAG=$project
WTR_SECRET_ROOT=$($secretRoot -replace '\\','/')
WTR_OPERATIONS_ROOT=$((Join-Path $reportRoot 'operations') -replace '\\','/')
WTR_RUNTIME_SMOKE_WEB_PORT=$WebPort
"@
[IO.File]::WriteAllText($envPath, $runtimeEnvironment, [Text.UTF8Encoding]::new($false))

try {
    Invoke-Compose -Arguments @('config', '--quiet')
    if ($ConfigOnly) {
        $preview = Invoke-Compose -Arguments @('config', '--format', 'json') -Capture | ConvertFrom-Json
        if (-not $preview.services.api.image.EndsWith(":$project") -or
            $preview.services.api.environment.WHAT_THE_REPO_FREE_PROVIDER_BASE_URL -ne 'https://provider.example.invalid' -or
            $preview.services.api.environment.WHAT_THE_REPO_GITHUB_GATEWAY_URL -or
            $preview.services.api.environment.DATABASE_URL -or
            [int]$preview.services.web.ports[0].published -ne $WebPort) {
            throw 'Runtime smoke configuration inherited unexpected instance settings.'
        }
        $succeeded = $true
        Write-Host 'Runtime smoke configuration verified; no services started.'
        return
    }
    $resourcesStarted = $true
    Invoke-Compose -Arguments @(
        'up', '--build', '-d', '--wait', '--wait-timeout', '420',
        '--scale', 'api=2', '--scale', 'analysis-worker=2'
    )

    $health = Invoke-WebRequest -Uri "http://127.0.0.1:${WebPort}/api/health" -UseBasicParsing -TimeoutSec 30
    $healthPayload = $health.Content | ConvertFrom-Json
    if ($health.StatusCode -ne 200 -or $healthPayload.storage -ne 'postgres' -or -not $healthPayload.model_configured) {
        throw 'Runtime smoke health payload is incomplete.'
    }

    $apiIds = @((Invoke-Compose -Arguments @('ps', '-q', 'api') -Capture) -split "`r?`n" | Where-Object { $_ })
    $workerIds = @((Invoke-Compose -Arguments @('ps', '-q', 'analysis-worker') -Capture) -split "`r?`n" | Where-Object { $_ })
    if ($apiIds.Count -ne 2 -or $workerIds.Count -ne 2) {
        throw "Expected 2 API and 2 worker containers; found $($apiIds.Count) and $($workerIds.Count)."
    }

    $apiInspect = Invoke-Docker -Arguments @('inspect', $apiIds[0]) -Capture | ConvertFrom-Json
    if (-not $apiInspect[0].HostConfig.ReadonlyRootfs) {
        throw 'Runtime API root filesystem is not read-only.'
    }
    $environmentText = ($apiInspect[0].Config.Env -join "`n")
    foreach ($secret in @($adminPassword, $runtimePassword, 'github-smoke-secret', 'free-provider-smoke-key')) {
        if ($environmentText.Contains($secret)) {
            throw 'A test secret leaked into the container environment.'
        }
    }
    if ($environmentText.Contains('postgresql://')) {
        throw 'A database URL leaked into the container environment.'
    }

    Invoke-Docker -Arguments @('stop', '--timeout', '20', $apiIds[0])
    Start-Sleep -Seconds 12
    $failover = Invoke-WebRequest -Uri "http://127.0.0.1:${WebPort}/api/health" -UseBasicParsing -TimeoutSec 30
    if ($failover.StatusCode -ne 200) {
        throw 'Web gateway did not fail over to the second API replica.'
    }
    Invoke-Docker -Arguments @('start', $apiIds[0])
    Invoke-Compose -Arguments @('up', '-d', '--wait', '--wait-timeout', '120', '--scale', 'api=2', '--scale', 'analysis-worker=2')

    $finishedAt = [DateTimeOffset]::UtcNow
    [ordered]@{
        ok = $true
        project = $project
        started_at = $startedAt.ToString('o')
        finished_at = $finishedAt.ToString('o')
        duration_seconds = [Math]::Round(($finishedAt - $startedAt).TotalSeconds, 3)
        api_replicas = $apiIds.Count
        analysis_worker_replicas = $workerIds.Count
        api_read_only = $true
        secrets_absent_from_environment = $true
        failover_health_status = $failover.StatusCode
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $reportPath -Encoding utf8

    $succeeded = $true
    Write-Host "Runtime Compose smoke passed. Report: $reportPath"
} finally {
    if (-not $succeeded) {
        try {
            Invoke-Compose -Arguments @('logs', '--no-color') -Capture |
                Set-Content -LiteralPath (Join-Path $reportRoot 'compose.log') -Encoding utf8
        } catch {
            Write-Warning "Could not collect runtime smoke logs: $($_.Exception.Message)"
        }
    }
    if (-not $KeepArtifacts) {
        if ($resourcesStarted) {
            try {
                Invoke-Compose -Arguments @('down', '--volumes', '--remove-orphans')
            } catch {
                Write-Warning "Could not remove runtime smoke resources: $($_.Exception.Message)"
            }
        }
        Remove-Item -LiteralPath $secretRoot -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $envPath -Force -ErrorAction SilentlyContinue
    }
}
