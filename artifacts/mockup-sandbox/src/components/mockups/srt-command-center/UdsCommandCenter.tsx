import React, { useState } from "react";
import { AppShell } from "./_shared/AppShell";
import { Send, Zap, ChevronDown, Activity, Settings2, ShieldAlert } from "lucide-react";

const SERVICES = [
  { id: "0x10", name: "DiagnosticSessionControl" },
  { id: "0x11", name: "ECUReset" },
  { id: "0x22", name: "ReadDataByIdentifier" },
  { id: "0x27", name: "SecurityAccess" },
  { id: "0x2E", name: "WriteDataByIdentifier" },
  { id: "0x31", name: "RoutineControl" },
  { id: "0x34", name: "RequestDownload" },
];

const TRANSCRIPT = [
  { time: "14:02:01.104", dir: "->", hex: "02 10 03 00 00 00 00 00", desc: "DiagnosticSessionControl (Extended)" },
  { time: "14:02:01.120", dir: "<-", hex: "06 50 03 00 32 01 F4 00", desc: "PositiveResponse", type: "good" },
  { time: "14:02:02.051", dir: "->", hex: "02 27 01 00 00 00 00 00", desc: "SecurityAccess (RequestSeed)" },
  { time: "14:02:02.065", dir: "<-", hex: "06 67 01 A3 F4 9B 22 00", desc: "Seed: A3 F4 9B 22", type: "good" },
  { time: "14:02:02.080", dir: "->", hex: "06 27 02 4F 11 8A 05 00", desc: "SecurityAccess (SendKey)" },
  { time: "14:02:02.102", dir: "<-", hex: "03 7F 27 35 00 00 00 00", desc: "NRC 0x35 invalidKey", type: "bad" },
  { time: "14:02:05.410", dir: "->", hex: "06 27 02 4F 11 8A 09 00", desc: "SecurityAccess (SendKey)" },
  { time: "14:02:05.425", dir: "<-", hex: "02 67 02 00 00 00 00 00", desc: "PositiveResponse", type: "good" },
  { time: "14:02:06.100", dir: "->", hex: "03 22 F1 90 00 00 00 00", desc: "ReadDataByIdentifier (VIN)" },
  { time: "14:02:06.115", dir: "<-", hex: "10 14 62 F1 90 31 43 34", desc: "FirstFrame (20 bytes)", type: "info" },
  { time: "14:02:06.118", dir: "->", hex: "30 00 00 00 00 00 00 00", desc: "FlowControl (Continue)" },
  { time: "14:02:06.125", dir: "<-", hex: "21 52 4A 46 44 4A 37 44", desc: "ConsecutiveFrame 1", type: "info" },
  { time: "14:02:06.130", dir: "<-", hex: "22 43 35 31 33 38 37 34", desc: "ConsecutiveFrame 2", type: "info" },
  { time: "14:02:06.132", dir: "<-", hex: "23 00 00 00 00 00 00 00", desc: "ConsecutiveFrame 3 (End)", type: "good", data: "1C4RJFDJ7DC513874" },
];

