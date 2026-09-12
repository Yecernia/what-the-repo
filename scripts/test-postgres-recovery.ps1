[CmdletBinding()]
param(
    [switch]$KeepArtifacts
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $repoRoot 'infra\postgres\compose.recovery-smoke.yaml'
$reportRoot = Join-Path $repoRoot 'out\postgres-recovery-smoke'
$reportPath = Join-Path $reportRoot 'report.json'
$logPath = Join-Path $reportRoot 'compose.log'
$project = "wtr-pg-recovery-$([DateTimeOffset]::UtcNow.ToString('yyyyMMddHHmmss'))-$PID".ToLowerInvariant()
$startedAt = [DateTimeOffset]::UtcNow
$succeeded = $false

function Resolve-DockerCommand {
    $command = Get-Command docker.exe -ErrorAction SilentlyContinue
    if ($null -ne $command) {
        return $command.Source
    }
    $desktopCommand = (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe')
    if (Test-Path -LiteralPath $desktopCommand -PathType Leaf) {
        return $desktopCommand
    }
    throw 'Docker CLI was not found. Start Docker Desktop and put docker.exe on PATH.'
}

$docker = Resolve-DockerCommand
$composePrefix = @('compose', '--ansi', 'never', '-p', $project, '-f', $composeFile)

function Invoke-Docker {
    param(
        [Parameter(Mandatory)][string[]]$Arguments,
        [switch]$Capture
    )

    $previousErrorActionPreference = $ErrorActionPreference
    try {
        # Windows PowerShell 5 surfaces normal Docker build progress from stderr as
        # NativeCommandError records. Docker's exit code remains the source of truth.
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

function Invoke-PsqlScalar {
    param(
        [Parameter(Mandatory)][string]$Service,
        [Parameter(Mandatory)][string]$Sql
    )

    return Invoke-Compose -Arguments @(
        'exec', '-T', $Service,
        'psql', '-qAt', '-v', 'ON_ERROR_STOP=1',
        '-U', 'wtr_recovery', '-d', 'wtr_recovery', '-c', $Sql
    ) -Capture
}

New-Item -ItemType Directory -Force -Path $reportRoot | Out-Null

try {
    Write-Host "Starting isolated PostgreSQL recovery project: $project"
    Invoke-Compose -Arguments @('up', '--build', '-d', '--wait', 'postgres')
    Invoke-Compose -Arguments @('run', '--build', '--rm', 'migration')

    $expectedMigrations = @(
        Get-ChildItem -LiteralPath (Join-Path $repoRoot 'server\migrations') -File |
            Where-Object { $_.Name -match '^\d{4}_.+\.sql$' -and $_.Name -notlike '*.down.sql' }
    ).Count
    $migrationsBefore = [int](Invoke-PsqlScalar -Service 'postgres' -Sql 'SELECT count(*) FROM schema_migrations;')
    if ($migrationsBefore -ne $expectedMigrations) {
        throw "Expected $expectedMigrations migrations before backup, found $migrationsBefore."
    }

    Invoke-PsqlScalar -Service 'postgres' -Sql @"
INSERT INTO app_users(owner_id, login, display_name, payload)
VALUES ('recovery:base', 'recovery-base', 'Recovery Base', jsonb_build_object('phase', 'base'));
SELECT owner_id FROM app_users WHERE owner_id = 'recovery:base';
"@ | Out-Null

    Invoke-Compose -Arguments @('run', '--rm', 'backup')

    $walName = Invoke-PsqlScalar -Service 'postgres' -Sql @"
INSERT INTO app_users(owner_id, login, display_name, payload)
VALUES ('recovery:after', 'recovery-after', 'Recovery After', jsonb_build_object('phase', 'after'));
SELECT pg_walfile_name(pg_current_wal_lsn());
"@
    $walName = ($walName -split "`r?`n" | Select-Object -Last 1).Trim()
    if ($walName -notmatch '^[0-9A-F]{24}$') {
        throw "PostgreSQL returned an invalid WAL file name: $walName"
    }
    Invoke-PsqlScalar -Service 'postgres' -Sql 'SELECT pg_switch_wal();' | Out-Null

    $archived = $false
    for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
        $archiveDone = Invoke-PsqlScalar -Service 'postgres' -Sql "SELECT EXISTS (SELECT 1 FROM pg_ls_archive_statusdir() WHERE name = '$walName.done');"
        if ($archiveDone.Trim() -eq 't') {
            $archived = $true
            break
        }
        Start-Sleep -Seconds 1
    }
    if (-not $archived) {
        throw "PostgreSQL did not archive WAL segment $walName within 60 seconds."
    }

    Invoke-Compose -Arguments @('stop', '-t', '30', 'postgres')
    Invoke-Compose -Arguments @('run', '--rm', '--no-deps', 'restore')
    Invoke-Compose -Arguments @('up', '-d', '--wait', '--no-deps', 'restored')

    $restoredOwners = Invoke-PsqlScalar -Service 'restored' -Sql @"
SELECT string_agg(owner_id, ',' ORDER BY owner_id)
FROM app_users
WHERE owner_id LIKE 'recovery:%';
"@
    $migrationsAfter = [int](Invoke-PsqlScalar -Service 'restored' -Sql 'SELECT count(*) FROM schema_migrations;')
    if ($restoredOwners.Trim() -ne 'recovery:after,recovery:base') {
        throw "Recovered rows were incomplete: $restoredOwners"
    }
    if ($migrationsAfter -ne $expectedMigrations) {
        throw "Expected $expectedMigrations restored migrations, found $migrationsAfter."
    }

    $postgresVersion = Invoke-PsqlScalar -Service 'restored' -Sql 'SHOW server_version;'
    $walGVersionOutput = Invoke-Compose -Arguments @(
        'run', '--rm', '--no-deps', '--entrypoint', '/usr/local/bin/wal-g',
        'restore', '--version'
    ) -Capture
    $walGVersion = @(
        $walGVersionOutput -split "`r?`n" |
            Where-Object { $_.Trim() -match '^wal-g version ' }
    ) | Select-Object -Last 1
    if (-not $walGVersion) {
        throw 'Could not read the WAL-G version from the recovery image.'
    }
    $finishedAt = [DateTimeOffset]::UtcNow
    [ordered]@{
        ok = $true
        project = $project
        started_at = $startedAt.ToString('o')
        finished_at = $finishedAt.ToString('o')
        duration_seconds = [Math]::Round(($finishedAt - $startedAt).TotalSeconds, 3)
        postgres_version = $postgresVersion.Trim()
        wal_g_version = $walGVersion.Trim()
        archived_wal = $walName
        restored_owners = $restoredOwners.Trim().Split(',')
        migration_count = $migrationsAfter
        expected_migration_count = $expectedMigrations
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $reportPath -Encoding utf8

    $succeeded = $true
    Write-Host "Recovery drill passed. Report: $reportPath"
} finally {
    if (-not $succeeded) {
        try {
            Invoke-Compose -Arguments @('logs', '--no-color') -Capture |
                Set-Content -LiteralPath $logPath -Encoding utf8
            Write-Warning "Recovery drill logs were saved to $logPath"
        } catch {
            Write-Warning "Could not collect recovery drill logs: $($_.Exception.Message)"
        }
    }
    if (-not $KeepArtifacts) {
        try {
            Invoke-Compose -Arguments @('down', '--volumes', '--remove-orphans')
        } catch {
            Write-Warning "Could not remove isolated recovery resources: $($_.Exception.Message)"
        }
    } else {
        Write-Host "Keeping isolated Docker resources for project $project"
    }
}
