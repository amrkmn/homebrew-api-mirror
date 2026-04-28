# formulae-mirror

Mirrors [formulae.brew.sh](https://formulae.brew.sh) to Cloudflare Workers via GitHub Actions.

Downloads the full github-pages artifact published by `Homebrew/formulae.brew.sh` and deploys it as a static site on Cloudflare.

## Setup

Set these repository secrets and variables:

| Key                        | Type     | Description                         |
| -------------------------- | -------- | ----------------------------------- |
| `GH_PAT`                   | Secret   | GitHub PAT with `public_repo` scope |
| `CLOUDFLARE_API_TOKEN`     | Secret   | Cloudflare API token                |
| `CLOUDFLARE_ACCOUNT_ID`    | Secret   | Cloudflare account ID               |
```bash
gh secret set GH_PAT
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID
```

## How it works

Runs every 15 minutes via GitHub Actions:

1. Fetch latest `github-pages` artifact from `Homebrew/formulae.brew.sh`
2. Download & cache artifact zip (skipped if unchanged)
3. Extract all files to `./dist`
4. Deploy to Cloudflare Workers via `wrangler`
