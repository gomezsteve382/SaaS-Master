# Goatmez Agent OS v13

Local-first agent command center with MCP support, encrypted vault, connector scaffolding, workflow playbooks, approvals, a Developer Agent, and a local Knowledge Base/RAG layer for searchable SOPs, notes, docs, code references, and operating playbooks.


## Knowledge Base / Local RAG

v13 adds a local knowledge base stored at `.goatmez/knowledge.json`. Use it for SOPs, strategy notes, client playbooks, credit repair references, developer docs, and reusable operating knowledge.

Available tools:

```txt
kb.list
kb.read
kb.search
kb.ingestFile
kb.ingestText
```

CLI examples:

```bash
GOATMEZ_PLANNER_PROVIDER=rule npm run dev -- "ingest README.md into knowledge base"
GOATMEZ_PLANNER_PROVIDER=rule npm run dev -- "search knowledge for 'dashboard'"
GOATMEZ_PLANNER_PROVIDER=rule npm run dev -- "list knowledge base documents"
```

Dashboard routes:

```txt
GET    /api/knowledge
GET    /api/knowledge/:id
DELETE /api/knowledge/:id
POST   /api/knowledge/search
POST   /api/knowledge/text
POST   /api/knowledge/file
```

v14 search modes:

- `keyword` (default): deterministic keyword ranking.
- `vector`: semantic ranking using chunk embeddings.
- `hybrid`: blend of keyword and vector scores.

`POST /api/knowledge/search` accepts:

```json
{
  "query": "search text",
  "limit": 10,
  "mode": "keyword | vector | hybrid",
  "hybridWeight": 0.5,
  "tags": ["workspace"]
}
```

Embeddings configuration:

```bash
GOATMEZ_KB_DEFAULT_SEARCH_MODE=keyword
GOATMEZ_KB_EMBEDDINGS_PROVIDER=off   # off | mock | openai
GOATMEZ_KB_EMBEDDINGS_MODEL=text-embedding-3-small
GOATMEZ_KB_EMBEDDINGS_BASE_URL=https://api.openai.com/v1
GOATMEZ_KB_HYBRID_KEYWORD_WEIGHT=0.5
```

For `openai` embeddings mode, store `OPENAI_API_KEY` in the encrypted vault (scope `openai` or `workspace`).

## Local LLM setup

Goatmez Agent OS can use a local OpenAI-compatible model server. Set these values in `.env`:

```bash
GOATMEZ_PLANNER_PROVIDER=auto
GOATMEZ_LLM_BASE_URL=http://localhost:11434/v1
GOATMEZ_LOCAL_MODEL=llama3.1
GOATMEZ_LLM_API_KEY=local-dev-key
```

Use LM Studio with `http://localhost:1234/v1`, vLLM with `http://localhost:8000/v1`, or Ollama with `http://localhost:11434/v1`.

## Developer Agent examples

```bash
npm install
GOATMEZ_PLANNER_PROVIDER=rule npm run dev -- --agent developer "scan repo"
GOATMEZ_PLANNER_PROVIDER=rule npm run dev -- --agent developer "search code for 'ConnectorExecutionHub'"
GOATMEZ_PLANNER_PROVIDER=rule npm run dev -- --agent developer "scaffold a FastAPI API project named client-api"
GOATMEZ_PLANNER_PROVIDER=rule npm run dev -- --agent developer --approve-all "scaffold a FastAPI API project named client-api"
npm run dashboard
```

---

# Goatmez Agent OS v11

Original agent command center for building Steven's agentic operating system.

```txt
Mission / Playbook / Schedule
  -> Agent Runtime
  -> Context Compiler
  -> Planner
      -> OpenAI Responses planner when OPENAI_API_KEY exists
      -> Rule-based fallback planner when no key exists
  -> Tool Registry
  -> Permission Gateway
  -> Approval Queue
  -> Tool Execution / MCP Tool Execution
  -> Event Ledger
  -> Persistent Database Adapter
  -> Mission History
  -> Task Engine
  -> Memory Store
  -> Schedule Engine
  -> Workflow Engine
  -> Credential Vault
  -> Connector Readiness Registry
  -> Connector Setup Wizard
  -> OAuth Token Manager
  -> Provider Adapter Layer
  -> Connector Action History
  -> Idempotent Action Replay
  -> Local Dashboard
```

