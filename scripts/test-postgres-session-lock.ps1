[CmdletBinding()]
param(
    [switch]$KeepArtifacts
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $repoRoot 'infra\postgres\compose.session-lock-smoke.yaml'
$reportRoot = Join-Path $repoRoot 'out\postgres-session-lock-smoke'
$reportPath = Join-Path $reportRoot 'report.json'
$composeLogPath = Join-Path $reportRoot 'compose.log'
$project = "wtr-session-lock-$([DateTimeOffset]::UtcNow.ToString('yyyyMMddHHmmss'))-$PID".ToLowerInvariant()
$holderContainer = "$project-holder"
$waiterContainer = "$project-waiter"
$cancelHolderContainer = "$project-cancel-holder"
$cancelWaiterContainer = "$project-cancel-waiter"
$timeoutHolderContainer = "$project-timeout-holder"
$timeoutWaiterContainer = "$project-timeout-waiter"
$smokeContainers = @(
    $holderContainer,
    $waiterContainer,
    $cancelHolderContainer,
    $cancelWaiterContainer,
    $timeoutHolderContainer,
    $timeoutWaiterContainer
)
$ownerId = 'session-lock-smoke:owner'
$projectId = 'session-lock-smoke:project'
$sessionId = 'session-lock-smoke:shared'
$cancelSessionId = 'session-lock-smoke:cancel'
$timeoutSessionId = 'session-lock-smoke:timeout'
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
        'psql', '-qAt', '-v', 'ON_ERROR_STOP=1',
        '-U', 'wtr_session_lock', '-d', 'wtr_session_lock', '-c', $Sql
    ) -Capture
}

function Get-ContainerLogs {
    param([Parameter(Mandatory)][string]$Container)

    return Invoke-Docker -Arguments @('logs', $Container) -Capture
}

function Wait-ForLogEvent {
    param(
        [Parameter(Mandatory)][string]$Container,
        [Parameter(Mandatory)][string]$Event,
        [int]$TimeoutSeconds = 30
    )

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        $logs = Get-ContainerLogs -Container $Container
        if ($logs -match ('"event":"' + [Regex]::Escape($Event) + '"')) {
            return $logs
        }
        $status = Invoke-Docker -Arguments @('inspect', '--format', '{{.State.Status}}|{{.State.ExitCode}}', $Container) -Capture
        if ($status -notmatch '^running\|') {
            $finalLogs = Get-ContainerLogs -Container $Container
            if ($finalLogs -match ('"event":"' + [Regex]::Escape($Event) + '"')) {
                return $finalLogs
            }
            throw "Container $Container exited before event '$Event': $status`n$finalLogs"
        }
        Start-Sleep -Milliseconds 250
    }
    throw "Timed out waiting for event '$Event' from $Container."
}

function Wait-ForContainerExit {
    param(
        [Parameter(Mandatory)][string]$Container,
        [int]$TimeoutSeconds = 30
    )

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        $status = Invoke-Docker -Arguments @(
            'inspect', '--format', '{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}', $Container
        ) -Capture
        if ($status -match '^exited\|') {
            return $status
        }
        Start-Sleep -Milliseconds 250
    }
    throw "Timed out waiting for container $Container to exit."
}

