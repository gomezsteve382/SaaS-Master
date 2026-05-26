import { nanoid } from "nanoid";
import { buildEnrichedSystemPrompt, buildReanalysisPrompt } from "./ai-learning.js";
import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, unlink, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const execFileAsync = promisify(execFile);

const FORGE_API_URL = process.env.BUILT_IN_FORGE_API_URL || "https://forge.manus.ai";
const FORGE_API_KEY = process.env.BUILT_IN_FORGE_API_KEY || "";

// Path to the Python dissect script
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DISSECT_SCRIPT = join(__dirname, "dissect.py");

export interface AnalysisResult {
  id: string;
  filename: string;
  fileSize: number;
  fileType: string;
  timestamp: number;
  status: "analyzing" | "complete" | "error";
  analysisPass: number; // 1 = first pass, 2+ = re-analysis
  findings: {
    summary: string;
    algorithms: Algorithm[];
    seedKeys: SeedKey[];
    canAddresses: CanAddress[];
    checksums: Checksum[];
    memoryMaps: MemoryMap[];
    strings: ExtractedString[];
    cryptoConstants: CryptoConstant[];
    securityBytes: SecurityByte[];
    deepFindings?: DeepFinding[];
  };
  rawHex: string;
  analysisMode: "deep_dissection" | "hex_preview";
  dissectionReport?: string; // Summary of what the dissector found
  error?: string;
}

interface Algorithm {
  name: string;
  type: string;
  description: string;
  constants: string[];
  pseudocode?: string;
}

interface SeedKey {
  module: string;
  level: string;
  algorithm: string;
  constants: string[];
  description: string;
}

interface CanAddress {
  module: string;
  txId: string;
  rxId: string;
  description: string;
}

interface Checksum {
  type: string;
  polynomial: string;
  offset: string;
  description: string;
}

interface MemoryMap {
  region: string;
  startOffset: string;
  endOffset: string;
  description: string;
  contents: string;
}

interface ExtractedString {
  value: string;
  offset: string;
  category: string;
}

interface CryptoConstant {
  name: string;
  value: string;
  offset: string;
  algorithm: string;
}

interface SecurityByte {
  module: string;
  offset: string;
  length: string;
  description: string;
  purpose: string;
}

interface DeepFinding {
  category: string;
  title: string;
  offset: string;
  details: string;
  programmingRelevance: string;
}

// ─── DEEP BINARY DISSECTION via Python subprocess ────────────────────────────
/**
 * Run the Python dissect.py script on the binary.
 * Returns structured dissection data including decompiled Python source,
 * PE imports/exports, automotive patterns, strings, and annotated hex chunks.
 */
async function runDissector(buffer: Buffer, filename: string): Promise<any | null> {
  let tmpFile: string | null = null;
  try {
    // Write buffer to a temp file
    const tmpDir = await mkdtemp(join(tmpdir(), "srtlab-"));
    tmpFile = join(tmpDir, filename.replace(/[^a-zA-Z0-9._-]/g, "_"));
    await writeFile(tmpFile, buffer);

    const { stdout, stderr } = await execFileAsync(
      "python3",
      [DISSECT_SCRIPT, tmpFile],
      { maxBuffer: 50 * 1024 * 1024, timeout: 120000 } // 50MB output, 2min timeout
    );

    if (stderr && !stdout) {
      console.warn("[dissect] stderr only:", stderr.substring(0, 500));
      return null;
    }

    const result = JSON.parse(stdout);
    if (result.error) {
      console.warn("[dissect] dissector error:", result.error);
      return null;
    }
    return result;
  } catch (err: any) {
    console.warn("[dissect] failed:", err.message?.substring(0, 200));
    return null;
  } finally {
    if (tmpFile) {
      try { await unlink(tmpFile); } catch {}
    }
  }
}

/**
 * Build a rich text context from dissection output for the LLM.
 * This is what replaces the old 256-byte hex sample.
 */
