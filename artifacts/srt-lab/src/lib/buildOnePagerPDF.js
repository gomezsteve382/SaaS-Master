import { NUNITO_REGULAR_BASE64, NUNITO_BOLD_BASE64 } from './nunito-fonts.js';

/**
 * Generic one-page A4/Letter PDF builder for tab quick-references.
 *
 * config = {
 *   filename, title, subtitle, version, footer, intro: [lines],
 *   sections: [{ label, type, data }]
 * }
 *
 * Section types:
 *   'cmds'  -> data: [[cmd, desc], ...]      (terminal-style)
 *   'rows'  -> data: { headers:[...], rows:[[col,col,...]], colors?:[hex,...] }
 *   'grid'  -> data: [[name, desc], ...]     (2-col compact list)
 *   'bullets' -> data: ['line', ...]
 */

function registerNunito(doc) {
  doc.addFileToVFS('Nunito-Regular.ttf', NUNITO_REGULAR_BASE64);
  doc.addFont('Nunito-Regular.ttf', 'Nunito', 'normal');
  doc.addFileToVFS('Nunito-Bold.ttf', NUNITO_BOLD_BASE64);
  doc.addFont('Nunito-Bold.ttf', 'Nunito', 'bold');
}

const SR = [0xD3, 0x2F, 0x2F];
const INK = [0x1A, 0x1A, 0x1A];
const SUB = [0x5A, 0x5A, 0x5A];
const MUTE = [0x9E, 0x9E, 0x9E];
const BORDER = [0xE8, 0xE4, 0xDE];
const STRIPE = [0xFA, 0xF9, 0xF7];
const ORANGE = [0xFF, 0x6D, 0x00];
const BLUE = [0x29, 0x79, 0xFF];
const PURPLE = [0xAA, 0x00, 0xFF];
const GREEN = [0xA5, 0xD6, 0xA7];