function Wait-ForPhaseLockPair {
    param(
        [Parameter(Mandatory)][string]$Phase,
        [int]$TimeoutSeconds = 30
    )

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    $lastSnapshot = '[]'
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        $lastSnapshot = Invoke-PsqlScalar -Sql @"
SELECT COALESCE(json_agg(lock_row ORDER BY application_name, granted DESC), '[]'::json)::text
FROM (
  SELECT a.application_name, a.state, a.wait_event_type, a.wait_event, l.granted
  FROM pg_locks AS l
  JOIN pg_stat_activity AS a ON a.pid = l.pid
  WHERE l.locktype = 'advisory'
    AND a.datname = current_database()
    AND a.application_name LIKE 'what-the-repo:session-lock-smoke:${Phase}:%'
) AS lock_row;
"@
        $phaseLocks = ConvertFrom-Json -InputObject $lastSnapshot
        $holderGranted = @($phaseLocks | Where-Object {
            $_.application_name -eq "what-the-repo:session-lock-smoke:${Phase}:holder" -and $_.granted -eq $true
        }).Count
        $waiterWaiting = @($phaseLocks | Where-Object {
            $_.application_name -eq "what-the-repo:session-lock-smoke:${Phase}:waiter" -and $_.granted -eq $false
        }).Count
        if ($holderGranted -eq 1 -and $waiterWaiting -eq 1) {
            return $lastSnapshot
        }
        Start-Sleep -Milliseconds 250
    }
    throw "PostgreSQL did not expose one granted holder and one waiting waiter for phase ${Phase}: $lastSnapshot"
}

function Wait-ForPhaseWaiterRelease {
    param(
        [Parameter(Mandatory)][string]$Phase,
        [int]$TimeoutSeconds = 10
    )

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    $lastSnapshot = '[]'
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        $lastSnapshot = Invoke-PsqlScalar -Sql @"
SELECT COALESCE(json_agg(lock_row ORDER BY application_name, granted DESC), '[]'::json)::text
FROM (
  SELECT a.application_name, l.granted
  FROM pg_locks AS l
  JOIN pg_stat_activity AS a ON a.pid = l.pid
  WHERE l.locktype = 'advisory'
    AND a.datname = current_database()
    AND a.application_name LIKE 'what-the-repo:session-lock-smoke:${Phase}:%'
) AS lock_row;
"@
        $phaseLocks = ConvertFrom-Json -InputObject $lastSnapshot
        $holderGranted = @($phaseLocks | Where-Object {
            $_.application_name -eq "what-the-repo:session-lock-smoke:${Phase}:holder" -and $_.granted -eq $true
        }).Count
        $waiterCount = @($phaseLocks | Where-Object {
            $_.application_name -eq "what-the-repo:session-lock-smoke:${Phase}:waiter"
        }).Count
        if ($holderGranted -eq 1 -and $waiterCount -eq 0) {
            return $lastSnapshot
        }
        Start-Sleep -Milliseconds 100
    }
    throw "The ${Phase} waiter connection did not release without changing the holder lock: $lastSnapshot"
}

function Convert-EventLog {
    param([string]$Log)

    $events = @()
    foreach ($line in ($Log -split "`r?`n")) {
        $trimmed = $line.Trim()
        if (-not $trimmed.StartsWith('{')) {
            continue
        }
        try {
            $events += $trimmed | ConvertFrom-Json
        } catch {
            throw "Invalid JSON event from smoke worker: $trimmed"
        }
    }
    return $events
}

function Remove-SmokeContainer {
    param([Parameter(Mandatory)][string]$Container)

    try {
        Invoke-Docker -Arguments @('rm', '--force', $Container) -Capture | Out-Null
    } catch {
        if ($_.Exception.Message -notmatch 'No such container') {
            Write-Warning "Could not remove container ${Container}: $($_.Exception.Message)"
        }
    }
}

New-Item -ItemType Directory -Force -Path $reportRoot | Out-Null

