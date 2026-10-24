#!/usr/bin/env bash
# Keep server logs (which include the TURN relay's connection logs with IP addresses) for at most
# 14 days, as promised in the Privacy Policy. Safe to run again. Run as root:
#   bash /opt/duet/deploy/log-retention.sh
set -euo pipefail

# systemd journal: drop entries older than 14 days.
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/duet-retention.conf <<'EOF'
[Journal]
MaxRetentionSec=14day
MaxFileSec=1day
EOF
systemctl restart systemd-journald
journalctl --vacuum-time=14d >/dev/null

# rsyslog files (/var/log/syslog etc.): rotate daily, keep 14.
if [ -f /etc/logrotate.d/rsyslog ]; then
  sed -i -E 's/^(\s*)weekly$/\1daily/; s/^(\s*)rotate [0-9]+$/\1rotate 14/' /etc/logrotate.d/rsyslog
fi
find /var/log -maxdepth 1 -type f \( -name 'syslog.*' -o -name 'messages.*' -o -name 'daemon.log.*' \) -mtime +14 -delete

echo "Log retention set to 14 days."
