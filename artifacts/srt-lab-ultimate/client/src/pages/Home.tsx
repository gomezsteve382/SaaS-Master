import { useState, useCallback, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Upload,
  Search,
  Shield,
  Cpu,
  Database,
  Zap,
  FileCode,
  Clock,
  ChevronRight,
  AlertTriangle,
  Binary,
  Key,
  Radio,
  HardDrive,
  Wrench,
  RefreshCw,
  BookOpen,
  GitBranch,
  Layers,
  Activity,
} from "lucide-react";
import InvestigationFeed from "@/components/InvestigationFeed";

interface VaultEntry {
  id: string;
  filename: string;
  fileSize: number;
  fileType: string;
  timestamp: number;
  status: string;
  summary: string;
  algorithmCount: number;
  seedKeyCount: number;
  canAddressCount: number;
  checksumCount: number;
  stringCount: number;
}

// ─── Agent metadata (mirrors server/swarm/agents.ts) ─────────────────────

const AGENT_META: Record<string, { codename: string; color: string; icon: string; specialty: string }> = {
  ghost:   { codename: "GHOST",   color: "#00FF88", icon: "👻", specialty: "Crypto Analysis" },
  phantom: { codename: "PHANTOM", color: "#00BFFF", icon: "👤", specialty: "Protocol & CAN" },
  specter: { codename: "SPECTER", color: "#FF6B6B", icon: "🔍", specialty: "Code Recovery" },
  wraith:  { codename: "WRAITH",  color: "#A855F7", icon: "🌀", specialty: "Memory & Structure" },
  shade:   { codename: "SHADE",   color: "#FF8C00", icon: "🛡️", specialty: "Security & SKIM" },
  venom:   { codename: "VENOM",   color: "#FFD700", icon: "🐍", specialty: "Synthesis" },
};

interface SwarmToolEvent {
  agentId: string;
  codename: string;
  type: "start" | "tool_start" | "tool_end" | "complete" | "error";
  toolName?: string;
  args?: Record<string, unknown>;
  result?: string;
  durationMs?: number;
  totalToolCalls?: number;
  message?: string;
}

