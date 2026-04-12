# Verify Agent Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static shell command verify phase with a dedicated QA agent (Claude Opus, 40 turns) that independently writes and runs smoke tests against the running application before PR creation.

**Architecture:** The verify phase becomes a normal job-based phase (like assess/review/implement). `scheduleVerifyPhase` and `VerifyRunner.ts` are deleted. A new `buildVerifyPrompt()` generates the verify agent's instructions. `spawnPhaseJob` gains a `'verify'` case, and `onJobCompleted` gains a `'verify'` handler that reads the agent's result note to determine pass/fail. The `verify_command` column is renamed to `start_command` throughout.

**Tech Stack:** TypeScript, SQLite, Vitest

---

### Task 1: Rename verify_command to start_command in types and shared code

**Files:**
- Modify: `src/shared/types.ts:134,578,641`
- Modify: `src/shared/taskNormalization.ts:130-131,302-303`

- [ ] **Step 1: Rename in Workflow interface**

In `src/shared/types.ts`, change the `Workflow` interface field:

```typescript
// line 134 -- change:
  verify_command: string | null;
// to:
  start_command: string | null;
```

- [ ] **Step 2: Rename in CreateWorkflowRequest**

In `src/shared/types.ts`, change:

```typescript
// line 578 -- change:
  verifyCommand?: string;
// to:
  startCommand?: string;
```

- [ ] **Step 3: Rename in CreateTaskRequest**

In `src/shared/types.ts`, change:

```typescript
// line 641 -- change:
  verifyCommand?: string;               // shell command to run before PR creation (at completion threshold)
// to:
  startCommand?: string;                // command to start the app for smoke testing (e.g. npm run dev)
```

- [ ] **Step 4: Rename in taskNormalization.ts validation**

In `src/shared/taskNormalization.ts`, change:

```typescript
// line 130-131 -- change:
    if (req.verifyCommand !== undefined) {
      return 'verifyCommand is a workflow-only field and cannot be used on job-routed tasks (iterations = 1)';
// to:
    if (req.startCommand !== undefined) {
      return 'startCommand is a workflow-only field and cannot be used on job-routed tasks (iterations = 1)';
```

- [ ] **Step 5: Rename in taskNormalization.ts workflow conversion**

In `src/shared/taskNormalization.ts`, change:

```typescript
// line 302-303 -- change:
    verifyCommand: req.verifyCommand,
    maxVerifyRetries: req.maxVerifyRetries,
// to:
    startCommand: req.startCommand,
    maxVerifyRetries: req.maxVerifyRetries,
```

- [ ] **Step 6: Verify TypeScript reports expected errors**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: Errors in files that still reference the old names (WorkflowManager, validation, MCP tools, etc.) -- confirms the rename propagated.

- [ ] **Step 7: Commit**

```bash
git add src/shared/types.ts src/shared/taskNormalization.ts
git commit -m "refactor: rename verify_command to start_command in shared types"
```

---

### Task 2: Rename in server-side code (DB, API, MCP, manager)

**Files:**
- Modify: `src/server/db/database.ts:488-489`
- Modify: `src/server/db/workflowQueries.ts:90,106`
- Modify: `src/server/api/validation.ts:55`
- Modify: `src/server/mcp/tools/createTask.ts:48`
- Modify: `src/server/mcp/tools/createAutonomousAgentRun.ts:24`
- Modify: `src/server/orchestrator/AutonomousAgentRunManager.ts:61`

- [ ] **Step 1: Add migration in database.ts**

In `src/server/db/database.ts`, after the existing `verify_command` migration (line 488-489), add a rename migration:

```typescript
  // Rename verify_command -> start_command (verify is now agent-driven, this field
  // tells the verify agent how to start the app for smoke testing)
  if (workflowCols.includes('verify_command') && !workflowCols.includes('start_command')) {
    db.exec('ALTER TABLE workflows RENAME COLUMN verify_command TO start_command');
  }
```

- [ ] **Step 2: Update workflowQueries.ts**

In `src/server/db/workflowQueries.ts`, rename all `verify_command` references to `start_command` in the `insertWorkflow` SQL and parameter list (line 90 column list and line 106 value reference).

