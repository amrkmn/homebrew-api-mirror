# Homebrew API Mirror

Mirrors the Homebrew API (formulae, casks, analytics, etc.) to any S3-compatible storage (Cloudflare R2, AWS S3, MinIO, etc.) via GitHub Actions.

Downloads the full API from the **GitHub Actions artifact** published by `Homebrew/formulae.brew.sh` — the same method used by TUNA and USTC mirrors. No need to scrape `formulae.brew.sh` one file at a time.

Uses **Bun's native S3 client** — zero external dependencies. SHA-256 diff ensures only changed files are uploaded.

## Setup

### 1. Create a bucket

**Cloudflare R2:**
```bash
npx wrangler r2 bucket create homebrew-api
```

**AWS S3:**
```bash
aws s3 mb s3://homebrew-api
```

**MinIO:**
```bash
mc alias set local http://localhost:9000 minioadmin minioadmin
mc mb local/homebrew-api
```

### 2. Add GitHub secrets

| Secret | Cloudflare R2 | AWS S3 | MinIO |
|--------|--------------|--------|-------|
| `GH_PAT` | Personal access token with `public_repo` scope (needed to download artifacts from Homebrew/formulae.brew.sh) | Same | Same |
| `S3_ENDPOINT` | `https://<account_id>.r2.cloudflarestorage.com` | *(omit or set to `https://s3.<region>.amazonaws.com`)* | `http://localhost:9000` |
| `S3_ACCESS_KEY_ID` | R2 access key ID | AWS access key ID | MinIO access key |
| `S3_SECRET_ACCESS_KEY` | R2 secret access key | AWS secret access key | MinIO secret key |
| `S3_BUCKET` | `homebrew-api` | `homebrew-api` | `homebrew-api` |
| `S3_REGION` | `auto` | `us-east-1` | *(omit)* |
| `S3_FORCE_PATH_STYLE` | `false` | `false` | `true` |

```bash
gh secret set GH_PAT             -b "<your_github_pat_with_public_repo>"
gh secret set S3_ENDPOINT        -b "https://<account_id>.r2.cloudflarestorage.com"
gh secret set S3_ACCESS_KEY_ID   -b "<access_key>"
gh secret set S3_SECRET_ACCESS_KEY -b "<secret_key>"
gh secret set S3_BUCKET          -b "homebrew-api"
gh secret set S3_REGION          -b "auto"
gh secret set S3_FORCE_PATH_STYLE -b "false"
```

### 3. Enable public access

**Cloudflare R2:** Dashboard → R2 → homebrew-api → Settings → Enable R2.dev subdomain or custom domain

**AWS S3:** Configure bucket policy for public read access, or use CloudFront

**MinIO:** Configure bucket policy: `mc anonymous set download local/homebrew-api`

## Client usage

```bash
# Point to your bucket's public URL
export HOMEBREW_API_DOMAIN=https://<bucket-url>/api
```

The bucket stores files matching the upstream layout, prefixed with `api/`:
- `api/formula.json`, `api/cask.json` — aggregate files
- `api/formula/git.json`, `api/cask/visual-studio-code.json` — per-package
- `api/analytics/...`, `api/internal/...`

## Manual trigger

```bash
gh workflow run sync.yml
```

## How it works

```
GitHub Actions (every 30 min)
  │
  ├─ Fetch latest github-pages artifact from Homebrew/formulae.brew.sh
  ├─ Download artifact zip (cached locally if unchanged)
  ├─ Extract artifact.tar, parse api/ files from tar
  ├─ SHA-256 hash all files
  ├─ Load previous hashes from S3 (__hash_state__.json)
  ├─ Diff → upload only changed files, delete stale files
  └─ Save new hash state to S3
```

Error handling:
- **GitHub API**: exponential backoff (2s → 32s) on 429/5xx, 5 retries max
- **S3 uploads**: 4 concurrent workers, 50ms spacing, exponential backoff on failure
- **Required files**: `formula.json` and `cask.json` must be present — sync aborts if missing
- **Artifact selection**: only non-expired artifacts from the `main` branch are considered
- **Artifact caching**: downloaded artifact zips are cached by artifact ID; if the same artifact is still the latest, the download is skipped. Old caches are pruned automatically.

## Sync details

| What | Source | S3 key |
|------|--------|--------|
| All API files | GitHub Actions artifact from `Homebrew/formulae.brew.sh` | `api/...` (mirrors upstream layout) |

The artifact contains the complete `api/` directory as published by the Homebrew project, including:
- `api/formula.json`, `api/cask.json` — aggregate files
- `api/formula/git.json`, `api/cask/visual-studio-code.json` — per-package
- `api/analytics/...`, `api/internal/...`