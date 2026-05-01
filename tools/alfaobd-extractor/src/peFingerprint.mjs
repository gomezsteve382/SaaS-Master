/**
 * Minimal PE / .NET-aware fingerprinter.
 *
 * Two responsibilities:
 *   1) `fingerprintPE(buf)` — generic PE32/PE32+ parse: machine, timestamp,
 *      sections (with Shannon entropy), import DLLs, exports.
 *   2) `dotnetMetadata(buf)` — read the COR20 header to confirm a binary is
 *      managed and report the CLR runtime version + assembly name.
 *
 * No third-party dependency. Used by the AlfaOBD extractor for both
 *  - AlfaOBD.exe (managed; we still want the PE timestamp + machine), and
 *  - shfolder(1).dll (we deliberately do NOT decompile this — only
 *    fingerprint it, because it is Safengine-Shielden packed).
 */

const PE_SIGNATURE = 0x00004550; // "PE\0\0"
const DOS_HEADER_SIZE = 64;
const E_LFANEW_OFFSET = 0x3C;
const FILE_HEADER_SIZE = 20;

const MACHINE = {
  0x014c: "I386",
  0x0200: "IA64",
  0x8664: "AMD64",
  0xaa64: "ARM64",
};

const DIRECTORY_INDEX = {
  EXPORT:    0,
  IMPORT:    1,
  RESOURCE:  2,
  COR20:    14,
};

export function fingerprintPE(buf) {
  if (!(buf instanceof Uint8Array)) buf = new Uint8Array(buf);
  if (buf.length < DOS_HEADER_SIZE) throw new Error("PE: buffer too small for DOS header");
  if (buf[0] !== 0x4d || buf[1] !== 0x5a) throw new Error("PE: missing 'MZ' magic");

  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const peOffset = dv.getUint32(E_LFANEW_OFFSET, true);
  if (peOffset + 24 > buf.length) throw new Error("PE: e_lfanew out of range");
  if (dv.getUint32(peOffset, true) !== PE_SIGNATURE) throw new Error("PE: missing 'PE\\0\\0' signature");

  const fileHeaderOffset = peOffset + 4;
  const machine    = dv.getUint16(fileHeaderOffset + 0, true);
  const numSections = dv.getUint16(fileHeaderOffset + 2, true);
  const timestamp   = dv.getUint32(fileHeaderOffset + 4, true);
  const optHdrSize  = dv.getUint16(fileHeaderOffset + 16, true);

  const optHdrOffset = fileHeaderOffset + FILE_HEADER_SIZE;
  if (optHdrOffset + 2 > buf.length) throw new Error("PE: missing optional header");
  const optMagic = dv.getUint16(optHdrOffset, true);
  let isPE32Plus;
  let dirOffset;
  if (optMagic === 0x010b) { isPE32Plus = false; dirOffset = optHdrOffset + 96; }
  else if (optMagic === 0x020b) { isPE32Plus = true;  dirOffset = optHdrOffset + 112; }
  else throw new Error(`PE: unknown optional header magic 0x${optMagic.toString(16)}`);

  const numDataDirs = dv.getUint32(dirOffset - 4, true);
  const directories = [];
  for (let i = 0; i < numDataDirs && i < 16; i++) {
    directories.push({
      virtualAddress: dv.getUint32(dirOffset + i * 8, true),
      size:           dv.getUint32(dirOffset + i * 8 + 4, true),
    });
  }

  const sectionTableOffset = optHdrOffset + optHdrSize;
  const sections = [];
  for (let i = 0; i < numSections; i++) {
    const o = sectionTableOffset + i * 40;
    const nameBytes = buf.slice(o, o + 8);
    let name = "";
    for (const b of nameBytes) { if (b === 0) break; name += String.fromCharCode(b); }
    const virtualSize    = dv.getUint32(o + 8, true);
    const virtualAddress = dv.getUint32(o + 12, true);
    const rawSize        = dv.getUint32(o + 16, true);
    const rawPointer     = dv.getUint32(o + 20, true);
    const characteristics = dv.getUint32(o + 36, true);
    const slice = buf.slice(rawPointer, rawPointer + rawSize);
    sections.push({
      name,
      virtual_address: rvaHex(virtualAddress),
      virtual_size:    virtualSize,
      raw_size:        rawSize,
      raw_pointer:     rawPointer,
      characteristics,
      entropy:         shannon(slice),
    });
  }

  const imports = parseImports(dv, buf, sections, directories[DIRECTORY_INDEX.IMPORT]);
  const exports = parseExports(dv, buf, sections, directories[DIRECTORY_INDEX.EXPORT]);
  const cor20Dir = directories[DIRECTORY_INDEX.COR20];
  const cor20 = cor20Dir && cor20Dir.size ? parseCor20(dv, buf, sections, cor20Dir) : null;

  return {
    machine: MACHINE[machine] || `Unknown(0x${machine.toString(16)})`,
    machine_id: machine,
    pe32_plus: isPE32Plus,
    pe_timestamp: new Date(timestamp * 1000).toISOString(),
    sections,
    imports,
    exports,
    cor20,
    has_resource_dir: !!(directories[DIRECTORY_INDEX.RESOURCE] && directories[DIRECTORY_INDEX.RESOURCE].size),
  };
}

