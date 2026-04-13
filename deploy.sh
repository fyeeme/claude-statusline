#!/usr/bin/env bash
set -euo pipefail

FORK_DIR="$(cd "$(dirname "$0")" && pwd)"
CACHE_DIR="$HOME/.claude/plugins/cache/claude-hud/claude-hud"

# Find latest versioned directory in plugin cache
TARGET=$(ls -d "$CACHE_DIR"/*/ 2>/dev/null | sort -t/ -k1,1 | tail -1)
if [ -z "$TARGET" ]; then
  echo "ERROR: No plugin cache found at $CACHE_DIR"
  exit 1
fi

echo "Building..."
cd "$FORK_DIR"
npm run build

echo "Syncing src/ and dist/ -> $TARGET"
rsync -a --delete "$FORK_DIR/src/" "${TARGET}src/"
rsync -a --delete "$FORK_DIR/dist/" "${TARGET}dist/"

echo "Done. Restart Claude Code to apply."
