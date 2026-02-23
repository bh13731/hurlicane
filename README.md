# Claude Orchestrator

A web-based dashboard for running multiple Claude Code (and Codex) agents in parallel. Agents can coordinate through file locks, spawn sub-agents, ask the user questions, share data via a scratchpad, and engage in structured multi-round debates — all visible in a real-time UI.

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
- **Model** — leave blank to let the system pick, or specify a model ID (Claude or Codex)
- **Work directory** — defaults to the server's working directory
- **Max turns** — cap on conversation turns before the agent stops
- **Depends on** — comma-separated job IDs that must complete first
- **Use worktree** — create an isolated git worktree for this job (see below)
- **Interactive** — run in a tmux PTY instead of batch mode
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
| Usage | Cost breakdown and token metrics (Claude and Codex separately) |
| Templates | Create and manage reusable prompt templates |
| Batch | Create and run batch template lists |
| Debate | Set up a structured multi-round debate between two models |
| Projects | Organize jobs into named groups |
| Settings | Configure global options (e.g., max concurrent agents) |

## Projects

Jobs can be organized into **Projects** — named groups visible in the dashboard. Click **Projects** in the header to create, switch between, or delete projects. The dashboard filters to show only jobs in the active project.

Sub-agents spawned via `create_job` inherit their parent's project automatically. Batch templates and debates each create a new project when run.

## Debates

**Debates** run two AI models — Claude and a Codex model — through a structured multi-round discussion on a shared task. Each round both sides independently analyze the problem and state a verdict (`agree`, `disagree`, or `partial`). When both sides agree the debate concludes with **consensus**; if the maximum number of rounds is reached without agreement it concludes with **disagreement**.

### Creating a Debate

Click **Debate** in the header and fill in:

- **Task** — the question or decision to debate
- **Claude model** — which Claude model to use
- **Codex model** — which Codex model to use
- **Max rounds** — 1–10 rounds (default 3)
- **Template** — optional prompt template to pre-fill the task
- **Post-action prompt** — if set, runs one model after the debate completes (e.g., "Implement what you agreed on")
- **Post-action role** — which side (Claude or Codex) runs the post-action
- **Verification** — if enabled and a post-action prompt is set, the other model reviews the implementation and the implementer responds with refinements

### How Rounds Work

1. Both models receive the task and generate independent analyses with a structured `<consensus_block>` JSON verdict
2. In subsequent rounds each side sees the other's previous output and can update its position
3. The debate manager reads the verdicts after each round and advances to the next round or closes the debate
4. All jobs for a debate are grouped in an automatically created project

## Batch Templates

**Batch Templates** let you save a list of task descriptions and run them all at once. Click **Batch** in the header to manage templates.

When you run a batch template you can choose:

- **Normal mode** — creates one job per item in the template
- **Debate mode** — creates one full debate per item (with all debate options)
- Model, work directory, max turns, worktree, and other per-job options

All jobs (or debates) from a single batch run are grouped under a new project.

## Git Worktree Support

Enable **Use worktree** on any job to give that agent an isolated git checkout. The orchestrator runs `git worktree add` before spawning the agent and sets the agent's working directory to the new worktree. This lets multiple agents work on the same repository simultaneously without interfering with each other or with your working tree.

Worktrees are created under `.orchestrator-worktrees/<agentId>` relative to the repository root, on a branch named `orchestrator/<job-title>-<agentId>`.

## Codex CLI Support

You can run [Codex](https://github.com/openai/codex) agents alongside Claude agents. Select a Codex model (e.g., `codex`, `codex-gpt-5.3-codex`) when creating a job, debate, or batch run.

- **Batch mode** — runs `codex exec --json` and parses the stream-json event format
- **Interactive mode** — launches Codex in a tmux PTY session
- **Cost tracking** — Codex spend is tracked separately from Claude and shown in the Usage panel
- **Sub-agents** — `create_job` passes the parent model down so Codex-spawned sub-jobs stay on Codex

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

Agents can share data through the scratchpad:

```
write_note(key, value)
read_note(key)
list_notes(prefix?)
watch_notes(keys?, prefix?, until_value?, timeout_ms?)
  → blocks until the specified keys exist (or a note under the prefix exists)
```

Use namespaced keys like `"results/step1"` to avoid collisions between agents. Use `watch_notes` instead of polling `read_note` — it blocks until the data is ready and wakes up automatically.

A typical orchestration pattern:

1. Call `report_status` to describe what you're doing
2. `create_job` for each parallel sub-task; collect job IDs
3. `wait_for_jobs` to block until all finish
4. Read `result_text` and `diff` from the results
5. Synthesize and report a final answer

## Settings

Click the settings icon in the header to open the Settings modal. Currently configurable:

| Setting | Default | Description |
|---------|---------|-------------|
| Max Concurrent Agents | 20 | How many agents may run simultaneously |

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
    api/           REST endpoints (jobs, agents, locks, templates, debates, projects, batch)
    db/            SQLite init, schema, query helpers
    mcp/           MCP tool server and tool implementations
    orchestrator/  AgentRunner, WorkQueueManager, FileLockRegistry, PtyManager, DebateManager
    socket/        Socket.io event broadcasting
  shared/
    types.ts       Types shared between server and client
scripts/
  check-lock-hook.mjs   Pre-tool-use hook that enforces file locks
data/
  orchestrator.db        SQLite database (auto-created on first run)
  agent-logs/            NDJSON output and stderr logs per agent
```
