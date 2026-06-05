// EFD / Mopar PowerCal `.webm` container reader (Task #488).
//
// EFD files share the EBML magic prefix used by WebM video, so the same
// element-id / size walking applies. We only need three things from the
// container:
//   - Plaintext metadata in the DS section (`Key = Value` lines).
//   - The EBML structure (top-level sections, with offsets/sizes/labels).
//   - The encrypted payload (`UP` section): offset, size, Shannon
//     entropy. The ECM bootloader decrypts the payload in-place during
//     the `0x36 TransferData` half of the UDS programming session, so we
//     never need to decrypt it ourselves.
//
// AL section (builder metadata):
//   Both ECM and BCM EFDs contain an AL section at the end with nested
//   sub-elements using a custom 3/4-byte ID format:
//     - 3-byte space-prefixed IDs: ' LE' (container), ' AU' (session token)
//     - 4-byte IDs: 0x10 + 3 ASCII chars: CRT (creation timestamp), FGN
//       (tool name), FGV (tool version), CAD (purpose string)
//   Sizes use the 8-byte VINT format: 01 00 00 00 00 00 00 NN
//   CRT is an 8-byte big-endian millisecond Unix timestamp.
//
// BCM EFDs have no DS block — only FS + UP + AL. The AL section provides
// the only human-readable metadata (creation date, builder tool, version).

export const EBML_MAGIC = new Uint8Array([0x1A, 0x45, 0xDF, 0xA3]);

const SECTION_LABELS = {
  '204453': { tag: 'DS', kind: 'plaintext-metadata' },
  '204653': { tag: 'FS', kind: 'encrypted' },
  '20434F': { tag: 'CO', kind: 'checksum' },
  '205550': { tag: 'UP', kind: 'payload' },
  '20414C': { tag: 'AL', kind: 'builder-metadata' },
};

// VINT (variable-length integer) reader. `keepMarker=true` keeps the
// element ID's leading length marker bit (we want this for IDs so that
// `0x1A45DFA3` round-trips to itself); `keepMarker=false` strips it for
// size fields.
function readVint(buf, pos, keepMarker){
  if (pos >= buf.length) return { value: 0, len: 0 };
  const first = buf[pos];
  if (first === 0) return { value: 0, len: 1 };
  let len = 1;
  let mask = 0x80;
  while (!(first & mask) && len < 8){ mask >>= 1; len++; }
  if (pos + len > buf.length) return { value: 0, len };
  let value;
  if (keepMarker){
    value = first;
    for (let i=1;i<len;i++) value = (value * 256) + buf[pos+i];
  } else {
    value = first & (mask - 1);
    for (let i=1;i<len;i++) value = (value * 256) + buf[pos+i];
  }
  return { value, len };
}

function vintToHex(value){
  let s = value.toString(16).toUpperCase();
  if (s.length % 2 === 1) s = '0' + s;
  return s;
}

// Compute Shannon entropy across `data` in bits/byte. Caps the slice at
// 256 KB so even a 4 MB payload entropy check stays under a few ms.
export function shannonEntropy(data, cap){
  const limit = Math.min(data.length, cap || 256 * 1024);
  if (limit === 0) return 0;
  const counts = new Uint32Array(256);
  for (let i=0;i<limit;i++) counts[data[i]]++;
  let h = 0;
  for (let i=0;i<256;i++){
    if (counts[i] === 0) continue;
    const p = counts[i] / limit;
    h -= p * Math.log2(p);
  }
  return h;
}

// Parse plaintext metadata from a DS section. Looks for ASCII `Key = Value`
// lines, splitting on `\n` / `\r` and trimming whitespace. Bails out
// silently for sections that aren't text-shaped.
function parseDsMetadata(buf, start, end){
  const meta = {};
  let lineStart = start;
  for (let i=start;i<=end;i++){
    if (i === end || buf[i] === 0x0A || buf[i] === 0x0D || buf[i] === 0x00){
      if (i > lineStart){
        // ASCII-only filter.
        let ok = true;
        for (let j=lineStart;j<i;j++){
          const b = buf[j];
          if (!(b === 0x09 || (b >= 0x20 && b <= 0x7E))) { ok = false; break; }
        }
        if (ok){
          const line = String.fromCharCode(...buf.subarray(lineStart,i));
          const eq = line.indexOf('=');
          if (eq > 0){
            const key = line.slice(0, eq).trim();
            const value = line.slice(eq + 1).trim();
            if (key && value && /^[A-Za-z][A-Za-z0-9 _\-]*$/.test(key)){
              meta[key] = value;
            }
          }
        }
      }
      lineStart = i + 1;
    }
  }
  return meta;
}

