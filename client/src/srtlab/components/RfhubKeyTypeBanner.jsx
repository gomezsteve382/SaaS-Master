/* ============================================================================
 * RfhubKeyTypeBanner.jsx — reusable banner component that displays the
 * required blank key type after RFHUB dump analysis.
 *
 * Usage:
 *   import { RfhubKeyTypeBanner } from '../components/RfhubKeyTypeBanner.jsx';
 *   <RfhubKeyTypeBanner bytes={rfhubUint8Array} />
 *
 * Or with a pre-computed result:
 *   import { detectRfhubKeyFamily } from '../lib/rfhubKeyTypeDetector.js';
 *   const result = useMemo(() => detectRfhubKeyFamily(bytes), [bytes]);
 *   <RfhubKeyTypeBanner result={result} />
 * ============================================================================ */

import React, { useMemo } from 'react';
import { detectRfhubKeyFamily, buildKeyTypeBanner } from '../lib/rfhubKeyTypeDetector.js';

/* ── Colour palette (matches the rest of SRT Lab) ─────────────────────── */
const LEVEL_STYLES = {
  success: { bg: '#F0FFF4', border: '#86EFAC', accent: '#16A34A', badge: '#DCFCE7', badgeText: '#15803D' },
  warning: { bg: '#F5F3FF', border: '#C4B5FD', accent: '#7C3AED', badge: '#EDE9FE', badgeText: '#6D28D9' },
  error:   { bg: '#FFF0F0', border: '#FCA5A5', accent: '#DC2626', badge: '#FEE2E2', badgeText: '#B91C1C' },
  info:    { bg: '#F0F9FF', border: '#93C5FD', accent: '#2563EB', badge: '#DBEAFE', badgeText: '#1D4ED8' },
  unknown: { bg: '#F9FAFB', border: '#D1D5DB', accent: '#6B7280', badge: '#F3F4F6', badgeText: '#374151' },
};

function UnknownFormatBanner({ banner }) {
  const s = LEVEL_STYLES.unknown;
  const reason = banner.parseError || banner.info?.notes || 'Format not recognized as a 4 KB Charger/Challenger RFHUB.';
  return (
    <div style={{
      borderRadius: 10,
      border: `2px dashed ${s.border}`,
      background: s.bg,
      padding: '10px 14px',
      marginBottom: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 15 }}>❓</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: s.accent, letterSpacing: 1.5 }}>KEY TYPE DETECTION UNAVAILABLE</div>
          <div style={{ fontSize: 11, color: '#374151', marginTop: 1 }}>Format not supported for automatic detection</div>
        </div>
      </div>
      <div style={{ fontSize: 10, color: '#6B7280', lineHeight: 1.6, padding: '7px 10px', background: 'rgba(0,0,0,0.04)', borderRadius: 6 }}>
        {reason}
      </div>
      <div style={{ marginTop: 8, padding: '7px 10px', borderRadius: 6, background: '#FEF9C3', border: '1px solid #FDE047', fontSize: 10, color: '#713F12', fontWeight: 600, lineHeight: 1.6 }}>
        💡 <b>Next step:</b> Identify the module type first. If this is a Gen1/Gen2 AA-50 RFHUB or XC2268,
        use the vehicle year/platform to determine the blank key type manually:
        2019 and earlier → <b>HITAG 2 (PCF7945/53)</b>;
        2020/21+ Redeye/Hellcat → <b>HITAG AES (PCF7939FA)</b>.
      </div>
    </div>
  );
}

