[CmdletBinding()]
param(
    [switch]$KeepArtifacts
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $repoRoot 'infra\postgres\compose.connection-capacity-smoke.yaml'
$reportRoot = Join-Path $repoRoot 'out\postgres-connection-capacity-smoke'
$reportPath = Join-Path $reportRoot 'report.json'
$logPath = Join-Path $reportRoot 'compose.log'
$project = "wtr-pg-capacity-$([DateTimeOffset]::UtcNow.ToString('yyyyMMddHHmmss'))-$PID".ToLowerInvariant()
$startedAt = [DateTimeOffset]::UtcNow
$succeeded = $false
$report = $null

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
    param([Parameter(Mandatory)][string]$Sql)

    return Invoke-Compose -Arguments @(
        'exec', '-T', 'postgres',
        'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
        '-U', 'wtr_capacity_admin', '-d', 'wtr_capacity', '-c', $Sql
    ) -Capture
}

function Wait-ForServiceEvent {
    param(
        [Parameter(Mandatory)][string]$Service,
        [Parameter(Mandatory)][string]$Event,
        [int]$TimeoutSeconds = 30
    )

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        $logs = Invoke-Compose -Arguments @('logs', '--no-color', $Service) -Capture
        if ($logs -match ('"event":"' + [Regex]::Escape($Event) + '"')) {
            return $logs
        }
        $container = (Invoke-Compose -Arguments @('ps', '-q', $Service) -Capture).Trim()
        if ($container) {
            $status = Invoke-Docker -Arguments @('inspect', '--format', '{{.State.Status}}|{{.State.ExitCode}}', $container) -Capture
            if ($status -notmatch '^running\|') {
                throw "Service $Service exited before event '$Event': $status`n$logs"
            }
        }
        Start-Sleep -Milliseconds 250
    }
    throw "Timed out waiting for event '$Event' from service $Service."
}

function Get-JsonEvent {
    param(
        [Parameter(Mandatory)][string]$Text,
        [Parameter(Mandatory)][string]$Event
    )

    foreach ($line in ($Text -split "`r?`n")) {
        $candidate = $line.Trim()
        $brace = $candidate.IndexOf('{')
        if ($brace -lt 0) {
            continue
        }
        try {
            $row = ConvertFrom-Json -InputObject $candidate.Substring($brace)
            if ($row.event -eq $Event) {
                return $row
            }
        } catch {
            continue
        }
    }
    throw "Event '$Event' was not found in command output."
}

function Wait-ForHolderConnections {
    param(
        [Parameter(Mandatory)][int]$Expected,
        [int]$TimeoutSeconds = 20
    )

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    $current = -1
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        $current = [int](Invoke-PsqlScalar -Sql @"
SELECT count(*)
FROM pg_stat_activity
WHERE datname = current_database()
  AND application_name IN (
    'what-the-repo:api-replica-1',
    'what-the-repo:api-replica-2',
    'what-the-repo:analysis-worker-replica-1'
  );
"@)
        if ($current -eq $Expected) {
            return $current
        }
        Start-Sleep -Milliseconds 250
    }
    throw "Expected $Expected holder connections, found $current."
}

function Count-LabeledResources {
    param([Parameter(Mandatory)][ValidateSet('container', 'volume', 'network')][string]$Kind)

    $arguments = switch ($Kind) {
        'container' { @('ps', '-aq', '--filter', "label=com.docker.compose.project=$project") }
        'volume' { @('volume', 'ls', '-q', '--filter', "label=com.docker.compose.project=$project") }
        'network' { @('network', 'ls', '-q', '--filter', "label=com.docker.compose.project=$project") }
    }
    $rows = Invoke-Docker -Arguments $arguments -Capture
    if (-not $rows.Trim()) {
        return 0
    }
    return @($rows -split "`r?`n" | Where-Object { $_.Trim() }).Count
}

