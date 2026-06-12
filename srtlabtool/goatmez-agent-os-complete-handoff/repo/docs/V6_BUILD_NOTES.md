# Part 21 — Goatmez Agent OS v6: Adapters, Auth, Agent Profiles, and Scheduler

## Core upgrades

### 1. Database adapter layer

The local persistence layer now runs through a driver interface instead of being hard-wired to one JSON file implementation.

Included drivers:

- `json` — durable local `.goatmez/database.json` persistence.
- `memory` — disposable in-memory persistence for tests and clean demos.

This gives the platform a clean path to SQLite/Postgres later without rewriting the runtime stores.

### 2. Dashboard token protection

The dashboard API can now be protected with `GOATMEZ_DASHBOARD_TOKEN`.

When the token is configured:

- browser UI prompts for access,
- API calls require `x-goatmez-token` or `Authorization: Bearer`,
- `/api/auth/status` remains available for the UI.

### 3. Custom agent profile loading

Agent profiles can now be loaded from `config/agents.json`.

Each profile controls:

- agent id/name,
- mission,
- permission mode,
- enabled tools,
- memory scopes,
- max planning steps,
- default model.

### 4. Scheduled missions

Added persistent scheduled missions with:

- interval minutes,
- next run time,
- last run result/error,
- manual run-now endpoint,
- dashboard schedule panel.

The scheduler runs inside the dashboard/server process and uses the same runtime, permissions, memory, and mission history as manual runs.

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

## Validation checklist

```bash
npm install --ignore-scripts
npm run typecheck -- --pretty false
npm run dev -- "inspect this workspace"
GOATMEZ_DB_DRIVER=memory npm run dev -- "inspect this workspace"
GOATMEZ_DASHBOARD_PORT=8791 npm run dashboard
```
