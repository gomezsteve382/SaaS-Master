import React from "react";
import { AppShell } from "./_shared/AppShell";
import { 
  FileBox, 
  UploadCloud, 
  AlertTriangle, 
  CheckCircle2, 
  XCircle, 
  ArrowRight, 
  Download, 
  TerminalSquare, 
  ShieldAlert, 
  Cpu,
  Info
} from "lucide-react";
import { Button } from "@/components/ui/button";

export function Diagnose() {
  // Hex diff data
  const hexRows = [
    { offset: "0x40C0", 
      current: ["FF", "FF", "FF", "FF", "FF", "FF", "FF", "FF", "FF", "A1", "B2", "C3", "D4", "E5", "F6", "07"], 
      proposed: ["FF", "FF", "FF", "FF", "FF", "FF", "FF", "FF", "FF", "4A", "2B", "9C", "1D", "8E", "5F", "30"],
      diffIndexes: [9, 10, 11, 12, 13, 14, 15]
    },
    { offset: "0x40D0", 
      current: ["18", "29", "3A", "4B", "5C", "6D", "7E", "8F", "90", "01", "12", "23", "34", "45", "56", "67"], 
      proposed: ["81", "92", "A3", "B4", "C5", "D6", "E7", "F8", "09", "10", "21", "32", "43", "54", "65", "76"],
      diffIndexes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
    },
    { offset: "0x40E0", 
      current: ["78", "89", "9A", "AB", "BC", "CD", "DE", "EF", "F0", "01", "12", "FF", "FF", "FF", "FF", "FF"], 
      proposed: ["87", "98", "A9", "BA", "CB", "DC", "ED", "FE", "0F", "10", "21", "FF", "FF", "FF", "FF", "FF"],
      diffIndexes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    },
    { offset: "0x40F0", 
      current: ["FF", "FF", "FF", "FF", "FF", "FF", "FF", "FF", "FF", "FF", "FF", "FF", "FF", "FF", "FF", "FF"], 
      proposed: ["FF", "FF", "FF", "FF", "FF", "FF", "FF", "FF", "FF", "FF", "FF", "FF", "FF", "FF", "FF", "FF"],
      diffIndexes: []
    }
  ];

  return (
    <AppShell active="diagnose">
      <div className="p-6 flex flex-col gap-6 max-w-[1200px] mx-auto h-full overflow-y-auto">
        
        {/* Header Chip */}
        <div 
          className="flex items-center justify-between px-4 py-3 rounded-md border"
          style={{ backgroundColor: "var(--srt-panel)", borderColor: "var(--srt-line)" }}
        >
          <div className="flex items-center gap-3">
            <div className="p-2 rounded bg-slate-100 text-slate-600">
              <FileBox size={18} />
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-medium" style={{ color: "var(--srt-ink)" }}>
                BCM_2C3CDXL94MH500418.bin <span style={{ color: "var(--srt-muted)" }}>· 512 KB</span>
              </span>
              <span className="text-xs flex items-center gap-1" style={{ color: "var(--srt-muted)" }}>
                <Cpu size={12} /> GPEC2A-adjacent BCM auto-detected
              </span>
            </div>
          </div>
          
          <button 
            className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition-colors border border-dashed"
            style={{ 
              borderColor: "var(--srt-line)", 
              color: "var(--srt-muted)",
              backgroundColor: "var(--srt-base)"
            }}
          >
            <UploadCloud size={14} />
            <span>Drop another</span>
          </button>
        </div>

        {/* Verdict Banner */}
        <div 
          className="rounded-md border p-5 flex items-start gap-4 shadow-sm"
          style={{ 
            backgroundColor: "#FEF2F2", // Light red tint
            borderColor: "var(--srt-red)",
            borderLeftWidth: "4px"
          }}
        >
          <ShieldAlert size={28} style={{ color: "var(--srt-red)", marginTop: "2px" }} />
          <div className="flex flex-col gap-2 flex-1">
            <h2 className="font-display text-lg uppercase tracking-wide" style={{ color: "var(--srt-red-deep)" }}>
              SEC16 IMMOBILIZER SECRET MISMATCH
            </h2>
            <p className="text-sm leading-relaxed" style={{ color: "var(--srt-ink)" }}>
              BCM split records disagree with RFHUB Gen2 master secret. The BCM contains an older or corrupted SEC16 block starting at <span className="font-mono bg-white px-1.5 py-0.5 rounded border text-xs">0x40C9</span>. Vehicle will not start in current state.
            </p>
            <div className="flex items-center gap-1.5 mt-1 text-xs font-medium" style={{ color: "var(--srt-red)" }}>
              <Info size={14} />
              <span>Confidence: 100% · Source: Cross-module checksum verification</span>
            </div>
          </div>
        </div>

        {/* Module Census Strip */}
        <div className="flex flex-col gap-3">
          <h3 className="font-display text-sm uppercase tracking-wider" style={{ color: "var(--srt-muted)" }}>Module Census</h3>
          <div className="flex items-center gap-3 overflow-x-auto pb-2">
            {[
              { name: "BCM", status: "OK", color: "var(--srt-good)", icon: CheckCircle2 },
              { name: "RFHUB", status: "MISMATCH", color: "var(--srt-bad)", icon: XCircle },
              { name: "PCM", status: "SEC6 ABSENT", color: "var(--srt-warn)", icon: AlertTriangle },
              { name: "GPEC2A", status: "VIRGIN", color: "var(--srt-good)", icon: CheckCircle2 },
            ].map((mod) => (
              <div 
                key={mod.name} 
                className="flex items-center gap-3 px-4 py-2.5 rounded border"
                style={{ backgroundColor: "var(--srt-panel)", borderColor: "var(--srt-line)" }}
              >
                <div className="relative flex items-center justify-center">
                  <Cpu size={18} style={{ color: "var(--srt-ink)" }} />
                  <div 
                    className="absolute -bottom-1 -right-1 w-2.5 h-2.5 rounded-full border-2 border-white"
                    style={{ backgroundColor: mod.color }}
                  />
                </div>
                <div className="flex flex-col">
                  <span className="text-xs font-bold font-mono" style={{ color: "var(--srt-ink)" }}>{mod.name}</span>
                  <span className="text-[10px] font-bold tracking-wide" style={{ color: mod.color }}>{mod.status}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Hex Diff Hero */}
        <div className="flex flex-col flex-1 min-h-[300px] border rounded-md overflow-hidden shadow-sm" style={{ borderColor: "var(--srt-line)" }}>
          <div className="flex items-center justify-between px-4 py-2 border-b" style={{ backgroundColor: "var(--srt-base)", borderColor: "var(--srt-line)" }}>
            <h3 className="font-display text-sm uppercase tracking-wider" style={{ color: "var(--srt-ink)" }}>SEC16 Block Fix Proposal</h3>
          </div>
          
          <div className="flex flex-1 overflow-hidden" style={{ backgroundColor: "var(--srt-panel)" }}>
            {/* Current */}
            <div className="flex-1 border-r flex flex-col" style={{ borderColor: "var(--srt-line)" }}>
              <div className="px-4 py-2 text-xs font-bold border-b" style={{ backgroundColor: "#FDFBF7", borderColor: "var(--srt-line)", color: "var(--srt-muted)" }}>
                BCM 0x40C9 — current
              </div>
              <div className="p-4 font-mono text-xs leading-loose overflow-x-auto whitespace-pre">
                {hexRows.map((row, i) => (
                  <div key={i} className="flex">
                    <span className="w-16 mr-4 opacity-50 select-none">{row.offset}</span>
                    <div className="flex gap-2">
                      {row.current.map((byte, j) => {
                        const isDiff = row.diffIndexes.includes(j);
                        return (
                          <span 
                            key={j} 
                            className={`w-5 text-center ${isDiff ? 'rounded' : ''}`}
                            style={isDiff ? { backgroundColor: "#FEE2E2", color: "var(--srt-red-deep)" } : { color: "var(--srt-ink)" }}
                          >
                            {byte}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Proposed */}
            <div className="flex-1 flex flex-col">
              <div className="px-4 py-2 text-xs font-bold border-b" style={{ backgroundColor: "#F0FDF4", borderColor: "var(--srt-line)", color: "var(--srt-good)" }}>
                Proposed fix — synced from RFHUB
              </div>
              <div className="p-4 font-mono text-xs leading-loose overflow-x-auto whitespace-pre">
                {hexRows.map((row, i) => (
                  <div key={i} className="flex">
                    <span className="w-16 mr-4 opacity-50 select-none">{row.offset}</span>
                    <div className="flex gap-2">
                      {row.proposed.map((byte, j) => {
                        const isDiff = row.diffIndexes.includes(j);
                        return (
                          <span 
                            key={j} 
                            className={`w-5 text-center font-bold ${isDiff ? 'rounded' : ''}`}
                            style={isDiff ? { backgroundColor: "#DCFCE7", color: "#166534" } : { color: "var(--srt-ink)", fontWeight: "normal" }}
                          >
                            {byte}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Action Bar */}
        <div 
          className="mt-auto pt-4 border-t flex flex-col sm:flex-row sm:items-center justify-between gap-4"
          style={{ borderColor: "var(--srt-line)" }}
        >
          <div className="flex items-center gap-3">
            <Button 
              className="font-display tracking-wider uppercase text-white border-0 shadow-sm"
              style={{ backgroundColor: "var(--srt-red)" }}
            >
              Apply fix · Write corrected SEC16
            </Button>
            <span className="text-xs" style={{ color: "var(--srt-muted)" }}>
              * We refuse to write if we are not 100% certain.
            </span>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-9 gap-2 text-xs" style={{ borderColor: "var(--srt-line)", color: "var(--srt-ink)" }}>
              <Download size={14} />
              Export diff report
            </Button>
            <Button variant="outline" size="sm" className="h-9 gap-2 text-xs" style={{ borderColor: "var(--srt-line)", color: "var(--srt-ink)" }}>
              <TerminalSquare size={14} />
              Open in UDS console
            </Button>
          </div>
        </div>

      </div>
    </AppShell>
  );
}
