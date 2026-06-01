---
name: Backup vault payload round-trip
description: What survives a backup save→refreshBackupsFromServer cycle in SRT Lab BackupsTab/audit.js, and how detail-view branches are selected.
---

# Backup vault payload round-trip (SRT Lab)

`refreshBackupsFromServer` rebuilds the local index from server **columns**, not
the original in-payload object. Consequences when adding a new backup flavor:

- `snapshotKind` round-trips (it is a server column), so list badges that key off
  `snapshotKind` survive a reload. Use it (e.g. `"repaired-dump"`,
  `"binary-repair"`) to drive list badges/subtitles.
- The in-payload `source` field does NOT round-trip. Do not depend on `source` for
  list rendering after a server refresh.

**Detail-view branch selection** in `BackupsTab.jsx` is by shape, checked in order:
`selectedData.rawB64` (raw full-image dump) → `selectedData.module === "BINARY_REPAIR"`
(provenance record) → normal DID snapshot (reads `selectedData.dids`). A raw dump
sets `dids:{}`, so without a dedicated `rawB64` branch it falls through to the normal
view and renders a misleading empty Restore/snapshot UI — add the shape branch first.

**Server cap:** `POST /api/backups` rejects payloads >512KB (MAX_PAYLOAD_BYTES).
Large CFLASH images (>~380KB raw → >512KB base64) 413 on the server but the
optimistic localStorage write still keeps them locally. This is the same accepted
behavior as `saveBinaryRepairRecord`.
