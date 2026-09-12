#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "usage: rollback-production-release.sh /opt/what-the-repo/releases/<release>" >&2
  exit 64
fi
if [[ "$(id -u)" -ne 0 ]]; then
  echo "run production rollback as root" >&2
  exit 77
fi

INSTALL_ROOT="${WTR_INSTALL_ROOT:-/opt/what-the-repo}"
requested="$(readlink -f -- "$1")"
release_root="$(readlink -f -- "$INSTALL_ROOT/releases")"
case "$requested/" in
  "$release_root"/*/) ;;
  *) echo "rollback target must be a release under $release_root" >&2; exit 64 ;;
esac
if [[ ! -f "$requested/compose.production.yaml" || ! -x "$requested/scripts/production-converge.sh" ]]; then
  echo "rollback target predates the production deployment contract" >&2
  exit 64
fi

temporary_link="$INSTALL_ROOT/.current.rollback.$$"
ln -s -- "$requested" "$temporary_link"
mv -Tf -- "$temporary_link" "$INSTALL_ROOT/current"

WTR_RELEASE_ROOT="$INSTALL_ROOT/current" \
  "$INSTALL_ROOT/current/scripts/production-converge.sh" --skip-backup

echo "production code rolled back to $(basename -- "$requested"); database migrations were not reversed"
