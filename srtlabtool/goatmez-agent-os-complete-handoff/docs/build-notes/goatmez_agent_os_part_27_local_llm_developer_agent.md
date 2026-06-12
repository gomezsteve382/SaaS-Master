# Goatmez Agent OS - Part 27: Local LLM + Developer Agent Runtime

## Build objective

Turn Goatmez Agent OS into a local-first software-building agent platform with an interchangeable model brain.

## Core result

v12 can now run with:

- a local OpenAI-compatible model server
- an optional cloud fallback
- a deterministic no-model fallback
- a dedicated Developer Agent
- codebase inspection tools
- code search tools
- approval-gated patch/write/scaffold tools
- approval-gated terminal execution
- a dashboard panel showing active model routing

## Model router

New module:

- `src/models/modelRouter.ts`

It reads:

- `GOATMEZ_PLANNER_PROVIDER`
- `GOATMEZ_LLM_BASE_URL`
- `GOATMEZ_LOCAL_MODEL`
- `GOATMEZ_LLM_API_KEY`
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`

Planner modes:

- `auto`
- `local`
- `openai`
- `rule`

## Local/Open-compatible chat planner

New module:

- `src/providers/openAiCompatibleChatPlanner.ts`

It calls:

- `POST {GOATMEZ_LLM_BASE_URL}/chat/completions`

Expected planner output is strict JSON:

```json
{
  "action": "respond|call_tool|finish",
  "thought": "brief operator note",
  "message": "text for respond/finish",
  "toolName": "tool.name for call_tool",
  "input": {}
}
```

## Developer Agent

New built-in agent:

- `developer`

Enabled tools:

- `workspace.list`
- `repo.scan`
- `code.search`
- `file.read`
- `file.write`
- `file.patch`
- `project.scaffold`
- `shell.run`
- `vault.status`
- `vault.check`
- `connector.*`
- `mcp.*`

## Developer tools

New module:

- `src/tools/developerTools.ts`

Tools:

- `repo.scan`
- `code.search`
- `file.patch`
- `project.scaffold`

## Dashboard changes

New API route:

- `GET /api/models/status`

New dashboard panels:

- Model Brain
- Developer Agent Quick Commands

## Validation performed

```bash
npm install --ignore-scripts
npm run typecheck -- --pretty false
GOATMEZ_PLANNER_PROVIDER=rule GOATMEZ_DB_DRIVER=memory npm run dev -- --agent developer "scan repo"
GOATMEZ_PLANNER_PROVIDER=rule GOATMEZ_DB_DRIVER=memory npm run dev -- --agent developer "scaffold a FastAPI API project named client-api"
GOATMEZ_PLANNER_PROVIDER=rule GOATMEZ_DB_DRIVER=memory npm run dev -- --agent developer --approve-all "scaffold a FastAPI API project named client-api"
node --check src/server/static/app.js
GOATMEZ_PLANNER_PROVIDER=rule GOATMEZ_DB_DRIVER=memory GOATMEZ_DASHBOARD_PORT=19001 npm run dashboard
curl http://localhost:19001/api/health
curl http://localhost:19001/api/models/status
```

## Next build layer

v13 should add the full autonomous developer loop:

1. plan
2. scan repo
3. select files
4. patch files
5. run build/test
6. analyze errors
7. patch again
8. create changelog
9. zip artifact
10. request deployment approval