function buildDissectionContext(dissection: any, filename: string): string {
  const sections: string[] = [];

  sections.push(`═══ FILE INTELLIGENCE REPORT ═══`);
  sections.push(`File: ${filename}`);
  sections.push(`Type: ${dissection.file_type || "Unknown"}`);
  sections.push(`Size: ${dissection.file_size} bytes (${(dissection.file_size / 1024).toFixed(1)} KB)`);
  sections.push(`SHA-256: ${dissection.sha256}`);

  // PE structure
  if (dissection.pe_info && dissection.pe_info.type === "PE") {
    const pe = dissection.pe_info;
    sections.push(`\n═══ PE STRUCTURE ═══`);
    sections.push(`Machine: ${pe.machine}`);
    sections.push(`Timestamp: ${pe.timestamp}`);

    if (pe.sections?.length > 0) {
      sections.push(`\nSECTIONS:`);
      pe.sections.forEach((s: any) => {
        sections.push(`  ${s.name.padEnd(10)} VA:${s.virtual_address}  Size:${s.size}  Entropy:${s.entropy}`);
      });
    }

    if (pe.imports?.length > 0) {
      sections.push(`\nIMPORTS (${pe.imports.length} DLLs):`);
      pe.imports.slice(0, 20).forEach((imp: any) => {
        const funcs = imp.functions.slice(0, 20).join(", ");
        sections.push(`  ${imp.dll}: ${funcs}`);
      });
    }

    if (pe.exports?.length > 0) {
      sections.push(`\nEXPORTS: ${pe.exports.slice(0, 50).join(", ")}`);
    }
  }

  // ELF structure
  if (dissection.elf_info && dissection.elf_info.type === "ELF") {
    sections.push(`\n═══ ELF STRUCTURE ═══`);
    sections.push(dissection.elf_info.readelf_headers || "");
    sections.push(dissection.elf_info.readelf_sections || "");
    if (dissection.elf_info.readelf_symbols) {
      sections.push(`\nSYMBOLS (first 3000 chars):`);
      sections.push(dissection.elf_info.readelf_symbols.substring(0, 3000));
    }
  }

  // PyInstaller / Python decompilation
  if (dissection.pyinstaller?.is_pyinstaller) {
    const py = dissection.pyinstaller;
    sections.push(`\n═══ PYTHON APPLICATION (PyInstaller) ═══`);
    sections.push(`Embedded modules: ${py.modules?.length || 0}`);
    if (py.modules?.length > 0) {
      sections.push(`Module list: ${py.modules.slice(0, 100).join(", ")}`);
    }

    if (py.decompiled_sources?.length > 0) {
      sections.push(`\nDECOMPILED PYTHON SOURCE CODE:`);
      py.decompiled_sources.forEach((src: any) => {
        sections.push(`\n--- MODULE: ${src.module} ---`);
        sections.push(src.source.substring(0, 6000));
      });
    }

    if (py.interesting_code?.length > 0) {
      sections.push(`\nAUTOMOTIVE-RELEVANT CODE SNIPPETS:`);
      py.interesting_code.forEach((hit: any) => {
        sections.push(`\n[${hit.module}] keyword: "${hit.keyword}"`);
        sections.push(hit.context);
      });
    }
  }

  // Disassembly sample
  if (dissection.disassembly_sample) {
    sections.push(`\n═══ DISASSEMBLY SAMPLE ═══`);
    sections.push(dissection.disassembly_sample.substring(0, 5000));
  }

  // Automotive patterns
  const auto = dissection.automotive_patterns;
  if (auto) {
    sections.push(`\n═══ AUTOMOTIVE PATTERN SCAN ═══`);

    if (auto.can_ids?.length > 0) {
      sections.push(`\nCAN IDs found (${auto.can_ids.length}):`);
      auto.can_ids.slice(0, 30).forEach((c: any) => {
        sections.push(`  ${c.value} @ offset ${c.offset}`);
      });
    }

    if (auto.security_access?.length > 0) {
      sections.push(`\nSECURITY ACCESS (0x27) sequences found (${auto.security_access.length}):`);
      auto.security_access.slice(0, 20).forEach((s: any) => {
        sections.push(`  Level ${s.level} @ ${s.offset}: ${s.context}`);
      });
    }

    if (auto.uds_services?.length > 0) {
      sections.push(`\nUDS SERVICE BYTES found (${auto.uds_services.length}):`);
      auto.uds_services.slice(0, 30).forEach((u: any) => {
        sections.push(`  ${u.name} (${u.service}) @ ${u.offset}: ${u.context}`);
      });
    }

    if (auto.crc_polynomials?.length > 0) {
      sections.push(`\nCRC POLYNOMIALS found:`);
      auto.crc_polynomials.forEach((c: any) => {
        sections.push(`  ${c.name} @ ${c.offset}`);
      });
    }

    if (auto.vin_patterns?.length > 0) {
      sections.push(`\nVIN PATTERNS found:`);
      auto.vin_patterns.forEach((v: any) => {
        sections.push(`  ${v.vin} @ ${v.offset}`);
      });
    }

    if (auto.pin_patterns?.length > 0) {
      sections.push(`\nPIN PATTERNS (4-5 digit) found:`);
      auto.pin_patterns.slice(0, 20).forEach((p: any) => {
        sections.push(`  ${p.value} @ ${p.offset}`);
      });
    }

    if (auto.gpec_patterns?.length > 0) {
      sections.push(`\nGPEC MAGIC BYTES found:`);
      auto.gpec_patterns.forEach((g: any) => {
        sections.push(`  ${g.marker} @ ${g.offset}: ${g.context}`);
      });
    }
  }

  // Interesting strings
  if (dissection.interesting_strings?.length > 0) {
    sections.push(`\n═══ AUTOMOTIVE-RELEVANT STRINGS (${dissection.interesting_strings.length}) ═══`);
    dissection.interesting_strings.slice(0, 200).forEach((s: any) => {
      sections.push(`  [${s.encoding}] @ ${s.offset}: "${s.value}"`);
    });
  }

  // Hex chunks
  if (dissection.hex_chunks?.length > 0) {
    sections.push(`\n═══ ANNOTATED HEX DUMP ═══`);
    dissection.hex_chunks.forEach((chunk: any) => {
      sections.push(`\n--- REGION: ${chunk.region} (${chunk.offset_start} - ${chunk.offset_end}) ---`);
      sections.push(chunk.hex);
    });
  }

  return sections.join("\n");
}

