# srt-lab-ultimate — Imported from external zip (Task #842)

This directory is the verbatim merge of `srt-lab-ultimate-main_(1)_1779796229930.zip` into the
monorepo. It is **not yet wired up as a runnable artifact** — it is staged for follow-up work.

## What landed

- `client/` — 220-file React + Wouter + Tailwind + shadcn UI for the standalone Reverse-Engineering Workbench
- `server/` — 42-file Express + `@modelcontextprotocol/sdk` + Anthropic Claude-agents service (`agents/`, `routes/`, `mcp.ts`)
- `shared/` — shared TypeScript types (`const.ts`, schema fragments)
- `drizzle/` — **Drizzle ORM schema targeting MySQL/TiDB**; the monorepo `lib/db` uses Postgres
- `docs/`, `references/`, `smoke-tests/`, `fixtures/` — companion material and bench binaries

## What was intentionally NOT done in Task #842

1. **No `artifact.toml`** — registering as a workflow would start a half-wired Express server. The decision to expose this as an artifact (web service vs. lib-only vs. dropped) belongs in a follow-up task.
2. **`package.json` / `pnpm-lock.yaml` / `tsconfig.json` were renamed to `*.from-zip`** so pnpm-install does not try to resolve their 90+ deps (many are not in `pnpm-workspace.yaml`'s catalog and would break the workspace install) and `tsc --build` does not pick up the orphan tsconfig.
3. **No drizzle migration ran** — the schema in `drizzle/` is MySQL/TiDB. Porting it to the monorepo's Postgres stack is its own task. Any data write paths inside `server/routes/` are currently dead code.
4. **No dependency reconciliation** — items like `@modelcontextprotocol/sdk`, `wouter`, `@hookform/resolvers`, all the `@radix-ui/*` packages, `concurrently`, `esbuild`, etc. need to be added to `pnpm-workspace.yaml`'s `catalog:` and to a real `package.json` once the wiring decision lands.
5. **Smoke tests (`smoke-tests/test-*.mjs`)** assume the Forge / Anthropic / Cloudfront secrets that lived in the original `.project-config.json` — see "Secret hygiene" below. They were copied for reference, not execution.

## Secret hygiene — IMPORTANT, READ FIRST

The source zip contained a `.project-config.json` at the root that included **live credentials**:
`ANTHROPIC_API_KEY`, `JWT_SECRET`, `DATABASE_URL` (TiDB), `DRIZZLE_DATABASE_URL`,
`BUILT_IN_FORGE_API_KEY`, `BUILT_IN_FORGE_API_URL`, `SWARM_DELEGATE_SECRET`,
`OAUTH_SERVER_URL`, `VITE_FRONTEND_FORGE_API_KEY`, `VITE_FRONTEND_FORGE_API_URL`,
`VITE_OAUTH_PORTAL_URL`, `GCP_SWARM_URL`, plus AWS STS `git_remote.access_key_id` /
`secret_access_key` / `session_token`.

**That file was explicitly NOT copied into this repo (deny-list in the merge manifest).**
Please assume every credential listed above is compromised by virtue of being in a zip
that crossed multiple environments, and rotate them.

## Pieces that DID get integrated into the existing `srt-lab` artifact

Per Task #842 plan step 4, the four `client/src/lib/` deltas were merged into the
existing `artifacts/srt-lab/src/lib/`:

| Source                                                  | Destination                                       | Notes |
|---------------------------------------------------------|---------------------------------------------------|-------|
| `client/src/lib/srt/bigMethodsVocabulary.generated.js`  | `…/srt-lab/src/lib/bigMethodsVocabulary.generated.js` | 1.1 MB — user explicitly opted in this time |
| `client/src/lib/srt/j2534.js`                           | `…/srt-lab/src/lib/j2534Raw.js`                       | renamed to avoid collision with existing `bridgeEngine.js` |
| `client/src/lib/export-report.ts`                       | `…/srt-lab/src/lib/export-report.ts`                  | TS — resolves `@/lib/workbench-types` |
| `client/src/lib/workbench-types.ts`                     | `…/srt-lab/src/lib/workbench-types.ts`                | shared types for the above |

And the 36 codegen scripts under `scripts/` of the zip were copied to
`scripts/src/` of the monorepo's `@workspace/scripts` package, with all hard-coded
`client/src/lib/srt/...` output paths rewritten to `artifacts/srt-lab/src/lib/...`.
They are **not yet wired into `codegen:all`** — see `scripts/package.json` for the
new `codegen:ultimate:*` namespace and the warning there.

## Post-import renames (audit clarification)

The manifest records targets at their pre-rename names because the rename happens
**after** the file copy. The actual on-disk names in this directory are:

| Manifest target           | On-disk name              |
|---------------------------|---------------------------|
| `package.json`            | `package.json.from-zip`   |
| `pnpm-lock.yaml`          | `pnpm-lock.yaml.from-zip` |
| `tsconfig.json`           | `tsconfig.json.from-zip`  |

All three carry the original byte-for-byte content from the zip; only the filename
was changed to keep them out of the live workspace install/build.

## Auditable provenance

The full file-by-file manifest with SHA-256 fingerprints is at
`.local/tasks/srt-lab-ultimate-merge.manifest.tsv`. Counts at the time of merge:

- 349 NEW (this directory + the 4 srt-lab lib deltas + the 36 scripts)
- 68 IDENTICAL (the `alfaobd-package-2026-05-25/` block already imported in a prior task — skipped)
- 1 DIFFER (a single charger PNG — local kept)
- 1 DENY (`.project-config.json`, see above)
- 1 SKIP (`patches/wouter+3.7.1.patch`, a yarn-style patch with no runtime effect here)