// Read an 8-byte AL-section VINT: 01 00 00 00 00 00 00 NN
// Returns { value, len } where len is the number of bytes consumed.
function readAlVint(buf, pos){
  if (pos >= buf.length) return { value: 0, len: 0 };
  const b = buf[pos];
  if (b === 0x01 && pos + 8 <= buf.length){
    // 8-byte form: 01 00 00 00 00 00 00 NN
    let val = 0;
    for (let i = 1; i < 8; i++) val = val * 256 + buf[pos + i];
    return { value: val, len: 8 };
  }
  // Fallback: standard VINT
  if (b & 0x80) return { value: b & 0x7F, len: 1 };
  if (b & 0x40) return { value: ((b & 0x3F) << 8) | buf[pos + 1], len: 2 };
  if (b & 0x20) return { value: ((b & 0x1F) << 16) | (buf[pos + 1] << 8) | buf[pos + 2], len: 3 };
  return { value: 0, len: 1 };
}

// Decode a 3-byte ASCII ID from the AL section.
function alIdStr(buf, pos, len){
  let s = '';
  for (let i = 0; i < len; i++){
    const c = buf[pos + i];
    s += (c >= 0x20 && c < 0x7F) ? String.fromCharCode(c) : '?';
  }
  return s.trim();
}

// Parse AL section sub-elements. The AL section uses a custom nested format:
//   - 3-byte space-prefixed IDs (0x20 XX XX): ' LE' container, ' AU' session
//   - 4-byte IDs (0x10 XX XX XX): CRT timestamp, FGN tool name, FGV version, CAD purpose
//   - Sizes: 8-byte VINT (01 00 00 00 00 00 00 NN)
// Returns a flat object with decoded fields.
function parseAlElements(buf, start, end){
  const result = {};
  let pos = start;

  while (pos < end && pos < buf.length){
    if (pos + 3 > end) break;
    const b0 = buf[pos];

    let idName, idLen;
    if (b0 === 0x20){
      // 3-byte space-prefixed ID
      idName = alIdStr(buf, pos, 3);
      idLen = 3;
    } else if (b0 === 0x10){
      // 4-byte ID: 0x10 + 3 ASCII chars
      idName = alIdStr(buf, pos + 1, 3);
      idLen = 4;
    } else {
      pos++;
      continue;
    }

    pos += idLen;
    if (pos >= end) break;

    const szR = readAlVint(buf, pos);
    if (!szR.len || szR.value === 0 || szR.value > 10000) { pos++; continue; }
    pos += szR.len;

    const valEnd = Math.min(pos + szR.value, buf.length);
    const val = buf.subarray(pos, valEnd);
    pos = valEnd;

    if (idName === 'LE'){
      // Container — recurse into nested elements
      const nested = parseAlElements(val, 0, val.length);
      Object.assign(result, nested);
    } else if (idName === 'AU'){
      // Session token (short ASCII string)
      result.AU = String.fromCharCode(...val).replace(/\x00/g, '');
    } else if (idName === 'CRT'){
      // 8-byte big-endian millisecond timestamp
      if (val.length === 8){
        let ms = 0;
        for (let i = 0; i < 8; i++) ms = ms * 256 + val[i];
        // Sanity check: must be between 2000-01-01 and 2040-01-01 in ms
        if (ms > 946684800000 && ms < 2208988800000){
          result.CRT_ms = ms;
          const d = new Date(ms);
          result.CRT = d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
        }
      }
    } else if (idName === 'FGN'){
      // Tool name (ASCII)
      result.FGN = String.fromCharCode(...val).replace(/\x00/g, '');
    } else if (idName === 'FGV'){
      // Tool version (ASCII)
      result.FGV = String.fromCharCode(...val).replace(/\x00/g, '');
    } else if (idName === 'CAD'){
      // Purpose string (ASCII)
      result.CAD = String.fromCharCode(...val).replace(/\x00/g, '');
    }
  }

  return result;
}

// Parse the AL section from the top-level EFD buffer.
// The AL element ID is 0x20414C (' AL'), followed by an 8-byte VINT size.
function parseAlSection(buf, dataStart, dataEnd){
  return parseAlElements(buf, dataStart, dataEnd);
}

