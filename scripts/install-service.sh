#!/usr/bin/env bash
# Installs HUGO Eye as a systemd --user service (runs at boot via linger).
set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_FILE="$UNIT_DIR/hugo-eye.service"

mkdir -p "$UNIT_DIR"

cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=HUGO Eye — independent camera platform
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
ExecStart=/usr/bin/env node src/index.js
Restart=on-failure
RestartSec=5
# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=$HOME/hugo-eye-data

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now hugo-eye.service

echo "installed and started hugo-eye.service"
systemctl --user status hugo-eye.service --no-pager | head -12
