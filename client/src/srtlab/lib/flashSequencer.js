// UDS Flash Sequencer — 10-phase Mopar flash template + .efd file parser
//
// The Mopar/Stellantis UDS flash sequence is documented in:
//   - PROVENANCE.md (flash routines 1126/1520/1750/1751 follow 10-phase template)
//   - UDS_Complete_Reference.pdf §8 (extracted in prior session)
//   - CDA.swf class `com.chrysler.cda.application.diagnostic.flash`
//
// .efd file format (Mopar's encrypted flash data):
//   - 32 KB cabinet/header file (offset 0..0x8000)
//   - N data blocks with addresses + length + raw bytes
//   - Trailer with checksums + signing data
//   - Total file sizes from firmware_database.json: 528 KB to 4 MB
//
// The actual .efd format is FCA proprietary. This module provides:
//   1. A header parser that infers structure from observed sizes
//   2. The 10-phase UDS flash sequencer that drives the actual reprogramming
//   3. Per-module flash strategies (PCM vs TCM vs SGW differ in detail)

import { buildIsoTpFrames, IsoTpReassembler } from "./isotp.js";

// ─── UDS service IDs ──────────────────────────────────────────────────────
export const UDS_SID = {
  DSC: 0x10,
  ECUReset: 0x11,
  ClearDTC: 0x14,
  ReadDTC: 0x19,
  RDBI: 0x22,
  SecurityAccess: 0x27,
  CommunicationControl: 0x28,
  WDBI: 0x2e,
  IOControl: 0x2f,
  RoutineControl: 0x31,
  RequestDownload: 0x34,
  RequestUpload: 0x35,
  TransferData: 0x36,
  RequestTransferExit: 0x37,
  WriteMemoryByAddress: 0x3d,
  TesterPresent: 0x3e,
};

// ─── DSC sessions ─────────────────────────────────────────────────────────
export const DSC_SESSIONS = {
  DEFAULT: 0x01,
  PROGRAMMING: 0x02,
  EXTENDED: 0x03,
  SAFETY_SYS: 0x04,
  // FCA-specific from our IL extraction
  FCA_40: 0x40,
  FCA_50: 0x50,
  FCA_60: 0x60,
  FCA_70: 0x70,
  FCA_81: 0x81,
  FCA_92: 0x92,
  FCA_FA: 0xfa,
};

// ─── 10-PHASE FLASH SEQUENCE ──────────────────────────────────────────────
/**
 * Drive a Mopar UDS flash session through all 10 phases:
 *   1. Open extended diagnostic session (10 03)
 *   2. Disable normal communication (28 81 03)
 *   3. Disable DTC monitoring (85 02)
 *   4. Enter programming session (10 02)
 *   5. SecurityAccess unlock (27 01 → 27 02 <key>)
 *   6. Write fingerprint (DID 0xF15A typical: 2E F1 5A <16 bytes tester ID + date>)
 *   7. RequestDownload (34 00 44 <addr 4B> <length 4B>)
 *   8. TransferData loop (36 <seq> <data 4093 bytes>) repeat
 *   9. RequestTransferExit (37)
 *  10. RoutineControl checksum (31 01 02 02 <crc 2B>) + ECUReset (11 01)
 *
 * Returns a generator that yields each phase's frames and expected responses.
 *
 * @param {object} options
 * @param {object} options.client      PassThruClient instance
 * @param {number} options.channelId   Active CAN channel
 * @param {number} options.txCanId     Target ECU CAN ID (e.g., 0x7E0 PCM)
 * @param {number} options.rxCanId     Response CAN ID (e.g., 0x7E8 PCM)
 * @param {object} options.cipher      { unlockKey(seedBytes) → keyBytes }
 * @param {Uint8Array} options.firmware  Parsed .efd binary or raw flash blob
 * @param {Array}  options.blocks      [{address, data}] from parseEfd()
 * @param {number} options.checksum    16-bit CRC of the firmware
 */
