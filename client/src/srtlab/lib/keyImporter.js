/**
 * keyImporter.js — Extract transponder keys from Autel screenshots and write to RFHUB
 * 
 * Supports:
 * - HITAG 2 key extraction from Autel screenshots (Low SK, High SK)
 * - RFHUB key slot writing with checksum recalculation
 * - 8-slot key ring buffer management (0x0C5E-0x0CDD)
 */

// RFHUB key ring buffer checksum is XOR-based, not CRC

/**
 * Parse Autel key screenshot OCR text to extract Low SK and High SK hex values.
 * Looks for patterns like "Low SK: 4D494B52" and "High SK: 4F4E45"
 * 
 * @param {string} ocrText - Raw OCR text from Claude vision
 * @returns {{ lowSk: string|null, highSk: string|null, confidence: number }}
 */
export function parseAutelKeyOcr(ocrText) {
  const text = String(ocrText || '').toUpperCase();
  
  // Pattern 1: "Low SK" / "High SK" with colon
  const lowSkMatch = text.match(/LOW\s*SK\s*[:\s]+([0-9A-F]{8})/);
  const highSkMatch = text.match(/HIGH\s*SK\s*[:\s]+([0-9A-F]{8})/);
  
  // Pattern 2: "Parameter" section with Low/High labels
  const paramMatch = text.match(/PARAMETER[\s\S]*?LOW\s*SK\s*([0-9A-F]{8})[\s\S]*?HIGH\s*SK\s*([0-9A-F]{8})/);
  
  const lowSk = lowSkMatch?.[1] || paramMatch?.[1] || null;
  const highSk = highSkMatch?.[1] || paramMatch?.[2] || null;
  
  // Confidence: 100% if both found, 50% if one found, 0% if none
  const confidence = (lowSk && highSk) ? 100 : (lowSk || highSk) ? 50 : 0;
  
  return {
    lowSk: lowSk ? lowSk.toUpperCase() : null,
    highSk: highSk ? highSk.toUpperCase() : null,
    confidence,
  };
}

/**
 * Convert Low SK (4 bytes) + High SK (4 bytes) into 8-byte key slot format.
 * HITAG 2 slot format: [Low SK 4B] [High SK 4B]
 * 
 * @param {string} lowSkHex - 8-char hex string (e.g. "4D494B52")
 * @param {string} highSkHex - 8-char hex string (e.g. "4F4E45")
 * @returns {Uint8Array|null} - 8-byte key slot, or null if invalid
 */
export function buildKeySlot(lowSkHex, highSkHex) {
  if (!lowSkHex || !highSkHex) return null;
  if (lowSkHex.length !== 8 || highSkHex.length !== 8) return null;
  
  try {
    const lowBytes = [];
    for (let i = 0; i < 8; i += 2) {
      lowBytes.push(parseInt(lowSkHex.slice(i, i + 2), 16));
    }
    const highBytes = [];
    for (let i = 0; i < 8; i += 2) {
      highBytes.push(parseInt(highSkHex.slice(i, i + 2), 16));
    }
    return new Uint8Array([...lowBytes, ...highBytes]);
  } catch (e) {
    return null;
  }
}

/**
 * Write a key slot to the RFHUB key table and recalculate checksum.
 * Key table is at 0x0C5E, 8 slots of 8 bytes each.
 * Checksum is at 0x0CDD (last byte of key ring buffer).
 * 
 * @param {Uint8Array} rfhubData - Full RFHUB dump (4096 bytes)
 * @param {number} slotIndex - Slot number (0-7)
 * @param {Uint8Array} keySlot - 8-byte key slot
 * @returns {{ success: boolean, error: string|null, modified: Uint8Array|null }}
 */
export function writeKeySlotToRfhub(rfhubData, slotIndex, keySlot) {
  if (!rfhubData || rfhubData.length < 4096) {
    return { success: false, error: 'RFHUB must be 4096 bytes', modified: null };
  }
  if (slotIndex < 0 || slotIndex > 7) {
    return { success: false, error: 'Slot index must be 0-7', modified: null };
  }
  if (!keySlot || keySlot.length !== 8) {
    return { success: false, error: 'Key slot must be 8 bytes', modified: null };
  }
  
  // Copy the RFHUB data so we don't mutate the original
  const modified = new Uint8Array(rfhubData);
  
  // Key table starts at 0x0C5E, each slot is 8 bytes
  const slotOffset = 0x0C5E + (slotIndex * 8);
  
  // Write the key slot
  for (let i = 0; i < 8; i++) {
    modified[slotOffset + i] = keySlot[i];
  }
  
  // Recalculate checksum over the entire key ring buffer (0x0C5E-0x0CDD = 128 bytes)
  // Checksum is stored at 0x0CDD
  let checksum = 0;
  for (let i = 0x0C5E; i < 0x0CDD; i++) {
    checksum ^= modified[i];
  }
  modified[0x0CDD] = checksum;
  
  return {
    success: true,
    error: null,
    modified,
  };
}

/**
 * Read a key slot from RFHUB and return as Low SK / High SK hex strings.
 * 
 * @param {Uint8Array} rfhubData - Full RFHUB dump
 * @param {number} slotIndex - Slot number (0-7)
 * @returns {{ lowSk: string, highSk: string, isEmpty: boolean }}
 */
export function readKeySlotFromRfhub(rfhubData, slotIndex) {
  if (!rfhubData || rfhubData.length < 4096 || slotIndex < 0 || slotIndex > 7) {
    return { lowSk: '', highSk: '', isEmpty: true };
  }
  
  const slotOffset = 0x0C5E + (slotIndex * 8);
  const slot = rfhubData.slice(slotOffset, slotOffset + 8);
  
  // Check if slot is empty (all 0xFF or all 0x00)
  const isEmpty = slot.every(b => b === 0xFF || b === 0x00);
  
  // Split into Low SK (bytes 0-3) and High SK (bytes 4-7)
  const lowSk = Array.from(slot.slice(0, 4)).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
  const highSk = Array.from(slot.slice(4, 8)).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
  
  return { lowSk, highSk, isEmpty };
}

/**
 * List all key slots in an RFHUB and return summary.
 * 
 * @param {Uint8Array} rfhubData - Full RFHUB dump
 * @returns {Array<{ slot: number, lowSk: string, highSk: string, isEmpty: boolean }>}
 */
export function listRfhubKeySlots(rfhubData) {
  const slots = [];
  for (let i = 0; i < 8; i++) {
    const { lowSk, highSk, isEmpty } = readKeySlotFromRfhub(rfhubData, i);
    slots.push({ slot: i, lowSk, highSk, isEmpty });
  }
  return slots;
}
