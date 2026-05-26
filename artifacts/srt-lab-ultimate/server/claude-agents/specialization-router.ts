/**
 * SRT Lab — Agent Specialization Router
 *
 * Detects file type characteristics and routes only relevant agents.
 * Saves time and resources by not running irrelevant agents.
 *
 * Example:
 * - Automotive binary (.exe with UDS patterns) → all 5 agents
 * - Generic firmware (.bin with no automotive markers) → skip WRAITH
 * - Pure crypto binary → prioritize GHOST, PHANTOM, skip SPECTER
 * - Network protocol binary → prioritize SPECTER, SHADE
 */

import { execSync } from "child_process";
import * as fs from "fs";

// ─── File Characteristics ───────────────────────────────────────────────────

export interface FileProfile {
  filename: string;
  fileSize: number;
  fileType: string;           // PE32, ELF, firmware, etc.
  isAutomotive: boolean;      // Has CAN/UDS/OBD markers
  hasCrypto: boolean;         // Has crypto constants/patterns
  hasNetwork: boolean;        // Has network/protocol patterns
  hasHardware: boolean;       // Has hardware/EEPROM/memory patterns
  isPython: boolean;          // PyInstaller or Python bytecode
  isDotNet: boolean;          // .NET assembly
  isEmbedded: boolean;        // Embedded firmware (ARM, MIPS)
  confidence: number;         // How confident we are in classification
  markers: string[];          // What we found
}

// ─── Agent Relevance Scores ─────────────────────────────────────────────────

export interface AgentRelevance {
  agentId: string;
  codename: string;
  relevanceScore: number;     // 0-100, below 20 = skip
  reason: string;
}

// ─── Quick Profile Detection ────────────────────────────────────────────────