- [ ] **Step 3: Update validation.ts**

In `src/server/api/validation.ts`, change:

```typescript
// line 55 -- change:
  verifyCommand: z.string().max(10_000).optional(),
// to:
  startCommand: z.string().max(10_000).optional(),
```

- [ ] **Step 4: Update MCP createTask tool**

In `src/server/mcp/tools/createTask.ts`, change the field name and description:

```typescript
  startCommand: z.string().optional().describe('Command to start the app for smoke testing before PR creation (workflow only). e.g. npm run dev, docker compose up.'),
```

Also update the pass-through (around line 103) from `verifyCommand: input.verifyCommand` to `startCommand: input.startCommand`.

- [ ] **Step 5: Update MCP createAutonomousAgentRun tool**

In `src/server/mcp/tools/createAutonomousAgentRun.ts`, change:

```typescript
  startCommand: z.string().optional().describe('Command to start the app for smoke testing before PR creation. e.g. npm run dev, docker compose up. NULL = skip verify.'),
```

- [ ] **Step 6: Update AutonomousAgentRunManager.ts**

In `src/server/orchestrator/AutonomousAgentRunManager.ts`, change:

```typescript
// line 61 -- change:
    verify_command: body.verifyCommand?.trim() || null,
// to:
    start_command: body.startCommand?.trim() || null,
```

- [ ] **Step 7: Verify TypeScript compiles (remaining errors only in WorkflowManager.ts and client)**

Run: `npx tsc --noEmit 2>&1 | head -30`

- [ ] **Step 8: Commit**

```bash
git add src/server/db/database.ts src/server/db/workflowQueries.ts src/server/api/validation.ts src/server/mcp/tools/createTask.ts src/server/mcp/tools/createAutonomousAgentRun.ts src/server/orchestrator/AutonomousAgentRunManager.ts
git commit -m "refactor: rename verify_command to start_command in server code"
```

---

### Task 3: Add buildVerifyPrompt and update WorkflowPrompts.ts

**Files:**
- Modify: `src/server/orchestrator/WorkflowPrompts.ts`

- [ ] **Step 1: Update InlineWorkflowContext.verifyFailure type**

Change the `verifyFailure` field from the old JSON-command format to a string (the agent's result note content):

```typescript
  /** Latest verify agent failure note for the current cycle -- present when this is a verify retry. */
  verifyFailure?: string | null;
```

- [ ] **Step 2: Update renderVerifyFailure for agent note format**

Replace the existing `renderVerifyFailure` function:

```typescript
/** Render a "Verification Failed" block for inclusion in the implement prompt. */
export function renderVerifyFailure(failure: InlineWorkflowContext['verifyFailure']): string {
  if (!failure) return '';
  const truncated = failure.length > VERIFY_OUTPUT_MAX_CHARS
    ? failure.slice(0, VERIFY_OUTPUT_MAX_CHARS) + '\n... (truncated)'
    : failure;
  return `\n\n## Verification Failed\n\nA QA agent tested your implementation against the running application and found issues. Fix the problems described below.\n\n${truncated}`;
}
```

- [ ] **Step 3: Add buildVerifyPrompt function**

Add after `buildImplementPrompt`. The full function body is in the spec at `docs/superpowers/specs/2026-04-12-verify-agent-design.md` under "Verify agent prompt". Key elements:

- Receives `workflow`, `cycle`, `inlineContext`
- References `workflow.start_command` (falls back to `'npm run dev'`)
- Tells the agent to: read the diff, start the app, write smoke tests, run them, write a structured result note
- Result note key: `workflow/{id}/verify-result/{cycle}`
- Result note must start with `## Verify Result: PASS` or `## Verify Result: FAIL`
- Includes inline context (plan, worklogs) via `renderInlineContext`
- Warns about branch if worktree is active

- [ ] **Step 4: Export buildVerifyPrompt**

Ensure it's exported from the module so WorkflowManager can import it.

- [ ] **Step 5: Verify TypeScript compiles for this file**

Run: `npx tsc --noEmit 2>&1 | grep WorkflowPrompts`
Expected: No errors in WorkflowPrompts.ts

- [ ] **Step 6: Commit**

