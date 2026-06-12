# Goatmez Agent OS v5 — Persistent Operator Database

v5 turns the local agent runtime into a more durable command-center system.

## Added

- Local persistent database at `.goatmez/database.json`
- Persistent mission history
- Persistent task records
- Persistent memory records
- Persistent approval records
- Database snapshot endpoint: `GET /api/db`
- Mission history endpoint: `GET /api/missions`
- Memory endpoints: `GET /api/memory` and `POST /api/memory`
- Dashboard mission-history panel
- Dashboard memory panel with quick memory entry
- Runtime mission lifecycle events:
  - `mission.started`
  - `mission.completed`
  - `mission.failed`

## Why this matters

Before v5, some state lived only inside the current server process. v5 makes the command center survive restarts. Missions, approvals, tasks, and memory are now saved in a single local JSON database that can later be replaced by SQLite or Postgres without changing the rest of the architecture.

## Data model

```json
{
  "version": 1,
  "updatedAt": "ISO timestamp",
  "tasks": [],
  "memories": [],
  "approvals": [],
  "missions": []
}
```

## Run

```bash
npm install
npm run typecheck
npm run dev -- "inspect this workspace"
npm run dashboard
```

Open the dashboard at:

```text
http://localhost:8787
```
