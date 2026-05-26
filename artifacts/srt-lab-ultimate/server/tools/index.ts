/**
 * SRT Lab Binary Analysis Tool Registry — v3 (Pure Node.js)
 *
 * ALL tools use pure Node.js/npm packages — NO system binaries (strings, xxd, objdump, python3, etc.)
 * This ensures tools work in production (minimal Node.js container) without binutils/python.
 */
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import * as zlib from "zlib";

// ─── Tool Type ───────────────────────────────────────────────────────────────
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required?: string[];
  };
  call(args: Record<string, unknown>, filePath: string): Promise<string>;
}

// ─── Pure JS Helpers ─────────────────────────────────────────────────────────

/** Format a buffer region as xxd-style hex dump */
function hexDump(buf: Buffer, startOffset = 0): string {
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i += 16) {
    const addr = (startOffset + i).toString(16).padStart(8, "0");
    const hexParts: string[] = [];
    let ascii = "";
    for (let j = 0; j < 16; j++) {
      if (i + j < buf.length) {
        hexParts.push(buf[i + j].toString(16).padStart(2, "0"));
        const ch = buf[i + j];
        ascii += ch >= 0x20 && ch <= 0x7e ? String.fromCharCode(ch) : ".";
      } else {
        hexParts.push("  ");
        ascii += " ";
      }
    }
    const hex = hexParts.slice(0, 8).join(" ") + "  " + hexParts.slice(8).join(" ");
    lines.push(`${addr}: ${hex}  ${ascii}`);
  }
  return lines.join("\n");
}

/** Extract printable ASCII strings from a buffer with offsets */
function extractStrings(buf: Buffer, minLen = 4, encoding: "ascii" | "utf16le" = "ascii"): Array<{ offset: number; str: string }> {
  const results: Array<{ offset: number; str: string }> = [];

  if (encoding === "utf16le") {
    let current = "";
    let startOffset = 0;
    for (let i = 0; i < buf.length - 1; i += 2) {
      const code = buf[i] | (buf[i + 1] << 8);
      if (code >= 0x20 && code <= 0x7e) {
        if (current.length === 0) startOffset = i;
        current += String.fromCharCode(code);
      } else {
        if (current.length >= minLen) {
          results.push({ offset: startOffset, str: current });
        }
        current = "";
      }
    }
    if (current.length >= minLen) {
      results.push({ offset: startOffset, str: current });
    }
  } else {
    let current = "";
    let startOffset = 0;
    for (let i = 0; i < buf.length; i++) {
      const ch = buf[i];
      if (ch >= 0x20 && ch <= 0x7e) {
        if (current.length === 0) startOffset = i;
        current += String.fromCharCode(ch);
      } else {
        if (current.length >= minLen) {
          results.push({ offset: startOffset, str: current });
        }
        current = "";
      }
    }
    if (current.length >= minLen) {
      results.push({ offset: startOffset, str: current });
    }
  }
  return results;
}

/** Calculate Shannon entropy of a buffer */
function calcEntropy(buf: Buffer): number {
  if (buf.length === 0) return 0;
  const freq = new Array(256).fill(0);
  for (let i = 0; i < buf.length; i++) freq[buf[i]]++;
  let entropy = 0;
  for (const f of freq) {
    if (f > 0) {
      const p = f / buf.length;
      entropy -= p * Math.log2(p);
    }
  }
  return entropy;
}

/** Search for a byte pattern in a buffer, return all offsets */
function findPattern(buf: Buffer, pattern: Buffer, maxHits = 50): number[] {
  const offsets: number[] = [];
  let pos = 0;
  while (pos < buf.length && offsets.length < maxHits) {
    const idx = buf.indexOf(pattern, pos);
    if (idx === -1) break;
    offsets.push(idx);
    pos = idx + 1;
  }
  return offsets;
}

/** Detect file type from magic bytes */
function detectFileType(header: Buffer): { type: string; mime: string } {
  // PE / MZ
  if (header[0] === 0x4D && header[1] === 0x5A) {
    return { type: "PE32 executable (Windows)", mime: "application/x-dosexec" };
  }
  // ELF
  if (header[0] === 0x7F && header[1] === 0x45 && header[2] === 0x4C && header[3] === 0x46) {
    const bits = header[4] === 2 ? "64-bit" : "32-bit";
    return { type: `ELF ${bits} executable`, mime: "application/x-elf" };
  }
  // Intel HEX
  if (header[0] === 0x3A) {
    return { type: "Intel HEX firmware", mime: "application/octet-stream" };
  }
  // Motorola S-Record
  if (header[0] === 0x53 && (header[1] >= 0x30 && header[1] <= 0x39)) {
    return { type: "Motorola S-Record firmware", mime: "application/octet-stream" };
  }
  // ZIP/JAR
  if (header[0] === 0x50 && header[1] === 0x4B) {
    return { type: "ZIP archive", mime: "application/zip" };
  }
  // PDF
  if (header.slice(0, 4).toString() === "%PDF") {
    return { type: "PDF document", mime: "application/pdf" };
  }
  // GZIP (tar.gz, .gz)
  if (header[0] === 0x1F && header[1] === 0x8B) {
    return { type: "GZIP compressed archive", mime: "application/gzip" };
  }
  // TAR (ustar magic at offset 257)
  if (header.length > 262 && header.slice(257, 262).toString() === "ustar") {
    return { type: "TAR archive", mime: "application/x-tar" };
  }
  // 7z
  if (header[0] === 0x37 && header[1] === 0x7A && header[2] === 0xBC && header[3] === 0xAF) {
    return { type: "7-Zip archive", mime: "application/x-7z-compressed" };
  }
  // RAR
  if (header[0] === 0x52 && header[1] === 0x61 && header[2] === 0x72 && header[3] === 0x21) {
    return { type: "RAR archive", mime: "application/x-rar-compressed" };
  }
  // SWF (Adobe Flash) — CWS (zlib-compressed), FWS (uncompressed), ZWS (LZMA-compressed)
  if (
    (header[0] === 0x43 && header[1] === 0x57 && header[2] === 0x53) || // CWS — zlib compressed
    (header[0] === 0x46 && header[1] === 0x57 && header[2] === 0x53) || // FWS — uncompressed
    (header[0] === 0x5A && header[1] === 0x57 && header[2] === 0x53)    // ZWS — LZMA compressed
  ) {
    const compression = header[0] === 0x43 ? "zlib-compressed (CWS)" : header[0] === 0x5A ? "LZMA-compressed (ZWS)" : "uncompressed (FWS)";
    const version = header[3];
    return {
      type: `Adobe Flash SWF file — ${compression} — SWF version ${version} — CALL swf_extract IMMEDIATELY to decompress and analyze ActionScript bytecode`,
      mime: "application/x-shockwave-flash",
    };
  }
  // HTML / XML — detect web bundles that are NOT firmware
  const headerStr = header.slice(0, 64).toString("utf8").trim().toLowerCase();
  if (headerStr.startsWith("<!doctype html") || headerStr.startsWith("<html") || headerStr.startsWith("<?xml")) {
    const isHtml = headerStr.includes("html");
    return {
      type: isHtml ? "HTML document (NOT firmware — web application bundle)" : "XML document",
      mime: isHtml ? "text/html" : "application/xml",
    };
  }
  // JSON
  if (header[0] === 0x7B || (header[0] === 0x5B)) {
    return { type: "JSON data", mime: "application/json" };
  }
  // Check entropy for binary classification
  const entropy = calcEntropy(header);
  if (entropy > 7.5) return { type: "Encrypted/compressed binary data", mime: "application/octet-stream" };
  if (entropy > 5.5) return { type: "Compiled binary data", mime: "application/octet-stream" };
  return { type: "Data file", mime: "application/octet-stream" };
}

// ─── PE Parser (pure JS using pe-library) ────────────────────────────────────

interface PESection {
  name: string;
  virtualAddress: string;
  virtualSize: number;
  rawSize: number;
  rawOffset: string;
  entropy: number;
  note: string;
}

async function parsePE(filePath: string, section: string): Promise<string> {
  try {
    const { NtExecutable, NtExecutableResource } = await import("pe-library");
    const data = await fs.readFile(filePath);
    const exe = NtExecutable.from(data);

    const result: string[] = [];

    if (section === "all" || section === "headers") {
      result.push("═══ PE HEADERS ═══");
      const dh = exe.dosHeader;
      const nh = exe.newHeader;
      if (nh) {
        result.push(`Machine: 0x${nh.fileHeader.machine.toString(16)}`);
        result.push(`Timestamp: ${nh.fileHeader.timeDateStamp}`);
        result.push(`Number of sections: ${nh.fileHeader.numberOfSections}`);
        result.push(`Characteristics: 0x${nh.fileHeader.characteristics.toString(16)}`);
        if (nh.optionalHeader) {
          result.push(`Entry point: 0x${nh.optionalHeader.addressOfEntryPoint.toString(16)}`);
          result.push(`Image base: 0x${nh.optionalHeader.imageBase.toString(16)}`);
          result.push(`Subsystem: ${nh.optionalHeader.subsystem}`);
        }
      }
    }

    if (section === "all" || section === "sections") {
      result.push("\n═══ SECTIONS ═══");
      const sections = exe.getAllSections();
      for (const sec of sections) {
        const secData = sec.data ? Buffer.from(sec.data) : Buffer.alloc(0);
        const entropy = secData.length > 0 ? calcEntropy(secData) : 0;
        const note = entropy > 7.0 ? " ◄ HIGH ENTROPY (packed/encrypted)" : "";
        const name = Buffer.from(sec.info.name).toString().replace(/\0/g, "");
        result.push(`  ${name.padEnd(10)} VAddr: 0x${sec.info.virtualAddress.toString(16).padStart(8, "0")} VSize: ${sec.info.virtualSize} RawSize: ${sec.info.sizeOfRawData} Entropy: ${entropy.toFixed(3)}${note}`);
      }
    }

    if (section === "all" || section === "imports") {
      result.push("\n═══ IMPORTS ═══");
      // Parse import directory manually from the binary
      const importInfo = parsePEImports(data);
      if (importInfo.length > 0) {
        result.push(`Total imported DLLs: ${importInfo.length}`);
        let totalFuncs = 0;
        for (const imp of importInfo) {
          result.push(`\n  ${imp.dll} (${imp.functions.length} functions):`);
          for (const fn of imp.functions.slice(0, 30)) {
            result.push(`    ${fn}`);
          }
          if (imp.functions.length > 30) {
            result.push(`    ... (${imp.functions.length - 30} more)`);
          }
          totalFuncs += imp.functions.length;
        }
        result.push(`\nTotal imported functions: ${totalFuncs}`);
      } else {
        result.push("  No imports found (or import table not parseable)");
      }
    }

    if (section === "all" || section === "resources") {
      result.push("\n═══ RESOURCES ═══");
      try {
        const res = NtExecutableResource.from(exe);
        const entries = res.entries || [];
        result.push(`  ${entries.length} resource entries found`);
        for (const entry of entries.slice(0, 20)) {
          result.push(`  Type: ${entry.type} ID: ${entry.id} Lang: ${entry.lang}`);
        }
      } catch {
        result.push("  No resources or resource parsing failed");
      }
    }

    return result.join("\n");
  } catch (err: any) {
    return `PE parsing error: ${err.message}. File may not be a valid PE executable.`;
  }
}

/** Manual PE import table parser for when pe-library doesn't expose imports directly */
function parsePEImports(data: Buffer): Array<{ dll: string; functions: string[] }> {
  const results: Array<{ dll: string; functions: string[] }> = [];
  try {
    // Check MZ signature
    if (data[0] !== 0x4D || data[1] !== 0x5A) return results;

    // Get PE offset from e_lfanew
    const peOffset = data.readUInt32LE(0x3C);
    if (peOffset >= data.length - 4) return results;

    // Verify PE signature
    if (data.readUInt32LE(peOffset) !== 0x00004550) return results;

    // Parse COFF header
    const coffOffset = peOffset + 4;
    const numberOfSections = data.readUInt16LE(coffOffset + 2);
    const sizeOfOptionalHeader = data.readUInt16LE(coffOffset + 16);

    // Parse optional header
    const optOffset = coffOffset + 20;
    const magic = data.readUInt16LE(optOffset);
    const is64 = magic === 0x20B;

    // Get import directory RVA
    let importDirRVA: number;
    let importDirSize: number;
    if (is64) {
      importDirRVA = data.readUInt32LE(optOffset + 120);
      importDirSize = data.readUInt32LE(optOffset + 124);
    } else {
      importDirRVA = data.readUInt32LE(optOffset + 104);
      importDirSize = data.readUInt32LE(optOffset + 108);
    }

    if (importDirRVA === 0) return results;

    // Parse section headers to build RVA-to-file-offset mapping
    const sectionsOffset = optOffset + sizeOfOptionalHeader;
    const sections: Array<{ virtualAddress: number; virtualSize: number; rawOffset: number; rawSize: number }> = [];
    for (let i = 0; i < numberOfSections; i++) {
      const secOff = sectionsOffset + i * 40;
      sections.push({
        virtualAddress: data.readUInt32LE(secOff + 12),
        virtualSize: data.readUInt32LE(secOff + 8),
        rawOffset: data.readUInt32LE(secOff + 20),
        rawSize: data.readUInt32LE(secOff + 16),
      });
    }

    const rvaToOffset = (rva: number): number => {
      for (const sec of sections) {
        if (rva >= sec.virtualAddress && rva < sec.virtualAddress + sec.rawSize) {
          return rva - sec.virtualAddress + sec.rawOffset;
        }
      }
      return rva; // fallback
    };

    // Parse import descriptors
    const importOffset = rvaToOffset(importDirRVA);
    for (let i = 0; i < 200; i++) { // max 200 DLLs
      const descOff = importOffset + i * 20;
      if (descOff + 20 > data.length) break;

      const nameRVA = data.readUInt32LE(descOff + 12);
      const thunkRVA = data.readUInt32LE(descOff + 0) || data.readUInt32LE(descOff + 16);

      if (nameRVA === 0 && thunkRVA === 0) break; // End of import descriptors

      // Read DLL name
      const nameOffset = rvaToOffset(nameRVA);
      let dllName = "";
      for (let j = 0; j < 256 && nameOffset + j < data.length; j++) {
        if (data[nameOffset + j] === 0) break;
        dllName += String.fromCharCode(data[nameOffset + j]);
      }

      // Read function names from thunk
      const functions: string[] = [];
      const thunkOffset = rvaToOffset(thunkRVA);
      const entrySize = is64 ? 8 : 4;

      for (let j = 0; j < 500; j++) { // max 500 functions per DLL
        const entryOff = thunkOffset + j * entrySize;
        if (entryOff + entrySize > data.length) break;

        let entry: number;
        let isOrdinal = false;
        if (is64) {
          // Read as two 32-bit values to avoid BigInt
          const lo = data.readUInt32LE(entryOff);
          const hi = data.readUInt32LE(entryOff + 4);
          if (lo === 0 && hi === 0) break;
          entry = lo; // We only need the low 32 bits for RVA
          isOrdinal = (hi & 0x80000000) !== 0;
        } else {
          entry = data.readUInt32LE(entryOff);
          if (entry === 0) break;
          isOrdinal = (entry & 0x80000000) !== 0;
        }

        // Check if import by ordinal
        if (isOrdinal) {
          functions.push(`ord_${entry & 0xFFFF}`);
        } else {
          // Import by name - read hint + name
          const hintOffset = rvaToOffset(entry) + 2; // skip hint word
          let funcName = "";
          for (let k = 0; k < 256 && hintOffset + k < data.length; k++) {
            if (data[hintOffset + k] === 0) break;
            funcName += String.fromCharCode(data[hintOffset + k]);
          }
          if (funcName) functions.push(funcName);
        }
      }

      if (dllName) results.push({ dll: dllName, functions });
    }
  } catch {
    // Silently fail — return what we have
  }
  return results;
}

