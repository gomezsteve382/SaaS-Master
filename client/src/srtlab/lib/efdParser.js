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

// ---------------------------------------------------------------------------
// EFD ZIP PACKAGE PARSER
// ---------------------------------------------------------------------------
// Mopar PowerCal exports EFD calibrations as a zip archive containing:
//   Microprocessor.zip                     — root descriptor
//   MicroprocessorN_LogicalBlock.zip       — one per flash region (N = 18,19,20…)
//     MicroprocessorN_LogicalBlock/
//       PhysicalBlock/
//         CodeData.bin    ← raw, decrypted flash region data
//         Address.txt     ← base address (hex, e.g. "0x40000")
//       AddressRange/
//         StartAddress.txt  ← region start (hex)
//         EndAddress.txt    ← region end   (hex, inclusive)
//   MicroprocessorN_AddScript.zip          — optional add-on scripts
//   MicroprocessorN_PartNumberDefinition.zip
//   MicroprocessorN_SourceFile.zip         — source S19 filename
//
// This parser accepts the OUTER zip (the one you download from PowerCal /
// FCA File .efd Reader) and returns a sorted array of flash blocks.
//
// Requires fflate (already in package.json).
// ---------------------------------------------------------------------------

// Parse a hex address text file entry (e.g. "0x40000" or "262144").
function parseHexAddr(str){
  if (!str) return null;
  const s = str.trim();
  if (s.startsWith('0x') || s.startsWith('0X')) return parseInt(s, 16);
  return parseInt(s, 10);
}

// Human-readable name for a known flash region by address range.
function regionLabel(start, end){
  const size = end - start + 1;
  // MPC5674F / GPEC2A known regions
  if (start === 0x40000  && size === 3407872) return 'INT FLASH (LB18) — Multi-PROG target';
  if (start === 0x380000 && size === 524288)  return 'Secondary P-Flash (LB19)';
  if (start === 0xE000   && size === 5632)    return 'Data Block (LB20)';
  if (start === 0x0      && size === 3932160) return 'Full P-Flash';
  if (start === 0x800000)                     return 'D-Flash';
  return null;
}

/**
 * Parse a Mopar PowerCal EFD zip package.
 *
 * @param {Uint8Array} zipBytes  Raw bytes of the outer .zip file.
 * @param {string}     [name]    Original filename (for display).
 * @returns {EfdZipResult}
 *
 * @typedef {Object} EfdZipResult
 * @property {boolean}     ok
 * @property {string}      [error]
 * @property {string}      name
 * @property {number}      totalSize
 * @property {FlashBlock[]} blocks   Sorted by startAddress.
 * @property {Object}      descriptor  Parsed Microprocessor.zip descriptor fields.
 *
 * @typedef {Object} FlashBlock
 * @property {number}     index        Logical block number (18, 19, 20 …)
 * @property {string}     label        Human-readable region name
 * @property {number}     startAddress
 * @property {number}     endAddress
 * @property {number}     declaredSize  endAddress - startAddress + 1
 * @property {Uint8Array} data          CodeData.bin bytes (may be shorter if truncated)
 * @property {number}     dataSize      data.byteLength
 * @property {boolean}    sizeMatch     dataSize === declaredSize
 * @property {string}     [sourceFile]  S19 source filename if present
 */
