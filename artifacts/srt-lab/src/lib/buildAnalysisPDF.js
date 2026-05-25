/**
 * buildAnalysisPDF.js — branded PDF renderer for module and job reports.
 *
 * Reuses the same palette, fonts, and layout primitives as buildOnePagerPDF.js
 * and buildQuickReferencePDF.js. No new library dependency — jsPDF is already
 * a production dependency of the workspace.
 *
 * Exports:
 *   buildModulePDF(reportData)  → triggers browser download (client-side only)
 *   buildJobPDF(reportData)     → triggers browser download (client-side only)
 */

import { NUNITO_REGULAR_BASE64, NUNITO_BOLD_BASE64 } from './nunito-fonts.js';

// ── Shared palette (matches buildOnePagerPDF.js) ─────────────────────────────
const SR     = [0xD3, 0x2F, 0x2F];
const INK    = [0x1A, 0x1A, 0x1A];
const SUB    = [0x5A, 0x5A, 0x5A];
const MUTE   = [0x9E, 0x9E, 0x9E];
const BORDER = [0xE8, 0xE4, 0xDE];
const STRIPE = [0xFA, 0xF9, 0xF7];
const GN     = [0x00, 0xC8, 0x53];
const WN     = [0xFF, 0xB3, 0x00];
const ER     = [0xFF, 0x17, 0x44];
const ORANGE = [0xFF, 0x6D, 0x00];
const BLUE   = [0x29, 0x79, 0xFF];
const PURPLE = [0xAA, 0x00, 0xFF];
const BG_LITE= [0xF4, 0xF1, 0xEC];

// ── Helpers ──────────────────────────────────────────────────────────────────

function registerNunito(doc) {
  doc.addFileToVFS('Nunito-Regular.ttf', NUNITO_REGULAR_BASE64);
  doc.addFont('Nunito-Regular.ttf', 'Nunito', 'normal');
  doc.addFileToVFS('Nunito-Bold.ttf', NUNITO_BOLD_BASE64);
  doc.addFont('Nunito-Bold.ttf', 'Nunito', 'bold');
}

function fmtTs(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
}

function statusColor(status) {
  switch (status) {
    case 'ok':      return GN;
    case 'fail':    return ER;
    case 'skipped': return WN;
    case 'running': return BLUE;
    default:        return MUTE;
  }
}

/** Truncate a string to maxLen characters with an ellipsis. */
function trunc(str, maxLen) {
  if (!str) return '';
  const s = String(str);
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
}

// ── Page layout constants ────────────────────────────────────────────────────
const W = 612, H = 792, M = 36;
const CONTENT_W = W - 2 * M;
const FOOTER_Y = H - 30;
const HEADER_H = 56;
const LINE_H = 13;

// ── Shared page primitives ───────────────────────────────────────────────────

/**
 * Draw the red SRT LAB header band and return the initial y offset.
 */
