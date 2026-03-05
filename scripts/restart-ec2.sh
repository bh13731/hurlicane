#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Load nvm if available
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

if [ -f .env ]; then set -a; source .env; set +a; fi
export NODE_OPTIONS="--experimental-sqlite"

SESSION="hurlicane"

echo "[restart] Pulling latest from origin..."
git pull origin aaryaman-main

echo "[restart] Installing dependencies..."
npm install

echo "[restart] Building..."
npm run build

echo "[restart] Stopping existing session..."
tmux kill-session -t "$SESSION" 2>/dev/null || true

echo "[restart] Starting server..."
tmux new-session -d -s "$SESSION" "node dist/server/index.js"

echo "[restart] Done — running in tmux session: $SESSION"
