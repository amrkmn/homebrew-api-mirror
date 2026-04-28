# formulae-mirror

Mirrors formulae.brew.sh to Render. Runs on a 30-minute schedule.

Homebrew publishes a `github-pages` artifact from `Homebrew/formulae.brew.sh`. This repo grabs the latest artifact, stashes its ID in `.latest.artifact`, and pushes the result. Render picks up the push and auto-deploys.

## Setup

No secrets needed. The workflow runs with the built-in `GITHUB_TOKEN`.

For local runs, put a `GITHUB_TOKEN` in `.env`.

## How it works

1. Fetch the latest `github-pages` artifact ID from `Homebrew/formulae.brew.sh`
2. Write the ID to `.latest.artifact`
3. Commit and push. Render deploys automatically.
