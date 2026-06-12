# Agent OS Extraction Part 15 — Hooks, Events, Logging, Telemetry, and Observability Deep Dive

## Boundary
Clean-room architecture extraction. No proprietary implementation is copied.

---

# 1. Why This Layer Matters

Agents need nervous systems.

Hooks and events let the platform react when things happen:

- User sends a message.
- Agent starts a task.
- Tool is requested.
- Permission is approved or denied.
- File changes.
- MCP server connects.
- Cost threshold is reached.
- Task fails.
- Memory is created.
- Workflow completes.

Observability lets you answer:

- What happened?
- Why did it happen?
- How much did it cost?
- Which agent/tool caused it?
- Was user approval obtained?
- Can we replay it?

For Goatmez Agent OS, this becomes the **Operations Ledger**.

---

# 2. Observed Areas

The reference package has separate areas for:

- hook registry,
- file-change watcher,
- session hooks,
- post-sampling hooks,
- skill hooks,
- tool hooks,
- analytics services,
- cost tracking,
- health checks,
- logging,
- metrics,
- Sentry-style error reporting,
- audit logs,
- Grafana dashboards.

Clean-room takeaway: every important action should emit an event.

---

# 3. Event Bus Pattern

## 3.1 Event shape

```ts
AgentEvent
- id
- type
- timestamp
- workspace_id
- session_id
- agent_id?
- task_id?
- tool_call_id?
- actor: user | agent | system | tool
- payload
- risk_level?
- correlation_id
```

## 3.2 Event categories

| Category | Examples |
|---|---|
| session | created, resumed, ended |
| message | user_received, assistant_generated |
| model | request_started, token_streamed, request_failed |
| tool | requested, approved, executed, failed |
| permission | requested, approved, denied, expired |
| task | created, started, paused, completed, failed |
| memory | proposed, saved, deleted, rejected |
| mcp | server_connected, server_failed, tool_discovered |
| file | read, written, patched, deleted |
| cost | threshold_warning, limit_reached |
| security | suspicious_command, blocked_path, secret_redacted |

---

# 4. Hook Registry Pattern

Hooks allow custom reactions to events.

## 4.1 Hook contract

```ts
Hook
- id
- event_types[]
- priority
- enabled
- handler(event, context): HookResult
```

## 4.2 Hook examples

- When `tool.requested`, run permission classifier.
- When `file.written`, create rollback snapshot.
- When `task.completed`, send notification.
- When `memory.proposed`, ask for confirmation if sensitive.
- When `cost.threshold_warning`, downgrade model or pause.
- When `mcp.server_failed`, mark tools unavailable.

---

# 5. Pre/Post Hook Strategy

## Pre-action hooks

Run before the action:

- validate permissions,
- validate paths,
- classify command risk,
- enforce cost limits,
- check workspace trust.

## Post-action hooks

Run after the action:

- summarize tool result,
- write audit log,
- update memory,
- update task state,
- trigger notifications,
- collect metrics.

---

# 6. Logging Strategy

## 6.1 Logs you need

| Log | Purpose |
|---|---|
| app log | runtime errors and service info |
| audit log | security-sensitive actions |
| conversation log | messages and tool calls |
| tool log | command output and tool results |
| cost log | model usage and spend |
| permission log | approvals, denials, bypasses |
| MCP log | server health and tool discovery |

## 6.2 Secret redaction

All logs must pass through a scrubber that removes:

- API keys,
- bearer tokens,
- OAuth tokens,
- passwords,
- `.env` values,
- cookies,
- session secrets,
- private keys.

---

# 7. Metrics

## 7.1 Runtime metrics

Track:

- tasks completed,
- failed tool calls,
- approval rate,
- denied risky actions,
- cost per task,
- tokens per agent,
- average task duration,
- MCP uptime,
- memory retrieval hit rate.

## 7.2 Business metrics

For Steven's agent platform:

- leads scraped,
- emails drafted,
- messages sent after approval,
- disputes generated,
- SEO audits completed,
- client reports generated,
- workflows created in GHL,
- content posts generated.

---

# 8. Replay and Debugger

A serious agent OS needs replay.

Replay package:

```txt
Session Replay
- input messages
- compiled context summary
- model selection
- tool definitions available
- tool calls requested
- permission decisions
- tool results
- final outputs
- errors
```

This lets you debug failures without guessing.

---

# 9. Goatmez Agent OS Observability V1

Build first:

1. Event bus.
2. JSONL event log.
3. Hook registry.
4. Tool audit logger.
5. Permission audit logger.
6. Cost tracker.
7. Health endpoint.
8. Simple dashboard table.

Build later:

1. Grafana dashboards.
2. Session replay UI.
3. Anomaly detector.
4. Cost optimizer.
5. Client-facing reporting portal.

---

# 10. Clean-Room Event Flow

```txt
User message received
  -> event: message.user_received
  -> context compiled
  -> event: context.compiled
  -> model called
  -> event: model.request_started
  -> tool requested
  -> event: tool.requested
  -> pre-hooks run
  -> permission decision
  -> event: permission.approved/denied
  -> tool executes
  -> event: tool.executed/tool.failed
  -> post-hooks run
  -> assistant response emitted
  -> event: message.assistant_generated
```

This is the backbone of a controllable agent platform.
