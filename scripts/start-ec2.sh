#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; source .env; set +a; fi
export NODE_OPTIONS="--experimental-sqlite"
SESSION="hurlicane"
tmux kill-session -t "$SESSION" 2>/dev/null || true
npm run build
tmux new-session -d -s "$SESSION" "node dist/server/index.js"
echo "Started in tmux session: $SESSION"