export async function parseEfdZipPackage(zipBytes, name){
  const { unzipSync } = await import('fflate');

  const result = {
    ok: false,
    name: name || 'package.zip',
    totalSize: zipBytes.byteLength,
    blocks: [],
    descriptor: {},
    error: null,
  };

  let outerFiles;
  try {
    outerFiles = unzipSync(zipBytes);
  } catch(e){
    result.error = 'Could not unzip outer package: ' + (e.message || e);
    return result;
  }

  // ── Step 1: parse the root Microprocessor.zip descriptor ──────────────────
  const rootZipKey = Object.keys(outerFiles).find(k =>
    /^Microprocessor\.zip$/i.test(k.split('/').pop())
  );
  if (rootZipKey){
    try {
      const rootFiles = unzipSync(outerFiles[rootZipKey]);
      const descKeys = Object.keys(rootFiles);
      for (const k of descKeys){
        const base = k.split('/').pop();
        const text = new TextDecoder().decode(rootFiles[k]).trim();
        if (base === 'Description.txt')  result.descriptor.description  = text;
        if (base === 'Comment.txt')      result.descriptor.comment      = text;
        if (base === 'FileSignature.txt') result.descriptor.fileSignature = text;
      }
    } catch { /* ignore descriptor parse errors */ }
  }

  // ── Step 2: find all LogicalBlock zips ────────────────────────────────────
  const lbZipKeys = Object.keys(outerFiles).filter(k =>
    /Microprocessor\d+_LogicalBlock\.zip$/i.test(k.split('/').pop())
  );

  if (lbZipKeys.length === 0){
    result.error = 'No MicroprocessorN_LogicalBlock.zip entries found — is this a PowerCal EFD package?';
    return result;
  }

  // ── Step 3: parse each LogicalBlock zip ───────────────────────────────────
  for (const lbKey of lbZipKeys){
    const m = lbKey.match(/Microprocessor(\d+)_LogicalBlock\.zip/i);
    const idx = m ? parseInt(m[1], 10) : 0;

    let lbFiles;
    try {
      lbFiles = unzipSync(outerFiles[lbKey]);
    } catch { continue; }

    // Locate CodeData.bin, Address.txt, StartAddress.txt, EndAddress.txt
    let codeData = null, startAddr = null, endAddr = null, sourceFile = null;
    for (const [path, bytes] of Object.entries(lbFiles)){
      const parts = path.split('/');
      const base  = parts[parts.length - 1];
      const dir   = parts[parts.length - 2] || '';

      if (base === 'CodeData.bin' && dir === 'PhysicalBlock'){
        codeData = bytes;
      } else if ((base === 'Address.txt' || base === 'StartAddress.txt') && dir === 'AddressRange'){
        startAddr = parseHexAddr(new TextDecoder().decode(bytes));
      } else if (base === 'StartAddress.txt' && dir === 'AddressRange' && startAddr === null){
        startAddr = parseHexAddr(new TextDecoder().decode(bytes));
      } else if (base === 'EndAddress.txt' && dir === 'AddressRange'){
        endAddr = parseHexAddr(new TextDecoder().decode(bytes));
      } else if (base === 'StartAddress.txt'){
        // fallback — some zips nest differently
        if (startAddr === null)
          startAddr = parseHexAddr(new TextDecoder().decode(bytes));
      } else if (base === 'EndAddress.txt'){
        if (endAddr === null)
          endAddr = parseHexAddr(new TextDecoder().decode(bytes));
      }
    }

    // Also grab StartAddress from PhysicalBlock/Address.txt if AddressRange is missing
    if (startAddr === null){
      for (const [path, bytes] of Object.entries(lbFiles)){
        const parts = path.split('/');
        const base  = parts[parts.length - 1];
        const dir   = parts[parts.length - 2] || '';
        if (base === 'Address.txt' && dir === 'PhysicalBlock'){
          startAddr = parseHexAddr(new TextDecoder().decode(bytes));
        }
      }
    }

    if (!codeData || startAddr === null || endAddr === null) continue;

    // Try to find source S19 filename from MicroprocessorN_SourceFile.zip
    const sfKey = Object.keys(outerFiles).find(k =>
      new RegExp(`Microprocessor${idx}_SourceFile\.zip`, 'i').test(k.split('/').pop())
    );
    if (sfKey){
      try {
        const sfFiles = unzipSync(outerFiles[sfKey]);
        for (const [path, bytes] of Object.entries(sfFiles)){
          if (path.split('/').pop() === 'SourceFileName.txt'){
            sourceFile = new TextDecoder().decode(bytes).trim();
          }
        }
      } catch { /* ignore */ }
    }

    const declaredSize = endAddr - startAddr + 1;
    const label = regionLabel(startAddr, endAddr) || `Block ${idx} @ 0x${startAddr.toString(16).toUpperCase()}`;

    result.blocks.push({
      index: idx,
      label,
      startAddress: startAddr,
      endAddress:   endAddr,
      declaredSize,
      data:      codeData,
      dataSize:  codeData.byteLength,
      sizeMatch: codeData.byteLength === declaredSize,
      sourceFile: sourceFile || null,
    });
  }

  if (result.blocks.length === 0){
    result.error = 'Found LogicalBlock zips but could not extract any CodeData.bin + address range pairs.';
    return result;
  }

  // Sort by start address
  result.blocks.sort((a, b) => a.startAddress - b.startAddress);
  result.ok = true;
  return result;
}

