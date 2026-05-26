/**
 * SRT Lab — Inter-Agent Investigation Bus
 *
 * Shared real-time communication layer between agents.
 * Agents can:
 * - Post findings that all other agents can see
 * - Signal specific agents to investigate something
 * - Read what other agents have discovered so far
 * - Receive directives from VENOM (the coordinator)
 *
 * This turns 6 isolated agents into a collaborating team.
 */

import { EventEmitter } from "events";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface InvestigationLead {
  id: string;
  fromAgent: string;
  toAgent?: string; // If undefined, broadcast to all
  priority: "critical" | "high" | "medium" | "low";
  type: "finding" | "request" | "directive" | "handoff";
  category: string; // e.g., "crypto", "protocol", "memory", "security"
  title: string;
  details: string;
  offset?: string; // Binary offset if relevant
  confidence: number; // 0-100
  timestamp: number;
  acknowledged: boolean; // Legacy field (kept for compat)
  acknowledgedBy: Set<string>; // Per-agent acknowledgment tracking
}

export interface AgentState {
  agentId: string;
  codename: string;
  status: "idle" | "investigating" | "waiting" | "complete";
  currentFocus: string;
  confidence: number; // Overall confidence in findings so far (0-100)
  leadsInvestigated: number;
  leadsGenerated: number;
  toolCallCount: number;
  lastActivity: number;
}

export interface VenomDirective {
  id: string;
  targetAgent: string;
  action: "investigate" | "go_deeper" | "stop" | "pivot" | "collaborate";
  reason: string;
  context: string;
  priority: "critical" | "high" | "medium";
  timestamp: number;
}

// ─── Investigation Bus ──────────────────────────────────────────────────────

export class InvestigationBus extends EventEmitter {
  private leads: InvestigationLead[] = [];
  private agentStates: Map<string, AgentState> = new Map();
  private directives: VenomDirective[] = [];
  private leadCounter = 0;

  constructor() {
    super();
    this.setMaxListeners(20);
  }

  // ── Agent Registration ──────────────────────────────────────────────────

  registerAgent(agentId: string, codename: string): void {
    this.agentStates.set(agentId, {
      agentId,
      codename,
      status: "idle",
      currentFocus: "",
      confidence: 0,
      leadsInvestigated: 0,
      leadsGenerated: 0,
      toolCallCount: 0,
      lastActivity: Date.now(),
    });
  }

  updateAgentState(agentId: string, update: Partial<AgentState>): void {
    const state = this.agentStates.get(agentId);
    if (state) {
      Object.assign(state, update, { lastActivity: Date.now() });
      this.emit("agent_state_change", { agentId, state: { ...state } });
    }
  }

  getAgentState(agentId: string): AgentState | undefined {
    return this.agentStates.get(agentId);
  }

  getAllAgentStates(): AgentState[] {
    return Array.from(this.agentStates.values());
  }

  // ── Lead Management ─────────────────────────────────────────────────────

  /**
   * Post a finding or request to the bus.
   * Other agents will see this and can act on it.
   */
  postLead(lead: Omit<InvestigationLead, "id" | "timestamp" | "acknowledged" | "acknowledgedBy">): InvestigationLead {
    const fullLead: InvestigationLead = {
      ...lead,
      id: `lead-${++this.leadCounter}`,
      timestamp: Date.now(),
      acknowledged: false,
      acknowledgedBy: new Set(),
    };
    this.leads.push(fullLead);

    // Update the posting agent's state
    const state = this.agentStates.get(lead.fromAgent);
    if (state) {
      state.leadsGenerated++;
      state.lastActivity = Date.now();
    }

    // Emit events
    this.emit("new_lead", fullLead);
    if (lead.toAgent) {
      this.emit(`lead_for_${lead.toAgent}`, fullLead);
    } else {
      this.emit("broadcast_lead", fullLead);
    }

    return fullLead;
  }

  /**
   * Get all leads relevant to a specific agent.
   * Returns: broadcasts + leads specifically addressed to this agent.
   */
  getLeadsForAgent(agentId: string): InvestigationLead[] {
    return this.leads.filter(
      lead => !lead.toAgent || lead.toAgent === agentId
    );
  }

  /**
   * Get unacknowledged leads for an agent (new intel they haven't seen).
   * Uses per-agent tracking so each agent gets to see every lead independently.
   */
  getNewLeadsForAgent(agentId: string): InvestigationLead[] {
    return this.leads.filter(
      lead => !lead.acknowledgedBy.has(agentId) &&
        lead.fromAgent !== agentId &&
        (!lead.toAgent || lead.toAgent === agentId)
    );
  }

