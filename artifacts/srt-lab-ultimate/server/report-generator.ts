/**
 * SRT Lab — Analysis Report Generator
 *
 * Generates formatted PDF and JSON exports of full analysis results,
 * including VENOM synthesis, per-agent findings, and complete tool call traces.
 */

import PDFDocument from "pdfkit";
import { PassThrough } from "stream";

// ─── Colors ─────────────────────────────────────────────────────────────────

const C = {
  bg: "#0A0A0A",
  surface: "#111111",
  border: "#1A1A1A",
  red: "#FF2D2D",
  redDim: "#CC2222",
  green: "#00FF88",
  blue: "#00BFFF",
  purple: "#9B59B6",
  orange: "#FF6B6B",
  yellow: "#FFD700",
  text: "#E8E8E8",
  textDim: "#999999",
  mono: "#A8FF78",
  white: "#FFFFFF",
};

const AGENT_COLORS: Record<string, string> = {
  GHOST: C.green,
  PHANTOM: C.blue,
  SPECTER: C.orange,
  WRAITH: C.purple,
  SHADE: C.red,
  VENOM: C.yellow,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function truncate(str: string, max: number): string {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) + "…" : str;
}

// ─── PDF Builder ─────────────────────────────────────────────────────────────

export async function generatePDFReport(analysisData: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      margins: { top: 50, bottom: 50, left: 50, right: 50 },
      bufferPages: true,
      info: {
        Title: `SRT Lab Analysis Report — ${analysisData.filename || "Unknown"}`,
        Author: "SRT Lab Ultimate Edition",
        Subject: "Binary Analysis Report",
        Keywords: "reverse engineering, automotive, binary analysis",
        CreationDate: new Date(),
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const findings = analysisData.findings || {};
    const toolTrace = analysisData.toolCallTrace || [];
    const agentResults = analysisData.agentResults || [];
    const ts = analysisData.timestamp || Date.now();

    // ── Page width helpers ──────────────────────────────────────────────────
    const PW = doc.page.width - 100; // usable width

    // ── Section header ──────────────────────────────────────────────────────
    function sectionHeader(title: string, color = C.red) {
      doc.moveDown(0.5);
      doc
        .rect(50, doc.y, PW, 24)
        .fill(color === C.red ? "#1A0000" : "#001A0A");
      doc
        .fillColor(color)
        .font("Helvetica-Bold")
        .fontSize(11)
        .text(title.toUpperCase(), 58, doc.y - 18);
      doc.moveDown(0.8);
      doc.fillColor(C.text).font("Helvetica").fontSize(9);
    }

    function subHeader(title: string) {
      doc.moveDown(0.3);
      doc.fillColor(C.textDim).font("Helvetica-Bold").fontSize(9).text(title);
      doc.moveDown(0.2);
      doc.fillColor(C.text).font("Helvetica").fontSize(8.5);
    }

    function kv(key: string, value: string, mono = false) {
      doc
        .fillColor(C.textDim)
        .font("Helvetica-Bold")
        .fontSize(8.5)
        .text(`${key}: `, { continued: true })
        .fillColor(C.text)
        .font(mono ? "Courier" : "Helvetica")
        .fontSize(8.5)
        .text(value || "—");
    }

    function hr() {
      doc.moveDown(0.3);
      doc
        .moveTo(50, doc.y)
        .lineTo(50 + PW, doc.y)
        .strokeColor("#222222")
        .lineWidth(0.5)
        .stroke();
      doc.moveDown(0.3);
    }

    function checkPageBreak(needed = 60) {
      if (doc.y > doc.page.height - doc.page.margins.bottom - needed) {
        doc.addPage();
      }
    }

    // ── COVER PAGE ──────────────────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, doc.page.height).fill("#050505");

    // Red accent bar
    doc.rect(0, 0, 6, doc.page.height).fill(C.red);

    // Logo / title
    doc
      .fillColor(C.red)
      .font("Helvetica-Bold")
      .fontSize(32)
      .text("SRT LAB", 60, 100);
    doc
      .fillColor(C.textDim)
      .font("Helvetica")
      .fontSize(12)
      .text("ULTIMATE EDITION — 6-AGENT SWARM", 60, 140);

    doc
      .moveTo(60, 165)
      .lineTo(60 + PW, 165)
      .strokeColor(C.red)
      .lineWidth(1)
      .stroke();

    doc
      .fillColor(C.white)
      .font("Helvetica-Bold")
      .fontSize(18)
      .text("ANALYSIS REPORT", 60, 185);

    // File info box
    doc.rect(60, 225, PW, 120).fill("#0D0D0D").stroke("#1A1A1A");

    doc
      .fillColor(C.textDim)
      .font("Helvetica-Bold")
      .fontSize(8)
      .text("FILE", 75, 240);
    doc
      .fillColor(C.white)
      .font("Courier-Bold")
      .fontSize(13)
      .text(truncate(analysisData.filename || "Unknown", 55), 75, 252);

    const coverY = 280;
    const col1 = 75;
    const col2 = 310;

    doc.fillColor(C.textDim).font("Helvetica").fontSize(8);
    doc.text("SIZE", col1, coverY);
    doc.text("TYPE", col2, coverY);
    doc
      .fillColor(C.text)
      .font("Helvetica-Bold")
      .fontSize(9)
      .text(formatBytes(analysisData.fileSize || 0), col1, coverY + 12);
    doc
      .fillColor(C.text)
      .font("Helvetica-Bold")
      .fontSize(9)
      .text(truncate(analysisData.fileType || "Binary", 35), col2, coverY + 12);

    doc.fillColor(C.textDim).font("Helvetica").fontSize(8);
    doc.text("ANALYZED", col1, coverY + 32);
    doc.text("MODE", col2, coverY + 32);
    doc
      .fillColor(C.text)
      .font("Helvetica-Bold")
      .fontSize(9)
      .text(formatDate(ts), col1, coverY + 44);
    doc
      .fillColor(C.text)
      .font("Helvetica-Bold")
      .fontSize(9)
      .text(analysisData.analysisMode || "autonomous_swarm", col2, coverY + 44);

    // Stats grid
    const stats = [
      { label: "ALGORITHMS", value: findings.algorithms?.length || 0, color: C.red },
      { label: "SEED KEYS", value: findings.seedKeys?.length || 0, color: C.green },
      { label: "CAN IDs", value: findings.canAddresses?.length || 0, color: C.blue },
      { label: "CHECKSUMS", value: findings.checksums?.length || 0, color: C.yellow },
      { label: "SEC BYTES", value: findings.securityBytes?.length || 0, color: C.orange },
      { label: "TOOL CALLS", value: toolTrace.length, color: C.purple },
    ];

    const statY = 380;
    const statW = Math.floor(PW / 3);
    stats.forEach((s, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const x = 60 + col * statW;
      const y = statY + row * 60;
      doc.rect(x + 2, y, statW - 6, 52).fill("#0D0D0D");
      doc
        .fillColor(s.color)
        .font("Helvetica-Bold")
        .fontSize(22)
        .text(String(s.value), x + 10, y + 8);
      doc
        .fillColor(C.textDim)
        .font("Helvetica")
        .fontSize(7)
        .text(s.label, x + 10, y + 36);
    });

    // Footer
    doc
      .fillColor(C.textDim)
      .font("Helvetica")
      .fontSize(8)
      .text(
        `Generated by SRT Lab Ultimate Edition — ${formatDate(Date.now())}`,
        60,
        doc.page.height - 70
      );

    // ── PAGE 2: EXECUTIVE SUMMARY ───────────────────────────────────────────
    doc.addPage();
    doc.rect(0, 0, doc.page.width, doc.page.height).fill("#050505");
    doc.rect(0, 0, 6, doc.page.height).fill(C.red);

    doc
      .fillColor(C.red)
      .font("Helvetica-Bold")
      .fontSize(14)
      .text("EXECUTIVE SUMMARY", 60, 55);
    hr();

    if (findings.summary) {
      doc
        .fillColor(C.text)
        .font("Helvetica")
        .fontSize(9)
        .text(findings.summary, 60, doc.y, { width: PW, lineGap: 3 });
    } else {
      doc.fillColor(C.textDim).font("Helvetica").fontSize(9).text("No summary available.");
    }

    // Agent performance table
    if (agentResults.length > 0) {
      doc.moveDown(1);
      sectionHeader("Agent Performance", C.green);

      const colWidths = [80, 180, 60, 60, 60, 60];
      const headers = ["AGENT", "SPECIALTY", "TOOLS", "ITERS", "LEADS", "MS"];
      const tableX = 50;
      let tableY = doc.y;

      // Header row
      doc.rect(tableX, tableY, PW, 18).fill("#1A0000");
      let cx = tableX + 5;
      headers.forEach((h, i) => {
        doc
          .fillColor(C.red)
          .font("Helvetica-Bold")
          .fontSize(7.5)
          .text(h, cx, tableY + 5, { width: colWidths[i] - 4 });
        cx += colWidths[i];
      });
      tableY += 18;

      agentResults.forEach((agent: any, idx: number) => {
        checkPageBreak(20);
        const rowColor = idx % 2 === 0 ? "#0A0A0A" : "#0D0D0D";
        doc.rect(tableX, tableY, PW, 16).fill(rowColor);
        const agentColor = AGENT_COLORS[agent.codename] || C.text;
        const row = [
          agent.codename || agent.agentId,
          truncate(agent.specialty || "", 38),
          String(agent.toolCallCount || 0),
          String(agent.iterations || 0),
          String(agent.leadsPosted || 0),
          agent.durationMs ? `${Math.round(agent.durationMs / 1000)}s` : "—",
        ];
        cx = tableX + 5;
        row.forEach((cell, i) => {
          doc
            .fillColor(i === 0 ? agentColor : C.text)
            .font(i === 0 ? "Helvetica-Bold" : "Helvetica")
            .fontSize(7.5)
            .text(cell, cx, tableY + 4, { width: colWidths[i] - 4 });
          cx += colWidths[i];
        });
        tableY += 16;
      });
      doc.y = tableY + 8;
    }

    // ── FINDINGS SECTIONS ───────────────────────────────────────────────────

    // Helper to render a findings section
    function renderFindingsSection(
      title: string,
      items: any[],
      color: string,
      renderItem: (item: any) => void
    ) {
      if (!items || items.length === 0) return;
      doc.addPage();
      doc.rect(0, 0, doc.page.width, doc.page.height).fill("#050505");
      doc.rect(0, 0, 6, doc.page.height).fill(color);
      doc
        .fillColor(color)
        .font("Helvetica-Bold")
        .fontSize(14)
        .text(title.toUpperCase(), 60, 55);
      doc
        .fillColor(C.textDim)
        .font("Helvetica")
        .fontSize(9)
        .text(`${items.length} item${items.length !== 1 ? "s" : ""} found`, 60, 74);
      hr();
      items.forEach((item, i) => {
        checkPageBreak(80);
        renderItem(item);
        if (i < items.length - 1) hr();
      });
    }

    // Algorithms
    renderFindingsSection("Algorithms", findings.algorithms || [], C.red, (algo: any) => {
      doc.fillColor(C.red).font("Helvetica-Bold").fontSize(10).text(algo.name || "Unknown Algorithm");
      doc.moveDown(0.2);
      if (algo.type) kv("Type", algo.type);
      if (algo.offset) kv("Offset", algo.offset, true);
      if (algo.description) {
        doc.moveDown(0.2);
        doc.fillColor(C.text).font("Helvetica").fontSize(8.5).text(algo.description, { width: PW });
      }
      if (algo.pseudocode) {
        doc.moveDown(0.3);
        doc.fillColor(C.textDim).font("Helvetica-Bold").fontSize(8).text("PSEUDOCODE:");
        doc.moveDown(0.1);
        doc
          .fillColor(C.mono)
          .font("Courier")
          .fontSize(7.5)
          .text(truncate(algo.pseudocode, 800), { width: PW });
      }
      if (algo.constants && algo.constants.length > 0) {
        doc.moveDown(0.2);
        kv("Constants", algo.constants.slice(0, 8).join(", "), true);
      }
    });

    // Seed Keys
    renderFindingsSection("Seed Keys", findings.seedKeys || [], C.green, (sk: any) => {
      doc.fillColor(C.green).font("Helvetica-Bold").fontSize(10).text(sk.name || "Seed-Key Algorithm");
      doc.moveDown(0.2);
      if (sk.offset) kv("Offset", sk.offset, true);
      if (sk.algorithm) kv("Algorithm", sk.algorithm);
      if (sk.description) {
        doc.moveDown(0.2);
        doc.fillColor(C.text).font("Helvetica").fontSize(8.5).text(sk.description, { width: PW });
      }
      if (sk.code) {
        doc.moveDown(0.3);
        doc.fillColor(C.textDim).font("Helvetica-Bold").fontSize(8).text("IMPLEMENTATION:");
        doc.moveDown(0.1);
        doc.fillColor(C.mono).font("Courier").fontSize(7.5).text(truncate(sk.code, 600), { width: PW });
      }
    });

    // CAN Addresses
    renderFindingsSection("CAN Addresses", findings.canAddresses || [], C.blue, (can: any) => {
      doc.fillColor(C.blue).font("Helvetica-Bold").fontSize(10).text(can.id || can.address || "Unknown CAN ID");
      doc.moveDown(0.2);
      if (can.description) kv("Description", can.description);
      if (can.direction) kv("Direction", can.direction);
      if (can.dlc) kv("DLC", String(can.dlc));
      if (can.offset) kv("Offset", can.offset, true);
    });

    // Checksums
    renderFindingsSection("Checksums", findings.checksums || [], C.yellow, (cs: any) => {
      doc.fillColor(C.yellow).font("Helvetica-Bold").fontSize(10).text(cs.type || cs.name || "Checksum");
      doc.moveDown(0.2);
      if (cs.offset) kv("Offset", cs.offset, true);
      if (cs.polynomial) kv("Polynomial", cs.polynomial, true);
      if (cs.description) {
        doc.moveDown(0.2);
        doc.fillColor(C.text).font("Helvetica").fontSize(8.5).text(cs.description, { width: PW });
      }
    });

    // Security Bytes
    renderFindingsSection("Security Bytes", findings.securityBytes || [], C.orange, (sb: any) => {
      doc.fillColor(C.orange).font("Helvetica-Bold").fontSize(10).text(sb.description || sb.name || "Security Byte");
      doc.moveDown(0.2);
      if (sb.offset) kv("Offset", sb.offset, true);
      if (sb.currentValue !== undefined) kv("Current Value", String(sb.currentValue), true);
      if (sb.expectedValue !== undefined) kv("Expected Value", String(sb.expectedValue), true);
      if (sb.notes) {
        doc.moveDown(0.2);
        doc.fillColor(C.text).font("Helvetica").fontSize(8.5).text(sb.notes, { width: PW });
      }
    });

    // Memory Maps
    renderFindingsSection("Memory Maps", findings.memoryMaps || [], C.purple, (mm: any) => {
      doc.fillColor(C.purple).font("Helvetica-Bold").fontSize(10).text(mm.region || mm.name || "Memory Region");
      doc.moveDown(0.2);
      if (mm.startOffset) kv("Start", mm.startOffset, true);
      if (mm.endOffset) kv("End", mm.endOffset, true);
      if (mm.size) kv("Size", mm.size);
      if (mm.description) {
        doc.moveDown(0.2);
        doc.fillColor(C.text).font("Helvetica").fontSize(8.5).text(mm.description, { width: PW });
      }
    });

    // Deep Findings
    if (findings.deepFindings && findings.deepFindings.length > 0) {
      renderFindingsSection("Deep Findings", findings.deepFindings, C.red, (df: any) => {
        const title = typeof df === "string" ? df : df.title || df.finding || JSON.stringify(df).slice(0, 80);
        const body = typeof df === "string" ? "" : df.details || df.description || "";
        doc.fillColor(C.red).font("Helvetica-Bold").fontSize(9).text(title, { width: PW });
        if (body) {
          doc.moveDown(0.2);
          doc.fillColor(C.text).font("Helvetica").fontSize(8.5).text(body, { width: PW });
        }
      });
    }

    // ── TOOL CALL TRACE ─────────────────────────────────────────────────────
    if (toolTrace.length > 0) {
      doc.addPage();
      doc.rect(0, 0, doc.page.width, doc.page.height).fill("#050505");
      doc.rect(0, 0, 6, doc.page.height).fill(C.purple);
      doc
        .fillColor(C.purple)
        .font("Helvetica-Bold")
        .fontSize(14)
        .text("TOOL CALL TRACE", 60, 55);
      doc
        .fillColor(C.textDim)
        .font("Helvetica")
        .fontSize(9)
        .text(`${toolTrace.length} tool calls across all agents`, 60, 74);
      hr();

      toolTrace.forEach((tc: any, i: number) => {
        checkPageBreak(60);
        const agentColor = AGENT_COLORS[tc.toolName?.split("]")?.[0]?.replace("[", "")] || C.text;

        // Tool name header
        doc
          .fillColor(agentColor)
          .font("Courier-Bold")
          .fontSize(8.5)
          .text(`[${i + 1}] ${tc.toolName || "unknown"}`, { continued: true });
        if (tc.durationMs !== undefined) {
          doc
            .fillColor(C.textDim)
            .font("Courier")
            .fontSize(8)
            .text(`  ${tc.durationMs}ms`);
        } else {
          doc.text("");
        }

        // Args
        if (tc.args && Object.keys(tc.args).length > 0) {
          const argsStr = Object.entries(tc.args)
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(", ");
          doc
            .fillColor(C.textDim)
            .font("Courier")
            .fontSize(7.5)
            .text(`  → ${truncate(argsStr, 200)}`, { width: PW });
        }

        // Result preview
        if (tc.result) {
          const resultStr = typeof tc.result === "string" ? tc.result : JSON.stringify(tc.result);
          doc
            .fillColor(C.mono)
            .font("Courier")
            .fontSize(7)
            .text(`  ${truncate(resultStr, 300)}`, { width: PW });
        }

        doc.moveDown(0.4);
      });
    }

    // ── STRINGS SECTION ─────────────────────────────────────────────────────
    const strings = findings.strings || [];
    if (strings.length > 0) {
      doc.addPage();
      doc.rect(0, 0, doc.page.width, doc.page.height).fill("#050505");
      doc.rect(0, 0, 6, doc.page.height).fill(C.textDim);
      doc
        .fillColor(C.textDim)
        .font("Helvetica-Bold")
        .fontSize(14)
        .text("EXTRACTED STRINGS", 60, 55);
      doc
        .fillColor(C.textDim)
        .font("Helvetica")
        .fontSize(9)
        .text(`${strings.length} strings extracted`, 60, 74);
      hr();

      // Print up to 200 strings in two columns
      const displayStrings = strings.slice(0, 200);
      const half = Math.ceil(displayStrings.length / 2);
      const col1Strings = displayStrings.slice(0, half);
      const col2Strings = displayStrings.slice(half);
      const colW = Math.floor(PW / 2) - 10;

      col1Strings.forEach((s: any, i: number) => {
        checkPageBreak(12);
        const str = typeof s === "string" ? s : s.value || JSON.stringify(s);
        const offset = typeof s === "object" && s.offset ? s.offset : "";
        const y = doc.y;
        doc.fillColor(C.textDim).font("Courier").fontSize(7).text(offset, 50, y, { width: 50 });
        doc.fillColor(C.mono).font("Courier").fontSize(7).text(truncate(str, 50), 105, y, { width: colW });
        if (col2Strings[i]) {
          const str2 = typeof col2Strings[i] === "string" ? col2Strings[i] : (col2Strings[i] as any).value || "";
          const offset2 = typeof col2Strings[i] === "object" ? (col2Strings[i] as any).offset || "" : "";
          doc.fillColor(C.textDim).font("Courier").fontSize(7).text(offset2, 50 + colW + 15, y, { width: 50 });
          doc.fillColor(C.mono).font("Courier").fontSize(7).text(truncate(str2, 50), 50 + colW + 70, y, { width: colW });
        }
        doc.moveDown(0.15);
      });

      if (strings.length > 200) {
        doc.moveDown(0.5);
        doc
          .fillColor(C.textDim)
          .font("Helvetica")
          .fontSize(8)
          .text(`... and ${strings.length - 200} more strings (see JSON export for full list)`);
      }
    }

    // ── FOOTER ON EVERY PAGE ────────────────────────────────────────────────
    const pageCount = doc.bufferedPageRange().count;
    for (let i = 0; i < pageCount; i++) {
      doc.switchToPage(i);
      doc
        .fillColor(C.textDim)
        .font("Helvetica")
        .fontSize(7)
        .text(
          `SRT Lab Ultimate Edition  |  ${analysisData.filename || "Unknown"}  |  Page ${i + 1} of ${pageCount}`,
          50,
          doc.page.height - 30,
          { width: PW, align: "center" }
        );
    }

    doc.end();
  });
}

