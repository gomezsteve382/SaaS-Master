---
name: Key history server sync
description: How per-VIN key history persists server-side and the localStorage-cache round-trip contract shared by the sibling history endpoints.
---

The Key Dump card's per-VIN "keys on file" history persists to the shared
api-server (`/api/key-history`, table `key_history`) so it survives a
browser-data wipe and shows on a second bench laptop for the same VIN.

**Pattern (shared with `/api/backups`, `/api/key-prog-archives`, `/api/diff-reports`):**
localStorage is an OFFLINE CACHE that mirrors the server; the server is the
canonical cross-device source of truth. The lib module write-throughs are
best-effort (silent on failure); a `refresh*FromServer(vin)` does the GET +
first-run migration of local-only rows + cache rewrite.

**Why these endpoints are NOT in `lib/api-spec/openapi.yaml`:** srt-lab does
not consume the generated `@workspace/api-client-react` hooks at all — every
one of these history-sync features uses plain `fetch` from a `src/lib/*.js`
module. Adding openapi codegen just for one endpoint would diverge from its
three siblings, so new history-sync endpoints follow the plain-fetch twin
pattern, not the codegen flow.

**Contract gotchas:**
- `capturedAt` crosses the wire as epoch ms (numeric), stored as timestamptz;
  the route converts both directions. The frontend entry shape keeps it numeric
  so the existing newest-first sort works unchanged.
- Migration marker is per-VIN (`srt-lab.keywriter.keyhistory.migrated.<VIN>`)
  and only set after every local candidate is confirmed on the server, so a
  transient outage retries instead of stranding local-only keys.
- `skHex` (per-transponder chip secret) IS persisted server-side; it is never
  the 16-byte RFHUB SEC16 master secret (the Key Dump card has no SK==SEC16 path).
