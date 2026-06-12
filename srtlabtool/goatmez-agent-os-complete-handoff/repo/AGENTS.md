# AGENTS.md

## Product
This repository is Goatmez Agent OS, an original agent command center and automation platform.

## Non-Negotiables
- Keep all code original.
- Do not reference outside proprietary systems.
- Do not add branding from any other AI product.
- Do not rename the product.
- Preserve backwards compatibility when possible.
- Prefer small, reviewable changes.
- Run `npm run typecheck -- --pretty false` before completion.

## Architecture
Core layers:
- Agent runtime
- Planner
- Tool registry
- Permission gateway
- Approval queue
- Event ledger
- Local database adapters
- Connector execution hub
- Credential vault
- Workflow playbooks
- Knowledge base / RAG layer
- Dashboard operator console

## Style
- TypeScript first.
- Explicit interfaces.
- Simple operator-focused dashboard.
- Every risky action must go through approval or dry-run mode.
- Use vault-backed credentials only; never hardcode secrets.

## Validation
Before finishing a coding mission:
1. Run `npm run typecheck -- --pretty false`.
2. Run a basic CLI command.
3. Confirm the dashboard server starts.
4. Document changed files, routes, and environment variables.
