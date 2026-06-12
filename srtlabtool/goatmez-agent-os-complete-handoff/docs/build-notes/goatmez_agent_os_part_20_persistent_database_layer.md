# Goatmez Agent OS Part 20 — Persistent Database Layer

## Build result

This build upgrades Goatmez Agent OS into v5 with a persistent local data layer. The runtime now saves important operator state to disk so mission history, task records, memory records, and approvals survive restarts.

## New core files

- `src/core/localDatabase.ts`
- `src/core/missionStore.ts`

## Updated core files

- `src/core/types.ts`
- `src/core/memoryStore.ts`
- `src/core/taskEngine.ts`
- `src/core/approvalStore.ts`
- `src/core/agentRuntime.ts`
- `src/app/createSystem.ts`
- `src/server/apiServer.ts`
- `src/server/static/dashboard.html`
- `src/server/static/app.js`
- `src/server/static/styles.css`

## Persistent database

The default local database path is:

```txt
.goatmez/database.json
```

The database contains:

```txt
tasks
memories
approvals
missions
```

The file is written atomically using a temporary file and rename operation.

## Mission lifecycle

The runtime now tracks missions separately from tasks.

Mission statuses:

```txt
running
blocked
done
failed
```

New mission events:

```txt
mission.started
mission.completed
mission.failed
```

## New API routes

```txt
GET  /api/missions
GET  /api/memory
POST /api/memory
GET  /api/db
```

## Dashboard upgrades

The dashboard now includes:

- Mission History panel
- Memory panel
- Quick memory-save form
- Persistent DB timestamp in health status

## Validation commands

```bash
npm install --ignore-scripts
npm run typecheck -- --pretty false
npm run dev -- "inspect this workspace"
npm run dev -- "write hello boss to notes/test.md"
npm run dev -- --approve-all "write hello v5 to notes/v5-test.md"
GOATMEZ_DASHBOARD_PORT=8790 npm run dashboard
curl http://localhost:8790/api/health
curl http://localhost:8790/api/missions
curl http://localhost:8790/api/db
```

## Next recommended build

Part 21 should add a real database adapter layer so the same store can use:

- local JSON for development,
- SQLite for local production,
- Postgres for cloud deployment.
