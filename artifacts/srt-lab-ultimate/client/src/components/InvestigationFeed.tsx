import { useState, useEffect, useRef } from "react";
import { Activity, Radio, Zap, Eye, AlertTriangle, ArrowRight, Shield, Brain, Cpu } from "lucide-react";

/**
 * InvestigationFeed — Real-time display of agent collaboration during analysis.
 * Connects to the SSE stream and shows:
 * - LLM backend indicator (Claude vs Forge)
 * - Agent state changes (who's investigating what)
 * - Leads posted between agents
 * - VENOM directives
 * - Routing decisions
 * - Confidence updates
 */

interface FeedEvent {
  type: "lead_posted" | "agent_state" | "venom_directive" | "routing_decision" | "llm_backend";
  timestamp: number;
  [key: string]: any;
}

interface Props {
  events: FeedEvent[];
  isLive: boolean;
}

const AGENT_COLORS: Record<string, string> = {
  GHOST: "text-cyan-400",
  PHANTOM: "text-purple-400",
  SPECTER: "text-amber-400",
  WRAITH: "text-red-400",
  SHADE: "text-green-400",
  VENOM: "text-rose-500",
};

const AGENT_BG: Record<string, string> = {
  GHOST: "bg-cyan-500/10 border-cyan-500/30",
  PHANTOM: "bg-purple-500/10 border-purple-500/30",
  SPECTER: "bg-amber-500/10 border-amber-500/30",
  WRAITH: "bg-red-500/10 border-red-500/30",
  SHADE: "bg-green-500/10 border-green-500/30",
  VENOM: "bg-rose-500/10 border-rose-500/30",
};

const PRIORITY_COLORS: Record<string, string> = {
  critical: "text-red-400 bg-red-500/20",
  high: "text-amber-400 bg-amber-500/20",
  medium: "text-blue-400 bg-blue-500/20",
  low: "text-zinc-400 bg-zinc-500/20",
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function LLMBackendEvent({ event }: { event: FeedEvent }) {
  const isClaude = event.backend === "claude";
  const bgClass = isClaude
    ? "bg-orange-500/10 border-orange-500/30"
    : "bg-blue-500/10 border-blue-500/30";
  const textClass = isClaude ? "text-orange-400" : "text-blue-400";
  const iconClass = isClaude ? "text-orange-400" : "text-blue-400";
  const label = isClaude ? "CLAUDE" : "FORGE";
  const model = event.model || (isClaude ? "claude-sonnet-4" : "gemini (forge)");

  return (
    <div className={`flex gap-3 items-center py-2.5 px-3 rounded-lg border ${bgClass}`}>
      <Cpu className={`w-4 h-4 ${iconClass}`} />
      <div className="flex items-center gap-2 flex-1">
        <span className={`font-mono text-xs font-bold ${textClass}`}>LLM BACKEND</span>
        <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold tracking-wider ${isClaude ? "bg-orange-500/30 text-orange-300" : "bg-blue-500/30 text-blue-300"}`}>
          {label}
        </span>
        <span className="text-[10px] text-zinc-500 font-mono">{model}</span>
      </div>
      <span className="text-[10px] text-zinc-600">{formatTime(event.timestamp)}</span>
    </div>
  );
}

function LeadEvent({ event }: { event: FeedEvent }) {
  const color = AGENT_COLORS[event.fromAgent] || "text-zinc-400";
  const priorityClass = PRIORITY_COLORS[event.priority] || PRIORITY_COLORS.low;

  return (
    <div className="flex gap-3 items-start py-2 px-3 rounded-lg hover:bg-white/5 transition-colors">
      <div className="mt-1">
        <Radio className={`w-4 h-4 ${color}`} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`font-mono text-xs font-bold ${color}`}>{event.fromAgent}</span>
          <ArrowRight className="w-3 h-3 text-zinc-600" />
          <span className="font-mono text-xs text-zinc-400">{event.toAgent}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${priorityClass}`}>
            {event.priority}
          </span>
          <span className="text-[10px] text-zinc-600 ml-auto">{formatTime(event.timestamp)}</span>
        </div>
        <p className="text-sm text-zinc-300 mt-0.5 font-medium">{event.title}</p>
        {event.details && (
          <p className="text-xs text-zinc-500 mt-0.5 line-clamp-2">{event.details}</p>
        )}
        {event.confidence > 0 && (
          <span className="text-[10px] text-zinc-600 mt-1 inline-block">
            confidence: {event.confidence}%
          </span>
        )}
      </div>
    </div>
  );
}

function AgentStateEvent({ event }: { event: FeedEvent }) {
  const color = AGENT_COLORS[event.codename] || "text-zinc-400";
  const statusIcon = event.status === "investigating" ? "🔍" : event.status === "complete" ? "✅" : "⏸";

  return (
    <div className="flex gap-3 items-center py-1.5 px-3 rounded-lg hover:bg-white/5 transition-colors">
      <Eye className={`w-3.5 h-3.5 ${color}`} />
      <span className={`font-mono text-xs font-bold ${color}`}>{event.codename}</span>
      <span className="text-xs text-zinc-500">{statusIcon} {event.status}</span>
      {event.currentFocus && (
        <span className="text-xs text-zinc-600 truncate max-w-[200px]">→ {event.currentFocus}</span>
      )}
      <span className="text-xs text-zinc-600 ml-auto">
        {event.confidence}% | {event.toolCallCount} tools
      </span>
      <span className="text-[10px] text-zinc-700">{formatTime(event.timestamp)}</span>
    </div>
  );
}

