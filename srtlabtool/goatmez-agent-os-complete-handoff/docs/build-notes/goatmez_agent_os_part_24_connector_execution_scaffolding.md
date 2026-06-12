# Goatmez Agent OS Part 24 — Connector Execution Scaffolding

## Objective

v9 upgrades the platform from connector readiness into connector execution infrastructure. The goal is to let agents prepare, approve, and eventually execute real connector actions while keeping secrets protected and connector access controlled by agent profile.

## What was added

### 1. Connector Execution Hub

New file:

- `src/connectors/connectorExecutor.ts`

Responsibilities:

- Run connector health checks.
- Enforce connector readiness.
- Enforce per-agent connector allowlists.
- Build vault-backed HTTP requests.
- Redact headers and credentials from returned output.
- Support dry-run mode by default.
- Support live execution only when `dryRun=false` is explicitly passed.

### 2. Connector Registry Access Layer

Updated file:

- `src/connectors/connectorRegistry.ts`

New capabilities:

- `enabled()`
- `require(id)`
- `decideAccess(connectorId, agentId)`
- `metadataString(id, key, fallback)`
- `metadataObject(id, key)`

This turns connector profiles into policy-aware resources, not just config records.

### 3. Connector Tool Namespace

New file:

- `src/tools/connectorTools.ts`

New tools:

- `connector.list`
- `connector.health`
- `connector.http.request`
- `connector.openai.responses`
- `connector.ghl.search_contacts`
- `connector.gmail.create_draft_payload`
- `connector.calendar.create_event_payload`
- `connector.stripe.webhook_payload`

### 4. Dashboard Connector Execution Lab

Updated files:

- `src/server/static/dashboard.html`
- `src/server/static/app.js`

New dashboard panels:

- Connector Health
- Connector Execution Lab

The execution lab prepares dry-run requests and shows the exact redacted request object before live execution is ever allowed.

### 5. API Routes

Updated file:

- `src/server/apiServer.ts`

New routes:

- `GET /api/connectors/health`
- `GET /api/connectors/health?id=<connectorId>`
- `POST /api/connectors/http/dry-run`

### 6. Expanded Connector Profiles

Updated file:

- `config/connectors.example.json`

Profiles now include:

- OpenAI API
- GoHighLevel
- Gmail
- Google Calendar
- Stripe/Webhooks
- Filesystem MCP

Each profile supports required secrets, allowed agents, risk level, and metadata for future execution.

## Security model

v9 keeps the platform conservative:

- Connector status checks are low-risk and automatic.
- Connector actions are approval-gated.
- Secrets resolve only from the encrypted vault.
- Credentials are redacted from dashboard, logs, and tool output.
- Agent profiles must be allowed on the connector profile.
- Dry-run is the default for connector HTTP calls.

## Validation

The following commands passed:

```bash
npm install --ignore-scripts
npm run typecheck -- --pretty false
GOATMEZ_VAULT_KEY=local-dev-master-key-123456 npm run dev -- "check connector health"
GOATMEZ_VAULT_KEY=local-dev-master-key-123456 GOATMEZ_DASHBOARD_PORT=8794 npm run dashboard
curl http://localhost:8794/api/health
curl http://localhost:8794/api/connectors/health
```

## Next layer

v10 should add OAuth-ready connector flows and dedicated provider adapters:

- Google OAuth token refresh service.
- Gmail draft/create/send tools.
- Google Calendar event create/update tools.
- GHL contact/workflow tools.
- Stripe customer/payment/event tools.
- Connector action history with replay-safe IDs.