function extractHexPreview(buffer: Buffer, maxBytes = 512): string {
  const lines: string[] = [];
  const limit = Math.min(buffer.length, maxBytes);

  for (let i = 0; i < limit; i += 16) {
    const offset = i.toString(16).padStart(8, "0");
    const hex: string[] = [];
    const ascii: string[] = [];

    for (let j = 0; j < 16 && i + j < limit; j++) {
      const byte = buffer[i + j];
      hex.push(byte.toString(16).padStart(2, "0"));
      ascii.push(byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".");
    }

    lines.push(`${offset}  ${hex.join(" ").padEnd(48)}  |${ascii.join("")}|`);
  }

  return lines.join("\n");
}

function detectFileType(buffer: Buffer, filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() || "";

  if (buffer[0] === 0x4D && buffer[1] === 0x5A) return "PE (Windows Executable)";
  if (buffer[0] === 0x7F && buffer[1] === 0x45 && buffer[2] === 0x4C && buffer[3] === 0x46) return "ELF Binary";
  if (buffer[0] === 0x50 && buffer[1] === 0x4B) return "ZIP Archive";
  if (buffer[0] === 0x1F && buffer[1] === 0x8B) return "GZIP Archive";

  const extMap: Record<string, string> = {
    exe: "PE (Windows Executable)",
    dll: "PE (Dynamic Link Library)",
    bin: "Raw Binary / Firmware",
    eeprom: "EEPROM Dump",
    hex: "Intel HEX",
    srec: "Motorola S-Record",
    elf: "ELF Binary",
    so: "Shared Object",
    sys: "Windows Driver",
    fw: "Firmware Image",
    rom: "ROM Image",
    flash: "Flash Dump",
    img: "Disk/Flash Image",
  };

  return extMap[ext] || "Unknown Binary";
}

