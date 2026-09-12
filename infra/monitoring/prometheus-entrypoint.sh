#!/bin/sh
set -eu

token="${WHAT_THE_REPO_METRICS_TOKEN:-}"
token_file="${WHAT_THE_REPO_METRICS_TOKEN_FILE:-}"
if [ -n "$token" ] && [ -n "$token_file" ]; then
  echo "Set either WHAT_THE_REPO_METRICS_TOKEN or WHAT_THE_REPO_METRICS_TOKEN_FILE, not both." >&2
  exit 64
fi
if [ -n "$token_file" ]; then
  if [ ! -f "$token_file" ] || [ ! -r "$token_file" ]; then
    echo "WHAT_THE_REPO_METRICS_TOKEN_FILE is not a readable regular file" >&2
    exit 66
  fi
  token=$(cat -- "$token_file")
fi
if [ -z "$token" ]; then
  echo "A metrics token or token file is required for the monitoring profile" >&2
  exit 1
fi

umask 077
printf '%s' "$token" > /tmp/what-the-repo-metrics-token
unset WHAT_THE_REPO_METRICS_TOKEN WHAT_THE_REPO_METRICS_TOKEN_FILE token token_file

exec /bin/prometheus "$@"
