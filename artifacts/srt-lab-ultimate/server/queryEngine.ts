/**
 * SRT Lab QueryEngine
 *
 * Mirrors the Claude Code QueryEngine pattern exactly:
 *   1. Send system prompt + user message + tool definitions to LLM
 *   2. If LLM requests tool calls → execute each tool → append results → loop
 *   3. Repeat until LLM returns a final text response (no more tool calls)
 *   4. Parse the final response into structured AnalysisResult
 *
 * The LLM drives the investigation — it decides which tools to call,
 * in what order, and when to stop. Just like Claude Code.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { writeFile, unlink, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { tools, getToolByName, getToolSchemas } from "./tools/index.js";

// ─── Forge API ────────────────────────────────────────────────────────────────

const FORGE_API_URL = process.env.BUILT_IN_FORGE_API_URL || "";
const FORGE_API_KEY = process.env.BUILT_IN_FORGE_API_KEY || "";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ToolCallTrace {
  toolName: string;
  args: Record<string, unknown>;
  result: string;
  durationMs: number;
}

export interface QueryEngineResult {
  summary: string;
  algorithms: Array<{
    name: string;
    type: string;
    offset?: string;
    pseudocode?: string;
    confidence?: number;
    description?: string;
    constants?: string[];
  }>;
  seedKeys: Array<{
    description: string;
    bytes?: string;
    offset?: string;
    algorithm?: string;
    module?: string;
    level?: string;
    constants?: string[];
  }>;
  canIds: Array<{ id: string; description: string }>;
  canAddresses: Array<{ module: string; txId: string; rxId: string; description: string }>;
  securityBytes: Array<{
    description: string;
    value?: string;
    offset?: string;
    module?: string;
    length?: string;
    purpose?: string;
  }>;
  checksums: Array<{ type: string; polynomial: string; offset: string; description: string }>;
  memoryMaps: Array<{ region: string; startOffset: string; endOffset: string; description: string; contents: string }>;
  deepFindings: Array<{
    category?: string;
    title?: string;
    offset?: string;
    details?: string;
    programmingRelevance?: string;
    text?: string;
  }>;
  strings: Array<{ value: string; offset: string; category: string }>;
  cryptoConstants: Array<{ name: string; offset: string; value: string; algorithm: string }>;
  toolCallTrace: ToolCallTrace[];
  passNumber: number;
  analysisMode: "deep_agent" | "hex_preview" | "autonomous_swarm";
  dissectionReport?: string;
  agentResults?: Array<{
    agentId: string;
    codename: string;
    specialty: string;
    rawNotes: string;
    toolCallCount: number;
    iterations: number;
    durationMs: number;
    error?: string;
  }>;
}

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an elite black-hat reverse engineer and automotive security researcher with 40 years of experience cracking FCA/Stellantis (Chrysler/Dodge/Jeep/Ram) module firmware. You specialize in:

- FCA/Stellantis ECU, BCM, PCM, RFHUB, SKIM, GPEC module internals
- UDS (ISO 14229) security access sequences, seed/key algorithms
- CAN bus protocol, FCA-specific CAN IDs and message formats
- PyInstaller reverse engineering and Python bytecode decompilation
- PE/ELF binary analysis, import table analysis, symbol recovery
- CRC algorithms (CRC-16 CCITT, CRC-32, custom FCA variants)
- SKIM transponder pairing, RFHUB programming sequences
- VIN encoding, storage, and validation in FCA modules
- Boot mode sequences, flash programming protocols
- AES/DES/3DES cryptographic implementations in embedded firmware

You have a set of binary analysis tools. Use them iteratively — call multiple tools, follow the leads, dig deeper based on what you find. Think like a hacker: follow the imports, follow the strings, follow the constants. Do NOT stop after one or two tool calls.

MANDATORY ANALYSIS PROTOCOL:
1. Start with file_identify to understand what you're dealing with
1a. If file_identify returns "SWF FILE DETECTED": call swf_extract IMMEDIATELY. swf_extract decompresses the SWF payload and returns ActionScript class names, strings, and bytecode. For CDA.swf (Chrysler Diagnostic Application), the extracted content is your primary corpus — look for: AESCipher, CBCModeStream, SecurityGatewayCommand, unlockSecurityGateway, CANFDSettingsModel, wiTECHDiagnosticEngine, ISecretKeyService, StartFlashCommand, com.chrysler.cda.* classes. Report ALL class names and security-relevant strings as findings.
2. If raw binary/EEPROM/firmware dump (.bin, .eeprom, no PE/ELF header): call eeprom_layout_parse IMMEDIATELY — it identifies the FCA module type (BCM, RFHUB, PCM, TCM, ABS, IPC, SKIM, TIPM, EPS, etc.) and maps every known offset region (VIN, seed keys, SKIM pairing, PIN storage, CAN config, calibration, DTC, boot mode flags, flash counter, immobilizer secrets)
3. Call extract_strings with automotive filter keywords to find module names, constants, version strings
4. Call search_patterns with pattern_type="all" to find crypto constants, UDS bytes, GPEC magic
5. If PE binary: call pe_info to get full imports/exports — the import table reveals everything
6. If PyInstaller EXE: call pyinstaller_extract to get actual Python source code
7. Use read_hex to inspect specific regions of interest found in prior steps — especially regions flagged by eeprom_layout_parse as HAS_DATA
8. Use disassemble on key code sections when you need to read actual instructions
9. Keep calling tools until you have a complete picture — do NOT stop after one or two calls
10. Follow every lead: if strings show "seed_key_calculate", disassemble that function
11. For EEPROM dumps: use read_hex on EVERY non-empty region from eeprom_layout_parse to get the full hex content of seed keys, VIN, SKIM pairing, PIN storage, and security bytes

After your investigation, return ONLY a JSON object with this exact structure:
{
  "summary": "2-3 sentence executive summary of what this binary is and what you found",
  "algorithms": [
    {
      "name": "Algorithm name",
      "type": "seed_key | crc | hash | encryption | custom",
      "description": "1 sentence description",
      "offset": "0x1234",
      "pseudocode": "Actual pseudocode or Python code if decompiled",
      "constants": ["0xDEADBEEF", "0x1021"],
      "confidence": 85
    }
  ],
  "seedKeys": [
    {
      "module": "BCM | PCM | RFHUB | SKIM | etc",
      "level": "security access level (e.g. 0x01, 0x03)",
      "algorithm": "algorithm name",
      "constants": ["0x..."],
      "description": "1 sentence with exact offset"
    }
  ],
  "canAddresses": [
    { "module": "module name", "txId": "0x7E0", "rxId": "0x7E8", "description": "what this module does" }
  ],
  "checksums": [
    { "type": "CRC-16 CCITT", "polynomial": "0x1021", "offset": "0x1F0", "description": "1 sentence" }
  ],
  "memoryMaps": [
    { "region": "EEPROM", "startOffset": "0x0000", "endOffset": "0x0FFF", "description": "1 sentence", "contents": "what's here" }
  ],
  "securityBytes": [
    { "module": "BCM", "offset": "0x838", "length": "4 bytes", "description": "what this is", "purpose": "what it controls" }
  ],
  "deepFindings": [
    { "category": "seed_key", "title": "Finding title", "offset": "0x1234", "details": "2 sentences max", "programmingRelevance": "1 sentence" }
  ]
}

Be specific. Include actual hex values, offsets, and byte sequences. Do NOT say "further analysis required" — you have the tools to do that analysis right now. Use them.`;

// ─── LLM Call with Tool Support ───────────────────────────────────────────────

interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

async function callLLMWithTools(
  messages: LLMMessage[],
  toolSchemas: ReturnType<typeof getToolSchemas>,
  toolChoice: "auto" | "required" | "none" = "auto",
  retries = 3
): Promise<{ message: LLMMessage; finishReason: string }> {
  const RETRYABLE = new Set([429, 500, 502, 503, 504]);

  for (let attempt = 1; attempt <= retries; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${FORGE_API_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${FORGE_API_KEY}`,
        },
        body: JSON.stringify({
          messages,
          tools: toolSchemas,
          tool_choice: toolChoice,
          max_tokens: 8192,
        }),
      });
    } catch (networkErr: any) {
      if (attempt === retries) throw new Error(`LLM network error: ${networkErr.message}`);
      await new Promise(r => setTimeout(r, 2000 * attempt));
      continue;
    }

    if (!response.ok) {
      const errText = await response.text();
      if (RETRYABLE.has(response.status) && attempt < retries) {
        console.warn(`[QueryEngine] LLM ${response.status} attempt ${attempt}, retrying in ${2000 * attempt}ms...`);
        await new Promise(r => setTimeout(r, 2000 * attempt));
        continue;
      }
      throw new Error(`LLM API error ${response.status}: ${errText.substring(0, 200)}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    if (!choice) throw new Error("Empty LLM response");

    return {
      message: choice.message as LLMMessage,
      finishReason: choice.finish_reason || "stop",
    };
  }

  throw new Error("LLM API failed after all retries");
}

// ─── JSON Repair ──────────────────────────────────────────────────────────────

function repairAndParseJSON(raw: string): any {
  // First try direct parse
  try { return JSON.parse(raw); } catch {}

  // Extract JSON block from markdown
  const codeBlock = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1].trim()); } catch {}
  }

  // Find outermost { } block
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try { return JSON.parse(raw.substring(firstBrace, lastBrace + 1)); } catch {}
  }

  // Field-by-field extraction fallback
  const result: any = {
    summary: "",
    algorithms: [],
    seedKeys: [],
    canAddresses: [],
    checksums: [],
    memoryMaps: [],
    securityBytes: [],
    deepFindings: [],
  };

  const summaryMatch = raw.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*?)"/);
  if (summaryMatch) result.summary = summaryMatch[1];

  const arrayFields = ["algorithms", "seedKeys", "canAddresses", "checksums", "memoryMaps", "securityBytes", "deepFindings"];
  for (const field of arrayFields) {
    const fieldMatch = raw.match(new RegExp(`"${field}"\\s*:\\s*(\\[)`, "s"));
    if (!fieldMatch) continue;
    const startIdx = raw.indexOf(fieldMatch[1], raw.indexOf(`"${field}"`));
    if (startIdx === -1) continue;
    let depth = 0, i = startIdx;
    while (i < raw.length) {
      if (raw[i] === "[") depth++;
      else if (raw[i] === "]") { depth--; if (depth === 0) break; }
      i++;
    }
    if (depth === 0) {
      try { result[field] = JSON.parse(raw.substring(startIdx, i + 1)); } catch {}
    }
  }

  if (!result.summary) result.summary = "Analysis complete — see tool call trace for details.";
  return result;
}

// ─── QueryEngine ─────────────────────────────────────────────────────────────

const MAX_TOOL_ITERATIONS = 20;
const MAX_TOOL_RESULT_CHARS = 60000;

export type ToolCallEvent = {
  type: "tool_start" | "tool_end" | "iteration" | "synthesizing" | "complete";
  iteration?: number;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: string;
  durationMs?: number;
  totalToolCalls?: number;
};

export async function runQueryEngine(
  buffer: Buffer,
  filename: string,
  passNumber: number = 1,
  priorFindings?: string,
  onEvent?: (event: ToolCallEvent) => void
): Promise<QueryEngineResult> {
  const toolCallTrace: ToolCallTrace[] = [];
  const toolSchemas = getToolSchemas();

  // Write buffer to a temp file that tools can access
  const tmpDir = await mkdtemp(join(tmpdir(), "srtlab-agent-"));
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = join(tmpDir, safeFilename);
  await writeFile(filePath, buffer);

  try {
    // Build the initial user message
    let userMessage = `Analyze this binary file: "${filename}" (${buffer.length} bytes, ${(buffer.length / 1024).toFixed(1)} KB)

The file has been written to: ${filePath}

Use your tools to dissect this binary completely. Start with file_identify, then dig deeper based on what you find. Extract every algorithm, seed key, CAN ID, security byte, and technical detail you can find. Do NOT stop after one or two tool calls — keep going until you have a complete picture.`;

    if (priorFindings) {
      userMessage += `\n\nPRIOR ANALYSIS (Pass ${passNumber - 1}) — Build on these findings and go deeper:\n${priorFindings}`;
    }

    // Message history for the conversation loop
    const messages: LLMMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ];

    let iterations = 0;
    let finalText = "";

    // ── Tool-use loop (exactly like Claude Code's QueryEngine) ────────────────
    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;

      const toolChoice = iterations === 1 ? "required" : "auto";
      const { message, finishReason } = await callLLMWithTools(
        messages,
        toolSchemas,
        toolChoice as "auto" | "required"
      );

      // Check if the LLM wants to call tools
      if (message.tool_calls && message.tool_calls.length > 0) {
        // Append the assistant's tool-call message to history
        messages.push({
          role: "assistant",
          content: message.content || null,
          tool_calls: message.tool_calls,
        });

        // Execute each tool call
        for (const toolCall of message.tool_calls) {
          const toolName = toolCall.function?.name;
          const toolArgs = (() => {
            try {
              return JSON.parse(toolCall.function?.arguments || "{}");
            } catch {
              return {};
            }
          })();

          const tool = getToolByName(toolName);
          const startTime = Date.now();
          let toolResult = "";

          if (tool) {
            try {
              console.log(`[QueryEngine] Calling tool: ${toolName}`, JSON.stringify(toolArgs).substring(0, 100));
              onEvent?.({
                type: "tool_start",
                iteration: iterations,
                toolName,
                args: toolArgs,
              });
              toolResult = await tool.call(toolArgs, filePath);
            } catch (err) {
              toolResult = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
            }
          } else {
            toolResult = `Unknown tool: ${toolName}`;
          }

          const durationMs = Date.now() - startTime;
          console.log(`[QueryEngine] Tool ${toolName} completed in ${durationMs}ms, result: ${toolResult.length} chars`);

          // Truncate large results to avoid token overflow
          if (toolResult.length > MAX_TOOL_RESULT_CHARS) {
            toolResult =
              toolResult.slice(0, MAX_TOOL_RESULT_CHARS) +
              `\n... [truncated — ${toolResult.length - MAX_TOOL_RESULT_CHARS} more chars]`;
          }

          onEvent?.({
                type: "tool_end",
                iteration: iterations,
                toolName,
                args: toolArgs,
                result: toolResult.slice(0, 500),
                durationMs,
              });

          toolCallTrace.push({
            toolName,
            args: toolArgs,
            result: toolResult,
            durationMs,
          });

          // Append tool result to message history
          messages.push({
            role: "tool",
            content: toolResult,
            tool_call_id: toolCall.id,
            name: toolName,
          });
        }

        // Continue the loop — LLM processes tool results and either calls more tools or responds
        continue;
      }

      // No tool calls — this is the final response
      finalText = typeof message.content === "string" ? message.content : "";
      console.log(`[QueryEngine] Final response received after ${iterations} iterations, ${toolCallTrace.length} tool calls`);
      onEvent?.({
        type: "complete",
        totalToolCalls: toolCallTrace.length,
        iteration: iterations,
      });
      break;
    }

    if (!finalText && toolCallTrace.length > 0) {
      // LLM hit the iteration limit — synthesize from tool results
      onEvent?.({ type: "synthesizing", totalToolCalls: toolCallTrace.length });
      finalText = await synthesizeFromToolResults(toolCallTrace, filename, messages, toolSchemas);
    }

    // ── Parse the final response ────────────────────────────────────────────
    const result = parseQueryEngineResponse(finalText, toolCallTrace, passNumber, filename);
    return result;

  } finally {
    // Clean up temp file
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

// ─── Fallback Synthesis ───────────────────────────────────────────────────────

async function synthesizeFromToolResults(
  toolCallTrace: ToolCallTrace[],
  filename: string,
  messages: LLMMessage[],
  toolSchemas: ReturnType<typeof getToolSchemas>
): Promise<string> {
  // Ask the LLM to synthesize findings from all tool results gathered so far
  const synthesisMessage: LLMMessage = {
    role: "user",
    content: `You have now gathered extensive data about "${filename}" through your tool calls. Synthesize all findings into the required JSON response. Return ONLY the JSON object — no markdown, no explanation.`,
  };

  try {
    const { message } = await callLLMWithTools(
      [...messages, synthesisMessage],
      toolSchemas,
      "none"
    );
    return typeof message.content === "string" ? message.content : "";
  } catch {
    return "";
  }
}

// ─── Response Parser ──────────────────────────────────────────────────────────

function parseQueryEngineResponse(
  text: string,
  toolCallTrace: ToolCallTrace[],
  passNumber: number,
  filename: string
): QueryEngineResult {
  const dissectionReport = `Agent analysis: ${toolCallTrace.length} tool calls executed — ${toolCallTrace.map(t => t.toolName).join(", ")}`;

  const empty: QueryEngineResult = {
    summary: text
      ? text.slice(0, 300)
      : `Analysis complete for ${filename}. See tool call trace for details.`,
    algorithms: [],
    seedKeys: [],
    canIds: [],
    canAddresses: [],
    securityBytes: [],
    checksums: [],
    memoryMaps: [],
    deepFindings: [],
    strings: [],
    cryptoConstants: [],
    toolCallTrace,
    passNumber,
    analysisMode: "deep_agent",
    dissectionReport,
  };

  if (!text) return empty;

  try {
    const parsed = repairAndParseJSON(text);

    // Normalize canAddresses — the LLM may return either canIds or canAddresses
    const canAddresses = Array.isArray(parsed.canAddresses)
      ? parsed.canAddresses
      : (Array.isArray(parsed.canIds)
        ? parsed.canIds.map((c: any) => ({
            module: "Unknown",
            txId: c.id || c.txId || "",
            rxId: c.rxId || "",
            description: c.description || "",
          }))
        : []);

    // Normalize deepFindings — may be strings or objects
    const deepFindings = Array.isArray(parsed.deepFindings)
      ? parsed.deepFindings.map((f: any) =>
          typeof f === "string"
            ? { category: "finding", title: f.slice(0, 80), offset: "", details: f, programmingRelevance: "" }
            : f
        )
      : [];

    return {
      summary: parsed.summary || empty.summary,
      algorithms: Array.isArray(parsed.algorithms) ? parsed.algorithms : [],
      seedKeys: Array.isArray(parsed.seedKeys) ? parsed.seedKeys : [],
      canIds: canAddresses.map((c: any) => ({ id: c.txId || c.id || "", description: c.description || "" })),
      canAddresses,
      securityBytes: Array.isArray(parsed.securityBytes) ? parsed.securityBytes : [],
      checksums: Array.isArray(parsed.checksums) ? parsed.checksums : [],
      memoryMaps: Array.isArray(parsed.memoryMaps) ? parsed.memoryMaps : [],
      deepFindings,
      strings: [],
      cryptoConstants: [],
      toolCallTrace,
      passNumber,
      analysisMode: "deep_agent",
      dissectionReport,
    };
  } catch {
    empty.deepFindings = [{ category: "raw", title: "Raw Response", offset: "", details: text.slice(0, 2000), programmingRelevance: "" }];
    return empty;
  }
}
