# Part 23 — Goatmez Agent OS v8: Credentials Vault + Connector Hardening

## Release objective

v8 turns Goatmez Agent OS into a safer integration-ready platform by adding an encrypted credential vault, connector readiness checks, vault-safe runtime tools, and dashboard controls for secrets and integration status.

## Major additions

### 1. Encrypted local credential vault

New module:

- `src/security/credentialVault.ts`

Capabilities:

- AES-256-GCM encryption for secret values.
- Master key from `GOATMEZ_VAULT_KEY`.
- Separate local vault file at `.goatmez/vault.json`.
- Metadata-only list responses.
- Masked secret previews.
- Secret resolution only inside trusted connector/runtime code.
- Template resolution for `${vault:SECRET_NAME}` references.

### 2. Redaction layer

New module:

- `src/security/redaction.ts`

Capabilities:

- Masks secret previews.
- Detects sensitive key names like token, apiKey, password, secret, bearer, authorization.
- Provides reusable redaction helpers for logs and dashboard responses.

### 3. Vault-safe tools

New module:

- `src/tools/vaultTools.ts`

Tools added:

- `vault.status`
- `vault.list`
- `vault.check`

These tools expose only safe metadata and never return plaintext secrets.

### 4. Connector readiness registry

New module:

- `src/connectors/connectorRegistry.ts`

New config:

- `config/connectors.example.json`

The connector registry tracks:

- Connector id
- Connector type
- Required secrets
- Allowed agents
- Risk level
- Description
- Readiness status
- Missing secrets

### 5. MCP vault reference support

`src/core/mcpConnectorMesh.ts` now supports vault-backed config values.

Example:

```json
{
  "env": {
    "API_KEY": "${vault:OPENAI_API_KEY}"
  }
}
```

Secrets are resolved only at MCP connection time. Dashboard responses redact vault references.

### 6. Dashboard upgrades

New dashboard panels:

- Credential Vault
- Connector Readiness

New routes:

- `GET /api/vault`
- `POST /api/vault/secrets`
- `DELETE /api/vault/secrets/:id`
- `GET /api/connectors`

### 7. Permission wildcard fix

The permission gateway now honors wildcard-enabled tools such as:

- `vault.*`
- `mcp.*`

This keeps tool permissions consistent between tool discovery and execution.

## Validation performed

Commands validated:

```bash
npm install --ignore-scripts
npm run typecheck -- --pretty false
GOATMEZ_VAULT_KEY=local-dev-master-key-123456 npm run dev -- "check vault status"
GOATMEZ_VAULT_KEY=local-dev-master-key-123456 GOATMEZ_DASHBOARD_PORT=8793 npm run dashboard
curl http://localhost:8793/api/health
curl http://localhost:8793/api/vault
curl -X POST http://localhost:8793/api/vault/secrets \
  -H 'content-type: application/json' \
  -d '{"name":"OPENAI_API_KEY","value":"sk-test-super-secret-123456789","scope":"workspace","provider":"openai"}'
curl http://localhost:8793/api/connectors
node --check src/server/static/app.js
```

Results:

- TypeScript passed.
- CLI vault status worked.
- Dashboard API served v0.8.0 health response.
- Vault secret save worked and returned masked preview only.
- Connector registry detected configured and missing secrets correctly.
- Browser JavaScript syntax check passed.

## Next release target

v9 should add connector execution scaffolding:

- Provider adapters for OpenAI, GHL, Gmail, Calendar, Stripe, and webhooks.
- Connector-specific tool factories.
- Connector-scoped approval policy.
- Per-agent connector allowlists.
- Runtime health checks per connector.
- Dashboard enable/disable toggles.
