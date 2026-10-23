#!/usr/bin/env bash
# Run on the server to deploy the latest code:  sudo bash /opt/duet/deploy/update.sh
set -euo pipefail
cd /opt/duet
sudo -u duet git pull --ff-only
sudo -u duet npm ci --omit=dev
systemctl restart duet
sleep 1
systemctl --no-pager --lines=5 status duet
curl -fsS http://127.0.0.1:3000/healthz && echo
