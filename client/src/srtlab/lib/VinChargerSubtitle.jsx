import React from 'react';
import { decodeChargerVin } from './vin.js';
import { C } from './constants.js';

// Shared one-line "Charger SRT trim · HP · year/family" subtitle. Renders
// nothing for non-Charger VINs so non-Charger workflows are visually
// untouched. Used by Module Sync, BCM, RFHUB, IMMO/VIN, and Backups
// (Task #488 — VIN integration across the workspace).
export default function VinChargerSubtitle({ vin, dataTestId, style }) {
  const r = decodeChargerVin(vin);
  if (!r) return null;
  return (
    <div data-testid={dataTestId || 'vin-charger-subtitle'} style={{
      fontSize: 11, color: C.ts, fontFamily: "'Nunito'",
      marginTop: 4, lineHeight: 1.4, ...(style || {}),
    }}>
      <span style={{ color: C.a3, fontWeight: 800 }}>{r.trim}</span>
      <span style={{ color: C.tm }}> · </span>
      <span style={{ color: C.tx, fontWeight: 700 }}>{r.hp}</span>
      <span style={{ color: C.tm }}> · </span>
      <span style={{ color: C.ts }}>{r.year} {r.family}</span>
    </div>
  );
}
