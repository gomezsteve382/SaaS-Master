/* identityPreflight — confirm WHO a module is before any unlock or 0x2E write.

   The audit's #0 catch: the single biggest way to brick a job is talking to the
   WRONG module. A flawless safety envelope wrapped around a write to the wrong
   rx-id still bricks the car. So before the first unlock, read the module's
   identity (part number + VIN) and surface it to the operator. We try several
   part-number DIDs (F18C -> F187 -> F18A -> F191) so a live module isn't falsely
   flagged just because it doesn't carry one specific DID.

   Engine contract: eng.uds(tx, rx, bytes) -> { ok, d, raw }, where d is a
   Uint8Array of the raw UDS reply (0x62 <did-hi> <did-lo> <data...> on success). */

// ECU part-number DIDs, most-common first.
//   F18C = ECU software number, F187 = vehicle-mfr spare-part number,
//   F18A = system-supplier identifier, F191 = vehicle-mfr ECU hardware number.
const PART_DIDS = [0xF18C, 0xF187, 0xF18A, 0xF191];

const encodeDid16 = (did) => [(did >> 8) & 0xFF, did & 0xFF];

function asciiTail(d, skip) {
  let s = '';
  for (let i = skip; i < d.length; i++) {
    const c = d[i];
    if (c >= 0x20 && c < 0x7F) s += String.fromCharCode(c);
  }
  return s.trim();
}

/* Read the first part-number DID that answers. Returns { did, value } or null. */
export async function readPartNumber(uds, tx, rx) {
  for (const did of PART_DIDS) {
    const r = await uds(tx, rx, [0x22, ...encodeDid16(did)]);
    if (r && r.ok && r.d && r.d[0] === 0x62) {
      const value = asciiTail(r.d, 3);
      if (value) return { did, value };
    }
  }
  return null;
}

/* Read F190 (current VIN). Returns the VIN string (trimmed to 17 if longer) or null. */
export async function readVin(uds, tx, rx) {
  const r = await uds(tx, rx, [0x22, 0xF1, 0x90]);
  if (r && r.ok && r.d && r.d[0] === 0x62) {
    const v = asciiTail(r.d, 3);
    if (!v) return null;
    return v.length >= 17 ? v.slice(0, 17) : v;
  }
  return null;
}

/* Full identity snapshot for the confirm dialog / write gate.
   `responded` is the liveness gate: if neither a part number nor a VIN comes
   back, the address is wrong or the module is asleep — callers MUST refuse to
   write. */
export async function readModuleIdentity(uds, tx, rx) {
  const part = await readPartNumber(uds, tx, rx);
  const vin = await readVin(uds, tx, rx);
  return {
    tx, rx,
    partNumber: part ? part.value : null,
    partDid: part ? part.did : null,
    vin: vin || null,
    responded: !!(part || vin),
  };
}

/* Gate helper: ok=true only when the module responded AND (when an expected
   part-number substring is supplied) the read part number contains it. */
export async function verifyIdentity(uds, tx, rx, { expectPartContains } = {}) {
  const id = await readModuleIdentity(uds, tx, rx);
  if (!id.responded) return { ...id, ok: false, reason: 'no-response' };
  if (expectPartContains && id.partNumber &&
      !id.partNumber.toUpperCase().includes(String(expectPartContains).toUpperCase())) {
    return { ...id, ok: false, reason: 'part-mismatch' };
  }
  return { ...id, ok: true, reason: null };
}

export { PART_DIDS, asciiTail };
