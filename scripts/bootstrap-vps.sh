#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this one-time setup as root."
  exit 1
fi

DEPLOY_USER="globaldigitsbot"
APP_DIR="/opt/global-digits-bot"
KEY_FILE="/root/globaldigits-github-actions"

if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi

apt-get update
apt-get install -y rsync postgresql-client

install -d -m 755 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"

if [[ ! -f "$KEY_FILE" ]]; then
  ssh-keygen -q -t ed25519 -N "" -C "global-digits-github-actions" -f "$KEY_FILE"
fi

AUTHORIZED_KEYS="/home/$DEPLOY_USER/.ssh/authorized_keys"
touch "$AUTHORIZED_KEYS"
if ! grep -qxF "$(cat "$KEY_FILE.pub")" "$AUTHORIZED_KEYS"; then
  cat "$KEY_FILE.pub" >> "$AUTHORIZED_KEYS"
fi
chown "$DEPLOY_USER:$DEPLOY_USER" "$AUTHORIZED_KEYS"
chmod 600 "$AUTHORIZED_KEYS"

if command -v pm2 >/dev/null 2>&1; then
  pm2 startup systemd -u "$DEPLOY_USER" --hp "/home/$DEPLOY_USER" >/dev/null
fi

echo
echo "VPS bootstrap complete."
echo "GitHub secret VPS_USER: $DEPLOY_USER"
echo "GitHub secret VPS_SSH_PRIVATE_KEY is stored at: $KEY_FILE"
echo "Show it once with: cat $KEY_FILE"