function findCryptoConstants(buffer: Buffer): { name: string; offset: string; value: string }[] {
  const constants: { name: string; offset: string; value: string }[] = [];

  const patterns: { name: string; bytes: number[]; value: string }[] = [
    { name: "AES S-Box", bytes: [0x63, 0x7C, 0x77, 0x7B, 0xF2, 0x6B, 0x6F, 0xC5], value: "63 7C 77 7B F2 6B 6F C5..." },
    { name: "SHA-256 Init H0", bytes: [0x6A, 0x09, 0xE6, 0x67], value: "6A09E667" },
    { name: "CRC-32 Polynomial", bytes: [0x04, 0xC1, 0x1D, 0xB7], value: "04C11DB7" },
    { name: "XTEA Delta (9E3779B9)", bytes: [0x9E, 0x37, 0x79, 0xB9], value: "9E3779B9" },
    { name: "TEA Delta (C6EF3720)", bytes: [0xC6, 0xEF, 0x37, 0x20], value: "C6EF3720" },
    { name: "CRC-16 CCITT Poly", bytes: [0x10, 0x21], value: "1021" },
    { name: "CRC-32C (Castagnoli)", bytes: [0x1E, 0xDC, 0x6F, 0x41], value: "1EDC6F41" },
    { name: "MD5 Init A", bytes: [0x01, 0x23, 0x45, 0x67], value: "01234567" },
    { name: "FCA RH850 Seed Constant", bytes: [0x17, 0x10, 0x68, 0x00], value: "171068" },
    { name: "SKIM Magic Byte", bytes: [0x96], value: "0x96 (GPEC unlock)" },
  ];

  for (const pattern of patterns) {
    const needle = Buffer.from(pattern.bytes);
    const idx = buffer.indexOf(needle);
    if (idx !== -1) {
      constants.push({ name: pattern.name, offset: `0x${idx.toString(16).toUpperCase()}`, value: pattern.value });
    }
  }

  return constants;
}

// Attempt to repair truncated JSON by extracting top-level fields that were fully parsed
function repairJSON(raw: string): any {
  try { return JSON.parse(raw); } catch {}

  const result: any = { summary: "", algorithms: [], seedKeys: [], canAddresses: [], checksums: [], memoryMaps: [], securityBytes: [], deepFindings: [] };

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

  if (!result.summary) result.summary = "Analysis partially complete (response truncated)";
  return result;
}

