/* Workbench — the rebuilt back-side UI. Replaces the 50-tab CommandShell drawer
   with FOUR focused workbenches (LIVE / KEYS / BENCH / GPEC), each a thin sub-nav
   over the existing (working) tab components. One dark theme, one job-first entry.

   The tab internals are reused unchanged; only the navigation + grouping are new. */

import { useState, useEffect } from "react";
import { T, WB_ACCENT } from "../lib/theme.js";

// LIVE
import TopologyTab from "../tabs/TopologyTab.jsx";
import J2534UdsConsoleTab from "../tabs/J2534UdsConsoleTab.jsx";
import OBDTab from "../tabs/OBDTab";
// KEYS
import AklWizardTab from "../tabs/AklWizardTab.jsx";
import LiveKeyTab from "../tabs/LiveKeyTab.jsx";
import KeyTransferTab from "../tabs/KeyTransferTab.jsx";
import KeyManagerTab from "../tabs/KeyManagerTab";
import KeyProgTab from "../tabs/KeyProgTab";
// BENCH
import ModuleSync from "../tabs/ModuleSync";
import BcmTab from "../tabs/BcmTab";
import RfhubTab from "../tabs/RfhubTab";
import EcmTab from "../tabs/EcmTab";
import VinProgrammerTab from "../tabs/VinProgrammerTab.jsx";
import SecuritySyncTab from "../tabs/SecuritySyncTab.jsx";
import EcmFlasherTab from "../tabs/EcmFlasherTab.jsx";
// GPEC
import Gpec2aUnlockTab from "../tabs/Gpec2aUnlockTab.jsx";
import Gpec2aTab from "../tabs/Gpec2aTab.jsx";

const WORKBENCHES = [
  { key: 'live',  label: 'LIVE',  icon: '🗺️', tagline: 'UDS · OBD · Topology' },
  { key: 'keys',  label: 'KEYS',  icon: '🔑', tagline: 'AKL · Add · Transfer' },
  { key: 'bench', label: 'BENCH', icon: '🧰', tagline: 'Checksum · VIN · Security' },
  { key: 'gpec',  label: 'GPEC',  icon: '🔓', tagline: 'Firmware unlock' },
];

// Map a job-launcher target (legacy tab id) to a {workbench, sub} location.
export const ROUTE = {
  topology: { wb: 'live',  sub: 'topology' },
  obd:      { wb: 'live',  sub: 'obd' },
  'uds-console': { wb: 'live', sub: 'uds' },
  akl:      { wb: 'keys',  sub: 'akl' },
  livekey:  { wb: 'keys',  sub: 'addkey' },
  keyxfer:  { wb: 'keys',  sub: 'transfer' },
  bcm:      { wb: 'bench', sub: 'bcm' },
  rfhub:    { wb: 'bench', sub: 'rfhub' },
  ecm:      { wb: 'bench', sub: 'ecm' },
  modsync:  { wb: 'bench', sub: 'sync' },
  vinprog:  { wb: 'bench', sub: 'vincrc' },
  secsync:  { wb: 'bench', sub: 'security' },
  flasher:  { wb: 'bench', sub: 'flash' },
  gpecunlock: { wb: 'gpec', sub: 'unlock' },
};