```bash
git add src/server/orchestrator/WorkflowPrompts.ts
git commit -m "feat: add buildVerifyPrompt and update verify failure rendering for agent output"
```

---

### Task 4: Replace scheduleVerifyPhase with job-based verify in WorkflowManager.ts

**Files:**
- Modify: `src/server/orchestrator/WorkflowManager.ts`
- Delete: `src/server/orchestrator/VerifyRunner.ts`

- [ ] **Step 1: Update imports**

Remove `import { runVerification } from './VerifyRunner.js';` and add `buildVerifyPrompt` to the WorkflowPrompts import. Remove the `VerifyRun` type from the types import if it's no longer needed directly (check -- it may still be needed for insertVerifyRun).

- [ ] **Step 2: Add verify case to _onJobCompleted switch**

Replace the existing `case 'verify'` (which just warns) with a full handler that:
- Reads `workflow/{id}/verify-result/{cycle}` note
- Checks if it contains `## Verify Result: PASS`
- Inserts a `verify_runs` record (command: `'verify-agent'`, exit_code: 0 or 1, stdout: note content)
- On pass: mark complete, call `finalizeWorkflow`
- On fail: persist failure note to `verify-failure/{cycle}`, spawn implement via `spawnPhaseJob` if retries remain, else block with `verify_failed`

- [ ] **Step 3: Add verify case to spawnPhaseJob switch**

```typescript
    case 'verify':
      model = 'claude-opus-4-6';
      stopMode = 'turns';
      stopValue = 40;
      prompt = buildVerifyPrompt(workflow, cycle, inlineContext);
      break;
```

Update the inlineContext loading line to include verify:

```typescript
  const inlineContext = (phase === 'review' || phase === 'implement' || phase === 'verify')
    ? preReadWorkflowContext(workflow.id, { cycle }) : undefined;
```

- [ ] **Step 4: Replace scheduleVerifyPhase calls in advanceAfterImplement**

Change `if (updated.verify_command)` to `if (updated.start_command)` and replace the `scheduleVerifyPhase(...)` call with `spawnPhaseJob(updated, 'verify', updated.current_cycle)`.

- [ ] **Step 5: Replace scheduleVerifyPhase calls in review completion path**

Same pattern: change `updated.verify_command` to `updated.start_command`, replace `scheduleVerifyPhase` with `spawnPhaseJob`. Remove the `lastImplementJob` lookup and error handling -- `spawnPhaseJob` handles everything.

- [ ] **Step 6: Delete scheduleVerifyPhase function entirely**

Remove the whole function (~150 lines).

- [ ] **Step 7: Simplify reconcileRunningWorkflows**

Delete the special `if (workflow.current_phase === 'verify')` block. Verify jobs are now normal jobs, so the generic reconciliation handles them.

- [ ] **Step 8: Simplify resumeWorkflow**

Remove the special `if (phase === 'verify')` block. Add verify to the switch:

```typescript
    case 'verify':
      model = 'claude-opus-4-6';
      stopMode = 'turns'; stopValue = 40;
      prompt = buildVerifyPrompt(updated, cycle, inlineContext);
      break;
```

Update inlineContext loading to include verify.

- [ ] **Step 9: Update preReadWorkflowContext verify failure loading**

Change from JSON parsing to reading the note value directly as a string:

```typescript
  let verifyFailure: InlineWorkflowContext['verifyFailure'] = null;
  const cycle = opts.cycle ?? workflow?.current_cycle;
  if (cycle !== undefined && cycle > 0) {
    const failureNote = queries.getNote(`workflow/${workflowId}/verify-failure/${cycle}`);
    if (failureNote?.value) {
      verifyFailure = failureNote.value;
    }
  }
```

- [ ] **Step 10: Update handleZeroProgressAndAdvance**

Replace the `is_verify_retry` job context check with verify_runs-based detection:

```typescript
  // If this cycle has failed verify runs, this implement was spawned to fix verify failures.
  // Skip zero-progress detection.
  const verifyRuns = queries.getVerifyRunsForCycle(workflow.id, updated.current_cycle);
  if (verifyRuns.some(r => r.exit_code !== 0)) {
    const nextCycle = updated.current_cycle + 1;
    updateAndEmit(workflow.id, { current_cycle: nextCycle });
    spawnPhaseJob(queries.getWorkflowById(workflow.id)!, 'review', nextCycle);
    return;
  }
```

