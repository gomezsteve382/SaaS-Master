---
name: AlfaOBD dispatch gap — static coverage ceiling
description: How much of the routine → UDS frame dispatch gap is closeable from pure static analysis vs. needing live bench capture.
---

Static-analysis coverage of the routine→UDS frame mapping tops out at **~17.6%** (299 / 1696 routines) once you merge the strict unambiguous `UDS_FRAME_TO_ROUTINES` map with the broader `MATCHED_DISPATCH_FULL` records that include ambiguous multi-routine resolutions. The strict-only ceiling is much lower (~3.9%, 66 routines).

**Why:** the AlfaOBD.exe IL extraction recovers literal UDS frame bytes per IL method, but the routine table (`Method[1163] .ctor`) does not carry the RID byte. Cross-matching happens via the per-frame decrypted-context strings against routine idx[0]/idx[1]/idx[2]. That works for the 499 dispatch records with strong context strings — everything else is genuinely orphan from static analysis.

**How to apply:** when planning the next dispatch-mapping pass, do not expect another static run to close the remaining ~82% gap. The realistic next steps are (a) bench capture of the worst-gap ECUs surfaced by the report (BODY_CHRYSLER tops the list with 66 orphans), or (b) targeted IL trace through the computed-dispatch MemberRef chain used by Tier-1 routines 2504/2505/2507/2508 (currently empty in `tier1DispatchFromExe.generated.js`). The heuristic candidate frames in `dispatchGapReport.generated.js` are deliberately scoped to RoutineControl (0x31) frames that share an IL method with confirmed frames on the same ECU — they are a triage hint, not an answer.
