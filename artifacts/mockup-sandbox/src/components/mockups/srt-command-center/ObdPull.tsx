import React, { useState, useEffect, useRef } from "react";
import { AppShell } from "./_shared/AppShell";
import { 
  Usb, 
  Zap, 
  Activity, 
  Database, 
  Download, 
  Play, 
  Settings2, 
  ServerCrash, 
  Terminal,
  Cpu,
  CheckCircle2,
  AlertTriangle,
  FileCode2,
  HardDrive
} from "lucide-react";

// Mock data for history
const PREVIOUS_DUMPS = [
  { id: 1, module: "BCM", address: "0x1328", size: "512 KB", timestamp: "10:42:15 AM", crc: "0x4F8A", status: "OK" },
  { id: 2, module: "RFHUB", address: "0x1A22", size: "256 KB", timestamp: "09:15:02 AM", crc: "0x11B2", status: "OK" },
  { id: 3, module: "PCM", address: "0x07E0", size: "4096 KB", timestamp: "Yesterday", crc: "0x99C1", status: "OK" },
  { id: 4, module: "TCU", address: "0x07E2", size: "2048 KB", timestamp: "Yesterday", crc: "0x--", status: "FAILED" },
];

export function ObdPull() {
  const [connected, setConnected] = useState(true);
  const [pulling, setPulling] = useState(false);
  const [progress, setProgress] = useState(0);
  const [log, setLog] = useState<string[]>([
    "[10:45:01] System ready.",
    "[10:45:01] Awaiting target module selection..."
  ]);
  
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [log]);

  const handlePull = () => {
    if (!connected) return;
    setPulling(true);
    setProgress(0);
    setLog(prev => [...prev, "[10:46:12] Init ISO 15765-4 CAN connection...", "[10:46:12] Requesting Security Access (0x27 0x01)...", "[10:46:12] Security Access GRANTED (0x27 0x02)"]);
    
    let current = 0;
    const interval = setInterval(() => {
      current += Math.random() * 15;
      if (current >= 100) {
        current = 100;
        clearInterval(interval);
        setPulling(false);
        setLog(prev => [...prev, `[10:46:18] Pull complete. Checksum: 0x8A2F.`, `[10:46:18] Dump saved to memory.`]);
      } else {
        const hexAddr = (0x100000 + Math.floor((current/100) * 0x7FFFF)).toString(16).toUpperCase();
        setLog(prev => [...prev, `[10:46:${12 + Math.floor(current/10)}] Read Block 0x${hexAddr} (0x1000 bytes) ... OK`]);
      }
      setProgress(current);
    }, 250);
  };

  return (
    <AppShell active="obd">
      <div className="flex-1 overflow-auto p-6" style={{ backgroundColor: "var(--srt-base)" }}>
        
        <div className="max-w-6xl mx-auto space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-display uppercase tracking-tight" style={{ color: "var(--srt-ink)" }}>
                OBD-II Bin Pull
              </h1>
              <p className="text-sm mt-1" style={{ color: "var(--srt-muted)" }}>
                Extract raw module firmware and NVRAM dumps over CAN/Web Serial.
              </p>
            </div>
            {/* Status indicators */}
            <div className="flex gap-4">
              <div className="flex items-center gap-2 px-3 py-1.5 rounded border" style={{ backgroundColor: "var(--srt-panel)", borderColor: "var(--srt-line)" }}>
                <Zap size={16} style={{ color: "var(--srt-warn)" }} />
                <span className="font-mono text-sm font-bold" style={{ color: "var(--srt-ink)" }}>13.8V</span>
              </div>
              <div className="flex items-center gap-2 px-3 py-1.5 rounded border" style={{ backgroundColor: "var(--srt-panel)", borderColor: "var(--srt-line)" }}>
                <Activity size={16} style={{ color: "var(--srt-good)" }} />
                <span className="font-mono text-sm font-bold" style={{ color: "var(--srt-ink)" }}>500kbps</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-12 gap-6">
            
            {/* LEFT COLUMN */}
            <div className="col-span-5 space-y-6">
              
              {/* CONNECTION PANEL */}
              <div className="rounded-md border p-5 space-y-5 shadow-sm" style={{ backgroundColor: "var(--srt-panel)", borderColor: "var(--srt-line)" }}>
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-display tracking-wide uppercase" style={{ color: "var(--srt-ink)" }}>Adapter Link</h2>
                  <div className="flex items-center gap-2">
                    <span className="relative flex h-2.5 w-2.5">
                      {connected && <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ backgroundColor: "var(--srt-good)" }}></span>}
                      <span className="relative inline-flex rounded-full h-2.5 w-2.5" style={{ backgroundColor: connected ? "var(--srt-good)" : "var(--srt-bad)" }}></span>
                    </span>
                    <span className="text-xs font-bold uppercase tracking-wider" style={{ color: connected ? "var(--srt-good)" : "var(--srt-bad)" }}>
                      {connected ? "Active" : "Offline"}
                    </span>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="flex justify-between items-center text-sm">
                    <span style={{ color: "var(--srt-muted)" }}>Interface</span>
                    <span className="font-mono font-medium" style={{ color: "var(--srt-ink)" }}>OBDLink EX (COM4)</span>
                  </div>
                  <div className="flex justify-between items-center text-sm">
                    <span style={{ color: "var(--srt-muted)" }}>Protocol</span>
                    <span className="font-mono font-medium" style={{ color: "var(--srt-ink)" }}>ISO 15765-4 CAN (11/500)</span>
                  </div>
                  <div className="flex justify-between items-center text-sm">
                    <span style={{ color: "var(--srt-muted)" }}>Bridge</span>
                    <span className="font-mono font-medium" style={{ color: "var(--srt-ink)" }}>Native Web Serial</span>
                  </div>
                </div>

                <div className="pt-2">
                  <button 
                    onClick={() => setConnected(!connected)}
                    className="w-full py-2.5 rounded text-sm font-bold uppercase tracking-wide transition-colors border"
                    style={{ 
                      backgroundColor: connected ? "transparent" : "var(--srt-ink)", 
                      color: connected ? "var(--srt-ink)" : "#fff",
                      borderColor: "var(--srt-line)"
                    }}
                  >
                    {connected ? "Disconnect" : "Connect"}
                  </button>
                  <p className="text-[11px] text-center mt-3" style={{ color: "var(--srt-muted)" }}>
                    SGW-gated VIN? <a href="#" className="underline hover:text-white" style={{ color: "var(--srt-ink)" }}>Use J2534 Bridge</a>
                  </p>
                </div>
              </div>

              {/* TARGET PANEL */}
              <div className="rounded-md border p-5 space-y-5 shadow-sm relative overflow-hidden" style={{ backgroundColor: "var(--srt-panel)", borderColor: "var(--srt-line)" }}>
                <h2 className="text-lg font-display tracking-wide uppercase flex items-center gap-2" style={{ color: "var(--srt-ink)" }}>
                  <Cpu size={18} />
                  Target & Pull
                </h2>

                <div className="space-y-4">
                  <div>
                    <label className="text-xs uppercase font-bold tracking-wider mb-1.5 block" style={{ color: "var(--srt-muted)" }}>Module ECU</label>
                    <select className="w-full bg-transparent border rounded px-3 py-2 text-sm font-mono focus:outline-none" style={{ borderColor: "var(--srt-line)", color: "var(--srt-ink)" }}>
                      <option>BCM (Body Control) [0x1328]</option>
                      <option>PCM (Powertrain) [0x07E0]</option>
                      <option>RFHUB (Radio Frequency) [0x1A22]</option>
                      <option>TCM (Transmission) [0x07E2]</option>
                    </select>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs uppercase font-bold tracking-wider mb-1.5 block" style={{ color: "var(--srt-muted)" }}>Address</label>
                      <input type="text" defaultValue="0x1328" className="w-full bg-transparent border rounded px-3 py-2 text-sm font-mono focus:outline-none" style={{ borderColor: "var(--srt-line)", color: "var(--srt-ink)" }} />
                    </div>
                    <div>
                      <label className="text-xs uppercase font-bold tracking-wider mb-1.5 block" style={{ color: "var(--srt-muted)" }}>Dump Size</label>
                      <select className="w-full bg-transparent border rounded px-3 py-2 text-sm font-mono focus:outline-none" style={{ borderColor: "var(--srt-line)", color: "var(--srt-ink)" }}>
                        <option>512 KB (D-Flash)</option>
                        <option>1024 KB (P-Flash)</option>
                        <option>4096 KB (Full)</option>
                        <option>Auto-Detect</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div className="pt-4">
                  <button 
                    onClick={handlePull}
                    disabled={pulling || !connected}
                    className="w-full py-4 rounded text-white text-base font-display tracking-widest uppercase transition-opacity flex items-center justify-center gap-2 disabled:opacity-50"
                    style={{ backgroundColor: "var(--srt-red)", backgroundImage: "linear-gradient(to bottom, var(--srt-red), var(--srt-red-deep))" }}
                  >
                    {pulling ? <ServerCrash size={20} className="animate-pulse" /> : <Play size={20} />}
                    {pulling ? "Pulling Dump..." : "Pull Bin Dump"}
                  </button>
                </div>
              </div>

            </div>

            {/* RIGHT COLUMN */}
            <div className="col-span-7 flex flex-col gap-6">
              
              {/* LIVE TERMINAL / PROGRESS */}
              <div className="rounded-md border shadow-sm flex flex-col overflow-hidden h-[300px]" style={{ backgroundColor: "var(--srt-panel)", borderColor: "var(--srt-line)" }}>
                <div className="px-4 py-3 border-b flex justify-between items-center" style={{ borderColor: "var(--srt-line)", backgroundColor: "rgba(0,0,0,0.02)" }}>
                  <h2 className="text-sm font-display tracking-wide uppercase flex items-center gap-2" style={{ color: "var(--srt-ink)" }}>
                    <Terminal size={16} />
                    Live Trace
                  </h2>
                  {pulling && (
                    <span className="font-mono text-xs font-bold" style={{ color: "var(--srt-red)" }}>
                      {((progress / 100) * 512).toFixed(1)} KB / 512.0 KB
                    </span>
                  )}
                </div>
                
                {pulling && (
                  <div className="w-full h-1 bg-gray-100">
                    <div className="h-full transition-all duration-200" style={{ width: `${progress}%`, backgroundColor: "var(--srt-red)" }}></div>
                  </div>
                )}

                <div className="flex-1 p-4 overflow-y-auto font-mono text-[11px] leading-relaxed space-y-1" style={{ color: "var(--srt-muted)" }}>
                  {log.map((line, i) => (
                    <div key={i}>{line}</div>
                  ))}
                  <div ref={logEndRef} />
                </div>
              </div>

              {/* DUMP HISTORY */}
              <div className="rounded-md border flex-1 shadow-sm flex flex-col" style={{ backgroundColor: "var(--srt-panel)", borderColor: "var(--srt-line)" }}>
                <div className="px-4 py-3 border-b" style={{ borderColor: "var(--srt-line)" }}>
                  <h2 className="text-sm font-display tracking-wide uppercase flex items-center gap-2" style={{ color: "var(--srt-ink)" }}>
                    <HardDrive size={16} />
                    Local Dump Repository
                  </h2>
                </div>
                
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead className="text-[10px] uppercase font-bold tracking-wider border-b" style={{ color: "var(--srt-muted)", borderColor: "var(--srt-line)", backgroundColor: "rgba(0,0,0,0.02)" }}>
                      <tr>
                        <th className="px-4 py-3">Module</th>
                        <th className="px-4 py-3">Size</th>
                        <th className="px-4 py-3">Timestamp</th>
                        <th className="px-4 py-3">CRC-16</th>
                        <th className="px-4 py-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y font-mono text-xs" style={{ borderColor: "var(--srt-line)", color: "var(--srt-ink)" }}>
                      {PREVIOUS_DUMPS.map(dump => (
                        <tr key={dump.id} className="hover:bg-black/5 transition-colors">
                          <td className="px-4 py-3 font-bold flex items-center gap-2">
                            {dump.status === "OK" ? <CheckCircle2 size={14} style={{ color: "var(--srt-good)" }} /> : <AlertTriangle size={14} style={{ color: "var(--srt-bad)" }} />}
                            {dump.module} <span className="text-[10px] opacity-50">[{dump.address}]</span>
                          </td>
                          <td className="px-4 py-3">{dump.size}</td>
                          <td className="px-4 py-3" style={{ color: "var(--srt-muted)" }}>{dump.timestamp}</td>
                          <td className="px-4 py-3">{dump.crc}</td>
                          <td className="px-4 py-3 text-right space-x-2">
                            <button className="p-1.5 rounded hover:bg-black/10 transition-colors" title="Open in Diagnose" style={{ color: "var(--srt-muted)" }}>
                              <FileCode2 size={16} />
                            </button>
                            <button className="p-1.5 rounded hover:bg-black/10 transition-colors" title="Download" style={{ color: "var(--srt-muted)" }}>
                              <Download size={16} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

              </div>

            </div>

          </div>
        </div>
      </div>
    </AppShell>
  );
}