export default function Home() {
  const [, navigate] = useLocation();
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatus, setUploadStatus] = useState("");
  const [vault, setVault] = useState<VaultEntry[]>([]);
  const [stats, setStats] = useState({ algorithms: 0, seedKeys: 0, canAddresses: 0, checksums: 0, totalAnalyses: 0 });
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [duplicateInfo, setDuplicateInfo] = useState<{ filename: string; analysisId: string; uploadedAt: number } | null>(null);

  const [aiSessions, setAiSessions] = useState(0);
  const [lastFile, setLastFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [analysisMode, setAnalysisMode] = useState<"full_binary" | "hex_preview" | "deep_agent" | null>(null);

  // Swarm state
  const [agentEvents, setAgentEvents] = useState<Record<string, SwarmToolEvent[]>>({});
  const [activeAgents, setActiveAgents] = useState<Set<string>>(new Set());
  const [completedAgents, setCompletedAgents] = useState<Set<string>>(new Set());
  const [venomActive, setVenomActive] = useState(false);
  const [totalSwarmTools, setTotalSwarmTools] = useState(0);
  const terminalRef = useRef<HTMLDivElement>(null);

  // Terminal log state
  const [terminalLog, setTerminalLog] = useState<Array<{ ts: number; agent: string; color: string; text: string }>>([]); 
  const [terminalExpanded, setTerminalExpanded] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  const [debugPollStatus, setDebugPollStatus] = useState<string | null>(null);
  const [timeoutCountdown, setTimeoutCountdown] = useState<number | null>(null); // seconds remaining
  const [showVaultEscape, setShowVaultEscape] = useState(false); // true after 60s of uploading
  const [pendingAnalysisId, setPendingAnalysisId] = useState<string | null>(null); // analysisId for manual vault nav

  // Investigation feed state
  const [investigationEvents, setInvestigationEvents] = useState<any[]>([]);
  const [showInvestigationFeed, setShowInvestigationFeed] = useState(false);

  // Upload speed / ETA state
  const [uploadSpeedBps, setUploadSpeedBps] = useState<number | null>(null);
  const [uploadEtaSec, setUploadEtaSec] = useState<number | null>(null);

  useEffect(() => {
    fetchVault();
    fetchStats();
    fetch("/api/profile").then(r => r.json()).then(p => setAiSessions(p.totalSessions || 0)).catch(() => {});
  }, []);

  // Auto-scroll terminal
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [agentEvents, venomActive]);

  // Auto-scroll collapsible log
  useEffect(() => {
    if (terminalExpanded && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [terminalLog, terminalExpanded]);

  const fetchVault = async () => {
    try {
      const res = await fetch("/api/vault");
      const data = await res.json();
      setVault(data);
    } catch (e) {
      console.error("Failed to fetch vault:", e);
    }
  };

  const fetchStats = async () => {
    try {
      const res = await fetch("/api/stats");
      const data = await res.json();
      setStats(data);
    } catch (e) {
      console.error("Failed to fetch stats:", e);
    }
  };

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      uploadFile(files[0]);
    }
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      uploadFile(e.target.files[0]);
    }
  };

  const uploadFile = async (file: File) => {
    setDuplicateInfo(null);
    setUploadError(null);
    setLastFile(file);

    // ── Handle/timer declarations (in scope for cleanup) ──
    let tickerHandle: ReturnType<typeof setInterval> | null = null;
    let pollHandle: ReturnType<typeof setInterval> | null = null;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let countdownHandle: ReturnType<typeof setInterval> | null = null;
    let escapeTimer: ReturnType<typeof setTimeout> | null = null;
    let navigated = false;

    // ── Reset all UI state ──
    setAgentEvents({});
    setActiveAgents(new Set());
    setCompletedAgents(new Set());
    setVenomActive(false);
    setTotalSwarmTools(0);
    setInvestigationEvents([]);
    setShowInvestigationFeed(false);
    setTerminalLog([]);
    setTerminalExpanded(false);
    setIsUploading(true);
    setUploadProgress(5);
    setUploadStatus("Uploading binary...");
    setAnalysisMode(null);
    setShowVaultEscape(false);
    setPendingAnalysisId(null);
    setDebugPollStatus(null);
    setTimeoutCountdown(null);

    // Show vault escape button after 60s
    escapeTimer = setTimeout(() => setShowVaultEscape(true), 60_000);

    // ── Chunked Upload Config ──
    const CHUNK_SIZE = 200 * 1024; // 200KB — smaller chunks complete faster and are less likely to be aborted on slow connections
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const uploadId = crypto.randomUUID();

    // ── Navigation helper (ensures we only navigate once) ──
    const navigateTo = (analysisId: string, filename: string) => {
      if (navigated) return;
      navigated = true;
      if (tickerHandle) { clearInterval(tickerHandle); tickerHandle = null; }
      if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
      if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
      if (countdownHandle) { clearInterval(countdownHandle); countdownHandle = null; }
      if (escapeTimer) { clearTimeout(escapeTimer); escapeTimer = null; }
      setShowVaultEscape(false);
      setTimeoutCountdown(null);
      setUploadProgress(100);
      setUploadStatus("Done! Redirecting to results...");
      setTimeout(() => {
        setIsUploading(false);
        setUploadProgress(0);
        setUploadStatus("");
        setAnalysisMode(null);
        setAgentEvents({});
        setActiveAgents(new Set());
        setCompletedAgents(new Set());
        setVenomActive(false);
        navigate(`/analysis/${analysisId}`);
      }, 1500);
    };

    // ── DB Polling (the ONLY mechanism that triggers navigation) ──
    const startDbPolling = (pollAnalysisId: string, filename: string, jobTok?: string | null) => {
      if (pollHandle) return; // already polling
      setDebugPollStatus(`Polling DB for ${pollAnalysisId}...`);
      pollHandle = setInterval(async () => {
        try {
          const pollRes = await fetch(`/api/analysis/${pollAnalysisId}`);
          if (pollRes.ok) {
            const pollData = await pollRes.json();
            if (pollData.status === "complete") {
              setDebugPollStatus(`Analysis complete — navigating!`);
              navigateTo(pollAnalysisId, filename);
              return;
            } else if (pollData.status === "failed") {
              if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
              if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
              if (countdownHandle) { clearInterval(countdownHandle); countdownHandle = null; }
              setTimeoutCountdown(null);
              setIsUploading(false);
              setUploadError(pollData.error || "Analysis failed. Please try again.");
              setDebugPollStatus(`Analysis failed: ${pollData.error}`);
              return;
            }
            // status === "running" — keep polling
            setDebugPollStatus(`Analysis running... polling ${pollAnalysisId}`);
          } else if (pollRes.status >= 500) {
            // Server overloaded (503) or crashed (500) — keep polling silently
            // The server is likely busy processing the swarm analysis
            setDebugPollStatus(`Server busy (${pollRes.status}), retrying...`);
          } else {
            setDebugPollStatus(`DB poll: ${pollRes.status} for ${pollAnalysisId}`);
          }
          // Also check job map for failure (backup) — skip silently on any error
          if (jobTok) {
            try {
              const jobRes = await fetch(`/api/job/${jobTok}`);
              if (jobRes.ok) {
                const jobData = await jobRes.json();
                if (jobData.status === "failed") {
                  if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
                  if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
                  if (countdownHandle) { clearInterval(countdownHandle); countdownHandle = null; }
                  setTimeoutCountdown(null);
                  setIsUploading(false);
                  setUploadError(jobData.error || "Analysis failed. Please try again.");
                  setDebugPollStatus(`Job failed: ${jobData.error}`);
                }
              }
              // Silently ignore 5xx/network errors on job endpoint
            } catch { /* server busy, ignore */ }
          }
        } catch (e: any) {
          // Network error — server might be restarting, keep polling
          setDebugPollStatus(`Poll error (retrying): ${e.message}`);
        }
      }, 5000);
    };

    // ── Progress ticker setup ──
    let progressTarget = 15;
    let progressCurrent = 15;
    const TICKER_INTERVAL = 500;
    const DRIFT_PER_TICK = 0.15;
    const HARD_CAP = 97;
    let toolCount = 0;
    let eventCount = 0;

    const calcEventTarget = (events: number, cap: number = 80) => {
      const base = 15;
      const range = cap - base;
      const progress = base + range * (1 - Math.exp(-events / 40));
      return Math.min(Math.round(progress), cap);
    };

    const bumpTarget = (events: number, cap = 80) => {
      const t = calcEventTarget(events, cap);
      if (t > progressTarget) progressTarget = t;
    };

    const logLine = (agent: string, color: string, text: string) => {
      setTerminalLog(prev => [...prev, { ts: Date.now(), agent, color, text }]);
    };

    try {
      // ═══════════════════════════════════════════════════════════════════════
      // STEP 1: Pre-register to get analysisId (plain JSON — works on production)
      // ═══════════════════════════════════════════════════════════════════════
      let analysisId: string | null = null;
      let jobToken: string | null = null;
      try {
        const regRes = await fetch("/api/register-analysis", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, fileSize: file.size }),
        });
        if (regRes.ok) {
          const regData = await regRes.json();
          analysisId = regData.analysisId || null;
          jobToken = regData.jobToken || null;
        }
      } catch (regErr) {
        console.warn("Pre-register failed, will fall back to headers:", regErr);
      }
      if (analysisId) {
        setPendingAnalysisId(analysisId);
        setDebugPollStatus(`Pre-registered: ${analysisId}`);
      }

      // ═══════════════════════════════════════════════════════════════════════
      // STEP 2: Upload all chunks sequentially with retry logic
      // ═══════════════════════════════════════════════════════════════════════
      // Add a small inter-chunk delay to avoid bursting the Forge storage rate limit.
      // The server also has retry-with-backoff, but preventing 429s is better.
      const INTER_CHUNK_DELAY_MS = 150; // 150ms between chunks ≈ ~6 chunks/sec max
      const CHUNK_MAX_RETRIES = 3;

      // Speed / ETA tracking
      const uploadStartTime = Date.now();
      let bytesUploaded = 0;
      setUploadSpeedBps(null);
      setUploadEtaSec(null);

      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);

        // Retry loop for each chunk (handles transient 429/5xx from the server)
        let chunkRes: Response | null = null;
        for (let attempt = 0; attempt <= CHUNK_MAX_RETRIES; attempt++) {
          if (attempt > 0) {
            const retryDelay = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
            setUploadStatus(`Retrying chunk ${i + 1}/${totalChunks} (attempt ${attempt + 1})...`);
            await new Promise(r => setTimeout(r, retryDelay));
          }
          const chunkForm = new FormData();
          chunkForm.append("file", chunk, file.name);
          chunkForm.append("uploadId", uploadId);
          chunkForm.append("chunkIndex", String(i));
          chunkForm.append("totalChunks", String(totalChunks));
          chunkForm.append("filename", file.name);

          chunkRes = await fetch("/api/upload-chunk", { method: "POST", body: chunkForm });
          if (chunkRes.ok) break; // success
          if (attempt === CHUNK_MAX_RETRIES) {
            const err = await chunkRes.json().catch(() => ({ error: `Chunk ${i} upload failed (${chunkRes!.status})` }));
            throw new Error(err.error || `Chunk ${i} upload failed after ${CHUNK_MAX_RETRIES + 1} attempts`);
          }
          // 429 or 5xx — will retry after delay
        }

        const chunkProgress = 5 + Math.round((i + 1) / totalChunks * 15);
        setUploadProgress(chunkProgress);

        // Update speed / ETA
        bytesUploaded += end - start;
        const elapsedSec = (Date.now() - uploadStartTime) / 1000;
        const speedBps = elapsedSec > 0.1 ? bytesUploaded / elapsedSec : null;
        const remainingBytes = file.size - bytesUploaded;
        const etaSec = speedBps && speedBps > 0 ? Math.ceil(remainingBytes / speedBps) : null;
        setUploadSpeedBps(speedBps);
        setUploadEtaSec(etaSec);

        const speedStr = speedBps ? (speedBps >= 1_000_000 ? `${(speedBps / 1_000_000).toFixed(1)} MB/s` : `${(speedBps / 1_000).toFixed(0)} KB/s`) : '';
        setUploadStatus(`Uploading... ${i + 1}/${totalChunks} chunks${speedStr ? ` · ${speedStr}` : ''}`);

        // Small delay between chunks to stay under the Forge rate limit
        if (i < totalChunks - 1) {
          await new Promise(r => setTimeout(r, INTER_CHUNK_DELAY_MS));
        }
      }

      setUploadStatus("Starting analysis...");
      setUploadProgress(20);

      // ═══════════════════════════════════════════════════════════════════════
      // STEP 3: Start DB polling IMMEDIATELY (before SSE fetch)
      // This is the KEY production fix — polling runs independently of SSE.
      // ═══════════════════════════════════════════════════════════════════════
      if (analysisId) {
        startDbPolling(analysisId, file.name, jobToken);
      }

      // Start progress ticker
      tickerHandle = setInterval(() => {
        if (progressCurrent < progressTarget) {
          progressCurrent = Math.min(progressCurrent + 1, progressTarget);
        }
        const slowDrift = progressCurrent + DRIFT_PER_TICK;
        if (slowDrift < HARD_CAP && slowDrift > progressCurrent) {
          progressCurrent = slowDrift;
        }
        setUploadProgress(Math.round(progressCurrent));
      }, TICKER_INTERVAL);

      // 8-minute safety timeout
      let secondsLeft = 8 * 60;
      setTimeoutCountdown(secondsLeft);
      countdownHandle = setInterval(() => {
        secondsLeft -= 1;
        setTimeoutCountdown(secondsLeft);
        if (secondsLeft <= 0) {
          if (countdownHandle) { clearInterval(countdownHandle); countdownHandle = null; }
        }
      }, 1000);

      timeoutHandle = setTimeout(() => {
        if (navigated) return;
        // Keep polling alive — don't set navigated=true
        if (tickerHandle) { clearInterval(tickerHandle); tickerHandle = null; }
        if (countdownHandle) { clearInterval(countdownHandle); countdownHandle = null; }
        setTimeoutCountdown(null);
        setIsUploading(false);
        setUploadProgress(0);
        setUploadStatus("");
        setAgentEvents({});
        setActiveAgents(new Set());
        setCompletedAgents(new Set());
        setVenomActive(false);
        setUploadError(
          "Analysis is taking longer than expected. Check the Vault — your results will appear there once complete."
        );
        setTimeout(() => {
          setUploadError(null);
          navigate("/history");
        }, 6000);
      }, 8 * 60 * 1000);

      // ═══════════════════════════════════════════════════════════════════════
      // STEP 4: Fire SSE stream (non-blocking for navigation — purely for progress UI)
      // If this fetch hangs, times out, or errors, polling still handles navigation.
      // ═══════════════════════════════════════════════════════════════════════
      try {
        const res = await fetch("/api/upload-stream-chunked", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            uploadId,
            totalChunks,
            filename: file.name,
            analysisId: analysisId || undefined,
            jobToken: jobToken || undefined,
          }),
        });

        if (!res.ok) {
          // SSE stream failed to start — not fatal, polling will handle completion
          console.warn("SSE stream failed:", res.status);
          setUploadStatus("Waiting for analysis to complete...");
          // If we don't have an analysisId yet, try to get it from headers
          if (!analysisId) {
            const headerId = res.headers.get("X-Analysis-Id");
            if (headerId) {
              analysisId = headerId;
              setPendingAnalysisId(headerId);
              startDbPolling(headerId, file.name, res.headers.get("X-Job-Token"));
            }
          }
          return; // Let polling handle the rest
        }

        // If we still don't have an analysisId, try headers as last resort
        if (!analysisId) {
          const headerId = res.headers.get("X-Analysis-Id");
          const headerJobToken = res.headers.get("X-Job-Token");
          if (headerId) {
            analysisId = headerId;
            setPendingAnalysisId(headerId);
            startDbPolling(headerId, file.name, headerJobToken);
          }
        }

        // Parse SSE stream for live progress events
        const reader = res.body?.getReader();
        if (!reader) {
          setUploadStatus("Waiting for analysis to complete...");
          return; // Let polling handle the rest
        }

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (!navigated && pollHandle) {
              setUploadStatus("Waiting for analysis to complete...");
            }
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const data = JSON.parse(line.slice(6));

                // ── Legacy status events ──
                if (data.phase === "uploading") {
                  progressTarget = Math.max(progressTarget, 10);
                  setUploadStatus("Uploading binary to storage...");
                  logLine("SYS", "#888", "Uploading binary to storage...");
                } else if (data.phase === "analyzing") {
                  progressTarget = Math.max(progressTarget, 15);
                  setUploadStatus("Deploying 6-agent swarm...");
                  setAnalysisMode("deep_agent");
                  logLine("SYS", "#888", "Deploying 6-agent autonomous swarm...");
                }

                // ── Swarm events ──
                else if (data.type === "agent_start") {
                  const agentId = data.agentId || "unknown";
                  setActiveAgents(prev => { const next = new Set(Array.from(prev)); next.add(agentId); return next; });
                  setAgentEvents(prev => ({
                    ...prev,
                    [agentId]: [...(prev[agentId] || []), {
                      agentId,
                      codename: data.codename || agentId.toUpperCase(),
                      type: "start",
                      message: data.message,
                    }],
                  }));
                  setUploadStatus(`${data.codename || agentId} deploying...`);
                  const meta = AGENT_META[agentId] || { color: "#888" };
                  logLine(data.codename || agentId.toUpperCase(), meta.color, `deployed — ${data.message || "investigating"}`);
                }
                else if (data.type === "agent_tool_start") {
                  const agentId = data.agentId || "unknown";
                  toolCount++;
                  eventCount++;
                  setTotalSwarmTools(toolCount);
                  bumpTarget(eventCount);
                  setUploadStatus(`${data.codename}: ${data.toolName}...`);
                  const meta = AGENT_META[agentId] || { color: "#888" };
                  const argsStr = data.args ? Object.entries(data.args).map(([k,v]) => `${k}=${typeof v === 'string' ? (v as string).substring(0,30) : v}`).join(', ') : '';
                  logLine(data.codename || agentId.toUpperCase(), meta.color, `▸ ${data.toolName}${argsStr ? ` (${argsStr})` : ''}`);
                  setAgentEvents(prev => ({
                    ...prev,
                    [agentId]: [...(prev[agentId] || []), {
                      agentId,
                      codename: data.codename || agentId.toUpperCase(),
                      type: "tool_start",
                      toolName: data.toolName,
                      args: data.args,
                    }],
                  }));
                }
                else if (data.type === "agent_tool_end") {
                  const agentId = data.agentId || "unknown";
                  eventCount++;
                  bumpTarget(eventCount);
                  const metaEnd = AGENT_META[agentId] || { color: "#888" };
                  logLine(data.codename || agentId.toUpperCase(), metaEnd.color, `✓ ${data.toolName} ${data.durationMs ? `(${data.durationMs}ms)` : ''}`);
                  setAgentEvents(prev => {
                    const events = [...(prev[agentId] || [])];
                    for (let i = events.length - 1; i >= 0; i--) {
                      if (events[i].toolName === data.toolName && events[i].type === "tool_start") {
                        events[i] = { ...events[i], type: "tool_end", result: data.result, durationMs: data.durationMs };
                        break;
                      }
                    }
                    return { ...prev, [agentId]: events };
                  });
                }
                else if (data.type === "agent_complete") {
                  const agentId = data.agentId || "unknown";
                  eventCount += 5;
                  bumpTarget(eventCount);
                  const metaComp = AGENT_META[agentId] || { color: "#888" };
                  logLine(data.codename || agentId.toUpperCase(), metaComp.color, `■ COMPLETE — ${data.totalToolCalls || '?'} tools, ${data.durationMs ? (data.durationMs/1000).toFixed(1) + 's' : ''}`);
                  setActiveAgents(prev => {
                    const next = new Set(prev);
                    next.delete(agentId);
                    return next;
                  });
                  setCompletedAgents(prev => { const next = new Set(Array.from(prev)); next.add(agentId); return next; });
                  setAgentEvents(prev => ({
                    ...prev,
                    [agentId]: [...(prev[agentId] || []), {
                      agentId,
                      codename: data.codename || agentId.toUpperCase(),
                      type: "complete",
                      totalToolCalls: data.totalToolCalls,
                      durationMs: data.durationMs,
                      message: data.message,
                    }],
                  }));
                }
                else if (data.type === "agent_error") {
                  const agentId = data.agentId || "unknown";
                  setActiveAgents(prev => {
                    const next = new Set(prev);
                    next.delete(agentId);
                    return next;
                  });
                  setAgentEvents(prev => ({
                    ...prev,
                    [agentId]: [...(prev[agentId] || []), {
                      agentId,
                      codename: data.codename || agentId.toUpperCase(),
                      type: "error",
                      message: data.message,
                    }],
                  }));
                }
                else if (data.type === "venom_start") {
                  setVenomActive(true);
                  progressTarget = 85; progressCurrent = Math.max(progressCurrent, 83);
                  setUploadStatus("VENOM synthesizing all findings...");
                  logLine("VENOM", "#FFD700", "Synthesizing all agent findings...");
                }
                else if (data.type === "venom_complete") {
                  setVenomActive(false);
                  progressTarget = 92; progressCurrent = Math.max(progressCurrent, 90);
                  setUploadStatus("VENOM synthesis complete");
                  logLine("VENOM", "#FFD700", "Synthesis complete");
                }
                else if (data.type === "swarm_routing") {
                  logLine("SYS", "#00BFFF", data.message || "Agent routing complete");
                }
                else if (data.type === "swarm_deploy") {
                  logLine("SYS", "#00BFFF", data.message || "Agents deploying");
                }
                else if (data.type === "swarm_complete") {
                  progressTarget = 95; progressCurrent = Math.max(progressCurrent, 93);
                  setUploadStatus(`Swarm complete — ${data.totalToolCalls} tool calls across 5 agents`);
                  logLine("SYS", "#00FF88", `Swarm complete — ${data.totalToolCalls} tool calls`);
                }

                // ── Investigation bus events ──
                else if (data.type === "bus_event") {
                  const busEvent = data.payload;
                  if (!busEvent) continue;
                  eventCount++;
                  bumpTarget(eventCount);

                  if (busEvent.type === 'routing_decision') {
                    setInvestigationEvents(prev => [...prev, busEvent]);
                    setShowInvestigationFeed(true);
                    const active = busEvent.activeAgents?.join(', ') || '';
                    const skipped = busEvent.skippedAgents?.join(', ') || 'none';
                    logLine('SYS', '#00BFFF', `routing: active=[${active}] skipped=[${skipped}]`);
                  } else if (busEvent.type === 'llm_backend') {
                    setInvestigationEvents(prev => [...prev, busEvent]);
                    setShowInvestigationFeed(true);
                    const backend = busEvent.backend === 'claude' ? 'CLAUDE' : 'FORGE';
                    const color = busEvent.backend === 'claude' ? '#f97316' : '#3b82f6';
                    logLine('LLM', color, `backend: ${backend} (${busEvent.model || 'unknown'})`);
                  } else {
                    setInvestigationEvents(prev => [...prev, busEvent]);
                    setShowInvestigationFeed(true);
                    if (busEvent.type === 'lead_posted') {
                      const src = busEvent.fromAgent || busEvent.from || 'AGENT';
                      const srcMeta = AGENT_META[src.toLowerCase()] || { color: '#0ff' };
                      const title = busEvent.title || busEvent.details?.substring(0, 60) || '';
                      logLine(src, srcMeta.color, `→ [${busEvent.priority || 'med'}] ${title.substring(0, 70)}`);
                    } else if (busEvent.type === 'agent_state') {
                      const meta = AGENT_META[(busEvent.codename || '').toLowerCase()] || { color: '#888' };
                      if (busEvent.confidence !== undefined && busEvent.confidence % 10 === 0 && busEvent.confidence > 0) {
                        logLine(busEvent.codename || 'AGENT', meta.color, `confidence: ${busEvent.confidence}% — ${(busEvent.currentFocus || '').substring(0, 50)}`);
                      }
                    }
                  }
                }

                // ── Legacy tool events ──
                else if (data.type === "tool_start") {
                  toolCount++;
                  setTotalSwarmTools(toolCount);
                  eventCount++;
                  bumpTarget(eventCount);
                  setUploadStatus(`Agent calling: ${data.toolName}...`);
                }
                else if (data.type === "tool_end") { /* no-op */ }
                else if (data.type === "synthesizing") {
                  progressTarget = 90; progressCurrent = Math.max(progressCurrent, 88);
                  setUploadStatus("Synthesizing findings...");
                }
                else if (data.type === "complete") {
                  progressTarget = 95; progressCurrent = Math.max(progressCurrent, 93);
                  setUploadStatus(`Analysis complete — ${data.totalToolCalls} tool calls`);
                }

                // ── Error event ──
                else if (data.message && !data.type) {
                  throw new Error(data.message);
                }

                // ── Job token event (backup — start polling if not already running) ──
                else if (data.jobToken) {
                  if (data.analysisId && !analysisId) {
                    analysisId = data.analysisId;
                    setPendingAnalysisId(data.analysisId);
                  }
                  if (analysisId) startDbPolling(analysisId, file.name, data.jobToken);
                }

                // ── Final result event (backup navigation — polling should get there first) ──
                else if (data.id && (data.status === "complete" || data.findings)) {
                  navigateTo(data.id, data.filename || file.name);
                  return;
                }
              } catch (parseErr: any) {
                // Skip non-JSON lines (keepalive pings, etc.)
              }
            }
          }
        }
      } catch (sseError: any) {
        // SSE stream failed (Cloudflare killed connection, network error, etc.)
        // This is EXPECTED on production — polling handles navigation independently.
        console.warn("SSE stream error (expected on production):", sseError.message);
        if (!navigated && pollHandle) {
          setUploadStatus("Waiting for analysis to complete...");
          return; // Let polling handle the rest
        }
        if (!navigated && !pollHandle) {
          // No polling running either — this is a real failure
          throw sseError;
        }
      }

    } catch (error: any) {
      // Fatal error — chunk upload failed, pre-register failed, etc.
      if (pollHandle && !navigated) {
        // Polling is running — let it handle navigation
        setUploadStatus("Finalizing analysis...");
        return;
      }
      if (tickerHandle) { clearInterval(tickerHandle); tickerHandle = null; }
      if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
      if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
      if (countdownHandle) { clearInterval(countdownHandle); countdownHandle = null; }
      if (escapeTimer) { clearTimeout(escapeTimer); escapeTimer = null; }
      if (!navigated) {
        setIsUploading(false);
        setUploadProgress(0);
        setUploadStatus("");
        setUploadError(error.message);
      }
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}`);
      const data = await res.json();
      setSearchResults(data);
    } catch (e) {
      console.error("Search failed:", e);
    }
    setIsSearching(false);
  };

  const totalAlgorithms = stats.algorithms;
  const totalSeedKeys = stats.seedKeys;
  const totalCanAddresses = stats.canAddresses;
  const totalChecksums = stats.checksums;

  // ─── Render helpers ──────────────────────────────────────────────────────

  const agentIds = Object.keys(agentEvents);
  const hasSwarmEvents = agentIds.length > 0;

  const renderSwarmTerminal = () => (
    <div ref={terminalRef} className="bg-black/80 rounded-lg border border-border/50 p-3 max-h-64 overflow-y-auto font-mono text-xs text-left space-y-1">
      {/* Agent status badges */}
      <div className="flex flex-wrap gap-1.5 mb-2 pb-2 border-b border-border/30">
        {["ghost", "phantom", "specter", "wraith", "shade"].map(id => {
          const meta = AGENT_META[id];
          const isActive = activeAgents.has(id);
          const isComplete = completedAgents.has(id);
          const events = agentEvents[id] || [];
          const toolsDone = events.filter(e => e.type === "tool_end").length;
          return (
            <span
              key={id}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-bold tracking-wider"
              style={{
                borderColor: isComplete ? meta.color : isActive ? meta.color + "80" : "#333",
                color: isComplete ? meta.color : isActive ? meta.color : "#555",
                backgroundColor: isActive ? meta.color + "15" : "transparent",
              }}
            >
              {isActive && <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: meta.color }} />}
              {isComplete && <span className="text-green-400">✓</span>}
              {meta.icon} {meta.codename}
              {toolsDone > 0 && <span className="opacity-60">({toolsDone})</span>}
            </span>
          );
        })}
        {venomActive && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-bold tracking-wider"
            style={{ borderColor: "#FFD700", color: "#FFD700", backgroundColor: "#FFD70015" }}>
            <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
            🐍 VENOM
          </span>
        )}
      </div>

      {/* Per-agent event log — interleaved by time (we just show per-agent blocks) */}
      {agentIds.map(agentId => {
        const meta = AGENT_META[agentId] || { codename: agentId.toUpperCase(), color: "#888", icon: "?", specialty: "" };
        const events = agentEvents[agentId] || [];
        if (events.length === 0) return null;

        return (
          <div key={agentId} className="mb-1">
            {events.map((evt, i) => {
              if (evt.type === "start") {
                return (
                  <div key={i} className="flex items-center gap-1.5" style={{ color: meta.color }}>
                    <span>{meta.icon}</span>
                    <span className="font-bold">{meta.codename}</span>
                    <span className="text-muted-foreground">deployed — {meta.specialty}</span>
                  </div>
                );
              }
              if (evt.type === "tool_start") {
                return (
                  <div key={i} className="flex items-start gap-1.5 pl-4">
                    <span style={{ color: meta.color }}>▸</span>
                    <span className="text-yellow-400">
                      <span className="text-cyan-400">{evt.toolName}</span>
                      {evt.args && Object.keys(evt.args).length > 0 && (
                        <span className="text-muted-foreground ml-1">
                          ({Object.entries(evt.args).map(([k, v]) => `${k}=${typeof v === 'string' ? v.substring(0, 25) : v}`).join(', ')})
                        </span>
                      )}
                      <span className="inline-block w-2 h-3 bg-primary/60 animate-pulse ml-1" />
                    </span>
                  </div>
                );
              }
              if (evt.type === "tool_end") {
                return (
                  <div key={i} className="flex items-start gap-1.5 pl-4">
                    <span className="text-green-500">✓</span>
                    <span className="text-green-400">
                      <span className="text-cyan-400">{evt.toolName}</span>
                      {evt.durationMs && <span className="text-muted-foreground ml-1">({evt.durationMs}ms)</span>}
                      {evt.result && (
                        <span className="text-muted-foreground ml-1 block pl-2 truncate max-w-full">
                          {evt.result.substring(0, 100)}{(evt.result?.length || 0) > 100 ? '...' : ''}
                        </span>
                      )}
                    </span>
                  </div>
                );
              }
              if (evt.type === "complete") {
                return (
                  <div key={i} className="flex items-center gap-1.5" style={{ color: meta.color }}>
                    <span>✓</span>
                    <span className="font-bold">{meta.codename}</span>
                    <span className="text-green-400">complete</span>
                    <span className="text-muted-foreground">
                      — {evt.totalToolCalls} tools, {evt.durationMs ? (evt.durationMs / 1000).toFixed(1) + 's' : ''}
                    </span>
                  </div>
                );
              }
              if (evt.type === "error") {
                return (
                  <div key={i} className="flex items-center gap-1.5 text-red-400">
                    <span>✗</span>
                    <span className="font-bold">{meta.codename}</span>
                    <span>{evt.message}</span>
                  </div>
                );
              }
              return null;
            })}
          </div>
        );
      })}

      {venomActive && (
        <div className="flex items-center gap-1.5 text-yellow-400 mt-1">
          <span>🐍</span>
          <span className="font-bold">VENOM</span>
          <span className="animate-pulse">synthesizing all agent findings...</span>
        </div>
      )}
    </div>
  );

  const renderInvestigationFeed = () => {
    if (!showInvestigationFeed && investigationEvents.length === 0) return null;
    return (
      <div className="mt-3 rounded-lg border border-cyan-500/20 bg-black/60 overflow-hidden" style={{ maxHeight: '300px' }}>
        <InvestigationFeed events={investigationEvents} isLive={isUploading} />
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border/50 bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="container flex items-center justify-between h-16">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded bg-primary/20 flex items-center justify-center glow-red-sm">
              <Shield className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-lg font-bold font-sans tracking-tight">SRT LAB</h1>
              <p className="text-[10px] text-muted-foreground uppercase tracking-widest">
                Ultimate Edition
              </p>
            </div>
          </div>
          <nav className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/align")}
              className="text-muted-foreground hover:text-foreground"
            >
              <Zap className="w-4 h-4 mr-1" />
              Multi-Align
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/compare")}
              className="text-muted-foreground hover:text-foreground"
            >
              <Wrench className="w-4 h-4 mr-1" />
              Compare & Patch
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/history")}
              className="text-muted-foreground hover:text-foreground"
            >
              <Database className="w-4 h-4 mr-1" />
              Vault
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/patterns")}
              className="text-muted-foreground hover:text-foreground"
            >
              <BookOpen className="w-4 h-4 mr-1" />
              Patterns
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/knowledge-graph")}
              className="text-muted-foreground hover:text-foreground"
            >
              <GitBranch className="w-4 h-4 mr-1" />
              KG
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/batch")}
              className="text-muted-foreground hover:text-foreground"
            >
              <Layers className="w-4 h-4 mr-1" />
              Batch
            </Button>
          </nav>
        </div>
      </header>

      <main className="container py-8 space-y-8">
        {/* Hero Section */}
        <section className="text-center space-y-4 py-6">
          <h2 className="text-3xl md:text-4xl font-bold font-sans tracking-tight">
            <span className="text-primary">6-Agent Swarm</span> Reverse Engineering
          </h2>
          <p className="text-muted-foreground max-w-2xl mx-auto">
            Upload any binary — .exe, .dll, .bin, .swf, firmware, EEPROM dumps — and watch 5 specialist agents
            (GHOST, PHANTOM, SPECTER, WRAITH, SHADE) crack it open in parallel, with VENOM synthesizing
            the intelligence.
          </p>
        </section>

        {/* Upload Zone */}
        <section>
          <Card
            className={`carbon-texture border-2 border-dashed transition-all duration-200 ${
              isDragging
                ? "border-primary glow-red scale-[1.01]"
                : isUploading
                ? "border-primary/50"
                : "border-border hover:border-primary/50"
            }`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <CardContent className="py-12 flex flex-col items-center justify-center text-center">
              {isUploading ? (
                <div className="w-full max-w-2xl space-y-4">
                  {/* Swarm header */}
                  <div className="flex items-center justify-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center animate-pulse">
                      <Cpu className="w-5 h-5 text-primary" />
                    </div>
                    <div className="text-left">
                      <p className="text-sm font-semibold">
                        {venomActive ? "VENOM Synthesizing" : activeAgents.size > 0 ? `${activeAgents.size} Agents Active` : "Swarm Deploying"}
                      </p>
                      <p className="text-xs text-muted-foreground font-mono">{uploadStatus}</p>
                    </div>
                    <span className="inline-flex items-center gap-1 text-xs font-mono px-2 py-0.5 rounded-full border bg-green-500/10 border-green-500/40 text-green-400">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400 inline-block animate-pulse" />
                      Swarm Mode
                    </span>
                  </div>

                  <Progress value={uploadProgress} className={`h-2 ${uploadProgress >= 95 && uploadProgress < 100 ? 'animate-pulse-glow' : ''}`} />

                  <p className="text-xs text-muted-foreground text-center">
                    {totalSwarmTools} tool calls · {completedAgents.size}/5 agents complete · {uploadProgress}%
                    {uploadEtaSec !== null && uploadProgress < 20 && (
                      <span className="ml-2 text-cyan-400/80">
                        · ETA {uploadEtaSec < 60 ? `${uploadEtaSec}s` : `${Math.ceil(uploadEtaSec / 60)}m`}
                      </span>
                    )}
                    {uploadSpeedBps !== null && uploadProgress < 20 && (
                      <span className="ml-1 text-cyan-400/60">
                        ({uploadSpeedBps >= 1_000_000 ? `${(uploadSpeedBps / 1_000_000).toFixed(1)} MB/s` : `${(uploadSpeedBps / 1_000).toFixed(0)} KB/s`})
                      </span>
                    )}
                    {timeoutCountdown !== null && (
                      <span className="ml-2 opacity-50">
                        · {Math.floor(timeoutCountdown / 60)}:{String(timeoutCountdown % 60).padStart(2, '0')} remaining
                      </span>
                    )}
                  </p>

                  {/* 95%+ status text */}
                  {uploadProgress >= 95 && uploadProgress < 100 && (
                    <p className="text-xs text-primary/80 text-center font-medium animate-pulse">
                      Agents synthesizing final report…
                    </p>
                  )}

                  {/* Debug polling status — visible in production to diagnose issues */}
                  {debugPollStatus && (
                    <p className="text-[10px] font-mono text-center px-2 py-1 rounded bg-black/40 border border-border/30" style={{ color: debugPollStatus.startsWith('✅') ? '#4ade80' : debugPollStatus.startsWith('❌') || debugPollStatus.startsWith('⚠') ? '#f87171' : '#94a3b8' }}>
                      {debugPollStatus}
                    </p>
                  )}

                  {/* Manual escape hatch — shown after 60s if still uploading */}
                  {showVaultEscape && (
                    <div className="flex flex-col items-center gap-2 pt-1">
                      {pendingAnalysisId ? (
                        <button
                          onClick={() => { navigate(`/analysis/${pendingAnalysisId}`); }}
                          className="text-xs px-3 py-1.5 rounded border border-primary/40 text-primary hover:bg-primary/10 transition-colors font-medium"
                        >
                          View Results →
                        </button>
                      ) : (
                        <button
                          onClick={() => navigate('/history')}
                          className="text-xs px-3 py-1.5 rounded border border-border/40 text-muted-foreground hover:bg-muted/10 transition-colors"
                        >
                          Check Vault for results
                        </button>
                      )}
                    </div>
                  )}

                  {/* Collapsible Terminal Log */}
                  <div className="w-full">
                    <button
                      onClick={() => setTerminalExpanded(!terminalExpanded)}
                      className="w-full flex items-center justify-between px-3 py-2 rounded-t-lg bg-black/80 border border-border/50 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <span className="flex items-center gap-2">
                        <span className={`transition-transform duration-200 ${terminalExpanded ? 'rotate-90' : ''}`}>▶</span>
                        <span>Event Log</span>
                        {terminalLog.length > 0 && (
                          <span className="px-1.5 py-0.5 rounded bg-primary/20 text-primary text-[10px] font-bold">
                            {terminalLog.length}
                          </span>
                        )}
                      </span>
                      <span className="text-[10px] opacity-60">{terminalExpanded ? 'collapse' : 'expand'}</span>
                    </button>
                    {terminalExpanded && (
                      <div className="bg-black/90 border border-t-0 border-border/50 rounded-b-lg p-2 max-h-64 overflow-y-auto font-mono text-[11px] text-left space-y-0.5">
                        {terminalLog.length === 0 && (
                          <div className="text-muted-foreground animate-pulse py-2 text-center">Waiting for events...</div>
                        )}
                        {terminalLog.map((entry, i) => (
                          <div key={i} className="flex items-start gap-1.5 leading-tight">
                            <span className="text-muted-foreground/50 shrink-0 w-[52px] text-right">
                              {new Date(entry.ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                            </span>
                            <span className="font-bold shrink-0 w-[70px] text-right truncate" style={{ color: entry.color }}>
                              [{entry.agent}]
                            </span>
                            <span className="text-foreground/80 break-all">{entry.text}</span>
                          </div>
                        ))}
                        <div ref={logEndRef} />
                      </div>
                    )}
                  </div>

                  {/* Investigation Feed — live collaboration events */}
                  {renderInvestigationFeed()}
                </div>
              ) : (
                <>
                  <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                    <Upload className="w-8 h-8 text-primary" />
                  </div>
                  <h3 className="text-xl font-semibold mb-2">Drop Binary Here</h3>
                  <p className="text-sm text-muted-foreground mb-4">
                    .exe, .dll, .bin, .swf, .eeprom, .hex, .srec, .fw, .rom — any binary format
                  </p>
                  <label>
                    <input
                      type="file"
                      className="hidden"
                      onChange={handleFileSelect}
                      accept=".exe,.dll,.bin,.swf,.eeprom,.hex,.srec,.fw,.rom,.flash,.img,.elf,.so,.sys"
                    />
                    <Button variant="default" className="cursor-pointer" asChild>
                      <span>
                        <FileCode className="w-4 h-4 mr-2" />
                        Select File
                      </span>
                    </Button>
                  </label>
                  <p className="text-xs text-muted-foreground mt-3">Max 500MB</p>
                </>
              )}
            </CardContent>
          </Card>
          {uploadError && !isUploading && (
            <div className="mt-3 p-4 rounded-lg bg-destructive/10 border border-destructive/30 text-sm">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
                <div className="flex-1">
                  <p className="font-medium text-destructive">Analysis Failed</p>
                  <p className="text-muted-foreground mt-1">{uploadError}</p>
                  {lastFile && (
                    <div className="flex gap-2 mt-3">
                      <Button
                        size="sm"
                        variant="default"
                        onClick={() => uploadFile(lastFile)}
                      >
                        <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                        Retry Analysis
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => { setUploadError(null); setLastFile(null); }}
                      >
                        Dismiss
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

        </section>

        {/* Stats Grid */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className="carbon-texture">
            <CardContent className="py-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded bg-primary/10 flex items-center justify-center">
                <Binary className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="text-2xl font-bold font-mono">{totalAlgorithms}</p>
                <p className="text-xs text-muted-foreground">Algorithms</p>
              </div>
            </CardContent>
          </Card>
          <Card className="carbon-texture">
            <CardContent className="py-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded bg-primary/10 flex items-center justify-center">
                <Key className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="text-2xl font-bold font-mono">{totalSeedKeys}</p>
                <p className="text-xs text-muted-foreground">Seed Keys</p>
              </div>
            </CardContent>
          </Card>
          <Card className="carbon-texture">
            <CardContent className="py-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded bg-primary/10 flex items-center justify-center">
                <Radio className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="text-2xl font-bold font-mono">{totalCanAddresses}</p>
                <p className="text-xs text-muted-foreground">CAN Addresses</p>
              </div>
            </CardContent>
          </Card>
          <Card className="carbon-texture">
            <CardContent className="py-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded bg-primary/10 flex items-center justify-center">
                <HardDrive className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="text-2xl font-bold font-mono">{totalChecksums}</p>
                <p className="text-xs text-muted-foreground">Checksums</p>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* Search */}
        <section>
          <Card className="carbon-texture">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Search className="w-5 h-5 text-primary" />
                Intelligence Search
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2">
                <Input
                  placeholder="Search algorithms, modules, CAN IDs, constants..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                  className="font-mono text-sm"
                />
                <Button onClick={handleSearch} disabled={isSearching}>
                  <Search className="w-4 h-4" />
                </Button>
              </div>
              {searchResults.length > 0 && (
                <div className="mt-4 space-y-2 max-h-80 overflow-y-auto">
                  {searchResults.map((result, idx) => (
                    <div
                      key={idx}
                      className="p-3 rounded bg-secondary/50 border border-border/50"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant="outline" className="text-xs">
                          {result.type}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          from {result.source}
                        </span>
                      </div>
                      <pre className="text-xs font-mono text-foreground/80 whitespace-pre-wrap">
                        {JSON.stringify(result.data, null, 2)}
                      </pre>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        {/* Recent Analyses */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold flex items-center gap-2">
              <Clock className="w-5 h-5 text-primary" />
              Intelligence Vault
            </h3>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/history")}
              className="text-muted-foreground"
            >
              View All <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          </div>
          <div className="space-y-3">
            {vault.length === 0 ? (
              <Card className="carbon-texture">
                <CardContent className="py-8 text-center text-muted-foreground">
                  <Zap className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p>No analyses yet. Upload a binary to get started.</p>
                </CardContent>
              </Card>
            ) : (
              vault.slice(0, 5).map((entry) => (
                <Card
                  key={entry.id}
                  className="carbon-texture cursor-pointer hover:border-primary/30 transition-all duration-150"
                  onClick={() => navigate(`/analysis/${entry.id}`)}
                >
                  <CardContent className="py-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded bg-primary/10 flex items-center justify-center">
                          <FileCode className="w-5 h-5 text-primary" />
                        </div>
                        <div>
                          <p className="font-medium font-mono text-sm">
                            {entry.filename}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {entry.fileType} •{" "}
                            {entry.fileSize > 0
                              ? `${(entry.fileSize / 1024).toFixed(1)} KB`
                              : "< 1 KB"}{" "}
                            •{" "}
                            {new Date(entry.timestamp).toLocaleDateString()}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {entry.algorithmCount > 0 && (
                          <Badge variant="outline" className="text-xs">
                            {entry.algorithmCount} algos
                          </Badge>
                        )}
                        {entry.seedKeyCount > 0 && (
                          <Badge variant="outline" className="text-xs">
                            {entry.seedKeyCount} keys
                          </Badge>
                        )}
                        {entry.canAddressCount > 0 && (
                          <Badge variant="outline" className="text-xs">
                            {entry.canAddressCount} CAN
                          </Badge>
                        )}
                        <Badge
                          variant={entry.status === "complete" ? "default" : "secondary"}
                          className="text-xs"
                        >
                          {entry.status}
                        </Badge>
                        <ChevronRight className="w-4 h-4 text-muted-foreground" />
                      </div>
                    </div>
                    {entry.summary && (
                      <p className="text-xs text-muted-foreground mt-2 line-clamp-2 pl-13">
                        {entry.summary}
                      </p>
                    )}
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-border/30 py-6 mt-12">
        <div className="container text-center text-xs text-muted-foreground">
          <p>SRT Lab: Ultimate Edition — 6-Agent Swarm Reverse Engineering</p>
          <p className="mt-1">GHOST · PHANTOM · SPECTER · WRAITH · SHADE · VENOM</p>
        </div>
      </footer>
    </div>
  );
}