try {
    Write-Host "Starting isolated PostgreSQL Session lock drill: $project"
    Invoke-Compose -Arguments @('up', '-d', '--wait', 'postgres')
    Invoke-Compose -Arguments @('run', '--build', '--rm', 'migration')

    $expectedMigrations = @(
        Get-ChildItem -LiteralPath (Join-Path $repoRoot 'server\migrations') -File |
            Where-Object { $_.Name -match '^\d{4}_.+\.sql$' -and $_.Name -notlike '*.down.sql' }
    ).Count
    $migrationCount = [int](Invoke-PsqlScalar -Sql 'SELECT count(*) FROM schema_migrations;')
    if ($migrationCount -ne $expectedMigrations) {
        throw "Expected $expectedMigrations migrations, found $migrationCount."
    }

    Invoke-PsqlScalar -Sql @"
INSERT INTO app_users(owner_id, login, display_name, payload)
VALUES ('$ownerId', 'session-lock-smoke', 'Session Lock Smoke', '{}'::jsonb)
ON CONFLICT(owner_id) DO NOTHING;
INSERT INTO projects(project_id, owner_id, payload, created_at, updated_at)
VALUES ('$projectId', '$ownerId', '{}'::jsonb, now(), now())
ON CONFLICT(project_id) DO NOTHING;
SELECT project_id FROM projects WHERE project_id = '$projectId';
"@ | Out-Null

    $commonRunArguments = @(
        'run', '--detach', '--no-deps',
        '-e', "WTR_SESSION_LOCK_SMOKE_SESSION_ID=$sessionId",
        '-e', "WTR_SESSION_LOCK_SMOKE_OWNER_ID=$ownerId",
        '-e', "WTR_SESSION_LOCK_SMOKE_PROJECT_ID=$projectId",
        '-e', 'WTR_SESSION_LOCK_SMOKE_PHASE=takeover'
    )
    Invoke-Compose -Arguments ($commonRunArguments + @(
        '--name', $holderContainer,
        '-e', 'WTR_SESSION_LOCK_SMOKE_ROLE=holder',
        '-e', 'WTR_SESSION_LOCK_SMOKE_HOLD_MS=600000',
        'session-worker'
    )) -Capture | Out-Null
    Wait-ForLogEvent -Container $holderContainer -Event 'entered' | Out-Null

    Invoke-Compose -Arguments ($commonRunArguments + @(
        '--name', $waiterContainer,
        '-e', 'WTR_SESSION_LOCK_SMOKE_ROLE=waiter',
        '-e', 'WTR_SESSION_LOCK_SMOKE_HOLD_MS=0',
        'session-worker'
    )) -Capture | Out-Null

    $lockSnapshotJson = ''
    $lockReady = $false
    for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
        $lockSnapshotJson = Invoke-PsqlScalar -Sql @"
SELECT COALESCE(json_agg(lock_row ORDER BY application_name, granted DESC), '[]'::json)::text
FROM (
  SELECT a.application_name, a.state, a.wait_event_type, a.wait_event, l.granted
  FROM pg_locks AS l
  JOIN pg_stat_activity AS a ON a.pid = l.pid
  WHERE l.locktype = 'advisory'
    AND a.datname = current_database()
    AND a.application_name LIKE 'what-the-repo:session-lock-smoke:takeover:%'
) AS lock_row;
"@
        $locks = ConvertFrom-Json -InputObject $lockSnapshotJson
        $holderGranted = @($locks | Where-Object {
            $_.application_name -eq 'what-the-repo:session-lock-smoke:takeover:holder' -and $_.granted -eq $true
        }).Count
        $waiterWaiting = @($locks | Where-Object {
            $_.application_name -eq 'what-the-repo:session-lock-smoke:takeover:waiter' -and $_.granted -eq $false
        }).Count
        if ($holderGranted -eq 1 -and $waiterWaiting -eq 1) {
            $lockReady = $true
            break
        }
        Start-Sleep -Milliseconds 250
    }
    if (-not $lockReady) {
        throw "PostgreSQL did not expose one granted holder and one waiting waiter: $lockSnapshotJson"
    }

    $waiterLogsBeforeKill = Get-ContainerLogs -Container $waiterContainer
    if ($waiterLogsBeforeKill -match '"event":"entered"') {
        throw 'The waiter entered the Session task before the holder connection was terminated.'
    }

    $killRequestedAt = [DateTimeOffset]::UtcNow
    Invoke-Docker -Arguments @('kill', $holderContainer) -Capture | Out-Null
    $holderStatus = Wait-ForContainerExit -Container $holderContainer
    Wait-ForLogEvent -Container $waiterContainer -Event 'completed' | Out-Null
    $waiterStatus = Wait-ForContainerExit -Container $waiterContainer

    $holderExitCode = [int](($holderStatus -split '\|')[1])
    $waiterExitCode = [int](($waiterStatus -split '\|')[1])
    if ($holderExitCode -ne 137) {
        throw "Expected the forced holder termination to exit with 137, got $holderExitCode."
    }
    if ($waiterExitCode -ne 0) {
        throw "Expected the waiter to exit successfully, got $waiterExitCode."
    }

    $sessionJson = Invoke-PsqlScalar -Sql @"