  /**
   * Mark a lead as acknowledged by a specific agent.
   * Other agents can still see and acknowledge the same lead independently.
   */
  acknowledgeLead(leadId: string, agentId: string): void {
    const lead = this.leads.find(l => l.id === leadId);
    if (lead) {
      lead.acknowledgedBy.add(agentId);
      lead.acknowledged = lead.acknowledgedBy.size >= this.agentStates.size; // Legacy compat
      const state = this.agentStates.get(agentId);
      if (state) state.leadsInvestigated++;
    }
  }

  /**
   * Get all leads sorted by priority.
   */
  getAllLeads(): InvestigationLead[] {
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    return [...this.leads].sort(
      (a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]
    );
  }

  /**
   * Get leads by category (e.g., all crypto findings).
   */
  getLeadsByCategory(category: string): InvestigationLead[] {
    return this.leads.filter(l => l.category === category);
  }

  // ── VENOM Directives ────────────────────────────────────────────────────

  /**
   * VENOM issues a directive to a specific agent.
   */
  issueDirective(directive: Omit<VenomDirective, "id" | "timestamp">): VenomDirective {
    const fullDirective: VenomDirective = {
      ...directive,
      id: `directive-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
    };
    this.directives.push(fullDirective);
    this.emit(`directive_for_${directive.targetAgent}`, fullDirective);
    this.emit("new_directive", fullDirective);
    return fullDirective;
  }

  /**
   * Get pending directives for an agent.
   */
  getDirectivesForAgent(agentId: string): VenomDirective[] {
    return this.directives.filter(d => d.targetAgent === agentId);
  }

  // ── Confidence & Termination ────────────────────────────────────────────

  /**
   * Check if the swarm has reached sufficient confidence to stop.
   * Returns true if ALL agents have confidence >= threshold.
   */
  isInvestigationComplete(confidenceThreshold: number = 75): boolean {
    const states = this.getAllAgentStates();
    if (states.length === 0) return false;
    return states.every(s => s.confidence >= confidenceThreshold || s.status === "complete");
  }

  /**
   * Get the overall swarm confidence (average of all agents).
   */
  getSwarmConfidence(): number {
    const states = this.getAllAgentStates();
    if (states.length === 0) return 0;
    return states.reduce((sum, s) => sum + s.confidence, 0) / states.length;
  }

  /**
   * Get agents that are stalled (no activity for > timeout ms).
   */
  getStalledAgents(timeoutMs: number = 30000): AgentState[] {
    const now = Date.now();
    return this.getAllAgentStates().filter(
      s => s.status === "investigating" && (now - s.lastActivity) > timeoutMs
    );
  }

  // ── Summary for VENOM ───────────────────────────────────────────────────

  /**
   * Generate a summary of all findings for VENOM to evaluate.
   */
  getInvestigationSummary(): string {
    const states = this.getAllAgentStates();
    const criticalLeads = this.leads.filter(l => l.priority === "critical");
    const highLeads = this.leads.filter(l => l.priority === "high");

    let summary = `=== INVESTIGATION STATUS ===\n`;
    summary += `Swarm Confidence: ${this.getSwarmConfidence().toFixed(0)}%\n`;
    summary += `Total Leads: ${this.leads.length} (${criticalLeads.length} critical, ${highLeads.length} high)\n\n`;

    summary += `=== AGENT STATUS ===\n`;
    for (const state of states) {
      summary += `${state.codename}: ${state.status} | Focus: ${state.currentFocus} | Confidence: ${state.confidence}% | Tools: ${state.toolCallCount} | Leads: ${state.leadsGenerated} posted, ${state.leadsInvestigated} investigated\n`;
    }

    summary += `\n=== CRITICAL FINDINGS ===\n`;
    for (const lead of criticalLeads) {
      const from = this.agentStates.get(lead.fromAgent)?.codename || lead.fromAgent;
      summary += `[${from}] ${lead.title}: ${lead.details.slice(0, 200)}\n`;
    }

    summary += `\n=== HIGH-PRIORITY FINDINGS ===\n`;
    for (const lead of highLeads.slice(0, 10)) {
      const from = this.agentStates.get(lead.fromAgent)?.codename || lead.fromAgent;
      summary += `[${from}] ${lead.title}: ${lead.details.slice(0, 150)}\n`;
    }

    return summary;
  }

  // ── Reset ───────────────────────────────────────────────────────────────

  reset(): void {
    this.leads = [];
    this.agentStates.clear();
    this.directives = [];
    this.leadCounter = 0;
    this.removeAllListeners();
  }
}

// ─── Singleton Bus Instance ─────────────────────────────────────────────────

export function createInvestigationBus(): InvestigationBus {
  return new InvestigationBus();
}
