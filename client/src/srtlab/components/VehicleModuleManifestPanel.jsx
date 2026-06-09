/**
 * VehicleModuleManifestPanel.jsx
 *
 * Displays the "Vehicle Module Manifest" derived from TIPM CGW Config + BCM
 * BODY_PN_CONFIG DID responses. Shows which modules are equipped (Set) vs
 * not equipped (Not Set) vs unknown (no data).
 *
 * Props:
 *   manifest      — result of buildModuleManifest() from bcmModuleManifest.js
 *   onReadAll     — callback to trigger reading all required DIDs from the bridge
 *   isReading     — boolean, true while DIDs are being read
 *   onSaveScan    — async callback(payload) to save scan to DB
 *   isSaving      — boolean, true while saving
 *   savedScanId   — number|null, set after successful save
 *   scanHistory   — array of past scans from DB
 *   onDeleteScan  — async callback(id) to delete a scan
 *   adapterUrl    — string, current bridge URL
 */

import React, { useMemo, useState } from 'react';
import { buildModuleManifest, groupManifestByCategory, MANIFEST_REQUIRED_DIDS } from '../lib/bcmModuleManifest.js';

const C = {
  bg:   '#F4F1EC',
  bk:   '#1A1A1A',
  a1:   '#FF6D00',
  a2:   '#00BFA5',
  a3:   '#2979FF',
  a4:   '#AA00FF',
  gray: '#888',
  card: '#FFFFFF',
  border: '#E0DDD6',
};

const CATEGORY_LABELS = {
  powertrain:   'Powertrain',
  body:         'Body / Cabin',
  safety:       'Safety / Restraints',
  comfort:      'Comfort / Convenience',
  infotainment: 'Infotainment',
  security:     'Security / Immobilizer',
  performance:  'Performance',
  other:        'Other',
};

const CATEGORY_ICONS = {
  powertrain:   '⚙️',
  body:         '🚗',
  safety:       '🛡️',
  comfort:      '❄️',
  infotainment: '📻',
  security:     '🔐',
  performance:  '🏁',
  other:        '📦',
};

function StatusBadge({ present, confidence }) {
  if (confidence === 'no_data') {
    return (
      <span style={{
        fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
        color: C.gray, background: '#F0EDE8', borderRadius: 4,
        padding: '2px 7px',
      }}>NO DATA</span>
    );
  }
  if (confidence === 'out_of_range') {
    return (
      <span style={{
        fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
        color: '#B26A00', background: '#FFF3E0', borderRadius: 4,
        padding: '2px 7px',
      }}>OUT OF RANGE</span>
    );
  }
  if (present === true) {
    return (
      <span style={{
        fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
        color: '#1B5E20', background: '#E8F5E9', borderRadius: 4,
        padding: '2px 7px',
      }}>✓ EQUIPPED</span>
    );
  }
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
      color: '#B71C1C', background: '#FFEBEE', borderRadius: 4,
      padding: '2px 7px',
    }}>✗ NOT EQUIPPED</span>
  );
}

function ModuleRow({ mod }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '6px 12px',
      borderBottom: `1px solid ${C.border}`,
      background: mod.present === true ? '#F9FFF9' : mod.present === false ? '#FFFAFA' : '#FAFAFA',
      transition: 'background 0.15s',
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: C.bk, fontFamily: 'monospace' }}>
          {mod.id}
        </span>
        <span style={{ fontSize: 11, color: C.gray }}>
          {mod.label.replace(mod.id + ' — ', '').replace(mod.id + ' — ', '')}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StatusBadge present={mod.present} confidence={mod.confidence} />
        <span style={{ fontSize: 10, color: '#BBB', fontFamily: 'monospace' }}>
          {mod.source}
        </span>
      </div>
    </div>
  );
}

