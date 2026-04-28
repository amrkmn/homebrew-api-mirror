# formulae-mirror

Mirrors [formulae.brew.sh](https://formulae.brew.sh) to Render via GitHub Actions.

Downloads the full github-pages artifact published by `Homebrew/formulae.brew.sh`, extracts all files to `dist/`, and pushes to the repo — triggering a Render deploy.

## Setup

Set this repository secret:

| Key          | Type   | Description                         |
| ------------ | ------ | ----------------------------------- |
| `GH_PAT`     | Secret | GitHub PAT with `public_repo` scope |

```bash
gh secret set GH_PAT
```

## How it works

Runs every 15 minutes via GitHub Actions:

1. Fetch latest `github-pages` artifact from `Homebrew/formulae.brew.sh`
2. Download & cache artifact zip (skipped if unchanged)
3. Extract all files to `./dist`
4. Commit & push — Render auto-deploys on push