export function profileBinary(buffer: Buffer, filename: string): FileProfile {
  const markers: string[] = [];
  const profile: FileProfile = {
    filename,
    fileSize: buffer.length,
    fileType: "unknown",
    isAutomotive: false,
    hasCrypto: false,
    hasNetwork: false,
    hasHardware: false,
    isPython: false,
    isDotNet: false,
    isEmbedded: false,
    confidence: 0,
    markers,
  };

  // ── File Type Detection ──────────────────────────────────────────────────

  // SWF (Adobe Flash) — CWS=zlib compressed, FWS=uncompressed, ZWS=LZMA compressed
  // CDA.swf is a Chrysler Diagnostic Application with ActionScript crypto + CAN/diagnostic code
  const swfMagic = buffer.length >= 3 ? buffer.subarray(0, 3).toString('ascii') : '';
  if (swfMagic === 'CWS' || swfMagic === 'FWS' || swfMagic === 'ZWS') {
    profile.fileType = 'SWF';
    markers.push('SWF_MAGIC', `SWF_${swfMagic}`, 'ACTIONSCRIPT_BYTECODE');
    // Chrysler CDA.swf contains: AES crypto, security gateway unlock, CAN-FD settings, wiTECH engine
    profile.isAutomotive = true;
    profile.hasCrypto = true;
    profile.hasNetwork = true;   // CAN bus / diagnostic protocols
    profile.hasHardware = true;  // ECU / CAN hardware interfaces
    profile.confidence = 95;
  }
  // GZIP / TAR.GZ archive — activate ALL agents (contents unknown until extracted)
  else if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    profile.fileType = "GZIP_ARCHIVE";
    markers.push("GZIP_MAGIC", "ARCHIVE_CONTAINER");
    // Force all flags so every agent activates
    profile.isAutomotive = true;
    profile.hasCrypto = true;
    profile.hasNetwork = true;
    profile.hasHardware = true;
    profile.isEmbedded = true;
    profile.confidence = 100;
  }
  // ZIP archive — activate ALL agents
  else if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    profile.fileType = "ZIP_ARCHIVE";
    markers.push("ZIP_MAGIC", "ARCHIVE_CONTAINER");
    profile.isAutomotive = true;
    profile.hasCrypto = true;
    profile.hasNetwork = true;
    profile.hasHardware = true;
    profile.isEmbedded = true;
    profile.confidence = 100;
  }
  // PE32 (Windows executable)
  else if (buffer[0] === 0x4D && buffer[1] === 0x5A) {
    profile.fileType = "PE32";
    markers.push("PE32_HEADER");
  }
  // ELF (Linux/embedded)
  else if (buffer[0] === 0x7F && buffer[1] === 0x45 && buffer[2] === 0x4C && buffer[3] === 0x46) {
    profile.fileType = "ELF";
    markers.push("ELF_HEADER");
  }
  // Intel HEX
  else if (buffer[0] === 0x3A) {
    profile.fileType = "IHEX";
    markers.push("INTEL_HEX");
    profile.isEmbedded = true;
  }
  // Motorola S-Record
  else if (buffer[0] === 0x53 && (buffer[1] >= 0x30 && buffer[1] <= 0x39)) {
    profile.fileType = "SREC";
    markers.push("MOTOROLA_SREC");
    profile.isEmbedded = true;
  }

  // ── Content Analysis (quick string scan) ─────────────────────────────────

  // Extract printable strings (quick scan of first 2MB)
  const scanSize = Math.min(buffer.length, 2 * 1024 * 1024);
  const scanBuffer = buffer.subarray(0, scanSize);
  const text = scanBuffer.toString("latin1");

  // Automotive markers
  const automotivePatterns = [
    /UDS/i, /\bCAN\b/, /\bOBD/i, /\bJ1939/i, /\bISO.?14229/i,
    /\bISO.?15765/i, /\bDiagnostic/i, /\bECU\b/i, /\bVIN\b/,
    /\bDTC\b/, /SecurityAccess/i, /RoutineControl/i, /ReadDataByIdentifier/i,
    /WriteDataByIdentifier/i, /RequestDownload/i, /TransferData/i,
    /\bCANoe\b/i, /\bVector\b/i, /\bKWP2000\b/i, /\bDoIP\b/i,
    /\bFCA\b/, /\bGM\b.*\bmodule\b/i, /\bBMW\b/i, /\bFord\b/i,
    /\bChevy\b/i, /\bDodge\b/i, /\bJeep\b/i, /\bChrysler\b/i,
  ];

  let autoCount = 0;
  for (const pattern of automotivePatterns) {
    if (pattern.test(text)) {
      autoCount++;
      markers.push(`AUTO:${pattern.source.slice(0, 20)}`);
    }
  }
  if (autoCount >= 3) {
    profile.isAutomotive = true;
    profile.confidence += 30;
  }

  // Crypto markers
  const cryptoPatterns = [
    /AES/i, /RSA/i, /\bDES\b/, /SHA.?256/i, /MD5/i, /HMAC/i,
    /\bCRC/i, /encrypt/i, /decrypt/i, /cipher/i, /\bXOR\b/i,
    /private.?key/i, /public.?key/i, /certificate/i, /\bPKCS/i,
  ];

  let cryptoCount = 0;
  for (const pattern of cryptoPatterns) {
    if (pattern.test(text)) {
      cryptoCount++;
      markers.push(`CRYPTO:${pattern.source.slice(0, 15)}`);
    }
  }
  if (cryptoCount >= 2) {
    profile.hasCrypto = true;
    profile.confidence += 20;
  }

  // Network markers
  const networkPatterns = [
    /HTTP/i, /TCP/i, /UDP/i, /socket/i, /\bIP\b/, /DNS/i,
    /TLS/i, /SSL/i, /WebSocket/i, /MQTT/i, /REST/i, /API/i,
    /endpoint/i, /server/i, /client/i, /port\s*\d+/i,
  ];

  let netCount = 0;
  for (const pattern of networkPatterns) {
    if (pattern.test(text)) {
      netCount++;
      markers.push(`NET:${pattern.source.slice(0, 12)}`);
    }
  }
  if (netCount >= 3) {
    profile.hasNetwork = true;
    profile.confidence += 15;
  }

  // Hardware markers
  const hardwarePatterns = [
    /EEPROM/i, /\bFlash\b/i, /\bSPI\b/, /\bI2C\b/, /\bUART\b/,
    /\bGPIO\b/, /register/i, /firmware/i, /bootloader/i,
    /\bRAM\b/, /\bROM\b/, /memory.?map/i, /calibration/i,
  ];

  let hwCount = 0;
  for (const pattern of hardwarePatterns) {
    if (pattern.test(text)) {
      hwCount++;
      markers.push(`HW:${pattern.source.slice(0, 12)}`);
    }
  }
  if (hwCount >= 2) {
    profile.hasHardware = true;
    profile.confidence += 15;
  }

  // Python detection
  if (text.includes("PYZ") || text.includes("pyimod") || text.includes("_MEIPASS") ||
      text.includes("python3") || text.includes("importlib")) {
    profile.isPython = true;
    markers.push("PYTHON_EMBEDDED");
    profile.confidence += 10;
  }

  // .NET detection
  if (text.includes("mscoree.dll") || text.includes("System.") || text.includes("mscorlib")) {
    profile.isDotNet = true;
    markers.push("DOTNET_ASSEMBLY");
    profile.confidence += 10;
  }

  // Embedded firmware detection
  if (profile.fileType === "ELF" || profile.isEmbedded) {
    if (text.includes("ARM") || text.includes("Cortex") || text.includes("MIPS") || text.includes("Thumb")) {
      profile.isEmbedded = true;
      markers.push("EMBEDDED_FW");
      profile.confidence += 15;
    }
  }

  profile.confidence = Math.min(profile.confidence, 100);
  return profile;
}

