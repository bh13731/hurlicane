# Verify Agent Phase — Design Spec

## Goal

Replace the static shell command verify phase with a dedicated QA agent that independently writes and runs smoke tests against the actual running application before allowing PR creation.

## Context

The current verify phase runs a user-configured shell command (e.g. `npm test`) after milestones meet the completion threshold. This is weak verification — unit tests don't catch integration issues, and the user has to know what command to run. The verify agent makes verification autonomous and meaningful: a fresh Opus agent reads the diff, boots the app, writes targeted smoke tests, runs them, and reports structured results.

## Architecture

### Phase lifecycle

Verify becomes a job-based phase like assess/review/implement. When milestones meet the completion threshold:

1. `advanceAfterImplement` detects threshold met + verify configured → calls `spawnPhaseJob(workflow, 'verify', cycle)`
2. `spawnPhaseJob` builds the verify prompt via `buildVerifyPrompt()` and inserts a job with `workflow_phase: 'verify'`
3. The verify agent runs: reads the diff, starts the app using `start_command`, writes and runs smoke tests, writes results via `write_note`
4. `onJobCompleted` handles the verify job:
   - Reads the verify result note. Pass → finalize workflow → PR. Fail → spawn implement with failure context (tagged `is_verify_retry`), up to `max_verify_retries` times.
5. If the verify job itself fails (agent crash, infrastructure), normal failed-job handling applies (retry, fallback model, block).

### Flow diagram

```
assess → review → implement → ... → threshold met
                                         ↓
                                   verify agent (Opus, 40 turns)
                                    ├── PASS → finalize → PR
                                    └── FAIL → implement (verify retry)
                                                  ↓
                                            threshold check → verify agent → ...
                                                  ↓ (retries exhausted)
                                                block (verify_failed)
```

### Verify agent prompt

`buildVerifyPrompt(workflow, cycle, inlineContext)` generates the prompt. The agent receives:

- The task description (what was being built)
- The git diff (`git diff $(git merge-base HEAD main) HEAD`) showing all changes
- The `start_command` (how to boot the app)
- The plan with checked-off milestones (via inline context)
- MCP tool access: `write_note`, `read_note`, `report_status`, plus normal filesystem/shell tools

The prompt instructs the agent to:

1. Read the diff to understand what changed
2. Start the application using the provided `start_command`
3. Write targeted smoke/integration tests that exercise the changed functionality against the running app
4. Run the tests
5. Write a structured result note to `workflow/{id}/verify-result/{cycle}` with: what was tested, what passed, what failed, suggested fixes
6. Kill the application process when done

### Verify result note format

```markdown
## Verify Result: PASS | FAIL

**Tests run:** N
**Passed:** N
**Failed:** N

### Tests
- [PASS] <test description>
- [FAIL] <test description>
  - Expected: ...
  - Actual: ...
  - Suggested fix: ...

### Summary
<1-2 sentence summary of findings>
```

### Failure feedback to implementer