- [ ] **Step 11: Delete VerifyRunner.ts**

```bash
rm src/server/orchestrator/VerifyRunner.ts
```

- [ ] **Step 12: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: No errors (or only client/test errors)

- [ ] **Step 13: Commit**

```bash
git add src/server/orchestrator/WorkflowManager.ts
git rm src/server/orchestrator/VerifyRunner.ts
git commit -m "feat: replace shell-command verify with job-based verify agent phase"
```

---

### Task 5: Update TaskForm UI

**Files:**
- Modify: `src/client/components/TaskForm.tsx`
- Modify: `src/client/components/WorkflowDetailModal.tsx`

- [ ] **Step 1: Rename state and field references in TaskForm**

Change `verifyCommand`/`setVerifyCommand` to `startCommand`/`setStartCommand`. Change default from `'npm test'` to `'npm run dev'`. Update `req.verifyCommand` to `req.startCommand`.

- [ ] **Step 2: Update UI labels**

Change input placeholder to `e.g. npm run dev, docker compose up`. Change helper text to `Command to start the app. A QA agent will write and run smoke tests against it.`

- [ ] **Step 3: Update WorkflowDetailModal**

Change `workflow.verify_command` references to `workflow.start_command`.

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | head -10`
Expected: Clean

- [ ] **Step 5: Commit**

```bash
git add src/client/components/TaskForm.tsx src/client/components/WorkflowDetailModal.tsx
git commit -m "feat: update UI -- rename verify command to start command"
```

---

### Task 6: Update tests

**Files:**
- Modify: `src/test/verify-lifecycle.test.ts`
- Modify: `src/test/verify-prompt.test.ts`
- Delete: `src/test/verify-runner.test.ts`

- [ ] **Step 1: Delete verify-runner tests**

```bash
git rm src/test/verify-runner.test.ts
```

- [ ] **Step 2: Rewrite verify-lifecycle tests**

Remove `VerifyRunner` mock. Tests now:
- Create verify jobs (not mock `runVerification`)
- Write `verify-result/{cycle}` notes to simulate agent output
- Call `onJobCompleted` on the verify job
- Assert workflow state based on note content (PASS/FAIL)
- Use `start_command` instead of `verify_command`

6 test cases:
1. No-verify regression (no start_command)
2. Threshold not met (start_command present but threshold false)
3. Verify pass: verify job done + PASS note -> complete + finalize
4. Verify fail + retry: verify job done + FAIL note -> new implement job
5. Verify fail exhausted: pre-insert failed verify_runs -> blocked
6. Verify-retry bypass: implement in cycle with failed verify_runs skips zero-progress

- [ ] **Step 3: Update verify-prompt tests**

- Update `renderVerifyFailure` tests to pass strings instead of objects
- Add `buildVerifyPrompt` test: verify it includes start_command, task, diff instructions
- Update `makeWorkflow` to use `start_command` instead of `verify_command`
- Update taskNormalization tests: `verifyCommand` -> `startCommand`

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run 2>&1 | tail -15`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git rm src/test/verify-runner.test.ts
git add src/test/verify-lifecycle.test.ts src/test/verify-prompt.test.ts
git commit -m "test: rewrite verify tests for agent-based verify phase"
```

---

### Task 7: Final verification

- [ ] **Step 1: Full TypeScript check**

Run: `npx tsc --noEmit`
Expected: Clean

- [ ] **Step 2: Full test suite**

Run: `npx vitest run 2>&1 | tail -15`
Expected: All pass

- [ ] **Step 3: Build**

Run: `npm run build 2>&1 | tail -10`
Expected: Build succeeds

- [ ] **Step 4: Grep for stale references**

Run: `grep -rn 'verify_command\|verifyCommand\|VerifyRunner\|runVerification' src/ --include='*.ts' --include='*.tsx' | grep -v node_modules`
Expected: No stale references outside test comments

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: clean up stale verify_command references"
```
