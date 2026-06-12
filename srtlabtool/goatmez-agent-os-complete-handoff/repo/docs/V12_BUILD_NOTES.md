# Goatmez Agent OS v12 - Local LLM + Developer Agent Runtime

## What changed

v12 turns the platform into a local-first AI software builder.

### Local-first model routing

The runtime now supports three planner modes:

1. `GOATMEZ_PLANNER_PROVIDER=local` - use any OpenAI-compatible local model server.
2. `GOATMEZ_PLANNER_PROVIDER=openai` - use the Responses planner as an optional cloud fallback.
3. `GOATMEZ_PLANNER_PROVIDER=rule` - deterministic fallback with no model endpoint.
4. `GOATMEZ_PLANNER_PROVIDER=auto` - local endpoint first, cloud fallback second, rules last.

Supported local server patterns:

- Ollama: `GOATMEZ_LLM_BASE_URL=http://localhost:11434/v1`
- LM Studio: `GOATMEZ_LLM_BASE_URL=http://localhost:1234/v1`
- vLLM: `GOATMEZ_LLM_BASE_URL=http://localhost:8000/v1`

### Developer Agent

New built-in agent:

- `developer`

Mission:

- plan software
- scan repos
- search code
- read files
- write files with approval
- patch files with approval
- scaffold starter projects with approval
- run shell commands with approval
- use MCP tools when configured

### New tools

- `repo.scan` - scan workspace tree and detect stack
- `code.search` - search code/text files
- `file.patch` - exact-text patching with approval
- `project.scaffold` - create starter projects with approval

### Dashboard additions

- Model Brain panel
- Developer Agent quick commands
- `/api/models/status` route

## Local model quick start

```bash
cp .env.example .env
# edit GOATMEZ_LLM_BASE_URL and GOATMEZ_LOCAL_MODEL
npm install
npm run dev -- --agent developer "scan repo"
npm run dashboard
```

## Examples

```bash
GOATMEZ_PLANNER_PROVIDER=rule npm run dev -- --agent developer "scan repo"
GOATMEZ_PLANNER_PROVIDER=rule npm run dev -- --agent developer "search code for 'ConnectorExecutionHub'"
GOATMEZ_PLANNER_PROVIDER=rule npm run dev -- --agent developer "scaffold a FastAPI API project named client-api"
GOATMEZ_PLANNER_PROVIDER=rule npm run dev -- --agent developer --approve-all "scaffold a FastAPI API project named client-api"
```

## Safety model

The developer agent can read and reason automatically. Anything that writes, patches, scaffolds, runs shell commands, or touches connectors is approval-gated unless `--approve-all` is explicitly used.
