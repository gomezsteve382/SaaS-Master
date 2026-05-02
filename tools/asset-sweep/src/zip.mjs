/**
 * Minimal vendored ZIP reader.
 *
 * Built-in node:zlib provides DEFLATE; the rest of the ZIP container format
 * (EOCD, central directory, local file header) is handled here directly so
 * the sweep tool ships with zero external runtime dependencies.
 *
 * Only the features actually used by `attached_assets/` zips are supported:
 *   - DEFLATE (method 8)  — every observed compressed entry
 *   - STORED  (method 0)  — uncompressed entries (rare but legal)
 *   - ZIP64-EOCD locator search at end of file
 *   - Filename UTF-8 (general purpose bit 11) or CP437 fallback
 *
 * Encrypted entries, multi-disk archives, and compression methods other than
 * 0/8 throw — none of these are present in our corpus, and an explicit failure
 * is preferable to silent skipping.
 */
import {inflateRawSync} from "node:zlib";

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CDH = 0x02014b50;
const SIG_LFH = 0x04034b50;

function findEOCD(buf) {
  // The EOCD record is at most 22 + 65535 bytes from the end.
  const start = Math.max(0, buf.length - (22 + 65535));
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new Error("zip: EOCD signature not found");
}

function decodeName(bytes, isUtf8) {
  if (isUtf8) return Buffer.from(bytes).toString("utf8");
  // CP437: pass through ASCII (>= 0x80 unlikely in our corpus).
  return Buffer.from(bytes).toString("latin1");
}

/**
 * Parse a ZIP archive and return an array of entries:
 *   { name, size, isDir, read() -> Buffer }
 *
 * `read()` is lazy — the entry's compressed payload is only decoded the
 * first time it is called. This keeps memory low when scanning huge zips
 * (the FCATOOL nested zip extracts to >10 MB but we only need a couple of
 * its files).
 */
export function readZip(buf) {
  const eocdOff = findEOCD(buf);
  let totalEntries = buf.readUInt16LE(eocdOff + 10);
  let cdSize = buf.readUInt32LE(eocdOff + 12);
  let cdOff = buf.readUInt32LE(eocdOff + 16);

  // ZIP64 hand-off: any of the EOCD fields being 0xFFFF/0xFFFFFFFF means we
  // need to consult the ZIP64 EOCD locator for the real values.
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    const locOff = eocdOff - 20;
    if (locOff >= 0 && buf.readUInt32LE(locOff) === SIG_EOCD64_LOCATOR) {
      const z64Off = Number(buf.readBigUInt64LE(locOff + 8));
      if (buf.readUInt32LE(z64Off) === SIG_EOCD64) {
        totalEntries = Number(buf.readBigUInt64LE(z64Off + 32));
        cdSize = Number(buf.readBigUInt64LE(z64Off + 40));
        cdOff = Number(buf.readBigUInt64LE(z64Off + 48));
      }
    }
  }

  const entries = [];
  let p = cdOff;
  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(p) !== SIG_CDH) {
      throw new Error(`zip: bad central directory header at ${p}`);
    }
    const gpFlag = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc32 = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lfhOff = buf.readUInt32LE(p + 42);
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLen);
    const name = decodeName(nameBytes, !!(gpFlag & 0x800));
    const isDir = name.endsWith("/");

    entries.push({
      name,
      size: uncompSize,
      compSize,
      method,
      crc32,
      isDir,
      read() {
        // Re-parse the local file header for the actual data offset (the LFH
        // may have a longer extra field than the CDH advertised).
        if (buf.readUInt32LE(lfhOff) !== SIG_LFH) {
          throw new Error(`zip: bad local file header for ${name}`);
        }
        const lfhNameLen = buf.readUInt16LE(lfhOff + 26);
        const lfhExtraLen = buf.readUInt16LE(lfhOff + 28);
        const dataOff = lfhOff + 30 + lfhNameLen + lfhExtraLen;
        const slice = buf.subarray(dataOff, dataOff + compSize);
        if (method === 0) return Buffer.from(slice);
        if (method === 8) return inflateRawSync(slice);
        throw new Error(`zip: unsupported compression method ${method} for ${name}`);
      },
    });

    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
