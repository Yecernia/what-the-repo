#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/production-common.sh
source "$SCRIPT_DIR/lib/production-common.sh"

prepare_operations_directories
metric_file="$WTR_OPERATIONS_ROOT/metrics/postgres_restore_drill.prom"
previous_success="$(metric_value "$metric_file" what_the_repo_postgres_restore_drill_last_success_unixtime)"
previous_success="${previous_success:-0}"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
started_epoch="$(date -u +%s)"
run_id="$(date -u +%Y%m%d%H%M%S)-$$"
marker="production-restore-drill:$run_id"
login="production-restore-drill-$run_id"
volume_name="what-the-repo-postgres-restore-$run_id"
stage="initializing"
marker_inserted=0
drill_succeeded=0

export POSTGRES_RESTORE_VOLUME_NAME="$volume_name"

exec 9>"/run/lock/what-the-repo-postgres-restore-drill.lock"
if ! flock -n 9; then
  echo "another production restore drill is already running" >&2
  exit 75
fi

cleanup() {
  local status=$?
  set +e
  final_stage="$stage"
  stage="cleanup"
  compose --profile operations rm --stop --force postgres-restored >/dev/null 2>&1

  if docker volume inspect "$volume_name" >/dev/null 2>&1; then
    project_label="$(docker volume inspect -f '{{ index .Labels "com.docker.compose.project" }}' "$volume_name" 2>/dev/null)"
    volume_label="$(docker volume inspect -f '{{ index .Labels "com.docker.compose.volume" }}' "$volume_name" 2>/dev/null)"
    if [[ "$project_label" == "$WTR_PROJECT_NAME" && "$volume_label" == "postgres-restore-data" ]]; then
      docker volume rm "$volume_name" >/dev/null
    else
      echo "refusing to remove restore volume with unexpected labels: $volume_name" >&2
      status=1
    fi
  fi

  if [[ "$marker_inserted" -eq 1 ]]; then
    postgres_scalar postgres "DELETE FROM app_users WHERE owner_id = '$marker'; SELECT pg_switch_wal();" >/dev/null 2>&1
  fi

  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  finished_epoch="$(date -u +%s)"
  success=0
  last_success="$previous_success"
  if [[ "$status" -eq 0 && "$drill_succeeded" -eq 1 ]]; then
    success=1
    last_success="$finished_epoch"
  fi

  write_metrics postgres_restore_drill "# HELP what_the_repo_postgres_restore_drill_last_run_unixtime Unix time of the latest isolated restore drill.
# TYPE what_the_repo_postgres_restore_drill_last_run_unixtime gauge
what_the_repo_postgres_restore_drill_last_run_unixtime $finished_epoch
# HELP what_the_repo_postgres_restore_drill_last_run_success Whether the latest isolated restore drill succeeded.
# TYPE what_the_repo_postgres_restore_drill_last_run_success gauge
what_the_repo_postgres_restore_drill_last_run_success $success
# HELP what_the_repo_postgres_restore_drill_last_success_unixtime Unix time of the latest successful isolated restore drill.
# TYPE what_the_repo_postgres_restore_drill_last_success_unixtime gauge
what_the_repo_postgres_restore_drill_last_success_unixtime $last_success"

  report="$(json_report "postgres-restore-drill-$run_id" "{\"ok\":$([[ "$success" -eq 1 ]] && printf true || printf false),\"run_id\":\"$run_id\",\"stage\":\"$final_stage\",\"started_at\":\"$started_at\",\"finished_at\":\"$finished_at\",\"image_tag\":\"$WTR_IMAGE_TAG\"}")"
  echo "production restore drill report: $report"
  trap - EXIT
  exit "$status"
}
trap cleanup EXIT

stage="creating-base-backup"
compose --profile operations run --rm postgres-backup

stage="writing-post-backup-marker"
wal_name="$(postgres_scalar postgres "INSERT INTO app_users(owner_id, login, display_name, payload) VALUES ('$marker', '$login', 'Production Restore Drill', jsonb_build_object('run_id', '$run_id')); SELECT pg_walfile_name(pg_current_wal_lsn());" | tail -n 1 | tr -d '\r')"
marker_inserted=1
if [[ ! "$wal_name" =~ ^[0-9A-F]{24}$ ]]; then
  echo "PostgreSQL returned an invalid WAL name" >&2
  exit 1
fi
postgres_scalar postgres "SELECT pg_switch_wal();" >/dev/null

stage="waiting-for-wal-archive"
archived=0
for _ in $(seq 1 120); do
  if [[ "$(postgres_scalar postgres "SELECT EXISTS (SELECT 1 FROM pg_ls_archive_statusdir() WHERE name = '$wal_name.done');")" == "t" ]]; then
    archived=1
    break
  fi
  sleep 1
done
if [[ "$archived" -ne 1 ]]; then
  echo "WAL segment did not archive within 120 seconds" >&2
  exit 1
fi

stage="restoring-new-volume"
if docker volume inspect "$volume_name" >/dev/null 2>&1; then
  echo "restore volume already exists: $volume_name" >&2
  exit 73
fi
compose --profile operations run --rm --no-deps postgres-restore
compose --profile operations up -d --wait --wait-timeout 180 --no-deps postgres-restored

stage="verifying-restored-database"
restored_marker="$(postgres_scalar postgres-restored "SELECT count(*) FROM app_users WHERE owner_id = '$marker';")"
live_migrations="$(postgres_scalar postgres "SELECT count(*) FROM schema_migrations;")"
restored_migrations="$(postgres_scalar postgres-restored "SELECT count(*) FROM schema_migrations;")"
recovery_state="$(postgres_scalar postgres-restored "SELECT pg_is_in_recovery();")"
if [[ "$restored_marker" != "1" ]]; then
  echo "restored database is missing the post-backup WAL marker" >&2
  exit 1
fi
if [[ "$restored_migrations" != "$live_migrations" ]]; then
  echo "restored migration count differs from production" >&2
  exit 1
fi
if [[ "$recovery_state" != "f" ]]; then
  echo "restored database did not promote after recovery" >&2
  exit 1
fi

stage="archiving-marker-cleanup"
cleanup_wal="$(postgres_scalar postgres "DELETE FROM app_users WHERE owner_id = '$marker'; SELECT pg_walfile_name(pg_current_wal_lsn());" | tail -n 1 | tr -d '\r')"
marker_inserted=0
if [[ ! "$cleanup_wal" =~ ^[0-9A-F]{24}$ ]]; then
  echo "PostgreSQL returned an invalid cleanup WAL name" >&2
  exit 1
fi
postgres_scalar postgres "SELECT pg_switch_wal();" >/dev/null
cleanup_archived=0
for _ in $(seq 1 120); do
  if [[ "$(postgres_scalar postgres "SELECT EXISTS (SELECT 1 FROM pg_ls_archive_statusdir() WHERE name = '$cleanup_wal.done');")" == "t" ]]; then
    cleanup_archived=1
    break
  fi
  sleep 1
done
if [[ "$cleanup_archived" -ne 1 ]]; then
  echo "cleanup WAL segment did not archive within 120 seconds" >&2
  exit 1
fi

stage="verified"
drill_succeeded=1
