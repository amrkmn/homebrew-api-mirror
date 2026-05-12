# formulae-mirror

Mirrors formulae.brew.sh. Runs via `sync.sh` on a cron schedule.

Homebrew publishes a `github-pages` artifact from `Homebrew/formulae.brew.sh`. The `sync.sh` script checks for new artifacts, commits the ID, and pushes.

## Setup

Set up `gh auth login` or a `GITHUB_TOKEN` env var on your VPS, then run:

```bash
./sync.sh
```

### Crontab

**Option A - token inline:**
```cron
*/20 * * * * GITHUB_TOKEN=your_token /path/to/formulae-mirror/sync.sh >> /var/log/formulae-sync.log 2>&1
```

**Option B - token in `.env` (recommended):**
```cron
*/20 * * * * /path/to/formulae-mirror/sync.sh >> /var/log/formulae-sync.log 2>&1
```
With `GITHUB_TOKEN=your_token` stored in the project's `.env` file — the script loads it automatically.
