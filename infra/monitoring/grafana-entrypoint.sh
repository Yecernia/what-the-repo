#!/bin/sh
set -eu

password="${GF_SECURITY_ADMIN_PASSWORD:-}"
password_file="${GF_SECURITY_ADMIN_PASSWORD_FILE:-}"
if [ -n "$password" ] && [ -n "$password_file" ]; then
  echo "Set either GF_SECURITY_ADMIN_PASSWORD or GF_SECURITY_ADMIN_PASSWORD_FILE, not both." >&2
  exit 64
fi
if [ -n "$password_file" ]; then
  if [ ! -f "$password_file" ] || [ ! -r "$password_file" ]; then
    echo "GF_SECURITY_ADMIN_PASSWORD_FILE is not a readable regular file" >&2
    exit 66
  fi
  password=$(cat -- "$password_file")
fi
if [ -z "$password" ]; then
  echo "A Grafana administrator password or password file is required for the monitoring profile" >&2
  exit 1
fi

export GF_SECURITY_ADMIN_PASSWORD="$password"
unset GF_SECURITY_ADMIN_PASSWORD_FILE password password_file

exec /run.sh
