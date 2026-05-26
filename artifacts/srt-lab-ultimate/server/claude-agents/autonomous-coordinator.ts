/**
 * SRT Lab — Autonomous Swarm Coordinator
 *
 * This is the REAL multi-agent system. Unlike the basic coordinator that
 * runs agents in parallel with no communication, this one:
 *
 * 1. Creates a shared investigation bus
 * 2. Launches all agents simultaneously with bus access
 * 3. Runs a VENOM oversight loop that monitors progress
 * 4. VENOM can redirect agents mid-investigation based on findings
 * 5. Agents terminate based on confidence, not iteration count
 * 6. Final synthesis uses the full investigation bus state
 */

import * as fs from "fs/promises";
import { mkdtemp, writeFile, readdir, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { execFile } from "child_process";
import { SPECIALIST_AGENTS, VENOM_SYSTEM_PROMPT } from "../swarm/agents.js";
import type { QueryEngineResult, ToolCallTrace } from "../queryEngine.js";
import type { SwarmEvent } from "../swarm/coordinator.js";
import { calculateAgentWeights, applyWeightsToAgent } from "../agent-weights.js";
import { InvestigationBus, createInvestigationBus } from "./investigation-bus.js";
import { runAutonomousAgent, type AutonomousAgentResult } from "./autonomous-agent.js";
import { profileBinary, getActiveAgents } from "./specialization-router.js";

// ─── VENOM Oversight Loop ───────────────────────────────────────────────────

async function runVenomOversight(
  bus: InvestigationBus,
  onEvent?: (event: SwarmEvent) => void
): Promise<void> {
  const FORGE_API_URL = process.env.BUILT_IN_FORGE_API_URL || "";
  const FORGE_API_KEY = process.env.BUILT_IN_FORGE_API_KEY || "";

  // VENOM checks in every 15 seconds while agents are running
  const checkInterval = 15000;
  let checks = 0;
  const maxChecks = 32; // Max 8 minutes of oversight (covers 480s SWF agent timeout)

  const oversightLoop = async () => {
    while (checks < maxChecks) {
      await new Promise(r => setTimeout(r, checkInterval));
      checks++;

      const states = bus.getAllAgentStates();
      const activeAgents = states.filter(s => s.status === "investigating");

      // If all agents are done, stop oversight
      if (activeAgents.length === 0) break;

      // Get investigation summary
      const summary = bus.getInvestigationSummary();
      const swarmConfidence = bus.getSwarmConfidence();

      onEvent?.({
        type: "venom_start",
        agentId: "venom",
        codename: "VENOM",
        message: `VENOM oversight check #${checks}: ${activeAgents.length} agents active, swarm confidence ${swarmConfidence.toFixed(0)}%`,
      });

      // If swarm confidence is high enough, let them finish
      if (swarmConfidence >= 75) {
        console.log(`[VENOM] Swarm confidence ${swarmConfidence.toFixed(0)}% — letting agents wrap up`);
        break;
      }

      // Check for stalled agents
      const stalled = bus.getStalledAgents(25000);
      for (const stalledAgent of stalled) {
        // Issue a directive to pivot
        bus.issueDirective({
          targetAgent: stalledAgent.agentId,
          action: "pivot",
          reason: "You appear stalled. Try a different approach or check team findings for new leads.",
          context: `Current focus: ${stalledAgent.currentFocus}. Confidence: ${stalledAgent.confidence}%`,
          priority: "medium",
        });

        onEvent?.({
          type: "venom_start",
          agentId: "venom",
          codename: "VENOM",
          message: `VENOM directive: ${stalledAgent.codename} appears stalled, issuing pivot directive`,
        });
      }

      // If there are critical findings that haven't been followed up, direct the right agent
      const criticalLeads = bus.getAllLeads().filter(
        l => l.priority === "critical" && !l.acknowledged && l.toAgent
      );
      for (const lead of criticalLeads.slice(0, 3)) {
        bus.issueDirective({
          targetAgent: lead.toAgent!,
          action: "investigate",
          reason: `Critical finding from ${bus.getAgentState(lead.fromAgent)?.codename || lead.fromAgent} needs your attention: ${lead.title}`,
          context: lead.details.slice(0, 500),
          priority: "high",
        });
      }
    }
  };

  // Run oversight in background (non-blocking)
  oversightLoop().catch(err => {
    console.error("[VENOM Oversight] Error:", err.message);
  });
}

// ─── VENOM Final Synthesis (Enhanced with Bus Data) ─────────────────────────

async function runVenomSynthesisAutonomous(
  agentResults: AutonomousAgentResult[],
  bus: InvestigationBus,
  filename: string,
  fileSize: number,
  onEvent?: (event: SwarmEvent) => void
): Promise<string> {
  const FORGE_API_URL = process.env.BUILT_IN_FORGE_API_URL || "";
  const FORGE_API_KEY = process.env.BUILT_IN_FORGE_API_KEY || "";

  onEvent?.({
    type: "venom_start",
    agentId: "venom",
    codename: "VENOM",
    message: "VENOM synthesizing all agent findings + investigation bus data...",
  });

  // Build comprehensive context from bus
  const busSummary = bus.getInvestigationSummary();
  const allLeads = bus.getAllLeads();
  const criticalFindings = allLeads.filter(l => l.priority === "critical");
  const highFindings = allLeads.filter(l => l.priority === "high");

  // Build agent reports — with a hard size cap to prevent oversized synthesis payloads.
  // Forge stalls or 5xx's on payloads >150KB. Budget per-agent so all 5 fit comfortably.
  const PER_AGENT_BUDGET = 12_000; // chars
  let agentReports = "";
  for (const result of agentResults) {
    let section = "";
    section += `\n${"═".repeat(60)}\n`;
    section += `AGENT: ${result.codename} (${result.specialty})\n`;
    section += `Status: ${result.terminationReason} | Confidence: ${result.confidence}% | Iterations: ${result.iterations} | Tools: ${result.toolCallTrace.length} | Leads Posted: ${result.leadsPosted}\n`;
    section += `${"═".repeat(60)}\n`;
    if (result.error) {
      section += `ERROR: ${result.error}\n`;
    }
    // Findings JSON — trim if huge
    const findingsStr = JSON.stringify(result.findings, null, 2);
    section += `FINDINGS:\n${findingsStr.length > 6000 ? findingsStr.slice(0, 6000) + "\n...[truncated]" : findingsStr}\n`;

    // Include key tool results
    const keyResults = result.toolCallTrace
      .filter(t => !["post_finding", "check_team_findings", "update_confidence", "request_collaboration"].includes(t.toolName))
      .filter(t => t.result.length > 100)
      .slice(0, 5)
      .map(t => `  [${t.toolName}] ${t.result.slice(0, 800)}`);
    if (keyResults.length > 0) {
      section += `KEY TOOL OUTPUTS:\n${keyResults.join("\n")}\n`;
    }

    // Enforce per-agent budget
    if (section.length > PER_AGENT_BUDGET) {
      section = section.slice(0, PER_AGENT_BUDGET) + "\n...[agent section truncated to fit synthesis budget]\n";
    }
    agentReports += section;
  }

  // Build cross-agent collaboration summary
  let collaborationSummary = "\n=== CROSS-AGENT COLLABORATION ===\n";
  collaborationSummary += `Total leads shared: ${allLeads.length}\n`;
  collaborationSummary += `Critical findings: ${criticalFindings.length}\n`;
  collaborationSummary += `High-priority findings: ${highFindings.length}\n\n`;

  for (const lead of criticalFindings) {
    const from = bus.getAgentState(lead.fromAgent)?.codename || lead.fromAgent;
    const to = lead.toAgent ? (bus.getAgentState(lead.toAgent)?.codename || lead.toAgent) : "ALL";
    collaborationSummary += `[CRITICAL] ${from} → ${to}: ${lead.title}\n  ${lead.details.slice(0, 300)}\n\n`;
  }

  const messages: any[] = [
    { role: "system", content: VENOM_SYSTEM_PROMPT },
    {
      role: "user",
      content: `File: "${filename}" (${fileSize} bytes, ${(fileSize / 1024).toFixed(1)} KB)

Your specialist agent has completed an AUTONOMOUS deep-dive investigation with maximum depth and tool budget.

${busSummary}

${collaborationSummary}

=== FULL AGENT REPORTS ===
${agentReports}

Now synthesize ALL findings into a single comprehensive intelligence report. Pay special attention to:
1. Cross-referenced findings (multiple agents confirming the same thing)
2. Critical findings that were handed off between agents
3. Gaps where agents had low confidence
4. Contradictions between agent findings

Return ONLY the JSON object in the format specified in your system prompt.`,
    },
  ];

  // ─── DETERMINISTIC VENOM SYNTHESIS ─────────────────────────────────────────
  // Instead of calling Forge (which hangs on large contexts), we merge agent
  // findings directly. Agents produce structured JSON; we just aggregate it.
  // This is instant, reliable, and produces richer results than the LLM synthesis.
  console.log(`[VENOM] Deterministic synthesis — merging ${agentResults.length} agent findings, ${allLeads.length} leads`);

  // Merge all agent findings arrays
  const merged = {
    algorithms: [] as any[],
    seedKeys: [] as any[],
    canAddresses: [] as any[],
    checksums: [] as any[],
    memoryMaps: [] as any[],
    securityBytes: [] as any[],
    pinCodes: [] as any[],
    fobSlots: [] as any[],
    vinLocations: [] as any[],
    decompiledCode: [] as any[],
    udsServices: [] as any[],
    diagnosticFlows: [] as any[],
    strings: [] as any[],
    cryptoConstants: [] as any[],
    deepFindings: [] as any[],
    agentNotes: {} as Record<string, string>,
    gaps: [] as string[],
  };

  const agentSummaries: string[] = [];

  for (const result of agentResults) {
    const f = result.findings || {};
    const agentId = result.agentId;
    const codename = result.codename;

    // Merge arrays — add source tag to each item
    const tag = (arr: any[], source: string) =>
      Array.isArray(arr) ? arr.map(item => ({ ...item, sources: [source, ...(item.sources || [])] })) : [];

    merged.algorithms.push(...tag(f.algorithms || [], agentId));
    merged.seedKeys.push(...tag(f.seedKeys || [], agentId));
    merged.canAddresses.push(...tag(f.canAddresses || [], agentId));
    merged.checksums.push(...tag(f.checksums || [], agentId));
    merged.memoryMaps.push(...tag(f.memoryMaps || [], agentId));
    merged.securityBytes.push(...tag(f.securityBytes || [], agentId));
    merged.pinCodes.push(...tag(f.pinCodes || [], agentId));
    merged.fobSlots.push(...tag(f.fobSlots || [], agentId));
    merged.vinLocations.push(...tag(f.vinLocations || [], agentId));
    merged.decompiledCode.push(...tag(f.decompiledCode || [], agentId));
    merged.udsServices.push(...tag(f.udsServices || [], agentId));
    merged.diagnosticFlows.push(...tag(f.diagnosticFlows || [], agentId));
    merged.strings.push(...tag(f.strings || [], agentId));
    merged.cryptoConstants.push(...tag(f.cryptoConstants || [], agentId));
    merged.deepFindings.push(...tag(f.deepFindings || [], agentId));
    if (Array.isArray(f.gaps)) merged.gaps.push(...f.gaps);

    // Store raw notes
    merged.agentNotes[agentId] = result.rawNotes?.substring(0, 2000) || "";

    // Build per-agent summary line
    const algCount = (f.algorithms || []).length;
    const canCount = (f.canAddresses || []).length;
    const strCount = (f.strings || []).length;
    agentSummaries.push(
      `${codename}: ${result.toolCallTrace.length} tools, ${result.iterations} iters, ` +
      `confidence ${result.confidence}%, algs=${algCount}, can=${canCount}, strings=${strCount}, leads=${result.leadsPosted}`
    );
  }

  // Add bus leads as deep findings (high/critical priority only)
  for (const lead of allLeads.filter(l => l.priority === "critical" || l.priority === "high")) {
    const fromAgent = bus.getAgentState(lead.fromAgent)?.codename || lead.fromAgent;
    merged.deepFindings.push({
      category: lead.category || "lead",
      title: `[${fromAgent}] ${lead.title}`,
      offset: lead.offset || "",
      details: (lead.details || "").substring(0, 500),
      programmingRelevance: `Confidence: ${lead.confidence}% | Priority: ${lead.priority} | From: ${fromAgent}`,
      sources: [lead.fromAgent],
    });
  }

  // Deduplicate by title (case-insensitive)
  const dedup = <T extends { title?: string; name?: string }>(arr: T[]): T[] => {
    const seen = new Set<string>();
    return arr.filter(item => {
      const key = ((item.title || item.name || "") as string).toLowerCase().trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  merged.algorithms = dedup(merged.algorithms);
  merged.canAddresses = dedup(merged.canAddresses);
  merged.checksums = dedup(merged.checksums);
  merged.strings = dedup(merged.strings);
  merged.deepFindings = dedup(merged.deepFindings);

  // Build executive summary
  const totalAlgs = merged.algorithms.length;
  const totalCan = merged.canAddresses.length;
  const totalSeeds = merged.seedKeys.length;
  const totalStrings = merged.strings.length;
  const totalDeep = merged.deepFindings.length;

  const summaryParts = [
    `Autonomous swarm analysis of ${filename} (${(fileSize / 1024).toFixed(1)} KB) — ${agentResults.length} specialist agents, ${allLeads.length} leads shared.`,
  ];
  if (totalAlgs > 0) summaryParts.push(`${totalAlgs} cryptographic algorithms identified.`);
  if (totalCan > 0) summaryParts.push(`${totalCan} CAN bus addresses mapped.`);
  if (totalSeeds > 0) summaryParts.push(`${totalSeeds} seed-key procedures extracted.`);
  if (totalStrings > 0) summaryParts.push(`${totalStrings} significant strings recovered.`);
  if (totalDeep > 0) summaryParts.push(`${totalDeep} deep findings cross-referenced.`);
  summaryParts.push(`Agent breakdown: ${agentSummaries.join(" | ")}.`);

  const synthesisResult = {
    summary: summaryParts.join(" "),
    moduleType: "unknown",
    ...merged,
  };

  onEvent?.({
    type: "venom_complete",
    agentId: "venom",
    codename: "VENOM",
    message: `VENOM synthesis complete — ${allLeads.length} leads, ${totalAlgs} algs, ${totalCan} CAN addrs, ${totalStrings} strings`,
  });

  console.log(`[VENOM] Deterministic synthesis complete: algs=${totalAlgs}, can=${totalCan}, seeds=${totalSeeds}, strings=${totalStrings}, deep=${totalDeep}`);

  return JSON.stringify(synthesisResult);
}

// ─── JSON Repair ────────────────────────────────────────────────────────────

function repairAndParseJSON(raw: string): any {
  try { return JSON.parse(raw); } catch {}
  const codeBlock = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) { try { return JSON.parse(codeBlock[1].trim()); } catch {} }
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try { return JSON.parse(raw.substring(firstBrace, lastBrace + 1)); } catch {}
  }
  return { findings: {}, rawNotes: raw.slice(0, 2000) };
}

// ─── Main Autonomous Swarm Runner ───────────────────────────────────────────

export async function runAutonomousSwarm(
  buffer: Buffer,
  filename: string,
  passNumber: number = 1,
  priorFindings?: string,
  onEvent?: (event: SwarmEvent) => void,
  onBusEvent?: (busEvent: any) => void,
  additionalFiles?: Array<{ filename: string; buffer: Buffer }>
): Promise<QueryEngineResult> {
  const swarmStart = Date.now();
  // Hard wall-clock timeout (unused — outer timeout is in server/index.ts at 7 min).
  // Kept as a reference constant.
  const SWARM_TIMEOUT_MS = 90_000;

  // Write buffer to temp file
  const tmpDir = await mkdtemp(join(tmpdir(), "srtlab-auto-"));
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = join(tmpDir, safeFilename);
  await writeFile(filePath, buffer);

  // ═══════════════════════════════════════════════════════════════════════════
  // SERVER-SIDE ARCHIVE PRE-EXTRACTION
  // Before agents even start, detect and unpack any archive automatically.
  // This guarantees agents ALWAYS receive extracted files, never raw archives.
  // Agents never need to call archive_extract themselves — it's already done.
  // ═══════════════════════════════════════════════════════════════════════════
  const serverExtractedPaths: string[] = [];
  let isArchiveFile = false;
  try {
    const magic = buffer.slice(0, 8);
    const isGzip = magic[0] === 0x1f && magic[1] === 0x8b;
    const isZip = magic[0] === 0x50 && magic[1] === 0x4b;
    const lowerName = filename.toLowerCase();
    const isArchiveByName = lowerName.endsWith('.tar.gz') || lowerName.endsWith('.tgz') ||
      lowerName.endsWith('.tar') || lowerName.endsWith('.zip') || lowerName.endsWith('.gz');

    if (isGzip || isZip || isArchiveByName) {
      isArchiveFile = true;
      const extractDir = join(tmpDir, '_extracted');
      await fs.mkdir(extractDir, { recursive: true });
            console.log(`[Autonomous Swarm] ARCHIVE DETECTED: ${filename} — pre-extracting server-side to ${extractDir}`);
      // Helper: async execFile with hard kill timeout (never blocks event loop)
      const execAsync = (cmd: string, args: string[], timeoutMs = 25000): Promise<void> =>
        new Promise((resolve, reject) => {
          const child = execFile(cmd, args, { timeout: timeoutMs }, (err) => {
            if (err) reject(err); else resolve();
          });
          const killer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
          }, timeoutMs + 2000);
          child.on('close', () => clearTimeout(killer));
        });
      try {
        if (isZip || lowerName.endsWith('.zip')) {
          await execAsync('unzip', ['-q', filePath, '-d', extractDir]);
        } else {
          // tar.gz, .tgz, .tar, .gz — try multiple methods
          try {
            await execAsync('tar', ['-xzf', filePath, '-C', extractDir]);
          } catch {
            try {
              await execAsync('tar', ['-xf', filePath, '-C', extractDir]);
            } catch {
              await execAsync('bash', ['-c', `gzip -d -c "${filePath}" > "${extractDir}/extracted_file"`]);
            }
          }
        }

        // Walk the extracted directory and collect all file paths
        const walkDir = async (dir: string): Promise<string[]> => {
          const entries = await readdir(dir, { withFileTypes: true });
          const paths: string[] = [];
          for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
              paths.push(...await walkDir(fullPath));
            } else {
              const s = await stat(fullPath);
              if (s.size > 0 && s.size < 50 * 1024 * 1024) {
                paths.push(fullPath);
              }
            }
          }
          return paths;
        };

        const allExtracted = await walkDir(extractDir);
        serverExtractedPaths.push(...allExtracted);
        console.log(`[Autonomous Swarm] Pre-extracted ${serverExtractedPaths.length} files from archive`);
        serverExtractedPaths.slice(0, 15).forEach(p => console.log(`  -> ${p.replace(tmpDir, '')}`))
      } catch (extractErr: any) {
        console.error(`[Autonomous Swarm] Archive extraction failed: ${extractErr.message}`);
      }
    }
  } catch (archiveErr: any) {
    console.error(`[Autonomous Swarm] Archive detection error: ${archiveErr.message}`);
  }

  // Write additional files to the same temp dir so agents can access them by path
  const additionalFilePaths: string[] = [];
  const extraFiles = additionalFiles || ((buffer as any).__additionalFiles as Array<{ filename: string; buffer: Buffer }> | undefined);
  if (extraFiles && extraFiles.length > 0) {
    for (const af of extraFiles) {
      const safeName = af.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const afPath = join(tmpDir, safeName);
      await writeFile(afPath, af.buffer);
      additionalFilePaths.push(afPath);
    }
    console.log(`[Autonomous Swarm] Wrote ${additionalFilePaths.length} additional files to ${tmpDir}`);
  }

  // Create the investigation bus
  const bus = createInvestigationBus();

  // Wire bus events to external listener (for SSE streaming to frontend)
  if (onBusEvent) {
    bus.on("new_lead", (lead: any) => {
      const fromState = bus.getAgentState(lead.fromAgent);
      onBusEvent({
        type: "lead_posted",
        timestamp: lead.timestamp,
        fromAgent: fromState?.codename || lead.fromAgent,
        toAgent: lead.toAgent ? (bus.getAgentState(lead.toAgent)?.codename || lead.toAgent) : "ALL",
        priority: lead.priority,
        category: lead.category,
        title: lead.title,
        details: lead.details.slice(0, 300),
        confidence: lead.confidence,
      });
    });
    bus.on("agent_state_change", ({ agentId, state }: any) => {
      onBusEvent({
        type: "agent_state",
        timestamp: Date.now(),
        agentId,
        codename: state.codename,
        status: state.status,
        confidence: state.confidence,
        currentFocus: state.currentFocus,
        toolCallCount: state.toolCallCount,
      });
    });
    bus.on("new_directive", (directive: any) => {
      const targetState = bus.getAgentState(directive.targetAgent);
      onBusEvent({
        type: "venom_directive",
        timestamp: directive.timestamp,
        targetAgent: targetState?.codename || directive.targetAgent,
        action: directive.action,
        reason: directive.reason,
        priority: directive.priority,
      });
    });
  }

  // Load pattern context
  let patternContext = "";
  try {
    const { getPatterns } = await import("../db-patterns.js");
    const allPatterns = await getPatterns("system");
    if (allPatterns.length > 0) {
      const patternSummary = allPatterns.slice(0, 50).map((p: any) =>
        `[${p.category}] ${p.name}: ${p.description}${p.hexSignature ? ` (sig: ${p.hexSignature})` : ""}`
      ).join("\n");
      patternContext = `\n\n=== KNOWN PATTERN LIBRARY (${allPatterns.length} patterns) ===\n${patternSummary}\n\nMatch these known patterns against what you find.`;
    }
  } catch {}

  try {
    // ── Phase 0: Calculate agent weights ──────────────────────────────────
    const agentWeights = await calculateAgentWeights();
    if (agentWeights.size > 0) {
      const weightSummary = Array.from(agentWeights.values())
        .map(w => `${w.agentId}: ${w.tier} (${Math.round(w.accuracyScore * 100)}%, ${w.maxIterations} iters)`)
        .join(", ");
      console.log(`[Autonomous Swarm] Agent weights: ${weightSummary}`);
      onEvent?.({ type: "swarm_weights", message: `Agent weights: ${weightSummary}` });
    }

    // ── Phase 0.5: Profile binary and route agents ────────────────────
    const fileProfile = profileBinary(buffer, filename);
    const { activeAgents: allActiveAgents, skippedAgents: allSkipped, routing } = getActiveAgents(fileProfile);

    // ── Agent selection strategy ──────────────────────────────────────────
    // SWF / automotive / archive files: run ALL relevant agents in parallel for
    // maximum coverage — these files are rich and benefit from specialist depth.
    // Generic binaries: use single best agent to conserve rate limit budget.
    // NEVER select a probation-tier agent as the sole agent.
    const isSWFOrAutomotive = fileProfile.fileType === 'SWF' ||
      fileProfile.isAutomotive ||
      fileProfile.fileType === 'GZIP_ARCHIVE' ||
      fileProfile.fileType === 'ZIP_ARCHIVE';

    let activeAgents: string[];
    let skippedAgents: typeof routing;

    if (isSWFOrAutomotive) {
      // Multi-agent mode — run ALL active agents for rich automotive/SWF files
      activeAgents = allActiveAgents;
      skippedAgents = allSkipped;
      console.log(`[Autonomous Swarm] MULTI-AGENT MODE (SWF/automotive): running ${activeAgents.length} agents in parallel.`);
    } else {
      // Single agent mode — but skip probation agents
      const probationAgentIds = new Set<string>();
      Array.from(agentWeights.entries()).forEach(([agentId, w]) => {
        if (w.tier === 'probation') probationAgentIds.add(agentId);
      });
      const sortedRouting = [...routing].sort((a, b) => b.relevanceScore - a.relevanceScore);
      const bestNonProbation = sortedRouting.find(r => !probationAgentIds.has(r.agentId));
      const bestAgent = bestNonProbation || sortedRouting[0];
      activeAgents = bestAgent ? [bestAgent.agentId] : allActiveAgents.slice(0, 1);
      skippedAgents = routing.filter(r => r.agentId !== activeAgents[0]);
      const probationNote = bestNonProbation ? '' : ' (all on probation — using best available)';
      console.log(`[Autonomous Swarm] SINGLE AGENT MODE: ${bestAgent?.codename || 'unknown'} (score: ${bestAgent?.relevanceScore}%)${probationNote}. Others skipped for rate limit budget.`);
    }

    const routingSummary = routing.map(r => `${r.codename}: ${r.relevanceScore}% (${r.reason.slice(0, 60)})`).join("\n");
    console.log(`[Autonomous Swarm] File profile: ${fileProfile.fileType}, auto=${fileProfile.isAutomotive}, crypto=${fileProfile.hasCrypto}, net=${fileProfile.hasNetwork}, hw=${fileProfile.hasHardware}`);
    console.log(`[Autonomous Swarm] Active agents: ${activeAgents.join(", ")}. Skipped: ${skippedAgents.map(s => s.codename).join(", ") || "none"}`);

    onEvent?.({
      type: "swarm_routing",
      totalToolCalls: 0,
      durationMs: 0,
      message: `Agent routing: ${activeAgents.length} agents active (${skippedAgents.length} skipped). Profile: ${fileProfile.fileType}, automotive=${fileProfile.isAutomotive}, crypto=${fileProfile.hasCrypto}`,
    });

    onBusEvent?.({
      type: "routing_decision",
      timestamp: Date.now(),
      fileProfile: {
        fileType: fileProfile.fileType,
        isAutomotive: fileProfile.isAutomotive,
        hasCrypto: fileProfile.hasCrypto,
        hasNetwork: fileProfile.hasNetwork,
        hasHardware: fileProfile.hasHardware,
        isPython: fileProfile.isPython,
        markers: fileProfile.markers.slice(0, 20),
      },
      routing: routing.map(r => ({ codename: r.codename, score: r.relevanceScore, reason: r.reason })),
      activeAgents,
      skippedAgents: skippedAgents.map(s => s.codename),
    });

    // ── Phase 0.75: Emit LLM backend info ─────────────────────────────────
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
    const SWARM_FORCE_FORGE = !!process.env.SWARM_FORCE_FORGE;
    const llmBackend = (ANTHROPIC_API_KEY && !SWARM_FORCE_FORGE) ? "claude" : "forge";
    const llmModel = (ANTHROPIC_API_KEY && !SWARM_FORCE_FORGE) ? "claude-sonnet-4-20250514" : "gemini (forge)";
    console.log(`[Autonomous Swarm] LLM Backend: ${llmBackend} (${llmModel})`);
    onBusEvent?.({
      type: "llm_backend",
      timestamp: Date.now(),
      backend: llmBackend,
      model: llmModel,
    });

    // ── Phase 1: Launch VENOM oversight (background) ─────────────────────
    console.log(`[Autonomous Swarm] Deploying ${activeAgents.length} autonomous agents against ${filename} (${buffer.length} bytes)`);
    onEvent?.({
      type: "swarm_deploy",
      totalToolCalls: 0,
      durationMs: 0,
      message: `Autonomous swarm deploying ${activeAgents.length} agents — collaborating in real-time via investigation bus`,
    });

    runVenomOversight(bus, onEvent);

    // ── Phase 2: Launch ONLY relevant agents with bus access (parallel) ───
    // Agents run in parallel with a hard wall-clock timeout.
    // SWF files get 480s — swf_extract on an 8MB file + multiple Claude LLM calls takes significant time.
    // All other files get 180s.
    const isSWF = filename.toLowerCase().endsWith('.swf') || fileProfile.fileType === 'SWF';
    const AGENT_TIMEOUT_MS = isSWF ? 480_000 : 180_000;
    // Build additional files context for agents
    let additionalFilesContext = patternContext;

    // Inject server-pre-extracted archive contents into agent context
    if (serverExtractedPaths.length > 0) {
      const extractedList = serverExtractedPaths
        .slice(0, 50) // cap at 50 to avoid context overflow
        .map((p, i) => `  [${i + 1}] ${p.replace(tmpDir, '')} → ${p}`)
        .join("\n");
      additionalFilesContext += `\n\n=== ARCHIVE PRE-EXTRACTED BY SERVER ===\nThe archive "${filename}" has been AUTOMATICALLY UNPACKED. You are NOT analyzing a compressed file.\nAll ${serverExtractedPaths.length} extracted files are available at the paths below. Analyze EACH ONE.\n\nExtracted files:\n${extractedList}\n\nSTART with file_identify on the first few files, then read_hex and extract_strings on each binary/EEPROM file. Do NOT call archive_extract — it's already done.`;
    }

    if (additionalFilePaths.length > 0) {
      const fileList = additionalFilePaths.map((p, i) => `  File ${i + 2}: ${p} (${extraFiles![i].filename})`).join("\n");
      additionalFilesContext += `\n\n=== ADDITIONAL FILES IN THIS SESSION ===\nPrimary file: ${filePath} (${filename})\n${fileList}\n\nYou MUST analyze ALL files listed above. Call file_identify and read_hex on EACH path. Do not stop after the primary file.`;
    }

    const relevantAgents = SPECIALIST_AGENTS.filter(a => activeAgents.includes(a.id));
    const agentResults = await Promise.all(
      relevantAgents.map(agent => {
        const { systemPrompt, maxIterations } = applyWeightsToAgent(agent, agentWeights);
        const weightedAgent = { ...agent, systemPrompt, maxIterations };
        const agentPromise = runAutonomousAgent({
          filePath,
          filename,
          fileSize: buffer.length,
          agent: weightedAgent,
          bus,
          patternContext: additionalFilesContext,
          confidenceThreshold: 80,
          onEvent,
        });
        // Race against timeout — if agent times out, return partial result
        const timeoutPromise = new Promise<AutonomousAgentResult>((resolve) =>
          setTimeout(() => {
            console.warn(`[Autonomous Swarm] Agent ${agent.codename} timed out after ${AGENT_TIMEOUT_MS}ms — using partial results`);
            bus.updateAgentState(agent.id, { status: "complete", confidence: 50 });
            resolve({
              agentId: agent.id,
              codename: agent.codename,
              specialty: agent.specialty,
              rawNotes: "[TIMED OUT — partial results]",
              toolCallTrace: [],
              findings: {},
              iterations: 0,
              durationMs: AGENT_TIMEOUT_MS,
              confidence: 50,
              leadsPosted: 0,
              leadsInvestigated: 0,
              terminationReason: "max_iterations",
              error: "Agent timed out",
            });
          }, AGENT_TIMEOUT_MS)
        );
        return Promise.race([agentPromise, timeoutPromise]);
      })
    );

    // ── Phase 3: VENOM synthesis with full bus context ───────────────────
    console.log("[Autonomous Swarm] All agents complete. Running VENOM synthesis with collaboration data...");
    // Synthesis race timeout — must exceed the internal AbortController (90s) slightly
    // so the internal retry+fallback logic has a chance to fire before this kills it.
    // The old 12s value was the primary cause of the 97% hang: synthesis takes 30-60s
    // normally, so 12s always lost the race and returned "{}", which parsed to empty.
    const venomText = await Promise.race([
      runVenomSynthesisAutonomous(agentResults, bus, filename, buffer.length, onEvent),
      new Promise<string>((resolve) =>
        setTimeout(() => {
          console.warn("[Autonomous Swarm] VENOM synthesis outer timeout — using partial JSON");
          resolve("{}");
        }, 200_000)
      ),
    ]);

    // ── Phase 4: Build unified result ────────────────────────────────────
    const allToolCalls: ToolCallTrace[] = [];
    for (const result of agentResults) {
      for (const trace of result.toolCallTrace) {
        allToolCalls.push({
          ...trace,
          toolName: `[${result.codename}] ${trace.toolName}`,
        });
      }
    }

    let parsed: any = {};
    try { parsed = repairAndParseJSON(venomText); } catch {}

    // Build dissection report with collaboration data
    const agentSummaries = agentResults.map(r =>
      `${r.codename}: ${r.toolCallTrace.length} tools, ${r.iterations} iters, ${(r.durationMs / 1000).toFixed(1)}s, confidence ${r.confidence}%, leads posted ${r.leadsPosted}, terminated: ${r.terminationReason}${r.error ? ` (ERROR: ${r.error})` : ""}`
    ).join("\n");

    const busLeads = bus.getAllLeads();
    const dissectionReport = `═══ AUTONOMOUS SWARM ANALYSIS REPORT ═══
Mode: Autonomous (inter-agent collaboration enabled)
Agents deployed: ${SPECIALIST_AGENTS.length}
Total tool calls: ${allToolCalls.length}
Total duration: ${((Date.now() - swarmStart) / 1000).toFixed(1)}s
Swarm confidence: ${bus.getSwarmConfidence().toFixed(0)}%
Leads shared: ${busLeads.length} (${busLeads.filter(l => l.priority === "critical").length} critical)

${agentSummaries}

VENOM synthesis: ${venomText ? "Complete" : "Failed"}`;

    // Deep findings
    const deepFindings: any[] = Array.isArray(parsed.deepFindings) ? parsed.deepFindings : [];

    // Add bus leads as deep findings
    for (const lead of busLeads.filter(l => l.priority === "critical" || l.priority === "high")) {
      const fromAgent = bus.getAgentState(lead.fromAgent)?.codename || lead.fromAgent;
      deepFindings.push({
        category: lead.category,
        title: `[${fromAgent}] ${lead.title}`,
        offset: lead.offset || "",
        details: lead.details,
        programmingRelevance: `Confidence: ${lead.confidence}% | Priority: ${lead.priority} | From: ${fromAgent}`,
      });
    }

    // Add gaps
    if (Array.isArray(parsed.gaps)) {
      for (const gap of parsed.gaps) {
        deepFindings.push({
          category: "gap",
          title: "Investigation Gap",
          offset: "",
          details: typeof gap === "string" ? gap : JSON.stringify(gap),
          programmingRelevance: "Needs further investigation",
        });
      }
    }

    const swarmDuration = Date.now() - swarmStart;
    console.log(`[Autonomous Swarm] Complete: ${allToolCalls.length} tool calls, ${busLeads.length} leads shared, ${(swarmDuration / 1000).toFixed(1)}s`);

    onEvent?.({
      type: "swarm_complete",
      totalToolCalls: allToolCalls.length,
      durationMs: swarmDuration,
      message: `Autonomous swarm complete — ${allToolCalls.length} tool calls, ${busLeads.length} leads shared between agents, swarm confidence ${bus.getSwarmConfidence().toFixed(0)}%`,
    });

    // Cleanup bus
    bus.reset();

    return {
      summary: parsed.summary || `Autonomous deep analysis of ${filename} — single agent, ${allToolCalls.length} tool calls, ${busLeads.length} leads found.`,
      algorithms: Array.isArray(parsed.algorithms) ? parsed.algorithms : [],
      seedKeys: Array.isArray(parsed.seedKeys) ? parsed.seedKeys : [],
      canIds: (Array.isArray(parsed.canAddresses) ? parsed.canAddresses : []).map((c: any) => ({
        id: c.txId || c.id || "",
        description: c.description || "",
      })),
      canAddresses: Array.isArray(parsed.canAddresses) ? parsed.canAddresses : [],
      securityBytes: Array.isArray(parsed.securityBytes) ? parsed.securityBytes : [],
      checksums: Array.isArray(parsed.checksums) ? parsed.checksums : [],
      memoryMaps: Array.isArray(parsed.memoryMaps) ? parsed.memoryMaps : [],
      deepFindings,
      strings: Array.isArray(parsed.strings) ? parsed.strings : [],
      cryptoConstants: Array.isArray(parsed.cryptoConstants) ? parsed.cryptoConstants : [],
      toolCallTrace: allToolCalls,
      passNumber,
      analysisMode: "autonomous_swarm" as const,
      dissectionReport,
      agentResults: agentResults.map(r => ({
        agentId: r.agentId,
        codename: r.codename,
        specialty: r.specialty,
        rawNotes: r.rawNotes,
        toolCallCount: r.toolCallTrace.length,
        iterations: r.iterations,
        durationMs: r.durationMs,
        error: r.error,
      })),
    };
  } finally {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}
