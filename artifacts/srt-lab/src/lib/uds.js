/**
 * UDS service helpers — pure builders/parsers for services that the
 * UdsTab and BackupsTab need but don't yet have first-class wrappers
 * for. Keeping these as standalone, dependency-free functions makes
 * them straightforward to unit-test (no DOM, no engine mock) and lets
 * other tabs reuse them without dragging UI state along.
 *
 * Services covered (Task #565):
 *   - 0x23 ReadMemoryByAddress  / 0x63 positive response
 *   - 0x3D WriteMemoryByAddress / 0x7D positive response
 *   - 0x31 0x03 RoutineControl: requestRoutineResults
 *   - 0x22 ReadDataByIdentifier — multi-DID request builder + 0x62
 *     response splitter, plus the chunking budget used by BackupsTab
 *     to collapse ~40 single-DID round trips into a handful.
 *
 * No imports: every helper is byte-in / byte-out so tests stay fast
 * and these can be tree-shaken out of bundles that don't use them.
 */

// ─── ReadMemoryByAddress 0x23 / WriteMemoryByAddress 0x3D ────────────

/**
 * Encode an ISO 14229 addressAndLengthFormatIdentifier (ALFID) plus
 * the address + length bytes that follow. The high nibble of ALFID is
 * the memorySize byte count; the low nibble is the memoryAddress byte
 * count. We default to 0x44 (4-byte addr + 4-byte size) because it's
 * what the FCA flasher already uses and matches AEMT EEPROM offsets
 * (0x100/0x108/0x220/0x230/0x240/0x510/0x518) cleanly.
 */
export function encodeAddressAndLength(addr, length, alfid = 0x44){
  const addrLen = alfid & 0x0F;
  const sizeLen = (alfid >> 4) & 0x0F;
  if (addrLen < 1 || addrLen > 4 || sizeLen < 1 || sizeLen > 4){
    throw new Error('encodeAddressAndLength: ALFID nibbles must be 1..4');
  }
  const a = (addr >>> 0);
  const l = (length >>> 0);
  const addrBytes = [];
  for (let i = addrLen - 1; i >= 0; i--) addrBytes.push((a >>> (i * 8)) & 0xFF);
  const lenBytes = [];
  for (let i = sizeLen - 1; i >= 0; i--) lenBytes.push((l >>> (i * 8)) & 0xFF);
  return { addrBytes, lenBytes, alfid };
}

/** Build a 0x23 ReadMemoryByAddress request frame. */
export function buildReadMemoryByAddress(addr, length, alfid = 0x44){
  const { addrBytes, lenBytes } = encodeAddressAndLength(addr, length, alfid);
  return [0x23, alfid, ...addrBytes, ...lenBytes];
}

/**
 * Parse a 0x63 ReadMemoryByAddress response. ISO 14229 returns the
 * raw bytes verbatim — no DID, no length prefix — so we just hand
 * back everything after the SID. NRCs are surfaced separately so the
 * caller can decode them with the existing nrc.js helpers.
 */
export function parseReadMemoryResponse(d){
  if (!d || d.length < 1) return { ok: false, data: null, nrc: null };
  if (d[0] === 0x7F) return { ok: false, data: null, nrc: d[2] ?? null };
  if (d[0] !== 0x63) return { ok: false, data: null, nrc: null };
  return { ok: true, data: Array.from(d).slice(1), nrc: null };
}

/** Build a 0x3D WriteMemoryByAddress request frame. */
export function buildWriteMemoryByAddress(addr, data, alfid = 0x44){
  if (!data || !data.length) throw new Error('buildWriteMemoryByAddress: data is empty');
  const { addrBytes, lenBytes } = encodeAddressAndLength(addr, data.length, alfid);
  return [0x3D, alfid, ...addrBytes, ...lenBytes, ...Array.from(data)];
}

/**
 * Parse a 0x7D WriteMemoryByAddress response. The positive form echoes
 * ALFID + addr + length; we don't validate the echo against the
 * request here (the engine layer already does request/response
 * matching), we just confirm the SID and surface the echoed bytes for
 * any caller that wants to display them.
 */
