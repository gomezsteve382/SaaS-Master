import { QR_CMDS, QR_BCM_CANDIDATES, QR_ALGOS, QR_BLURB } from './quickRef.js';
import { NUNITO_REGULAR_BASE64, NUNITO_BOLD_BASE64 } from './nunito-fonts.js';

function registerNunito(doc) {
  doc.addFileToVFS('Nunito-Regular.ttf', NUNITO_REGULAR_BASE64);
  doc.addFont('Nunito-Regular.ttf', 'Nunito', 'normal');
  doc.addFileToVFS('Nunito-Bold.ttf', NUNITO_BOLD_BASE64);
  doc.addFont('Nunito-Bold.ttf', 'Nunito', 'bold');
}

export async function buildQuickReferencePDF() {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'letter', compress: true });
  registerNunito(doc);

  const W = 612, H = 792, M = 36;
  const SR = [0xD3, 0x2F, 0x2F];
  const INK = [0x1A, 0x1A, 0x1A];
  const SUB = [0x5A, 0x5A, 0x5A];
  const MUTE = [0x9E, 0x9E, 0x9E];
  const BORDER = [0xE8, 0xE4, 0xDE];
  const STRIPE = [0xFA, 0xF9, 0xF7];
  const ORANGE = [0xFF, 0x6D, 0x00];
  const BLUE = [0x29, 0x79, 0xFF];
  const GREEN = [0xA5, 0xD6, 0xA7];

  doc.setFillColor(...SR);
  doc.rect(0, 0, W, 56, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('Nunito', 'bold');
  doc.setFontSize(20);
  doc.text('SRT LAB', M, 32);
  doc.setFontSize(11);
  doc.text('BENCH QUICK REFERENCE', M, 48);
  doc.setFont('Nunito', 'normal');
  doc.setFontSize(9);
  doc.text('v1 \u00B7 Mopar / FCA UDS \u00B7 J2534', W - M, 48, { align: 'right' });

  let y = 78;
  doc.setTextColor(...INK);
  doc.setFont('Nunito', 'normal');
  doc.setFontSize(9.5);
  QR_BLURB.forEach(t => { doc.text(t, M, y); y += 12; });
  y += 6;

  const sectionHeader = (label) => {
    doc.setFillColor(...SR);
    doc.rect(M, y - 10, 4, 12, 'F');
    doc.setFont('Nunito', 'bold'); doc.setFontSize(11);
    doc.setTextColor(...INK);
    doc.text(label, M + 10, y);
    y += 10;
    doc.setDrawColor(...BORDER);
    doc.line(M, y - 2, W - M, y - 2);
    y += 8;
  };

  sectionHeader('CORE CLI COMMANDS');
  doc.setFontSize(9);
  QR_CMDS.forEach(([cmd, desc]) => {
    doc.setFillColor(...INK);
    doc.rect(M, y - 9, W - 2 * M, 14, 'F');
    doc.setTextColor(...GREEN);
    doc.setFont('courier', 'normal');
    doc.text('$ ' + cmd, M + 6, y + 1);
    y += 18;
    doc.setTextColor(...SUB);
    doc.setFont('Nunito', 'normal');
    doc.text(desc, M + 10, y);
    y += 14;
  });
  y += 4;

  sectionHeader('BCM CAN ADDRESS CANDIDATES');
  y += 2;
  doc.setFontSize(9);
  doc.setFont('Nunito', 'bold');
  doc.setTextColor(...MUTE);
  doc.text('TX', M + 6, y); doc.text('RX', M + 70, y); doc.text('DESCRIPTION', M + 134, y);
  y += 4; doc.setDrawColor(...BORDER); doc.line(M, y, W - M, y); y += 10;
  QR_BCM_CANDIDATES.forEach(([tx, rx, d], i) => {
    if (i % 2 === 0) { doc.setFillColor(...STRIPE); doc.rect(M, y - 9, W - 2 * M, 13, 'F'); }
    doc.setFont('courier', 'bold');
    doc.setTextColor(...ORANGE);
    doc.text('0x' + tx.toString(16).toUpperCase().padStart(3, '0'), M + 6, y);
    doc.setTextColor(...BLUE);
    doc.text('0x' + rx.toString(16).toUpperCase().padStart(3, '0'), M + 70, y);
    doc.setFont('Nunito', 'normal');
    doc.setTextColor(...INK);
    doc.text(d, M + 134, y);
    y += 13;
  });
  y += 8;

  sectionHeader('BCM SECURITY ALGORITHMS  (' + QR_ALGOS.length + ')');
  y += 2;
  doc.setFontSize(8.5);
  const colW = (W - 2 * M) / 2;
  const rows = Math.ceil(QR_ALGOS.length / 2);
  for (let i = 0; i < rows; i++) {
    if (i % 2 === 0) { doc.setFillColor(...STRIPE); doc.rect(M, y - 8, W - 2 * M, 12, 'F'); }
    [0, 1].forEach(col => {
      const idx = col * rows + i;
      if (idx >= QR_ALGOS.length) return;
      const [n, d] = QR_ALGOS[idx];
      const x = M + col * colW + 6;
      doc.setFont('Nunito', 'bold'); doc.setTextColor(...SR);
      doc.text(String(idx + 1).padStart(2, '0'), x, y);
      doc.setTextColor(...INK);
      doc.text(n, x + 18, y);
      doc.setFont('Nunito', 'normal'); doc.setTextColor(...SUB);
      doc.text(d, x + 100, y);
    });
    y += 12;
  }

  doc.setDrawColor(...BORDER);
  doc.line(M, H - 30, W - M, H - 30);
  doc.setFont('Nunito', 'normal'); doc.setFontSize(8);
  doc.setTextColor(...MUTE);
  doc.text('SRT Lab \u00B7 Bench Quick Reference \u00B7 For authorized service use only', M, H - 16);
  doc.text('srt_lab.py', W - M, H - 16, { align: 'right' });

  doc.save('SRT_Lab_Quick_Reference.pdf');
}