// ─── Route Agents Based on Profile ──────────────────────────────────────────

export function routeAgents(profile: FileProfile): AgentRelevance[] {
  const relevance: AgentRelevance[] = [];

  // GHOST — Pattern Recognition & Crypto Analysis
  // Always relevant (pattern recognition is universal)
  let ghostScore = 50; // Base relevance
  if (profile.hasCrypto) ghostScore += 40;
  if (profile.isAutomotive) ghostScore += 10;
  relevance.push({
    agentId: "ghost",
    codename: "GHOST",
    relevanceScore: Math.min(ghostScore, 100),
    reason: profile.hasCrypto
      ? "Crypto patterns detected — GHOST will identify algorithms and extract keys"
      : "Base pattern recognition — GHOST scans for any crypto/encoding patterns",
  });

  // PHANTOM — Control Flow & Disassembly
  // Always relevant for executables
  let phantomScore = 40;
  if (profile.fileType === "PE32" || profile.fileType === "ELF") phantomScore += 30;
  if (profile.hasCrypto) phantomScore += 15;
  if (profile.isAutomotive) phantomScore += 15;
  relevance.push({
    agentId: "phantom",
    codename: "PHANTOM",
    relevanceScore: Math.min(phantomScore, 100),
    reason: (profile.fileType === "PE32" || profile.fileType === "ELF")
      ? "Executable detected — PHANTOM will disassemble and trace control flow"
      : "Non-executable format — PHANTOM has limited utility",
  });

  // SPECTER — Protocol & Communication Analysis
  let specterScore = 30;
  if (profile.isAutomotive) specterScore += 40; // CAN/UDS protocols
  if (profile.hasNetwork) specterScore += 30;
  relevance.push({
    agentId: "specter",
    codename: "SPECTER",
    relevanceScore: Math.min(specterScore, 100),
    reason: profile.isAutomotive
      ? "Automotive markers detected — SPECTER will decode CAN/UDS protocol structures"
      : profile.hasNetwork
        ? "Network patterns found — SPECTER will analyze communication protocols"
        : "No protocol markers — SPECTER may have limited findings",
  });

  // WRAITH — Hardware & Memory Analysis
  let wraithScore = 25;
  if (profile.isAutomotive) wraithScore += 35;
  if (profile.hasHardware) wraithScore += 35;
  if (profile.isEmbedded) wraithScore += 30;
  relevance.push({
    agentId: "wraith",
    codename: "WRAITH",
    relevanceScore: Math.min(wraithScore, 100),
    reason: profile.isAutomotive || profile.hasHardware
      ? "Hardware/automotive markers — WRAITH will map memory regions and EEPROM structures"
      : profile.isEmbedded
        ? "Embedded firmware — WRAITH will analyze hardware interfaces"
        : "No hardware markers — WRAITH will be skipped to save resources",
  });

  // SHADE — Information Leakage & Intelligence Extraction
  // Always relevant (looks for strings, secrets, endpoints)
  let shadeScore = 60; // High base — always useful
  if (profile.isPython) shadeScore += 20;
  if (profile.hasNetwork) shadeScore += 15;
  if (profile.isAutomotive) shadeScore += 5;
  relevance.push({
    agentId: "shade",
    codename: "SHADE",
    relevanceScore: Math.min(shadeScore, 100),
    reason: profile.isPython
      ? "Python binary — SHADE will extract embedded source and secrets"
      : "SHADE will extract strings, endpoints, credentials, and intelligence",
  });

  return relevance;
}

// ─── Filter Agents by Relevance Threshold ───────────────────────────────────

export function getActiveAgents(
  profile: FileProfile,
  threshold: number = 25
): { activeAgents: string[]; skippedAgents: AgentRelevance[]; routing: AgentRelevance[] } {
  const routing = routeAgents(profile);
  const activeAgents = routing
    .filter(r => r.relevanceScore >= threshold)
    .map(r => r.agentId);
  const skippedAgents = routing.filter(r => r.relevanceScore < threshold);

  return { activeAgents, skippedAgents, routing };
}
