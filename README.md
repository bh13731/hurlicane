# Claude Orchestrator

A web-based dashboard for running multiple Claude Code agents in parallel. Agents can coordinate through file locks, spawn sub-agents, ask the user questions, and share data via a scratchpad — all visible in a real-time UI.

## Requirements

- **Node.js ≥ 22** — uses the experimental `node:sqlite` module
- **[Claude Code CLI](https://github.com/anthropics/claude-code)** — default path: `/Users/kph/.local/bin/claude`
- **tmux** — required for interactive sessions
  ```bash
  # macOS
  brew install tmux
  # Ubuntu/Debian
  sudo apt install tmux
  ```
- **C++ build tools** — needed to compile the `node-pty` native addon
  ```bash
  # macOS — install Xcode Command Line Tools if not already present
  xcode-select --install
  # Ubuntu/Debian
  sudo apt install build-essential python3
  ```
- **sqlite3 CLI** — needed only if you want to manually acquire file locks (see below)
  ```bash
  # macOS
  brew install sqlite
  # Ubuntu/Debian
  sudo apt install sqlite3
  ```

## Setup

```bash
npm install
```

If your Claude binary is somewhere else, set `CLAUDE_BIN`:

```bash
export CLAUDE_BIN=/path/to/claude
```

## Starting the Server

```bash
npm run dev
```

This starts the Express + Socket.io server on port 3000 and the Vite dev server concurrently, both with hot reload.

Open **http://localhost:3000** in your browser.

For production:

```bash
npm run build
npm run server:start
```

## Using the Dashboard

### Creating a Job

Click **New Job** in the header to open the job form. Fill in:

- **Description** — the task to run (required)
- **Title** — auto-generated from the description if left blank
- **Priority** — -10 to +10; higher priority jobs are dispatched first
- **Model** — leave blank to let the system pick, or specify a model ID
- **Work directory** — defaults to the server's working directory
- **Max turns** — cap on conversation turns before the agent stops
- **Depends on** — comma-separated job IDs that must complete first
- **Context** — extra key/value data injected into the agent's prompt
- **Template** — pick a saved prompt template to pre-fill the description

Submit the form and the job enters the queue. The `WorkQueueManager` polls every 2 seconds, resolves dependencies, and dispatches queued jobs to Claude Code subprocesses.

### Watching Agent Output

Click any agent card to open its terminal panel. The **Output** tab streams the agent's JSON event log in a readable format — assistant text, tool calls, and results. The **Changes** tab shows a git diff of files modified since the agent started (if the work directory is a git repo).

Agent cards are color-coded by status:

| Color | Meaning |
|-------|---------|
| Orange | Starting or running |
| Red | Waiting for your answer |
| Green | Done with unread output |
| Dim | Failed or cancelled |

### Answering Agent Questions

Agents can call `ask_user` to pause and ask you something. When this happens the agent card turns red and a prompt appears in the terminal panel. Type your answer and click **Submit** — the agent resumes immediately.

### Interactive Sessions

Set **Interactive** when creating a job to run the agent in a tmux session via a pseudo-terminal instead of batch mode. This is useful for tasks that need live terminal I/O (e.g., running a test suite, using an editor).

In interactive mode:
- The terminal panel shows raw PTY output with full scrollback
- You can send input directly to the running process
- **Disconnect** exits the session view without killing the agent
- **Continue** (after the agent finishes) sends a follow-up message to the same tmux session

### Other Dashboard Features

| Button | What it does |
|--------|-------------|
| Search | Full-text search across all agent output |
| Timeline | Gantt chart of job execution over time |
| Graph | DAG visualization of job dependencies |
| Usage | Cost breakdown and token metrics |
| Templates | Create and manage reusable prompt templates |

## File Locking

Agents must acquire a lock before editing a file. A pre-tool-use hook (`scripts/check-lock-hook.mjs`) enforces this — it intercepts every Edit/Write call and rejects it if the agent doesn't hold the lock for that file.

Agents use MCP tools to coordinate:

```
lock_files(files, reason)   — acquire exclusive lock(s); blocks until available
release_files(files)        — release lock(s) when done
check_file_locks()          — list all currently held locks
```

The lock map is visible in the dashboard via the file lock panel.

### Locking for the Interactive Session (Manual Edits)

If you're editing files directly while the orchestrator is running, the hook applies to you too (your interactive Claude Code session is also subject to lock checks). Use this workaround to temporarily hold a lock:

```bash
AGENT_ID="$ORCHESTRATOR_AGENT_ID"
FILE="/absolute/path/to/file"
LOCK_ID=$(node -e "const {randomUUID}=require('crypto');console.log(randomUUID())")
NOW=$(node -e "console.log(Date.now())")
EXPIRES=$(node -e "console.log(Date.now()+300000)")

sqlite3 data/orchestrator.db \
  "INSERT INTO file_locks (id,agent_id,file_path,reason,acquired_at,expires_at,released_at)
   VALUES ('$LOCK_ID','$AGENT_ID','$FILE','manual edit',$NOW,$EXPIRES,NULL);"

# ... make your edits ...

sqlite3 data/orchestrator.db \
  "UPDATE file_locks SET released_at=$(node -e 'console.log(Date.now())') WHERE id='$LOCK_ID';"
```

## Multi-Agent Orchestration

Agents can spawn and coordinate sub-agents using MCP tools:

```
create_job(description, title?, priority?, work_dir?, max_turns?, model?, depends_on?)
  → returns { job_id, title, status }

wait_for_jobs(job_ids, timeout_ms?)
  → blocks until all jobs finish; returns { job_id, status, result_text, diff } for each
```

Agents can also share data through the scratchpad:

```
write_note(key, value)
read_note(key)
list_notes(prefix?)
```

Use namespaced keys like `"results/step1"` to avoid collisions between agents.

A typical orchestration pattern:

1. Call `report_status` to describe what you're doing
2. `create_job` for each parallel sub-task; collect job IDs
3. `wait_for_jobs` to block until all finish
4. Read `result_text` and `diff` from the results
5. Synthesize and report a final answer

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP + UI server port |
| `MCP_PORT` | `3001` | MCP tool server port (agents connect here) |
| `DB_PATH` | `data/orchestrator.db` | SQLite database location |
| `CLAUDE_BIN` | `/Users/kph/.local/bin/claude` | Path to the Claude Code CLI |
| `ORCHESTRATOR_AGENT_ID` | *(set automatically)* | Agent identity; used by the lock hook |
| `ORCHESTRATOR_API_URL` | `http://localhost:3000` | Base URL for lock verification |

## Project Structure

```
src/
  client/          React + Vite dashboard
  server/
    api/           REST endpoints (jobs, agents, locks, templates)
    db/            SQLite init, schema, query helpers
    mcp/           MCP tool server and tool implementations
    orchestrator/  AgentRunner, WorkQueueManager, FileLockRegistry, PtyManager
    socket/        Socket.io event broadcasting
  shared/
    types.ts       Types shared between server and client
scripts/
  check-lock-hook.mjs   Pre-tool-use hook that enforces file locks
data/
  orchestrator.db        SQLite database (auto-created on first run)
  agent-logs/            NDJSON output and stderr logs per agent
```