SELECT json_build_object(
  'session_count', count(*),
  'owner_id', max(owner_id),
  'project_id', max(project_id),
  'snapshot_id', max(snapshot_id),
  'skill_id', max(skill_id),
  'skill_version', max(skill_version)
)::text
FROM pi_sessions
WHERE session_id = '$sessionId';
"@
    $sessionResult = ConvertFrom-Json -InputObject $sessionJson
    if ([int]$sessionResult.session_count -ne 1) {
        throw "Expected one persisted Session identity, found $($sessionResult.session_count)."
    }
    if ($sessionResult.skill_version -ne 'session-lock-smoke:takeover:waiter' -or
        $sessionResult.snapshot_id -ne 'session-lock-smoke:takeover:waiter') {
        throw "The waiter did not publish the final Session metadata: $sessionJson"
    }

    $cancelRunArguments = @(
        'run', '--detach', '--no-deps',
        '-e', "WTR_SESSION_LOCK_SMOKE_SESSION_ID=$cancelSessionId",
        '-e', "WTR_SESSION_LOCK_SMOKE_OWNER_ID=$ownerId",
        '-e', "WTR_SESSION_LOCK_SMOKE_PROJECT_ID=$projectId",
        '-e', 'WTR_SESSION_LOCK_SMOKE_PHASE=cancel'
    )
    Invoke-Compose -Arguments ($cancelRunArguments + @(
        '--name', $cancelHolderContainer,
        '-e', 'WTR_SESSION_LOCK_SMOKE_ROLE=holder',
        '-e', 'WTR_SESSION_LOCK_SMOKE_HOLD_MS=600000',
        'session-worker'
    )) -Capture | Out-Null
    Wait-ForLogEvent -Container $cancelHolderContainer -Event 'entered' | Out-Null

    Invoke-Compose -Arguments ($cancelRunArguments + @(
        '--name', $cancelWaiterContainer,
        '-e', 'WTR_SESSION_LOCK_SMOKE_ROLE=waiter',
        '-e', 'WTR_SESSION_LOCK_SMOKE_HOLD_MS=0',
        '-e', 'WTR_SESSION_LOCK_SMOKE_ABORT_AFTER_MS=5000',
        '-e', 'WTR_SESSION_LOCK_SMOKE_EXPECT_ERROR=session_lock_smoke_cancelled',
        'session-worker'
    )) -Capture | Out-Null
    $cancelLockSnapshotJson = Wait-ForPhaseLockPair -Phase 'cancel'
    $cancelLocks = ConvertFrom-Json -InputObject $cancelLockSnapshotJson
    Wait-ForLogEvent -Container $cancelWaiterContainer -Event 'rejected' -TimeoutSeconds 15 | Out-Null
    $cancelWaiterStatus = Wait-ForContainerExit -Container $cancelWaiterContainer -TimeoutSeconds 15
    $cancelWaiterExitCode = [int](($cancelWaiterStatus -split '\|')[1])
    if ($cancelWaiterExitCode -ne 0) {
        throw "Expected the cancelled waiter to exit successfully, got $cancelWaiterExitCode."
    }
    $cancelWaiterEvents = Convert-EventLog -Log (Get-ContainerLogs -Container $cancelWaiterContainer)
    if (@($cancelWaiterEvents | Where-Object { $_.event -eq 'entered' }).Count -ne 0) {
        throw 'The cancelled waiter entered the Session task.'
    }
    $cancelRejected = @($cancelWaiterEvents | Where-Object {
        $_.event -eq 'rejected' -and $_.message -eq 'session_lock_smoke_cancelled'
    }) | Select-Object -First 1
    if ($null -eq $cancelRejected) {
        throw 'The cancelled waiter did not report the expected rejection.'
    }
    $cancelHolderStateBeforeKill = Invoke-Docker -Arguments @(
        'inspect', '--format', '{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}', $cancelHolderContainer
    ) -Capture
    if ($cancelHolderStateBeforeKill -notmatch '^running\|0\|false$') {
        throw "The holder did not remain alive after cancelling the waiter: $cancelHolderStateBeforeKill"
    }
    $cancelReleaseObservedAt = [DateTimeOffset]::UtcNow
    $cancelLocksAfterJson = Wait-ForPhaseWaiterRelease -Phase 'cancel'
    $cancelReleasedAt = [DateTimeOffset]::UtcNow
    $cancelLocksAfter = ConvertFrom-Json -InputObject $cancelLocksAfterJson
    Invoke-Docker -Arguments @('kill', $cancelHolderContainer) -Capture | Out-Null
    $cancelHolderStatus = Wait-ForContainerExit -Container $cancelHolderContainer
    if ([int](($cancelHolderStatus -split '\|')[1]) -ne 137) {
        throw "Expected the cancellation-phase holder to exit with 137: $cancelHolderStatus"
    }

    $timeoutRunArguments = @(
        'run', '--detach', '--no-deps',
        '-e', "WTR_SESSION_LOCK_SMOKE_SESSION_ID=$timeoutSessionId",
        '-e', "WTR_SESSION_LOCK_SMOKE_OWNER_ID=$ownerId",
        '-e', "WTR_SESSION_LOCK_SMOKE_PROJECT_ID=$projectId",
        '-e', 'WTR_SESSION_LOCK_SMOKE_PHASE=timeout'
    )
    Invoke-Compose -Arguments ($timeoutRunArguments + @(
        '--name', $timeoutHolderContainer,
        '-e', 'WTR_SESSION_LOCK_SMOKE_ROLE=holder',
        '-e', 'WTR_SESSION_LOCK_SMOKE_HOLD_MS=600000',
        'session-worker'
    )) -Capture | Out-Null
    Wait-ForLogEvent -Container $timeoutHolderContainer -Event 'entered' | Out-Null

    Invoke-Compose -Arguments ($timeoutRunArguments + @(
        '--name', $timeoutWaiterContainer,
        '-e', 'WTR_SESSION_LOCK_SMOKE_ROLE=waiter',
        '-e', 'WTR_SESSION_LOCK_SMOKE_HOLD_MS=0',
        '-e', 'WTR_SESSION_LOCK_SMOKE_WAIT_TIMEOUT_MS=3000',
        '-e', 'WTR_SESSION_LOCK_SMOKE_EXPECT_ERROR=pi_session_lock_wait_timeout',
        'session-worker'
    )) -Capture | Out-Null
    $timeoutLockSnapshotJson = Wait-ForPhaseLockPair -Phase 'timeout'
    $timeoutLocks = ConvertFrom-Json -InputObject $timeoutLockSnapshotJson
    Wait-ForLogEvent -Container $timeoutWaiterContainer -Event 'rejected' -TimeoutSeconds 15 | Out-Null
    $timeoutWaiterStatus = Wait-ForContainerExit -Container $timeoutWaiterContainer -TimeoutSeconds 15
    $timeoutWaiterExitCode = [int](($timeoutWaiterStatus -split '\|')[1])
    if ($timeoutWaiterExitCode -ne 0) {
        throw "Expected the timed-out waiter to exit successfully, got $timeoutWaiterExitCode."
    }
    $timeoutWaiterEvents = Convert-EventLog -Log (Get-ContainerLogs -Container $timeoutWaiterContainer)
    if (@($timeoutWaiterEvents | Where-Object { $_.event -eq 'entered' }).Count -ne 0) {
        throw 'The timed-out waiter entered the Session task.'
    }
    $timeoutRejected = @($timeoutWaiterEvents | Where-Object {
        $_.event -eq 'rejected' -and $_.message -eq 'pi_session_lock_wait_timeout'
    }) | Select-Object -First 1
    if ($null -eq $timeoutRejected) {
        throw 'The timed-out waiter did not report the expected rejection.'
    }
    $timeoutHolderStateBeforeKill = Invoke-Docker -Arguments @(
        'inspect', '--format', '{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}', $timeoutHolderContainer
    ) -Capture
    if ($timeoutHolderStateBeforeKill -notmatch '^running\|0\|false$') {
        throw "The holder did not remain alive after the waiter timed out: $timeoutHolderStateBeforeKill"
    }
    $timeoutReleaseObservedAt = [DateTimeOffset]::UtcNow
    $timeoutLocksAfterJson = Wait-ForPhaseWaiterRelease -Phase 'timeout'
    $timeoutReleasedAt = [DateTimeOffset]::UtcNow
    $timeoutLocksAfter = ConvertFrom-Json -InputObject $timeoutLocksAfterJson
    Invoke-Docker -Arguments @('kill', $timeoutHolderContainer) -Capture | Out-Null
    $timeoutHolderStatus = Wait-ForContainerExit -Container $timeoutHolderContainer
    if ([int](($timeoutHolderStatus -split '\|')[1]) -ne 137) {
        throw "Expected the timeout-phase holder to exit with 137: $timeoutHolderStatus"
    }

    $cancelSessionJson = Invoke-PsqlScalar -Sql @"