export async function* flashSequence({ client, channelId, txCanId, rxCanId, cipher, firmware, blocks, checksum, fingerprint }) {
  // ─── Phase 1: Open Extended Diagnostic Session
  yield { phase: 1, name: "OpenExtendedSession", uds: [UDS_SID.DSC, DSC_SESSIONS.EXTENDED] };

  // ─── Phase 2: Disable normal communication (silence other modules)
  yield { phase: 2, name: "DisableNormalComm", uds: [UDS_SID.CommunicationControl, 0x81, 0x03] };

  // ─── Phase 3: Disable DTC monitoring
  yield { phase: 3, name: "DisableDtcMonitoring", uds: [0x85, 0x02] };

  // ─── Phase 4: Programming Session
  yield { phase: 4, name: "OpenProgrammingSession", uds: [UDS_SID.DSC, DSC_SESSIONS.PROGRAMMING] };

  // ─── Phase 5: SecurityAccess
  // 5a. Request seed (27 01)
  const seedResponse = yield { phase: 5, sub: "a", name: "RequestSeed", uds: [UDS_SID.SecurityAccess, 0x01] };
  // Expected: 67 01 <4-byte seed>
  if (!seedResponse || seedResponse.length < 6 || seedResponse[0] !== 0x67 || seedResponse[1] !== 0x01) {
    throw new Error(`SecurityAccess request-seed failed: ${Array.from(seedResponse || []).map((b) => b.toString(16)).join(" ")}`);
  }
  const seed = seedResponse.subarray(2, 6);
  const key = cipher.unlockKey(seed);
  // 5b. Send key (27 02 <key>)
  yield { phase: 5, sub: "b", name: "SendKey", uds: [UDS_SID.SecurityAccess, 0x02, ...key] };

  // ─── Phase 6: Write Fingerprint (typical FCA programming requirement)
  if (fingerprint) {
    // DID 0xF15A is the standard "Calibration verification fingerprint"
    yield { phase: 6, name: "WriteFingerprint", uds: [UDS_SID.WDBI, 0xf1, 0x5a, ...fingerprint] };
  }

  // ─── Phase 7: RequestDownload — for each contiguous block
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const addr = block.address;
    const len = block.data.length;
    // dataFormatIdentifier=0x00 (no compression/encryption indication)
    // addressAndLengthFormatIdentifier=0x44 (4-byte address, 4-byte length)
    const addrBytes = [(addr >> 24) & 0xff, (addr >> 16) & 0xff, (addr >> 8) & 0xff, addr & 0xff];
    const lenBytes = [(len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff];
    const reqDownloadResp = yield {
      phase: 7,
      block: i,
      name: "RequestDownload",
      uds: [UDS_SID.RequestDownload, 0x00, 0x44, ...addrBytes, ...lenBytes],
    };
    // Expected: 74 <lengthFormat> <maxNumberOfBlockLength bytes>
    // Parse max block size from response
    if (!reqDownloadResp || reqDownloadResp[0] !== 0x74) {
      throw new Error(`RequestDownload failed for block ${i}: ${Array.from(reqDownloadResp || []).map((b) => b.toString(16)).join(" ")}`);
    }
    const lengthFormat = (reqDownloadResp[1] >> 4) & 0x0f;
    let maxBlockSize = 0;
    for (let bi = 0; bi < lengthFormat; bi++) {
      maxBlockSize = (maxBlockSize << 8) | reqDownloadResp[2 + bi];
    }
    // ISO-TP frame payload limit minus PCI = (maxBlockSize - 2)
    const chunkSize = maxBlockSize - 2;
    // ─── Phase 8: TransferData loop
    let offset = 0;
    let seq = 1;
    while (offset < block.data.length) {
      const chunk = block.data.subarray(offset, offset + chunkSize);
      yield {
        phase: 8,
        block: i,
        sequence: seq,
        offset,
        name: "TransferData",
        uds: [UDS_SID.TransferData, seq & 0xff, ...chunk],
      };
      offset += chunk.length;
      seq = (seq + 1) & 0xff;
      if (seq === 0) seq = 1; // wrap, skip 0
    }
    // ─── Phase 9: RequestTransferExit
    yield { phase: 9, block: i, name: "RequestTransferExit", uds: [UDS_SID.RequestTransferExit] };
  }

  // ─── Phase 10a: Run checksum routine
  const crcLo = checksum & 0xff;
  const crcHi = (checksum >> 8) & 0xff;
  yield {
    phase: 10,
    sub: "a",
    name: "RoutineChecksumVerify",
    uds: [UDS_SID.RoutineControl, 0x01, 0x02, 0x02, crcHi, crcLo],
  };

  // ─── Phase 10b: ECU Reset
  yield { phase: 10, sub: "b", name: "EcuReset", uds: [UDS_SID.ECUReset, 0x01] };
}

// ─── .efd file parser ─────────────────────────────────────────────────────
/**
 * Parse a Mopar .efd flash file. The format is FCA proprietary but follows a
 * common structure:
 *   - Header (typically 0x80-0x200 bytes) with part number, checksum, layout
 *   - One or more data blocks, each preceded by an address+length header
 *   - Trailer with optional signing/integrity data
 *
 * This parser implements a best-effort heuristic walk. For known patterns
 * (PCM, TCM, SGW from firmware_database.json), specific extractors can be
 * registered.
 *
 * @param {Uint8Array} buf
 * @param {object}     options
 * @param {string}     options.partNumber   e.g. '05035671AB'
 * @param {number}     options.expectedChecksum   from firmware_database.json
 * @returns {object}   { header, blocks: [{address, data}], trailer }
 */
