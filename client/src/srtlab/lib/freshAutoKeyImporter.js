/**
 * freshAutoKeyImporter.js — FreshAuto ring buffer key injection
 * 
 * FreshAuto RFHUBs (Gen1/Gen2) store keys in a ring buffer at 0x0C5E-0x0CDD (128 bytes).
 * Format:
 * - 8 slots, each 8 bytes (8×8 = 64 bytes of key data)
 * - Each slot prefixed with 4-byte header: 5A 5A 95 00 (marker) or 5A 5A 95 00 (empty)
 * - Empty marker: 5A 5A 95 00 FF FF [6 bytes padding]
 * - Write pointer tracked by the last non-empty slot position
 * - Dual-write redundancy: keys are written twice (mirrored)
 * - Checksum at 0x0CDD (XOR of entire 128-byte buffer)
 */

/**
 * Parse FreshAuto ring buffer and return current state
 * 
 * @param {Uint8Array} rfhubData - Full RFHUB dump (4096 bytes)
 * @returns {{ slots: Array, writePointer: number, isEmpty: boolean, checksum: number }}
 */
export function parseFreshAutoRingBuffer(rfhubData) {
  if (!rfhubData || rfhubData.length < 4096) {
    return { slots: [], writePointer: -1, isEmpty: true, checksum: 0 };
  }
  
  const slots = [];
  const RING_BUFFER_START = 0x0C5E;
  const RING_BUFFER_END = 0x0CDD;
  const SLOT_SIZE = 16; // 4-byte header + 8-byte key + 4-byte padding
  
  // Parse all 8 slots
  for (let i = 0; i < 8; i++) {
    const offset = RING_BUFFER_START + (i * SLOT_SIZE);
    const header = rfhubData.slice(offset, offset + 4);
    const keyData = rfhubData.slice(offset + 4, offset + 12);
    const padding = rfhubData.slice(offset + 12, offset + 16);
    
    // Check if slot is empty (5A 5A 95 00 FF FF or all FF)
    const isEmpty = (header[0] === 0x5A && header[1] === 0x5A && header[2] === 0x95 && header[3] === 0x00 && 
                     rfhubData[offset + 4] === 0xFF && rfhubData[offset + 5] === 0xFF) ||
                    keyData.every(b => b === 0xFF);
    
    slots.push({
      slot: i,
      offset,
      header: Array.from(header).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' '),
      key: Array.from(keyData).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(''),
      isEmpty,
    });
  }
  
  // Find write pointer (last non-empty slot)
  let writePointer = -1;
  for (let i = 7; i >= 0; i--) {
    if (!slots[i].isEmpty) {
      writePointer = i;
      break;
    }
  }
  
  // Calculate current checksum
  const bufferData = rfhubData.slice(RING_BUFFER_START, RING_BUFFER_END);
  let checksum = 0;
  for (let i = 0; i < bufferData.length; i++) {
    checksum ^= bufferData[i];
  }
  
  return {
    slots,
    writePointer,
    isEmpty: writePointer === -1,
    checksum,
  };
}

/**
 * Inject a key into the FreshAuto ring buffer at the next write pointer position
 * 
 * @param {Uint8Array} rfhubData - Full RFHUB dump
 * @param {string} keyHex - 16-char hex string (8 bytes: Low SK 4B + High SK 4B)
 * @returns {{ success: boolean, error: string|null, modified: Uint8Array|null, slotUsed: number|null }}
 */
export function injectKeyIntoFreshAutoRingBuffer(rfhubData, keyHex) {
  if (!rfhubData || rfhubData.length !== 4096) {
    return { success: false, error: 'RFHUB must be exactly 4096 bytes', modified: null, slotUsed: null };
  }
  
  if (!keyHex || keyHex.length !== 16) {
    return { success: false, error: 'Key must be 16 hex characters (8 bytes)', modified: null, slotUsed: null };
  }
  
  // Parse current ring buffer state
  const state = parseFreshAutoRingBuffer(rfhubData);
  
  // Determine next write slot
  let nextSlot = state.writePointer + 1;
  if (nextSlot >= 8) {
    nextSlot = 0; // Wrap around
  }
  
  // Convert hex key to bytes
  let keyBytes;
  try {
    keyBytes = [];
    for (let i = 0; i < 16; i += 2) {
      keyBytes.push(parseInt(keyHex.slice(i, i + 2), 16));
    }
  } catch (e) {
    return { success: false, error: 'Invalid hex key format', modified: null, slotUsed: null };
  }
  
  // Copy original data
  const modified = new Uint8Array(rfhubData);
  
  const RING_BUFFER_START = 0x0C5E;
  const SLOT_SIZE = 16;
  const slotOffset = RING_BUFFER_START + (nextSlot * SLOT_SIZE);
  
  // Write key slot: 4-byte header + 8-byte key + 4-byte padding
  // Header: 5A 5A 95 00
  modified[slotOffset] = 0x5A;
  modified[slotOffset + 1] = 0x5A;
  modified[slotOffset + 2] = 0x95;
  modified[slotOffset + 3] = 0x00;
  
  // Key data (8 bytes)
  for (let i = 0; i < 8; i++) {
    modified[slotOffset + 4 + i] = keyBytes[i];
  }
  
  // Padding (4 bytes) — typically 00 00 00 00 or FF FF FF FF
  modified[slotOffset + 12] = 0x00;
  modified[slotOffset + 13] = 0x00;
  modified[slotOffset + 14] = 0x00;
  modified[slotOffset + 15] = 0x00;
  
  // Recalculate checksum
  const RING_BUFFER_END = 0x0CDD;
  let checksum = 0;
  for (let i = RING_BUFFER_START; i < RING_BUFFER_END; i++) {
    checksum ^= modified[i];
  }
  modified[RING_BUFFER_END] = checksum;
  
  return {
    success: true,
    error: null,
    modified,
    slotUsed: nextSlot,
  };
}

/**
 * List all keys currently in the FreshAuto ring buffer
 * 
 * @param {Uint8Array} rfhubData - Full RFHUB dump
 * @returns {Array<{ slot: number, key: string, isEmpty: boolean }>}
 */
export function listFreshAutoKeys(rfhubData) {
  const state = parseFreshAutoRingBuffer(rfhubData);
  return state.slots.map(s => ({
    slot: s.slot,
    key: s.isEmpty ? '(empty)' : s.key,
    isEmpty: s.isEmpty,
  }));
}
