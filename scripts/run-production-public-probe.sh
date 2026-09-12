#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/production-common.sh
source "$SCRIPT_DIR/lib/production-common.sh"

prepare_operations_directories
metric_file="$WTR_OPERATIONS_ROOT/metrics/public_https_probe.prom"
previous_not_after="$(metric_value "$metric_file" what_the_repo_tls_certificate_not_after_unixtime)"
previous_not_after="${previous_not_after:-0}"
domain="$(env_value WHAT_THE_REPO_PUBLIC_DOMAIN)"
if [[ -z "$domain" || ! "$domain" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "WHAT_THE_REPO_PUBLIC_DOMAIN is missing or invalid" >&2
  exit 64
fi

finished_epoch="$(date -u +%s)"
success=0
not_after="$previous_not_after"
health=""

set +e
health="$(curl --fail --silent --show-error --max-time 20 "https://$domain/api/health")"
curl_status=$?
certificate_end="$(timeout 20 openssl s_client -connect "$domain:443" -servername "$domain" </dev/null 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null)"
certificate_status=$?
set -e

if [[ "$certificate_status" -eq 0 && "$certificate_end" == notAfter=* ]]; then
  parsed_not_after="$(date -u -d "${certificate_end#notAfter=}" +%s 2>/dev/null || true)"
  if [[ "$parsed_not_after" =~ ^[0-9]+$ ]]; then
    not_after="$parsed_not_after"
  fi
fi

if [[ "$curl_status" -eq 0 && "$certificate_status" -eq 0 ]] \
  && grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' <<<"$health" \
  && grep -Eq '"storage"[[:space:]]*:[[:space:]]*"postgres"' <<<"$health" \
  && grep -Eq '"model_configured"[[:space:]]*:[[:space:]]*true' <<<"$health"; then
  success=1
fi

write_metrics public_https_probe "# HELP what_the_repo_public_https_probe_last_run_unixtime Unix time of the latest public product probe.
# TYPE what_the_repo_public_https_probe_last_run_unixtime gauge
what_the_repo_public_https_probe_last_run_unixtime $finished_epoch
# HELP what_the_repo_public_https_probe_success Whether HTTPS, certificate and PostgreSQL product health checks succeeded.
# TYPE what_the_repo_public_https_probe_success gauge
what_the_repo_public_https_probe_success $success
# HELP what_the_repo_tls_certificate_not_after_unixtime Public TLS certificate expiration time.
# TYPE what_the_repo_tls_certificate_not_after_unixtime gauge
what_the_repo_tls_certificate_not_after_unixtime $not_after"

if [[ "$success" -ne 1 ]]; then
  echo "public HTTPS production probe failed" >&2
  exit 1
fi
echo "public HTTPS production probe passed"