// ─── ELF Parser (pure JS) ───────────────────────────────────────────────────

function parseELF(data: Buffer, section: string): string {
  const result: string[] = [];
  try {
    // Verify ELF magic
    if (data[0] !== 0x7F || data[1] !== 0x45 || data[2] !== 0x4C || data[3] !== 0x46) {
      return "Not an ELF binary";
    }

    const is64 = data[4] === 2;
    const isLE = data[5] === 1;
    const read16 = isLE ? (off: number) => data.readUInt16LE(off) : (off: number) => data.readUInt16BE(off);
    const read32 = isLE ? (off: number) => data.readUInt32LE(off) : (off: number) => data.readUInt32BE(off);

    if (section === "all" || section === "headers") {
      result.push("═══ ELF HEADERS ═══");
      result.push(`Class: ${is64 ? "ELF64" : "ELF32"}`);
      result.push(`Data: ${isLE ? "Little-endian" : "Big-endian"}`);
      result.push(`OS/ABI: ${data[7]}`);
      result.push(`Type: ${read16(16)}`);
      result.push(`Machine: 0x${read16(18).toString(16)}`);
      if (is64) {
        const entryLo = read32(24);
        const entryHi = read32(28);
        result.push(`Entry point: 0x${((entryHi * 0x100000000) + entryLo).toString(16)}`);
      } else {
        result.push(`Entry point: 0x${read32(24).toString(16)}`);
      }
    }

    if (section === "all" || section === "sections") {
      result.push("\n═══ SECTIONS ═══");
      let shoff: number, shentsize: number, shnum: number, shstrndx: number;
      if (is64) {
        shoff = read32(40); // simplified - ignoring high 32 bits
        shentsize = read16(58);
        shnum = read16(60);
        shstrndx = read16(62);
      } else {
        shoff = read32(32);
        shentsize = read16(46);
        shnum = read16(48);
        shstrndx = read16(50);
      }

      // Read string table
      let strTabOff = 0;
      if (shstrndx < shnum) {
        const strSecOff = shoff + shstrndx * shentsize;
        strTabOff = is64 ? read32(strSecOff + 24) : read32(strSecOff + 16);
      }

      for (let i = 0; i < Math.min(shnum, 50); i++) {
        const secOff = shoff + i * shentsize;
        if (secOff + shentsize > data.length) break;
        const nameIdx = read32(secOff);
        const type = read32(secOff + 4);
        let size: number, offset: number;
        if (is64) {
          offset = read32(secOff + 24);
          size = read32(secOff + 32);
        } else {
          offset = read32(secOff + 16);
          size = read32(secOff + 20);
        }

        // Read section name from string table
        let name = "";
        if (strTabOff > 0 && strTabOff + nameIdx < data.length) {
          for (let j = 0; j < 64 && strTabOff + nameIdx + j < data.length; j++) {
            if (data[strTabOff + nameIdx + j] === 0) break;
            name += String.fromCharCode(data[strTabOff + nameIdx + j]);
          }
        }
        if (name || type > 0) {
          result.push(`  [${i.toString().padStart(2)}] ${(name || "(null)").padEnd(20)} Type: ${type.toString().padStart(2)} Offset: 0x${offset.toString(16).padStart(8, "0")} Size: ${size}`);
        }
      }
    }

    return result.join("\n") || "ELF parsed but no data extracted";
  } catch (err: any) {
    return `ELF parsing error: ${err.message}`;
  }
}

// ─── PyInstaller Extractor (pure JS) ─────────────────────────────────────────

function extractPyInstaller(data: Buffer, filter: string): string {
  const MAGIC_COOKIE = Buffer.from([0x4D, 0x45, 0x49, 0x0C, 0x0D, 0x0A, 0x1A, 0x0A]);
  const result: string[] = [];

  // Find PyInstaller cookie
  let pos = -1;
  for (let i = data.length - 4096; i >= 0 && i < data.length - 8; i++) {
    if (data.indexOf(MAGIC_COOKIE, i) === i) {
      pos = i;
      break;
    }
  }
  // Also search from end
  if (pos === -1) {
    pos = data.lastIndexOf(MAGIC_COOKIE);
  }

  if (pos === -1) {
    return "NOT_PYINSTALLER: No PyInstaller magic cookie found in this binary.";
  }

  result.push("═══ PYINSTALLER BINARY DETECTED ═══");
  result.push(`Cookie found at: 0x${pos.toString(16).toUpperCase()}`);

  try {
    // Parse archive header (big-endian)
    const pkgLen = data.readUInt32BE(pos + 8);
    const tocOffset = data.readUInt32BE(pos + 12);
    const tocLen = data.readUInt32BE(pos + 16);
    const pyVer = data.readUInt32BE(pos + 20);

    const archiveStart = Math.max(0, pos + 24 + 64 - pkgLen);

    result.push(`Python version: ${pyVer}`);
    result.push(`Archive start: 0x${archiveStart.toString(16).toUpperCase()}`);
    result.push(`TOC offset: 0x${tocOffset.toString(16).toUpperCase()} (length: ${tocLen})`);
    result.push(`Package length: ${pkgLen}`);
    result.push("");

    // Parse TOC entries
    const tocStart = archiveStart + tocOffset;
    const entries: Array<{ name: string; offset: number; compLen: number; uncompLen: number; compress: boolean; typeCode: number }> = [];

    let cursor = tocStart;
    while (cursor < tocStart + tocLen && cursor + 18 < data.length) {
      const entryLen = data.readUInt32BE(cursor);
      if (entryLen < 18 || entryLen > 65536) break;

      const entryOffset = data.readUInt32BE(cursor + 4);
      const compLen = data.readUInt32BE(cursor + 8);
      const uncompLen = data.readUInt32BE(cursor + 12);
      const compress = data[cursor + 16] === 1;
      const typeCode = data[cursor + 17];

      // Read name (null-terminated after byte 18)
      let name = "";
      for (let i = 18; i < entryLen && cursor + i < data.length; i++) {
        if (data[cursor + i] === 0) break;
        name += String.fromCharCode(data[cursor + i]);
      }

      entries.push({ name, offset: entryOffset, compLen, uncompLen, compress, typeCode });
      cursor += entryLen;
    }

    result.push(`═══ TOC ENTRIES (${entries.length} total) ═══`);

    const typeNames: Record<number, string> = {
      115: "SCRIPT (s)", 109: "MODULE (m)", 77: "MODULE (M)",
      100: "DATA (d)", 98: "BINARY (b)", 122: "PYZ (z)",
      90: "PYZ (Z)", 120: "DEPENDENCY (x)", 111: "OPTION (o)",
    };

    const filteredEntries = filter
      ? entries.filter(e => e.name.toLowerCase().includes(filter))
      : entries;

    for (const entry of filteredEntries.slice(0, 100)) {
      const typeName = typeNames[entry.typeCode] || `TYPE_${entry.typeCode}`;
      const marker = filter && entry.name.toLowerCase().includes(filter) ? " ◄◄◄ MATCH" : "";
      result.push(`  ${typeName.padEnd(14)} ${entry.name} (${entry.compLen} bytes${entry.compress ? ", compressed" : ""})${marker}`);
    }

    if (filteredEntries.length > 100) {
      result.push(`  ... (${filteredEntries.length - 100} more entries)`);
    }

    // Try to extract and show content of script entries
    const scripts = entries.filter(e => e.typeCode === 115 || (filter && e.name.toLowerCase().includes(filter)));
    if (scripts.length > 0) {
      result.push("\n═══ SCRIPT/MODULE CONTENT EXTRACTION ═══");
      for (const script of scripts.slice(0, 10)) {
        const rawOffset = archiveStart + script.offset;
        if (rawOffset + script.compLen > data.length) continue;

        let content = data.slice(rawOffset, rawOffset + script.compLen);
        if (script.compress) {
          try {
            content = Buffer.from(zlib.inflateSync(content));
          } catch {
            // Try raw inflate
            try {
              content = Buffer.from(zlib.inflateRawSync(content));
            } catch {
              result.push(`\n  ${script.name}: [decompression failed]`);
              continue;
            }
          }
        }

        // Show printable content
        const printable = content.toString("utf-8", 0, Math.min(content.length, 2000))
          .replace(/[^\x20-\x7E\n\r\t]/g, ".");
        if (printable.replace(/\./g, "").trim().length > 20) {
          result.push(`\n── ${script.name} ──`);
          result.push(printable.substring(0, 2000));
          if (content.length > 2000) result.push(`... (${content.length - 2000} more bytes)`);
        }
      }
    }

  } catch (err: any) {
    result.push(`TOC parsing error: ${err.message}`);
  }

  return result.join("\n");
}

