#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/opt/global-digits-bot"
LOCK_FILE="/tmp/global-digits-deploy.lock"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another Global Digits deployment is already running."
  exit 1
fi

cd "$APP_DIR"

if [[ ! -f .env ]]; then
  echo "Missing $APP_DIR/.env. Copy .env.example to .env and configure it once on the VPS."
  exit 1
fi

npm ci --omit=dev
npm run check
npm run db:check
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save

echo "Global Digits deployment completed successfully."