function KeyTypeBannerInner({ banner }) {
  if (!banner || !banner.show) return null;

  if (banner.family === 'unknown') return <UnknownFormatBanner banner={banner} />;

  const { level, family, info, keyCount, hitag2Count, hitagAesCount } = banner;
  const s = LEVEL_STYLES[level] || LEVEL_STYLES.info;

  return (
    <div style={{
      borderRadius: 10,
      border: `2px solid ${s.border}`,
      background: s.bg,
      padding: '12px 14px',
      marginBottom: 14,
    }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 16 }}>{info.emoji}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: s.accent, letterSpacing: 1.5 }}>
            REQUIRED BLANK KEY TYPE
          </div>
          <div style={{ fontSize: 13, fontWeight: 900, color: '#111', marginTop: 1 }}>
            {info.blankLabel}
          </div>
        </div>
        <div style={{
          fontSize: 10, fontWeight: 800, padding: '3px 10px',
          background: s.badge, color: s.badgeText,
          borderRadius: 6, letterSpacing: 1,
        }}>
          {keyCount} KEY{keyCount !== 1 ? 'S' : ''} DETECTED
        </div>
      </div>

      {/* Detail grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px', marginBottom: 10 }}>
        <DetailRow label="Chip Type" value={info.chipType} />
        <DetailRow label="Part Number" value={info.partNumber} />
        <DetailRow label="Year Range" value={info.yearRange} />
        <DetailRow label="Programmer Workflow" value={info.progTool} />
        {family === 'mixed' && (
          <>
            <DetailRow label="HITAG 2 Keys (flag 0x01)" value={hitag2Count} />
            <DetailRow label="HITAG AES Keys (flag 0x03)" value={hitagAesCount} />
          </>
        )}
        {family === 'hitag2' && hitag2Count > 0 && (
          <DetailRow label="Family Flags" value={`All ${hitag2Count} key(s) = 0x01 (HITAG 2)`} />
        )}
        {family === 'hitag-aes' && hitagAesCount > 0 && (
          <DetailRow label="Family Flags" value={`All ${hitagAesCount} key(s) = 0x03 (HITAG AES)`} />
        )}
      </div>

      {/* Notes */}
      <div style={{
        fontSize: 10, color: '#4B5563', lineHeight: 1.6,
        padding: '8px 10px', background: 'rgba(0,0,0,0.04)',
        borderRadius: 6,
      }}>
        {info.notes}
      </div>

      {/* HITAG AES extra warning */}
      {family === 'hitag-aes' && (
        <div style={{
          marginTop: 8, padding: '7px 10px', borderRadius: 6,
          background: '#EDE9FE', border: '1px solid #C4B5FD',
          fontSize: 10, color: '#5B21B6', fontWeight: 700, lineHeight: 1.6,
        }}>
          ⚠️ <b>Do NOT use a standard HITAG 2 / id46 blank.</b> The module will reject it.
          You need a <b>PCF7939FA (HITAG AES)</b> blank — either an OEM 2021+ Redeye FOBIK
          or an Autel IKEY AES variant. Program using the HITAG AES workflow on your Autel IM608.
        </div>
      )}

      {/* No-keys guidance */}
      {family === 'no-keys' && (
        <div style={{
          marginTop: 8, padding: '7px 10px', borderRadius: 6,
          background: '#DBEAFE', border: '1px solid #93C5FD',
          fontSize: 10, color: '#1D4ED8', fontWeight: 600, lineHeight: 1.6,
        }}>
          💡 No keys are currently paired to this module. Use the vehicle year and platform
          to determine the correct blank type: 2019 and earlier → HITAG 2 (PCF7945/53);
          2020/21+ Redeye/Hellcat → HITAG AES (PCF7939FA).
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <span style={{ fontSize: 9, fontWeight: 800, color: '#9CA3AF', letterSpacing: 1, textTransform: 'uppercase' }}>{label}</span>
      <span style={{ fontSize: 11, color: '#111', fontWeight: 600, lineHeight: 1.4 }}>{value}</span>
    </div>
  );
}

/* ── Public component ───────────────────────────────────────────────────── */

/**
 * RfhubKeyTypeBanner
 *
 * Props:
 *   bytes  — Uint8Array of the loaded RFHUB dump (auto-detects on change)
 *   result — pre-computed detectRfhubKeyFamily() result (skips auto-detect)
 *   style  — optional container style overrides
 */
export function RfhubKeyTypeBanner({ bytes, result: resultProp, style }) {
  const result = useMemo(() => {
    if (resultProp !== undefined) return resultProp;
    if (!bytes) return null;
    return detectRfhubKeyFamily(bytes);
  }, [bytes, resultProp]);

  const banner = useMemo(() => buildKeyTypeBanner(result), [result]);

  if (!banner || !banner.show) return null;

  return (
    <div style={style}>
      <KeyTypeBannerInner banner={banner} />
    </div>
  );
}

export default RfhubKeyTypeBanner;