// ─── Tools ───────────────────────────────────────────────────────────────────
export const tools: ToolDefinition[] = [
  // ═══════════════════════════════════════════════════════════════════════════
  // 1. file_identify — comprehensive file identification (pure JS)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "file_identify",
    description:
      "Identify the file type, format, architecture, and metadata. Returns magic-byte detection, size, entropy analysis, and header hex dump. ALWAYS call this first on any new file.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    async call(_args, filePath) {
      const stats = await fs.stat(filePath);
      const fd = await fs.open(filePath, "r");
      const headerBuf = Buffer.alloc(Math.min(256, stats.size));
      await fd.read(headerBuf, 0, headerBuf.length, 0);

      // Read first 4KB for entropy
      const entropyBuf = Buffer.alloc(Math.min(4096, stats.size));
      await fd.read(entropyBuf, 0, entropyBuf.length, 0);
      await fd.close();

      const entropy = calcEntropy(entropyBuf);
      const detected = detectFileType(headerBuf);

      // Check for PyInstaller — only scan last 4KB (marker is always near end of PE)
      // Skip entirely for SWF files (not applicable)
      const isSWFEarly = detected.mime === "application/x-shockwave-flash";
      let hasPyInstaller = false;
      if (!isSWFEarly && stats.size > 0) {
        const tailSize = Math.min(65536, stats.size); // last 64KB
        const tailBuf = Buffer.alloc(tailSize);
        const tailFd = await fs.open(filePath, "r");
        await tailFd.read(tailBuf, 0, tailSize, stats.size - tailSize);
        await tailFd.close();
        hasPyInstaller = tailBuf.lastIndexOf(Buffer.from([0x4D, 0x45, 0x49, 0x0C, 0x0D, 0x0A, 0x1A, 0x0A])) !== -1;
      }

      const headerHex = headerBuf.toString("hex").match(/.{1,2}/g)?.join(" ") || "";

      const isSWF = detected.mime === "application/x-shockwave-flash";
      return [
        `═══ FILE IDENTIFICATION ═══`,
        `File type: ${detected.type}${hasPyInstaller ? " [PyInstaller packed]" : ""}`,
        `MIME: ${detected.mime}`,
        `Size: ${stats.size} bytes (${(stats.size / 1024).toFixed(1)} KB / ${(stats.size / 1048576).toFixed(2)} MB)`,
        `Header entropy: ${entropy.toFixed(3)} bits/byte (${entropy > 7.5 ? "ENCRYPTED/COMPRESSED" : entropy > 6.0 ? "COMPILED/BINARY" : "STRUCTURED DATA"})`,
        ``,
        `First 256 bytes (hex):`,
        headerHex,
        ``,
        `First 256 bytes (ASCII, non-printable replaced with .):`,
        headerBuf.toString("ascii").replace(/[^\x20-\x7E]/g, "."),
        hasPyInstaller ? `\n⚠️ PyInstaller detected — use pyinstaller_extract to reveal embedded Python code` : "",
        detected.type.includes("PE32") ? `\n⚠️ Windows PE detected — use pe_info to analyze imports/sections/resources` : "",
        isSWF ? `\n🔥 SWF FILE DETECTED — This is a compressed Flash/ActionScript binary. MANDATORY NEXT STEP: call swf_extract immediately to decompress and analyze the full ActionScript bytecode. This file may contain automotive diagnostic protocols, crypto algorithms, seed keys, and security gateway logic embedded in ActionScript classes.` : "",
      ].join("\n");
    },
  },
  // ═══════════════════════════════════════════════════════════════════════════
  // 2. read_hex — read raw hex dump of any region (pure JS, replaces xxd)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "read_hex",
    description:
      "Read a hex dump of the binary at a specific byte offset and length. Use to inspect specific regions, headers, data structures, or follow up on offsets found by other tools.",
    inputSchema: {
      type: "object",
      properties: {
        offset: {
          type: "number",
          description: "Byte offset to start reading from (default: 0)",
        },
        length: {
          type: "number",
          description: "Number of bytes to read (default: 512, max: 8192)",
        },
      },
    },
    async call(args, filePath) {
      const offset = Math.max(0, Number(args.offset ?? 0));
      const length = Math.min(8192, Math.max(16, Number(args.length ?? 512)));
      const fd = await fs.open(filePath, "r");
      const stats = await fd.stat();
      const readLen = Math.min(length, stats.size - offset);
      if (readLen <= 0) {
        await fd.close();
        return `Error: offset ${offset} is beyond file size ${stats.size}`;
      }
      const buf = Buffer.alloc(readLen);
      await fd.read(buf, 0, readLen, offset);
      await fd.close();
      return hexDump(buf, offset);
    },
  },
  // ═══════════════════════════════════════════════════════════════════════════
  // 3. extract_strings — extract ALL printable strings (pure JS, replaces strings command)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "extract_strings",
    description:
      "Extract printable strings from the binary with file offsets. Call WITHOUT a filter first to see everything, then call again WITH a filter to narrow down. Returns up to 3000 lines.",
    inputSchema: {
      type: "object",
      properties: {
        min_length: {
          type: "number",
          description: "Minimum string length (default: 4)",
        },
        filter: {
          type: "string",
          description: "Optional case-insensitive filter (e.g. 'seed|key|vin|can|uds|skim|pin|crc|aes|xor|encrypt|decrypt|password|secret|auth'). Use pipe | for OR.",
        },
        encoding: {
          type: "string",
          description: "String encoding: 's' for ASCII (default), 'l' for 16-bit little-endian (Unicode)",
        },
      },
    },
    async call(args, filePath) {
      const minLen = Math.max(4, Number(args.min_length ?? 4));
      const filter = String(args.filter ?? "").trim();
      const encoding = String(args.encoding ?? "s").trim();

      const data = await fs.readFile(filePath);
      const enc = encoding === "l" ? "utf16le" : "ascii";
      let strings = extractStrings(data, minLen, enc);

      // Apply filter
      if (filter) {
        const parts = filter.split("|").map(p => p.trim().toLowerCase());
        strings = strings.filter(s => parts.some(p => s.str.toLowerCase().includes(p)));
      }

      if (strings.length === 0) {
        return filter ? `No strings matching '${filter}'` : "No strings found";
      }

      const lines = strings.slice(0, 3000).map(s =>
        `${s.offset.toString(16).padStart(8, " ")} ${s.str}`
      );

      if (strings.length > 3000) {
        lines.push(`\n... (${strings.length - 3000} more lines — use a filter to narrow down)`);
      }

      return lines.join("\n");
    },
  },
  // ═══════════════════════════════════════════════════════════════════════════
  // 4. pe_info — Windows PE structure analysis (pure JS via pe-library)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "pe_info",
    description:
      "Analyze Windows PE (EXE/DLL) structure: sections with entropy, all imports (DLLs and functions), exports, resources, timestamps, entry point. Use for .exe and .dll files.",
    inputSchema: {
      type: "object",
      properties: {
        section: {
          type: "string",
          description: "Which section: 'all', 'imports', 'exports', 'sections', 'resources', 'headers' (default: 'all')",
        },
      },
    },
    async call(args, filePath) {
      const section = String(args.section ?? "all");
      return parsePE(filePath, section);
    },
  },
  // ═══════════════════════════════════════════════════════════════════════════
  // 5. elf_info — ELF binary analysis (pure JS)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "elf_info",
    description:
      "Analyze ELF binary structure: sections, symbols, dynamic libraries, entry point. Use for Linux/embedded firmware binaries.",
    inputSchema: {
      type: "object",
      properties: {
        section: {
          type: "string",
          description: "Which section: 'headers', 'sections', 'all' (default: 'all')",
        },
      },
    },
    async call(args, filePath) {
      const section = String(args.section ?? "all");
      const data = await fs.readFile(filePath);
      return parseELF(data, section);
    },
  },
  // ═══════════════════════════════════════════════════════════════════════════
  // 6. disassemble — basic instruction dump (pure JS, limited without objdump)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "disassemble",
    description:
      "Read raw bytes from a code region and display as hex instruction dump. For PE files, reads from the .text section entry point. Without a full disassembler, shows raw bytes with basic x86 opcode hints.",
    inputSchema: {
      type: "object",
      properties: {
        offset: {
          type: "number",
          description: "File offset to start reading from. If not specified, reads from entry point (PE) or offset 0.",
        },
        length: {
          type: "number",
          description: "Number of bytes to read (default: 256, max: 2048)",
        },
      },
    },
    async call(args, filePath) {
      const data = await fs.readFile(filePath);
      let offset = Number(args.offset ?? -1);
      const length = Math.min(2048, Math.max(16, Number(args.length ?? 256)));

      // If no offset specified, try to find entry point
      if (offset < 0) {
        if (data[0] === 0x4D && data[1] === 0x5A) {
          // PE: find entry point file offset
          const peOff = data.readUInt32LE(0x3C);
          if (peOff < data.length - 40) {
            const optOff = peOff + 4 + 20;
            const magic = data.readUInt16LE(optOff);
            const ep = data.readUInt32LE(optOff + 16); // AddressOfEntryPoint RVA
            // Find which section contains the entry point
            const numSections = data.readUInt16LE(peOff + 4 + 2);
            const sizeOptHdr = data.readUInt16LE(peOff + 4 + 16);
            const secStart = optOff + sizeOptHdr;
            for (let i = 0; i < numSections; i++) {
              const secOff = secStart + i * 40;
              const va = data.readUInt32LE(secOff + 12);
              const vs = data.readUInt32LE(secOff + 8);
              const rawOff = data.readUInt32LE(secOff + 20);
              if (ep >= va && ep < va + vs) {
                offset = ep - va + rawOff;
                break;
              }
            }
          }
        }
        if (offset < 0) offset = 0;
      }

      const readLen = Math.min(length, data.length - offset);
      if (readLen <= 0) return `Offset 0x${offset.toString(16)} is beyond file size`;

      const buf = data.slice(offset, offset + readLen);
      const result: string[] = [];
      result.push(`═══ RAW CODE DUMP @ 0x${offset.toString(16).toUpperCase()} (${readLen} bytes) ═══`);
      result.push(`Note: This is a raw hex dump of the code region. Use read_hex for data regions.`);
      result.push("");
      result.push(hexDump(buf, offset));

      return result.join("\n");
    },
  },
  // ═══════════════════════════════════════════════════════════════════════════
  // 7. pyinstaller_extract — extract Python from PyInstaller EXE (pure JS)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "pyinstaller_extract",
    description:
      "Extract and analyze Python content from a PyInstaller-compiled executable. Lists all embedded modules and attempts to extract readable content. This is the KEY tool for analyzing Python-compiled EXEs — it reveals the actual application logic.",
    inputSchema: {
      type: "object",
      properties: {
        module_filter: {
          type: "string",
          description: "Optional filter to only show modules matching this pattern (e.g. 'main', 'seed', 'skim', 'uds', 'can')",
        },
      },
    },
    async call(args, filePath) {
      const filter = String(args.module_filter ?? "").toLowerCase().trim();
      const data = await fs.readFile(filePath);
      return extractPyInstaller(data, filter);
    },
  },
  // ═══════════════════════════════════════════════════════════════════════════
  // 8. search_patterns — binary pattern search (pure JS, replaces grep -bao)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "search_patterns",
    description:
      "Search for specific byte patterns, hex sequences, or text in the binary. Returns offsets and surrounding context. Use to find crypto constants, magic bytes, UDS service IDs, CAN IDs, and automotive-specific patterns.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "What to search for. Can be: text string (e.g. 'seed_key'), hex bytes (e.g. 'hex:27 01'), or a preset scan name (e.g. 'automotive', 'crypto', 'all')",
        },
      },
      required: ["pattern"],
    },
    async call(args, filePath) {
      const pattern = String(args.pattern ?? "").trim();
      if (!pattern) return "Error: pattern is required";

      const data = await fs.readFile(filePath);
      const results: string[] = [];

      if (pattern === "automotive" || pattern === "all") {
        results.push("═══ AUTOMOTIVE PATTERN SCAN ═══\n");
        const autoPatterns: Array<{ name: string; bytes: number[] }> = [
          { name: "UDS Security Access 0x27 sub=0x01", bytes: [0x27, 0x01] },
          { name: "UDS Security Access 0x27 sub=0x03", bytes: [0x27, 0x03] },
          { name: "UDS Security Access 0x27 sub=0x05", bytes: [0x27, 0x05] },
          { name: "UDS Security Access 0x27 sub=0x11", bytes: [0x27, 0x11] },
          { name: "UDS Security Access 0x27 sub=0x61", bytes: [0x27, 0x61] },
          { name: "UDS DiagSession 0x10 sub=0x01", bytes: [0x10, 0x01] },
          { name: "UDS DiagSession 0x10 sub=0x02", bytes: [0x10, 0x02] },
          { name: "UDS DiagSession 0x10 sub=0x03", bytes: [0x10, 0x03] },
          { name: "UDS ReadByID 0x22 F1xx", bytes: [0x22, 0xF1] },
          { name: "UDS WriteByID 0x2E F1xx", bytes: [0x2E, 0xF1] },
          { name: "UDS RoutineCtrl 0x31 sub=0x01", bytes: [0x31, 0x01] },
          { name: "UDS RequestDownload 0x34", bytes: [0x34, 0x00] },
          { name: "CRC-16 CCITT poly (0x1021)", bytes: [0x10, 0x21] },
          { name: "CRC-32 poly (0x04C11DB7)", bytes: [0x04, 0xC1, 0x1D, 0xB7] },
        ];

        for (const ap of autoPatterns) {
          const pat = Buffer.from(ap.bytes);
          const offsets = findPattern(data, pat, 20);
          if (offsets.length > 0) {
            results.push(`${ap.name}: ${offsets.length} hit(s)`);
            for (const off of offsets.slice(0, 5)) {
              const ctxStart = Math.max(0, off - 4);
              const ctxEnd = Math.min(data.length, off + 16);
              const ctx = data.slice(ctxStart, ctxEnd).toString("hex").match(/.{1,2}/g)?.join(" ") || "";
              results.push(`  @ 0x${off.toString(16).toUpperCase().padStart(8, "0")}: ${ctx}`);
            }
          }
        }

        // Text pattern scan
        const textPatterns = ["seed", "key", "vin", "skim", "pin", "crc", "aes", "xor", "encrypt", "decrypt", "password", "secret", "auth", "unlock", "immobilizer", "transponder"];
        const strings = extractStrings(data, 4);
        const matchedStrings = strings.filter(s => textPatterns.some(p => s.str.toLowerCase().includes(p)));
        if (matchedStrings.length > 0) {
          results.push(`\n═══ AUTOMOTIVE TEXT STRINGS ═══`);
          for (const s of matchedStrings.slice(0, 100)) {
            results.push(`  ${s.offset.toString(16).padStart(8, " ")} ${s.str}`);
          }
        }

        return results.join("\n") || "No automotive patterns found";
      }

      if (pattern === "crypto") {
        results.push("═══ CRYPTO CONSTANT SCAN ═══\n");
        const cryptoPatterns: Array<{ name: string; bytes: number[] }> = [
          { name: "AES S-Box start (0x637C777B)", bytes: [0x63, 0x7C, 0x77, 0x7B] },
          { name: "AES Rcon", bytes: [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80] },
          { name: "SHA-256 init (0x6A09E667)", bytes: [0x6A, 0x09, 0xE6, 0x67] },
          { name: "MD5 init (0x67452301)", bytes: [0x67, 0x45, 0x23, 0x01] },
          { name: "CRC-16 CCITT (0x1021)", bytes: [0x10, 0x21] },
          { name: "CRC-32 (0x04C11DB7)", bytes: [0x04, 0xC1, 0x1D, 0xB7] },
          { name: "DES initial perm", bytes: [0x3A, 0x32, 0x2A, 0x22] },
        ];

        for (const cp of cryptoPatterns) {
          const pat = Buffer.from(cp.bytes);
          const offsets = findPattern(data, pat, 10);
          if (offsets.length > 0) {
            results.push(`${cp.name}: FOUND (${offsets.length} hits)`);
            for (const off of offsets.slice(0, 3)) {
              results.push(`  @ 0x${off.toString(16).toUpperCase()}`);
            }
          }
        }
        return results.join("\n") || "No crypto constants found";
      }

      // Hex pattern search: "hex:27 01 03"
      if (pattern.startsWith("hex:")) {
        const hexStr = pattern.slice(4).replace(/\s+/g, "");
        const patBuf = Buffer.from(hexStr, "hex");
        if (patBuf.length === 0) return "Error: invalid hex pattern";

        const offsets = findPattern(data, patBuf, 50);
        if (offsets.length > 0) {
          results.push(`Found ${offsets.length} matches for hex pattern:`);
          for (const off of offsets.slice(0, 20)) {
            const ctxStart = Math.max(0, off - 8);
            const ctxEnd = Math.min(data.length, off + 24);
            const ctx = hexDump(data.slice(ctxStart, ctxEnd), ctxStart).split("\n")[0];
            results.push(`  0x${off.toString(16).toUpperCase().padStart(8, "0")}: ${ctx}`);
          }
        }
        return results.join("\n") || `No matches for hex pattern`;
      }

      // Text pattern search
      const strings = extractStrings(data, 4);
      const parts = pattern.split("|").map(p => p.trim().toLowerCase());
      const matched = strings.filter(s => parts.some(p => s.str.toLowerCase().includes(p)));

      if (matched.length > 0) {
        for (const s of matched.slice(0, 200)) {
          results.push(`${s.offset.toString(16).padStart(8, " ")} ${s.str}`);
        }
        if (matched.length > 200) results.push(`... (${matched.length - 200} more matches)`);
      }
      return results.join("\n") || `No matches for '${pattern}'`;
    },
  },
  // ═══════════════════════════════════════════════════════════════════════════
  // 9. eeprom_layout_parse — FCA EEPROM/binary module layout (pure JS)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "eeprom_layout_parse",
    description:
      "Identify and map the layout of FCA/Stellantis EEPROM dumps or module binaries. Detects module type (RFHUB, WCM, BCM, PCM, etc.), maps known offset regions, finds VINs, UDS references, and CAN IDs. Essential for automotive module analysis.",
    inputSchema: {
      type: "object",
      properties: {
        module_hint: {
          type: "string",
          description: "Optional hint for module type: 'rfhub', 'wcm', 'bcm', 'pcm', 'skim', 'auto' (default: 'auto')",
        },
      },
    },
    async call(args, filePath) {
      const hint = String(args.module_hint ?? "auto").toLowerCase();
      const data = await fs.readFile(filePath);
      const size = data.length;
      const results: string[] = [];

      results.push("═══ EEPROM LAYOUT ANALYSIS ═══");
      results.push(`File size: ${size} bytes (${(size / 1024).toFixed(1)} KB)`);

      // Module detection signatures
      const moduleSignatures: Record<string, { markers: string[]; typicalSizes: Array<[number, number]> }> = {
        RFHUB: { markers: ["RFHUB", "RF_HUB", "FOBIK", "RFH"], typicalSizes: [[1024, 8192], [16384, 65536]] },
        WCM: { markers: ["WCM", "SKREEM", "SKIM"], typicalSizes: [[2048, 16384]] },
        BCM: { markers: ["BCM", "TIPM", "BODY"], typicalSizes: [[32768, 262144]] },
        PCM: { markers: ["PCM", "ECM", "ENGINE"], typicalSizes: [[262144, 4194304]] },
        TCM: { markers: ["TCM", "TRANS"], typicalSizes: [[65536, 524288]] },
        ABS: { markers: ["ABS", "ESP", "BRAKE"], typicalSizes: [[32768, 262144]] },
        IPC: { markers: ["IPC", "CLUSTER", "INSTRUMENT"], typicalSizes: [[16384, 131072]] },
      };

      // Detect module type
      let detectedModule = "UNKNOWN";
      let bestScore = 0;
      const dataStr = data.toString("ascii").replace(/[^\x20-\x7E]/g, "");

      for (const [modName, sig] of Object.entries(moduleSignatures)) {
        let score = 0;
        if (hint === modName.toLowerCase()) score += 50;
        for (const marker of sig.markers) {
          if (dataStr.includes(marker)) {
            score += 10;
            results.push(`  Signature: "${marker}" found`);
          }
        }
        for (const [minSz, maxSz] of sig.typicalSizes) {
          if (size >= minSz && size <= maxSz) { score += 5; break; }
        }
        if (score > bestScore) { bestScore = score; detectedModule = modName; }
      }

      results.push(`\nDetected module: ${detectedModule} (confidence: ${Math.min(100, bestScore)}%)`);

      // VIN scan (17 alphanumeric chars, excluding I, O, Q)
      const vinRegex = /[A-HJ-NPR-Z0-9]{17}/g;
      const vinMatches: Array<{ offset: number; vin: string }> = [];
      for (let i = 0; i < data.length - 17; i++) {
        const slice = data.slice(i, i + 17).toString("ascii");
        if (/^[A-HJ-NPR-Z0-9]{17}$/.test(slice)) {
          vinMatches.push({ offset: i, vin: slice });
          i += 16; // skip ahead
        }
      }
      if (vinMatches.length > 0) {
        results.push(`\n═══ VIN LOCATIONS ═══`);
        for (const v of vinMatches.slice(0, 10)) {
          results.push(`  0x${v.offset.toString(16).toUpperCase().padStart(4, "0")}: ${v.vin}`);
        }
      }

      // UDS 0x27 Security Access references
      const seedKeyOffsets: string[] = [];
      for (let i = 0; i < data.length - 2; i++) {
        if (data[i] === 0x27 && [0x01, 0x03, 0x05, 0x11, 0x61].includes(data[i + 1])) {
          seedKeyOffsets.push(`0x${i.toString(16).toUpperCase().padStart(4, "0")} (sub=0x${data[i + 1].toString(16).padStart(2, "0")})`);
        }
      }
      if (seedKeyOffsets.length > 0) {
        results.push(`\n═══ UDS SECURITY ACCESS (0x27) REFERENCES ═══`);
        for (const ref of seedKeyOffsets.slice(0, 20)) {
          results.push(`  ${ref}`);
        }
        if (seedKeyOffsets.length > 20) results.push(`  ... (${seedKeyOffsets.length - 20} more)`);
      }

      // CAN ID scan
      const canIds: Array<{ pattern: Buffer; label: string }> = [
        { pattern: Buffer.from([0x07, 0x40]), label: "0x740 (RFHUB Tx)" },
        { pattern: Buffer.from([0x07, 0x42]), label: "0x742 (RFHUB Rx)" },
        { pattern: Buffer.from([0x07, 0xE0]), label: "0x7E0 (PCM Tx)" },
        { pattern: Buffer.from([0x07, 0xE8]), label: "0x7E8 (PCM Rx)" },
        { pattern: Buffer.from([0x06, 0x40]), label: "0x640 (BCM Tx)" },
        { pattern: Buffer.from([0x06, 0x48]), label: "0x648 (BCM Rx)" },
      ];
      const foundCan: string[] = [];
      for (const { pattern: canPat, label } of canIds) {
        const idx = data.indexOf(canPat);
        if (idx !== -1) {
          foundCan.push(`${label} at 0x${idx.toString(16).toUpperCase().padStart(4, "0")}`);
        }
      }
      if (foundCan.length > 0) {
        results.push(`\n═══ CAN IDs FOUND ═══`);
        for (const c of foundCan) results.push(`  ${c}`);
      }

      // Generic region map based on size
      results.push(`\n═══ OFFSET REGION MAP ═══`);
      const regionSize = Math.min(size, 256);
      const firstRegion = data.slice(0, regionSize);
      const isEmpty = firstRegion.every(b => b === 0x00 || b === 0xFF);
      results.push(`  [0x0000 - 0x${regionSize.toString(16).toUpperCase()}] Header region ${isEmpty ? "[EMPTY]" : "[DATA]"}`);
      results.push(`    Hex: ${data.slice(0, 32).toString("hex").match(/.{1,2}/g)?.join(" ")}`);

      if (size > 256) {
        const midStart = Math.floor(size / 4);
        const midData = data.slice(midStart, midStart + 32);
        results.push(`  [0x${midStart.toString(16).toUpperCase()} - ...] Mid-file region`);
        results.push(`    Hex: ${midData.toString("hex").match(/.{1,2}/g)?.join(" ")}`);
            }
      return results.join("\n");
    },
  },
  // ─── archive_extract ─────────────────────────────────────────────────────
  {
    name: "archive_extract",
    description: `MANDATORY FIRST STEP when the file is a .tar.gz, .tar, .zip, .gz, .7z, or any compressed/archived container. Extracts ALL contents from the archive, returns a full manifest of every extracted file with its size, type, and a hex/string preview. ALWAYS call this BEFORE any other tool when file_identify shows gzip, tar, zip, or archive magic bytes. Do NOT try to analyze the archive container itself - extract first, then analyze each extracted file individually.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        filePath: { type: "string", description: "Absolute path to the archive file to extract" },
        outputDir: { type: "string", description: "Optional: directory to extract into" },
      },
      required: ["filePath"],
    },
    call: async (args: Record<string, unknown>): Promise<string> => {
      const filePath = args.filePath as string;
      const outputDir = args.outputDir as string | undefined;
      const { execSync } = await import("child_process");
      const fsM = await import("fs");
      const pathM = await import("path");
      if (!fsM.existsSync(filePath)) return `ERROR: File not found: ${filePath}`;
      const outDir = outputDir || `/tmp/srt-extract-${Date.now()}`;
      fsM.mkdirSync(outDir, { recursive: true });
      const results: string[] = [];
      try {
        const fd = fsM.openSync(filePath, "r");
        const magic = Buffer.alloc(6);
        fsM.readSync(fd, magic, 0, 6, 0);
        fsM.closeSync(fd);
        const isGzip = magic[0] === 0x1f && magic[1] === 0x8b;
        const isZip = magic[0] === 0x50 && magic[1] === 0x4b;
        let extractCmd = "";
        if (isGzip || filePath.endsWith(".tar.gz") || filePath.endsWith(".tgz")) {
          extractCmd = `tar -xzf "${filePath}" -C "${outDir}" 2>&1`;
        } else if (filePath.endsWith(".tar")) {
          extractCmd = `tar -xf "${filePath}" -C "${outDir}" 2>&1`;
        } else if (isZip || filePath.endsWith(".zip")) {
          extractCmd = `unzip -o "${filePath}" -d "${outDir}" 2>&1`;
        } else if (filePath.endsWith(".gz")) {
          const outFile = pathM.join(outDir, pathM.basename(filePath, ".gz"));
          extractCmd = `gunzip -c "${filePath}" > "${outFile}" 2>&1`;
        } else {
          extractCmd = `tar -xf "${filePath}" -C "${outDir}" 2>&1`;
        }
        results.push(`[ARCHIVE EXTRACT] Running: ${extractCmd}`);
        try {
          const out = execSync(extractCmd, { timeout: 60000, maxBuffer: 10 * 1024 * 1024 }).toString();
          if (out.trim()) results.push(`[OUTPUT] ${out.slice(0, 500)}`);
        } catch (e: any) {
          results.push(`[EXTRACT WARNING] ${e.message?.slice(0, 300)}`);
        }
        const allFiles: string[] = [];
        const walkDir = (dir: string) => {
          try {
            const entries = fsM.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = pathM.join(dir, entry.name);
              if (entry.isDirectory()) walkDir(fullPath);
              else allFiles.push(fullPath);
            }
          } catch { /* skip */ }
        };
        walkDir(outDir);
        results.push(`\n=== EXTRACTED ${allFiles.length} FILES ===`);
        results.push(`Output directory: ${outDir}\n`);
        for (const fp of allFiles.slice(0, 200)) {
          const relPath = fp.replace(outDir + "/", "");
          const stat = fsM.statSync(fp);
          const sizeFmt = stat.size > 1048576 ? `${(stat.size / 1048576).toFixed(1)}MB` : `${(stat.size / 1024).toFixed(1)}KB`;
          let typeLabel = "binary";
          try {
            const ffd = fsM.openSync(fp, "r");
            const fmag = Buffer.alloc(8);
            fsM.readSync(ffd, fmag, 0, 8, 0);
            fsM.closeSync(ffd);
            if (fmag[0] === 0x4d && fmag[1] === 0x5a) typeLabel = "PE/EXE";
            else if (fmag[0] === 0x7f && fmag[1] === 0x45) typeLabel = "ELF";
            else if (fmag[0] === 0x1f && fmag[1] === 0x8b) typeLabel = "GZIP";
            else if (fmag[0] === 0x50 && fmag[1] === 0x4b) typeLabel = "ZIP";
            else if (fp.endsWith(".py") || fp.endsWith(".ts") || fp.endsWith(".js")) typeLabel = "source";
            else if (fp.endsWith(".json")) typeLabel = "JSON";
            else if (fp.endsWith(".bin") || fp.endsWith(".eep") || fp.endsWith(".eeprom")) typeLabel = "EEPROM/binary";
            else if (fp.endsWith(".csv")) typeLabel = "CSV";
            else if (fp.endsWith(".md") || fp.endsWith(".txt")) typeLabel = "text";
          } catch { /* ignore */ }
          results.push(`  [${typeLabel}] ${fp}  (${sizeFmt})`);
          if ((typeLabel === "source" || typeLabel === "JSON" || typeLabel === "text" || typeLabel === "CSV") && stat.size < 50000) {
            try {
              const content = fsM.readFileSync(fp, "utf8").slice(0, 2000);
              results.push(`    --- PREVIEW ---`);
              results.push(content.split("\n").slice(0, 40).map((l: string) => `    ${l}`).join("\n"));
              results.push(`    --- END ---`);
            } catch { /* skip */ }
          } else if (typeLabel === "EEPROM/binary" || typeLabel === "binary") {
            try {
              const bfd = fsM.openSync(fp, "r");
              const bpreview = Buffer.alloc(Math.min(64, stat.size));
              fsM.readSync(bfd, bpreview, 0, bpreview.length, 0);
              fsM.closeSync(bfd);
              results.push(`    Hex[0:64]: ${bpreview.toString("hex").match(/.{1,2}/g)?.join(" ")}`);
            } catch { /* skip */ }
          }
        }
        if (allFiles.length > 200) results.push(`  ... (${allFiles.length - 200} more files)`);
        results.push(`\n[NEXT STEP] Use the absolute file paths above with file_identify, read_hex, extract_strings, eeprom_layout_parse, etc. to analyze each extracted file.`);
        return results.join("\n");
      } catch (err: any) {
        return `ERROR extracting archive: ${err.message}`;
      }
    },
  },
];
// ─── Extended RE Tools (v4) ─────────────────────────────────────────────────

// Shared helpers for extended tools
function _parsePECtx(buf: Buffer) {
  if (buf.length < 0x40) return null;
  const peOff = buf.readUInt32LE(0x3c);
  if (peOff + 24 > buf.length || buf.readUInt32LE(peOff) !== 0x00004550) return null;
  const coffOff = peOff + 4;
  const numSec = buf.readUInt16LE(coffOff + 2);
  const optSize = buf.readUInt16LE(coffOff + 16);
  const optOff = coffOff + 20;
  const magic = buf.readUInt16LE(optOff);
  const is64 = magic === 0x20b;
  const ep = buf.readUInt32LE(optOff + 16);
  const imageBase = is64 ? buf.readUInt32LE(optOff + 24) : buf.readUInt32LE(optOff + 28);
  const secStart = optOff + optSize;
  const sections: Array<{ name: string; va: number; vsize: number; rawOff: number; rawSize: number; chars: number }> = [];
  for (let i = 0; i < numSec; i++) {
    const so = secStart + i * 40;
    if (so + 40 > buf.length) break;
    sections.push({
      name: buf.slice(so, so + 8).toString().replace(/\0/g, ""),
      va: buf.readUInt32LE(so + 12),
      vsize: buf.readUInt32LE(so + 8),
      rawOff: buf.readUInt32LE(so + 20),
      rawSize: buf.readUInt32LE(so + 16),
      chars: buf.readUInt32LE(so + 36),
    });
  }
  const rva2off = (rva: number): number => {
    for (const s of sections) {
      if (rva >= s.va && rva < s.va + s.rawSize) return rva - s.va + s.rawOff;
    }
    return rva;
  };
  const off2rva = (off: number): number => {
    for (const s of sections) {
      if (off >= s.rawOff && off < s.rawOff + s.rawSize) return off - s.rawOff + s.va;
    }
    return 0;
  };
  return { peOff, coffOff, optOff, is64, imageBase, ep, numSec, sections, rva2off, off2rva };
}
function _readCStr(buf: Buffer, off: number, max = 256): string {
  let s = "";
  for (let i = 0; i < max && off + i < buf.length; i++) {
    if (buf[off + i] === 0) break;
    s += String.fromCharCode(buf[off + i]);
  }
  return s;
}
function _calcEnt(buf: Buffer): number {
  if (buf.length === 0) return 0;
  const freq = new Float64Array(256);
  for (let i = 0; i < buf.length; i++) freq[buf[i]]++;
  let ent = 0;
  for (let i = 0; i < 256; i++) {
    if (freq[i] === 0) continue;
    const p = freq[i] / buf.length;
    ent -= p * Math.log2(p);
  }
  return ent;
}
function _parsePEImportsExt(buf: Buffer, pe: NonNullable<ReturnType<typeof _parsePECtx>>) {
  const importDirRVA = pe.is64 ? buf.readUInt32LE(pe.optOff + 120) : buf.readUInt32LE(pe.optOff + 104);
  if (importDirRVA === 0) return [];
  const results: Array<{ dll: string; functions: Array<{ name: string; hint: number; isOrdinal: boolean }>; iatRva: number }> = [];
  const importOff = pe.rva2off(importDirRVA);
  for (let i = 0; i < 300; i++) {
    const descOff = importOff + i * 20;
    if (descOff + 20 > buf.length) break;
    const nameRVA = buf.readUInt32LE(descOff + 12);
    const iltRVA = buf.readUInt32LE(descOff + 0) || buf.readUInt32LE(descOff + 16);
    const iatRva = buf.readUInt32LE(descOff + 16);
    if (nameRVA === 0 && iltRVA === 0) break;
    const dll = _readCStr(buf, pe.rva2off(nameRVA));
    const functions: Array<{ name: string; hint: number; isOrdinal: boolean }> = [];
    const thunkOff = pe.rva2off(iltRVA);
    const entrySize = pe.is64 ? 8 : 4;
    for (let j = 0; j < 1000; j++) {
      const eOff = thunkOff + j * entrySize;
      if (eOff + entrySize > buf.length) break;
      let entry: number;
      let isOrdinal = false;
      if (pe.is64) {
        const lo = buf.readUInt32LE(eOff);
        const hi = buf.readUInt32LE(eOff + 4);
        if (lo === 0 && hi === 0) break;
        entry = lo;
        isOrdinal = (hi & 0x80000000) !== 0;
      } else {
        entry = buf.readUInt32LE(eOff);
        if (entry === 0) break;
        isOrdinal = (entry & 0x80000000) !== 0;
      }
      if (isOrdinal) {
        functions.push({ name: `ord_${entry & 0xffff}`, hint: entry & 0xffff, isOrdinal: true });
      } else {
        const hintOff = pe.rva2off(entry);
        const hint = hintOff + 2 <= buf.length ? buf.readUInt16LE(hintOff) : 0;
        const name = _readCStr(buf, hintOff + 2);
        if (name) functions.push({ name, hint, isOrdinal: false });
      }
    }
    if (dll) results.push({ dll, functions, iatRva });
  }
  return results;
}

tools.push(
  // ── struct_unpack ──────────────────────────────────────────────────────────
  {
    name: "struct_unpack",
    description: "Parse a binary struct at a given offset. Specify fields as semicolon-separated 'name:type' pairs. Types: u8, i8, u16le, u16be, i16le, u32le, u32be, i32le, bytes:N, char:N, skip:N. Can repeat the struct N times for arrays.",
    inputSchema: {
      type: "object" as const,
      properties: {
        offset: { type: "number", description: "File offset to start parsing" },
        fields: { type: "string", description: "Semicolon-separated field definitions, e.g. 'magic:bytes:4;version:u16le;flags:u8'" },
        repeat: { type: "number", description: "Number of times to repeat the struct (default 1, max 500)" },
      },
      required: ["offset", "fields"],
    },
    async call(args: Record<string, unknown>, filePath: string): Promise<string> {
      const fsM = await import("fs");
      const buf = fsM.readFileSync(filePath);
      let pos = args.offset as number;
      const repeat = Math.min((args.repeat as number) || 1, 500);
      const fieldDefs = (args.fields as string).split(";").map((f: string) => {
        const parts = f.trim().split(":");
        return { name: parts[0], type: parts.slice(1).join(":") };
      });
      const rows: string[] = [];
      for (let r = 0; r < repeat; r++) {
        const rowStart = pos;
        const cols: string[] = [];
        for (const fd of fieldDefs) {
          const off = pos;
          let val: string;
          let size = 0;
          if (fd.type === "u8") { val = `${buf[pos]} (0x${buf[pos].toString(16).toUpperCase().padStart(2, "0")})`; size = 1; }
          else if (fd.type === "i8") { val = `${buf.readInt8(pos)}`; size = 1; }
          else if (fd.type === "u16le") { const v = buf.readUInt16LE(pos); val = `${v} (0x${v.toString(16).toUpperCase().padStart(4, "0")})`; size = 2; }
          else if (fd.type === "u16be") { const v = buf.readUInt16BE(pos); val = `${v} (0x${v.toString(16).toUpperCase().padStart(4, "0")})`; size = 2; }
          else if (fd.type === "i16le") { val = `${buf.readInt16LE(pos)}`; size = 2; }
          else if (fd.type === "u32le") { const v = buf.readUInt32LE(pos); val = `${v} (0x${v.toString(16).toUpperCase().padStart(8, "0")})`; size = 4; }
          else if (fd.type === "u32be") { const v = buf.readUInt32BE(pos); val = `${v} (0x${v.toString(16).toUpperCase().padStart(8, "0")})`; size = 4; }
          else if (fd.type === "i32le") { val = `${buf.readInt32LE(pos)}`; size = 4; }
          else if (fd.type.startsWith("bytes:")) { const n = parseInt(fd.type.split(":")[1]); val = buf.slice(pos, pos + n).toString("hex").toUpperCase().match(/.{1,2}/g)?.join(" ") || ""; size = n; }
          else if (fd.type.startsWith("char:")) { const n = parseInt(fd.type.split(":")[1]); val = `"${buf.slice(pos, pos + n).toString().replace(/\0/g, "")}"`; size = n; }
          else if (fd.type.startsWith("skip:")) { const n = parseInt(fd.type.split(":")[1]); val = `(${n} bytes skipped)`; size = n; }
          else { val = `unknown type: ${fd.type}`; size = 0; }
          cols.push(`  [+0x${(off - rowStart).toString(16).padStart(4, "0")}] ${fd.name} (${fd.type}): ${val}`);
          pos += size;
        }
        rows.push(`--- Entry ${r} @ 0x${rowStart.toString(16).toUpperCase()} ---\n${cols.join("\n")}`);
      }
      return rows.join("\n\n");
    },
  },
  // ── hex_diff ───────────────────────────────────────────────────────────────
  {
    name: "hex_diff",
    description: "Compare two regions of a file byte-by-byte. Shows only lines that differ. Provide offsetA and offsetB within the same file, or use filePathB to compare against a second file.",
    inputSchema: {
      type: "object" as const,
      properties: {
        offsetA: { type: "number", description: "Start offset in the primary file" },
        filePathB: { type: "string", description: "Optional: absolute path to second file (default: same file)" },
        offsetB: { type: "number", description: "Start offset in file B" },
        length: { type: "number", description: "Number of bytes to compare (default 256, max 4096)" },
      },
      required: ["offsetA", "offsetB"],
    },
    async call(args: Record<string, unknown>, filePath: string): Promise<string> {
      const fsM = await import("fs");
      const bufA = fsM.readFileSync(filePath);
      const bufB = fsM.readFileSync((args.filePathB as string) || filePath);
      const len = Math.min((args.length as number) || 256, 4096);
      const a = bufA.slice(args.offsetA as number, (args.offsetA as number) + len);
      const b = bufB.slice(args.offsetB as number, (args.offsetB as number) + len);
      const cmpLen = Math.min(a.length, b.length);
      const lines: string[] = [];
      let diffCount = 0;
      for (let i = 0; i < cmpLen; i += 16) {
        let hasDiff = false;
        for (let j = 0; j < 16 && i + j < cmpLen; j++) if (a[i + j] !== b[i + j]) { hasDiff = true; diffCount++; }
        if (!hasDiff) continue;
        let hexA = "", hexB = "";
        for (let j = 0; j < 16 && i + j < cmpLen; j++) { hexA += a[i + j].toString(16).padStart(2, "0") + " "; hexB += b[i + j].toString(16).padStart(2, "0") + " "; }
        lines.push(`0x${i.toString(16).padStart(8, "0")}  A: ${hexA.trimEnd()}\n            B: ${hexB.trimEnd()}`);
      }
      return lines.length === 0 ? `No differences in ${cmpLen} bytes` : `${diffCount} differing bytes:\n\n${lines.join("\n\n")}`;
    },
  },
  // ── binary_slice ──────────────────────────────────────────────────────────
  {
    name: "binary_slice",
    description: "Extract a region from a binary file, detect its magic bytes, compute entropy, and return a hex dump. Useful for isolating embedded payloads.",
    inputSchema: {
      type: "object" as const,
      properties: {
        offset: { type: "number", description: "Start offset" },
        length: { type: "number", description: "Number of bytes to extract (max 65536)" },
      },
      required: ["offset", "length"],
    },
    async call(args: Record<string, unknown>, filePath: string): Promise<string> {
      const fsM = await import("fs");
      const buf = fsM.readFileSync(filePath);
      const offset = args.offset as number;
      const slice = buf.slice(offset, offset + Math.min(args.length as number, 65536));
      let magic = "unknown";
      if (slice.length >= 4) {
        if (slice[0] === 0x4d && slice[1] === 0x5a) magic = "PE (MZ)";
        else if (slice[0] === 0x7f && slice[1] === 0x45 && slice[2] === 0x4c && slice[3] === 0x46) magic = "ELF";
        else if (slice[0] === 0x50 && slice[1] === 0x4b && slice[2] === 0x03 && slice[3] === 0x04) magic = "ZIP/PK";
        else if (slice[0] === 0x89 && slice[1] === 0x50 && slice[2] === 0x4e && slice[3] === 0x47) magic = "PNG";
        else if (slice[0] === 0xff && slice[1] === 0xd8 && slice[2] === 0xff) magic = "JPEG";
        else if (slice[0] === 0x1f && slice[1] === 0x8b) magic = "GZIP";
        else if (slice[0] === 0x52 && slice[1] === 0x61 && slice[2] === 0x72 && slice[3] === 0x21) magic = "RAR";
        else if (slice[0] === 0x37 && slice[1] === 0x7a && slice[2] === 0xbc && slice[3] === 0xaf) magic = "7-Zip";
      }
      const entropy = _calcEnt(slice);
      const hexLines: string[] = [];
      for (let i = 0; i < Math.min(slice.length, 512); i += 16) {
        const addr = (offset + i).toString(16).toUpperCase().padStart(8, "0");
        let hex = "", ascii = "";
        for (let j = 0; j < 16 && i + j < slice.length; j++) {
          const b = slice[i + j];
          hex += b.toString(16).padStart(2, "0") + " ";
          ascii += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".";
          if (j === 7) hex += " ";
        }
        hexLines.push(`${addr}  ${hex.padEnd(49)} |${ascii}|`);
      }
      return `Offset: 0x${offset.toString(16).toUpperCase()}, Size: ${slice.length} bytes\nMagic: ${magic}\nEntropy: ${entropy.toFixed(3)} bits/byte\n\n${hexLines.join("\n")}${slice.length > 512 ? `\n... (${slice.length - 512} more bytes)` : ""}`;
    },
  },
  // ── checksum_brute ────────────────────────────────────────────────────────
  {
    name: "checksum_brute",
    description: "Compute all common checksums over a region: Sum8, XOR8, Sum16-LE/BE, XOR16-LE, CRC-16-CCITT (init 0xFFFF and 0x0000), Fletcher-16, CRC-32, Adler-32. Identifies what checksum algorithm a binary uses.",
    inputSchema: {
      type: "object" as const,
      properties: {
        start: { type: "number", description: "Start offset (inclusive)" },
        end: { type: "number", description: "End offset (exclusive)" },
      },
      required: ["start", "end"],
    },
    async call(args: Record<string, unknown>, filePath: string): Promise<string> {
      const fsM = await import("fs");
      const buf = fsM.readFileSync(filePath);
      const start = args.start as number;
      const end = args.end as number;
      const region = buf.slice(start, end);
      const res: string[] = [`Checksum brute-force 0x${start.toString(16).toUpperCase()}–0x${end.toString(16).toUpperCase()} (${region.length} bytes):\n`];
      let sum8 = 0; for (let i = 0; i < region.length; i++) sum8 = (sum8 + region[i]) & 0xff;
      res.push(`Sum8:             0x${sum8.toString(16).toUpperCase().padStart(2, "0")}`);
      res.push(`Sum8-neg:         0x${((~sum8 + 1) & 0xff).toString(16).toUpperCase().padStart(2, "0")}`);
      let xor8 = 0; for (let i = 0; i < region.length; i++) xor8 ^= region[i];
      res.push(`XOR8:             0x${xor8.toString(16).toUpperCase().padStart(2, "0")}`);
      let sum16le = 0, sum16be = 0;
      for (let i = 0; i + 1 < region.length; i += 2) { sum16le = (sum16le + region.readUInt16LE(i)) & 0xffff; sum16be = (sum16be + region.readUInt16BE(i)) & 0xffff; }
      res.push(`Sum16-LE:         0x${sum16le.toString(16).toUpperCase().padStart(4, "0")}`);
      res.push(`Sum16-BE:         0x${sum16be.toString(16).toUpperCase().padStart(4, "0")}`);
      let xor16 = 0; for (let i = 0; i + 1 < region.length; i += 2) xor16 ^= region.readUInt16LE(i);
      res.push(`XOR16-LE:         0x${xor16.toString(16).toUpperCase().padStart(4, "0")}`);
      let crc16 = 0xffff;
      for (let i = 0; i < region.length; i++) { crc16 ^= region[i] << 8; for (let j = 0; j < 8; j++) crc16 = (crc16 & 0x8000) ? ((crc16 << 1) ^ 0x1021) : (crc16 << 1); crc16 &= 0xffff; }
      res.push(`CRC-16-CCITT:     0x${crc16.toString(16).toUpperCase().padStart(4, "0")}  (poly=0x1021, init=0xFFFF)`);
      let crc16z = 0;
      for (let i = 0; i < region.length; i++) { crc16z ^= region[i] << 8; for (let j = 0; j < 8; j++) crc16z = (crc16z & 0x8000) ? ((crc16z << 1) ^ 0x1021) : (crc16z << 1); crc16z &= 0xffff; }
      res.push(`CRC-16-CCITT-0:   0x${crc16z.toString(16).toUpperCase().padStart(4, "0")}  (poly=0x1021, init=0x0000)`);
      let f1 = 0, f2 = 0; for (let i = 0; i < region.length; i++) { f1 = (f1 + region[i]) % 255; f2 = (f2 + f1) % 255; }
      res.push(`Fletcher-16:      0x${((f2 << 8) | f1).toString(16).toUpperCase().padStart(4, "0")}`);
      const tbl: number[] = []; for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); tbl.push(c); }
      let crc32 = 0xffffffff; for (let i = 0; i < region.length; i++) crc32 = tbl[(crc32 ^ region[i]) & 0xff] ^ (crc32 >>> 8); crc32 = (crc32 ^ 0xffffffff) >>> 0;
      res.push(`CRC-32:           0x${crc32.toString(16).toUpperCase().padStart(8, "0")}`);
      let a1 = 1, a2 = 0; for (let i = 0; i < region.length; i++) { a1 = (a1 + region[i]) % 65521; a2 = (a2 + a1) % 65521; }
      res.push(`Adler-32:         0x${(((a2 << 16) | a1) >>> 0).toString(16).toUpperCase().padStart(8, "0")}`);
      return res.join("\n");
    },
  },
  // ── crc_verify ────────────────────────────────────────────────────────────
  {
    name: "crc_verify",
    description: "Compute CRC-16, CRC-32, Sum8, Sum16-LE over a region and optionally compare against a stored value at a given offset. Reports if the stored value matches any algorithm.",
    inputSchema: {
      type: "object" as const,
      properties: {
        start: { type: "number", description: "Start of region to checksum (inclusive)" },
        end: { type: "number", description: "End of region to checksum (exclusive)" },
        storedOffset: { type: "number", description: "Optional: offset where the stored checksum lives (for comparison)" },
      },
      required: ["start", "end"],
    },
    async call(args: Record<string, unknown>, filePath: string): Promise<string> {
      const fsM = await import("fs");
      const buf = fsM.readFileSync(filePath);
      const start = args.start as number;
      const end = args.end as number;
      const region = buf.slice(start, end);
      let crc16 = 0xffff;
      for (let i = 0; i < region.length; i++) { crc16 ^= region[i] << 8; for (let j = 0; j < 8; j++) crc16 = (crc16 & 0x8000) ? ((crc16 << 1) ^ 0x1021) : (crc16 << 1); crc16 &= 0xffff; }
      const tbl: number[] = []; for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); tbl.push(c); }
      let crc32 = 0xffffffff; for (let i = 0; i < region.length; i++) crc32 = tbl[(crc32 ^ region[i]) & 0xff] ^ (crc32 >>> 8); crc32 = (crc32 ^ 0xffffffff) >>> 0;
      let sum8 = 0, sum16le = 0;
      for (let i = 0; i < region.length; i++) sum8 = (sum8 + region[i]) & 0xff;
      for (let i = 0; i + 1 < region.length; i += 2) sum16le = (sum16le + region.readUInt16LE(i)) & 0xffff;
      const lines = [
        `Region: 0x${start.toString(16).toUpperCase()}–0x${end.toString(16).toUpperCase()} (${region.length} bytes)`,
        `CRC-16-CCITT: 0x${crc16.toString(16).toUpperCase().padStart(4, "0")}`,
        `CRC-32:       0x${crc32.toString(16).toUpperCase().padStart(8, "0")}`,
        `Sum8:         0x${sum8.toString(16).toUpperCase().padStart(2, "0")}`,
        `Sum16-LE:     0x${sum16le.toString(16).toUpperCase().padStart(4, "0")}`,
      ];
      const storedOffset = args.storedOffset as number | undefined;
      if (storedOffset !== undefined && storedOffset + 4 <= buf.length) {
        const s16be = buf.readUInt16BE(storedOffset), s16le = buf.readUInt16LE(storedOffset);
        const s32be = buf.readUInt32BE(storedOffset), s32le = buf.readUInt32LE(storedOffset);
        lines.push(`\nStored at 0x${storedOffset.toString(16).toUpperCase()}: 0x${buf.slice(storedOffset, storedOffset + 4).toString("hex").toUpperCase()}`);
        if (crc16 === s16be) lines.push("MATCH: CRC-16 (BE)");
        else if (crc16 === s16le) lines.push("MATCH: CRC-16 (LE)");
        else if (crc32 === s32be) lines.push("MATCH: CRC-32 (BE)");
        else if (crc32 === s32le) lines.push("MATCH: CRC-32 (LE)");
        else lines.push("No match — try checksum_brute for more algorithms");
      }
      return lines.join("\n");
    },
  },
  // ── rva_resolver ──────────────────────────────────────────────────────────
  {
    name: "rva_resolver",
    description: "For PE files: convert between Virtual Address (VA), Relative Virtual Address (RVA), and file offset. Shows which section the address falls in and the bytes at that location.",
    inputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "number", description: "The address to resolve" },
        addrType: { type: "string", enum: ["va", "rva", "file_offset"], description: "Type: 'va', 'rva', or 'file_offset'" },
      },
      required: ["address"],
    },
    async call(args: Record<string, unknown>, filePath: string): Promise<string> {
      const fsM = await import("fs");
      const buf = fsM.readFileSync(filePath);
      const pe = _parsePECtx(buf);
      if (!pe) return "ERROR: Not a valid PE file";
      const address = args.address as number;
      const addrType = (args.addrType as string) || "va";
      let rva: number, va: number, fileOffset: number | null = null, section = "unmapped";
      if (addrType === "va") { va = address; rva = va - pe.imageBase; }
      else if (addrType === "rva") { rva = address; va = pe.imageBase + rva; }
      else { fileOffset = address; rva = pe.off2rva(address); va = pe.imageBase + rva; }
      if (fileOffset === null) {
        const off = pe.rva2off(rva);
        for (const s of pe.sections) { if (rva >= s.va && rva < s.va + s.rawSize) { fileOffset = off; section = s.name; break; } }
      } else {
        for (const s of pe.sections) { if (fileOffset >= s.rawOff && fileOffset < s.rawOff + s.rawSize) { section = s.name; break; } }
      }
      let bytesAt = "";
      if (fileOffset !== null && fileOffset < buf.length) bytesAt = buf.slice(fileOffset, Math.min(fileOffset + 32, buf.length)).toString("hex").toUpperCase().match(/.{1,2}/g)?.join(" ") || "";
      return `VA:          0x${va.toString(16).toUpperCase()}\nRVA:         0x${rva.toString(16).toUpperCase()}\nFile Offset: ${fileOffset !== null ? "0x" + fileOffset.toString(16).toUpperCase() : "unmapped"}\nSection:     ${section}\nImage Base:  0x${pe.imageBase.toString(16).toUpperCase()}\nBytes[0:32]: ${bytesAt}`;
    },
  },
  // ── pe_exports_deep ───────────────────────────────────────────────────────
  {
    name: "pe_exports_deep",
    description: "List all exported functions from a PE DLL/EXE with ordinals, RVAs, and basic demangling of C++ names. Optionally filter by substring.",
    inputSchema: {
      type: "object" as const,
      properties: {
        filter: { type: "string", description: "Optional substring filter for export names" },
      },
      required: [],
    },
    async call(args: Record<string, unknown>, filePath: string): Promise<string> {
      const fsM = await import("fs");
      const buf = fsM.readFileSync(filePath);
      const pe = _parsePECtx(buf);
      if (!pe) return "ERROR: Not a valid PE file";
      const exportRVA = pe.is64 ? buf.readUInt32LE(pe.optOff + 112) : buf.readUInt32LE(pe.optOff + 96);
      const exportSize = pe.is64 ? buf.readUInt32LE(pe.optOff + 116) : buf.readUInt32LE(pe.optOff + 100);
      if (exportRVA === 0) return "No export table found";
      const expOff = pe.rva2off(exportRVA);
      if (expOff + 40 > buf.length) return "Export table out of bounds";
      const numFuncs = buf.readUInt32LE(expOff + 20);
      const numNames = buf.readUInt32LE(expOff + 24);
      const ordBase = buf.readUInt32LE(expOff + 16);
      const funcRVA = pe.rva2off(buf.readUInt32LE(expOff + 28));
      const nameRVA = pe.rva2off(buf.readUInt32LE(expOff + 32));
      const ordRVA = pe.rva2off(buf.readUInt32LE(expOff + 36));
      const dllName = _readCStr(buf, pe.rva2off(buf.readUInt32LE(expOff + 12)));
      const filterLc = ((args.filter as string) || "").toLowerCase();
      const lines = [`DLL: ${dllName}  |  Functions: ${numFuncs}  |  Named: ${numNames}  |  OrdBase: ${ordBase}\n`];
      for (let i = 0; i < numNames && i < 5000; i++) {
        if (nameRVA + i * 4 + 4 > buf.length) break;
        const namePtr = pe.rva2off(buf.readUInt32LE(nameRVA + i * 4));
        const funcName = _readCStr(buf, namePtr);
        if (filterLc && !funcName.toLowerCase().includes(filterLc)) continue;
        if (ordRVA + i * 2 + 2 > buf.length) break;
        const ord = buf.readUInt16LE(ordRVA + i * 2);
        if (funcRVA + ord * 4 + 4 > buf.length) break;
        const funcAddr = buf.readUInt32LE(funcRVA + ord * 4);
        let forwarded = "";
        if (funcAddr >= exportRVA && funcAddr < exportRVA + exportSize) forwarded = ` → ${_readCStr(buf, pe.rva2off(funcAddr))}`;
        const demangled = funcName.startsWith("?") ? funcName.replace(/^\?/, "").replace(/@/g, "::").replace(/::$/, "") : "";
        lines.push(`  ord=${ord + ordBase}  rva=0x${funcAddr.toString(16).toUpperCase().padStart(8, "0")}  ${funcName}${demangled ? ` [${demangled}]` : ""}${forwarded}`);
      }
      return lines.join("\n");
    },
  },
  // ── section_permissions ───────────────────────────────────────────────────
  {
    name: "section_permissions",
    description: "List all PE sections with their RWX permissions, entropy, and security alerts (e.g. RWX sections indicate code injection surface). Essential for PE security analysis.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    async call(_args: Record<string, unknown>, filePath: string): Promise<string> {
      const fsM = await import("fs");
      const buf = fsM.readFileSync(filePath);
      const pe = _parsePECtx(buf);
      if (!pe) return "ERROR: Not a valid PE file";
      const lines = [`PE Sections (${pe.is64 ? "64-bit" : "32-bit"}, ImageBase=0x${pe.imageBase.toString(16).toUpperCase()}):\n`];
      for (const s of pe.sections) {
        const R = !!(s.chars & 0x40000000), W = !!(s.chars & 0x80000000), X = !!(s.chars & 0x20000000);
        const flags: string[] = [];
        if (s.chars & 0x00000020) flags.push("CODE");
        if (s.chars & 0x00000040) flags.push("IDATA");
        if (s.chars & 0x00000080) flags.push("UDATA");
        if (s.chars & 0x02000000) flags.push("DISCARDABLE");
        if (s.chars & 0x10000000) flags.push("SHARED");
        const secBuf = buf.slice(s.rawOff, s.rawOff + Math.min(s.rawSize, 65536));
        const ent = secBuf.length > 0 ? _calcEnt(secBuf) : 0;
        let alert = "";
        if (R && W && X) alert = " *** RWX — CODE INJECTION SURFACE";
        else if (W && X) alert = " *** WX — SUSPICIOUS";
        lines.push(`  ${s.name.padEnd(10)} VA=0x${s.va.toString(16).toUpperCase().padStart(8, "0")}  VSize=0x${s.vsize.toString(16).toUpperCase().padStart(6, "0")}  RawSize=0x${s.rawSize.toString(16).toUpperCase().padStart(6, "0")}  ${R ? "R" : "-"}${W ? "W" : "-"}${X ? "X" : "-"}  Entropy=${ent.toFixed(2)}  [${flags.join(",")}]${alert}`);
      }
      return lines.join("\n");
    },
  },
  // ── import_xref ───────────────────────────────────────────────────────────
  {
    name: "import_xref",
    description: "Find all call sites in a PE binary for a specific imported function. Shows file offset and instruction type (CALL or JMP) for each reference.",
    inputSchema: {
      type: "object" as const,
      properties: {
        filter: { type: "string", description: "Function name substring (e.g. 'CryptEncrypt', 'CreateProcess', 'VirtualAlloc')" },
      },
      required: ["filter"],
    },
    async call(args: Record<string, unknown>, filePath: string): Promise<string> {
      const fsM = await import("fs");
      const buf = fsM.readFileSync(filePath);
      const pe = _parsePECtx(buf);
      if (!pe) return "ERROR: Not a valid PE file";
      const imports = _parsePEImportsExt(buf, pe);
      const filterLc = (args.filter as string).toLowerCase();
      let textStart = 0, textEnd = buf.length;
      for (const s of pe.sections) { if (s.name === ".text" || s.name === "CODE") { textStart = s.rawOff; textEnd = s.rawOff + s.rawSize; break; } }
      const lines: string[] = [];
      for (const imp of imports) {
        let iatSlotRva = imp.iatRva;
        const entrySize = pe.is64 ? 8 : 4;
        for (const fn of imp.functions) {
          if (!fn.name.toLowerCase().includes(filterLc)) { iatSlotRva += entrySize; continue; }
          const callSites: string[] = [];
          for (let i = textStart; i < textEnd - 6 && callSites.length < 20; i++) {
            if (buf[i] === 0xff && (buf[i + 1] === 0x15 || buf[i + 1] === 0x25)) {
              if (pe.is64) { const rel = buf.readInt32LE(i + 2); const targetRva = pe.off2rva(i + 6) + rel; if (Math.abs(targetRva - iatSlotRva) < 4) callSites.push(`    0x${i.toString(16).toUpperCase()} — ${buf[i + 1] === 0x15 ? "CALL" : "JMP"} [IAT]`); }
              else { const abs = buf.readUInt32LE(i + 2); if (abs === pe.imageBase + iatSlotRva) callSites.push(`    0x${i.toString(16).toUpperCase()} — ${buf[i + 1] === 0x15 ? "CALL" : "JMP"} [IAT]`); }
            }
          }
          if (callSites.length > 0) { lines.push(`${imp.dll}!${fn.name} (IAT slot RVA=0x${iatSlotRva.toString(16).toUpperCase()}):`); lines.push(...callSites); }
          iatSlotRva += entrySize;
        }
      }
      return lines.length > 0 ? lines.join("\n") : `No call sites found for '${args.filter}'`;
    },
  },
  // ── string_xref ───────────────────────────────────────────────────────────
  {
    name: "string_xref",
    description: "Find all occurrences of a string (ASCII and UTF-16LE) in a binary, and for PE files, find all code references to each occurrence.",
    inputSchema: {
      type: "object" as const,
      properties: {
        search: { type: "string", description: "String to search for" },
        maxRefs: { type: "number", description: "Max references per occurrence (default 20)" },
      },
      required: ["search"],
    },
    async call(args: Record<string, unknown>, filePath: string): Promise<string> {
      const fsM = await import("fs");
      const buf = fsM.readFileSync(filePath);
      const search = args.search as string;
      const maxRefs = (args.maxRefs as number) || 20;
      const occurrences: Array<{ offset: number; encoding: string; refs: Array<{ offset: number; ctx: string }> }> = [];
      let pos = 0;
      while (pos < buf.length) { const idx = buf.indexOf(Buffer.from(search, "ascii"), pos); if (idx === -1) break; occurrences.push({ offset: idx, encoding: "ascii", refs: [] }); pos = idx + 1; if (occurrences.length > 50) break; }
      const u16Buf = Buffer.alloc(search.length * 2);
      for (let i = 0; i < search.length; i++) u16Buf.writeUInt16LE(search.charCodeAt(i), i * 2);
      pos = 0;
      while (pos < buf.length) { const idx = buf.indexOf(u16Buf, pos); if (idx === -1) break; occurrences.push({ offset: idx, encoding: "utf16le", refs: [] }); pos = idx + 1; if (occurrences.length > 50) break; }
      const pe = _parsePECtx(buf);
      if (pe) {
        for (const occ of occurrences) {
          const addrBuf = Buffer.alloc(4); addrBuf.writeUInt32LE(occ.offset);
          let rpos = 0;
          while (rpos < buf.length - 4 && occ.refs.length < maxRefs) { const idx = buf.indexOf(addrBuf, rpos); if (idx === -1) break; const ctx = buf.slice(Math.max(0, idx - 2), Math.min(idx + 6, buf.length)).toString("hex").toUpperCase(); occ.refs.push({ offset: idx, ctx }); rpos = idx + 1; }
        }
      }
      if (occurrences.length === 0) return `String '${search}' not found`;
      const lines = [`String '${search}' — ${occurrences.length} occurrence(s):\n`];
      for (const occ of occurrences) {
        lines.push(`  0x${occ.offset.toString(16).toUpperCase()} [${occ.encoding}]`);
        for (const ref of occ.refs) lines.push(`    referenced at 0x${ref.offset.toString(16).toUpperCase()} — ctx: ${ref.ctx}`);
      }
      return lines.join("\n");
    },
  },
  // ── pe_overlay ────────────────────────────────────────────────────────────
  {
    name: "pe_overlay",
    description: "Detect data appended after the end of a PE file (overlay). Common in PyInstaller, NSIS, Inno Setup, and self-extracting archives.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    async call(_args: Record<string, unknown>, filePath: string): Promise<string> {
      const fsM = await import("fs");
      const buf = fsM.readFileSync(filePath);
      const pe = _parsePECtx(buf);
      if (!pe) return "ERROR: Not a valid PE file";
      let peEnd = 0;
      for (const s of pe.sections) peEnd = Math.max(peEnd, s.rawOff + s.rawSize);
      if (peEnd >= buf.length) return `No overlay — PE ends at 0x${peEnd.toString(16).toUpperCase()}, file size = ${buf.length} bytes`;
      const overlay = buf.slice(peEnd);
      const sigs: string[] = [];
      if (overlay[0] === 0x4d && overlay[1] === 0x5a) sigs.push("Embedded PE (MZ)");
      if (overlay[0] === 0x50 && overlay[1] === 0x4b) sigs.push("Embedded ZIP");
      if (overlay.indexOf(Buffer.from("Rar!")) !== -1) sigs.push("Embedded RAR");
      if (overlay.indexOf(Buffer.from("MSCF")) !== -1) sigs.push("Embedded CAB");
      if (overlay.indexOf(Buffer.from([0x4d, 0x45, 0x49, 0x0c])) !== -1) sigs.push("PyInstaller archive");
      if (overlay.indexOf(Buffer.from("Inno Setup")) !== -1) sigs.push("Inno Setup");
      if (overlay.indexOf(Buffer.from("NullsoftInst")) !== -1) sigs.push("NSIS installer");
      const strs: string[] = []; let run = "";
      for (let i = 0; i < Math.min(overlay.length, 8192); i++) { if (overlay[i] >= 0x20 && overlay[i] <= 0x7e) run += String.fromCharCode(overlay[i]); else { if (run.length >= 6) strs.push(run.slice(0, 80)); run = ""; } }
      if (run.length >= 6) strs.push(run.slice(0, 80));
      return `PE ends at:    0x${peEnd.toString(16).toUpperCase()}\nFile size:     ${buf.length} bytes\nOverlay size:  ${overlay.length} bytes\nOverlay magic: ${overlay.slice(0, 8).toString("hex").toUpperCase()}\nEntropy:       ${_calcEnt(overlay).toFixed(3)} bits/byte\nSignatures:    ${sigs.length > 0 ? sigs.join(", ") : "none detected"}\n\nFirst strings in overlay:\n${strs.slice(0, 15).map((s: string) => "  " + s).join("\n")}`;
    },
  },
  // ── find_references ───────────────────────────────────────────────────────
  {
    name: "find_references",
    description: "Find all 16-bit or 32-bit LE and BE references to a numeric value in a binary. Useful for finding all places that reference a specific address, constant, or CAN ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        value: { type: "number", description: "The numeric value to search for" },
        size: { type: "number", description: "Size in bytes: 2 (16-bit) or 4 (32-bit). Default 4." },
        maxResults: { type: "number", description: "Maximum results to return (default 100)" },
      },
      required: ["value"],
    },
    async call(args: Record<string, unknown>, filePath: string): Promise<string> {
      const fsM = await import("fs");
      const buf = fsM.readFileSync(filePath);
      const value = args.value as number;
      const sz = (args.size as number) === 2 ? 2 : 4;
      const maxResults = (args.maxResults as number) || 100;
      const hits: string[] = [];
      for (let i = 0; i <= buf.length - sz && hits.length < maxResults; i++) {
        let matchLE = false, matchBE = false;
        if (sz === 4) { if (buf.readUInt32LE(i) === value) matchLE = true; if (buf.readUInt32BE(i) === value) matchBE = true; }
        else { if (buf.readUInt16LE(i) === value) matchLE = true; if (buf.readUInt16BE(i) === value) matchBE = true; }
        if (matchLE || matchBE) {
          const ctx = buf.slice(Math.max(0, i - 4), Math.min(i + sz + 4, buf.length)).toString("hex").toUpperCase().match(/.{1,2}/g)?.join(" ") || "";
          if (matchLE) hits.push(`  0x${i.toString(16).toUpperCase().padStart(8, "0")} [LE] ctx: ${ctx}`);
          else if (matchBE) hits.push(`  0x${i.toString(16).toUpperCase().padStart(8, "0")} [BE] ctx: ${ctx}`);
        }
      }
      return hits.length > 0 ? `Found ${hits.length} reference(s) to 0x${value.toString(16).toUpperCase()} (${sz}-byte):\n${hits.join("\n")}` : `No references to 0x${value.toString(16).toUpperCase()} found`;
    },
  },
  // ── srec_ihex_parse ───────────────────────────────────────────────────────
  {
    name: "srec_ihex_parse",
    description: "Parse Motorola S-Record (.srec, .s19) or Intel HEX (.hex, .ihex) firmware files. Extracts memory regions, addresses, data, and entry point.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    async call(_args: Record<string, unknown>, filePath: string): Promise<string> {
      const fsM = await import("fs");
      const text = fsM.readFileSync(filePath, "utf8");
      const lines = text.split(/[\r\n]+/).filter((l: string) => l.trim().length > 0);
      if (lines.length === 0) return "Empty file";
      let format: "srec" | "ihex" | "unknown" = "unknown";
      if (lines[0].startsWith("S")) format = "srec";
      else if (lines[0].startsWith(":")) format = "ihex";
      else return "Not an SREC or IHEX file";
      const chunks: Array<{ address: number; data: Buffer }> = [];
      let entry: number | null = null;
      if (format === "srec") {
        for (const line of lines) {
          if (line.length < 4 || line[0] !== "S") continue;
          const type = parseInt(line[1]);
          const bytes = Buffer.from(line.slice(2), "hex");
          const count = bytes[0];
          if (type === 1) chunks.push({ address: bytes.readUInt16BE(1), data: bytes.slice(3, 1 + count - 1) });
          else if (type === 2) chunks.push({ address: (bytes[1] << 16) | bytes.readUInt16BE(2), data: bytes.slice(4, 1 + count - 1) });
          else if (type === 3) chunks.push({ address: bytes.readUInt32BE(1), data: bytes.slice(5, 1 + count - 1) });
          else if (type === 7) entry = bytes.readUInt32BE(1);
          else if (type === 8) entry = (bytes[1] << 16) | bytes.readUInt16BE(2);
          else if (type === 9) entry = bytes.readUInt16BE(1);
        }
      } else {
        let baseAddr = 0;
        for (const line of lines) {
          if (line[0] !== ":") continue;
          const bytes = Buffer.from(line.slice(1), "hex");
          const count = bytes[0], addr = bytes.readUInt16BE(1), type = bytes[3];
          if (type === 0x00) chunks.push({ address: baseAddr + addr, data: bytes.slice(4, 4 + count) });
          else if (type === 0x02) baseAddr = bytes.readUInt16BE(4) << 4;
          else if (type === 0x04) baseAddr = bytes.readUInt16BE(4) << 16;
          else if (type === 0x05) entry = bytes.readUInt32BE(4);
        }
      }
      if (chunks.length === 0) return "No data records found";
      chunks.sort((a: { address: number }, b: { address: number }) => a.address - b.address);
      const regions: Array<{ address: number; size: number; entropy: number; preview: string }> = [];
      let cur = { address: chunks[0].address, bufs: [chunks[0].data] };
      for (let i = 1; i < chunks.length; i++) {
        const expected = cur.address + cur.bufs.reduce((s: number, b: Buffer) => s + b.length, 0);
        if (chunks[i].address === expected) cur.bufs.push(chunks[i].data);
        else {
          const merged = Buffer.concat(cur.bufs);
          regions.push({ address: cur.address, size: merged.length, entropy: _calcEnt(merged), preview: merged.slice(0, 16).toString("hex").toUpperCase().match(/.{1,2}/g)?.join(" ") || "" });
          cur = { address: chunks[i].address, bufs: [chunks[i].data] };
        }
      }
      const lastMerged = Buffer.concat(cur.bufs);
      regions.push({ address: cur.address, size: lastMerged.length, entropy: _calcEnt(lastMerged), preview: lastMerged.slice(0, 16).toString("hex").toUpperCase().match(/.{1,2}/g)?.join(" ") || "" });
      const totalBytes = regions.reduce((s: number, r: { size: number }) => s + r.size, 0);
      const out = [`Format: ${format.toUpperCase()}, ${regions.length} region(s), ${totalBytes} total bytes${entry !== null ? `, entry=0x${entry.toString(16).toUpperCase()}` : ""}\n`];
      for (const r of regions) out.push(`  0x${r.address.toString(16).toUpperCase().padStart(8, "0")}  size=${r.size}  entropy=${r.entropy.toFixed(2)}  preview: ${r.preview}`);
      return out.join("\n");
    },
  },
  // ── dll_dependency_tree ───────────────────────────────────────────────────
  {
    name: "dll_dependency_tree",
    description: "List all DLL imports for a PE file with function counts and security-relevant API highlights (VirtualAlloc, CreateProcess, CryptEncrypt, IsDebuggerPresent, etc.).",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    async call(_args: Record<string, unknown>, filePath: string): Promise<string> {
      const fsM = await import("fs");
      const buf = fsM.readFileSync(filePath);
      const pe = _parsePECtx(buf);
      if (!pe) return "ERROR: Not a valid PE file";
      const imports = _parsePEImportsExt(buf, pe);
      if (imports.length === 0) return "No imports found";
      const notable = new Set(["CreateFileA","CreateFileW","ReadFile","WriteFile","DeleteFileA","DeleteFileW","CreateProcessA","CreateProcessW","ShellExecuteA","ShellExecuteW","VirtualAlloc","VirtualAllocEx","VirtualProtect","WriteProcessMemory","ReadProcessMemory","GetProcAddress","LoadLibraryA","LoadLibraryW","GetModuleHandleA","RegOpenKeyExA","RegOpenKeyExW","RegSetValueExA","RegSetValueExW","InternetOpenA","InternetOpenW","HttpOpenRequestA","URLDownloadToFileA","WSAStartup","connect","send","recv","socket","CryptEncrypt","CryptDecrypt","CryptGenKey","CryptAcquireContextA","NtCreateThread","NtWriteVirtualMemory","NtQueueApcThread","IsDebuggerPresent","CheckRemoteDebuggerPresent","NtQueryInformationProcess"]);
      const lines: string[] = [];
      for (const imp of imports) {
        const highlights = imp.functions.filter((f: { name: string }) => notable.has(f.name)).map((f: { name: string }) => f.name);
        lines.push(`  ${imp.dll.padEnd(35)} ${imp.functions.length} functions${highlights.length > 0 ? "  *** " + highlights.join(", ") : ""}`);
      }
      return `DLL Dependency Tree (${imports.length} DLLs):\n${lines.join("\n")}`;
    },
  },
  // ── resource_extractor ────────────────────────────────────────────────────
  {
    name: "resource_extractor",
    description: "Extract PE resource directory: icons, bitmaps, version info (FileVersion, ProductVersion, CompanyName, etc.), and embedded manifests.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    async call(_args: Record<string, unknown>, filePath: string): Promise<string> {
      const fsM = await import("fs");
      const buf = fsM.readFileSync(filePath);
      const pe = _parsePECtx(buf);
      if (!pe) return "ERROR: Not a valid PE file";
      const rsrcDirRVA = pe.is64 ? buf.readUInt32LE(pe.optOff + 136) : buf.readUInt32LE(pe.optOff + 120);
      if (rsrcDirRVA === 0) return "No resource directory found";
      const rsrcBase = pe.rva2off(rsrcDirRVA);
      const RESOURCE_TYPES: Record<number, string> = {1:"CURSOR",2:"BITMAP",3:"ICON",4:"MENU",5:"DIALOG",6:"STRING",7:"FONTDIR",8:"FONT",9:"ACCELERATOR",10:"RCDATA",11:"MESSAGETABLE",12:"GROUP_CURSOR",14:"GROUP_ICON",16:"VERSION",17:"DLGINCLUDE",19:"PLUGPLAY",20:"VFW",21:"ANICURSOR",22:"ANIICON",23:"HTML",24:"MANIFEST"};
      const entries: string[] = [];
      let versionInfo: Record<string, string> | null = null;
      let manifest: string | null = null;
      try {
        const numNamed1 = buf.readUInt16LE(rsrcBase + 12), numId1 = buf.readUInt16LE(rsrcBase + 14);
        for (let t = 0; t < numNamed1 + numId1 && t < 50; t++) {
          const e1 = rsrcBase + 16 + t * 8;
          if (e1 + 8 > buf.length) break;
          const typeId = buf.readUInt32LE(e1), typeOff = buf.readUInt32LE(e1 + 4);
          if (!(typeOff & 0x80000000)) continue;
          const dir2Off = rsrcBase + (typeOff & 0x7fffffff);
          if (dir2Off + 16 > buf.length) continue;
          const numNamed2 = buf.readUInt16LE(dir2Off + 12), numId2 = buf.readUInt16LE(dir2Off + 14);
          for (let n = 0; n < numNamed2 + numId2 && n < 100; n++) {
            const e2 = dir2Off + 16 + n * 8;
            if (e2 + 8 > buf.length) break;
            const nameOff = buf.readUInt32LE(e2 + 4);
            if (!(nameOff & 0x80000000)) continue;
            const dir3Off = rsrcBase + (nameOff & 0x7fffffff);
            if (dir3Off + 16 > buf.length) continue;
            const numNamed3 = buf.readUInt16LE(dir3Off + 12), numId3 = buf.readUInt16LE(dir3Off + 14);
            for (let l = 0; l < numNamed3 + numId3 && l < 20; l++) {
              const e3 = dir3Off + 16 + l * 8;
              if (e3 + 8 > buf.length) break;
              const dataOff = buf.readUInt32LE(e3 + 4);
              if (dataOff & 0x80000000) continue;
              const dataEntry = rsrcBase + dataOff;
              if (dataEntry + 16 > buf.length) continue;
              const dataRVA = buf.readUInt32LE(dataEntry), dataSize = buf.readUInt32LE(dataEntry + 4);
              const fileOff = pe.rva2off(dataRVA);
              const typeName = RESOURCE_TYPES[typeId] || `CUSTOM_${typeId}`;
              const preview = buf.slice(fileOff, Math.min(fileOff + 16, buf.length)).toString("hex").toUpperCase().match(/.{1,2}/g)?.join(" ") || "";
              entries.push(`  ${typeName.padEnd(16)} offset=0x${fileOff.toString(16).toUpperCase()}  size=${dataSize}  preview: ${preview}`);
              if (typeId === 16 && fileOff + dataSize <= buf.length) {
                const vdata = buf.slice(fileOff, fileOff + dataSize);
                const vkeys = ["FileVersion","ProductVersion","CompanyName","FileDescription","InternalName","LegalCopyright","OriginalFilename","ProductName"];
                const vresult: Record<string, string> = {};
                for (const key of vkeys) {
                  const keyU16 = Buffer.alloc(key.length * 2);
                  for (let i = 0; i < key.length; i++) keyU16.writeUInt16LE(key.charCodeAt(i), i * 2);
                  const idx = vdata.indexOf(keyU16); if (idx === -1) continue;
                  let vStart = idx + keyU16.length;
                  while (vStart + 1 < vdata.length && vdata[vStart] === 0 && vdata[vStart + 1] === 0) vStart += 2;
                  let val = "";
                  for (let i = vStart; i + 1 < vdata.length; i += 2) { const ch = vdata.readUInt16LE(i); if (ch === 0) break; val += String.fromCharCode(ch); }
                  if (val) vresult[key] = val;
                }
                if (Object.keys(vresult).length > 0) versionInfo = vresult;
              }
              if (typeId === 24 && fileOff + dataSize <= buf.length) manifest = buf.slice(fileOff, fileOff + dataSize).toString("utf8").replace(/\0/g, "").slice(0, 2000);
            }
          }
        }
      } catch { /* best-effort */ }
      const out = [`Resources (${entries.length} entries):\n`, ...entries];
      if (versionInfo) { out.push("\nVersion Info:"); for (const [k, v] of Object.entries(versionInfo)) out.push(`  ${k}: ${v}`); }
      if (manifest) out.push(`\nManifest (first 500 chars):\n${manifest.slice(0, 500)}`);
      return out.join("\n");
    },
  },
  // ── base64_blob_finder ────────────────────────────────────────────────────
  {
    name: "base64_blob_finder",
    description: "Find base64-encoded and hex-encoded blobs in a binary file. Decodes each blob and reports size, entropy, and magic bytes. Useful for finding embedded payloads.",
    inputSchema: {
      type: "object" as const,
      properties: {
        minLen: { type: "number", description: "Minimum encoded string length (default 32)" },
        maxBlobs: { type: "number", description: "Maximum blobs to return (default 50)" },
      },
      required: [],
    },
    async call(args: Record<string, unknown>, filePath: string): Promise<string> {
      const fsM = await import("fs");
      const buf = fsM.readFileSync(filePath);
      const minLen = (args.minLen as number) || 32;
      const maxBlobs = (args.maxBlobs as number) || 50;
      const blobs: string[] = [];
      const b64re = /[A-Za-z0-9+/]{32,}={0,3}/g;
      const hexre = /[0-9A-Fa-f]{64,}/g;
      const runs: Array<{ offset: number; text: string }> = [];
      let run = "", runStart = 0;
      for (let i = 0; i < buf.length; i++) { if (buf[i] >= 0x20 && buf[i] <= 0x7e) { if (run.length === 0) runStart = i; run += String.fromCharCode(buf[i]); } else { if (run.length >= minLen) runs.push({ offset: runStart, text: run }); run = ""; } }
      if (run.length >= minLen) runs.push({ offset: runStart, text: run });
      for (const r of runs) {
        if (blobs.length >= maxBlobs) break;
        let match: RegExpExecArray | null;
        b64re.lastIndex = 0;
        while ((match = b64re.exec(r.text)) !== null && blobs.length < maxBlobs) {
          if (match[0].length < minLen) continue;
          try {
            const decoded = Buffer.from(match[0], "base64");
            if (decoded.length < 8) continue;
            const ent = _calcEnt(decoded);
            let magic = "unknown";
            if (decoded[0] === 0x4d && decoded[1] === 0x5a) magic = "PE";
            else if (decoded[0] === 0x7f && decoded[1] === 0x45) magic = "ELF";
            else if (decoded[0] === 0x50 && decoded[1] === 0x4b) magic = "ZIP";
            else if (decoded[0] === 0x1f && decoded[1] === 0x8b) magic = "GZIP";
            blobs.push(`  0x${(r.offset + match.index).toString(16).toUpperCase()} [base64] len=${match[0].length} → decoded=${decoded.length}B entropy=${ent.toFixed(2)} magic=${magic}  preview: ${match[0].slice(0, 40)}...`);
          } catch { /* skip */ }
        }
        hexre.lastIndex = 0;
        while ((match = hexre.exec(r.text)) !== null && blobs.length < maxBlobs) {
          if (match[0].length < 64) continue;
          try {
            const decoded = Buffer.from(match[0], "hex");
            if (decoded.length < 16) continue;
            const ent = _calcEnt(decoded);
            let magic = "unknown";
            if (decoded[0] === 0x4d && decoded[1] === 0x5a) magic = "PE";
            else if (decoded[0] === 0x50 && decoded[1] === 0x4b) magic = "ZIP";
            blobs.push(`  0x${(r.offset + match.index).toString(16).toUpperCase()} [hex] len=${match[0].length} → decoded=${decoded.length}B entropy=${ent.toFixed(2)} magic=${magic}  preview: ${match[0].slice(0, 40)}...`);
          } catch { /* skip */ }
        }
      }
      return blobs.length > 0 ? `Found ${blobs.length} encoded blob(s):\n${blobs.join("\n")}` : "No base64 or hex-encoded blobs found";
    },
  },
  // ── scan_key_material ─────────────────────────────────────────────────────
  {
    name: "scan_key_material",
    description: "Comprehensive secret scanner: finds PEM blocks (certificates, private keys), SSH keys, JWTs, API keys (AWS, Google, GitHub, Stripe, etc.), high-entropy blobs (possible encryption keys), and known crypto constants (AES S-Box, SHA-256 init values, CRC-32 polynomial, etc.).",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    async call(_args: Record<string, unknown>, filePath: string): Promise<string> {
      const fsM = await import("fs");
      const buf = fsM.readFileSync(filePath);
      const text = buf.toString("latin1");
      const results: string[] = [];
      // PEM blocks
      const beginPrefix = "-----BEGIN ";
      let searchFrom = 0;
      while (searchFrom < text.length) {
        const beginIdx = text.indexOf(beginPrefix, searchFrom);
        if (beginIdx === -1) break;
        const lineEnd = text.indexOf("\n", beginIdx);
        if (lineEnd === -1) break;
        const headerLine = text.slice(beginIdx, lineEnd).trim();
        const typeMatch = headerLine.match(/^-----BEGIN (.+)-----$/);
        if (typeMatch) {
          const pemType = typeMatch[1];
          const endMarker = `-----END ${pemType}-----`;
          const endIdx = text.indexOf(endMarker, lineEnd);
          if (endIdx !== -1) results.push(`  0x${beginIdx.toString(16).toUpperCase()} [PEM] ${pemType} (${endIdx + endMarker.length - beginIdx} chars)`);
        }
        searchFrom = lineEnd + 1;
      }
      // SSH keys
      const sshPatterns = [/ssh-rsa AAAA[A-Za-z0-9+/]+=*/g, /ssh-ed25519 AAAA[A-Za-z0-9+/]+=*/g, /ecdsa-sha2-nistp\d+ AAAA[A-Za-z0-9+/]+=*/g];
      for (const re of sshPatterns) { re.lastIndex = 0; let m: RegExpExecArray | null; while ((m = re.exec(text)) !== null) results.push(`  0x${m.index.toString(16).toUpperCase()} [SSH Key] ${m[0].slice(0, 60)}...`); }
      // JWTs
      const jwtRe = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
      jwtRe.lastIndex = 0; let jwtM: RegExpExecArray | null;
      while ((jwtM = jwtRe.exec(text)) !== null) results.push(`  0x${jwtM.index.toString(16).toUpperCase()} [JWT] ${jwtM[0].slice(0, 60)}...`);
      // API keys
      const apiPatterns = [
        { name: "AWS Access Key ID", re: /AKIA[0-9A-Z]{16}/g },
        { name: "Google API Key", re: /AIza[0-9A-Za-z_-]{35}/g },
        { name: "GitHub Token", re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
        { name: "Slack Token", re: /xox[bpoas]-[0-9A-Za-z-]{10,}/g },
        { name: "Stripe Key", re: /sk_(?:live|test)_[0-9A-Za-z]{24,}/g },
        { name: "Generic API Key", re: /(?:api[_-]?key|apikey|api[_-]?token|auth[_-]?token)\s*[=:]\s*["']?([A-Za-z0-9_\-]{20,})/gi },
        { name: "Password in config", re: /(?:password|passwd|pwd)\s*[=:]\s*["']([^"'\s]{8,})["']/gi },
        { name: "Bearer Token", re: /Bearer\s+([A-Za-z0-9_\-\.]{20,})/gi },
      ];
      for (const { name, re } of apiPatterns) { re.lastIndex = 0; let m: RegExpExecArray | null; while ((m = re.exec(text)) !== null) results.push(`  0x${m.index.toString(16).toUpperCase()} [${name}] ${m[0].slice(0, 80)}`); }
      // High-entropy blobs
      const ENTROPY_WINDOW = 256, ENTROPY_STEP = 64, ENTROPY_THRESHOLD = 7.2, MIN_BLOB_SIZE = 64;
      let inHighRegion = false, regionStart = 0;
      for (let i = 0; i + ENTROPY_WINDOW <= buf.length; i += ENTROPY_STEP) {
        const window = buf.slice(i, i + ENTROPY_WINDOW);
        const ent = _calcEnt(window);
        if (ent >= ENTROPY_THRESHOLD) { if (!inHighRegion) { regionStart = i; inHighRegion = true; } }
        else if (inHighRegion) {
          const size = i - regionStart;
          if (size >= MIN_BLOB_SIZE && results.length < 100) {
            const regionBuf = buf.slice(regionStart, i);
            const regionEnt = _calcEnt(regionBuf);
            const hexPreview = regionBuf.subarray(0, 16).toString("hex").toUpperCase().match(/.{1,2}/g)?.join(" ") || "";
            results.push(`  0x${regionStart.toString(16).toUpperCase()} [High-Entropy Blob] ${size}B entropy=${regionEnt.toFixed(2)} preview: ${hexPreview}`);
          }
          inHighRegion = false;
        }
      }
      // Crypto constants
      const CRYPTO_CONSTANTS = [
        { name: "AES Forward S-Box", needle: Buffer.from([0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76]) },
        { name: "AES Inverse S-Box", needle: Buffer.from([0x52,0x09,0x6a,0xd5,0x30,0x36,0xa5,0x38,0xbf,0x40,0xa3,0x9e,0x81,0xf3,0xd7,0xfb]) },
        { name: "SHA-256 H0-H1", needle: Buffer.from([0x6a,0x09,0xe6,0x67,0xbb,0x67,0xae,0x85]) },
        { name: "SHA-256 H0-H1 BE", needle: Buffer.from([0x67,0xe6,0x09,0x6a,0x85,0xae,0x67,0xbb]) },
        { name: "SHA-1 H0", needle: Buffer.from([0x67,0x45,0x23,0x01,0xef,0xcd,0xab,0x89]) },
        { name: "MD5 H0", needle: Buffer.from([0x01,0x23,0x45,0x67,0x89,0xab,0xcd,0xef]) },
        { name: "CRC-32 Polynomial", needle: Buffer.from([0x04,0xc1,0x1d,0xb7]) },
        { name: "CRC-32 Reflected Poly", needle: Buffer.from([0xed,0xb8,0x83,0x20]) },
        { name: "AES-GCM GHASH Poly", needle: Buffer.from([0x87,0x00,0x00,0x00,0x00,0x00,0x00,0x00]) },
      ];
      for (const { name, needle } of CRYPTO_CONSTANTS) {
        let i = 0;
        while (i <= buf.length - needle.length) { const idx = buf.indexOf(needle, i); if (idx === -1) break; const hexPreview = needle.toString("hex").toUpperCase().match(/.{1,2}/g)?.join(" ") || ""; results.push(`  0x${idx.toString(16).toUpperCase()} [Crypto Constant] ${name}: ${hexPreview}`); i = idx + needle.length; }
      }
      return results.length > 0 ? `Found ${results.length} secret/key material finding(s):\n${results.join("\n")}` : "No key material found";
    },
  },
);
// Register swf_extract tool (defined in swf-extract.ts)
import { swfExtractTool } from "./swf-extract.js";
tools.push(swfExtractTool);

// ─── Checksum Tools ───────────────────────────────────────────────────────────
import { FCA_CRC_VARIANTS, MODULE_CRC_REGIONS, crcWithVariant, verifyCrcs, recalculateAllCrcs, formatCrcReport } from "../crc-engine.js";

// checksum_verify: verify all CRC regions for a given module
tools.push({
  name: "checksum_verify",
  description:
    "Verify all CRC-16 checksums for an FCA/Stellantis module EEPROM binary. " +
    "Reads the stored CRC values, auto-detects which polynomial was used (Chrysler 0x589B, Dodge 0x8C5B, Jeep 0xA097, Ferrari 0x71DE, CCITT 0x1021, IBM 0x8005, etc.), " +
    "and reports whether each region PASSES or FAILS. " +
    "Use this BEFORE patching to understand the checksum state, and AFTER patching to confirm all CRCs are valid. " +
    "Supported modules: BCM, RFHUB, GPEC, PCM, TCM, IPC, ADCM, EPS, UNKNOWN (wildcard).",
  inputSchema: {
    type: "object",
    properties: {
      module: {
        type: "string",
        description: "Module type: BCM, RFHUB, GPEC, PCM, TCM, IPC, ADCM, EPS, or UNKNOWN for generic scan",
        enum: ["BCM", "RFHUB", "GPEC", "PCM", "TCM", "IPC", "ADCM", "EPS", "UNKNOWN"],
      },
    },
    required: ["module"],
  },
  async call(args, filePath) {
    const buf = await fs.readFile(filePath);
    const module = (args.module as string) || "UNKNOWN";
    const results = verifyCrcs(buf, module);
    if (results.length === 0) {
      return `No CRC regions defined for module ${module}. File size: ${buf.length} bytes.`;
    }
    const lines = [`═══ CHECKSUM VERIFICATION: ${module} (${buf.length} bytes) ═══`];
    let passCount = 0, failCount = 0, skipCount = 0;
    for (const r of results) {
      if (r.skipped) {
        skipCount++;
        lines.push(`  [SKIP] ${r.regionName}: ${r.skipReason}`);
      } else if (r.valid) {
        passCount++;
        lines.push(`  [PASS] ${r.regionName} @ 0x${r.crcOffset.toString(16).toUpperCase()}: stored=0x${r.storedCrc.toString(16).toUpperCase().padStart(4,"0")} computed=0x${r.expectedCrc.toString(16).toUpperCase().padStart(4,"0")} poly=${r.variantUsed}`);
      } else {
        failCount++;
        lines.push(`  [FAIL] ${r.regionName} @ 0x${r.crcOffset.toString(16).toUpperCase()}: stored=0x${r.storedCrc.toString(16).toUpperCase().padStart(4,"0")} expected=0x${r.expectedCrc.toString(16).toUpperCase().padStart(4,"0")} poly=${r.variantUsed}${r.polyMatched ? "" : " (no exact poly match — best guess)"}`);
      }
    }
    lines.push(`\nSummary: ${passCount} PASS, ${failCount} FAIL, ${skipCount} SKIP`);
    if (failCount > 0) {
      lines.push(`⚠ ${failCount} checksum(s) are INVALID — use checksum_fix to correct them before writing to module.`);
    } else if (passCount > 0) {
      lines.push(`✓ All checksums valid. File is safe to write to module.`);
    }
    return lines.join("\n");
  },
});

// checksum_brute_poly: brute-force identify the CRC polynomial used for a specific region (FCA/Stellantis-specific)
tools.push({
  name: "checksum_brute_poly",
  description:
    "Brute-force identify the CRC-16 polynomial used to protect a specific byte region in an EEPROM binary (FCA/Stellantis modules). " +
    "Provide the data region offset/length and the CRC storage offset. " +
    "Tries all 17 known FCA/Stellantis CRC variants plus the full 16-bit polynomial space (65536 values) if needed. " +
    "Use this when checksum_verify reports 'no exact poly match' to find the correct algorithm.",
  inputSchema: {
    type: "object",
    properties: {
      data_offset: {
        type: "string",
        description: "Hex offset of the data block covered by the CRC (e.g. '0x160')",
      },
      data_length: {
        type: "string",
        description: "Length in bytes of the data block (e.g. '17' or '0x11')",
      },
      crc_offset: {
        type: "string",
        description: "Hex offset where the 2-byte CRC is stored (e.g. '0x1F0')",
      },
      endian: {
        type: "string",
        description: "Byte order of stored CRC: 'BE' (big-endian, default) or 'LE' (little-endian)",
        enum: ["BE", "LE"],
      },
    },
    required: ["data_offset", "data_length", "crc_offset"],
  },
  async call(args, filePath) {
    const buf = await fs.readFile(filePath);
    const dataOffset = parseInt(args.data_offset as string, 16);
    const dataLength = parseInt(args.data_length as string);
    const crcOffset = parseInt(args.crc_offset as string, 16);
    const isBE = (args.endian as string || "BE") !== "LE";

    if (isNaN(dataOffset) || isNaN(dataLength) || isNaN(crcOffset)) {
      return "Error: invalid offset/length values. Use hex for offsets (e.g. '0x160') and decimal for length.";
    }
    if (dataOffset + dataLength > buf.length || crcOffset + 2 > buf.length) {
      return `Error: region out of file bounds. File size=${buf.length}, need data up to 0x${(dataOffset+dataLength).toString(16)}, CRC at 0x${crcOffset.toString(16)}.`;
    }

    const data = buf.subarray(dataOffset, dataOffset + dataLength);
    const storedCrc = isBE ? buf.readUInt16BE(crcOffset) : buf.readUInt16LE(crcOffset);

    const lines = [
      `═══ CRC BRUTE-FORCE: data=0x${dataOffset.toString(16).toUpperCase()}+${dataLength}B crc@0x${crcOffset.toString(16).toUpperCase()} stored=0x${storedCrc.toString(16).toUpperCase().padStart(4,"0")} ═══`,
      `Data preview: ${data.subarray(0,16).toString("hex").toUpperCase().match(/.{1,2}/g)?.join(" ")}${dataLength > 16 ? "..." : ""}`,
      "",
      "Phase 1: Testing all 17 known FCA/Stellantis variants...",
    ];

    const matches: string[] = [];

    // Phase 1: known variants
    for (const v of FCA_CRC_VARIANTS) {
      const computed = crcWithVariant(data, v);
      if (computed === storedCrc) {
        matches.push(`  ✓ MATCH: ${v.name} poly=0x${v.polynomial.toString(16).toUpperCase()} init=0x${v.init.toString(16).toUpperCase()} refIn=${v.reflectInput} refOut=${v.reflectOutput} xorOut=0x${v.xorOut.toString(16).toUpperCase()}`);
      }
    }

    if (matches.length > 0) {
      lines.push(...matches);
      lines.push(`\n✓ Found ${matches.length} matching variant(s) in Phase 1. No brute-force needed.`);
      return lines.join("\n");
    }

    lines.push("  No known variant matched.");
    lines.push("Phase 2: Brute-forcing all 65536 polynomials (init=0xFFFF, no reflection)...");

    // Phase 2: brute-force all polynomials with common init values
    const bruteMatches: string[] = [];
    const initValues = [0xFFFF, 0x0000, 0x1D0F];
    for (const init of initValues) {
      for (let poly = 0; poly <= 0xFFFF; poly++) {
        const computed = crcWithVariant(data, { name: "", polynomial: poly, init, reflectInput: false, reflectOutput: false, xorOut: 0 });
        if (computed === storedCrc) {
          bruteMatches.push(`  ✓ poly=0x${poly.toString(16).toUpperCase().padStart(4,"0")} init=0x${init.toString(16).toUpperCase().padStart(4,"0")} refIn=false refOut=false`);
          if (bruteMatches.length >= 20) break;
        }
      }
      if (bruteMatches.length >= 20) break;
    }

    if (bruteMatches.length > 0) {
      lines.push(...bruteMatches);
      if (bruteMatches.length >= 20) lines.push("  ... (truncated at 20 results)");
    } else {
      lines.push("  No polynomial match found. The CRC may use reflection, XOR-out, or a non-standard algorithm.");
      lines.push("  Try providing different data_offset/data_length — the covered region may differ from expected.");
    }
    return lines.join("\n");
  },
});

// checksum_fix: recalculate and write all CRC checksums for a module
tools.push({
  name: "checksum_fix",
  description:
    "Recalculate and write all CRC-16 checksums for an FCA/Stellantis module EEPROM binary. " +
    "Auto-detects the polynomial from the original data, then writes the correct CRC to all slots. " +
    "For dual-CRC modules (GPEC, RFHUB, ADCM), writes to both the primary and mirror CRC slots. " +
    "Returns the patched binary as a base64-encoded string. " +
    "IMPORTANT: This modifies the file in-place. Always verify with checksum_verify after.",
  inputSchema: {
    type: "object",
    properties: {
      module: {
        type: "string",
        description: "Module type: BCM, RFHUB, GPEC, PCM, TCM, IPC, ADCM, EPS, or UNKNOWN",
        enum: ["BCM", "RFHUB", "GPEC", "PCM", "TCM", "IPC", "ADCM", "EPS", "UNKNOWN"],
      },
    },
    required: ["module"],
  },
  async call(args, filePath) {
    const original = await fs.readFile(filePath);
    const module = (args.module as string) || "UNKNOWN";
    const patched = Buffer.from(original);
    const results = recalculateAllCrcs(patched, module, original);
    const report = formatCrcReport(results);

    const fixCount = results.filter(r => !r.skipped && r.oldCrc !== r.newCrc).length;
    const skipCount = results.filter(r => r.skipped).length;

    // Write the patched file back
    await fs.writeFile(filePath, patched);

    const lines = [
      report,
      "",
      `Fixed ${fixCount} checksum(s), skipped ${skipCount} region(s).`,
      `Patched file written (${patched.length} bytes). Run checksum_verify to confirm.`,
    ];
    return lines.join("\n");
  },
});

// ─── Tool Registry ────────────────────────────────────────────────────────────
export function getToolByName(name: string): ToolDefinition | undefined {
  return tools.find((t) => t.name === name);
}

export function getToolSchemas() {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}
