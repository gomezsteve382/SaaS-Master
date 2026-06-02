---
name: ModuleSync SYNC ALL UI test fixtures
description: Non-obvious gotchas when driving ModuleSync through real DropZones with makeBcm/makeRfhubGen2 fixtures in jsdom.
---

Driving ModuleSync "SYNC ALL" end-to-end (render → load BCM+RFH via DropZone file
inputs → click button → assert gate verdict) hits four traps, all fixture/DOM
shape problems, NOT logic bugs:

1. **engParseBcm needs a `00 46 <slotType> 00` header before each VIN slot.**
   makeBcm writes raw VIN ASCII at 0x5320/0x5340/0x5360/0x5380 with no header,
   so the inspector parses zero VINs, bcm.parsed.ok stays false, and the SYNC
   ALL action card never mounts. Inject the 4-byte header at base-4 before all
   four bases. slotType ∈ BCM_SLOT_TYPES (0x46/0x52/0x53/0x56/0x57); CRC need
   not be valid (slot is pushed regardless).

2. **Inject the header before ALL FOUR bases, not just one.** The export gate
   (checkExportSafety→parseModule) validates a CRC-16 at base+17 on every
   canonical VIN slot. engWriteBcmVin only restamps slots engParseBcm found, so
   a single header leaves the other three raw → gate blocks with "VIN slot
   checksum INVALID". Four headers → engWriteBcmVin restamps all four → gate
   passes.

3. **makeBcm's `vehicleSecret` option is clobbered.** It fills 0x40C9 first, but
   the later IMMO-record fill at 0x40C0 (record length 24) overwrites
   0x40C9..0x40D8 entirely. The resolved flat the gate reads becomes the IMMO
   pattern, not your secret. To control the flat (e.g. reconcilable pair), stamp
   it at 0x40C9 AFTER makeBcm returns. The IMMO backup mismatch this creates
   (0x40C0 primary vs 0x2000 backup) is NOT a gate blocking issue.

4. **querySelectorAll('input[type=file]') goes stale after the BCM load.**
   Loading the BCM re-renders the tab (inspection panel mounts), replacing DOM
   nodes; a NodeList captured once points at a detached RFH input and the change
   event is silently dropped. Re-query the inputs by index on every load.

Reconcile rule (crossValidate): MATCH iff reverse(resolved BCM flat) === RFH
SEC16 secret. RFH default (makeRfhubGen2) secret = [01..10], so a reconcilable
BCM flat = reverse([01..10]). source stays 'flat', which skips the legacy-flat
staleness warning.

5. **Wrong-size PCM is blocked at UI enablement, not by the sync-time log
   guard.** SYNC ALL has two entry points and only one is reachable by clicking:
   the direct button is *disabled* when the PCM is non-canonical (neither 4 KB
   nor 8 KB), and a disabled button's onClick is wired to undefined — so a click
   can never reach the sync executor. The executor's size-guard log line is a
   backstop reachable only via the MismatchWizard "Full 3-Module Sync"
   programmatic re-entry. So a wrong-size *button* test asserts disabled state +
   visible reason (the size-block help panel) + no download fired — NOT a log
   line; testing the log requires driving the wizard path instead. Build the
   oversized PCM with `makeGpec2a({ size })`: fields stay in the first 4 KB and
   the tail is 0xFF pad, so it still parses as GPEC2A (not "too small").
