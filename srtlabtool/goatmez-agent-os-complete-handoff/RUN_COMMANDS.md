# Run Commands

## Install
```bash
cd repo
npm install --ignore-scripts
```

## Typecheck
```bash
npm run typecheck -- --pretty false
```

## CLI: rule planner
```bash
GOATMEZ_PLANNER_PROVIDER=rule GOATMEZ_DB_DRIVER=memory npm run dev -- "inspect this workspace"
```

## CLI: knowledge base
```bash
GOATMEZ_PLANNER_PROVIDER=rule GOATMEZ_DB_DRIVER=memory npm run dev -- "ingest README.md into knowledge base"
GOATMEZ_PLANNER_PROVIDER=rule GOATMEZ_DB_DRIVER=memory npm run dev -- "search knowledge for dashboard"
```

## Dashboard
```bash
GOATMEZ_DB_DRIVER=memory GOATMEZ_DASHBOARD_PORT=8796 npm run dashboard
```

## Dashboard URL
```text
http://localhost:8796
```
