# PostgreSQL, Google Sheets, GitHub, and VPS Setup

## 1. Create PostgreSQL on Ubuntu VPS

```bash
sudo apt update
sudo apt install -y postgresql postgresql-contrib
sudo -u postgres psql
```

Run these inside `psql`, replacing `YOUR_STRONG_PASSWORD`:

```sql
CREATE USER globaldigits WITH ENCRYPTED PASSWORD 'YOUR_STRONG_PASSWORD';
CREATE DATABASE globaldigits_bot OWNER globaldigits;
\q
```

The local/VPS connection string will be:

```text
postgresql://globaldigits:YOUR_STRONG_PASSWORD@127.0.0.1:5432/globaldigits_bot
```

If the password contains special URL characters such as `@`, `#`, `/`, or `:`, URL-encode them or choose a strong password without those characters.

## 2. Configure the bot

```bash
cp .env.example .env
nano .env
```

Required values:

```dotenv
BOT_TOKEN=YOUR_BOTFATHER_TOKEN
ADMIN_IDS=8747545932,5869510759
SUPPORT_LINK=https://t.me/Globalverifyed_support
CHANNEL_ID=-1003704005774
CHANNEL_LINK=https://telegram.me/+9Q4OivE77oc1YmU1
DATABASE_URL=postgresql://globaldigits:YOUR_STRONG_PASSWORD@127.0.0.1:5432/globaldigits_bot
DATABASE_SSL=false
DATABASE_POOL_SIZE=10
SHEET_SYNC_ENABLED=false
GOOGLE_APPS_SCRIPT_URL=
GOOGLE_APPS_SCRIPT_SECRET=
PORT=3010
```

Install and verify:

```bash
npm ci
npm run check
npm run db:check
npm start
```

`npm start` keeps the terminal occupied while the bot runs; that is normal. Test `/start` in Telegram. Press `Ctrl+C` to stop the local process.

## 3. Connect Google Sheets with Apps Script

Follow [APPS_SCRIPT_SETUP.md](APPS_SCRIPT_SETUP.md). No Google Cloud project, service-account email, or JSON credential file is needed. After deploying the Apps Script Web App, update `.env`:

```dotenv
SHEET_SYNC_ENABLED=true
GOOGLE_APPS_SCRIPT_URL=YOUR_WEB_APP_EXEC_URL
GOOGLE_APPS_SCRIPT_SECRET=YOUR_PRIVATE_WEBHOOK_SECRET
```

Restart the bot. It creates the six tabs and their headers automatically. In the Admin Panel, use **Sheet Sync** or `/syncstatus` to see the queue.

Keep the webhook secret private and never commit `.env`.

## 4. Push safely to GitHub

The ZIP contains no `.git` history. From the project folder:

```bash
git init
git add .
git commit -m "Initial Global Digits bot"
git branch -M main
git remote add origin YOUR_GITHUB_REPOSITORY_URL
git push -u origin main
```

Before `git add`, run `git status` and confirm `.env` is not listed.

## 5. Automatic GitHub deployment (recommended)

See [AUTO_DEPLOY.md](AUTO_DEPLOY.md). The included workflow deploys every push to `main`, runs `npm ci`, syntax and database checks, and uses PM2 `startOrReload` so the first deployment starts the bot and later deployments reload it.

## 6. Run continuously with PM2 manually

Install a current Node.js LTS release, clone the private repository, and then:

```bash
cd GLOBAL_DIGITS_BOT
npm ci --omit=dev
npm run db:check
sudo npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Run the command printed by `pm2 startup`, then run `pm2 save` again.

Useful commands:

```bash
pm2 status
pm2 logs global-digits-bot
pm2 restart global-digits-bot
```

After a future GitHub update:

```bash
git pull
npm ci --omit=dev
npm run check
pm2 restart global-digits-bot
```

## 7. Backup

PostgreSQL contains the real bot state. Google Sheets is a mirror, not a database backup. Create a dump regularly:

```bash
pg_dump -U globaldigits -h 127.0.0.1 globaldigits_bot > globaldigits_backup.sql
```

Store backups outside the VPS and protect them because they contain customer and delivered-account data.
