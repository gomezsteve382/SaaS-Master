# Goatmez Agent OS Complete Handoff

This bundle contains the current working project, build notes, architecture docs, and Codex-ready instructions for continuing development.

## What to use first
Use the `/repo` folder as the working codebase.

The latest packaged release is also included here:

`/releases/goatmez-agent-os-v13.zip`

## Quick start

```bash
cd repo
npm install --ignore-scripts
npm run typecheck -- --pretty false
GOATMEZ_PLANNER_PROVIDER=rule GOATMEZ_DB_DRIVER=memory npm run dev -- "inspect this workspace"
GOATMEZ_DB_DRIVER=memory GOATMEZ_DASHBOARD_PORT=8796 npm run dashboard
```

Then open the dashboard at:

```text
http://localhost:8796
```

## Important environment variables

```bash
GOATMEZ_PLANNER_PROVIDER=rule
GOATMEZ_DB_DRIVER=memory
GOATMEZ_DASHBOARD_PORT=8796
GOATMEZ_VAULT_KEY=local-dev-master-key-123456
OPENAI_API_KEY=your_key_here
```

## Suggested next mission
Build v14: Semantic Embeddings + Vector Adapter System.

Use `/docs/codex/CODEX_MISSION_V14.md` as the first mission prompt.
