/* algoProvenance.js — SINGLE SOURCE OF TRUTH for how much each seed→key
 * algorithm and each immobilizer-secret writer can be trusted.
 *
 * WHY THIS EXISTS: a forensic grounding audit found that several subsystems
 * carried provenance language ("VILLAIN confirmed", "byte-verified", "ground
 * truth") that overstated what was actually recovered from the dealer-tool
 * binaries. Worse, almost nothing in the seed→key path has ever been confirmed
 * against a live seed/key capture from a real ECU — the "golden" tests prove
 * self-consistency (formula vs its own pinned vectors), not correctness on
 * hardware. This module records the HONEST grounding so the UI can show a
 * confidence level and never present a guess as a fact.
 *
 * GROUNDING LEVELS (ascending trust):
 *   'unverified'         — hand-asserted or inferred; NO extraction source AND
 *                          NO bench confirmation. Treat output as a candidate
 *                          to be tried, never as known-correct.
 *   'grounded-extracted' — the value/structure is traceable to something pulled
 *                          out of a binary (CDA.swf const pool, VILLAIN dump,
 *                          AlfaOBD IL, a decompiled .pyc). Still NOT proven on a
 *                          vehicle.
 *   'bench-verified'     — reproduces a real before/after capture byte-for-byte.
 *                          The only level you can act on without a second source.
 *
 * `dangerous: true` marks an operation that can damage a module if the guess is
 * wrong (e.g. a write/erase path), so callers can gate it behind an explicit
 * acknowledgement.
 *
 * IMPORTANT: the default for an UNKNOWN id is 'unverified' (see groundingFor) —
 * trust must be earned by an explicit entry, never assumed.
 */

export const GROUNDING = Object.freeze({
  UNVERIFIED: 'unverified',
  EXTRACTED: 'grounded-extracted',
  BENCH: 'bench-verified',
});

const RANK = { unverified: 0, 'grounded-extracted': 1, 'bench-verified': 2 };

