# Part 22 — Goatmez Agent OS v7: Workflow Playbooks and Mission Chains

## What changed

v7 adds the playbook layer: reusable multi-step workflows that chain agents together.

This is the move from “run one mission” to “run an operating procedure.”

## New modules

```txt
config/playbooks.example.json
src/core/playbookStore.ts
src/core/workflowEngine.ts
```

## New data model

Added persistent workflow run records:

```txt
workflowRuns
```

Each run stores:

- playbook id
- playbook name
- inputs
- status
- step messages
- step results
- step errors
- timestamps

## Dashboard additions

The dashboard now includes:

- Workflow Playbooks panel
- Run Playbook form
- Workflow inputs box
- Dry-run toggle
- Workflow Runs history

## New API routes

```txt
GET  /api/playbooks
GET  /api/workflows/runs
POST /api/workflows/run
```

## Template variables

Playbook step messages support:

```txt
{{previousResult}}
```

And any custom input:

```txt
{{objective}}
{{client}}
{{industry}}
{{offer}}
```

## Validation performed

```bash
npm install --ignore-scripts
npm run typecheck -- --pretty false
GOATMEZ_DB_DRIVER=memory npm run dev -- "inspect this workspace"
GOATMEZ_DB_DRIVER=memory GOATMEZ_DASHBOARD_PORT=8792 npm run dashboard
curl http://localhost:8792/api/playbooks
curl -H 'content-type: application/json' -X POST http://localhost:8792/api/workflows/run -d '{"playbookId":"workspace_audit","inputs":{"objective":"v7 validation"},"dryRun":true}'
curl http://localhost:8792/api/workflows/runs
```

## Next layer

v8 should add the credentials vault and connector hardening layer:

- encrypted local secret store
- connector credential registry
- dashboard secrets manager
- redacted event logging
- per-agent credential access rules
