# Agent OS Extraction Part 18 — Dashboard / Operator Console Build

## Objective

Move Goatmez Agent OS from CLI-only operation into a local command center. The dashboard layer gives Steven an operator-grade view of missions, tools, approvals, MCP servers, tasks, and event logs.

## Original build boundary

This is original Goatmez Agent OS code and architecture. The build converts the agent capability pattern into a fresh implementation:

- Runtime owns execution.
- Planner proposes actions.
- Permission gateway controls authority.
- Approval store records blocked high-risk tool calls.
- Dashboard exposes operator visibility and review.

## New v3 architecture

```txt
Browser Dashboard
  -> Local HTTP API Server
      -> createSystem()
          -> Agent Runtime
          -> Tool Registry
          -> Permission Gateway
          -> Approval Store
          -> Task Engine
          -> Event Ledger
          -> MCP Connector Mesh
```

## New files

```txt
src/app/createSystem.ts
src/core/approvalStore.ts
src/server/apiServer.ts
src/server/static/dashboard.html
src/server/static/styles.css
src/server/static/app.js
```

## API routes

```txt
GET  /api/health
GET  /api/agents
GET  /api/tools?agent=operator
GET  /api/tasks
GET  /api/events?limit=100
GET  /api/approvals
GET  /api/mcp
POST /api/run
POST /api/approvals/:id/approve
POST /api/approvals/:id/reject
```

## Dashboard panels

### 1. Mission launcher

Controls:

- agent selector,
- mission text,
- dry-run toggle,
- approve-all development toggle,
- response output.

### 2. Approval queue

Shows:

- pending tool name,
- risk reason,
- requested input,
- agent ID,
- approve/reject buttons.

Current behavior marks approval decisions. True replay execution is the next module.

### 3. Tasks

Shows active and completed in-memory task records.

### 4. Tools

Shows available tool descriptors for the selected agent:

- name,
- description,
- risk level,
- whether approval is required.

### 5. MCP servers

Shows configured MCP servers and whether they are enabled.

### 6. Event ledger

Reads `.goatmez/events.jsonl` and displays newest events first.

## Why this matters

Agents need an operator layer. Without a dashboard, agent systems become invisible and hard to trust. The dashboard creates operational control:

- what the agent tried,
- what it ran,
- what got blocked,
- what needs approval,
- what tools exist,
- what connectors are configured.

## Validation

The v3 build was validated with:

```bash
npm install --ignore-scripts
npm run typecheck -- --pretty false
npm run dev -- "inspect this workspace"
npm run dev -- "write hello boss to notes/test.md"
npm run dashboard
curl http://localhost:8787/api/health
curl http://localhost:8787/api/approvals
```

## Next module

Part 19 should implement true approval replay:

1. agent requests a high-risk tool,
2. runtime records approval with exact tool call,
3. operator approves from dashboard,
4. system executes that exact stored call once,
5. result is appended to event ledger,
6. replay token is burned to prevent duplicate execution.
