const MARKER_START = "# --- claude-onboard start ---";
const MARKER_END = "# --- claude-onboard end ---";

function wrapInMarkers(script: string): string {
  return `${MARKER_START}\n${script}\n${MARKER_END}`;
}

export function renderPostCommitHook(): string {
  return wrapInMarkers(`# claude-onboard: post-commit hook (runs in background)
if [ -f ".claude/hooks/update-docs.sh" ]; then
  sh .claude/hooks/update-docs.sh "commit" &
fi`);
}

export function renderPostMergeHook(): string {
  return wrapInMarkers(`# claude-onboard: post-merge hook (runs synchronously)
if [ -f ".claude/hooks/update-docs.sh" ]; then
  sh .claude/hooks/update-docs.sh "merge"
fi`);
}

export function renderPostRewriteHook(): string {
  return wrapInMarkers(`# claude-onboard: post-rewrite hook
if [ -f ".claude/hooks/update-docs.sh" ]; then
  sh .claude/hooks/update-docs.sh "rebase"
fi`);
}

export function renderPrepareCommitMsgHook(): string {
  // Reserved for future use (e.g., injecting context into commit messages).
  // Returns empty string so no hook is installed.
  return "";
}

export function renderUpdateDocsScript(): string {
  return `#!/bin/sh
# claude-onboard: update-docs runner
# Called by git hooks to regenerate documentation locally.
# Runs claude-onboard update (no LLM needed — pure static analysis).
# Fails silently to never block git operations.

MODE="\${1:-manual}"
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
    log "Skipped: throttled (\${DIFF}s since last update)"
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
  echo "\\033[33m⚠️  Documentation may have gaps — run 'claude-onboard init --interactive' to improve\\033[0m" 2>/dev/null || true
fi

# Detect significant churn and suggest interactive update
SNAPSHOT_FILE="$REPO_ROOT/.claude/.onboard-snapshot.json"
if [ -f "$SNAPSHOT_FILE" ] && command -v git >/dev/null 2>&1; then
  LAST_SHA=$(grep -o '"sha":"[^"]*"' "$SNAPSHOT_FILE" 2>/dev/null | head -1 | cut -d'"' -f4)
  if [ -n "$LAST_SHA" ]; then
    CHANGED_COUNT=$(git diff --name-only "$LAST_SHA" HEAD 2>/dev/null | wc -l | tr -d ' ')
    if [ "$CHANGED_COUNT" -ge 15 ]; then
      echo "\\033[33m⚠️  \${CHANGED_COUNT} files changed since last onboarding — run 'claude-onboard update --interactive' to update context\\033[0m" 2>/dev/null || true
    fi
  fi
fi
`;
}

export function renderUninstallScript(): string {
  return `#!/bin/sh
# claude-onboard: uninstall script
# Removes claude-onboard hooks and optionally the .claude/ directory

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo ".")"

echo "Removing claude-onboard git hooks..."
for HOOK in post-commit post-merge post-rewrite prepare-commit-msg; do
  HOOK_FILE="$REPO_ROOT/.git/hooks/$HOOK"
  if [ -f "$HOOK_FILE" ]; then
    # Remove only our markers
    if grep -q "claude-onboard start" "$HOOK_FILE" 2>/dev/null; then
      sed '/# --- claude-onboard start ---/,/# --- claude-onboard end ---/d' "$HOOK_FILE" > "$HOOK_FILE.tmp"
      mv "$HOOK_FILE.tmp" "$HOOK_FILE"
      # Remove file if empty (only whitespace)
      if [ ! -s "$HOOK_FILE" ] || ! grep -q '[^[:space:]]' "$HOOK_FILE" 2>/dev/null; then
        rm -f "$HOOK_FILE"
        echo "  Removed: $HOOK"
      else
        echo "  Cleaned: $HOOK (other hooks preserved)"
      fi
    fi
  fi
done

echo "Removing update-docs script..."
rm -f "$REPO_ROOT/.claude/hooks/update-docs.sh"
rm -f "$REPO_ROOT/.claude/.update-lock"

echo "Done. To also remove generated docs, run: rm -rf .claude/"
`;
}

export { MARKER_START, MARKER_END };
