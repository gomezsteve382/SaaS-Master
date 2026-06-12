# Part 21 — Goatmez Agent OS v6: Autonomous Platform Layer

## What changed

v6 turns the command center into a more serious autonomous platform foundation.

### 1. Database adapter system

The runtime now stores state through a database adapter interface.

Included adapters:

- `json` — persistent local JSON database at `.goatmez/database.json`
- `memory` — disposable in-memory database for clean demos/tests

This prepares the app for future SQLite/Postgres drivers without changing the mission runtime, approval queue, scheduler, memory store, or dashboard API.

### 2. Dashboard access protection

The dashboard can now be protected with `GOATMEZ_DASHBOARD_TOKEN`.

Supported API auth methods:

- `x-goatmez-token`
- `Authorization: Bearer <token>`
- `?token=<token>` for simple local testing

The browser dashboard includes an unlock panel and stores the token in local browser storage.

### 3. Custom agent profiles

The system now loads custom agents from `config/agents.json` when present.

Each agent can define:

- id
- name
- mission
- model
- permission mode
- enabled tools
- memory scopes
- max planning steps

This moves Goatmez Agent OS closer to a real multi-agent command center where each agent has its own operating rules.

### 4. Scheduled missions

v6 adds interval-based scheduled missions that run through the same runtime as manual missions.

Scheduled missions include:

- title
- agent id
- mission prompt
- interval minutes
- next run time
- last run result
- last error
- enabled/disabled state

The dashboard can now:

- create scheduled missions
- show active schedules
- run a schedule immediately
- delete a schedule

### 5. Dashboard improvements

The dashboard now displays:

- database driver
- scheduler status
- schedule count
- schedule cards
- auth status
- schedule create form

## New files

```txt
src/storage/databaseAdapter.ts
src/storage/jsonDatabaseAdapter.ts
src/storage/memoryDatabaseAdapter.ts
src/storage/createDatabaseAdapter.ts
src/agents/loadAgents.ts
src/core/scheduleEngine.ts
docs/V6_BUILD_NOTES.md
```

## New API routes

```txt
GET    /api/auth/status
GET    /api/schedules
POST   /api/schedules
POST   /api/schedules/:id/run-now
DELETE /api/schedules/:id
```

## Validation performed

```bash
npm install --ignore-scripts
npm run typecheck -- --pretty false
GOATMEZ_DB_DRIVER=memory npm run dev -- "inspect this workspace"
GOATMEZ_DB_DRIVER=memory GOATMEZ_DASHBOARD_PORT=8791 GOATMEZ_DASHBOARD_TOKEN=secret npm run dashboard
curl http://localhost:8791/api/auth/status
curl -H 'x-goatmez-token: secret' http://localhost:8791/api/health
curl -H 'x-goatmez-token: secret' -H 'content-type: application/json' -X POST http://localhost:8791/api/schedules -d '{"agentId":"operator","title":"Test schedule","message":"inspect this workspace","intervalMinutes":60}'
curl -H 'x-goatmez-token: secret' http://localhost:8791/api/schedules
```

## Next platform layer

Recommended v7 build:

- workflow templates
- reusable playbooks
- mission chains
- agent-to-agent delegation
- connector credentials vault
- audit export
- dashboard mission detail drawer
