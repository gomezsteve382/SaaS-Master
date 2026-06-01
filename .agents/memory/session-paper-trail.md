---
name: Session paper-trail location & backend sync
description: Where the session paper-trail feature actually lives and why it must not be re-added to srt-lab.
---

The session "paper trail" (logSession/getSessions/SessionsTab) was **deliberately
removed from the original `srt-lab` artifact at the user's request**. In srt-lab,
`lib/audit.js` no longer has any session functions and `lib/paperTrail.js` is a dead
re-export shim pointing at symbols that no longer exist (nothing imports it, so it
never breaks the build). There is no `SessionsTab.jsx` in srt-lab.

**There is currently NO frontend home for the session feature.** It was briefly
wired into `srt-lab-ultimate`, but that entire artifact was later retired, so those
frontend files no longer exist. Any future session UI must be (re)built in whatever
artifact becomes the canonical SRT Lab frontend.

**Backend sync (this survives, has no consumer yet):** sessions persist to the
shared `artifacts/api-server` at
`/api/sessions` (GET/POST upsert/DELETE), backed by the `session_log` Drizzle table
in `lib/db`. Mirrors the existing `/api/backups` + `module_backups` pattern. Client
keeps a localStorage cache with a per-record `synced` flag; `refreshSessionsFromServer`
merges server+local (dedupe by id), `syncPendingSessions` uploads unsynced/legacy
records. Cross-artifact `/api/...` calls reach api-server via the shared proxy
regardless of the calling artifact's base path.

**Why this matters:** A task may name `artifacts/srt-lab/...` for session work, but
that target has the feature stripped. Do NOT re-add session logging to srt-lab — that
contradicts an explicit user removal (and overlaps the separate "paper-trail audit log
of every VIN write" effort). Implement session work in srt-lab-ultimate instead.