New-Item -ItemType Directory -Force -Path $reportRoot | Out-Null

try {
    Write-Host "Starting isolated PostgreSQL connection-capacity project: $project"
    Invoke-Compose -Arguments @('up', '--build', '-d', '--wait', 'postgres')
    Invoke-Compose -Arguments @('run', '--rm', '--no-deps', 'postgres-role-bootstrap')
    Invoke-Compose -Arguments @('run', '--build', '--rm', '--no-deps', 'migration')
    Invoke-Compose -Arguments @('up', '-d', '--no-deps', 'holder-a', 'holder-b', 'holder-c')

    foreach ($service in @('holder-a', 'holder-b', 'holder-c')) {
        Wait-ForServiceEvent -Service $service -Event 'holder_ready' | Out-Null
    }
    $heldBefore = Wait-ForHolderConnections -Expected 9

    $snapshot = ConvertFrom-Json -InputObject (Invoke-PsqlScalar -Sql @"
SELECT json_build_object(
  'postgres_version', current_setting('server_version'),
  'max_connections', current_setting('max_connections')::integer,
  'superuser_reserved_connections', current_setting('superuser_reserved_connections')::integer,
  'runtime_superuser', (SELECT rolsuper FROM pg_roles WHERE rolname = 'wtr_capacity_runtime'),
  'runtime_read_all_stats', pg_has_role('wtr_capacity_runtime', 'pg_read_all_stats', 'member'),
  'runtime_connect', has_database_privilege('wtr_capacity_runtime', current_database(), 'CONNECT'),
  'runtime_temporary', has_database_privilege('wtr_capacity_runtime', current_database(), 'TEMPORARY'),
  'runtime_schema_create', has_schema_privilege('wtr_capacity_runtime', 'public', 'CREATE'),
  'runtime_table_dml', has_table_privilege('wtr_capacity_runtime', 'app_users', 'SELECT,INSERT,UPDATE,DELETE')
)::text;
"@)
    if ($snapshot.max_connections -ne 12 -or $snapshot.superuser_reserved_connections -ne 3) {
        throw "Unexpected PostgreSQL connection limits: $($snapshot | ConvertTo-Json -Compress)"
    }
    if (
        $snapshot.runtime_superuser -ne $false -or
        $snapshot.runtime_read_all_stats -ne $true -or
        $snapshot.runtime_connect -ne $true -or
        $snapshot.runtime_temporary -ne $false -or
        $snapshot.runtime_schema_create -ne $false -or
        $snapshot.runtime_table_dml -ne $true
    ) {
        throw "Runtime role privileges are incorrect: $($snapshot | ConvertTo-Json -Compress)"
    }

    $exhaustedOutput = Invoke-Compose -Arguments @(
        'run', '--rm', '--no-deps',
        '-e', 'WTR_CONNECTION_CAPACITY_EXPECT=exhausted',
        '-e', 'WTR_CONNECTION_CAPACITY_APPLICATION_NAME=what-the-repo:runtime-exhaustion-probe',
        'connection-client'
    ) -Capture
    $exhaustedEvent = Get-JsonEvent -Text $exhaustedOutput -Event 'probe_exhausted'
    if ($exhaustedEvent.error_code -ne '53300') {
        throw "Expected SQLSTATE 53300, received $($exhaustedEvent.error_code)."
    }

    $adminOutput = Invoke-Compose -Arguments @(
        'run', '--rm', '--no-deps',
        '-e', 'DATABASE_URL=postgresql://wtr_capacity_admin:wtr-capacity-admin-test-only@postgres:5432/wtr_capacity',
        '-e', 'WTR_CONNECTION_CAPACITY_EXPECT=success',
        '-e', 'WTR_CONNECTION_CAPACITY_EXPECT_SUPERUSER=true',
        '-e', 'WTR_CONNECTION_CAPACITY_APPLICATION_NAME=what-the-repo:admin-rescue-probe',
        'connection-client'
    ) -Capture
    $adminEvent = Get-JsonEvent -Text $adminOutput -Event 'probe_succeeded'
    if ($adminEvent.superuser -ne $true) {
        throw 'The administrator did not retain a reserved recovery connection.'
    }

    Invoke-Compose -Arguments @('stop', '-t', '10', 'holder-c')
    $heldAfterRelease = Wait-ForHolderConnections -Expected 6

    $recoveryOutput = Invoke-Compose -Arguments @(
        'run', '--rm', '--no-deps',
        '-e', 'WTR_CONNECTION_CAPACITY_EXPECT=success',
        '-e', 'WTR_CONNECTION_CAPACITY_APPLICATION_NAME=what-the-repo:runtime-recovery-probe',
        'connection-client'
    ) -Capture
    $recoveryEvent = Get-JsonEvent -Text $recoveryOutput -Event 'probe_succeeded'
    if ($recoveryEvent.superuser -ne $false) {
        throw 'The recovered runtime connection unexpectedly used a superuser.'
    }

    $finishedAt = [DateTimeOffset]::UtcNow
    $report = [ordered]@{
        ok = $true
        project = $project
        started_at = $startedAt.ToString('o')
        finished_at = $finishedAt.ToString('o')
        duration_seconds = [Math]::Round(($finishedAt - $startedAt).TotalSeconds, 3)
        postgres_version = [string]$snapshot.postgres_version
        max_connections = [int]$snapshot.max_connections
        superuser_reserved_connections = [int]$snapshot.superuser_reserved_connections
        runtime_role = [ordered]@{
            superuser = [bool]$snapshot.runtime_superuser
            read_all_stats = [bool]$snapshot.runtime_read_all_stats
            connect = [bool]$snapshot.runtime_connect
            temporary = [bool]$snapshot.runtime_temporary
            schema_create = [bool]$snapshot.runtime_schema_create
            table_dml = [bool]$snapshot.runtime_table_dml
        }
        exhaustion = [ordered]@{
            held_runtime_connections = $heldBefore
            rejected_error_code = [string]$exhaustedEvent.error_code
            admin_reserved_connection_succeeded = [bool]$adminEvent.superuser
        }
        recovery = [ordered]@{
            held_runtime_connections_after_release = $heldAfterRelease
            runtime_connection_succeeded = ($recoveryEvent.superuser -eq $false)
        }
    }
    $succeeded = $true
} finally {
    if (-not $succeeded) {
        try {
            Invoke-Compose -Arguments @('logs', '--no-color') -Capture |
                Set-Content -LiteralPath $logPath -Encoding utf8
            Write-Warning "Connection-capacity logs were saved to $logPath"
        } catch {
            Write-Warning "Could not collect connection-capacity logs: $($_.Exception.Message)"
        }
    }

    if (-not $KeepArtifacts) {
        try {
            Invoke-Compose -Arguments @('down', '--volumes', '--remove-orphans')
        } catch {
            Write-Warning "Could not remove isolated connection-capacity resources: $($_.Exception.Message)"
        }
    } else {
        Write-Host "Keeping isolated Docker resources for project $project"
    }
}

if ($succeeded) {
    $cleanup = [ordered]@{
        kept = [bool]$KeepArtifacts
        containers_remaining = Count-LabeledResources -Kind container
        volumes_remaining = Count-LabeledResources -Kind volume
        networks_remaining = Count-LabeledResources -Kind network
    }
    if (-not $KeepArtifacts -and ($cleanup.containers_remaining -ne 0 -or $cleanup.volumes_remaining -ne 0 -or $cleanup.networks_remaining -ne 0)) {
        throw "Isolated resources remain after cleanup: $($cleanup | ConvertTo-Json -Compress)"
    }
    $report['cleanup'] = $cleanup
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportPath -Encoding utf8
    Write-Host "Connection-capacity drill passed. Report: $reportPath"
}
