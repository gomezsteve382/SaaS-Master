/**
 * rfhubTypeDetector.js — Detect RFHUB type (FreshAuto vs MPC)
 * 
 * FreshAuto RFHUBs store keys in a ring buffer at 0x0C5E-0x0CDD with markers:
 *   - 5A 5A 95 00 (populated slot header)
 *   - 5A 5A 95 00 FF FF (empty slot marker)
 * 
 * MPC (Charger/Challenger) RFHUBs store keys in an 8-slot table at 0x0C5E:
 *   - 8 slots × 8 bytes each = 64 bytes
 *   - No ring buffer markers; direct key data
 *   - Checksum at 0x0CDD
 */

/**
 * Detect RFHUB type from file contents
 * 
 * @param {Uint8Array} rfhubData - Full RFHUB dump (4096 bytes)
 * @returns {{ type: 'freshAuto' | 'mpc' | 'unknown', confidence: number, reason: string }}
 */
export function detectRfhubType(rfhubData) {
  if (!rfhubData || rfhubData.length !== 4096) {
    return { type: 'unknown', confidence: 0, reason: 'Invalid file size (must be 4096 bytes)' };
  }
  
  const RING_BUFFER_START = 0x0C5E;
  const RING_BUFFER_END = 0x0CDD;
  
  // Check for FreshAuto ring buffer markers
  // FreshAuto pattern: repeating 5A 5A 95 00 markers at slot boundaries
  let freshAutoMarkerCount = 0;
  let mpcEmptySlotCount = 0;
  let mpcPopulatedSlotCount = 0;
  
  for (let i = 0; i < 8; i++) {
    const slotOffset = RING_BUFFER_START + (i * 16);
    
    // Check for FreshAuto marker (5A 5A 95 00)
    const isFreshAutoMarker = (
      rfhubData[slotOffset] === 0x5A &&
      rfhubData[slotOffset + 1] === 0x5A &&
      rfhubData[slotOffset + 2] === 0x95 &&
      rfhubData[slotOffset + 3] === 0x00
    );
    
    if (isFreshAutoMarker) {
      freshAutoMarkerCount++;
    }
    
    // Check for MPC slot pattern
    // MPC slots are 8 bytes each, no markers
    // Empty MPC slots are typically all 0xFF or 0x00
    const slotData = rfhubData.slice(slotOffset, slotOffset + 8);
    const isAllFF = slotData.every(b => b === 0xFF);
    const isAllZero = slotData.every(b => b === 0x00);
    const hasVariedBytes = slotData.some((b, idx) => {
      if (idx === 0) return false;
      return b !== slotData[0];
    });
    
    if (isAllFF || isAllZero) {
      mpcEmptySlotCount++;
    } else if (hasVariedBytes) {
      mpcPopulatedSlotCount++;
    }
  }
  
  // Decision logic
  if (freshAutoMarkerCount >= 6) {
    // Strong FreshAuto signal: 6+ slots have the ring buffer marker
    return {
      type: 'freshAuto',
      confidence: 95,
      reason: `Found ${freshAutoMarkerCount}/8 FreshAuto ring buffer markers (5A 5A 95 00)`,
    };
  }
  
  if (freshAutoMarkerCount >= 3) {
    // Moderate FreshAuto signal
    return {
      type: 'freshAuto',
      confidence: 70,
      reason: `Found ${freshAutoMarkerCount}/8 FreshAuto ring buffer markers`,
    };
  }
  
  // Check for MPC pattern: mostly empty slots + some populated
  if (mpcEmptySlotCount >= 5 || (mpcPopulatedSlotCount > 0 && mpcEmptySlotCount >= 3)) {
    // MPC pattern detected
    return {
      type: 'mpc',
      confidence: 80,
      reason: `MPC pattern detected: ${mpcPopulatedSlotCount} populated slots, ${mpcEmptySlotCount} empty slots`,
    };
  }
  
  // Fallback: check for any ring buffer marker at all
  if (freshAutoMarkerCount > 0) {
    return {
      type: 'freshAuto',
      confidence: 50,
      reason: `Found ${freshAutoMarkerCount} FreshAuto markers (weak signal)`,
    };
  }
  
  // Default to MPC if no FreshAuto markers found
  return {
    type: 'mpc',
    confidence: 40,
    reason: 'No FreshAuto markers detected; assuming MPC format',
  };
}

/**
 * Get human-readable RFHUB type name
 * 
 * @param {string} type - 'freshAuto' | 'mpc' | 'unknown'
 * @returns {string}
 */
export function getRfhubTypeName(type) {
  const names = {
    freshAuto: 'FreshAuto (Gen1/Gen2)',
    mpc: 'MPC (Charger/Challenger)',
    unknown: 'Unknown',
  };
  return names[type] || 'Unknown';
}
