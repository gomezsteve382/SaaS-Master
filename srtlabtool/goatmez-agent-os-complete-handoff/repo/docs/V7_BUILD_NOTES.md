# Part 22 — Goatmez Agent OS v7: Workflow Playbooks and Mission Chains

## Core upgrade

v7 adds reusable workflow playbooks so the platform can run multi-step mission chains, not just single prompts.

## New capabilities

### 1. Playbook templates

Playbooks can be loaded from `config/playbooks.json`.

Each playbook has:

- id
- name
- description
- optional inputs
- ordered steps

Each step has:

- step id
- title
- agent id
- message template
- optional `stopOnBlocked`

### 2. Workflow engine

The new workflow engine executes each step through the same `AgentRuntime` used by normal missions.

That means every workflow step still uses:

- context compiler
- planner
- tool registry
- permission gateway
- approval queue
- mission history
- event ledger
- memory store

### 3. Template interpolation

Step messages support template variables:

```txt
{{objective}}
{{previousResult}}
```

Any input passed to the workflow can be used as `{{inputName}}`.

### 4. Persistent workflow run history

Workflow runs are saved in the database with:

- playbook id/name
- inputs
- status
- each step result
- each step error
- timestamps

### 5. Dashboard workflow controls

The dashboard now includes:

- playbook list
- playbook launcher
- workflow input box
- dry-run toggle
- workflow run history

## New files

```txt
config/playbooks.example.json
src/core/playbookStore.ts
src/core/workflowEngine.ts
docs/V7_BUILD_NOTES.md
```

## New API routes

```txt
GET  /api/playbooks
GET  /api/workflows/runs
POST /api/workflows/run
```

## Validation performed

```bash
npm install --ignore-scripts
npm run typecheck -- --pretty false
GOATMEZ_DB_DRIVER=memory npm run dev -- "inspect this workspace"
GOATMEZ_DB_DRIVER=memory GOATMEZ_DASHBOARD_PORT=8792 npm run dashboard
curl http://localhost:8792/api/health
curl http://localhost:8792/api/playbooks
curl -H 'content-type: application/json' -X POST http://localhost:8792/api/workflows/run -d '{"playbookId":"workspace_audit","inputs":{"objective":"v7 validation"},"dryRun":true}'
curl http://localhost:8792/api/workflows/runs
```

## Recommended v8 build

- connector credentials vault
- encrypted local secret store
- agent-to-agent delegation
- workflow branching conditions
- dashboard mission detail drawer
- CSV/JSON audit export
