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

export const EBML_MAGIC = new Uint8Array([0x1A, 0x45, 0xDF, 0xA3]);

const SECTION_LABELS = {
  '204453': { tag: 'DS', kind: 'plaintext-metadata' },
  '204653': { tag: 'FS', kind: 'encrypted' },
  '20434F': { tag: 'CO', kind: 'checksum' },
  '205550': { tag: 'UP', kind: 'payload' },
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

export function parseEFD(buf, name){
  const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const result = {
    name: name || 'unnamed.efd',
    size: data.length,
    valid: false,
    error: null,
    efdType: 'unknown',
    metadata: {},
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

    // Plaintext metadata sweep.
    if (idHex === '204453'){
      const meta = parseDsMetadata(data, dataStart, elemEnd);
      Object.assign(result.metadata, meta);
    }

    // Capture the encrypted payload location + entropy.
    if (idHex === '205550' && !result.payload){
      const payloadEnd = elemEnd;
      const payloadSize = Math.max(0, payloadEnd - dataStart);
      result.payload = {
        offset: dataStart,
        size: payloadSize,
        entropy: shannonEntropy(data.subarray(dataStart, payloadEnd)),
      };
    }

    pos = elemEnd;
    count++;
    if (pos <= 0 || pos >= data.length) break;
  }

  if (result.metadata.Engine || result.metadata.Program){
    result.efdType = 'mopar_powercal';
  }

  return result;
}

export function isEbmlBuffer(buf){
  if (!buf || buf.length < 4) return false;
  const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return data[0] === EBML_MAGIC[0] && data[1] === EBML_MAGIC[1] &&
         data[2] === EBML_MAGIC[2] && data[3] === EBML_MAGIC[3];
}
