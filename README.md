# formulae-mirror

Mirrors [formulae.brew.sh](https://formulae.brew.sh) to Render via GitHub Actions.

Downloads the full github-pages artifact published by `Homebrew/formulae.brew.sh`, records the artifact ID, and pushes to the repo — triggering a Render deploy.

## Setup

No repository secrets required — the workflow uses the built-in `GITHUB_TOKEN` with explicit permissions (`artifact-metadata: read`, `actions: read`, `contents: write`).

For local development, set `GITHUB_TOKEN` in `.env`.

## How it works

Runs every 30 minutes via GitHub Actions:

1. Fetch latest `github-pages` artifact ID from `Homebrew/formulae.brew.sh`
2. Record artifact ID in `.latest.artifact`
3. Commit & push — Render auto-deploys on push
