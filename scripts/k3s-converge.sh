#!/usr/bin/env bash
set -Eeuo pipefail

skip_build=0
skip_initial_backup=0
for argument in "$@"; do
  case "$argument" in
    --skip-build) skip_build=1 ;;
    --skip-initial-backup) skip_initial_backup=1 ;;
    *) echo "unknown argument: $argument" >&2; exit 64 ;;
  esac
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$skip_build" -eq 1 ]]; then
  export WTR_K3S_SKIP_BUILD=1
fi

bash "$SCRIPT_DIR/k3s-bootstrap-services.sh"

bash "$SCRIPT_DIR/k3s-run-migration.sh"
if [[ "$skip_initial_backup" -eq 1 ]]; then
  bash "$SCRIPT_DIR/k3s-apply-application.sh" --skip-initial-backup
else
  bash "$SCRIPT_DIR/k3s-apply-application.sh"
fi
