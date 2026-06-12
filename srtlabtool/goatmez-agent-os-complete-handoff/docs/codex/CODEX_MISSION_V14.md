# Codex Mission: Goatmez Agent OS v14

You are working on Goatmez Agent OS.

## Rules
- Keep all code original.
- Do not reference outside proprietary systems.
- Do not rename the product.
- Preserve the current architecture.
- Use small, reviewable changes.
- Run `npm run typecheck -- --pretty false` before finishing.
- Document every new API route, config file, environment variable, and changed module.

## Mission
Upgrade the Knowledge Base from keyword-only retrieval to semantic and hybrid retrieval.

## Tasks
1. Add an embeddings provider interface.
2. Add a local deterministic mock embeddings provider for development and tests.
3. Add an OpenAI embeddings provider using vault-stored API keys.
4. Store vectors per knowledge chunk.
5. Add cosine similarity search.
6. Keep keyword search as fallback.
7. Add hybrid search that blends keyword score and vector score.
8. Add dashboard controls to choose keyword, vector, or hybrid search.
9. Add API support for search mode selection.
10. Add a validation script or tests.

## Acceptance Checks
- `npm run typecheck -- --pretty false` passes.
- CLI knowledge ingestion still works.
- CLI knowledge search works in keyword mode without API keys.
- Dashboard Knowledge Base panel can search in keyword, vector, and hybrid mode.
- No secrets appear in logs, dashboard responses, or saved events.