/* Per seed→key algorithm id (matches algos.js ALGOS[].id). */
export const ALGO_GROUNDING = Object.freeze({
  // GPEC sxor primaries — q1 constants are in the VILLAIN dump, but the
  // _gpec_calculator function body was never captured and there are zero live
  // seed→key pairs, so the sxor application itself is unconfirmed.
  gpec1:    { level: GROUNDING.EXTRACTED, source: 'VILLAIN dump (q1 const)', caveat: 'sxor application unverified; no bench pairs' },
  gpec2:    { level: GROUNDING.EXTRACTED, source: 'VILLAIN dump (q1 const)', caveat: 'sxor application unverified; no bench pairs' },
  gpec2f:   { level: GROUNDING.EXTRACTED, source: 'VILLAIN dump (q1 const)', caveat: 'sxor application unverified; no bench pairs' },
  gpec2e:   { level: GROUNDING.EXTRACTED, source: 'VILLAIN dump (q1 const)', caveat: 'sxor application unverified; no bench pairs' },
  gpec3:    { level: GROUNDING.EXTRACTED, source: 'VILLAIN dump (q1 const)', caveat: 'sxor application unverified; no bench pairs' },
  gpec2a:   { level: GROUNDING.EXTRACTED, source: 'VILLAIN dump (q1 const)', caveat: 'sxor application unverified; no bench pairs' },
  gpec15:   { level: GROUNDING.EXTRACTED, source: 'VILLAIN dump (q1 const)', caveat: 'sxor application unverified; no bench pairs' },
  // GPEC q2/q3/q4 — constants are real in the dump, but the assumption that
  // they feed the SAME sxor() as q1 is pure inference. NOT VILLAIN-confirmed.
  gpec2_q2:  { level: GROUNDING.UNVERIFIED, source: 'VILLAIN dump (q2 const)', caveat: 'sxor application is inference, not described in the dump' },
  gpec2f_q2: { level: GROUNDING.UNVERIFIED, source: 'VILLAIN dump (q2 const)', caveat: 'sxor application is inference' },
  gpec2e_q2: { level: GROUNDING.UNVERIFIED, source: 'VILLAIN dump (q2 const)', caveat: 'sxor application is inference' },
  gpec2e_q3: { level: GROUNDING.UNVERIFIED, source: 'VILLAIN dump (q3 const)', caveat: 'sxor application is inference' },
  gpec2e_q4: { level: GROUNDING.UNVERIFIED, source: 'VILLAIN dump (q4 const)', caveat: 'sxor application is inference' },
  gpec3_q2:  { level: GROUNDING.UNVERIFIED, source: 'VILLAIN dump (q2 const)', caveat: 'sxor application is inference' },
  gpec2a_q2: { level: GROUNDING.UNVERIFIED, source: 'VILLAIN dump (q2 const)', caveat: 'sxor application is inference' },
  gpec15_q2: { level: GROUNDING.UNVERIFIED, source: 'VILLAIN dump (q2 const)', caveat: 'sxor application is inference' },
  // NGC — tables in the dump, mixing function reconstructed; label mismatch
  // (binary says DAIMCHRYSLER/13, code uses DAIMLERCHRYSLER1/16).
  ngc:  { level: GROUNDING.UNVERIFIED, source: 'VILLAIN dump (NT/NS/NGC_PRE tables)', caveat: 'mixing function reconstructed, not in dump' },
  jtec: { level: GROUNDING.EXTRACTED, source: 'VILLAIN dump (fixed key 0000)', caveat: 'trivially confirmed' },
  // sbec — hand-typed magic, no source at all.
  sbec: { level: GROUNDING.UNVERIFIED, source: null, caveat: 'hand-asserted magic; no extraction source' },
  // cda6 — the DEFAULT body-bus unlock (BCM/RFHUB/ABS/IPC/EPS/radio/ORC/HVAC).
  // The CDA SWF confirms WHICH modules use the "cda6" label, but the transform
  // (0x4B129F/0x1234/0xABCD) appears in NO extraction artifact. Highest blast
  // radius of any single guess in the tool.
  cda6: { level: GROUNDING.UNVERIFIED, source: null, caveat: 'formula in no artifact; CDA.swf confirms only the label, not the transform' },
  // xtea_sgw — the 128-bit key IS lifted from CDA.swf, but the VILLAIN wiTECH
  // analysis says SGW unlock is SERVER-SIDE ("the tool cannot compute unlock
  // codes locally"), so a local XTEA may be the wrong model entirely.
  xtea_sgw: { level: GROUNDING.UNVERIFIED, source: 'CDA.swf @0x24664A (key only)', caveat: 'SGW auth is likely server-side; local-compute model unconfirmed' },
  // TIPM — all six tables are in the dump; the parity-XOR mixing routine is not.
  t80:   { level: GROUNDING.EXTRACTED, source: 'VILLAIN dump (TT tables)', caveat: 'mixing routine reconstructed; not bench-verified' },
  t36:   { level: GROUNDING.EXTRACTED, source: 'VILLAIN dump (TT tables)', caveat: 'mixing routine reconstructed; not bench-verified' },
  t81:   { level: GROUNDING.EXTRACTED, source: 'VILLAIN dump (TT tables)', caveat: 'mixing routine reconstructed; not bench-verified' },
  t3c:   { level: GROUNDING.EXTRACTED, source: 'VILLAIN dump (TT tables)', caveat: 'mixing routine reconstructed; not bench-verified' },
  t3608: { level: GROUNDING.EXTRACTED, source: 'VILLAIN dump (TT tables)', caveat: 'mixing routine reconstructed; not bench-verified' },
  tc605: { level: GROUNDING.EXTRACTED, source: 'VILLAIN dump (TT tables)', caveat: 'mixing routine reconstructed; not bench-verified' },
  // AlfaOBD family — reverse-engineered from AlfaOBD.exe .NET IL; JS⇄Python
  // cross-checked, but never bench-verified against an ECU.
  alfa_ht: { level: GROUNDING.EXTRACTED, source: 'AlfaOBD.exe IL', caveat: 'JS⇄Python checked; not bench-verified' },
  alfa_f:  { level: GROUNDING.EXTRACTED, source: 'AlfaOBD.exe IL', caveat: 'JS⇄Python checked; not bench-verified' },
  alfa_ao: { level: GROUNDING.EXTRACTED, source: 'AlfaOBD.exe IL', caveat: 'JS⇄Python checked; not bench-verified' },
  alfa_w6_tt: { level: GROUNDING.EXTRACTED, source: 'AlfaOBD.exe IL (w6)', caveat: 'not bench-verified' },
  alfa_w6_tu: { level: GROUNDING.EXTRACTED, source: 'AlfaOBD.exe IL (w6)', caveat: 'not bench-verified' },
  alfa_w6_tv: { level: GROUNDING.EXTRACTED, source: 'AlfaOBD.exe IL (w6)', caveat: 'not bench-verified' },
  alfa_w6_ez: { level: GROUNDING.EXTRACTED, source: 'AlfaOBD.exe IL (w6)', caveat: 'not bench-verified' },
  alfa_w6_custom: { level: GROUNDING.UNVERIFIED, source: 'operator input', caveat: 'user-supplied (r,s); correctness is the operator’s responsibility' },
  // Asset-sweep promotions — ports of the project's OWN Python (srt_lab.py /
  // srtlab_canflash_algos.py), which itself has no binary-extraction
  // provenance. "vector-verified" is circular (formula vs its own pin).
  aisin_tcm:     { level: GROUNDING.UNVERIFIED, source: 'project Python port', caveat: 'no binary provenance; vectors are self-pinned' },
  alpine_radio:  { level: GROUNDING.UNVERIFIED, source: 'project Python port', caveat: 'no binary provenance; vectors are self-pinned' },
  bcm_fca:       { level: GROUNDING.UNVERIFIED, source: 'project Python port', caveat: 'no binary provenance; vectors are self-pinned' },
  bcm_standard:  { level: GROUNDING.UNVERIFIED, source: 'project Python port', caveat: 'no binary provenance; vectors are self-pinned' },
  cummins_849:   { level: GROUNDING.UNVERIFIED, source: 'project Python port', caveat: 'no binary provenance; vectors are self-pinned' },
  dcx_ptcm:      { level: GROUNDING.UNVERIFIED, source: 'project Python port', caveat: 'no binary provenance; vectors are self-pinned' },
  egs52:         { level: GROUNDING.UNVERIFIED, source: 'project Python port', caveat: 'no binary provenance; vectors are self-pinned' },
  mitsubishi_rar:{ level: GROUNDING.UNVERIFIED, source: 'project Python port', caveat: 'no binary provenance; vectors are self-pinned' },
  ptim_lx:       { level: GROUNDING.UNVERIFIED, source: 'project Python port', caveat: 'no binary provenance; vectors are self-pinned' },
});