function drawHeader(doc, title, subtitle, generatedAt) {
  doc.setFillColor(...SR);
  doc.rect(0, 0, W, HEADER_H, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('Nunito', 'bold');
  doc.setFontSize(20);
  doc.text('SRT LAB', M, 32);
  doc.setFontSize(11);
  doc.text(title || 'MODULE REPORT', M, 48);
  doc.setFont('Nunito', 'normal');
  doc.setFontSize(9);
  if (generatedAt) {
    doc.text(fmtTs(generatedAt), W - M, 48, { align: 'right' });
  }

  let y = 72;
  if (subtitle) {
    doc.setTextColor(...SUB);
    doc.setFont('Nunito', 'bold');
    doc.setFontSize(10);
    doc.text(subtitle, M, y);
    y += 14;
  }
  return y;
}

/**
 * Draw the footer rule + text at the bottom of every page.
 */
function drawFooter(doc, left, right) {
  doc.setDrawColor(...BORDER);
  doc.line(M, FOOTER_Y, W - M, FOOTER_Y);
  doc.setFont('Nunito', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...MUTE);
  doc.text(left || 'SRT Lab \u00B7 For authorized service use only', M, H - 16);
  if (right) doc.text(right, W - M, H - 16, { align: 'right' });
}

/**
 * Draw a section header bar and advance y.
 * Returns new y.
 */
function sectionHeader(doc, label, y) {
  if (y > H - 80) return y;
  doc.setFillColor(...SR);
  doc.rect(M, y - 10, 4, 12, 'F');
  doc.setFont('Nunito', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...INK);
  doc.text(label, M + 10, y);
  y += 8;
  doc.setDrawColor(...BORDER);
  doc.line(M, y - 2, W - M, y - 2);
  y += 8;
  return y;
}

/**
 * Check if we need a new page. If so, add one, draw header/footer for
 * continuation, and return reset y.
 */
function guardPage(doc, y, titleLine, generatedAt) {
  if (y > H - 60) {
    drawFooter(doc, 'SRT Lab \u00B7 Continued', fmtTs(generatedAt));
    doc.addPage();
    drawHeader(doc, titleLine, null, generatedAt);
    return 72;
  }
  return y;
}

// ── Module Report ─────────────────────────────────────────────────────────────

async function buildModuleDoc(data) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'letter', compress: true });
  registerNunito(doc);

  const subtitle = `${data.sourceFile}  ·  ${(data.size || 0).toLocaleString()} bytes  ·  ${data.type}`;
  let y = drawHeader(doc, `MODULE REPORT — ${data.title}`, subtitle, data.generatedAt);

  // ── VIN badge ─────────────────────────────────────────────────────────────
  if (data.vin) {
    doc.setFillColor(...BG_LITE);
    doc.roundedRect(M, y, CONTENT_W, 28, 4, 4, 'F');
    doc.setFont('Nunito', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...MUTE);
    doc.text('VIN', M + 10, y + 11);
    doc.setFont('courier', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(...ORANGE);
    doc.text(data.vin, M + 40, y + 11);
    doc.setFont('Nunito', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...SUB);
    if (data.source) doc.text(`Loaded from: ${data.source}`, M + 10, y + 22);
    y += 36;
  }

  // ── Warnings ──────────────────────────────────────────────────────────────
  if (data.warnings && data.warnings.length > 0) {
    data.warnings.forEach(w => {
      doc.setFillColor(...WN);
      doc.setFillColor(0xFF, 0xB3, 0x00, 0.08);
      doc.rect(M, y - 2, CONTENT_W, LINE_H + 2, 'F');
      doc.setFont('Nunito', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(...WN);
      doc.text('\u26A0 ' + trunc(w, 90), M + 6, y + 8);
      y += LINE_H + 2;
    });
    y += 4;
  }

  // ── Parsed Fields table ──────────────────────────────────────────────────
  y = sectionHeader(doc, 'PARSED FIELDS', y);

  if (data.fields && data.fields.length > 0) {
    const colW = [60, 100, 220, CONTENT_W - 60 - 100 - 220];
    const headers = ['OFFSET', 'CATEGORY', 'VALUE', 'DETAIL'];

    doc.setFont('Nunito', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(...MUTE);
    headers.forEach((h, i) => {
      const x = M + colW.slice(0, i).reduce((a, b) => a + b, 0);
      doc.text(h, x + 4, y);
    });
    y += 4;
    doc.setDrawColor(...BORDER);
    doc.line(M, y, W - M, y);
    y += 9;

    data.fields.forEach((row, ri) => {
      y = guardPage(doc, y, `MODULE REPORT — ${data.title}`, data.generatedAt);
      if (ri % 2 === 0) {
        doc.setFillColor(...STRIPE);
        doc.rect(M, y - 8, CONTENT_W, LINE_H, 'F');
      }

      const vals = [row.offset, row.category, row.value, row.detail];
      vals.forEach((cell, ci) => {
        const x = M + colW.slice(0, ci).reduce((a, b) => a + b, 0) + 4;
        const isMono = ci === 0 || ci === 2;
        if (isMono) {
          doc.setFont('courier', ci === 0 ? 'normal' : 'bold');
          if (ci === 0) doc.setTextColor(...BLUE); else doc.setTextColor(...INK);
        } else {
          doc.setFont('Nunito', ci === 1 ? 'bold' : 'normal');
          if (ci === 1) doc.setTextColor(...SR); else doc.setTextColor(...SUB);
        }
        doc.setFontSize(8.5);
        doc.text(trunc(String(cell ?? '—'), ci === 2 ? 36 : ci === 3 ? 30 : 20), x, y);
      });
      y += LINE_H;
    });
    y += 6;
  } else {
    doc.setFont('Nunito', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...MUTE);
    doc.text('No parseable fields found in this module.', M + 4, y);
    y += 14;
  }

  // ── Security summary ──────────────────────────────────────────────────────
  y = guardPage(doc, y, `MODULE REPORT — ${data.title}`, data.generatedAt);
  y = sectionHeader(doc, 'SECURITY SUMMARY', y);

  doc.setFont('Nunito', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...INK);
  const secLines = [
    `Secrets found: ${data.hasSecrets ? 'YES — see fields above' : 'None detected'}`,
    `VINs total: ${data.vins.length}`,
  ];
  secLines.forEach(l => {
    y = guardPage(doc, y, `MODULE REPORT — ${data.title}`, data.generatedAt);
    doc.setTextColor(...SR);
    doc.text('\u25AA', M + 4, y);
    doc.setTextColor(...INK);
    doc.text(l, M + 14, y);
    y += LINE_H;
  });

  drawFooter(doc, 'SRT Lab \u00B7 Module Report \u00B7 For authorized service use only', data.sourceFile);
  return doc;
}

/**
 * Generate and download a single-module PDF report.
 * @param {object} reportData - output of buildModuleReportData()
 */
export async function buildModulePDF(reportData) {
  const doc = await buildModuleDoc(reportData);
  doc.save(reportData.filename || 'srtlab-module-report.pdf');
}

// ── Job Report ────────────────────────────────────────────────────────────────

async function buildJobDoc(data) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'letter', compress: true });
  registerNunito(doc);

  const subtitle = data.vin
    ? `VIN: ${data.vin}  ·  Status: ${data.status}  ·  Job: ${data.jobId ?? '—'}`
    : `Status: ${data.status}  ·  Job: ${data.jobId ?? '—'}`;
  let y = drawHeader(doc, 'JOB REPORT', subtitle, data.generatedAt);

  const TITLE_LINE = 'JOB REPORT';

  // ── Job metadata ──────────────────────────────────────────────────────────
  doc.setFillColor(...BG_LITE);
  doc.roundedRect(M, y, CONTENT_W, 36, 4, 4, 'F');
  doc.setFont('Nunito', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(...INK);
  doc.text(trunc(data.title, 60), M + 10, y + 14);
  doc.setFont('Nunito', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...SUB);
  doc.text(`Created: ${fmtTs(data.createdAt)}   Updated: ${fmtTs(data.updatedAt)}`, M + 10, y + 28);
  y += 46;

  // ── Totals pill row ──────────────────────────────────────────────────────
  const pills = [
    { label: 'TOTAL', val: data.totals.total, col: INK },
    { label: 'DONE',  val: data.totals.completed, col: GN },
    { label: 'FAIL',  val: data.totals.failed, col: ER },
    { label: 'SKIP',  val: data.totals.skipped, col: WN },
    { label: 'PEND',  val: data.totals.pending, col: MUTE },
  ];
  const pillW = 80;
  pills.forEach((p, i) => {
    const px = M + i * (pillW + 6);
    doc.setFillColor(p.col[0], p.col[1], p.col[2]);
    doc.roundedRect(px, y, pillW, 22, 3, 3, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('Nunito', 'bold');
    doc.setFontSize(8);
    doc.text(`${p.label}: ${p.val}`, px + 8, y + 14);
  });
  y += 32;

  // ── Module Census ─────────────────────────────────────────────────────────
  y = sectionHeader(doc, 'MODULE CENSUS', y);

  if (data.censusRows.length === 0) {
    doc.setFont('Nunito', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...MUTE);
    doc.text('No census data — load module dumps in the DUMPS tab.', M + 4, y);
    y += 14;
  } else {
    const kindColor = { ok: GN, mismatch: WN, missing: ER, extra: BLUE, unknown: MUTE };
    data.censusRows.forEach((row, ri) => {
      y = guardPage(doc, y, TITLE_LINE, data.generatedAt);
      if (ri % 2 === 0) { doc.setFillColor(...STRIPE); doc.rect(M, y - 8, CONTENT_W, LINE_H, 'F'); }
      const kc = kindColor[row.kind] || MUTE;
      doc.setFillColor(...kc);
      doc.circle(M + 8, y - 2, 3, 'F');
      doc.setFont('Nunito', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(...INK);
      doc.text(trunc(row.code, 12), M + 16, y);
      doc.setFont('Nunito', 'normal');
      doc.setTextColor(...SUB);
      doc.text(trunc(row.name, 40), M + 90, y);
      if (row.vin) {
        doc.setFont('courier', 'normal');
        doc.setTextColor(...ORANGE);
        doc.text(row.vin, M + 290, y);
      }
      doc.setFont('Nunito', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(...kc);
      doc.text(row.kind.toUpperCase(), W - M - 4, y, { align: 'right' });
      y += LINE_H;
    });
    y += 4;
  }

  // ── Fix Plan steps ────────────────────────────────────────────────────────
  y = guardPage(doc, y, TITLE_LINE, data.generatedAt);
  y = sectionHeader(doc, 'FIX PLAN STEPS', y);

  if (data.blockers.length > 0) {
    doc.setFont('Nunito', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(...WN);
    doc.text('Blockers: ' + trunc(data.blockers.join(' · '), 80), M + 4, y);
    y += LINE_H + 2;
  }

  if (data.steps.length === 0) {
    doc.setFont('Nunito', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...MUTE);
    doc.text('Fix plan is empty.', M + 4, y);
    y += 14;
  } else {
    const headers2 = ['STATUS', 'MODULE', 'STEP', 'RESULT'];
    const col2W = [60, 70, 240, CONTENT_W - 60 - 70 - 240];
    doc.setFont('Nunito', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(...MUTE);
    headers2.forEach((h, i) => doc.text(h, M + col2W.slice(0, i).reduce((a, b) => a + b, 0) + 4, y));
    y += 4;
    doc.setDrawColor(...BORDER);
    doc.line(M, y, W - M, y);
    y += 9;

    data.steps.forEach((step, ri) => {
      y = guardPage(doc, y, TITLE_LINE, data.generatedAt);
      if (ri % 2 === 0) { doc.setFillColor(...STRIPE); doc.rect(M, y - 8, CONTENT_W, LINE_H, 'F'); }
      const sc = statusColor(step.status);
      const cols = [
        { text: step.status.toUpperCase(), color: sc, font: 'bold', mono: false },
        { text: step.module ?? '—', color: SUB, font: 'normal', mono: false },
        { text: step.label, color: INK, font: 'normal', mono: false },
        { text: step.note ?? (step.status === 'ok' ? '✓' : ''), color: SUB, font: 'normal', mono: false },
      ];
      cols.forEach((c, ci) => {
        const x = M + col2W.slice(0, ci).reduce((a, b) => a + b, 0) + 4;
        doc.setFont('Nunito', c.font);
        doc.setFontSize(8.5);
        doc.setTextColor(...c.color);
        doc.text(trunc(c.text, ci === 2 ? 38 : 16), x, y);
      });
      y += LINE_H;
    });
    y += 6;
  }

  // ── Sign-Off ──────────────────────────────────────────────────────────────
  y = guardPage(doc, y, TITLE_LINE, data.generatedAt);
  y = sectionHeader(doc, 'SIGN-OFF', y);

  if (data.signOff) {
    const ready = data.signOff.ready;
    doc.setFillColor(ready ? 0x00 : 0xFF, ready ? 0xC8 : 0x17, ready ? 0x53 : 0x44);
    doc.roundedRect(M, y - 2, CONTENT_W, 20, 3, 3, 'F');
    doc.setFont('Nunito', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(255, 255, 255);
    doc.text(
      ready ? '\u2713 READY FOR CUSTOMER HAND-OFF' : '\u26A0 BLOCKED — Review failed steps',
      M + 10, y + 11
    );
    y += 28;
  } else {
    doc.setFont('Nunito', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...MUTE);
    doc.text('No sign-off generated yet.', M + 4, y);
    y += 14;
  }

  // ── Audit log (last 20 events) ────────────────────────────────────────────
  if (data.events.length > 0) {
    y = guardPage(doc, y, TITLE_LINE, data.generatedAt);
    y = sectionHeader(doc, `AUDIT LOG (${Math.min(data.events.length, 20)} most recent events)`, y);

    data.events.slice(-20).forEach((ev, ri) => {
      y = guardPage(doc, y, TITLE_LINE, data.generatedAt);
      if (ri % 2 === 0) { doc.setFillColor(...STRIPE); doc.rect(M, y - 8, CONTENT_W, LINE_H, 'F'); }
      doc.setFont('courier', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(...BLUE);
      doc.text(ev.ts ? new Date(ev.ts).toLocaleString() : '—', M + 4, y);
      doc.setFont('Nunito', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(...SR);
      doc.text(trunc(ev.kind, 22), M + 130, y);
      doc.setFont('Nunito', 'normal');
      doc.setTextColor(...SUB);
      if (ev.module) doc.text(trunc(ev.module, 12), M + 280, y);
      y += LINE_H;
    });
  }

  drawFooter(doc, 'SRT Lab \u00B7 Job Report \u00B7 For authorized service use only', data.jobId ?? '');
  return doc;
}

/**
 * Generate and download a vehicle-job PDF report.
 * @param {object} reportData - output of buildJobReportData()
 */
export async function buildJobPDF(reportData) {
  const doc = await buildJobDoc(reportData);
  doc.save(reportData.filename || 'srtlab-job-report.pdf');
}