export function dotnetMetadata(peInfo) {
  if (!peInfo || !peInfo.cor20) return { is_dotnet: false };
  return {
    is_dotnet: true,
    clr_version: peInfo.cor20.runtime_version,
    metadata_streams: peInfo.cor20.streams,
  };
}

/* ── Helpers ─────────────────────────────────────────────────────── */
function rvaHex(n) { return "0x" + n.toString(16).toUpperCase().padStart(8, "0"); }

function shannon(bytes) {
  if (!bytes || bytes.length === 0) return 0;
  const freq = new Uint32Array(256);
  for (const b of bytes) freq[b]++;
  let h = 0;
  const n = bytes.length;
  for (const c of freq) {
    if (!c) continue;
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return Math.round(h * 1000) / 1000;
}

function rvaToFileOffset(rva, sections) {
  for (const s of sections) {
    const base = parseInt(s.virtual_address, 16);
    if (rva >= base && rva < base + Math.max(s.virtual_size, s.raw_size)) {
      return s.raw_pointer + (rva - base);
    }
  }
  return null;
}

function readCString(buf, off) {
  let s = "";
  while (off < buf.length && buf[off] !== 0) { s += String.fromCharCode(buf[off]); off++; }
  return s;
}

function parseImports(dv, buf, sections, dir) {
  if (!dir || !dir.size) return [];
  let off = rvaToFileOffset(dir.virtualAddress, sections);
  if (off == null) return [];
  const out = [];
  while (off + 20 <= buf.length) {
    const nameRva = dv.getUint32(off + 12, true);
    if (nameRva === 0 && dv.getUint32(off + 0, true) === 0) break;
    const nameOff = rvaToFileOffset(nameRva, sections);
    if (nameOff != null) out.push(readCString(buf, nameOff));
    off += 20;
    if (out.length > 256) break;
  }
  return out;
}

function parseExports(dv, buf, sections, dir) {
  if (!dir || !dir.size) return [];
  const off = rvaToFileOffset(dir.virtualAddress, sections);
  if (off == null) return [];
  const numNames = dv.getUint32(off + 24, true);
  const namesRva = dv.getUint32(off + 32, true);
  const namesOff = rvaToFileOffset(namesRva, sections);
  if (namesOff == null) return [];
  const out = [];
  for (let i = 0; i < numNames && i < 1024; i++) {
    const nameRva = dv.getUint32(namesOff + i * 4, true);
    const nameOff = rvaToFileOffset(nameRva, sections);
    if (nameOff != null) out.push(readCString(buf, nameOff));
  }
  return out.sort();
}

function parseCor20(dv, buf, sections, dir) {
  const off = rvaToFileOffset(dir.virtualAddress, sections);
  if (off == null) return null;
  if (off + 72 > buf.length) return null;
  const mdRva  = dv.getUint32(off + 8,  true);
  const mdSize = dv.getUint32(off + 12, true);
  const mdOff  = rvaToFileOffset(mdRva, sections);
  if (mdOff == null) return null;
  if (dv.getUint32(mdOff, true) !== 0x424A5342) return null; // "BSJB"
  const verLen = dv.getUint32(mdOff + 12, true);
  const verBytes = buf.slice(mdOff + 16, mdOff + 16 + verLen);
  let runtimeVersion = "";
  for (const b of verBytes) { if (b === 0) break; runtimeVersion += String.fromCharCode(b); }
  const streamsOff = mdOff + 16 + alignUp(verLen, 4);
  const numStreams = dv.getUint16(streamsOff + 2, true);
  const streams = [];
  let p = streamsOff + 4;
  for (let i = 0; i < numStreams && i < 16; i++) {
    if (p + 8 > buf.length) break;
    p += 8;
    let name = "";
    while (p < buf.length && buf[p] !== 0) { name += String.fromCharCode(buf[p]); p++; }
    streams.push(name);
    while (p < buf.length && (p - streamsOff) % 4 !== 0) p++;
  }
  return {
    runtime_version: runtimeVersion,
    metadata_size:   mdSize,
    streams,
  };
}

function alignUp(n, a) { return (n + a - 1) & ~(a - 1); }