/* Per immobilizer-secret writer / parser subsystem. Keyed by a stable name the
 * caller chooses (exported function name or subsystem id). */
export const WRITER_GROUNDING = Object.freeze({
  // The bench-verified core — your marry/parse/secret-write path.
  parseModuleOffsets:  { level: GROUNDING.BENCH, source: 'real anonymized captures + bench traces', caveat: '' },
  writeBcmSec16Gen2:   { level: GROUNDING.BENCH, source: 'real MPC5606B before/after', caveat: '' },
  writePcmSec6:        { level: GROUNDING.BENCH, source: 'real GPEC2A before/after', caveat: '' },
  writeRfhSec16FromBcm:{ level: GROUNDING.BENCH, source: 'real 24C32 before/after', caveat: '' },
  knownWorkingKeys:    { level: GROUNDING.BENCH, source: 'real anonymized RFHUB dumps', caveat: 'primary vehicles only' },
  charRfhubKeyTable:   { level: GROUNDING.EXTRACTED, source: 'real 21-key corpus RE', caveat: 'index formula solved but no before/after key-add pair' },
  write95640Sec16:     { level: GROUNDING.EXTRACTED, source: '95640 SEC16 mirror @0x838 + CRC16 @0x848', caveat: 'offsets known; round-trip verified, not before/after bench-confirmed' },
  fcaProxi:            { level: GROUNDING.EXTRACTED, source: 'decompiled proxi_record.py', caveat: 'offsets decompile-derived, not bench-reverified' },
  // The risky writers — these touch a real module but rest on a guess.
  writeRfhSec16Gen1:   { level: GROUNDING.UNVERIFIED, source: null, caveat: 'crc8_65 assumed from Gen2; no physical 24C16 dump exists', dangerous: true },
  writeXc2268Sec16:    { level: GROUNDING.UNVERIFIED, source: 'Task #634 screenshot', caveat: 'entire offset map incl. image-CRC reconstructed from a screenshot', dangerous: true },
  dealerLockoutBypass: { level: GROUNDING.UNVERIFIED, source: null, caveat: '0xFF00 is the generic ISO-14229 erase RID relabeled; invented payload — can trigger an unintended firmware erase', dangerous: true },
  keyWriterProtocol:   { level: GROUNDING.UNVERIFIED, source: 'public captures', caveat: 'VVDI/Tango framing never verified against a tethered writer', dangerous: true },
  moparRadioCode:      { level: GROUNDING.UNVERIFIED, source: null, caveat: 'FAMILY_TABLE constants unexplained; outputs self-pinned' },
  rfhPflashIdentity:   { level: GROUNDING.UNVERIFIED, source: 'competitor tool output', caveat: 'field shapes are pattern guesses' },
});

const UNKNOWN = Object.freeze({ level: GROUNDING.UNVERIFIED, source: null, caveat: 'no provenance entry; treat as unverified by default' });

/** Grounding record for a seed→key algorithm id (defaults to unverified). */
export function groundingFor(algoId) {
  return ALGO_GROUNDING[algoId] || UNKNOWN;
}

/** Grounding record for a writer/subsystem name (defaults to unverified). */
export function writerGrounding(name) {
  return WRITER_GROUNDING[name] || UNKNOWN;
}

/** True only for bench-verified items — the ones safe to act on alone. */
export function isTrusted(record) {
  return RANK[record?.level] === RANK[GROUNDING.BENCH];
}

/** Short UI badge for a grounding record. */
export function confidenceBadge(record) {
  switch (record?.level) {
    case GROUNDING.BENCH: return { text: 'BENCH-VERIFIED', tone: 'good' };
    case GROUNDING.EXTRACTED: return { text: 'EXTRACTED · UNCONFIRMED', tone: 'warn' };
    default: return { text: 'UNVERIFIED', tone: 'danger' };
  }
}

/** Compare two levels: -1/0/1. */
export function compareGrounding(a, b) {
  return Math.sign((RANK[a] ?? 0) - (RANK[b] ?? 0));
}