/**
 * Build a contiguous full-flash binary image from an EfdZipResult.
 * Fills gaps between blocks with 0xFF (erased flash).
 * Returns null if blocks is empty.
 *
 * @param {FlashBlock[]} blocks
 * @returns {{ image: Uint8Array, startAddress: number, endAddress: number } | null}
 */
export function buildFullFlashImage(blocks){
  if (!blocks || blocks.length === 0) return null;
  const sorted = [...blocks].sort((a, b) => a.startAddress - b.startAddress);
  const imageStart = sorted[0].startAddress;
  const imageEnd   = sorted[sorted.length - 1].endAddress;
  const imageSize  = imageEnd - imageStart + 1;
  const image = new Uint8Array(imageSize).fill(0xFF);
  for (const blk of sorted){
    const offset = blk.startAddress - imageStart;
    const src    = blk.data.subarray(0, Math.min(blk.dataSize, blk.declaredSize));
    image.set(src, offset);
  }
  return { image, startAddress: imageStart, endAddress: imageEnd };
}

// ---------------------------------------------------------------------------
// BENCH WRITE VALIDATOR
// ---------------------------------------------------------------------------
// Known flash region sizes for Mopar/FCA ECUs supported by Multi-PROG.
// Each entry: { ecu, region, startAddress, endAddress, size, programmer, notes }
// ---------------------------------------------------------------------------

