#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run this installer as root" >&2
  exit 77
fi

INSTALL_ROOT="${WTR_INSTALL_ROOT:-/opt/what-the-repo}"
OPERATIONS_ROOT="${WTR_OPERATIONS_ROOT:-/var/lib/what-the-repo-operations}"

install -d -m 0755 "$OPERATIONS_ROOT" "$OPERATIONS_ROOT/metrics"
install -d -m 0700 "$OPERATIONS_ROOT/reports"

cat > /etc/systemd/system/what-the-repo-postgres-backup.service <<EOF
[Unit]
Description=what-the-repo PostgreSQL base backup to COS
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
ExecStart=$INSTALL_ROOT/current/scripts/run-production-backup.sh
Environment=WTR_INSTALL_ROOT=$INSTALL_ROOT
Environment=WTR_OPERATIONS_ROOT=$OPERATIONS_ROOT
UMask=0077
Nice=10
IOSchedulingClass=idle
TimeoutStartSec=2h
EOF

cat > /etc/systemd/system/what-the-repo-postgres-backup.timer <<'EOF'
[Unit]
Description=Daily what-the-repo PostgreSQL base backup

[Timer]
OnCalendar=*-*-* 03:17:00 Asia/Shanghai
RandomizedDelaySec=15m
Persistent=true
Unit=what-the-repo-postgres-backup.service

[Install]
WantedBy=timers.target
EOF

cat > /etc/systemd/system/what-the-repo-postgres-restore-drill.service <<EOF
[Unit]
Description=what-the-repo isolated PostgreSQL COS restore drill
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
ExecStart=$INSTALL_ROOT/current/scripts/run-production-restore-drill.sh
Environment=WTR_INSTALL_ROOT=$INSTALL_ROOT
Environment=WTR_OPERATIONS_ROOT=$OPERATIONS_ROOT
UMask=0077
Nice=15
IOSchedulingClass=idle
TimeoutStartSec=3h
EOF

cat > /etc/systemd/system/what-the-repo-postgres-restore-drill.timer <<'EOF'
[Unit]
Description=Weekly what-the-repo PostgreSQL restore verification

[Timer]
OnCalendar=Sun *-*-* 04:11:00 Asia/Shanghai
RandomizedDelaySec=30m
Persistent=true
Unit=what-the-repo-postgres-restore-drill.service

[Install]
WantedBy=timers.target
EOF

cat > /etc/systemd/system/what-the-repo-public-probe.service <<EOF
[Unit]
Description=what-the-repo public HTTPS and certificate probe
After=network-online.target

[Service]
Type=oneshot
ExecStart=$INSTALL_ROOT/current/scripts/run-production-public-probe.sh
Environment=WTR_INSTALL_ROOT=$INSTALL_ROOT
Environment=WTR_OPERATIONS_ROOT=$OPERATIONS_ROOT
UMask=0022
TimeoutStartSec=1m
EOF

cat > /etc/systemd/system/what-the-repo-public-probe.timer <<'EOF'
[Unit]
Description=Frequent what-the-repo public HTTPS probe

[Timer]
OnBootSec=2m
OnUnitActiveSec=5m
AccuracySec=30s
Unit=what-the-repo-public-probe.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now \
  what-the-repo-postgres-backup.timer \
  what-the-repo-postgres-restore-drill.timer \
  what-the-repo-public-probe.timer

echo "production backup, restore-drill and public-probe timers installed"
