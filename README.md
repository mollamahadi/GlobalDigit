# Global Digits Bot

Production-ready Telegram digital-product store for `@GlobalDigits_Bot`.

## Included

- PostgreSQL is the permanent source of truth; no SQLite database is included.
- Google Sheets mirror with `Users`, `Products`, `Stock`, `Orders`, `Delivered`, and `Deposits` tabs.
- Durable Sheet outbox: Telegram orders continue if Google is temporarily unavailable, and sync retries automatically.
- Admin Panel product/category/stock management without editing source code.
- Automatic or manual delivery selected while creating each product.
- Optional manual area codes, including Google Voice, TN, TextNow, Telegram Stars, Facebook Account, and custom products.
- Wallet add/cut, payment proof review, deposit approve/reject, QR payments, channel verification, terms, back navigation, and screen cleanup.
- Concurrent automatic purchases are protected by PostgreSQL row locks so one stock item cannot be delivered twice.
- GitHub Actions production deployment: every push to `main` securely copies the release to the VPS, validates it, applies the database schema, and reloads only this PM2 bot.

## First setup

Follow [SETUP.md](SETUP.md). In short:

1. Create the PostgreSQL database and user.
2. Copy `.env.example` to `.env` and set `BOT_TOKEN`, database password, and IDs.
3. Run `npm ci` and `npm run db:check`.
4. Set up the Google service account and Sheet, then enable Sheet sync.
5. Start locally with `npm start`, or follow [AUTO_DEPLOY.md](AUTO_DEPLOY.md) for automatic GitHub-to-VPS deployment.

The schema and indexes are created automatically on first start.

## Sheet behavior

- Product created/updated in the Admin Panel -> `Products`.
- Stock added or sold -> `Stock`.
- Purchase made -> `Orders`.
- Automatically delivered account or completed manual delivery -> `Delivered`, including account details.
- Deposit proof and review result -> `Deposits`.
- User/profile/wallet changes -> `Users`.

The Sheet is a reporting mirror. Do not manually edit Sheet rows expecting them to alter the bot; edit operational data from the Admin Panel so PostgreSQL remains consistent.

## Security

Never commit `.env` or `google-service-account.json`. Both are already ignored by Git. Rotate the Telegram token immediately if it is ever exposed.

## Useful commands

- `npm run check` - JavaScript syntax check.
- `npm run db:check` - connect to PostgreSQL and create/check all tables.
- `npm start` - run the bot.
- `/syncstatus` - admin-only Sheet queue status.
- `/syncall` - queue a complete PostgreSQL-to-Sheet refresh.

All regular management commands are also shown by the Admin Panel's **Commands** button.
