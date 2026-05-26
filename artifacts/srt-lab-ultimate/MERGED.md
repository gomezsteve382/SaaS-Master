# srt-lab-ultimate — Imported from external zip (Task #842), shipped as artifact (Task #845)

This directory is the verbatim merge of `srt-lab-ultimate-main_(1)_1779796229930.zip` into the
monorepo. As of Task #845 it is **registered as a real two-service artifact** (web + api) and
boots cleanly under the workspace workflows.

## How it runs now

- Registered as artifact `artifacts/srt-lab-ultimate` (kind `web`, preview path `/srtlabu/`).
- Two services live in `.replit-artifact/artifact.toml`:
  - **web** — Vite dev server on `localPort 5180`, mounted at `/srtlabu/`. Build output goes to
    `dist/public/` and is served as static in production.
  - **api** — `tsx watch server/index.ts` on `localPort 5181`, mounted at `/srtlabu/api/`
    (more-specific than the web service's `/srtlabu/`, so the shared proxy routes it correctly).
    A small prefix-strip middleware (configured via `API_PREFIX`, default `/srtlabu`) rewrites
    incoming `req.url` so the existing `app.post("/api/*")` route registrations keep working
    unchanged. The historical static-serve + SPA catch-all at the tail of `server/index.ts` was
    removed — Vite is its own service now.
- Client code uses absolute `/api/...` fetches throughout. A small early-boot fetch patch in
  `client/src/lib/apiBase.ts` (installed from `main.tsx`) rewrites any `/api/...` call to
  `${import.meta.env.BASE_URL}api/...`, so a client call to `/api/vault` is sent as
  `/srtlabu/api/vault` and the shared proxy routes it to the api service. This keeps the 61
  legacy call sites working without touching them.
- Workflows: `artifacts/srt-lab-ultimate: web` and `artifacts/srt-lab-ultimate: api`.
- `pnpm --filter @workspace/srt-lab-ultimate run typecheck` passes clean.

## Drizzle MySQL/TiDB → Postgres port

- `drizzle/schema.ts` was rewritten: `mysqlTable`/`mysqlEnum`/`int`/`float`/`json` →
  `pgTable`/`varchar`/`integer`/`real`/`jsonb`. All 16 tables and their relations are preserved.
  Enums are stored as `varchar` (not `pgEnum`) to keep named-type churn down.
- `server/db.ts` now uses `pg` + `drizzle-orm/node-postgres`.
- `drizzle.config.json` (mysql) replaced by `drizzle.config.ts` (postgresql dialect). The old
  MySQL migration SQL under `drizzle/migrations/` was removed; only `meta/` remains. New
  migrations need to be generated against a real Postgres instance.
- Every `.onDuplicateKeyUpdate({ set: … })` site in `server/index.ts` was rewritten to
  `.onConflictDoUpdate({ target: <table>.id, set: … })`.
- `server/ai-learning.ts` is stubbed (safe defaults / no-ops). It previously queried
  `user_profile` and `analysis_goals` tables that were not part of the imported schema; a real
  port belongs in a follow-up.
- Runtime needs `DATABASE_URL` pointing at a Postgres database and the schema pushed via
  `pnpm drizzle-kit push` (or generate + apply migrations). Until then routes that hit the DB
  return their own SQL error rather than a 500.

## Dependency reconciliation

- `package.json.from-zip`, `pnpm-lock.yaml.from-zip`, and `tsconfig.json.from-zip` are gone.
  A new minimal `package.json` declares deps using `catalog:` where available (react, vite, zod,
  drizzle-orm, etc.) and local versions for the long Radix / shadcn tail, `pg`, `express`,
  `multer`, `pdfkit`, `archiver`, `form-data`, `@modelcontextprotocol/sdk`, `@trpc/server`, and
  `tw-animate-css`.
- New `tsconfig.json` extends `../../tsconfig.base.json`. Two project-level relaxations were
  needed for the dropped-in upstream code to typecheck without invasive rewrites:
  `noImplicitReturns: false` and `types: [..., "google.maps"]` (with `@types/google.maps`
  installed). A single `// @ts-expect-error` annotates each of the two real upstream
  context-provider prop holes (`WorkbenchWrapper`, `MasterVinProvider`) that the original
  codebase relied on JS looseness for.
- New `vite.config.ts` adds the React + Tailwind plugins, sets `BASE_PATH` default `/srtlabu/`,
  `allowedHosts: true` for the Replit proxy, and proxies `/api` → `http://localhost:5181` for
  ad-hoc local fetches that bypass the prefix strip.

## What still belongs in a follow-up

1. **Run migrations against a real Postgres**: generate the initial migration from the ported
   `drizzle/schema.ts`, apply it, and connect `DATABASE_URL`. Until then all DB-backed routes
   surface their underlying SQL error.
2. **`server/ai-learning.ts` real port** if user-profile / analysis-goals features are wanted.
3. **Catalog the long Radix / shadcn tail** in `pnpm-workspace.yaml` so versions hoist with the
   other artifacts instead of being re-resolved per package.
4. **Tighten the two `@ts-expect-error` suppressions** by giving `WorkbenchWrapper` and
   `MasterVinProvider` real prop types upstream.
5. **Smoke tests** (`smoke-tests/test-*.mjs`) still expect Forge / Anthropic / Cloudfront
   secrets — same status as the original import.

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
