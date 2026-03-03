#!/bin/sh
# claude-onboard: update-context runner
# Called by git hooks to regenerate context locally.
# Runs claude-onboard update (no LLM needed — pure static analysis).
# Fails silently to never block git operations.

MODE="${1:-manual}"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo ".")"
META_FILE="$REPO_ROOT/.claude/.onboarder-meta.json"
LOG_FILE="$REPO_ROOT/.claude/hooks/update.log"
LOCK_FILE="$REPO_ROOT/.claude/.update-lock"
THROTTLE_SECONDS=300

# Ensure log directory exists
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true

log() {
  echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") [$MODE] $1" >> "$LOG_FILE" 2>/dev/null || true
}

# Rotate log if > 1MB
if [ -f "$LOG_FILE" ]; then
  LOG_SIZE=$(wc -c < "$LOG_FILE" 2>/dev/null || echo 0)
  if [ "$LOG_SIZE" -gt 1048576 ]; then
    tail -c 524288 "$LOG_FILE" > "$LOG_FILE.tmp" 2>/dev/null && mv "$LOG_FILE.tmp" "$LOG_FILE" 2>/dev/null || true
  fi
fi

# Lock file check (prevent concurrent runs)
if [ -f "$LOCK_FILE" ]; then
  log "Skipped: another update is running"
  exit 0
fi

# Throttle: skip if updated recently
if [ -f "$META_FILE" ]; then
  # Use file modification time as a portable throttle check
  if [ "$(uname)" = "Darwin" ]; then
    LAST_EPOCH=$(stat -f "%m" "$META_FILE" 2>/dev/null || echo 0)
  else
    LAST_EPOCH=$(stat -c "%Y" "$META_FILE" 2>/dev/null || echo 0)
  fi
  NOW_EPOCH=$(date "+%s" 2>/dev/null || echo 0)
  DIFF=$((NOW_EPOCH - LAST_EPOCH))
  if [ "$DIFF" -lt "$THROTTLE_SECONDS" ] && [ "$DIFF" -ge 0 ]; then
    log "Skipped: throttled (${DIFF}s since last update)"
    exit 0
  fi
fi

# Find claude-onboard: prefer local node_modules, then npx, then global
if [ -x "$REPO_ROOT/node_modules/.bin/claude-onboard" ]; then
  ONBOARD_CMD="$REPO_ROOT/node_modules/.bin/claude-onboard"
elif command -v claude-onboard >/dev/null 2>&1; then
  ONBOARD_CMD="claude-onboard"
elif command -v npx >/dev/null 2>&1; then
  ONBOARD_CMD="npx claude-onboard"
else
  log "Skipped: claude-onboard not found (install with: npm i -D claude-onboard)"
  exit 0
fi

# Create lock
echo $$ > "$LOCK_FILE" 2>/dev/null || true
trap 'rm -f "$LOCK_FILE" 2>/dev/null' EXIT INT TERM

log "Starting documentation update via $ONBOARD_CMD"

# Run the update (regenerates docs from static analysis, no LLM)
$ONBOARD_CMD update "$REPO_ROOT" > /dev/null 2>&1 || {
  log "Update failed (non-fatal)"
}

log "Update complete"

# Check confidence score and warn if low
ANSWERS_FILE="$REPO_ROOT/.claude/.onboard-answers.json"
if [ ! -f "$ANSWERS_FILE" ]; then
  echo "\033[33m⚠️  Documentation may have gaps — run 'claude-onboard init --interactive' to improve\033[0m" 2>/dev/null || true
fi