On verify fail, the result note content is loaded into `InlineWorkflowContext.verifyFailure` (adapting the existing field from a JSON blob of command output to the agent's structured note content). `renderVerifyFailure()` is updated to render the agent's findings in the implement prompt so the implementer knows exactly what to fix.

## Schema changes

### `workflows` table

- Rename `verify_command` column to `start_command` (migration: `ALTER TABLE workflows RENAME COLUMN verify_command TO start_command`)
- `max_verify_retries` stays as-is (default 2)

### `verify_runs` table

Stays as-is. The `command` field will store `"verify-agent"` instead of a shell command. `stdout`/`stderr` fields store the agent's result note content. `exit_code` is 0 for pass, 1 for fail (derived from the result note).

### `Workflow` type

- `verify_command: string | null` → `start_command: string | null`

### `CreateTaskRequest` / `CreateWorkflowRequest`

- `verifyCommand?: string` → `startCommand?: string`

## Verify agent configuration

- **Model:** `claude-opus-4-6` (hardcoded default — this is the final quality gate)
- **Turns:** 40 (hardcoded)
- **Stop mode:** `turns`
- **Work dir:** worktree path (same as implement)

## Changes to `spawnPhaseJob`

Add `case 'verify'` to the switch in `spawnPhaseJob`:

```typescript
case 'verify':
  model = 'claude-opus-4-6';
  stopMode = 'turns';
  stopValue = 40;
  prompt = buildVerifyPrompt(workflow, cycle, inlineContext);
  break;
```

## Changes to `onJobCompleted`

Add `case 'verify'` handler (replacing the current `console.warn` for unexpected verify completions):

- Read `workflow/{id}/verify-result/{cycle}` note
- Parse pass/fail from the note content (look for `## Verify Result: PASS` vs `FAIL`)
- If pass: `updateAndEmit` status complete, call `finalizeWorkflow`
- If fail: persist failure to `verify-failure/{cycle}` note, spawn implement with `is_verify_retry` if retries remain, else block
- Persist a `verify_runs` record for dashboard visibility

## Changes to `scheduleVerifyPhase`

This function is removed entirely. Its responsibilities move to `spawnPhaseJob` (spawning) and `onJobCompleted` (result handling), which is cleaner since verify is now a normal job-based phase.

## Callers of `scheduleVerifyPhase` that need updating

- `advanceAfterImplement` — replace `scheduleVerifyPhase(...)` with `spawnPhaseJob(updated, 'verify', cycle)`
- Review-phase completion path — same replacement
- `reconcileRunningWorkflows` — remove the special `current_phase === 'verify'` block; verify jobs are now normal jobs, so the generic reconciliation handles them
- `resumeWorkflow` — remove the special `phase === 'verify'` block; verify resumes via the normal `spawnPhaseJob` path

## UI changes

### TaskForm

- Checkbox label stays "Verify before PR"
- Rename the command input to "Start command" with placeholder `e.g. npm run dev, docker compose up`
- Default value changes from `npm test` to `npm run dev`
- Helper text: "Command to start the app for smoke testing. The verify agent will write and run tests against it."

### WorkflowDetailModal

- Verify tab stays. `verify_runs` data still displayed. The `command` column will show `verify-agent` instead of a shell command.

### WorkflowSummaryCard

- No changes — verify pill already exists.

## Files deleted

- `src/server/orchestrator/VerifyRunner.ts` — no longer needed
- `src/test/verify-runner.test.ts` — tests for the removed runner

## Files modified

- `src/server/orchestrator/WorkflowManager.ts` — remove `scheduleVerifyPhase`, add verify case to `onJobCompleted` and `spawnPhaseJob`, simplify reconciliation and resume
- `src/server/orchestrator/WorkflowPrompts.ts` — add `buildVerifyPrompt()`, update `renderVerifyFailure()` for agent note format, update `InlineWorkflowContext.verifyFailure` type
- `src/shared/types.ts` — rename `verify_command` → `start_command` on `Workflow`, `CreateTaskRequest`, `CreateWorkflowRequest`
- `src/shared/taskNormalization.ts` — rename `verifyCommand` → `startCommand`
- `src/server/db/database.ts` — migration to rename column
- `src/server/db/workflowQueries.ts` — update column references
- `src/server/api/validation.ts` — rename field in Zod schema
- `src/server/mcp/tools/createTask.ts` — rename field
- `src/server/mcp/tools/createAutonomousAgentRun.ts` — rename field
- `src/server/orchestrator/AutonomousAgentRunManager.ts` — rename field
- `src/client/components/TaskForm.tsx` — rename field, update labels/placeholder
- `src/test/verify-lifecycle.test.ts` — rewrite for agent-based verify
- `src/test/verify-prompt.test.ts` — update for new prompt and render functions

## What stays the same

- `verify_runs` table structure
- `max_verify_retries` behavior and retry loop
- `is_verify_retry` context tagging on implement retry jobs
- Zero-progress bypass for verify-retry implements
- Dashboard verify tab and phase pill
- `WorkflowPhase = 'verify'` type
- `OPERATIONAL_BLOCK_SUBSTRINGS` includes `verify_failed`
- Worktree safety checks before spawning
