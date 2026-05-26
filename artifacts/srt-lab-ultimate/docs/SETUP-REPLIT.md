# srt-lab-ultimate — Replit setup

Full source as of 2026-05-26 with the AlfaOBD/CDA/wiTECH extraction
package integrated. The repo's own `README.md` is the primary reference;
this file is the Replit quickstart.

## ⚠️ Secrets in this zip

`.project-config.json` contains live credentials (Anthropic API key,
TiDB DATABASE_URL, AWS STS creds, JWT_SECRET, Forge keys,
SWARM_DELEGATE_SECRET — see REVIEW.md `[CRITICAL-1]`). Treat this zip
like a credentials envelope: do not put it in any public Replit, do not
share, and rotate every one of those secrets as soon as you have the
project running, since they're tracked in git history regardless.

## First-run

```bash
# node_modules is included but pnpm install is still safer to align
# binaries to Replit's Linux + Node version
pnpm install

# Codegen all derived data modules from attached_assets/ source JSONs
pnpm codegen:all

# Typecheck baseline
pnpm check
# Expected: 22 pre-existing TS7016 errors (REVIEW.md HIGH-1). Zero NEW.

# Dev (frontend + backend concurrently)
pnpm dev
```

## Read order for new eyes

1. `REVIEW.md` — 781-line code review + 2026-05-25 addendum
2. `attached_assets/alfaobd-package-2026-05-25/package-README.md` —
   AlfaOBD extraction → repo mapping table
3. `client/src/lib/srt/` — data layer (start with `algos.js`,
   `cdaUdsCommands.generated.js`, `vinOffsetDatabase.generated.js`)
4. `README.md` — original project readme