export const BENCH_WRITE_REGIONS = [
  // ── MPC5674F (GPEC2A / GPEC2B — 6.4L / 5.7L / 3.6L Pentastar) ──────────
  { ecu:'GPEC2A/GPEC2B', region:'INT FLASH (LB18)',      startAddress:0x040000, endAddress:0x37FFFF, size:3407872, programmer:'Multi-PROG', notes:'Primary calibration region — most common write target' },
  { ecu:'GPEC2A/GPEC2B', region:'Secondary P-Flash (LB19)', startAddress:0x380000, endAddress:0x3FFFFF, size:524288,  programmer:'Multi-PROG', notes:'Secondary code region' },
  { ecu:'GPEC2A/GPEC2B', region:'Data Block (LB20)',     startAddress:0x00E000, endAddress:0x00F5FF, size:5632,    programmer:'Multi-PROG', notes:'Small data/config block' },
  { ecu:'GPEC2A/GPEC2B', region:'Full P-Flash',          startAddress:0x000000, endAddress:0x3FFFFF, size:4194304, programmer:'Multi-PROG', notes:'Complete P-Flash image (all LBs)' },
  { ecu:'GPEC2A/GPEC2B', region:'P-Flash (no data)',     startAddress:0x040000, endAddress:0x3FFFFF, size:3932160, programmer:'Multi-PROG', notes:'P-Flash minus data block (LB18+LB19)' },
  // ── MPC5606B (BCM — LH/LD Charger/Challenger/300) ───────────────────────
  { ecu:'MPC5606B BCM',  region:'INT FLASH',             startAddress:0x000000, endAddress:0x0FFFFF, size:1048576, programmer:'Multi-PROG', notes:'BCM full internal flash' },
  { ecu:'MPC5606B BCM',  region:'INT FLASH (half)',      startAddress:0x000000, endAddress:0x07FFFF, size:524288,  programmer:'Multi-PROG', notes:'BCM half-flash (some variants)' },
  // ── MPC5607B (TCM — ZF 8HP) ──────────────────────────────────────────────
  { ecu:'MPC5607B TCM',  region:'INT FLASH',             startAddress:0x000000, endAddress:0x1FFFFF, size:2097152, programmer:'Multi-PROG', notes:'TCM full internal flash' },
  // ── SPC5777 (GPEC3 — Hellcat / Demon / Redeye) ───────────────────────────
  { ecu:'SPC5777 GPEC3', region:'INT FLASH',             startAddress:0x000000, endAddress:0x1FFFFF, size:2097152, programmer:'Multi-PROG', notes:'Hellcat/Demon/Redeye ECM' },
  { ecu:'SPC5777 GPEC3', region:'INT FLASH (large)',     startAddress:0x000000, endAddress:0x3FFFFF, size:4194304, programmer:'Multi-PROG', notes:'Larger SPC5777 variant' },
  // ── EEPROM / RFHUB ────────────────────────────────────────────────────────
  { ecu:'RFHUB 24C32',   region:'EEPROM (4 KB)',         startAddress:0x000000, endAddress:0x000FFF, size:4096,    programmer:'Multi-PROG / SOIC8', notes:'Standard RFHUB — Charger/Challenger/300' },
  { ecu:'RFHUB 24C32 WK2', region:'EEPROM (8 KB doubled)', startAddress:0x000000, endAddress:0x001FFF, size:8192, programmer:'Multi-PROG / SOIC8', notes:'Trackhawk WK2 — doubled 24C32 dump' },
  { ecu:'XC2268 RFHUB',  region:'EEPROM (16 KB)',        startAddress:0x000000, endAddress:0x003FFF, size:16384,   programmer:'SOIC8 adapter', notes:'XC2268 variant — not Gen2 compatible' },
  // ── BCM EEPROM ────────────────────────────────────────────────────────────
  { ecu:'BCM EEPROM',    region:'EEPROM (2 KB)',         startAddress:0x000000, endAddress:0x0007FF, size:2048,    programmer:'Multi-PROG / SOIC8', notes:'BCM EEPROM — 24C16 or similar' },
  { ecu:'BCM EEPROM',    region:'EEPROM (8 KB)',         startAddress:0x000000, endAddress:0x001FFF, size:8192,    programmer:'Multi-PROG / SOIC8', notes:'BCM EEPROM — larger variant' },
];

/**
 * Validate a binary file's size against known Multi-PROG flash regions.
 *
 * @param {number}  byteLength  File size in bytes.
 * @param {string}  [filename]  Optional filename for context.
 * @returns {BenchValidateResult}
 *
 * @typedef {Object} BenchValidateResult
 * @property {boolean}  pass         True if at least one region matches exactly.
 * @property {number}   byteLength
 * @property {string}   [filename]
 * @property {BenchRegionMatch[]} matches  All regions whose size matches exactly.
 * @property {BenchRegionMatch[]} close    Regions within ±10% of the file size (no exact match).
 *
 * @typedef {Object} BenchRegionMatch
 * @property {string}  ecu
 * @property {string}  region
 * @property {number}  size
 * @property {string}  programmer
 * @property {string}  notes
 * @property {number}  [delta]  Signed byte difference (close matches only)
 */
export function benchWriteValidate(byteLength, filename){
  const matches = BENCH_WRITE_REGIONS.filter(r => r.size === byteLength);
  const close   = matches.length === 0
    ? BENCH_WRITE_REGIONS
        .filter(r => Math.abs(r.size - byteLength) / r.size < 0.10)
        .map(r => ({ ...r, delta: byteLength - r.size }))
    : [];
  return {
    pass: matches.length > 0,
    byteLength,
    filename: filename || null,
    matches,
    close,
  };
}