function hexToRgb(h) {
  if (!h || h[0] !== '#') return INK;
  const v = h.slice(1);
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

export async function buildOnePagerPDF(cfg) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'letter', compress: true });
  registerNunito(doc);

  const W = 612, H = 792, M = 36;

  // Header band
  doc.setFillColor(...SR);
  doc.rect(0, 0, W, 56, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('Nunito', 'bold');
  doc.setFontSize(20);
  doc.text('SRT LAB', M, 32);
  doc.setFontSize(11);
  doc.text(cfg.title || 'QUICK REFERENCE', M, 48);
  doc.setFont('Nunito', 'normal');
  doc.setFontSize(9);
  if (cfg.version) {
    doc.text(cfg.version, W - M, 48, { align: 'right' });
  }

  let y = 78;

  if (cfg.subtitle) {
    doc.setTextColor(...SUB);
    doc.setFont('Nunito', 'bold');
    doc.setFontSize(10);
    doc.text(cfg.subtitle, M, y);
    y += 14;
  }

  if (cfg.intro && cfg.intro.length) {
    doc.setTextColor(...INK);
    doc.setFont('Nunito', 'normal');
    doc.setFontSize(9.5);
    cfg.intro.forEach(t => { doc.text(t, M, y); y += 12; });
    y += 4;
  }

  const sectionHeader = (label) => {
    if (y > H - 80) return; // leave room for footer
    doc.setFillColor(...SR);
    doc.rect(M, y - 10, 4, 12, 'F');
    doc.setFont('Nunito', 'bold'); doc.setFontSize(11);
    doc.setTextColor(...INK);
    doc.text(label, M + 10, y);
    y += 8;
    doc.setDrawColor(...BORDER);
    doc.line(M, y - 2, W - M, y - 2);
    y += 8;
  };

  for (const sec of (cfg.sections || [])) {
    if (y > H - 60) break;
    sectionHeader(sec.label);

    if (sec.type === 'cmds') {
      doc.setFontSize(8.5);
      sec.data.forEach(([cmd, desc]) => {
        if (y > H - 50) return;
        doc.setFillColor(...INK);
        doc.rect(M, y - 9, W - 2 * M, 13, 'F');
        doc.setTextColor(...GREEN);
        doc.setFont('courier', 'normal');
        doc.text('$ ' + cmd, M + 6, y + 1);
        y += 15;
        doc.setTextColor(...SUB);
        doc.setFont('Nunito', 'normal');
        doc.text(desc, M + 10, y);
        y += 12;
      });
      y += 4;
    } else if (sec.type === 'rows') {
      const { headers, rows, colors } = sec.data;
      doc.setFontSize(8.5);
      doc.setFont('Nunito', 'bold');
      doc.setTextColor(...MUTE);
      const nCols = headers.length;
      const colW = (W - 2 * M) / nCols;
      headers.forEach((h, i) => doc.text(h, M + 6 + i * colW, y));
      y += 4; doc.setDrawColor(...BORDER); doc.line(M, y, W - M, y); y += 10;
      rows.forEach((row, ri) => {
        if (y > H - 50) return;
        if (ri % 2 === 0) { doc.setFillColor(...STRIPE); doc.rect(M, y - 8, W - 2 * M, 12, 'F'); }
        row.forEach((cell, ci) => {
          const isMono = /^0x[0-9A-Fa-f]+$/.test(String(cell)) || (colors && colors[ci] === '__mono__');
          if (isMono) doc.setFont('courier', 'bold'); else doc.setFont('Nunito', 'normal');
          if (colors && colors[ci] && colors[ci] !== '__mono__') doc.setTextColor(...hexToRgb(colors[ci]));
          else doc.setTextColor(...INK);
          doc.text(String(cell), M + 6 + ci * colW, y);
        });
        y += 12;
      });
      y += 4;
    } else if (sec.type === 'grid') {
      doc.setFontSize(8.5);
      const colW = (W - 2 * M) / 2;
      const rows = Math.ceil(sec.data.length / 2);
      for (let i = 0; i < rows; i++) {
        if (y > H - 50) break;
        if (i % 2 === 0) { doc.setFillColor(...STRIPE); doc.rect(M, y - 8, W - 2 * M, 12, 'F'); }
        for (let col = 0; col < 2; col++) {
          const idx = col * rows + i;
          if (idx >= sec.data.length) continue;
          const [n, d] = sec.data[idx];
          const x = M + col * colW + 6;
          doc.setFont('Nunito', 'bold'); doc.setTextColor(...SR);
          doc.text(String(idx + 1).padStart(2, '0'), x, y);
          doc.setTextColor(...INK);
          doc.text(String(n), x + 18, y);
          doc.setFont('Nunito', 'normal'); doc.setTextColor(...SUB);
          if (d) doc.text(String(d), x + 100, y);
        }
        y += 12;
      }
      y += 4;
    } else if (sec.type === 'bullets') {
      doc.setFontSize(9);
      doc.setFont('Nunito', 'normal');
      doc.setTextColor(...INK);
      sec.data.forEach(line => {
        if (y > H - 50) return;
        doc.setTextColor(...SR);
        doc.text('\u25AA', M + 4, y);
        doc.setTextColor(...INK);
        doc.text(String(line), M + 14, y);
        y += 13;
      });
      y += 4;
    }
  }

  // Footer
  doc.setDrawColor(...BORDER);
  doc.line(M, H - 30, W - M, H - 30);
  doc.setFont('Nunito', 'normal'); doc.setFontSize(8);
  doc.setTextColor(...MUTE);
  doc.text(cfg.footer || 'SRT Lab \u00B7 Quick Reference \u00B7 For authorized service use only', M, H - 16);
  if (cfg.footerRight) doc.text(cfg.footerRight, W - M, H - 16, { align: 'right' });

  doc.save(cfg.filename || 'SRT_Lab_Reference.pdf');
}

export const QR_COLORS = { SR, ORANGE, BLUE, PURPLE };
