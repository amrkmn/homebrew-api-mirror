# Homebrew API Mirror

Mirrors the Homebrew API to any S3-compatible storage (Cloudflare R2, AWS S3, MinIO) via GitHub Actions.

Downloads the full API from the GitHub Actions artifact published by `Homebrew/formulae.brew.sh` — no need to scrape `formulae.brew.sh` one file at a time. Uses **Bun's native S3 client** with SHA-256 delta syncing so only changed files are uploaded.

## Setup

### 1. Create a bucket

```bash
# Cloudflare R2
npx wrangler r2 bucket create homebrew-api

# AWS S3
aws s3 mb s3://homebrew-api

# MinIO
mc mb local/homebrew-api
```

### 2. Add GitHub secrets

| Secret | Cloudflare R2 | AWS S3 | MinIO |
|--------|--------------|--------|-------|
| `GH_PAT` | PAT with `public_repo` scope | Same | Same |
| `S3_ENDPOINT` | `https://<account_id>.r2.cloudflarestorage.com` | *(omit)* | `http://localhost:9000` |
| `S3_ACCESS_KEY_ID` | R2 access key ID | AWS access key ID | MinIO access key |
| `S3_SECRET_ACCESS_KEY` | R2 secret access key | AWS secret access key | MinIO secret key |
| `S3_BUCKET` | `homebrew-api` | `homebrew-api` | `homebrew-api` |
| `S3_REGION` | `auto` | `us-east-1` | *(omit)* |
| `S3_FORCE_PATH_STYLE` | `false` | `false` | `true` |

```bash
gh secret set GH_PAT
gh secret set S3_ENDPOINT
gh secret set S3_ACCESS_KEY_ID
gh secret set S3_SECRET_ACCESS_KEY
gh secret set S3_BUCKET
gh secret set S3_REGION
gh secret set S3_FORCE_PATH_STYLE
```

### 3. Enable public access

- **R2:** Dashboard → bucket → Settings → enable R2.dev subdomain or custom domain
- **S3:** Configure bucket policy for public read, or use CloudFront
- **MinIO:** `mc anonymous set download local/homebrew-api`

## Usage

```bash
export HOMEBREW_API_DOMAIN=https://<your-bucket-url>/api
```

The bucket mirrors the upstream layout: `api/formula.json`, `api/cask.json`, `api/formula/*.json`, `api/cask/*.json`, `api/analytics/`, etc.

## How it works

Runs every 30 minutes via GitHub Actions:

1. Fetch latest `github-pages` artifact from `Homebrew/formulae.brew.sh`
2. Download & cache artifact zip (skipped if unchanged)
3. Extract `api/` files and SHA-256 hash them
4. Compare against previous hashes stored in S3
5. Upload only changed files, delete stale files
6. Save updated hash state