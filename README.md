# Claude Orchestrator

A web-based dashboard for running multiple Claude Code (and Codex) agents in parallel. Agents can coordinate through file locks, spawn sub-agents, ask the user questions, share data via a scratchpad, learn from past tasks through a persistent knowledge base, and engage in structured multi-round debates — all visible in a real-time UI.

## Branches

| Branch | Description |
|--------|-------------|
| `main` | Stable base. Repos registered by local path, worktrees optional, agents can work anywhere. |
| `aaryaman-main` | Active development. Tight git coupling, Eye updates, system prompt appendix. |

### What `aaryaman-main` changes

#### Tight Git Coupling

On `main`, git is loosely integrated — repos are registered by local directory path, worktrees are optional, and agents can freely run in any directory. On `aaryaman-main`, the entire job lifecycle is coupled to git:

- **URL-based repo registration** — repos are registered by git URL and cloned to `data/repos/` with a live Socket.io progress bar. Local paths are no longer accepted.
- **Mandatory worktrees** — every job must run in a worktree. The "work directory" option is removed from the job form. Instead, a radio toggle lets you pick an existing worktree branch (dropdown) or create a new one (repo + branch name).
- **Branch protection** — a `PreToolUse` hook (`scripts/check-branch-hook.mjs`) blocks agents from switching branches (`git checkout`, `git switch`), creating branches (`-b`/`-B`), or renaming branches (`git branch -m`). The assigned branch is set via `ORCHESTRATOR_BRANCH` env var at spawn time, so it works for all agents including sub-agents.
- **Sub-agent worktree reuse** — when an agent spawns a sub-job (retry, continuation, debate stage), the sub-agent detects the `work_dir` is already a worktree and reuses it instead of trying to create a new one.
- **PR-based auto-cleanup** — worktrees are only auto-cleaned when their PR is merged or closed (checked via `gh pr view`), not when the job finishes. This keeps worktrees alive for follow-up work.

#### Eye — GitHub Webhook Automation

Eye (`eye/`) is a built-in GitHub webhook listener that automatically creates orchestrator jobs in response to GitHub events. It runs as a child process launched from the dashboard's Eye panel.

**What it does:** Point a GitHub webhook at Eye's URL and it watches for CI failures, PR reviews, and comments on your PRs — then automatically creates jobs (or debates) to fix them.

**Supported events:**

| Event | Trigger | Action |
|-------|---------|--------|
| `check_suite` | CI suite fails on your PR | Creates a "Fix CI" job |
| `check_run` | Individual check run fails on your PR | Creates a "Fix CI" job |
| `pull_request_review` | Someone requests changes or leaves a comment | Creates a job to address the review |
| `issue_comment` | Someone comments on your PR | Creates a job to respond |
| `pull_request` (close/sync) | PR closed or new push | Cleans up worktrees, resets dedup, cancels running jobs |

**How it works:**

1. GitHub sends a webhook to `http://<your-host>:4567/webhook`
2. Eye verifies the signature, filters to events on PRs owned by the configured author
3. Evaluates complexity — simple events become jobs, complex ones (e.g. 3+ failing checks, long review comments) become debates
4. Resolves or creates a worktree for the PR branch
5. Assigns the configured template and dispatches to the orchestrator

**Configuration:** Eye is launched from the Eye panel in the dashboard UI, where you set the webhook secret, GitHub author to watch, port, and template. Event types can be individually disabled. Duplicate events within 10 minutes are automatically deduplicated.

#### System Prompt Appendix

A new **System Prompt Appendix** setting lets you inject custom instructions into every agent's system prompt without editing code:

- **Settings UI** — the Settings modal now has a monospace textarea for the appendix, saved to the database via `PUT /api/settings`.
- **Injection** — `getSystemPrompt()` in `AgentRunner.ts` appends the stored text to the base system prompt. It's passed to Claude agents via `--append-system-prompt` and prepended to Codex agent prompts (which lack that flag).
- **Use cases** — enforce coding conventions, add project-specific rules, restrict agent behavior globally (e.g., "Never modify package.json without asking").

## Deploying on EC2

### Prerequisites (Amazon Linux 2023)