async function callLLM(
  messages: { role: string; content: string }[],
  retries = 3
): Promise<string> {
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
          response_format: { type: "json_object" },
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
        console.warn(`LLM API ${response.status} on attempt ${attempt}, retrying in ${2000 * attempt}ms...`);
        await new Promise(r => setTimeout(r, 2000 * attempt));
        continue;
      }
      throw new Error(`LLM API error ${response.status}: ${errText.substring(0, 200)}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || "{}";
  }

  throw new Error("LLM API failed after all retries");
}

const JSON_SCHEMA = `{
  "summary": "2-3 sentence overview: module type, key findings, programming relevance",
  "algorithms": [{"name": "string", "type": "string", "description": "1 sentence", "constants": ["0x..."], "pseudocode": "3 lines max"}],
  "seedKeys": [{"module": "string", "level": "string", "algorithm": "string", "constants": ["0x..."], "description": "1 sentence with offset"}],
  "canAddresses": [{"module": "string", "txId": "0x###", "rxId": "0x###", "description": "1 sentence"}],
  "checksums": [{"type": "string", "polynomial": "string", "offset": "0x###", "description": "1 sentence"}],
  "memoryMaps": [{"region": "string", "startOffset": "0x###", "endOffset": "0x###", "description": "1 sentence", "contents": "1 sentence"}],
  "securityBytes": [{"module": "string", "offset": "0x###", "length": "string", "description": "1 sentence", "purpose": "1 sentence"}],
  "deepFindings": [{"category": "string", "title": "string", "offset": "0x###", "details": "2 sentences max", "programmingRelevance": "1 sentence"}]
}`;

// ─── FIRST-PASS ANALYSIS ────────────────────────────────────────────────────
export async function analyzeFile(
  file: Express.Multer.File,
  userInstructions?: string
): Promise<AnalysisResult> {
  const id = nanoid(12);
  const buffer = file.buffer;
  const fileType = detectFileType(buffer, file.originalname);
  const cryptoHits = findCryptoConstants(buffer);

  const result: AnalysisResult = {
    id,
    filename: file.originalname,
    fileSize: buffer.length,
    fileType,
    timestamp: Date.now(),
    status: "analyzing",
    analysisPass: 1,
    findings: {
      summary: "",
      algorithms: [],
      seedKeys: [],
      canAddresses: [],
      checksums: [],
      memoryMaps: [],
      strings: [],
      cryptoConstants: [],
      securityBytes: [],
      deepFindings: [],
    },
    rawHex: extractHexPreview(buffer, 512),
    analysisMode: "hex_preview",
  };

  // ─── Run deep Python dissector ─────────────────────────────────────────────
  console.log(`[analyze] Running deep dissector on ${file.originalname} (${buffer.length} bytes)`);
  const dissection = await runDissector(buffer, file.originalname);

  let dissectionContext: string;
  let dissectionReport: string;

  if (dissection) {
    result.analysisMode = "deep_dissection";
    dissectionContext = buildDissectionContext(dissection, file.originalname);
    dissectionReport = [
      `Deep dissection complete.`,
      dissection.pyinstaller?.is_pyinstaller ? `PyInstaller app detected — ${dissection.pyinstaller.decompiled_sources?.length || 0} modules decompiled.` : "",
      dissection.pe_info?.type === "PE" ? `PE: ${dissection.pe_info.imports?.length || 0} imported DLLs, ${dissection.pe_info.sections?.length || 0} sections.` : "",
      `${dissection.interesting_strings?.length || 0} automotive-relevant strings.`,
      `${dissection.automotive_patterns?.can_ids?.length || 0} CAN IDs, ${dissection.automotive_patterns?.security_access?.length || 0} security access sequences.`,
    ].filter(Boolean).join(" ");
    result.dissectionReport = dissectionReport;

    // Populate strings from dissection
    result.findings.strings = (dissection.interesting_strings || []).slice(0, 300).map((s: any) => ({
      value: s.value,
      offset: s.offset,
      category: "automotive",
    }));
  } else {
    // Fallback to basic hex preview
    dissectionContext = `HEX DUMP (header / middle / tail):\n\`\`\`\n${extractHexPreview(buffer, 768)}\n\`\`\``;
    dissectionReport = "Static hex analysis only (dissector unavailable).";
    result.dissectionReport = dissectionReport;
  }

  result.findings.cryptoConstants = cryptoHits.map(c => ({
    ...c,
    algorithm: c.name.split(" ")[0],
  }));

  // ─── Build system prompt ───────────────────────────────────────────────────
  const instructions = userInstructions?.trim() ||
    `FULL DIAGNOSTIC DEEP-DIVE — NO INSTRUCTIONS REQUIRED. Analyze this automotive binary completely:
1. MODULE IDENTIFICATION — What module is this (BCM, PCM, RFHUB, TCM, etc.), part numbers, SW/HW versions, platform
2. CAN BUS IDs — All diagnostic IDs (0x7DF, 0x7E0, 0x640, 0x740, etc.), module associations, protocol type
3. UDS SERVICES — All diagnostic services present, DID tables, session types, security access levels and seed lengths
4. CHECKSUMS/CRCs — Algorithm, polynomial, init value, protected region, storage offset, verification pass/fail
5. CRYPTO CONSTANTS — AES S-boxes, XTEA deltas (0x9E3779B9), SHA/MD5 constants — identify which algorithm and what it protects
6. MEMORY MAP — Complete region breakdown: EEPROM layout, flash sectors, calibration areas, DTC storage, VIN storage
7. DTC STORAGE — Fault code table location, stored DTCs with status bytes, max DTC count
8. CALIBRATION DATA — Calibration regions, parameter tables, configuration flags, feature enables
9. VIN STORAGE — VIN offset(s), primary and backup copies, encoding format
10. BOOT MODE FLAGS — Boot/application mode indicators, programming counters, flash validity markers
11. FLASH LAYOUT — Bootloader, application, calibration, data regions with boundaries and sector sizes
12. DATA STRUCTURES — Repeating patterns, struct layouts, field-level documentation
Be thorough and precise. Every hex offset must be exact.`;

  let systemPrompt: string;
  try {
    systemPrompt = await buildEnrichedSystemPrompt(instructions);
  } catch {
    systemPrompt = buildFallbackSystemPrompt(instructions);
  }

  systemPrompt += `\n\nRespond ONLY with valid JSON matching this exact schema:\n${JSON_SCHEMA}`;

  // ─── Build user message with full dissection context ──────────────────────
  const userMessage = `ANALYZE THIS BINARY — PASS 1 (FULL DEEP DIVE)

File: ${file.originalname}
Type: ${fileType}
Size: ${buffer.length} bytes (${(buffer.length / 1024).toFixed(1)} KB)
Dissection Mode: ${result.analysisMode}
${dissectionReport}

CRYPTO CONSTANTS DETECTED (static pre-scan):
${cryptoHits.length > 0 ? cryptoHits.map(c => `  • ${c.name} @ ${c.offset} = ${c.value}`).join("\n") : "  None detected"}

${dissectionContext}

MISSION: You have the FULL binary intelligence above — decompiled source code, PE structure, imports, strings, automotive patterns, hex dump. Produce a complete diagnostic analysis: module identification, memory map, CAN bus layout, UDS service catalog, DTC storage, calibration regions, checksum verification, and firmware structure. Be thorough and precise. Every hex offset must be exact.`;

  try {
    const llmResponse = await callLLM([
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ]);

    const parsed = repairJSON(llmResponse);
    result.findings.summary = parsed.summary || "Analysis complete";
    result.findings.algorithms = parsed.algorithms || [];
    result.findings.seedKeys = parsed.seedKeys || [];
    result.findings.canAddresses = parsed.canAddresses || [];
    result.findings.checksums = parsed.checksums || [];
    result.findings.memoryMaps = parsed.memoryMaps || [];
    result.findings.securityBytes = parsed.securityBytes || [];
    result.findings.deepFindings = parsed.deepFindings || [];
    result.status = "complete";
  } catch (error: any) {
    console.error("AI analysis error:", error.message);
    result.status = "complete";
    result.findings.summary = `Deep dissection complete. File: ${fileType}, ${buffer.length} bytes. ${dissectionReport} AI synthesis error: ${error.message.substring(0, 100)}`;
  }

  return result;
}