export function parseEfd(buf, { partNumber, expectedChecksum } = {}) {
  if (!buf || buf.length < 0x100) {
    throw new Error("parseEfd: buffer too small (need >= 256 bytes)");
  }
  // Heuristic: scan for ASCII part-number near header
  const headerEnd = locateHeaderEnd(buf);
  const header = {
    raw: buf.subarray(0, headerEnd),
    partNumber: extractAsciiPartNumber(buf.subarray(0, headerEnd)),
  };

  // Walk blocks: each block is preceded by a length-prefix structure that
  // FCA encodes specific to the controller. Common pattern: 4-byte address +
  // 4-byte length BE.
  const blocks = [];
  let offset = headerEnd;
  while (offset < buf.length - 8) {
    // Try a 4+4 byte address+length header
    const addr = (buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3];
    const len = (buf[offset + 4] << 24) | (buf[offset + 5] << 16) | (buf[offset + 6] << 8) | buf[offset + 7];
    // Sanity: addr in valid ECU memory range, len in valid block range
    if (addr >= 0x00000000 && addr < 0xffffffff && len > 0 && len < 0x10000000 && offset + 8 + len <= buf.length) {
      blocks.push({
        address: addr,
        data: buf.subarray(offset + 8, offset + 8 + len),
        headerOffset: offset,
      });
      offset += 8 + len;
    } else {
      // Couldn't parse; advance by 1 (best-effort)
      offset += 1;
      if (blocks.length === 0 && offset > headerEnd + 0x1000) {
        // Give up if we can't find a single block in 4 KB
        break;
      }
    }
  }

  const trailer = buf.subarray(offset);

  // Verify checksum (16-bit CRC over all block data)
  const calc = computeCrc16(blocks.flatMap((b) => Array.from(b.data)));
  const checksumMatch = expectedChecksum !== undefined ? calc === expectedChecksum : null;

  return {
    header,
    blocks,
    trailer,
    checksumCalculated: calc,
    checksumExpected: expectedChecksum,
    checksumMatch,
    partNumber: header.partNumber || partNumber,
  };
}

function locateHeaderEnd(buf) {
  // FCA .efd headers typically end at a power-of-2 boundary with the part
  // number followed by version + date. Heuristic: scan for first repeated
  // 0xFF sequence (erased flash placeholder) or first all-zero block.
  for (let i = 0x80; i < Math.min(buf.length, 0x2000); i += 0x10) {
    let allFF = true;
    for (let j = 0; j < 0x10; j++) if (buf[i + j] !== 0xff) {
      allFF = false;
      break;
    }
    if (allFF) return i;
  }
  return 0x100; // default
}

function extractAsciiPartNumber(buf) {
  // FCA part numbers are 10 chars like '05035671AB'
  for (let i = 0; i < buf.length - 10; i++) {
    let ok = true;
    for (let j = 0; j < 10; j++) {
      const b = buf[i + j];
      const isDigit = b >= 0x30 && b <= 0x39;
      const isUpper = b >= 0x41 && b <= 0x5a;
      if (!isDigit && !isUpper) {
        ok = false;
        break;
      }
    }
    if (ok) {
      let s = "";
      for (let j = 0; j < 10; j++) s += String.fromCharCode(buf[i + j]);
      // Validate FCA shape: starts with digits, ends with letters
      if (/^[0-9]{8}[A-Z]{2}$/.test(s)) return s;
    }
  }
  return null;
}

/**
 * Compute CRC-16-CCITT (poly 0x1021, init 0xFFFF) over data.
 * Mopar uses this for the standard EOL / VIN / flash checksums.
 */
export function computeCrc16(data) {
  let crc = 0xffff;
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      if (crc & 0x8000) crc = ((crc << 1) ^ 0x1021) & 0xffff;
      else crc = (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/**
 * Build a Mopar fingerprint for the WriteFingerprint phase. FCA expects the
 * tester ID (16 bytes typical) prefixed with the programming date.
 *
 * Date format: YYYY-MM-DD encoded as 3 BCD bytes.
 * Tester ID: arbitrary 16 bytes (typically ASCII like 'AlfaOBD2.5.7' padded
 * with 0x00).
 */
export function buildFingerprint(testerId = "SRT-LAB", date = new Date()) {
  const fp = new Uint8Array(19);
  const yy = date.getFullYear() - 2000;
  const mm = date.getMonth() + 1;
  const dd = date.getDate();
  fp[0] = ((yy / 10) << 4) | (yy % 10);
  fp[1] = ((mm / 10) << 4) | (mm % 10);
  fp[2] = ((dd / 10) << 4) | (dd % 10);
  const idBytes = new TextEncoder().encode(testerId.padEnd(16, "\0"));
  fp.set(idBytes.subarray(0, 16), 3);
  return fp;
}