function CategorySection({ category, modules }) {
  const equipped = modules.filter(m => m.present === true).length;
  const total = modules.filter(m => m.confidence === 'confirmed').length;

  return (
    <div style={{
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      overflow: 'hidden',
      marginBottom: 12,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 12px',
        background: '#F7F4EF',
        borderBottom: `1px solid ${C.border}`,
      }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: C.bk }}>
          {CATEGORY_ICONS[category]} {CATEGORY_LABELS[category] || category}
        </span>
        {total > 0 && (
          <span style={{ fontSize: 11, color: C.gray }}>
            {equipped}/{total} equipped
          </span>
        )}
      </div>
      {modules.map(mod => (
        <ModuleRow key={mod.id} mod={mod} />
      ))}
    </div>
  );
}

function HistoryOverlay({ scans, onClose, onDelete }) {
  const [deletingId, setDeletingId] = useState(null);

  const handleDelete = async (id) => {
    setDeletingId(id);
    try { await onDelete(id); } finally { setDeletingId(null); }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div style={{
        background: C.card, borderRadius: 12, width: 640, maxWidth: '95vw',
        maxHeight: '80vh', overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 8px 40px rgba(0,0,0,0.25)',
      }} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 18px', borderBottom: `1px solid ${C.border}`,
        }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: C.bk }}>📋 Scan History</span>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: C.gray,
          }}>✕</button>
        </div>

        {/* List */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {(!scans || scans.length === 0) ? (
            <div style={{ textAlign: 'center', padding: '40px 20px', color: C.gray, fontSize: 13 }}>
              No saved scans yet. Run a MODULE MAP read and click "Save Scan" to record it.
            </div>
          ) : scans.map(scan => {
            const moduleList = Array.isArray(scan.moduleList) ? scan.moduleList : [];
            const equipped = moduleList.filter(m => m.equipped).length;
            const total = moduleList.length;
            const date = new Date(scan.createdAt).toLocaleString();
            return (
              <div key={scan.id} style={{
                padding: '12px 18px',
                borderBottom: `1px solid ${C.border}`,
                display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
                gap: 12,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    {scan.vin && (
                      <span style={{
                        fontSize: 13, fontFamily: 'monospace', fontWeight: 700,
                        color: C.bk, letterSpacing: 1,
                      }}>{scan.vin}</span>
                    )}
                    {scan.vehicleLabel && (
                      <span style={{ fontSize: 12, color: C.gray }}>{scan.vehicleLabel}</span>
                    )}
                    {!scan.vin && !scan.vehicleLabel && (
                      <span style={{ fontSize: 12, color: C.gray, fontStyle: 'italic' }}>No VIN / label</span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: C.gray, marginBottom: 2 }}>
                    {equipped}/{total} equipped · {date}
                  </div>
                  {scan.notes && (
                    <div style={{ fontSize: 11, color: '#555', fontStyle: 'italic' }}>{scan.notes}</div>
                  )}
                </div>
                <button
                  onClick={() => handleDelete(scan.id)}
                  disabled={deletingId === scan.id}
                  style={{
                    background: 'none', border: `1px solid #FFCDD2`,
                    borderRadius: 6, padding: '4px 10px',
                    fontSize: 11, color: '#B71C1C', cursor: 'pointer',
                    opacity: deletingId === scan.id ? 0.5 : 1,
                    flexShrink: 0,
                  }}
                >
                  {deletingId === scan.id ? '…' : '🗑 Delete'}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function VehicleModuleManifestPanel({
  manifest,
  onReadAll,
  isReading,
  onSaveScan,
  isSaving,
  savedScanId,
  scanHistory,
  onDeleteScan,
  adapterUrl,
}) {
  const grouped = useMemo(() => {
    if (!manifest) return null;
    return groupManifestByCategory(manifest);
  }, [manifest]);

  const [vehicleLabel, setVehicleLabel] = useState('');
  const [notes, setNotes] = useState('');
  const [showHistory, setShowHistory] = useState(false);

  const equippedCount = manifest?.modules?.filter(m => m.present === true).length ?? 0;
  const confirmedCount = manifest?.modules?.filter(m => m.confidence === 'confirmed').length ?? 0;
  const notEquippedCount = manifest?.modules?.filter(m => m.present === false && m.confidence === 'confirmed').length ?? 0;
  const missingDids = manifest?.didsMissing ?? MANIFEST_REQUIRED_DIDS.map(d => d.did);

  const handleSave = () => {
    if (!onSaveScan || !manifest) return;
    const moduleList = manifest.modules.map(m => ({
      module: m.id,
      equipped: m.present === true,
      source: m.source,
      did: m.did,
      label: m.label,
    }));
    onSaveScan({
      vin: manifest.vin || undefined,
      vehicleLabel: vehicleLabel.trim() || undefined,
      adapterUrl: adapterUrl || undefined,
      moduleList,
      rawResponses: manifest.rawResponses || undefined,
      equippedCount,
      notEquippedCount,
      notes: notes.trim() || undefined,
    });
  };

  return (
    <div style={{ fontFamily: 'Inter, sans-serif' }}>
      {/* History overlay */}
      {showHistory && (
        <HistoryOverlay
          scans={scanHistory}
          onClose={() => setShowHistory(false)}
          onDelete={onDeleteScan}
        />
      )}

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 16, flexWrap: 'wrap', gap: 8,
      }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.bk }}>
            🗺️ Vehicle Module Manifest
          </div>
          <div style={{ fontSize: 12, color: C.gray, marginTop: 2 }}>
            Derived from TIPM CGW Config + BCM BODY_PN_CONFIG
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* History button */}
          <button
            onClick={() => setShowHistory(true)}
            style={{
              background: 'none', color: C.a3, border: `1px solid ${C.a3}`,
              borderRadius: 6, padding: '6px 12px',
              fontSize: 12, fontWeight: 700, cursor: 'pointer',
            }}
          >
            📋 History {scanHistory?.length > 0 ? `(${scanHistory.length})` : ''}
          </button>
          {/* Read All DIDs */}
          {onReadAll && (
            <button
              onClick={onReadAll}
              disabled={isReading}
              style={{
                background: C.a1, color: '#FFF', border: 'none',
                borderRadius: 6, padding: '7px 16px',
                fontSize: 12, fontWeight: 700, cursor: isReading ? 'not-allowed' : 'pointer',
                opacity: isReading ? 0.6 : 1,
                transition: 'opacity 0.15s',
              }}
            >
              {isReading ? '⏳ Reading…' : '▶ Read All DIDs'}
            </button>
          )}
        </div>
      </div>

      {/* VIN banner */}
      {manifest?.vin && (
        <div style={{
          background: '#E8F5E9', border: '1px solid #A5D6A7',
          borderRadius: 8, padding: '8px 14px', marginBottom: 14,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#1B5E20' }}>VIN</span>
          <span style={{ fontSize: 14, fontFamily: 'monospace', fontWeight: 700, color: C.bk, letterSpacing: 1 }}>
            {manifest.vin}
          </span>
          <span style={{ fontSize: 11, color: C.gray }}>(from BCM DID 2023)</span>
        </div>
      )}

      {/* Summary bar */}
      {confirmedCount > 0 && (
        <div style={{
          background: '#FFF8F0', border: `1px solid ${C.border}`,
          borderRadius: 8, padding: '8px 14px', marginBottom: 14,
          display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 12, color: C.gray }}>
            <b style={{ color: '#1B5E20' }}>{equippedCount}</b> equipped
            &nbsp;·&nbsp;
            <b style={{ color: '#B71C1C' }}>{confirmedCount - equippedCount}</b> not equipped
            &nbsp;·&nbsp;
            <b style={{ color: C.gray }}>{manifest.modules.length - confirmedCount}</b> unknown
          </span>
          {manifest.didsCovered?.length > 0 && (
            <span style={{ fontSize: 11, color: C.gray, fontFamily: 'monospace' }}>
              DIDs read: {manifest.didsCovered.join(', ')}
            </span>
          )}
        </div>
      )}

      {/* Missing DIDs warning */}
      {missingDids.length > 0 && (
        <div style={{
          background: '#FFF8E1', border: '1px solid #FFE082',
          borderRadius: 8, padding: '8px 14px', marginBottom: 14,
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#B26A00', marginBottom: 4 }}>
            ⚠️ Missing DID responses — module status unknown for:
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {MANIFEST_REQUIRED_DIDS.filter(d => missingDids.includes(d.did)).map(d => (
              <span key={d.did} style={{
                fontSize: 11, fontFamily: 'monospace', fontWeight: 700,
                background: '#FFF3CD', border: '1px solid #FFE082',
                borderRadius: 4, padding: '2px 7px', color: '#7A4F00',
              }}>
                {d.request} — {d.label}
              </span>
            ))}
          </div>
          {onReadAll && (
            <div style={{ fontSize: 11, color: C.gray, marginTop: 6 }}>
              Click "Read All DIDs" to fetch all required responses from the connected module.
            </div>
          )}
        </div>
      )}

      {/* Module groups */}
      {grouped && Object.entries(grouped).map(([cat, mods]) => (
        <CategorySection key={cat} category={cat} modules={mods} />
      ))}

      {/* Save Scan card — shown when manifest has data */}
      {manifest && confirmedCount > 0 && onSaveScan && (
        <div style={{
          border: `1px solid ${C.border}`, borderRadius: 8,
          padding: '14px 16px', marginTop: 8,
          background: savedScanId ? '#E8F5E9' : '#FAFAFA',
        }}>
          {savedScanId ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 22 }}>✅</span>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#1B5E20' }}>
                  Scan saved to database (ID #{savedScanId})
                </div>
                <div style={{ fontSize: 11, color: C.gray, marginTop: 2 }}>
                  View it any time from the History button above.
                </div>
              </div>
            </div>
          ) : (
            <>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.bk, marginBottom: 10 }}>
                💾 Save This Scan to Database
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                <input
                  value={vehicleLabel}
                  onChange={e => setVehicleLabel(e.target.value)}
                  placeholder="Vehicle label (e.g. 2018 Charger SRT)"
                  style={{
                    flex: 1, minWidth: 180,
                    border: `1px solid ${C.border}`, borderRadius: 6,
                    padding: '6px 10px', fontSize: 12, background: '#FFF',
                    color: C.bk, outline: 'none',
                  }}
                />
                <input
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder="Notes (optional)"
                  style={{
                    flex: 1, minWidth: 180,
                    border: `1px solid ${C.border}`, borderRadius: 6,
                    padding: '6px 10px', fontSize: 12, background: '#FFF',
                    color: C.bk, outline: 'none',
                  }}
                />
              </div>
              <button
                onClick={handleSave}
                disabled={isSaving}
                style={{
                  background: C.a2, color: '#FFF', border: 'none',
                  borderRadius: 6, padding: '7px 20px',
                  fontSize: 12, fontWeight: 700,
                  cursor: isSaving ? 'not-allowed' : 'pointer',
                  opacity: isSaving ? 0.6 : 1,
                  transition: 'opacity 0.15s',
                }}
              >
                {isSaving ? '⏳ Saving…' : '💾 Save Scan'}
              </button>
            </>
          )}
        </div>
      )}

      {/* Empty state */}
      {!manifest && (
        <div style={{
          textAlign: 'center', padding: '40px 20px',
          color: C.gray, fontSize: 13,
        }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🗺️</div>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>No manifest data yet</div>
          <div>Connect to the vehicle and click "Read All DIDs" to build the module manifest.</div>
        </div>
      )}
    </div>
  );
}
