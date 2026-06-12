# Goatmez Agent OS v8 — Credentials Vault + Connector Hardening

## What changed

v8 adds a local encrypted credential layer and connector readiness system so the Agent OS can safely prepare for real API/MCP integrations without exposing credentials in logs, prompts, dashboard responses, or repo files.

## New systems

### 1. Credential Vault

- Stores secrets in `.goatmez/vault.json` by default.
- Encrypts secret values with AES-256-GCM.
- Uses `GOATMEZ_VAULT_KEY` as the local master key.
- API and dashboard return metadata only: name, scope, provider, timestamps, and masked preview.
- Plaintext is only resolved inside trusted runtime code when a connector needs it.

### 2. Vault tools

The tool registry now includes safe metadata tools:

- `vault.status`
- `vault.list`
- `vault.check`

None of these tools return secret plaintext.

### 3. Connector readiness registry

`config/connectors.example.json` defines connector profiles with:

- connector id
- connector type
- required secrets
- allowed agent ids
- risk level
- description

The dashboard shows whether each connector is ready or missing required secrets.

### 4. MCP vault reference resolution

MCP config values can now reference vault secrets:

```json
{
  "env": {
    "API_KEY": "${vault:OPENAI_API_KEY}"
  }
}
```

Vault references are resolved only at connection time and redacted in dashboard API responses.

### 5. Dashboard upgrades

New panels:

- Credential Vault
- Connector Readiness

New API routes:

- `GET /api/vault`
- `POST /api/vault/secrets`
- `DELETE /api/vault/secrets/:id`
- `GET /api/connectors`

## Security rules

- Do not commit `.goatmez/vault.json`.
- Do not share `GOATMEZ_VAULT_KEY`.
- Rotate the vault key by re-saving secrets with a new key.
- Give high-risk connectors approval-gated tools by default.
- Prefer connector-scoped secrets for integrations, with workspace-scoped fallback only when useful.

## Validation commands

```bash
npm install --ignore-scripts
npm run typecheck -- --pretty false
GOATMEZ_VAULT_KEY=local-dev-master-key-123456 npm run dev -- "check vault status"
GOATMEZ_VAULT_KEY=local-dev-master-key-123456 GOATMEZ_DASHBOARD_PORT=8793 npm run dashboard
```