export default function Workbench({ vehicle, files, selectedCflash, setSelectedCflash, onBack, initial }) {
  const [wb, setWb] = useState(initial?.wb || 'live');
  const [subByWb, setSubByWb] = useState(initial?.sub ? { [initial.wb || 'live']: initial.sub } : {});

  // re-route when the launcher hands us a new target
  useEffect(() => {
    if (initial?.wb) {
      setWb(initial.wb);
      if (initial.sub) setSubByWb(s => ({ ...s, [initial.wb]: initial.sub }));
    }
  }, [initial]);

  const SUBS = {
    live: [
      { key: 'topology', label: 'Topology',     render: () => <TopologyTab /> },
      { key: 'uds',      label: 'UDS Console',   render: () => <J2534UdsConsoleTab /> },
      { key: 'obd',      label: 'OBD · DTCs',    render: () => <OBDTab /> },
    ],
    keys: [
      { key: 'akl',      label: 'All-Keys-Lost', render: () => <AklWizardTab /> },
      { key: 'addkey',   label: 'Add a Key (live)', render: () => <LiveKeyTab /> },
      { key: 'transfer', label: 'Key Transfer',  render: () => <KeyTransferTab /> },
      { key: 'manager',  label: 'Key Manager',   render: () => <KeyManagerTab /> },
      { key: 'keyprog',  label: 'Key-Prog Bundle', render: () => <KeyProgTab /> },
    ],
    bench: [
      { key: 'sync',     label: 'Module Sync',   render: () => <ModuleSync vehicleId={vehicle?.id} files={files} /> },
      { key: 'bcm',      label: 'BCM',           render: () => <BcmTab vehicle={vehicle} /> },
      { key: 'rfhub',    label: 'RFHUB',         render: () => <RfhubTab vehicle={vehicle} /> },
      { key: 'ecm',      label: 'ECM',           render: () => <EcmTab vehicle={vehicle} /> },
      { key: 'vincrc',   label: 'VIN + Checksum', render: () => <VinProgrammerTab /> },
      { key: 'security', label: 'Security Sync', render: () => <SecuritySyncTab /> },
      { key: 'flash',    label: 'Flash',         render: () => <EcmFlasherTab selectedFile={selectedCflash} files={files} onSelectFile={setSelectedCflash} /> },
    ],
    gpec: [
      { key: 'unlock',   label: 'Unlock (file)', render: () => <Gpec2aUnlockTab /> },
      { key: 'inspect',  label: 'Inspect / Diff', render: () => <Gpec2aTab /> },
    ],
  };

  const subs = SUBS[wb];
  const activeSub = subByWb[wb] || subs[0].key;
  const active = subs.find(s => s.key === activeSub) || subs[0];
  const accent = WB_ACCENT[wb];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: T.bg, color: T.text, fontFamily: T.font }}>
      {/* top bar: back + vehicle + workbench rail */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "10px 16px", borderBottom: `1px solid ${T.border}`, background: T.panel }}>
        <button onClick={onBack} style={{ background: "none", border: `1px solid ${T.border}`, color: T.dim, borderRadius: 8, padding: "6px 12px", cursor: "pointer", fontFamily: T.font, fontWeight: 700, fontSize: 12 }}>← Vehicle</button>
        <div style={{ fontFamily: "'Righteous',sans-serif", fontSize: 15, letterSpacing: 1, color: T.text }}>{vehicle?.full || vehicle?.label || vehicle?.id || "SRT LAB"}</div>
        <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
          {WORKBENCHES.map(w => {
            const on = w.key === wb;
            const a = WB_ACCENT[w.key];
            return (
              <button key={w.key} onClick={() => setWb(w.key)} title={w.tagline} style={{
                display: "flex", alignItems: "center", gap: 7, padding: "7px 14px", borderRadius: 10, cursor: "pointer",
                fontFamily: T.font, fontWeight: 900, fontSize: 13, letterSpacing: 0.5,
                border: `1px solid ${on ? a : T.border}`, background: on ? a + "1A" : "transparent", color: on ? a : T.dim,
              }}>
                <span style={{ fontSize: 15 }}>{w.icon}</span>{w.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* sub-nav */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderBottom: `1px solid ${T.border}`, background: T.panel2, overflowX: "auto" }}>
        <span style={{ fontSize: 10, fontWeight: 800, color: accent, letterSpacing: 1.5, marginRight: 4, whiteSpace: "nowrap" }}>{wb.toUpperCase()}</span>
        {subs.map(s => {
          const on = s.key === activeSub;
          return (
            <button key={s.key} onClick={() => setSubByWb(m => ({ ...m, [wb]: s.key }))} style={{
              padding: "6px 13px", borderRadius: 8, cursor: "pointer", whiteSpace: "nowrap",
              fontFamily: T.font, fontWeight: 800, fontSize: 12,
              border: `1px solid ${on ? accent : T.border}`, background: on ? accent + "22" : T.card, color: on ? "#fff" : T.dim,
            }}>{s.label}</button>
          );
        })}
      </div>

      {/* content */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {active.render()}
      </div>
    </div>
  );
}
