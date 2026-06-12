# Goatmez Agent OS v11 — Connector Setup Wizard + Idempotent Action Replay

## Goal

Turn connector execution into a safer operator workflow:

1. Configure connector secrets intentionally.
2. Run dry-run actions first.
3. Review the prepared action.
4. Execute the prepared action once.
5. Preserve an audit trail and block duplicate execution.

## Added modules

### `src/connectors/setupWizard.ts`

Provides connector setup profiles that combine:

- connector config
- required secrets
- vault readiness
- agent allowlist status
- step-by-step setup guidance

### `src/connectors/connectorReplayService.ts`

Executes prepared connector actions. It currently routes prepared actions for:

- `gmail.create_draft`
- `calendar.create_event`
- `ghl.search_contacts`
- `stripe.retrieve_account`
- generic `http.*` actions
- `openai.responses`

### `src/connectors/connectorActionStore.ts`

Upgraded action history with:

- idempotency keys
- duplicate execution blocking
- replay status
- replay linkage
- blocked action records

## GHL adapter

`ProviderAdapters.ghlSearchContacts()` builds a provider-specific search request with:

- connector allowlist enforcement
- vault-backed `GHL_API_KEY`
- vault-backed `GHL_LOCATION_ID`
- dry-run preparation
- real execution path when `dryRun=false`
- action history recording

## Dashboard additions

- Connector Setup Wizard panel
- GHL dry-run button in Provider Adapter Lab
- Execute Prepared Action button in Connector Action History

## API additions

```txt
GET  /api/setup/connectors
GET  /api/setup/connectors?id=ghl
POST /api/setup/secrets
POST /api/connectors/actions/:id/execute
POST /api/connectors/ghl/search/dry-run
```

## Validation performed

```bash
npm install --ignore-scripts
npm run typecheck -- --pretty false
GOATMEZ_DB_DRIVER=memory GOATMEZ_VAULT_KEY=local-dev-master-key-123456 npm run dev -- "check connector health"
node --check src/server/static/app.js
```

Dashboard routes validated:

```txt
GET  /api/health
GET  /api/setup/connectors
GET  /api/connectors/actions
POST /api/setup/secrets
POST /api/connectors/ghl/search/dry-run
POST /api/connectors/actions/nope/execute
```

## Next build layer

v12 should add a full connector onboarding wizard that can generate `config/connectors.json`, enable/disable connectors from the dashboard, and perform provider-specific live verification checks without running destructive actions.
