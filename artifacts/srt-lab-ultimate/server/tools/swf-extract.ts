/**
 * SWF Extract Tool — Decompresses and analyzes Adobe Flash/Flex SWF files.
 * Extracts class names, security strings, diagnostic keywords, URLs, hex constants,
 * and ActionScript Bytecode (ABC) tag headers.
 *
 * Output is capped at ~18,000 chars to keep LLM context manageable.
 * Priority order: Chrysler/DCC classes > security > diagnostic > URLs > hex > methods > other
 */
import * as fsSync from "fs";
import * as zlib from "zlib";
import { promisify } from "util";
import type { ToolDefinition } from "./index.js";

const inflate = promisify(zlib.inflate);

const MAX_OUTPUT_CHARS = 18_000;

export const swfExtractTool: ToolDefinition = {
  name: "swf_extract",
  description:
    "Decompress and analyze a SWF (Adobe Flash/Flex) file. Detects SWF signature (FWS/CWS/ZWS), " +
    "decompresses zlib payload, extracts all readable strings, class names, ActionScript identifiers, " +
    "URLs, security-related strings, diagnostic/automotive keywords, hex constants, and embedded ABC " +
    "(ActionScript Bytecode) tag headers. Returns a structured dump of everything found in the SWF. " +
    "Use this as the FIRST tool when the file is identified as a .swf file.",
  inputSchema: {
    type: "object",
    properties: {
      focus: {
        type: "string",
        description: "Optional focus area: 'crypto', 'diagnostic', 'classes', 'all' (default: 'all')",
        enum: ["crypto", "diagnostic", "classes", "all"],
      },
    },
    required: [],
  },
  call: async (args: Record<string, unknown>, filePath: string): Promise<string> => {
    const focus = typeof args.focus === "string" ? args.focus : "all";
    const lines: string[] = [];

    const raw = fsSync.readFileSync(filePath);

    // Validate SWF signature
    const sig = raw.slice(0, 3).toString("ascii");
    if (sig !== "FWS" && sig !== "CWS" && sig !== "ZWS") {
      return `Not a SWF file. Magic bytes: ${raw.slice(0, 4).toString("hex").toUpperCase()} (${raw.slice(0, 3).toString("ascii")})`;
    }

    const version = raw[3];
    const fileLen = raw.readUInt32LE(4);
    const compressed = sig === "CWS" ? "zlib" : sig === "ZWS" ? "LZMA" : "none";
    lines.push(`SWF Header: signature=${sig} version=${version} fileLength=${fileLen} compression=${compressed}`);
    lines.push(`Raw file size on disk: ${raw.length} bytes`);

    // Decompress payload
    let payload: Buffer;
    if (sig === "CWS") {
      try {
        payload = (await inflate(raw.slice(8))) as Buffer;
        lines.push(
          `Decompressed payload: ${payload.length} bytes (ratio ${(payload.length / (raw.length - 8)).toFixed(2)}x)`
        );
      } catch (e) {
        return `SWF zlib decompression failed: ${e}`;
      }
    } else if (sig === "ZWS") {
      payload = raw.slice(12);
      lines.push(`LZMA-compressed SWF — extracting strings from compressed data (reduced accuracy)`);
    } else {
      payload = raw.slice(8);
      lines.push(`Uncompressed SWF payload: ${payload.length} bytes`);
    }

    // ── Extract all printable ASCII strings (length >= 5) ──────────────────
    const strings: string[] = [];
    let i = 0;
    while (i < payload.length) {
      let j = i;
      while (j < payload.length && payload[j] >= 0x20 && payload[j] < 0x7f) j++;
      if (j - i >= 5) {
        strings.push(payload.slice(i, j).toString("ascii"));
      }
      i = j + 1;
    }
    lines.push(`Total printable strings found: ${strings.length}`);

    // ── Categorize strings — priority order ───────────────────────────────
    // 1. Chrysler/DCC/automotive vendor class names (highest priority)
    const chryslerClasses = strings.filter((s) =>
      /^(com\.chrysler|com\.dcctools|com\.fca|com\.stellantis|com\.mopar|com\.witech)\./i.test(s) &&
      s.length < 200
    );
    // 2. All other package/class names
    const otherClasses = strings.filter((s) =>
      /^(com|net|org|flash|mx|spark|adobe)\./i.test(s) &&
      s.length < 200 &&
      !chryslerClasses.includes(s)
    );
    // 3. URLs
    const urls = strings.filter((s) => /^https?:\/\//.test(s));
    // 4. Security/crypto strings
    const securityKeywords = strings.filter(
      (s) =>
        /seed|key|algorithm|security|access|unlock|skim|pin|fob|immobil|crypt|hash|aes|des|xor|crc|checksum|passw|secret|token|auth|credential/i.test(s) &&
        s.length >= 5 &&
        s.length < 300 &&
        !chryslerClasses.includes(s) &&
        !otherClasses.includes(s)
    );
    // 5. Diagnostic/automotive strings
    const diagnosticKeywords = strings.filter(
      (s) =>
        /uds|can\b|obd|dtc|vin|ecu|bcm|pcm|tcm|abs|rfhub|gpec|sgw|gateway|diagnostic|programming|flash|erase|download|upload|session|tester|service|module|calibrat|proxi|tracer|pid\b|dde\b|ada\b/i.test(s) &&
        s.length >= 4 &&
        s.length < 300 &&
        !chryslerClasses.includes(s) &&
        !otherClasses.includes(s) &&
        !securityKeywords.includes(s)
    );
    // 6. Hex constants
    const hexLike = strings.filter((s) => /^(0x)?[0-9A-Fa-f]{4,16}$/.test(s));
    // 7. camelCase method/variable names
    const methodNames = strings.filter(
      (s) =>
        /^[a-z][a-zA-Z0-9_]{4,}$/.test(s) &&
        /[A-Z]/.test(s) &&
        s.length < 80 &&
        !chryslerClasses.includes(s) &&
        !otherClasses.includes(s)
    );

    // ── Build output with char budget ─────────────────────────────────────
    let charBudget = MAX_OUTPUT_CHARS - lines.join("\n").length - 500; // reserve for header

    function addSection(title: string, items: string[], maxItems: number): void {
      if (items.length === 0) return;
      const show = Math.min(items.length, maxItems);
      const sectionLines = [`\n=== ${title} (${items.length} total, showing ${show}) ===`];
      let sectionChars = sectionLines[0].length;
      let shown = 0;
      for (const item of items.slice(0, show)) {
        const line = `  ${item}`;
        if (sectionChars + line.length > charBudget) break;
        sectionLines.push(line);
        sectionChars += line.length + 1;
        shown++;
      }
      if (items.length > shown) sectionLines.push(`  ... and ${items.length - shown} more`);
      charBudget -= sectionChars;
      lines.push(...sectionLines);
    }

    // Add sections in priority order based on focus
    if (focus === "crypto") {
      addSection("Chrysler/DCC Class Names", chryslerClasses, 200);
      addSection("Security-Related Strings", securityKeywords, 300);
      addSection("Hex Constants", hexLike, 200);
      addSection("Method / Variable Names", methodNames, 150);
      addSection("Other Package/Class Names", otherClasses, 100);
      addSection("Diagnostic / Automotive Strings", diagnosticKeywords, 100);
      addSection("URLs / Server Endpoints", urls, 50);
    } else if (focus === "diagnostic") {
      addSection("Chrysler/DCC Class Names", chryslerClasses, 200);
      addSection("Diagnostic / Automotive Strings", diagnosticKeywords, 300);
      addSection("URLs / Server Endpoints", urls, 100);
      addSection("Security-Related Strings", securityKeywords, 150);
      addSection("Other Package/Class Names", otherClasses, 100);
      addSection("Hex Constants", hexLike, 100);
    } else if (focus === "classes") {
      addSection("Chrysler/DCC Class Names", chryslerClasses, 400);
      addSection("Other Package/Class Names", otherClasses, 200);
      addSection("Method / Variable Names", methodNames, 200);
    } else {
      // "all" — balanced view
      addSection("Chrysler/DCC Class Names", chryslerClasses, 150);
      addSection("Security-Related Strings", securityKeywords, 100);
      addSection("Diagnostic / Automotive Strings", diagnosticKeywords, 100);
      addSection("URLs / Server Endpoints", urls, 50);
      addSection("Hex Constants", hexLike, 80);
      addSection("Other Package/Class Names", otherClasses, 80);
      addSection("Method / Variable Names", methodNames, 80);
    }

    // ── Scan for ABC (ActionScript Bytecode) tag headers ───────────────────
    const abcTags: string[] = [];
    for (let pos = 0; pos < payload.length - 6; pos++) {
      const tagCodeAndLength = payload.readUInt16LE(pos);
      const tagType = (tagCodeAndLength >> 6) & 0x3ff;
      if (tagType === 82 || tagType === 72) {
        const shortLen = tagCodeAndLength & 0x3f;
        let tagLen: number;
        let dataStart: number;
        if (shortLen === 0x3f) {
          tagLen = payload.readInt32LE(pos + 2);
          dataStart = pos + 6;
        } else {
          tagLen = shortLen;
          dataStart = pos + 2;
        }
        let abcName = "";
        if (tagType === 82 && dataStart + 4 < payload.length) {
          let nameStart = dataStart + 4;
          while (nameStart < payload.length && payload[nameStart] !== 0 && abcName.length < 128) {
            const ch = payload[nameStart];
            if (ch >= 0x20 && ch < 0x7f) abcName += String.fromCharCode(ch);
            nameStart++;
          }
        }
        abcTags.push(
          `  Offset 0x${pos.toString(16).toUpperCase()}: DoABC${tagType === 82 ? "2" : ""} tag, length=${tagLen} bytes${abcName ? ` name="${abcName}"` : ""}`
        );
        if (abcTags.length >= 20) {
          abcTags.push("  ... (truncated at 20 ABC tags)");
          break;
        }
      }
    }

    if (abcTags.length > 0) {
      lines.push(`\n=== ActionScript Bytecode (ABC) Tags (${abcTags.length}) ===`);
      abcTags.forEach((t) => lines.push(t));
    } else {
      lines.push("\n=== ActionScript Bytecode (ABC) Tags: None detected ===");
    }

    // Summary stats
    lines.push(`\n=== Summary ===`);
    lines.push(`  Chrysler/DCC classes: ${chryslerClasses.length}`);
    lines.push(`  Other classes: ${otherClasses.length}`);
    lines.push(`  Security strings: ${securityKeywords.length}`);
    lines.push(`  Diagnostic strings: ${diagnosticKeywords.length}`);
    lines.push(`  URLs: ${urls.length}`);
    lines.push(`  Hex constants: ${hexLike.length}`);
    lines.push(`  Method names: ${methodNames.length}`);
    lines.push(`  ABC tags: ${abcTags.length}`);
    lines.push(`  Total strings: ${strings.length}`);
    lines.push(`  TIP: Call swf_extract again with focus='crypto', 'diagnostic', or 'classes' for deeper dives.`);

    const result = lines.join("\n");
    // Hard cap — should never trigger given the budget tracking above, but safety net
    if (result.length > MAX_OUTPUT_CHARS + 1000) {
      return result.substring(0, MAX_OUTPUT_CHARS) + "\n\n[OUTPUT TRUNCATED — call again with focus parameter for specific sections]";
    }
    return result;
  },
};
