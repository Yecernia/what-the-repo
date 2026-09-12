#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/production-common.sh
source "$SCRIPT_DIR/lib/production-common.sh"

prepare_operations_directories
metric_file="$WTR_OPERATIONS_ROOT/metrics/postgres_backup.prom"
previous_success="$(metric_value "$metric_file" what_the_repo_postgres_backup_last_success_unixtime)"
previous_success="${previous_success:-0}"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
started_epoch="$(date -u +%s)"
status=0

exec 9>"/run/lock/what-the-repo-postgres-backup.lock"
if ! flock -n 9; then
  echo "another production backup is already running" >&2
  exit 75
fi

set +e
compose --profile operations run --rm postgres-backup
status=$?
set -e

finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
finished_epoch="$(date -u +%s)"
success=0
last_success="$previous_success"
if [[ "$status" -eq 0 ]]; then
  success=1
  last_success="$finished_epoch"
fi

write_metrics postgres_backup "# HELP what_the_repo_postgres_backup_last_run_unixtime Unix time of the latest base backup attempt.
# TYPE what_the_repo_postgres_backup_last_run_unixtime gauge
what_the_repo_postgres_backup_last_run_unixtime $finished_epoch
# HELP what_the_repo_postgres_backup_last_run_success Whether the latest base backup attempt succeeded.
# TYPE what_the_repo_postgres_backup_last_run_success gauge
what_the_repo_postgres_backup_last_run_success $success
# HELP what_the_repo_postgres_backup_last_success_unixtime Unix time of the latest successful base backup.
# TYPE what_the_repo_postgres_backup_last_success_unixtime gauge
what_the_repo_postgres_backup_last_success_unixtime $last_success"

report="$(json_report "postgres-backup-$finished_epoch" "{\"ok\":$([[ "$success" -eq 1 ]] && printf true || printf false),\"started_at\":\"$started_at\",\"finished_at\":\"$finished_at\",\"image_tag\":\"$WTR_IMAGE_TAG\"}")"
echo "production backup report: $report"
exit "$status"