```bash
# Node.js 22
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo yum install -y nodejs

# Build tools (for node-pty native compilation)
sudo yum groupinstall -y "Development Tools"
sudo yum install -y python3

# tmux and git
sudo yum install -y tmux git

# Claude Code CLI
npm install -g @anthropic-ai/claude-code
```

### Setup

```bash
git clone <repo-url> hurlicane
cd hurlicane
npm install
```

Create a `.env` file with your configuration:

```bash
AUTH_PASSWORD=your-password-here
ANTHROPIC_API_KEY=sk-ant-...
# Optional: stable secret so sessions survive restarts
AUTH_SECRET=some-random-string
```

### Running

A startup script is provided:

```bash
./scripts/start-ec2.sh
```

This loads `.env`, builds the project, and starts the server in a detached tmux session. To manage it:

```bash
tmux attach -t hurlicane    # view logs (Ctrl-B D to detach)
tmux kill-session -t hurlicane  # stop the server
```

### EC2 Security Group

Open these inbound ports:

| Port | Purpose |
|------|---------|
| 3000 | Orchestrator UI and API |
| 4567 | Eye webhook listener (if using GitHub integration) |
| 22   | SSH |

### Password Protection

Set `AUTH_PASSWORD` in your `.env` to gate the UI, API, and Socket.io behind a login page. When unset, auth is disabled (for local dev). Internal service-to-service requests (Eye, MCP agents) on localhost bypass auth automatically.

## Requirements

