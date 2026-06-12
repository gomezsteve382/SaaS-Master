# Goatmez Agent OS v9 — Connector Execution Scaffolding

## What changed

v9 turns connector readiness into executable connector infrastructure. The system can now prepare connector requests, verify local setup, enforce per-agent access, and route connector actions through the same approval and audit model as every other tool.

## New runtime pieces

- `ConnectorExecutionHub` for health checks and vault-backed HTTP execution.
- Extended `ConnectorRegistry` with access decisions and agent allowlist enforcement.
- Connector tools under the `connector.*` namespace.
- Dashboard connector execution lab.
- Connector health panel.

## New tools

- `connector.list`
- `connector.health`
- `connector.http.request`
- `connector.openai.responses`
- `connector.ghl.search_contacts`
- `connector.gmail.create_draft_payload`
- `connector.calendar.create_event_payload`
- `connector.stripe.webhook_payload`

## Safety model

Connector actions are approval-gated unless they only read local status. Secrets are resolved from the encrypted vault at execution time and redacted from logs, dashboard output, and tool observations.

## Validation commands

```bash
npm install --ignore-scripts
npm run typecheck -- --pretty false
GOATMEZ_VAULT_KEY=local-dev-master-key-123456 npm run dev -- "check connector health"
GOATMEZ_VAULT_KEY=local-dev-master-key-123456 GOATMEZ_DASHBOARD_PORT=8794 npm run dashboard
```
