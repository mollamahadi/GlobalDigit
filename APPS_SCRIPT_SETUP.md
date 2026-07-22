# Google Apps Script Sheet Sync

This setup uses the spreadsheet `Global Digits Bot Database` with ID:

```text
1qbsXuLUYgP0du2ac2s3yrFigQLhEwMtyVdtn2xEdGS0
```

No service-account JSON or Google Cloud project is required.

## 1. Create a private webhook secret

On the VPS, run:

```bash
openssl rand -hex 32
```

Copy the result privately. Do not send it in chat or commit it to GitHub.

## 2. Add Apps Script to the Sheet

Open the spreadsheet, select **Extensions -> Apps Script**, delete the sample code, and paste all contents of `google-apps-script/Code.gs`.

In Apps Script, open **Project Settings -> Script Properties**, add:

```text
Property: WEBHOOK_SECRET
Value: the secret generated in step 1
```

Save the project.

## 3. Authorize and create tabs

Select the `setupSheets` function and click **Run**. Approve the requested spreadsheet permission. It creates and formats these tabs:

- Users
- Products
- Stock
- Orders
- Delivered
- Deposits

## 4. Deploy the Web App

Select **Deploy -> New deployment -> Web app**:

- Execute as: **Me**
- Who has access: **Anyone**

Click **Deploy** and copy the production URL ending in `/exec`.

## 5. Enable it on the VPS

Edit `/opt/global-digits-bot/.env`:

```dotenv
SHEET_SYNC_ENABLED=true
GOOGLE_APPS_SCRIPT_URL=https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec
GOOGLE_APPS_SCRIPT_SECRET=THE_SAME_WEBHOOK_SECRET
```

Restart the bot and check:

```bash
pm2 restart global-digits-bot
pm2 logs global-digits-bot --lines 30 --nostream
```

The log should show `Apps Script and Google Sheet tabs are ready.` Use `/syncall` once in Telegram to send all existing PostgreSQL records to the Sheet.