// ---------------------------------------------------------------------------
// EFD / BIN FILENAME PARSER
// ---------------------------------------------------------------------------
// Extracts calibration context from Mopar PowerCal zip/bin filenames.
// Examples:
//   18SCAT_ECM_INTFLASH.bin  → { year:2018, program:'SCAT', module:'ECM', region:'INTFLASH' }
//   19LD64_BCM_CFLASH.zip    → { year:2019, program:'LD64', module:'BCM', region:'CFLASH' }
//   2018GPEC2A_P14U_ENG.zip  → { year:2018, ecu:'GPEC2A', part:'P14U' }
// ---------------------------------------------------------------------------

const MODULE_PATTERNS = [
  { re: /\bECM\b/i,   module:'ECM',   desc:'Engine Control Module' },
  { re: /\bPCM\b/i,   module:'PCM',   desc:'Powertrain Control Module' },
  { re: /\bBCM\b/i,   module:'BCM',   desc:'Body Control Module' },
  { re: /\bTCM\b/i,   module:'TCM',   desc:'Transmission Control Module' },
  { re: /\bRFH(UB)?\b/i, module:'RFHUB', desc:'RF Hub' },
  { re: /\bABS\b/i,   module:'ABS',   desc:'ABS Module' },
  { re: /\bEPS\b/i,   module:'EPS',   desc:'Electric Power Steering' },
  { re: /\bACM\b/i,   module:'ACM',   desc:'Airbag Control Module' },
];

const PROGRAM_PATTERNS = [
  { re: /\bSCAT\b/i,       program:'SCAT',       desc:'Scat Pack (6.4L 392)' },
  { re: /\bHELLCAT\b/i,   program:'HELLCAT',    desc:'Hellcat (6.2L Supercharged)' },
  { re: /\bDEMON\b/i,     program:'DEMON',      desc:'Demon (6.2L Supercharged)' },
  { re: /\bREDEYE\b/i,    program:'REDEYE',     desc:'Redeye (6.2L Supercharged)' },
  { re: /\bJAILBREAK\b/i, program:'JAILBREAK',  desc:'Jailbreak (6.2L Supercharged)' },
  { re: /\bLD64\b/i,      program:'LD64',       desc:'6.4L 392 HEMI (LD platform)' },
  { re: /\bLD6\b/i,       program:'LD6',        desc:'6.2L Supercharged (LD platform)' },
  { re: /\bLC6\b/i,       program:'LC6',        desc:'6.2L Supercharged (LC platform)' },
  { re: /\bLC4\b/i,       program:'LC4',        desc:'6.4L 392 (LC platform)' },
  { re: /\bLX4\b/i,       program:'LX4',        desc:'6.4L 392 (LX platform)' },
  { re: /\bLX6\b/i,       program:'LX6',        desc:'6.2L Supercharged (LX platform)' },
  { re: /\bGPEC2A\b/i,    program:'GPEC2A',     desc:'Continental GPEC2A ECU' },
  { re: /\bGPEC2B\b/i,    program:'GPEC2B',     desc:'Continental GPEC2B ECU' },
  { re: /\bGPEC3\b/i,     program:'GPEC3',      desc:'Continental GPEC3 ECU (Hellcat/Demon)' },
  { re: /\bP14U\b/i,      program:'P14U',       desc:'GPEC2A 6.4L program code' },
  { re: /\bP13U\b/i,      program:'P13U',       desc:'GPEC2A 5.7L program code' },
  { re: /\bP16U\b/i,      program:'P16U',       desc:'GPEC2A 3.6L Pentastar program code' },
  { re: /\bP17U\b/i,      program:'P17U',       desc:'GPEC2A 6.4L alt program code' },
  { re: /\bP15U\b/i,      program:'P15U',       desc:'GPEC2A 5.7L alt program code' },
];

const REGION_PATTERNS = [
  { re: /\bINTFLASH\b/i,  region:'INTFLASH',  desc:'Internal Flash (LB18)' },
  { re: /\bCFLASH\b/i,    region:'CFLASH',    desc:'Cold Flash (full P-Flash)' },
  { re: /\bEEPROM\b/i,    region:'EEPROM',    desc:'EEPROM' },
  { re: /\bDFLASH\b/i,    region:'DFLASH',    desc:'D-Flash' },
  { re: /\bFULL\b/i,      region:'FULL',      desc:'Full flash image' },
];