## What's new in v11

- Connector Setup Wizard API and dashboard panel.
- Setup-aware secret saving under connector scopes.
- GHL provider adapter for contact-search dry-runs and real execution path.
- Prepared connector actions now carry idempotency keys.
- Duplicate real connector executions are blocked by idempotency.
- Prepared connector actions can be executed from the dashboard/API.
- Connector action records support replay tracking.
- Dashboard Connector Action History now shows execute controls for prepared actions.
- Provider Adapter Lab now includes a GHL contact-search dry-run.

## Install

```bash
npm install
cp .env.example .env
cp config/mcp.servers.example.json config/mcp.servers.json
cp config/agents.example.json config/agents.json
cp config/playbooks.example.json config/playbooks.json
cp config/connectors.example.json config/connectors.json
```

## Run CLI

```bash
npm run dev -- "inspect this workspace"
npm run dev -- --dry-run "write hello boss to notes/test.md"
npm run dev -- --approve-all "write hello boss to notes/test.md"
npm run dev -- "check connector health"
```

## Run dashboard

```bash
npm run dashboard
```

Open:

```txt
http://localhost:8787
```

## Dashboard protection

Set a token in `.env`:

```bash
GOATMEZ_DASHBOARD_TOKEN="choose-a-long-local-password"
```

API calls can pass:

```bash
-H 'x-goatmez-token: choose-a-long-local-password'
```

## Vault setup

Set a local vault key:

```bash
GOATMEZ_VAULT_KEY="use-a-long-random-local-master-key"
```

Save secrets through the dashboard setup wizard, the vault panel, or the API. Store provider secrets under the connector scope when possible:

```txt
openai: OPENAI_API_KEY
ghl: GHL_API_KEY, GHL_LOCATION_ID
gmail: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
calendar: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
stripe: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
```

Workspace-scope secrets are used as fallback when connector-scoped secrets are not present.

## Connector setup API

```txt
GET  /api/setup/connectors
GET  /api/setup/connectors?id=ghl
POST /api/setup/secrets
```

Example:

```bash
curl -X POST http://localhost:8787/api/setup/secrets \
  -H 'content-type: application/json' \
  -d '{"connectorId":"ghl","name":"GHL_API_KEY","value":"paste-key-here"}'
```

## Connector action replay API

Prepared actions are created by dry-run routes. After review, execute a prepared action:

```txt
POST /api/connectors/actions/:id/execute
```

Execution creates a new real action record, marks the prepared record as replayed, and blocks duplicate real executions with idempotency keys.

## Connector/provider routes

```txt
GET  /api/connectors/actions
POST /api/connectors/actions/:id/execute
POST /api/connectors/oauth/google/refresh/dry-run
POST /api/connectors/ghl/search/dry-run
POST /api/connectors/gmail/draft/dry-run
POST /api/connectors/calendar/event/dry-run
```

## Validation

```bash
npm install --ignore-scripts
npm run typecheck -- --pretty false
npm run validate:knowledge
GOATMEZ_DB_DRIVER=memory GOATMEZ_VAULT_KEY=local-dev-master-key-123456 npm run dev -- "check connector health"
GOATMEZ_DB_DRIVER=memory GOATMEZ_VAULT_KEY=local-dev-master-key-123456 GOATMEZ_DASHBOARD_PORT=8787 npm run dashboard
```

## Folder map

```txt
src/app              System wiring
src/agents           Agent profiles
src/core             Runtime, tools, approvals, memory, tasks, database
src/connectors       Connector registry, executor, setup wizard, action replay, OAuth, provider adapters
src/security         Vault and redaction
src/tools            Built-in tools
src/server           Local dashboard API + static UI
src/planners         Dynamic + fallback planners
src/storage          Database adapters
config               Local config templates
```