- **Node.js ≥ 22** — uses the experimental `node:sqlite` module
- **[Claude Code CLI](https://github.com/anthropics/claude-code)** — install via npm, then find your binary with `which claude`
  ```bash
  npm install -g @anthropic-ai/claude-code
  ```
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
- **[Codex CLI](https://github.com/openai/codex)** *(optional)* — only needed if you want to run OpenAI Codex agents
  ```bash
  npm install -g @openai/codex
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
- **Model** — leave blank to auto-classify (see [Model Auto-Classification](#model-auto-classification)), or specify a model ID (Claude or Codex)
- **Worktree** — pick an existing worktree branch or create a new one (see [Git Worktree Support](#git-worktree-support))
- **Max turns** — cap on conversation turns before the agent stops
- **Depends on** — job IDs that must complete first
- **Interactive** — run in a tmux PTY instead of batch mode
- **Context** — extra key/value data injected into the agent's prompt
- **Template** — pick a saved prompt template to pre-fill the description
- **Repeat every N seconds** — re-queue the job on a schedule after each successful completion
- **Retry policy** — what to do if the job fails (see [Retry & Completion Checks](#retry--completion-checks))
- **Completion checks** — validation rules that must pass for a job to be considered successful

Submit the form and the job enters the queue. The `WorkQueueManager` polls every 2 seconds, resolves dependencies, and dispatches queued jobs to Claude Code subprocesses.

### Watching Agent Output

Click any agent card to open its terminal panel. The **Output** tab streams the agent's JSON event log in a readable format — assistant text, tool calls, and results. The **Changes** tab shows a git diff of files modified since the agent started (if the work directory is a git repo).

Agent cards are color-coded by status:

| Color | Meaning |
|-------|---------|
| Orange | Starting or running |
| Red | Waiting for your answer |
| Blue | Interactive agent idle (waiting for your input) |
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

### Agent Lifecycle Actions

After an agent finishes or fails, you have several options:

| Action | What it does |
|--------|-------------|
| Continue | Sends a follow-up message to the same session, preserving conversation context |
| Retry | Creates a fresh job with the same description |
| Requeue | Cancels the current run and resets the job back to queued |
| Reconnect | Re-attaches to a still-alive tmux session (useful after UI disconnects) |

### Other Dashboard Features

| Button | What it does |
|--------|-------------|
| Search | Full-text search across all agent output (powered by SQLite FTS5) |
| Timeline | Gantt chart of job execution over time |
| Graph | DAG visualization of job dependencies |
| Usage | Cost breakdown and token metrics (Claude and Codex separately) |
| Templates | Create and manage reusable prompt templates |
| Batch | Create and run batch template lists |
| Debate | Set up a structured multi-round debate between two models |
| Projects | Organize jobs into named groups |
| KB | Browse, search, and manage the agent knowledge base |
| Settings | Configure global options (e.g., max concurrent agents) |

## Projects

Jobs can be organized into **Projects** — named groups visible in the dashboard. Click **Projects** in the header to create, switch between, or delete projects. The dashboard filters to show only jobs in the active project.

Sub-agents spawned via `create_job` inherit their parent's project automatically. Batch templates and debates each create a new project when run.

Jobs can also be **flagged** for attention or **archived** to hide them from the default view. Use the archive view in the project selector to see archived jobs.

## Templates

**Templates** are reusable prompt skeletons that standardize how agents approach tasks. When a job uses a template, the template's content is prepended to the job description as a `## Guidelines` section, ensuring the agent follows your methodology regardless of what specific task it's given.

Templates can also set default **model** and **work directory** values that auto-fill in the job form when selected. The Templates panel shows per-template stats — success rate, average cost, average turns, and average duration broken down by model.

Click **Templates** in the header to create, edit, and delete templates.

### Example Templates

**Code Review:**
```
You are reviewing code changes. For each file changed:

1. Check for bugs, security issues, and performance problems
2. Verify error handling is complete
3. Ensure naming and style match the surrounding code
4. Note any missing tests

Write your findings as a structured report. If you find critical issues, flag them clearly.
Do NOT make changes — only report findings.
```

**Feature Implementation:**
```
You are implementing a feature. Follow these steps:

1. Read the relevant source files before writing any code
2. Follow existing patterns and conventions in the codebase
3. Write tests for any new functionality
4. Run existing tests to make sure nothing is broken
5. Keep changes minimal — only modify what's necessary

When finished, call finish_job with a summary of what you changed and why.
```

**Bug Investigation:**
```
You are investigating a bug. Your goal is to find the root cause, not to fix it.

1. Reproduce or understand the failure conditions
2. Trace the code path that leads to the bug
3. Identify the root cause
4. Write up your findings: what's broken, where, and why
5. Suggest a fix approach but do NOT implement it

Call finish_job with your analysis when done.
```

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

### Example Debates

**Architecture Decision** *(simple, 3 rounds):*

> Task: "We need to add real-time updates to our dashboard. Evaluate WebSockets vs Server-Sent Events vs long polling. Consider: complexity, browser support, scalability, and our existing Express stack."

Set max rounds to 3, no post-action. Both models argue their position independently, and you get a structured comparison with a consensus verdict. Good for quick decision-making where you want two perspectives.

**Code Review with Implementation** *(post-action + verification):*

> Task: "Review the error handling in our API layer. Identify inconsistencies, missing error cases, and propose a unified approach."
>
> Post-action prompt: "Implement the agreed-upon error handling improvements."
>
> Post-action role: Claude. Verification: enabled.

The debate phase produces a reviewed plan, the post-action implements it, and verification has the other model review the implementation. You get debate, implementation, and code review in one flow.

**Debugging Disagreement** *(focused, 2 rounds):*

> Task: "Users report intermittent 502 errors on the /api/checkout endpoint. The error logs show both timeout errors from the payment gateway and connection pool exhaustion in our database layer. Determine the root cause and propose a fix."
>
> Post-action prompt: "Implement the agreed-upon fix."
>
> Post-action role: Claude. Verification: disabled.

Two models independently analyze a complex bug from different angles, then converge on a diagnosis before one implements the fix.

## Batch Templates

**Batch Templates** let you save a list of task descriptions and run them all at once. Click **Batch** in the header to manage templates.

When you run a batch template you can choose:

- **Normal mode** — creates one job per item in the template
- **Debate mode** — creates one full debate per item (with all debate options)
- Model, work directory, max turns, worktree, and other per-job options

All jobs (or debates) from a single batch run are grouped under a new project.

### Example Batch Templates

**"Refactor to TypeScript Strict"** *(normal mode, with worktrees):*

Items:
- `Enable strict null checks in src/server/api/ and fix all resulting type errors`
- `Enable strict null checks in src/server/orchestrator/ and fix all resulting type errors`
- `Enable strict null checks in src/client/components/ and fix all resulting type errors`

Each item targets an independent directory, so agents run in parallel without conflicts. Enable worktree mode so each agent gets its own git checkout.

**"Security Audit"** *(normal mode, paired with a template):*

Pair with a "Security Review" template that defines your review methodology, then use batch items to narrow scope:
- `Audit authentication and session handling`
- `Audit all user-facing API endpoints for input validation`
- `Audit file upload and download paths for path traversal`
- `Audit database queries for SQL injection`

The template provides consistent methodology; each item narrows the scope so agents don't duplicate effort.

**"Architecture Decisions"** *(debate mode):*

Items:
- `Should we migrate from REST to GraphQL for our client API?`
- `Should we replace our homegrown caching layer with Redis?`
- `Should we switch from Jest to Vitest for our test suite?`

Run in debate mode with post-action enabled — after each debate reaches consensus, the post-action agent writes up a formal Architecture Decision Record (ADR).

## Agent Memory & Knowledge Base

Agents build up a persistent **knowledge base** of learnings across tasks — project conventions, debugging insights, build quirks, and useful patterns. This means agents get smarter over time as they accumulate experience with your codebase.

### How It Works

1. **At the start of each task**, the agent's prompt is automatically injected with relevant KB entries for the current project under a `## Memory` section.

2. **During a task**, agents can search for past learnings:
   ```
   search_kb(query, project_id?)  — full-text search of the knowledge base
   ```

3. **At the end of a task**, agents report what they learned:
   ```
   report_learnings(learnings[])  — report up to 5 learnings with title, content, tags, and scope
   ```
   Each learning has a **scope** hint: `"project"` for repo-specific knowledge or `"global"` for universal patterns.

4. **After a job completes**, a Haiku triage pass automatically classifies each reported learning as `project`, `global`, or `discard`. It checks against existing KB entries to avoid duplicates. Learnings that survive triage are persisted to the knowledge base.

### Managing the Knowledge Base

Click **KB** in the header to open the Knowledge Base modal. From here you can:

- Browse all entries (filterable by project)
- Full-text search across entries
- Manually add, edit, or delete entries
- See which agent and job produced each entry

### What Gets Learned

Typical KB entries include:
- Build commands and test invocations specific to a project
- Gotchas (e.g., "node:sqlite returns null-prototype objects — always cast via JSON.parse(JSON.stringify())")
- Naming conventions and architectural patterns
- Debugging tips for recurring issues
- File paths and project structure notes

## Model Auto-Classification

When a job is created without an explicit model, a Haiku classifier analyzes the task description and assigns a model based on complexity:

| Classification | Model |
|----------------|-------|
| Simple | Haiku |
| Medium | Sonnet |
| Complex | Opus |

This keeps costs down for straightforward tasks while ensuring complex work gets the most capable model. You can always override this by specifying a model explicitly.

## Retry & Completion Checks

### Retry Policies

Jobs can be configured with a retry policy that triggers when they fail:

| Policy | Behavior |
|--------|----------|
| `none` | No retry (default) |
| `same` | Re-queues an identical copy of the failed job |
| `analyze` | Spawns a Haiku agent to diagnose the failure, then creates a refined retry with the diagnosis context |

The `analyze` policy is particularly useful — the analysis agent reads the failure output, identifies what went wrong, and rewrites the task description to avoid the same mistake.

### Completion Checks

Completion checks are validation rules that run after an agent finishes. If any check fails, the job is marked as failed (and retry policies apply):

| Check | What it validates |
|-------|-------------------|
| `diff_not_empty` | The agent actually made git changes |
| `no_error_in_output` | No error events in the agent's recent output |
| `custom_command:<cmd>` | Runs a shell command in the work directory; exit 0 = pass |

Example custom command: `custom_command:npm test` ensures tests pass before the job is considered done.

## Scheduled & Repeat Jobs

Jobs support scheduling and recurring execution:

- **Scheduled jobs** — set a future timestamp and the job stays queued until that time arrives
- **Repeat jobs** — set a repeat interval (in seconds) and the job automatically re-queues itself after each successful completion

Use repeat jobs for ongoing tasks like periodic audits, health checks, or scheduled data processing.

## Git Worktree Support

All jobs run in isolated git worktrees. Repos are registered by URL and cloned to `data/repos/`; worktrees are created under `data/worktrees/` on branches named `orchestrator/<job-title>-<shortId>`.

### Repo Registration

Click the git icon in the header to register a repo by URL. The orchestrator clones it (with a progress bar streamed via Socket.io) and stores it locally. Before each worktree is created, `git pull origin main` runs to ensure the latest code.

### Creating Jobs on Worktrees

The job form offers two modes:

- **Existing branch** — a dropdown of active worktree branches. The job runs in the existing worktree alongside any prior work on that branch.
- **New branch** — select a repo and optionally name the branch (auto-generated from the job title if blank). A fresh worktree is created from `main`.

Sub-jobs spawned by agents (retries, continuations, debate stages) automatically reuse their parent's worktree rather than creating new ones.

### Branch Protection

Agents are restricted to their assigned worktree branch. A `PreToolUse` hook (`scripts/check-branch-hook.mjs`) intercepts Bash tool calls and blocks:

- `git checkout <branch>` (branch switching)
- `git checkout -b` / `-B` (branch creation)
- `git switch` (branch switching)
- `git branch -m` / `-M` (branch renaming)

File-restore operations (`git checkout -- <file>`) are allowed. The assigned branch is passed to agents via the `ORCHESTRATOR_BRANCH` environment variable at spawn time, so it works for all agents including sub-agents.

### Worktree Cleanup

- **Auto-cleanup** — every 5 minutes, the cleanup daemon checks each active worktree's PR status via `gh pr view`. Worktrees whose PR has been merged or closed are automatically removed along with their branches.
- **Manual cleanup** — `POST /api/worktrees/cleanup` removes worktrees for jobs in terminal states (done, failed, cancelled).
- **Orphan cleanup** — directories in `data/worktrees/` not tracked in the database are removed automatically.

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

The lock registry supports **deadlock detection** — if agents form a circular wait (A waits for B, B waits for A), it detects the cycle and returns immediately so agents can release and retry. Locks have a default TTL of 10 minutes and are automatically cleaned up when an agent's job reaches a terminal state.

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
  → blocks until all jobs finish; returns { job_id, status, result_text } for each
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

Additional coordination tools:

```
report_status(message)     — update the dashboard status shown on the agent card
finish_job(result?)        — signal task completion (automated jobs only)
search_kb(query)           — search the knowledge base for past learnings
report_learnings(learnings) — report what you learned for future agents
```

A typical orchestration pattern:

1. Call `report_status` to describe what you're doing
2. `create_job` for each parallel sub-task; collect job IDs
3. Use `depends_on` to express ordering if some sub-tasks depend on others
4. `wait_for_jobs` to block until all finish
5. Read `result_text` from the results
6. Synthesize and report a final answer

## Health Monitoring

The orchestrator includes automated health monitoring that watches for problematic agents:

| Warning | Trigger |
|---------|---------|
| Stalled | No output for more than 10 minutes |
| High turns | Agent has used 80%+ of its max turns cap |
| Long running | Agent has been running for over 60 minutes |

A **stuck job watchdog** also runs every 30 seconds to detect agents whose underlying process has died but whose database status still shows running. It cleans up orphaned locks, resolves pending questions, and handles disconnected MCP sessions.

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
| `CLAUDE_BIN` | `$(which claude)` | Path to the Claude Code CLI |
| `ORCHESTRATOR_AGENT_ID` | *(set automatically)* | Agent identity; used by the lock hook |
| `ORCHESTRATOR_BRANCH` | *(set automatically)* | Assigned worktree branch; used by the branch-enforcement hook |
| `ORCHESTRATOR_API_URL` | `http://localhost:3000` | Base URL for lock verification |

## Project Structure

```
src/
  client/          React + Vite dashboard
  server/
    api/           REST endpoints (jobs, agents, locks, templates, debates, projects, batch, knowledge-base)
    db/            SQLite init, schema, query helpers
    mcp/           MCP tool server and tool implementations
    orchestrator/  AgentRunner, WorkQueueManager, FileLockRegistry, PtyManager, DebateManager,
                   HealthMonitor, StuckJobWatchdog, ModelClassifier, RetryManager, MemoryTriager
    socket/        Socket.io event broadcasting
  shared/
    types.ts       Types shared between server and client
scripts/
  check-lock-hook.mjs     Pre-tool-use hook that enforces file locks
  check-branch-hook.mjs   Pre-tool-use hook that enforces branch protection
data/
  orchestrator.db        SQLite database (auto-created on first run)
  agent-logs/            NDJSON output and stderr logs per agent
```
