import React, { useState } from "react";
import { AppShell } from "./_shared/AppShell";
import { 
  Bot, 
  User, 
  Send, 
  ChevronRight, 
  Cpu, 
  ShieldAlert, 
  Wrench, 
  CheckCircle2, 
  CircleDashed,
  TerminalSquare,
  Activity,
  AlertTriangle,
  Zap,
  Fingerprint
} from "lucide-react";

export function AiCopilot() {
  const [inputValue, setInputValue] = useState("");

  return (
    <AppShell active="copilot">
      <div 
        className="flex h-full w-full overflow-hidden" 
        style={{ backgroundColor: "var(--srt-base)", color: "var(--srt-ink)" }}
      >
        
        {/* MAIN CHAT AREA */}
        <div className="flex-1 flex flex-col min-w-0 border-r" style={{ borderColor: "var(--srt-line)" }}>
          
          {/* Header */}
          <div className="h-14 flex items-center px-6 border-b shrink-0 bg-white/50" style={{ borderColor: "var(--srt-line)" }}>
            <div className="flex items-center gap-2">
              <Bot className="w-5 h-5" style={{ color: "var(--srt-red)" }} />
              <h2 className="font-display text-lg tracking-wide uppercase mt-1">AI Copilot</h2>
            </div>
            <div className="ml-auto flex items-center gap-3">
              <span className="flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full" style={{ backgroundColor: "rgba(34, 197, 94, 0.1)", color: "var(--srt-good)" }}>
                <Activity className="w-3.5 h-3.5" />
                Active Session
              </span>
            </div>
          </div>

          {/* Transcript Area */}
          <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
            
            {/* Tech Message */}
            <div className="flex gap-4 max-w-4xl ml-auto">
              <div className="flex-1 bg-white p-4 rounded-lg rounded-tr-sm shadow-sm border" style={{ borderColor: "var(--srt-line)" }}>
                <p className="text-sm">
                  Key programming fails with <span className="font-mono text-xs bg-gray-100 px-1 py-0.5 rounded">NRC 0x35</span> on <span className="font-mono text-xs bg-gray-100 px-1 py-0.5 rounded">RFHUB</span> after BCM swap — why?
                </p>
              </div>
              <div className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center bg-gray-200 text-gray-600">
                <User className="w-5 h-5" />
              </div>
            </div>

            {/* Assistant Message */}
            <div className="flex gap-4 max-w-4xl mr-auto">
              <div className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center text-white" style={{ backgroundColor: "var(--srt-red)" }}>
                <Bot className="w-5 h-5" />
              </div>
              <div className="flex-1 bg-white p-5 rounded-lg rounded-tl-sm shadow-sm border" style={{ borderColor: "var(--srt-line)" }}>
                <div className="flex items-center gap-2 mb-3">
                  <Badge variant="danger" icon={<ShieldAlert className="w-3 h-3"/>}>Mismatch Detected</Badge>
                  <span className="text-xs" style={{ color: "var(--srt-muted)" }}>09:41:22 AM</span>
                </div>
                
                <div className="space-y-4 text-sm leading-relaxed">
                  <p>
                    <span className="font-mono text-xs bg-gray-100 px-1 py-0.5 rounded">NRC 0x35</span> indicates an Invalid Key during Security Access. 
                    I've cross-referenced the dumps for the donor BCM and the target RFHUB Gen2.
                  </p>
                  
                  <div className="bg-gray-50 border p-3 rounded space-y-2" style={{ borderColor: "var(--srt-line)" }}>
                    <div className="flex justify-between text-xs pb-1 border-b" style={{ borderColor: "var(--srt-line)", color: "var(--srt-muted)" }}>
                      <span>Parameter</span>
                      <span>Donor BCM (Extracted)</span>
                      <span>Target RFHUB (Current)</span>
                    </div>
                    <div className="flex justify-between font-mono text-xs">
                      <span className="font-sans text-xs font-medium">VIN</span>
                      <span>1C4RJFDJ7DC5*****</span>
                      <span className="text-orange-600">2C3CDXCT1HH6*****</span>
                    </div>
                    <div className="flex justify-between font-mono text-xs">
                      <span className="font-sans text-xs font-medium">PIN</span>
                      <span>4419</span>
                      <span className="text-orange-600">8231</span>
                    </div>
                    <div className="flex justify-between font-mono text-xs">
                      <span className="font-sans text-xs font-medium">SEC16 (Bytes 0-3)</span>
                      <span>7F 2A 91 B4</span>
                      <span style={{ color: "var(--srt-bad)" }}>C2 99 F1 0A</span>
                    </div>
                  </div>

                  <p>
                    The BCM swap introduced split records. The RFHUB Gen2 is generating its challenge based on its original <span className="font-mono text-xs">SEC16</span> secret (<span className="font-mono text-xs">C2 99 F1 0A ...</span>), while your test tool is calculating the response using the BCM's secret (<span className="font-mono text-xs">7F 2A 91 B4 ...</span>).
                  </p>

                  <div className="bg-orange-50 border border-orange-200 p-3 rounded text-orange-900">
                    <p className="font-medium text-xs mb-1 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> Recommendation</p>
                    <p>Perform a SEC16 Sync to mirror the donor BCM's 16-byte secret into the RFHUB. Once synchronized, Security Access (0x27) will pass and key programming can proceed.</p>
                  </div>
                </div>

                <div className="mt-5 pt-4 border-t flex flex-wrap gap-2" style={{ borderColor: "var(--srt-line)" }}>
                  <button className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded bg-gray-100 hover:bg-gray-200 transition-colors" style={{ color: "var(--srt-ink)" }}>
                    <Wrench className="w-3.5 h-3.5 text-gray-500" />
                    Open SEC16 Sync
                  </button>
                  <button className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded bg-gray-100 hover:bg-gray-200 transition-colors" style={{ color: "var(--srt-ink)" }}>
                    <Fingerprint className="w-3.5 h-3.5 text-gray-500" />
                    View BCM Extracted Data
                  </button>
                  <button className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded bg-gray-100 hover:bg-gray-200 transition-colors" style={{ color: "var(--srt-ink)" }}>
                    <TerminalSquare className="w-3.5 h-3.5 text-gray-500" />
                    Test 0x27 in UDS Console
                  </button>
                </div>
              </div>
            </div>

          </div>

          {/* Input Area */}
          <div className="p-4 bg-white/50 border-t shrink-0" style={{ borderColor: "var(--srt-line)" }}>
            <div className="max-w-4xl mx-auto space-y-3">
              {/* Chips */}
              <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
                <Chip>Explain RFHUB Gen2 differences</Chip>
                <Chip>Can I bypass SEC16 entirely?</Chip>
                <Chip>Show me the raw hex dump mismatch</Chip>
              </div>
              
              <div className="relative flex items-center">
                <input 
                  type="text" 
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  placeholder="Ask about DTCs, NRCs, or request a diagnostic procedure..."
                  className="w-full h-12 pl-4 pr-12 rounded-lg border bg-white text-sm focus:outline-none focus:ring-1"
                  style={{ 
                    borderColor: "var(--srt-line)", 
                    color: "var(--srt-ink)",
                    '--tw-ring-color': "var(--srt-red)"
                  } as any}
                />
                <button 
                  className="absolute right-2 w-8 h-8 flex items-center justify-center rounded transition-colors text-white"
                  style={{ backgroundColor: "var(--srt-red)" }}
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
              <div className="text-[10px] text-center" style={{ color: "var(--srt-muted)" }}>
                AI responses may not always be 100% accurate. Verify critical data against service manuals.
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT RAIL - INVESTIGATION */}
        <div className="w-[320px] shrink-0 bg-white flex flex-col border-l" style={{ borderColor: "var(--srt-line)" }}>
          <div className="h-14 flex items-center px-4 border-b shrink-0" style={{ borderColor: "var(--srt-line)" }}>
            <h3 className="font-display text-sm uppercase tracking-wider">Investigation State</h3>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-6">
            
            {/* Context */}
            <div className="space-y-3">
              <h4 className="text-xs font-bold uppercase tracking-wide" style={{ color: "var(--srt-muted)" }}>Active Context</h4>
              <div className="bg-gray-50 border p-3 rounded space-y-2" style={{ borderColor: "var(--srt-line)" }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Cpu className="w-4 h-4 text-gray-500" />
                    <span className="text-xs font-medium">Donor BCM</span>
                  </div>
                  <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-mono">LOADED</span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Zap className="w-4 h-4 text-gray-500" />
                    <span className="text-xs font-medium">Target RFHUB</span>
                  </div>
                  <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-mono">LOADED</span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <TerminalSquare className="w-4 h-4 text-gray-500" />
                    <span className="text-xs font-medium">UDS Trace</span>
                  </div>
                  <span className="text-[10px] bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded font-mono">EMPTY</span>
                </div>
              </div>
            </div>

            {/* Findings */}
            <div className="space-y-3">
              <h4 className="text-xs font-bold uppercase tracking-wide" style={{ color: "var(--srt-muted)" }}>Current Findings</h4>
              
              <div className="relative border-l-2 ml-2 pl-4 py-1 space-y-5" style={{ borderColor: "var(--srt-line)" }}>
                
                {/* Step 1 */}
                <div className="relative">
                  <div className="absolute -left-[23px] top-0 bg-white text-green-500">
                    <CheckCircle2 className="w-4 h-4" />
                  </div>
                  <p className="text-xs font-medium mb-1">Analyze Failure Mode</p>
                  <p className="text-[11px] leading-tight" style={{ color: "var(--srt-muted)" }}>Identified NRC 0x35 (Invalid Key) on routine 0x3101 during Key Programming.</p>
                </div>

                {/* Step 2 */}
                <div className="relative">
                  <div className="absolute -left-[23px] top-0 bg-white text-green-500">
                    <CheckCircle2 className="w-4 h-4" />
                  </div>
                  <p className="text-xs font-medium mb-1">Cross-reference SEC16</p>
                  <p className="text-[11px] leading-tight" style={{ color: "var(--srt-muted)" }}>Extracted 16-byte secrets from both modules. Confirmed mismatch.</p>
                </div>

                {/* Step 3 */}
                <div className="relative">
                  <div className="absolute -left-[23px] top-0 bg-white" style={{ color: "var(--srt-red)" }}>
                    <CircleDashed className="w-4 h-4 animate-spin-slow" style={{ animationDuration: '3s' }} />
                  </div>
                  <p className="text-xs font-medium mb-1" style={{ color: "var(--srt-red)" }}>Resolve Split Records</p>
                  <p className="text-[11px] leading-tight mb-2" style={{ color: "var(--srt-muted)" }}>Waiting for operator to sync SEC16 from Donor BCM to RFHUB.</p>
                  <button 
                    className="w-full flex items-center justify-center gap-2 text-xs font-medium text-white px-3 py-1.5 rounded transition-colors shadow-sm"
                    style={{ backgroundColor: "var(--srt-red)" }}
                  >
                    <Wrench className="w-3.5 h-3.5" />
                    Open SEC16 Sync Tool
                  </button>
                </div>

              </div>
            </div>

            {/* Confidence */}
            <div className="p-3 bg-gray-50 border rounded-lg" style={{ borderColor: "var(--srt-line)" }}>
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs font-bold uppercase" style={{ color: "var(--srt-muted)" }}>Diagnosis Confidence</span>
                <span className="text-xs font-mono font-bold" style={{ color: "var(--srt-good)" }}>98.5%</span>
              </div>
              <div className="w-full h-1.5 bg-gray-200 rounded-full overflow-hidden">
                <div className="h-full bg-green-500 rounded-full" style={{ width: "98.5%" }}></div>
              </div>
            </div>

          </div>
        </div>

      </div>
    </AppShell>
  );
}

// Helpers
function Badge({ children, icon, variant = "default" }: { children: React.ReactNode, icon?: React.ReactNode, variant?: "default" | "danger" | "success" }) {
  let bg = "bg-gray-100";
  let text = "text-gray-700";
  
  if (variant === "danger") {
    bg = "bg-red-100";
    text = "text-red-700";
  } else if (variant === "success") {
    bg = "bg-green-100";
    text = "text-green-700";
  }

  return (
    <span className={`flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${bg} ${text}`}>
      {icon}
      {children}
    </span>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <button className="whitespace-nowrap flex items-center gap-1 text-xs px-3 py-1.5 border rounded-full bg-white hover:bg-gray-50 transition-colors" style={{ borderColor: "var(--srt-line)", color: "var(--srt-muted)" }}>
      {children}
    </button>
  );
}
