# Automatic GitHub to VPS Deployment

After this one-time setup, every push to the `main` branch automatically updates `/opt/global-digits-bot`, runs checks, applies the PostgreSQL schema, and starts/reloads only the `global-digits-bot` PM2 process.

## GitHub repository secrets

Create these under **Repository -> Settings -> Secrets and variables -> Actions**:

- `VPS_HOST` - the VPS IP address.
- `VPS_USER` - `globaldigitsbot`.
- `VPS_SSH_PRIVATE_KEY` - the complete private key printed from `/root/globaldigits-github-actions`, including the BEGIN and END lines.

Never commit the private key or `.env` to the repository.

## What the workflow preserves

Deployment never uploads or deletes these VPS-only items:

- `.env`
- `google-service-account.json`
- `node_modules/`
- `data/`

The GitHub workflow is `.github/workflows/deploy.yml`. It can also be run manually from the repository's **Actions** tab.