export function parseWriteMemoryResponse(d){
  if (!d || d.length < 1) return { ok: false, echo: null, nrc: null };
  if (d[0] === 0x7F) return { ok: false, echo: null, nrc: d[2] ?? null };
  if (d[0] !== 0x7D) return { ok: false, echo: null, nrc: null };
  return { ok: true, echo: Array.from(d).slice(1), nrc: null };
}

// ─── RoutineControl 0x31 0x03 (requestRoutineResults) ────────────────

/** Build a 0x31 0x03 routine-result request for a 16-bit routine id. */
export function buildRoutineResult(rid){
  return [0x31, 0x03, (rid >> 8) & 0xFF, rid & 0xFF];
}

/**
 * Parse a 0x71 RoutineControl response. We accept any subfunction so
 * the same helper covers Start/Stop/Result; the caller can compare
 * `control` against the subfunction it sent. `statusRecord` is every
 * byte after the routine ID (often a 1-byte completion code plus
 * routine-specific telemetry).
 */
export function parseRoutineResponse(d){
  if (!d || d.length < 1) return { ok: false, control: null, rid: null, statusRecord: null, nrc: null };
  if (d[0] === 0x7F) return { ok: false, control: null, rid: null, statusRecord: null, nrc: d[2] ?? null };
  if (d[0] !== 0x71 || d.length < 4) return { ok: false, control: null, rid: null, statusRecord: null, nrc: null };
  const control = d[1];
  const rid = (d[2] << 8) | d[3];
  const statusRecord = Array.from(d).slice(4);
  return { ok: true, control, rid, statusRecord, nrc: null };
}

// ─── Multi-DID 0x22 batching ─────────────────────────────────────────

/**
 * Build a 0x22 request that asks for several 16-bit DIDs in one go.
 * Per ISO 14229 the request is `0x22 DID1Hi DID1Lo DID2Hi DID2Lo ...`.
 * We refuse 24-bit DIDs (`>0xFFFF`) here on purpose — those (e.g.
 * `0x6E2025`) are FCA's per-module scoped DIDs and never appear in
 * the standard 0x22 multi-DID flow. The caller should drop them to a
 * single-DID request.
 */
export function buildMultiDidRead(dids){
  if (!dids || !dids.length) throw new Error('buildMultiDidRead: empty list');
  const frame = [0x22];
  for (const did of dids){
    if (typeof did !== 'number' || did < 0 || did > 0xFFFF){
      throw new Error('buildMultiDidRead: DID out of 16-bit range: ' + did);
    }
    frame.push((did >> 8) & 0xFF, did & 0xFF);
  }
  return frame;
}

/**
 * Conservative ISO-TP budget for multi-DID requests. ISO-TP/CAN
 * classic supports up to 4095 bytes per message but real benches
 * occasionally choke on long multi-frame transfers (especially the
 * response side, since some modules truncate at ~256 bytes). We aim
 * for chunks that:
 *   - send a request well below the 256-byte single-burst sweet spot
 *   - leave headroom for a response of ~32 bytes per DID on average
 *
 * Defaults: maxRequestBytes=255, maxResponseBytes=512, avgRespBytesPerDid=32.
 * That works out to ~16 DIDs per request by response budget and ~127
 * by request budget; we honor the tighter of the two.
 */
export function chunkDidsForRequest(dids, opts = {}){
  const maxRequestBytes = opts.maxRequestBytes ?? 255;
  const maxResponseBytes = opts.maxResponseBytes ?? 512;
  const avgRespBytesPerDid = opts.avgRespBytesPerDid ?? 32;
  // Each DID costs 2 bytes in the request (+1 SID once per chunk).
  const byRequest = Math.max(1, Math.floor((maxRequestBytes - 1) / 2));
  // Each DID costs (2 + avg payload) bytes in the response (+1 SID once).
  const byResponse = Math.max(1, Math.floor((maxResponseBytes - 1) / (2 + avgRespBytesPerDid)));
  const perChunk = Math.max(1, Math.min(byRequest, byResponse));
  const out = [];
  for (let i = 0; i < dids.length; i += perChunk){
    out.push(dids.slice(i, i + perChunk));
  }
  return out;
}