const ENGINE_PATTERNS = [
  { re: /\b6\.4L?\b/i,    engine:'6.4L',    desc:'6.4L 392 HEMI' },
  { re: /\b6\.2L?\b/i,    engine:'6.2L',    desc:'6.2L Supercharged HEMI' },
  { re: /\b5\.7L?\b/i,    engine:'5.7L',    desc:'5.7L HEMI' },
  { re: /\b3\.6L?\b/i,    engine:'3.6L',    desc:'3.6L Pentastar V6' },
  { re: /\b392\b/,        engine:'392',     desc:'392 HEMI (6.4L)' },
  { re: /\b426\b/,        engine:'426',     desc:'426 HEMI (Demon/Jailbreak)' },
  { re: /\bHEMI\b/i,      engine:'HEMI',    desc:'HEMI engine family' },
];

/**
 * Parse calibration context from an EFD zip or bin filename.
 *
 * @param {string} filename
 * @returns {EfdFilenameInfo}
 *
 * @typedef {Object} EfdFilenameInfo
 * @property {number|null}  year
 * @property {string|null}  module      ECM, BCM, TCM, etc.
 * @property {string|null}  moduleDesc
 * @property {string|null}  program     SCAT, GPEC2A, LD64, etc.
 * @property {string|null}  programDesc
 * @property {string|null}  region      INTFLASH, CFLASH, etc.
 * @property {string|null}  regionDesc
 * @property {string|null}  engine
 * @property {string|null}  engineDesc
 * @property {string}       summary     Human-readable one-liner
 */
export function parseEfdFilename(filename){
  if (!filename) return _emptyFilenameInfo();
  // Strip extension and replace separators with spaces for matching
  const base = filename.replace(/\.(zip|efd|webm|bin|s19)$/i, '').replace(/[_\-\.]/g, ' ');
  // Strip leading year digits for word-boundary matching (e.g. '18SCAT' -> 'SCAT').
  // JS \b treats digits and letters both as \w so '18SCAT' has no boundary before 'S'.
  const baseNY = base.replace(/^\d+\s*/, '');

  // Year: look for 4-digit (2016-2026) or 2-digit (16-26) at start or after space.
  // Filenames like '18SCAT', '19LD64', '2018GPEC2A' have no word boundary between
  // the year digits and the following letters, so we use start-of-string / space anchors.
  let year = null;
  const yr4 = base.match(/(?:^| )(20(1[6-9]|2[0-6]))(?=[A-Za-z_ ]|$)/);
  const yr2 = base.match(/(?:^| )(1[6-9]|2[0-6])(?=[A-Za-z_ ]|$)/);
  if (yr4) year = parseInt(yr4[1], 10);
  else if (yr2) year = 2000 + parseInt(yr2[1], 10);

  let module = null, moduleDesc = null;
  for (const p of MODULE_PATTERNS){
    if (p.re.test(baseNY)){ module = p.module; moduleDesc = p.desc; break; }
  }

  let program = null, programDesc = null;
  for (const p of PROGRAM_PATTERNS){
    if (p.re.test(baseNY)){ program = p.program; programDesc = p.desc; break; }
  }

  let region = null, regionDesc = null;
  for (const p of REGION_PATTERNS){
    if (p.re.test(baseNY)){ region = p.region; regionDesc = p.desc; break; }
  }

  let engine = null, engineDesc = null;
  for (const p of ENGINE_PATTERNS){
    if (p.re.test(baseNY)){ engine = p.engine; engineDesc = p.desc; break; }
  }

  // Build summary
  const parts = [];
  if (year)        parts.push(year.toString());
  if (program)     parts.push(program);
  if (module)      parts.push(module);
  if (engine)      parts.push(engine);
  if (region)      parts.push(region);
  const summary = parts.length ? parts.join(' · ') : 'Unknown calibration';

  return { year, module, moduleDesc, program, programDesc, region, regionDesc, engine, engineDesc, summary };
}