SELECT json_build_object('session_count', count(*), 'skill_version', max(skill_version))::text
FROM pi_sessions WHERE session_id = '$cancelSessionId';
"@
    $cancelSessionResult = ConvertFrom-Json -InputObject $cancelSessionJson
    if ([int]$cancelSessionResult.session_count -ne 1 -or
        $cancelSessionResult.skill_version -ne 'session-lock-smoke:cancel:holder') {
        throw "The cancelled waiter changed Session metadata unexpectedly: $cancelSessionJson"
    }
    $timeoutSessionJson = Invoke-PsqlScalar -Sql @"
SELECT json_build_object('session_count', count(*), 'skill_version', max(skill_version))::text
FROM pi_sessions WHERE session_id = '$timeoutSessionId';
"@
    $timeoutSessionResult = ConvertFrom-Json -InputObject $timeoutSessionJson
    if ([int]$timeoutSessionResult.session_count -ne 1 -or
        $timeoutSessionResult.skill_version -ne 'session-lock-smoke:timeout:holder') {
        throw "The timed-out waiter changed Session metadata unexpectedly: $timeoutSessionJson"
    }

    $remainingLocks = [int](Invoke-PsqlScalar -Sql @"
SELECT count(*)
FROM pg_locks AS l
JOIN pg_stat_activity AS a ON a.pid = l.pid
WHERE l.locktype = 'advisory'
  AND a.datname = current_database()
  AND a.application_name LIKE 'what-the-repo:session-lock-smoke:%';
"@)
    if ($remainingLocks -ne 0) {
        throw "Expected no remaining Session smoke advisory locks, found $remainingLocks."
    }

    $holderEvents = Convert-EventLog -Log (Get-ContainerLogs -Container $holderContainer)
    $waiterEvents = Convert-EventLog -Log (Get-ContainerLogs -Container $waiterContainer)
    $cancelHolderEvents = Convert-EventLog -Log (Get-ContainerLogs -Container $cancelHolderContainer)
    $timeoutHolderEvents = Convert-EventLog -Log (Get-ContainerLogs -Container $timeoutHolderContainer)
    $waiterEntered = @($waiterEvents | Where-Object { $_.event -eq 'entered' }) | Select-Object -First 1
    if ($null -eq $waiterEntered) {
        throw 'The waiter completed without an entered event.'
    }
    $waiterEnteredAt = [DateTimeOffset]::Parse($waiterEntered.at)
    if ($waiterEnteredAt -lt $killRequestedAt) {
        throw 'The waiter entered before the holder kill request.'
    }

    $finishedAt = [DateTimeOffset]::UtcNow
    [ordered]@{
        ok = $true
        project = $project
        started_at = $startedAt.ToString('o')
        finished_at = $finishedAt.ToString('o')
        duration_seconds = [Math]::Round(($finishedAt - $startedAt).TotalSeconds, 3)
        postgres_version = (Invoke-PsqlScalar -Sql 'SHOW server_version;').Trim()
        migration_count = $migrationCount
        expected_migration_count = $expectedMigrations
        session_id = $sessionId
        lock_snapshot_before_kill = @($locks)
        waiter_entered_before_kill = $false
        holder_exit_code = $holderExitCode
        waiter_exit_code = $waiterExitCode
        kill_requested_at = $killRequestedAt.ToString('o')
        waiter_entered_at = $waiterEnteredAt.ToString('o')
        persisted_session = $sessionResult
        cancelled_wait = [ordered]@{
            lock_snapshot = @($cancelLocks)
            waiter_entered = $false
            rejection = $cancelRejected
            waiter_exit_code = $cancelWaiterExitCode
            holder_state_before_kill = $cancelHolderStateBeforeKill
            locks_after_rejection = @($cancelLocksAfter)
            waiter_release_wait_ms = [Math]::Round(($cancelReleasedAt - $cancelReleaseObservedAt).TotalMilliseconds, 3)
            persisted_session = $cancelSessionResult
            holder_events = $cancelHolderEvents
            waiter_events = $cancelWaiterEvents
        }
        timed_out_wait = [ordered]@{
            lock_snapshot = @($timeoutLocks)
            waiter_entered = $false
            rejection = $timeoutRejected
            waiter_exit_code = $timeoutWaiterExitCode
            holder_state_before_kill = $timeoutHolderStateBeforeKill
            locks_after_rejection = @($timeoutLocksAfter)
            waiter_release_wait_ms = [Math]::Round(($timeoutReleasedAt - $timeoutReleaseObservedAt).TotalMilliseconds, 3)
            persisted_session = $timeoutSessionResult
            holder_events = $timeoutHolderEvents
            waiter_events = $timeoutWaiterEvents
        }
        advisory_lock_count_after = $remainingLocks
        holder_events = $holderEvents
        waiter_events = $waiterEvents
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding utf8

    $succeeded = $true
    Write-Host "PostgreSQL Session lock drill passed. Report: $reportPath"
} finally {
    if (-not $succeeded) {
        foreach ($container in $smokeContainers) {
            try {
                Get-ContainerLogs -Container $container |
                    Set-Content -LiteralPath (Join-Path $reportRoot "$container.log") -Encoding utf8
            } catch {
                Write-Warning "Could not collect logs for ${container}: $($_.Exception.Message)"
            }
        }
        try {
            Invoke-Compose -Arguments @('logs', '--no-color') -Capture |
                Set-Content -LiteralPath $composeLogPath -Encoding utf8
        } catch {
            Write-Warning "Could not collect Compose logs: $($_.Exception.Message)"
        }
    }
    if (-not $KeepArtifacts) {
        foreach ($container in $smokeContainers) {
            Remove-SmokeContainer -Container $container
        }
        try {
            Invoke-Compose -Arguments @('down', '--volumes', '--remove-orphans')
        } catch {
            Write-Warning "Could not remove isolated Session lock resources: $($_.Exception.Message)"
        }
    } else {
        Write-Host "Keeping isolated Docker resources for project $project"
    }
}