export function UdsCommandCenter() {
  const [activeService, setActiveService] = useState(SERVICES[3]);

  return (
    <AppShell active="uds">
      <div 
        className="h-full flex gap-6 p-6 overflow-hidden"
        style={{ backgroundColor: "var(--srt-base)", color: "var(--srt-ink)" }}
      >
        {/* LEFT COLUMN: BUILDER */}
        <div className="w-[420px] flex flex-col gap-4 flex-shrink-0">
          <div className="flex items-center justify-between pb-2 border-b" style={{ borderColor: "var(--srt-line)" }}>
            <h2 className="font-display text-lg tracking-wider">FRAME BUILDER</h2>
            <div className="flex items-center gap-2 text-xs font-mono px-2 py-1 rounded" style={{ backgroundColor: "var(--srt-panel)", border: "1px solid var(--srt-line)" }}>
              <Settings2 size={12} style={{ color: "var(--srt-muted)" }} />
              <span className="font-bold">0x7E0</span> ECM
            </div>
          </div>

          <div className="flex flex-col gap-4 flex-1">
            {/* Service Picker */}
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold uppercase tracking-wider" style={{ color: "var(--srt-muted)" }}>Service</label>
              <div className="relative">
                <select 
                  className="w-full appearance-none px-3 py-2 text-sm font-mono rounded cursor-pointer outline-none focus:ring-2 focus:ring-opacity-50"
                  style={{ 
                    backgroundColor: "var(--srt-panel)", 
                    border: "1px solid var(--srt-line)",
                    outlineColor: "var(--srt-red)"
                  }}
                  value={activeService.id}
                  onChange={(e) => setActiveService(SERVICES.find(s => s.id === e.target.value) || SERVICES[0])}
                >
                  {SERVICES.map(s => (
                    <option key={s.id} value={s.id}>{s.id} {s.name}</option>
                  ))}
                </select>
                <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: "var(--srt-muted)" }} />
              </div>
            </div>

            {/* Context Fields */}
            <div className="flex flex-col gap-3 p-4 rounded border" style={{ backgroundColor: "var(--srt-panel)", borderColor: "var(--srt-line)" }}>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-bold uppercase" style={{ color: "var(--srt-muted)" }}>Sub-function</label>
                <input 
                  type="text" 
                  defaultValue="01" 
                  className="px-2 py-1.5 font-mono text-sm border rounded focus:outline-none"
                  style={{ borderColor: "var(--srt-line)" }}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-bold uppercase" style={{ color: "var(--srt-muted)" }}>Security Level</label>
                <div className="flex gap-2">
                  <span className="px-2 py-1 text-xs font-mono bg-black/5 rounded border" style={{ borderColor: "var(--srt-line)" }}>01 RequestSeed</span>
                  <span className="px-2 py-1 text-xs font-mono opacity-50 border border-transparent">02 SendKey</span>
                </div>
              </div>
              <div className="flex flex-col gap-1.5 mt-2">
                <label className="text-xs font-bold uppercase" style={{ color: "var(--srt-muted)" }}>Payload Bytes</label>
                <input 
                  type="text" 
                  placeholder="e.g. A3 F4 9B 22" 
                  className="px-2 py-1.5 font-mono text-sm border rounded focus:outline-none bg-black/5"
                  style={{ borderColor: "var(--srt-line)", color: "var(--srt-muted)" }}
                  disabled
                />
              </div>
            </div>

            {/* Built Frame Preview */}
            <div className="mt-auto">
              <label className="text-xs font-bold uppercase tracking-wider mb-2 block" style={{ color: "var(--srt-muted)" }}>Built Frame</label>
              <div className="p-3 rounded border font-mono text-sm shadow-sm" style={{ backgroundColor: "var(--srt-ink)", color: "#fff", borderColor: "var(--srt-line)" }}>
                <div className="flex justify-between items-center mb-2 pb-2 border-b border-white/10 text-xs">
                  <span className="text-white/50">ISO-TP: Single Frame</span>
                  <span className="text-white/50">Length: 0x02</span>
                </div>
                <div className="flex gap-2 text-lg">
                  <span className="text-white/40">02</span>
                  <span style={{ color: "var(--srt-red)" }}>27</span>
                  <span className="text-white">01</span>
                  <span className="text-white/20">00 00 00 00 00</span>
                </div>
              </div>
            </div>

            <button 
              className="w-full flex items-center justify-center gap-2 py-3 rounded text-white font-bold tracking-wide transition-opacity hover:opacity-90 active:scale-[0.98]"
              style={{ backgroundColor: "var(--srt-red)" }}
            >
              <Send size={16} />
              SEND REQUEST
            </button>
          </div>
        </div>

        {/* RIGHT COLUMN: TRANSCRIPT */}
        <div className="flex-1 flex flex-col min-w-0 border-l pl-6" style={{ borderColor: "var(--srt-line)" }}>
          <div className="flex items-center justify-between pb-2 border-b mb-4" style={{ borderColor: "var(--srt-line)" }}>
            <h2 className="font-display text-lg tracking-wider flex items-center gap-2">
              <Activity size={18} style={{ color: "var(--srt-red)" }} />
              SESSION TRANSCRIPT
            </h2>
            <div className="text-xs font-mono flex gap-4" style={{ color: "var(--srt-muted)" }}>
              <span>BAUD: 500kbps</span>
              <span>PROTOCOL: CAN11</span>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto pr-4 custom-scrollbar flex flex-col gap-1.5 text-sm font-mono pb-8">
            {TRANSCRIPT.map((entry, i) => {
              const isSent = entry.dir === "->";
              const isBad = entry.type === "bad";
              const isGood = entry.type === "good";
              
              let descColor = "var(--srt-muted)";
              if (isBad) descColor = "var(--srt-red)";
              else if (isGood) descColor = "var(--srt-good, #16a34a)";

              return (
                <div 
                  key={i} 
                  className={`flex gap-4 p-1.5 rounded hover:bg-black/5 transition-colors ${isBad ? 'bg-red-500/5' : ''}`}
                >
                  <div className="w-24 flex-shrink-0 text-right opacity-50">{entry.time}</div>
                  <div className={`w-6 flex-shrink-0 font-bold ${isSent ? '' : 'opacity-60'}`} style={{ color: isSent ? "var(--srt-ink)" : "var(--srt-muted)" }}>
                    {entry.dir}
                  </div>
                  <div className="w-[215px] flex-shrink-0 tracking-wide whitespace-nowrap" style={{ color: isSent ? "var(--srt-ink)" : "var(--srt-muted)" }}>
                    {entry.hex}
                  </div>
                  <div className="flex-1 flex flex-col truncate">
                    <span className="truncate flex items-center gap-2" style={{ color: descColor }}>
                      {isBad && <ShieldAlert size={14} />}
                      {entry.desc}
                    </span>
                    {entry.data && (
                      <span className="text-xs font-bold mt-0.5" style={{ color: "var(--srt-ink)" }}>
                        Data: {entry.data}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
            <div className="mt-4 pt-4 border-t opacity-50 flex gap-4 text-xs" style={{ borderColor: "var(--srt-line)" }}>
              <div className="w-24 text-right">--:--:--.---</div>
              <div className="w-6"></div>
              <div className="flex-1 italic">Waiting for input...</div>
            </div>
          </div>
        </div>
      </div>
      <style dangerouslySetInnerHTML={{__html: `
        .custom-scrollbar::-webkit-scrollbar {
          width: 8px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background-color: var(--srt-line);
          border-radius: 4px;
        }
      `}} />
    </AppShell>
  );
}