/**
 * Split a 0x62 multi-DID positive response back into per-DID rows in
 * the order the caller asked for them.
 *
 * The spec doesn't carry per-DID lengths — the response is just
 * `0x62 DID1Hi DID1Lo data1... DID2Hi DID2Lo data2...`. Without the
 * length the only way to know where one record ends and the next
 * begins is to scan for the next expected DID marker. We do exactly
 * that, in order, refusing to overlap matches: the cursor only ever
 * moves forward, so if a data byte happens to look like a later DID
 * it can't poison an earlier slice. DIDs the module didn't return
 * come back as `{found: false, data: null}` — the UI can flag them
 * the same way single-DID NRC failures are flagged today.
 */
export function splitMultiDidResponse(d, expectedDids){
  const blank = (expectedDids || []).map(did => ({ did, found: false, data: null }));
  if (!d || d.length < 1) return { ok: false, nrc: null, results: blank };
  if (d[0] === 0x7F) return { ok: false, nrc: d[2] ?? null, results: blank };
  if (d[0] !== 0x62) return { ok: false, nrc: null, results: blank };
  const body = Array.from(d).slice(1);
  // Locate each expected DID in order, advancing the cursor so
  // overlapping matches are impossible.
  const positions = [];
  let cursor = 0;
  for (const did of expectedDids){
    const hi = (did >> 8) & 0xFF;
    const lo = did & 0xFF;
    let pos = -1;
    for (let i = cursor; i + 1 < body.length; i++){
      if (body[i] === hi && body[i + 1] === lo){ pos = i; break; }
    }
    positions.push({ did, pos });
    if (pos >= 0) cursor = pos + 2;
  }
  // Slice each DID's data block: from just after its marker to just
  // before the next found marker (or end of body).
  const results = positions.map((entry, i) => {
    if (entry.pos < 0) return { did: entry.did, found: false, data: null };
    const start = entry.pos + 2;
    let end = body.length;
    for (let j = i + 1; j < positions.length; j++){
      if (positions[j].pos >= 0){ end = positions[j].pos; break; }
    }
    return { did: entry.did, found: true, data: body.slice(start, end) };
  });
  return { ok: true, nrc: null, results };
}

/**
 * High-level: read a list of 16-bit DIDs over one or more multi-DID
 * 0x22 requests, falling back to single-DID reads for any DID a chunk
 * couldn't deliver (NRC on the chunk, or DID missing from the split
 * response). Returns a Map keyed by DID number with shape:
 *   { ok: bool, data: number[] | null, nrc: number | null }
 *
 * The fallback is what makes this safe to drop into existing code:
 * even on modules that reject multi-DID requests (some early FCA
 * BCMs do, with NRC 0x13), every DID still gets a chance.
 */
export async function readDidsBatched(engUds, tx, rx, dids, opts = {}){
  const results = new Map();
  const chunks = chunkDidsForRequest(dids, opts);
  for (const chunk of chunks){
    const req = buildMultiDidRead(chunk);
    const r = await engUds(tx, rx, req);
    let chunkOk = false;
    if (r && r.ok && r.d){
      const split = splitMultiDidResponse(r.d, chunk);
      if (split.ok){
        chunkOk = true;
        for (const item of split.results){
          if (item.found){
            results.set(item.did, { ok: true, data: item.data, nrc: null });
          } else if (!results.has(item.did)){
            // Mark as needing the per-DID fallback below.
            results.set(item.did, { ok: false, data: null, nrc: null });
          }
        }
      }
    }
    if (!chunkOk){
      for (const did of chunk){
        if (!results.has(did)) results.set(did, { ok: false, data: null, nrc: null });
      }
    }
    // Per-DID fallback for any DID still marked failed in this chunk.
    for (const did of chunk){
      const cur = results.get(did);
      if (cur && cur.ok) continue;
      const single = await engUds(tx, rx, [0x22, (did >> 8) & 0xFF, did & 0xFF]);
      if (single && single.ok && single.d){
        if (single.d[0] === 0x62){
          results.set(did, { ok: true, data: Array.from(single.d).slice(3), nrc: null });
        } else if (single.d[0] === 0x7F){
          results.set(did, { ok: false, data: null, nrc: single.d[2] ?? null });
        } else {
          results.set(did, { ok: false, data: null, nrc: null });
        }
      } else {
        results.set(did, { ok: false, data: null, nrc: null });
      }
    }
  }
  return results;
}
