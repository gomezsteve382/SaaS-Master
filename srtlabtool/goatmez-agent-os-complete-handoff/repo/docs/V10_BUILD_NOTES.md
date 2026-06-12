# Goatmez Agent OS v10 — OAuth + Provider Adapter Layer

## What changed

v10 turns the connector system into a provider-adapter layer with persistent action history and OAuth-ready execution.

Added:

- Connector action history stored in `.goatmez/database.json`
- `ConnectorActionStore` for replay-safe audit records
- `OAuthTokenManager` for Google refresh-token flows
- Google access-token vault storage under connector scope
- Provider adapters for:
  - Gmail draft creation
  - Google Calendar event creation
  - Stripe account introspection
  - Google OAuth refresh dry-run/execution
- Generic connector HTTP actions are now recorded
- OpenAI Responses connector actions are now recorded
- Dashboard Connector Action History panel
- Dashboard Provider Adapter Lab
- New API routes:
  - `GET /api/connectors/actions`
  - `POST /api/connectors/oauth/google/refresh/dry-run`
  - `POST /api/connectors/gmail/draft/dry-run`
  - `POST /api/connectors/calendar/event/dry-run`

## Safety model

Provider actions default to dry-run preparation unless the tool input explicitly sets `dryRun: false` and the permission gateway/approval flow allows execution.

Secrets remain in the encrypted vault and are redacted in action records, API responses, and dashboard views.

## Google OAuth setup

Save these secrets to the vault with scope `gmail` and/or `calendar`, or save them under scope `workspace` as shared fallback credentials:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`

When an execution needs a token, the runtime can refresh and save:

- `GOOGLE_ACCESS_TOKEN`

## Validation commands

```bash
npm install --ignore-scripts
npm run typecheck -- --pretty false
GOATMEZ_DB_DRIVER=memory GOATMEZ_VAULT_KEY=local-dev-master-key-123456 npm run dev -- "check connector health"
GOATMEZ_DB_DRIVER=memory GOATMEZ_VAULT_KEY=local-dev-master-key-123456 GOATMEZ_DASHBOARD_PORT=8795 npm run dashboard
curl http://localhost:8795/api/health
curl http://localhost:8795/api/connectors/actions
```
