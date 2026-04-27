# Homebrew API Mirror

Mirrors the Homebrew API to S3-compatible storage via GitHub Actions.

Downloads the full API from the GitHub Actions artifact published by `Homebrew/formulae.brew.sh` — no need to scrape `formulae.brew.sh` one file at a time. Uses **Bun's native S3 client** with SHA-256 delta syncing so only changed files are uploaded.

## Setup

Create a bucket and set these repository secrets:

| Secret                 | Description                         | Default       |
| ---------------------- | ----------------------------------- | ------------- |
| `GH_PAT`               | GitHub PAT with `public_repo` scope | —             |
| `S3_ENDPOINT`          | S3 API endpoint                     | —             |
| `S3_ACCESS_KEY_ID`     | Access key ID                       | —             |
| `S3_SECRET_ACCESS_KEY` | Secret access key                   | —             |
| `S3_BUCKET`            | Bucket name                         | —             |
| `S3_REGION`            | Region                              | `auto`        |
| `S3_FORCE_PATH_STYLE`  | Use path-style URLs                 | `false`       |

```bash
gh secret set GH_PAT
gh secret set S3_ENDPOINT
gh secret set S3_ACCESS_KEY_ID
gh secret set S3_SECRET_ACCESS_KEY
gh secret set S3_BUCKET
gh secret set S3_REGION
gh secret set S3_FORCE_PATH_STYLE
```

Enable public read access on your bucket, then:

```bash
export HOMEBREW_API_DOMAIN=https://<your-bucket-url>/api
```

## How it works

Runs every 30 minutes via GitHub Actions:

1. Fetch latest `github-pages` artifact from `Homebrew/formulae.brew.sh`
2. Download & cache artifact zip (skipped if unchanged)
3. Extract `api/` files and SHA-256 hash them
4. Compare against previous hashes stored in S3
5. Upload only changed files, delete stale files
6. Save updated hash state
