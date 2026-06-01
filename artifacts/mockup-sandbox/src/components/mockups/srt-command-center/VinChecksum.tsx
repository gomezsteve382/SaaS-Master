import React, { useState } from "react";
import { AppShell } from "./_shared/AppShell";
import {
  Cpu,
  CheckCircle2,
  AlertTriangle,
  ShieldAlert,
  Fingerprint,
  Database,
  ArrowRight,
  RefreshCw,
  Search,
  CheckSquare,
} from "lucide-react";

// Mock Data
const MODULES = [
  { id: "bcm", name: "Body Control Module (BCM)", vin: "2C3CDXL94MH500418", crc: "A8F1", status: "ok" },
  { id: "rfhub", name: "Radio Frequency Hub (RFHUB)", vin: "2C3CDXL94MH500418", crc: "3C9B", status: "ok" },
  { id: "pcm", name: "Powertrain Control Module (PCM)", vin: "2C3CDXL94MH500418", crc: "77D2", status: "ok" },
  { id: "ipc", name: "Instrument Panel Cluster (IPC)", vin: "1C4RJFDJ7DC513874", crc: "FF01", status: "mismatch" },
];

export function VinChecksum() {
  const [targetVin, setTargetVin] = useState("2C3CDXL94MH500418");
  const [selectedModules, setSelectedModules] = useState<string[]>(["ipc"]);
  const [isWriting, setIsWriting] = useState(false);

  const toggleModule = (id: string) => {
    setSelectedModules((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]
    );
  };

  const allSelected = selectedModules.length === MODULES.length;
  const selectAll = () => setSelectedModules(allSelected ? [] : MODULES.map((m) => m.id));

  // Basic mock validation
  const isValidLen = targetVin.length === 17;
  const isDodge = targetVin.startsWith("2C3");
  const modelYear = isValidLen ? "2021 (M)" : "Unknown";

  const cardStyle = { backgroundColor: "var(--srt-panel)", borderColor: "var(--srt-line)" };

  return (
    <AppShell active="vin">
      <div className="h-full flex flex-col overflow-y-auto p-6" style={{ backgroundColor: "var(--srt-base)", color: "var(--srt-ink)" }}>
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-display uppercase tracking-wider" style={{ color: "var(--srt-ink)" }}>
              VIN &amp; Checksum
            </h1>
            <p className="text-sm mt-1" style={{ color: "var(--srt-muted)" }}>
              Read / write VIN across modules and verify CRC integrity.
            </p>
          </div>
          <div
            className="flex items-center gap-2 px-3 py-1.5 rounded-md border font-mono text-xs font-bold uppercase tracking-wide"
            style={{ ...cardStyle, color: "var(--srt-ink)" }}
          >
            <ShieldAlert className="w-3.5 h-3.5" style={{ color: "var(--srt-red)" }} />
            SEC-16: Unlocked
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          {/* Left Column: Module State */}
          <div className="xl:col-span-2 flex flex-col gap-6">
            {/* Module State Map */}
            <div className="rounded-md border shadow-sm overflow-hidden" style={cardStyle}>
              <div className="flex items-center gap-2 px-4 py-3 border-b" style={{ borderColor: "var(--srt-line)" }}>
                <Database className="w-5 h-5" style={{ color: "var(--srt-muted)" }} />
                <h2 className="font-display text-base uppercase tracking-wide" style={{ color: "var(--srt-ink)" }}>
                  Module State Map
                </h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead
                    className="text-[10px] uppercase font-bold tracking-wider border-b"
                    style={{ color: "var(--srt-muted)", borderColor: "var(--srt-line)", backgroundColor: "rgba(0,0,0,0.02)" }}
                  >
                    <tr>
                      <th className="px-4 py-3 w-[44px] text-center">
                        <input
                          type="checkbox"
                          checked={allSelected}
                          onChange={selectAll}
                          className="accent-[var(--srt-red)] w-3.5 h-3.5 align-middle"
                        />
                      </th>
                      <th className="px-4 py-3">Module</th>
                      <th className="px-4 py-3">Stored VIN</th>
                      <th className="px-4 py-3">CRC16</th>
                      <th className="px-4 py-3">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y" style={{ borderColor: "var(--srt-line)" }}>
                    {MODULES.map((mod) => {
                      const bad = mod.status === "mismatch";
                      return (
                        <tr key={mod.id} className="hover:bg-black/[0.02] transition-colors">
                          <td className="px-4 py-3 text-center">
                            <input
                              type="checkbox"
                              checked={selectedModules.includes(mod.id)}
                              onChange={() => toggleModule(mod.id)}
                              className="accent-[var(--srt-red)] w-3.5 h-3.5 align-middle"
                            />
                          </td>
                          <td className="px-4 py-3">
                            <span className="flex items-center gap-2 font-medium" style={{ color: "var(--srt-ink)" }}>
                              <Cpu className="w-4 h-4" style={{ color: "var(--srt-muted)" }} />
                              {mod.name}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className="font-mono text-xs px-2 py-1 rounded border"
                              style={{
                                backgroundColor: bad ? "#FEE2E2" : "#F0FDF4",
                                color: bad ? "var(--srt-bad)" : "var(--srt-good)",
                                borderColor: bad ? "#FCA5A5" : "#BBF7D0",
                              }}
                            >
                              {mod.vin}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className="font-mono text-xs px-1.5 py-0.5 rounded border"
                              style={{ backgroundColor: "rgba(0,0,0,0.03)", color: "var(--srt-muted)", borderColor: "var(--srt-line)" }}
                            >
                              0x{mod.crc}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            {bad ? (
                              <span
                                className="inline-flex items-center gap-1 font-mono text-[10px] font-bold uppercase px-2 py-0.5 rounded border"
                                style={{ backgroundColor: "#FEF2F2", color: "var(--srt-bad)", borderColor: "#FCA5A5" }}
                              >
                                <AlertTriangle className="w-3 h-3" /> Mismatch
                              </span>
                            ) : (
                              <span
                                className="inline-flex items-center gap-1 font-mono text-[10px] font-bold uppercase px-2 py-0.5 rounded border"
                                style={{ backgroundColor: "#F0FDF4", color: "var(--srt-good)", borderColor: "#BBF7D0" }}
                              >
                                <CheckCircle2 className="w-3 h-3" /> Valid
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Action Bar */}
            <div className="rounded-md border shadow-sm p-4 flex items-center justify-between gap-4 flex-wrap" style={cardStyle}>
              <div className="flex items-center gap-2 text-sm">
                <ShieldAlert className="w-4 h-4" style={{ color: "var(--srt-warn)" }} />
                <span className="font-mono text-xs" style={{ color: "var(--srt-muted)" }}>
                  Safety lock: cannot write VIN to a VIRGIN module.
                </span>
              </div>
              <div className="flex items-center gap-3">
                <button
                  className="flex items-center gap-2 font-display tracking-wide uppercase text-sm px-4 py-2 rounded-md border transition-colors hover:bg-black/[0.03]"
                  style={{ borderColor: "var(--srt-line)", color: "var(--srt-ink)" }}
                >
                  <CheckSquare className="w-4 h-4" />
                  Verify Checksums
                </button>
                <button
                  className="flex items-center gap-2 font-display tracking-wide uppercase text-sm px-4 py-2 rounded-md text-white transition-opacity disabled:opacity-50"
                  style={{ backgroundColor: "var(--srt-red)" }}
                  disabled={selectedModules.length === 0 || !isValidLen || isWriting}
                  onClick={() => {
                    setIsWriting(true);
                    setTimeout(() => setIsWriting(false), 2000);
                  }}
                >
                  {isWriting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Fingerprint className="w-4 h-4" />}
                  Write VIN to Selected
                </button>
              </div>
            </div>
          </div>

          {/* Right Column: Settings & Analysis */}
          <div className="flex flex-col gap-6">
            {/* Target VIN Panel */}
            <div className="rounded-md border shadow-sm overflow-hidden" style={cardStyle}>
              <div className="flex items-center gap-2 px-4 py-3 border-b" style={{ borderColor: "var(--srt-line)" }}>
                <Search className="w-5 h-5" style={{ color: "var(--srt-muted)" }} />
                <h2 className="font-display text-base uppercase tracking-wide" style={{ color: "var(--srt-ink)" }}>
                  Target VIN Definition
                </h2>
              </div>
              <div className="p-4 flex flex-col gap-4">
                <div>
                  <label className="text-[10px] font-bold uppercase tracking-wider mb-1.5 block" style={{ color: "var(--srt-muted)" }}>
                    New Vehicle Identification Number
                  </label>
                  <input
                    value={targetVin}
                    onChange={(e) => setTargetVin(e.target.value.toUpperCase())}
                    maxLength={17}
                    placeholder="ENTER 17-CHAR VIN"
                    className="w-full font-mono text-lg tracking-widest uppercase px-3 py-2 rounded-md border focus:outline-none focus:ring-1"
                    style={{ borderColor: "var(--srt-line)", color: "var(--srt-ink)", ["--tw-ring-color" as any]: "var(--srt-red)" }}
                  />
                </div>

                <div className="rounded-md border p-3 flex flex-col gap-2" style={{ backgroundColor: "rgba(0,0,0,0.02)", borderColor: "var(--srt-line)" }}>
                  {[
                    { k: "Length", v: `${targetVin.length} / 17`, ok: isValidLen },
                    { k: "WMI Decode", v: isDodge ? "Dodge NA" : "Unknown" },
                    { k: "Model Year", v: modelYear },
                  ].map((row, i) => (
                    <div key={row.k} className={`flex justify-between items-center text-sm font-mono ${i < 2 ? "border-b pb-2" : ""}`} style={{ borderColor: "var(--srt-line)" }}>
                      <span style={{ color: "var(--srt-muted)" }}>{row.k}</span>
                      <span className="font-bold" style={{ color: row.ok === undefined ? "var(--srt-ink)" : row.ok ? "var(--srt-good)" : "var(--srt-bad)" }}>
                        {row.v}
                      </span>
                    </div>
                  ))}
                  <div className="flex justify-between items-center text-sm font-mono pt-1">
                    <span style={{ color: "var(--srt-muted)" }}>Check Digit</span>
                    <span
                      className="inline-flex items-center font-mono text-[10px] font-bold uppercase px-2 py-0.5 rounded border"
                      style={{ backgroundColor: "#F0FDF4", color: "var(--srt-good)", borderColor: "#BBF7D0" }}
                    >
                      Pass
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Checksum Pre-flight */}
            <div className="rounded-md border shadow-sm overflow-hidden" style={cardStyle}>
              <div className="flex items-center gap-2 px-4 py-3 border-b" style={{ borderColor: "var(--srt-line)" }}>
                <RefreshCw className="w-5 h-5" style={{ color: "var(--srt-muted)" }} />
                <h2 className="font-display text-base uppercase tracking-wide" style={{ color: "var(--srt-ink)" }}>
                  Checksum Pre-flight
                </h2>
              </div>
              <div className="p-4 flex flex-col gap-4">
                <p className="text-xs font-mono leading-relaxed" style={{ color: "var(--srt-muted)" }}>
                  Previews CRC16/CRC32 generation for selected modules based on target VIN offset.
                </p>

                {selectedModules.includes("ipc") && (
                  <div className="rounded-md border p-3 relative overflow-hidden" style={{ backgroundColor: "#FEF2F2", borderColor: "#FCA5A5" }}>
                    <div className="absolute top-0 right-0 bottom-0 w-1" style={{ backgroundColor: "var(--srt-red)" }} />
                    <h4 className="font-mono text-xs font-bold uppercase mb-2" style={{ color: "var(--srt-red-deep)" }}>
                      IPC (Mismatched)
                    </h4>
                    <div className="flex items-center justify-between mt-2">
                      <div className="flex flex-col">
                        <span className="text-[10px] font-mono" style={{ color: "var(--srt-muted)" }}>CURRENT CRC</span>
                        <span className="font-mono text-sm line-through" style={{ color: "var(--srt-ink)" }}>0xFF01</span>
                      </div>
                      <ArrowRight className="w-4 h-4" style={{ color: "var(--srt-red)" }} />
                      <div className="flex flex-col items-end">
                        <span className="text-[10px] font-mono" style={{ color: "var(--srt-muted)" }}>TARGET CRC</span>
                        <span className="font-mono text-sm font-bold" style={{ color: "var(--srt-red-deep)" }}>0x2A4B</span>
                      </div>
                    </div>
                    <div className="mt-3 text-right">
                      <span className="inline-flex items-center font-mono text-[10px] font-bold uppercase px-2 py-0.5 rounded border" style={{ backgroundColor: "var(--srt-panel)", color: "var(--srt-muted)", borderColor: "var(--srt-line)" }}>
                        Will-recompute
                      </span>
                    </div>
                  </div>
                )}

                {selectedModules.includes("bcm") && (
                  <div className="rounded-md border p-3 relative overflow-hidden" style={{ backgroundColor: "rgba(0,0,0,0.02)", borderColor: "var(--srt-line)" }}>
                    <div className="absolute top-0 right-0 bottom-0 w-1" style={{ backgroundColor: "var(--srt-good)" }} />
                    <h4 className="font-mono text-xs font-bold uppercase mb-2" style={{ color: "var(--srt-ink)" }}>BCM</h4>
                    <div className="flex items-center justify-between mt-2">
                      <div className="flex flex-col">
                        <span className="text-[10px] font-mono" style={{ color: "var(--srt-muted)" }}>CURRENT CRC</span>
                        <span className="font-mono text-sm" style={{ color: "var(--srt-ink)" }}>0xA8F1</span>
                      </div>
                      <ArrowRight className="w-4 h-4" style={{ color: "var(--srt-muted)" }} />
                      <div className="flex flex-col items-end">
                        <span className="text-[10px] font-mono" style={{ color: "var(--srt-muted)" }}>TARGET CRC</span>
                        <span className="font-mono text-sm font-bold" style={{ color: "var(--srt-good)" }}>0xA8F1</span>
                      </div>
                    </div>
                    <div className="mt-3 text-right">
                      <span className="inline-flex items-center font-mono text-[10px] font-bold uppercase px-2 py-0.5 rounded border" style={{ backgroundColor: "var(--srt-panel)", color: "var(--srt-muted)", borderColor: "var(--srt-line)" }}>
                        Verified
                      </span>
                    </div>
                  </div>
                )}

                {selectedModules.length === 0 && (
                  <div className="text-center py-6 text-sm font-mono" style={{ color: "var(--srt-muted)" }}>
                    No modules selected for preview.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