function _emptyFilenameInfo(){
  return { year:null, module:null, moduleDesc:null, program:null, programDesc:null,
           region:null, regionDesc:null, engine:null, engineDesc:null, summary:'Unknown calibration' };
}

// ---------------------------------------------------------------------------
// BLOCK DIFF
// ---------------------------------------------------------------------------
// Compare two sets of FlashBlock arrays (from parseEfdZipPackage) block by block.
// Returns a diff result for each matching block index.
// ---------------------------------------------------------------------------

/**
 * Diff two EfdZipResult block arrays.
 *
 * @param {FlashBlock[]} blocksA
 * @param {FlashBlock[]} blocksB
 * @returns {BlockDiffResult[]}
 *
 * @typedef {Object} BlockDiffResult
 * @property {number}   index
 * @property {string}   label
 * @property {boolean}  onlyInA
 * @property {boolean}  onlyInB
 * @property {boolean}  identical
 * @property {number}   changedBytes
 * @property {number}   totalBytes
 * @property {number}   pctChanged
 * @property {DiffHunk[]} hunks  Contiguous changed regions (max 500 hunks)
 *
 * @typedef {Object} DiffHunk
 * @property {number} offset
 * @property {Uint8Array} a
 * @property {Uint8Array} b
 */
export function diffEfdBlocks(blocksA, blocksB){
  const byIndex = (arr) => {
    const m = {};
    for (const b of arr) m[b.index] = b;
    return m;
  };
  const mapA = byIndex(blocksA || []);
  const mapB = byIndex(blocksB || []);
  const allIdx = [...new Set([...Object.keys(mapA), ...Object.keys(mapB)].map(Number))].sort((a,b)=>a-b);

  return allIdx.map(idx => {
    const blkA = mapA[idx];
    const blkB = mapB[idx];
    if (!blkA) return { index:idx, label: blkB.label, onlyInA:false, onlyInB:true,  identical:false, changedBytes:blkB.dataSize, totalBytes:blkB.dataSize, pctChanged:100, hunks:[] };
    if (!blkB) return { index:idx, label: blkA.label, onlyInA:true,  onlyInB:false, identical:false, changedBytes:blkA.dataSize, totalBytes:blkA.dataSize, pctChanged:100, hunks:[] };

    const len = Math.max(blkA.dataSize, blkB.dataSize);
    const a   = blkA.data;
    const b   = blkB.data;
    let changedBytes = 0;
    const hunks = [];
    let hunkStart = -1;
    const MAX_HUNKS = 500;
    const HUNK_CTX  = 8;  // bytes of context around each change

    for (let i = 0; i < len; i++){
      const byteA = i < a.length ? a[i] : 0xFF;
      const byteB = i < b.length ? b[i] : 0xFF;
      if (byteA !== byteB){
        changedBytes++;
        if (hunkStart === -1) hunkStart = i;
      } else if (hunkStart !== -1 && i - hunkStart > HUNK_CTX){
        // close hunk
        if (hunks.length < MAX_HUNKS){
          const s = Math.max(0, hunkStart - HUNK_CTX);
          const e = Math.min(len, i + HUNK_CTX);
          hunks.push({
            offset: s,
            a: a.slice(s, e),
            b: b.slice(s, e),
          });
        }
        hunkStart = -1;
      }
    }
    if (hunkStart !== -1 && hunks.length < MAX_HUNKS){
      const s = Math.max(0, hunkStart - HUNK_CTX);
      hunks.push({ offset: s, a: a.slice(s), b: b.slice(s) });
    }

    return {
      index: idx,
      label: blkA.label || blkB.label,
      onlyInA: false,
      onlyInB: false,
      identical: changedBytes === 0,
      changedBytes,
      totalBytes: len,
      pctChanged: len > 0 ? (changedBytes / len) * 100 : 0,
      hunks,
    };
  });
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
