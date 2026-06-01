---
name: Transponder writer bridge (VVDI / Tango)
description: Scope, gates, and transport contract for the KEY WRITER tab that hands RFHUB slot bytes to commercial transponder writers.
---

## Scope rule
KEY WRITER tab only burns chips. The vehicle pairing still happens through the existing RFHUB RoutineControl 0x0401 wizard. Do not graft pairing onto the writer code path — the writer firmware does not own the car-side dialog.

**Why:** Xhorse VVDI Mini and Tango talk to the chip, not the car. The receiver only accepts the chip once SEC16 + UID + payload all agree; if you skip the 0x0401 step you get a working chip the car still ignores.

**How to apply:** Any new code under `keyWriter/` must terminate at "chip burned & verified". Vehicle-side state changes belong in RfhubTab / keyProgWizard.js.

## Chip families must match RFHUB slot block size
For any chip family that targets RFHUB slots, `uidBytes + payloadBytes` MUST equal the slot block size that `rfhubKeySlots` exports. Bigger chips need a different dump source — they do not belong in this bridge.

**Why:** The serializer's id-shape gate rejects anything else with `id-shape-mismatch` long before the simulator ever sees the request, so the entire happy path silently dead-ends. Easy to miss because public HITAG2 docs list more bytes than the receiver actually stores.

**How to apply:** When adding a new chip, derive the split from the slot block size, not from chip-vendor docs. Run the full ping→detect→burn→verify simulator path as part of the change; if any step short-circuits at the burn-serializer gate, the chip table is wrong.

## Transport contract
Every transport's `send(frame)` MUST resolve with **raw frame bytes** (Uint8Array), not a parsed `{cmd,payload}` object. `burnSlot` re-parses the response itself.

**Why:** When this was violated for the Web Serial transport, every live request decoded as "incomplete frame" and every burn appeared to fail at ping. Simulator passed because it returned bytes; the regression only surfaced on real hardware.

**How to apply:** Lock this with the WebSerialTransport tests that parse the response back out and assert against `{cmd,payload}`. If you add a new transport (BLE, WebSocket bridge, etc), mirror the same shape.

## Pending must be registered before write
Any request/response transport over USB-CDC must assign `this.pending` **before** awaiting `writer.write()`. A fast-responding device can otherwise win the race and the reader's no-pending branch will silently drop its frame.

**Why:** Symptom is intermittent timeouts that vanish under load — and they vanish exactly because logging slows the host enough to lose the race. Painful to diagnose if the test suite doesn't pre-arm the inbox to make the race deterministic.

**How to apply:** Use the pre-armed inbox pattern in the WebSerialTransport tests; never accept a transport patch that moves the pending assignment after the write.

## SK (transponder secret) is NOT SEC16 (vehicle master)
The Key Dump capture/clone/export surface stores a transponder's own **SK** secret. SK ≠ SEC16. They have different lengths, different roles, and must never be cross-copied into each other's field.

**Why:** SEC16 is the RFHUB/vehicle immobilizer master secret; SK is the chip's own key from an external read tool. Putting SEC16 in the SK field (or vice-versa) produces a key the receiver rejects and risks leaking the master secret into a portable export. The Key Dump JSON manifest carries an explicit `_sk_warning` field to keep this honest.

**How to apply:** Any extension of `keyRecord.js` / `autelExport.js` Key Dump path keeps SK and SEC16 in separate slots. `writeKeyRecordToSlot` (rfhubKeySlots.js) clones a UID into a free RFHUB slot for the "second blank key, same car" case; it never touches SEC16.

## Per-vehicle key history is localStorage-only, scoped by Master VIN
The "Keys on file for this vehicle" list (`keyWriter/keyHistory.js`) persists captured Key Dump records in localStorage keyed by the active MasterVin (cap 50/VIN), de-duped by chipId+UID. It is the inline Key Dump card's history — NOT KeyDumpPanel.jsx (separate parallel impl).

**Why:** Operators work several keys per car and need an at-a-glance count + slot map before cloning. Storage is per-browser only; there is no server backing yet (follow-up tasks cover cross-device sync + bulk export/import).

**How to apply:** Reducers (`upsertEntry`/`removeEntryById`) are pure for unit tests; storage wrappers must return the post-upsert stored row (id is preserved on dedupe, so re-read from the resulting list rather than the pre-dedupe entry). The shared `Tag` component does NOT forward `data-testid` — wrap it in a span when a testid is needed.

## Protocol framing is unverified
`protocol.js` 5A A5 framing matches public USB-CDC captures of VVDI Mini but has not been bench-verified in this repo. The Burn tab puts an orange disclaimer banner on this and defaults to Simulator. Treat the first live burn as field-verification, not production.