export function parseEFD(buf, name){
  const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const result = {
    name: name || 'unnamed.efd',
    size: data.length,
    valid: false,
    error: null,
    efdType: 'unknown',
    metadata: {},       // DS section Key=Value pairs (ECM/PCM EFDs)
    builderMeta: {},    // AL section builder metadata (all EFD types)
    sections: [],
    payload: null,
  };

  if (data.length < 4){
    result.error = 'Too small to be EFD/EBML container';
    return result;
  }

  const magicOk = data[0] === EBML_MAGIC[0] && data[1] === EBML_MAGIC[1] &&
                  data[2] === EBML_MAGIC[2] && data[3] === EBML_MAGIC[3];
  if (!magicOk){
    result.error = 'Missing EBML magic (1A 45 DF A3)';
    return result;
  }

  result.valid = true;

  let pos = 0;
  let count = 0;
  // 8 KB scan budget for top-level sections — Mopar PowerCal files top
  // out around a dozen sections.
  while (pos < data.length && count < 64){
    const idR = readVint(data, pos, true);
    if (!idR.len) break;
    const sizeR = readVint(data, pos + idR.len, false);
    if (!sizeR.len) break;

    const idHex = vintToHex(idR.value);
    const dataStart = pos + idR.len + sizeR.len;
    const elemEnd = Math.min(dataStart + sizeR.value, data.length);
    const labelInfo = SECTION_LABELS[idHex] || null;
    const section = {
      offset: pos,
      id: idHex,
      size: sizeR.value,
      dataStart,
      label: labelInfo ? labelInfo.tag : null,
      kind: labelInfo ? labelInfo.kind : null,
    };
    result.sections.push(section);

    // Plaintext metadata sweep (ECM/PCM EFDs only).
    if (idHex === '204453'){
      const meta = parseDsMetadata(data, dataStart, elemEnd);
      Object.assign(result.metadata, meta);
    }

    // Builder metadata from AL section (present in all EFD types).
    if (idHex === '20414C'){
      const alMeta = parseAlSection(data, dataStart, elemEnd);
      Object.assign(result.builderMeta, alMeta);
    }

    // Capture the encrypted payload location + entropy.
    if (idHex === '205550' && !result.payload){
      const payloadEnd = elemEnd;
      const payloadSize = Math.max(0, payloadEnd - dataStart);
      result.payload = {
        offset: dataStart,
        // `size` is the number of payload bytes actually present in the file
        // (clamped to the buffer). `declaredSize` is the raw size the EBML
        // header claims — they differ only when the container is truncated.
        size: payloadSize,
        declaredSize: sizeR.value,
        entropy: shannonEntropy(data.subarray(dataStart, payloadEnd)),
      };
    }

    pos = elemEnd;
    count++;
    if (pos <= 0 || pos >= data.length) break;
  }

  // Determine EFD type:
  //   - ECM/PCM: has DS block with Engine/Program fields
  //   - BCM: no DS block, smaller UP payload (~1 MB vs ~4 MB for ECM)
  //   - Unknown: valid EBML but no recognized structure
  const hasDs = result.sections.some(s => s.label === 'DS');
  if (result.metadata.Engine || result.metadata.Program){
    result.efdType = 'mopar_powercal';
  } else if (!hasDs && result.payload){
    // BCM EFDs are ~1 MB; ECM EFDs are ~4 MB. Use payload size as a hint.
    result.efdType = result.payload.size < 2_000_000 ? 'mopar_bcm' : 'mopar_powercal_noDS';
  }

  return result;
}

export function isEbmlBuffer(buf){
  if (!buf || buf.length < 4) return false;
  const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return data[0] === EBML_MAGIC[0] && data[1] === EBML_MAGIC[1] &&
         data[2] === EBML_MAGIC[2] && data[3] === EBML_MAGIC[3];
}

// Carve the raw UP payload out of an EFD container. This is exactly what the
// original Windows `EFD_Reader.exe` writes to disk: the encrypted payload
// bytes, unmodified. No decryption is performed here (none is by the desktop
// tool either) — the ECM bootloader decrypts the payload in-place during the
// `0x36 TransferData` half of the UDS programming session. The payload is
// located by a proper EBML walk (the UP element id `0x205550`), not a naive
// two-byte id scan, so it is robust to coincidental id bytes inside the blob.
//
// Returns `{ ok:true, offset, size, declaredSize, bytes, parsed }` on success
// or `{ ok:false, error, parsed }` when the file isn't a valid EFD or has no
// payload section.
export function extractEfdPayload(buf, name){
  const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const parsed = parseEFD(data, name);
  if (!parsed.valid){
    return { ok: false, error: parsed.error || 'Not a valid EFD/EBML container', parsed };
  }
  if (!parsed.payload || !parsed.payload.size){
    return { ok: false, error: 'No UP payload section (id 0x205550) found in container', parsed };
  }
  const { offset, size } = parsed.payload;
  const end = Math.min(offset + size, data.length);
  const bytes = data.subarray(offset, end);
  const declaredSize = parsed.payload.declaredSize ?? size;
  return { ok: true, offset, size: bytes.length, declaredSize, bytes, parsed };
}
