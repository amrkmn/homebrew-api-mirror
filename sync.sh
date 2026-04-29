#!/bin/sh
set -e

START_TS=$(date '+%Y-%m-%d %H:%M:%S')
START_SEC=$(date '+%s')
echo "Sync started at ${START_TS}."

REPO="Homebrew/formulae.brew.sh"
ARTIFACT_FILE=".latest.artifact"
API_URL="https://api.github.com/repos/${REPO}/actions/artifacts?name=github-pages&per_page=10"

cd "$(dirname "$0")"

# --- Load GITHUB_TOKEN from .env if not already set ---
if [ -z "${GITHUB_TOKEN:-}" ] && [ -f ".env" ]; then
    GITHUB_TOKEN=$(grep '^GITHUB_TOKEN=' .env | cut -d '=' -f 2-)
    export GITHUB_TOKEN
fi

# --- Check required commands ---
for cmd in curl jq git; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "ERROR: Required command '$cmd' not found." >&2
        exit 1
    fi
done

# --- Auth: gh CLI > GITHUB_TOKEN > error ---
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    echo "Using gh CLI for auth"
    LATEST_ID=$(gh api "repos/${REPO}/actions/artifacts?name=github-pages&per_page=10" \
        --jq '[.artifacts[] | select(.workflow_run.head_branch == "main" and .expired == false)] | first | .id')
elif [ -n "${GITHUB_TOKEN:-}" ]; then
    echo "Using GITHUB_TOKEN for auth"
    LATEST_ID=$(curl -sf \
        -H "Authorization: Bearer ${GITHUB_TOKEN}" \
        -H "Accept: application/vnd.github+json" \
        "${API_URL}" \
        | jq -r '[.artifacts[] | select(.workflow_run.head_branch == "main" and .expired == false)] | first | .id')
else
    echo "ERROR: Neither gh CLI nor GITHUB_TOKEN available." >&2
    exit 1
fi

if [ -z "${LATEST_ID}" ] || [ "${LATEST_ID}" = "null" ]; then
    echo "ERROR: Could not find a valid github-pages artifact on main." >&2
    exit 1
fi

CURRENT_ID=$(cat "${ARTIFACT_FILE}" 2>/dev/null || echo "")

if [ "${LATEST_ID}" = "${CURRENT_ID}" ]; then
    echo "Already up to date: #${LATEST_ID}"
    END_SEC=$(date '+%s')
    DURATION=$((END_SEC - START_SEC))
    END_TS=$(date '+%Y-%m-%d %H:%M:%S')
    echo "Sync completed at ${END_TS} (${DURATION}s)."
    exit 0
fi

if [ -z "${CURRENT_ID}" ]; then
    CURRENT_LABEL="none"
else
    CURRENT_LABEL="${CURRENT_ID}"
fi
echo "New artifact available: #${LATEST_ID} (current: #${CURRENT_LABEL})"

echo "${LATEST_ID}" > "${ARTIFACT_FILE}"
git add "${ARTIFACT_FILE}"

if git diff --cached --quiet; then
    echo "No changes to commit."
    END_SEC=$(date '+%s')
    DURATION=$((END_SEC - START_SEC))
    END_TS=$(date '+%Y-%m-%d %H:%M:%S')
    echo "Sync completed at ${END_TS} (${DURATION}s)."
    exit 0
fi

git pull --rebase --autostash
git add "${ARTIFACT_FILE}"
git commit -m "sync: artifact #${LATEST_ID}"
git push

echo "Pushed artifact #${LATEST_ID}."

END_SEC=$(date '+%s')
DURATION=$((END_SEC - START_SEC))
END_TS=$(date '+%Y-%m-%d %H:%M:%S')
echo "Sync completed at ${END_TS} (${DURATION}s)."