function DirectiveEvent({ event }: { event: FeedEvent }) {
  return (
    <div className="flex gap-3 items-start py-2 px-3 rounded-lg bg-rose-500/5 border border-rose-500/20 hover:bg-rose-500/10 transition-colors">
      <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5" />
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-bold text-rose-400">VENOM</span>
          <ArrowRight className="w-3 h-3 text-zinc-600" />
          <span className={`font-mono text-xs font-bold ${AGENT_COLORS[event.targetAgent] || "text-zinc-400"}`}>
            {event.targetAgent}
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 font-medium">
            {event.action}
          </span>
          <span className="text-[10px] text-zinc-600 ml-auto">{formatTime(event.timestamp)}</span>
        </div>
        <p className="text-xs text-zinc-400 mt-0.5">{event.reason}</p>
      </div>
    </div>
  );
}

function RoutingEvent({ event }: { event: FeedEvent }) {
  return (
    <div className="py-2 px-3 rounded-lg bg-indigo-500/5 border border-indigo-500/20">
      <div className="flex items-center gap-2 mb-2">
        <Brain className="w-4 h-4 text-indigo-400" />
        <span className="text-xs font-bold text-indigo-400">SPECIALIZATION ROUTING</span>
        <span className="text-[10px] text-zinc-600 ml-auto">{formatTime(event.timestamp)}</span>
      </div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {event.fileProfile && Object.entries(event.fileProfile).map(([key, val]: [string, any]) => {
          if (key === "markers" || typeof val === "object") return null;
          if (typeof val === "boolean" && !val) return null;
          return (
            <span key={key} className={`text-[10px] px-1.5 py-0.5 rounded ${val === true ? "bg-green-500/20 text-green-300" : "bg-zinc-700/50 text-zinc-400"}`}>
              {key}: {String(val)}
            </span>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {event.routing?.map((r: any) => (
          <div key={r.codename} className={`text-[10px] px-2 py-1 rounded border ${AGENT_BG[r.codename] || "bg-zinc-800 border-zinc-700"}`}>
            <span className={`font-bold ${AGENT_COLORS[r.codename] || "text-zinc-400"}`}>{r.codename}</span>
            <span className="text-zinc-500 ml-1">{r.score}%</span>
          </div>
        ))}
      </div>
      {event.skippedAgents?.length > 0 && (
        <p className="text-[10px] text-zinc-600 mt-1.5">
          Skipped: {event.skippedAgents.join(", ")} (below relevance threshold)
        </p>
      )}
    </div>
  );
}

export default function InvestigationFeed({ events, isLive }: Props) {
  const feedRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    if (autoScroll && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [events.length, autoScroll]);

  const handleScroll = () => {
    if (feedRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = feedRef.current;
      setAutoScroll(scrollHeight - scrollTop - clientHeight < 50);
    }
  };

  const leadCount = events.filter(e => e.type === "lead_posted").length;
  const directiveCount = events.filter(e => e.type === "venom_directive").length;
  const backendEvent = events.find(e => e.type === "llm_backend");

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-cyan-400" />
          <span className="text-sm font-bold text-zinc-200">Investigation Feed</span>
          {isLive && (
            <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-green-500/20 text-green-400 animate-pulse">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
              LIVE
            </span>
          )}
          {/* Persistent LLM Backend Badge in header */}
          {backendEvent && (
            <span className={`flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-bold tracking-wide ${
              backendEvent.backend === "claude"
                ? "bg-orange-500/20 text-orange-400 border border-orange-500/30"
                : "bg-blue-500/20 text-blue-400 border border-blue-500/30"
            }`}>
              <Cpu className="w-3 h-3" />
              {backendEvent.backend === "claude" ? "CLAUDE" : "FORGE"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-zinc-500">
          <span>{events.length} events</span>
          <span>{leadCount} leads</span>
          <span>{directiveCount} directives</span>
        </div>
      </div>

      {/* Feed */}
      <div
        ref={feedRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto space-y-1 p-2"
      >
        {events.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-zinc-600">
            <Shield className="w-8 h-8 mb-2" />
            <p className="text-sm">Waiting for agent activity...</p>
            <p className="text-xs mt-1">Upload a binary to see real-time collaboration</p>
          </div>
        ) : (
          events.map((event, i) => {
            switch (event.type) {
              case "llm_backend":
                return <LLMBackendEvent key={i} event={event} />;
              case "lead_posted":
                return <LeadEvent key={i} event={event} />;
              case "agent_state":
                return <AgentStateEvent key={i} event={event} />;
              case "venom_directive":
                return <DirectiveEvent key={i} event={event} />;
              case "routing_decision":
                return <RoutingEvent key={i} event={event} />;
              default:
                return null;
            }
          })
        )}
      </div>

      {/* Footer with legend */}
      <div className="px-4 py-2 border-t border-zinc-800 flex flex-wrap gap-3">
        {Object.entries(AGENT_COLORS).map(([name, color]) => (
          <span key={name} className={`text-[10px] font-mono font-bold ${color}`}>{name}</span>
        ))}
      </div>
    </div>
  );
}
