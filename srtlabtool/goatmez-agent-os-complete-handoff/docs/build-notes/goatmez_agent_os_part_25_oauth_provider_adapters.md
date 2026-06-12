# Goatmez Agent OS — Part 25: OAuth + Provider Adapters

## Release

Built **Goatmez Agent OS v10**.

## Objective

Move the connector system from basic readiness checks into a provider-adapter layer that can safely prepare, approve, execute, and audit real external actions.

## Added systems

### 1. Connector Action History

New records are stored in the persistent database for connector activity:

- connector ID
- action name
- agent ID
- workspace/session
- dry-run flag
- redacted request
- redacted response
- status
- timestamps
- error state

This gives the dashboard an audit trail for provider calls.

### 2. OAuth Token Manager

Added a Google OAuth refresh-token manager that can:

- prepare a token refresh dry-run
- exchange a refresh token for an access token
- store the access token in the encrypted vault
- keep credential material redacted in logs and UI responses

### 3. Provider Adapter Layer

Added provider adapters for:

- Gmail draft preparation/creation
- Google Calendar event preparation/creation
- Stripe account introspection
- Google OAuth token refresh

### 4. Connector Execution Recording

Generic connector HTTP calls and OpenAI Responses connector calls now write connector action history records.

### 5. Dashboard upgrades

Added:

- Provider Adapter Lab
- Connector Action History panel
- OAuth dry-run button
- Gmail draft dry-run button
- Calendar event dry-run button

### 6. New API routes

```txt
GET  /api/connectors/actions
POST /api/connectors/oauth/google/refresh/dry-run
POST /api/connectors/gmail/draft/dry-run
POST /api/connectors/calendar/event/dry-run
```

## Validation performed

```bash
npm install --package-lock-only --ignore-scripts
npm run typecheck -- --pretty false
GOATMEZ_DB_DRIVER=memory GOATMEZ_VAULT_KEY=local-dev-master-key-123456 npm run dev -- "check connector health"
node --check src/server/static/app.js
GOATMEZ_DB_DRIVER=memory GOATMEZ_VAULT_KEY=local-dev-master-key-123456 GOATMEZ_DASHBOARD_PORT=8795 npm run dashboard
curl http://localhost:8795/api/health
curl http://localhost:8795/api/connectors/actions
```

A temporary enabled Gmail connector test was also run with dummy vault secrets to confirm the OAuth dry-run route creates a redacted connector action record.

## Next build layer

**v11 — Real OAuth onboarding wizard + connector setup UX**

Recommended next additions:

- dashboard wizard for setting up Gmail/Calendar OAuth
- connector enable/disable editor
- secret completeness checklist per provider
- real GHL contact adapter with location ID handling
- action replay guard with idempotency keys
- connector-scoped permissions per workflow/playbook