// ─── JSON Report ─────────────────────────────────────────────────────────────

export function generateJSONReport(analysisData: any, analysisId: string): object {
  const findings = analysisData.findings || {};
  const toolTrace = analysisData.toolCallTrace || [];
  const agentResults = analysisData.agentResults || [];

  return {
    meta: {
      reportVersion: "1.0",
      generatedAt: new Date().toISOString(),
      generator: "SRT Lab Ultimate Edition — 6-Agent Swarm",
      analysisId,
    },
    file: {
      name: analysisData.filename,
      size: analysisData.fileSize,
      type: analysisData.fileType,
      analyzedAt: analysisData.timestamp ? new Date(analysisData.timestamp).toISOString() : null,
      analysisMode: analysisData.analysisMode,
    },
    summary: {
      text: findings.summary || "",
      algorithmCount: findings.algorithms?.length || 0,
      seedKeyCount: findings.seedKeys?.length || 0,
      canAddressCount: findings.canAddresses?.length || 0,
      checksumCount: findings.checksums?.length || 0,
      securityByteCount: findings.securityBytes?.length || 0,
      stringCount: findings.strings?.length || 0,
      totalToolCalls: toolTrace.length,
      agentCount: agentResults.length,
    },
    agents: agentResults.map((a: any) => ({
      id: a.agentId,
      codename: a.codename,
      specialty: a.specialty,
      toolCallCount: a.toolCallCount,
      iterations: a.iterations,
      leadsPosted: a.leadsPosted,
      durationMs: a.durationMs,
      terminationReason: a.terminationReason,
      error: a.error || null,
    })),
    findings: {
      algorithms: findings.algorithms || [],
      seedKeys: findings.seedKeys || [],
      canAddresses: findings.canAddresses || [],
      checksums: findings.checksums || [],
      securityBytes: findings.securityBytes || [],
      memoryMaps: findings.memoryMaps || [],
      cryptoConstants: findings.cryptoConstants || [],
      deepFindings: findings.deepFindings || [],
      strings: findings.strings || [],
    },
    toolCallTrace: toolTrace.map((tc: any) => ({
      toolName: tc.toolName,
      args: tc.args,
      result: tc.result,
      durationMs: tc.durationMs,
    })),
    dissectionReport: analysisData.dissectionReport || null,
  };
}
