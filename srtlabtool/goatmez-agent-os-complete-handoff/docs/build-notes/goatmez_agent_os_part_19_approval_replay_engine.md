# Goatmez Agent OS Part 19 — Approval Replay Engine

## Objective

Move the dashboard from simple approval tracking into controlled execution. The operator can now approve a stored tool request and execute the exact recorded call one time.

## Why this matters

Agents need power, but power needs a governor. The approval replay engine creates a clean chain of custody:

```txt
Agent plans risky action
  -> Runtime blocks action
  -> Approval request is recorded
  -> Operator reviews request
  -> Operator approves or rejects
  -> Approved call executes once
  -> Result is written back to approval record
  -> Event ledger records the execution
```

## New behavior in v4

- Pending approvals now show `Approve & Execute`, `Approve Only`, and `Reject`.
- Approved approvals show `Execute approved call`.
- Executed and failed approvals are closed and cannot be run again.
- Execution results are attached to the approval record.
- Dashboard displays the execution summary.
- Event ledger records success or failure.

## New files

```txt
src/core/approvalExecutor.ts
```

## Updated files

```txt
src/core/approvalStore.ts
src/server/apiServer.ts
src/server/static/app.js
src/server/static/styles.css
README.md
package.json
```

## New API route

```txt
POST /api/approvals/:id/approve-and-execute
```

This route turns a pending approval into an approved approval, executes the exact stored tool call, and closes the approval with the execution result.

## Approval record lifecycle

```txt
pending
  -> approved
      -> executing
          -> executed
          -> failed
  -> rejected
```

## Guardrails

- Tool execution still goes through `ToolRegistry.execute()`.
- The stored agent profile is loaded before execution.
- The stored tool call input is reused exactly.
- The approval must be approved before execution.
- Closed records cannot be run again.
- The event ledger receives a permanent execution event.

## Validation commands

```bash
npm install --ignore-scripts
npm run typecheck -- --pretty false
npm run dev -- "write hello boss to notes/test.md"
npm run dashboard
```

Then open:

```txt
http://localhost:8787
```

Use the dashboard to approve and execute the pending `file.write` request.

## Next module

Part 20 should add a persistent database layer so events, tasks, memory, approvals, and mission runs can survive restarts without relying only on JSONL files.
