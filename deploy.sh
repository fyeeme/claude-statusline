#!/usr/bin/env bash
set -euo pipefail

FORK_DIR="$(cd "$(dirname "$0")" && pwd)"
CACHE_BASE="$HOME/.claude/plugins/cache"

# Find the latest installed plugin version directory.
# Prefer the current name (claude-statusline); fall back to the legacy
# claude-hud directory so the script keeps working for existing installs.
# (ls is allowed to fail via `|| true` so `set -e` does not abort the loop.)
TARGET=""
for NAME in claude-statusline claude-hud; do
  TARGET=$( { ls -d "$CACHE_BASE/$NAME/$NAME"/*/ 2>/dev/null || true; } | sort | tail -1)
  [ -n "$TARGET" ] && break
done

if [ -z "$TARGET" ]; then
  echo "ERROR: No plugin cache found under $CACHE_BASE/{claude-statusline,claude-hud}/"
  echo "       Install the plugin first via /plugin install, then re-run deploy.sh"
  exit 1
fi

echo "Building..."
cd "$FORK_DIR"
npm run build

echo "Syncing src/ and dist/ -> $TARGET"
rsync -a --delete "$FORK_DIR/src/" "${TARGET}src/"
rsync -a --delete "$FORK_DIR/dist/" "${TARGET}dist/"

echo "Done. Restart Claude Code to apply."