// ─── RE-ANALYSIS (CHAINED DEEPER PASS) ──────────────────────────────────────
export async function reanalyzeFile(
  buffer: Buffer,
  filename: string,
  previousResult: any,
  userInstructions: string,
  passNumber: number
): Promise<AnalysisResult> {
  const id = nanoid(12);
  const fileType = detectFileType(buffer, filename);
  const cryptoHits = findCryptoConstants(buffer);

  const result: AnalysisResult = {
    id,
    filename,
    fileSize: buffer.length,
    fileType,
    timestamp: Date.now(),
    status: "analyzing",
    analysisPass: passNumber,
    findings: {
      summary: "",
      algorithms: [],
      seedKeys: [],
      canAddresses: [],
      checksums: [],
      memoryMaps: [],
      strings: previousResult?.findings?.strings || [],
      cryptoConstants: cryptoHits.map(c => ({ ...c, algorithm: c.name.split(" ")[0] })),
      securityBytes: [],
      deepFindings: [],
    },
    rawHex: extractHexPreview(buffer, 512),
    analysisMode: "hex_preview",
  };

  // Run deep dissector for re-analysis too
  console.log(`[analyze] Running deep dissector for re-analysis pass ${passNumber} on ${filename}`);
  const dissection = await runDissector(buffer, filename);

  let dissectionContext: string;
  let dissectionReport: string;

  if (dissection) {
    result.analysisMode = "deep_dissection";
    dissectionContext = buildDissectionContext(dissection, filename);
    dissectionReport = [
      `Deep dissection complete (Pass ${passNumber}).`,
      dissection.pyinstaller?.is_pyinstaller ? `PyInstaller app — ${dissection.pyinstaller.decompiled_sources?.length || 0} modules decompiled.` : "",
      `${dissection.interesting_strings?.length || 0} automotive strings, ${dissection.automotive_patterns?.can_ids?.length || 0} CAN IDs.`,
    ].filter(Boolean).join(" ");
    result.dissectionReport = dissectionReport;
  } else {
    dissectionContext = `HEX DUMP:\n\`\`\`\n${extractHexPreview(buffer, 768)}\n\`\`\``;
    dissectionReport = "Static hex analysis only.";
    result.dissectionReport = dissectionReport;
  }

  // Build prior findings summary
  const prior = previousResult?.findings || {};
  const priorSummary = [
    prior.summary ? `PRIOR SUMMARY: ${prior.summary}` : "",
    prior.algorithms?.length > 0
      ? `ALGORITHMS FOUND (${prior.algorithms.length}): ${prior.algorithms.map((a: any) => `${a.name} (${a.type})`).join(", ")}`
      : "ALGORITHMS: None found yet",
    prior.seedKeys?.length > 0
      ? `SEED KEYS (${prior.seedKeys.length}): ${prior.seedKeys.map((s: any) => `${s.module} ${s.level}`).join(", ")}`
      : "SEED KEYS: None found yet",
    prior.canAddresses?.length > 0
      ? `CAN ADDRESSES (${prior.canAddresses.length}): ${prior.canAddresses.map((c: any) => `${c.module} TX:${c.txId} RX:${c.rxId}`).join(", ")}`
      : "CAN ADDRESSES: None found yet",
    prior.securityBytes?.length > 0
      ? `SECURITY BYTES (${prior.securityBytes.length}): ${prior.securityBytes.map((s: any) => `${s.module} @ ${s.offset}`).join(", ")}`
      : "SECURITY BYTES: None found yet",
    prior.checksums?.length > 0
      ? `CHECKSUMS (${prior.checksums.length}): ${prior.checksums.map((c: any) => `${c.type} @ ${c.offset}`).join(", ")}`
      : "CHECKSUMS: None found yet",
  ].filter(Boolean).join("\n");

  let systemPrompt: string;
  try {
    systemPrompt = await buildReanalysisPrompt(userInstructions, priorSummary, passNumber);
  } catch {
    systemPrompt = buildFallbackReanalysisPrompt(userInstructions, priorSummary, passNumber);
  }

  systemPrompt += `\n\nRespond ONLY with valid JSON matching this exact schema:\n${JSON_SCHEMA}`;

  const reanalysisMessage = `ANALYZE THIS BINARY — PASS ${passNumber} (DEEPER TARGETED DIVE)

File: ${filename}
Type: ${fileType}
Size: ${buffer.length} bytes (${(buffer.length / 1024).toFixed(1)} KB)
${dissectionReport}

═══════════════════════════════════════════
WHAT PASS ${passNumber - 1} ALREADY FOUND:
═══════════════════════════════════════════
${priorSummary}

═══════════════════════════════════════════
USER INSTRUCTIONS FOR THIS PASS:
═══════════════════════════════════════════
${userInstructions}

═══════════════════════════════════════════
FULL BINARY INTELLIGENCE:
═══════════════════════════════════════════
${dissectionContext}

MISSION: You already have the surface findings from Pass ${passNumber - 1}. Now go DEEPER. You have the full binary intelligence above. Find what was missed. Follow the user's specific instructions. Every algorithm needs full parameters. Every data region needs its exact offset and purpose. Be precise and thorough.`;

  try {
    const llmResponse = await callLLM([
      { role: "system", content: systemPrompt },
      { role: "user", content: reanalysisMessage },
    ]);

    const parsed = repairJSON(llmResponse);

    const mergeArrays = (prior: any[], current: any[]) => {
      const combined = [...(prior || []), ...(current || [])];
      const seen = new Set<string>();
      return combined.filter(item => {
        const key = `${item.name || item.module || item.type || ""}:${item.offset || ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };

    result.findings.summary = parsed.summary || prior.summary || "Re-analysis complete";
    result.findings.algorithms = mergeArrays(prior.algorithms, parsed.algorithms);
    result.findings.seedKeys = mergeArrays(prior.seedKeys, parsed.seedKeys);
    result.findings.canAddresses = mergeArrays(prior.canAddresses, parsed.canAddresses);
    result.findings.checksums = mergeArrays(prior.checksums, parsed.checksums);
    result.findings.memoryMaps = mergeArrays(prior.memoryMaps, parsed.memoryMaps);
    result.findings.securityBytes = mergeArrays(prior.securityBytes, parsed.securityBytes);
    result.findings.deepFindings = mergeArrays(prior.deepFindings, parsed.deepFindings);
    result.status = "complete";
  } catch (error: any) {
    console.error("Re-analysis error:", error.message);
    result.status = "complete";
    result.findings = { ...prior, summary: `Re-analysis pass ${passNumber} failed: ${error.message}. Prior findings preserved.` };
  }

  return result;
}

// ─── FALLBACK PROMPTS (when DB is unavailable) ───────────────────────────────
function buildFallbackSystemPrompt(instructions: string): string {
  return `You are an expert automotive firmware analyst — 40 years of experience with FCA/Stellantis module firmware, CAN bus protocols, UDS diagnostics, EEPROM layouts, and embedded systems. You produce comprehensive diagnostic documentation for professional automotive technicians.

## USER INSTRUCTIONS
${instructions}

## YOUR MANDATE
Perform a thorough, precise firmware analysis. Document EVERYTHING you find:
1. **Module Identification** — What module is this, part numbers, SW/HW versions, platform generation
2. **CAN Bus Addresses** — All diagnostic IDs with module associations and protocol type
3. **UDS Services** — Service catalog, DID table, session types, security access levels and seed lengths
4. **Checksums/CRCs** — Algorithm type, polynomial, init value, protected region, storage offset, verification pass/fail
5. **Crypto Constants** — AES S-boxes, XTEA deltas, SHA/MD5 constants — identify algorithm and what it protects
6. **Memory Maps** — Full region breakdown: EEPROM layout, flash sectors, calibration areas, DTC storage, VIN storage
7. **DTC Storage** — Fault code table, stored DTCs with status bytes, max count
8. **Calibration Data** — Calibration regions, parameter tables, configuration flags
9. **VIN Storage** — All VIN copies with offsets and encoding
10. **Boot Flags** — Boot/app mode indicators, programming counters, flash validity markers
11. **Flash Layout** — Bootloader, application, calibration, data regions with boundaries
12. **Data Structures** — Repeating patterns, struct layouts, field-level documentation

## DEPTH REQUIREMENT
Surface scans are unacceptable. Every finding needs exact hex offsets. Every checksum should be verified if possible. Every data region needs its boundaries and contents documented.`;
}

function buildFallbackReanalysisPrompt(instructions: string, priorSummary: string, passNumber: number): string {
  return `You are an expert automotive firmware analyst performing PASS ${passNumber} of a deep binary analysis.

## PRIOR FINDINGS (from Pass ${passNumber - 1})
${priorSummary}

## USER INSTRUCTIONS FOR THIS PASS
${instructions}

## YOUR MANDATE — GO DEEPER
Pass ${passNumber - 1} found the surface-level data. Your job now is to find what was MISSED:
- Algorithms that were identified but not fully documented — complete their parameters now
- Memory regions that were found but not fully mapped — document every field
- CAN addresses that were partially identified — find the complete set
- DTC storage tables not yet fully decoded
- Calibration regions with undocumented parameters
- Any data structures not yet broken down to field level

Be thorough. This is Pass ${passNumber} — it must be deeper than Pass ${passNumber - 1}.`;
}
