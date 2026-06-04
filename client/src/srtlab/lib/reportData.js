/**
 * reportData.js — pure marshalling helpers for PDF report generation.
 *
 * `buildModuleReportData(mod, entry?)` → typed structure consumed by
 *   buildAnalysisPDF.buildModulePDF().
 *
 * `buildJobReportData(job)` → typed structure consumed by
 *   buildAnalysisPDF.buildJobPDF().
 *
 * Both functions are pure (no side-effects, no imports from jspdf) so they
 * can be tested independently with Vitest.
 */

import { TL } from './constants.js';

/**
 * Format a Date or ISO string as a compact "YYYYMMDD-HHmm" token for filenames.
 * Falls back to 'unknown' if the value is missing or unparseable.
 */
export function fmtFilenameTs(ts) {
  if (!ts) return 'unknown';
  try {
    const d = ts instanceof Date ? ts : new Date(ts);
    if (isNaN(d.getTime())) return 'unknown';
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  } catch {
    return 'unknown';
  }
}

/**
 * Produce a human-readable display name for a module type code.
 */
function typeName(type) {
  return TL[type] || type || 'Unknown Module';
}

/**
 * Build the report-data structure for a single loaded module dump.
 *
 * @param {object} mod   - parseModule() output (the canonical module record)
 * @param {object} [entry] - loadedDumps entry (for source provenance)
 * @returns {object}
 */
export function buildModuleReportData(mod, entry) {
  if (!mod) throw new Error('buildModuleReportData: mod is required');

  const now = new Date();
  const vin = mod.vins?.[0]?.vin ?? null;
  const fileId = (mod.filename ?? 'module').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]/g, '_');
  const tsToken = fmtFilenameTs(now);
  const filename = `srtlab-${vin ?? fileId}-${tsToken}.pdf`;

  // Build the fields table rows (mirrors the inspector Overview tab table)
  const fields = [];

  if (mod.vins) {
    mod.vins.forEach((v, i) => {
      fields.push({
        offset: `0x${v.offset.toString(16).toUpperCase().padStart(4, '0')}`,
        category: `VIN ${i + 1}`,
        value: v.vin,
        detail: '17B ASCII',
      });
    });
  }

  if (mod.skimStatus != null) {
    fields.push({
      offset: '0x0011',
      category: 'SKIM',
      value: `0x${mod.skimByte.toString(16).toUpperCase()} — ${mod.skimStatus}`,
      detail: 'Immobilizer byte',
    });
  }

  if (mod.secretKey) {
    fields.push({
      offset: `0x${mod.secretKey.offset.toString(16).toUpperCase().padStart(4, '0')}`,
      category: 'SECRET KEY',
      value: mod.secretKey.hex,
      detail: `8B sync key ${mod.keyConsistent ? 'consistent' : 'INCONSISTENT'}`,
    });
  }

  if (mod.vehicleSecret) {
    fields.push({
      offset: `0x${mod.vehicleSecret.offset.toString(16).toUpperCase().padStart(4, '0')}`,
      category: 'VEHICLE SECRET',
      value: mod.vehicleSecret.hex,
      detail: `${mod.vehicleSecret.endian}-endian 16B`,
    });
  }

  if (mod.transponderKeys) {
    mod.transponderKeys.forEach((tk, i) => {
      fields.push({
        offset: `0x${tk.offset.toString(16).toUpperCase().padStart(4, '0')}`,
        category: `FOBIK ${i + 1}`,
        value: tk.hex,
        detail: 'Transponder',
      });
    });
  }

  if (mod.immoKeys) {
    mod.immoKeys.forEach((ik, i) => {
      fields.push({
        offset: `0x${ik.offset.toString(16).toUpperCase().padStart(4, '0')}`,
        category: `IMMO ${i + 1}`,
        value: ik.hex,
        detail: 'IMMO entry',
      });
    });
  }

  if (mod.zzzzTamper) {
    fields.push({
      offset: `0x${mod.zzzzTamper.offset.toString(16).toUpperCase().padStart(4, '0')}`,
      category: 'TAMPER',
      value: `${mod.zzzzTamper.hex} — ${mod.zzzzTamper.intact ? 'INTACT' : 'CLEARED'}`,
      detail: 'ZZZZ marker',
    });
  }

  if (mod.securityLock) {
    fields.push({
      offset: '0x8028',
      category: 'LOCK',
      value: `0x${mod.securityLock.value.toString(16).toUpperCase()} — ${mod.securityLock.locked ? 'LOCKED' : 'UNLOCKED'}`,
      detail: 'BCM security lock',
    });
  }

  if (mod.fobikSlots !== undefined) {
    fields.push({
      offset: '0x0880',
      category: 'FOBIK SLOTS',
      value: String(mod.fobikSlots),
      detail: 'CC66AA55 RFHUB slots',
    });
  }

  if (mod.fobikCount !== undefined) {
    fields.push({
      offset: '0x5862',
      category: 'FOBIK KEYS',
      value: String(mod.fobikCount),
      detail: 'BCM key count',
    });
  }

  if (mod.partNumbers) {
    Object.entries(mod.partNumbers).forEach(([k, v]) => {
      fields.push({
        offset: '—',
        category: `PN-${k.toUpperCase()}`,
        value: String(v),
        detail: 'Part number',
      });
    });
  }

  if (mod.partNumberStr) {
    fields.push({
      offset: '0x0FA1',
      category: 'SW RELEASE',
      value: mod.partNumberStr,
      detail: 'Software release ID',
    });
  }

  if (mod.runtimeCounters) {
    Object.entries(mod.runtimeCounters).forEach(([k, v]) => {
      fields.push({
        offset: `0x${v.offset.toString(16).toUpperCase().padStart(4, '0')}`,
        category: `CTR: ${k}`,
        value: `${v.hex} (${v.value.toLocaleString()})`,
        detail: 'Runtime counter',
      });
    });
  }

  // Secrets-scan summary (any non-null security fields)
  const hasSecrets = !!(
    mod.secretKey || mod.vehicleSecret ||
    (mod.transponderKeys && mod.transponderKeys.length > 0) ||
    (mod.immoKeys && mod.immoKeys.length > 0)
  );

  return {
    kind: 'module',
    filename,
    title: typeName(mod.type),
    sourceFile: mod.filename ?? 'unknown',
    type: mod.type ?? 'UNKNOWN',
    size: mod.size ?? (mod.data ? mod.data.length : 0),
    vin,
    vins: (mod.vins ?? []).map(v => v.vin),
    source: entry?.source ?? null,
    fields,
    hasSecrets,
    warnings: [
      ...(mod.sizeWarn ? [mod.sizeWarn.msg ?? 'Non-canonical size'] : []),
      ...(mod.contentWarn ? [mod.contentWarn.msg ?? 'Content validation warning'] : []),
    ],
    generatedAt: now.toISOString(),
  };
}

/**
 * Build the report-data structure for a completed (or in-progress) vehicle job.
 *
 * @param {object} job     - vehicle job record (from /api/vehicle-jobs/:id)
 * @param {object} [opts]  - { results } — in-memory step results map from WorkflowTab state
 * @returns {object}
 */
export function buildJobReportData(job, opts = {}) {
  if (!job) throw new Error('buildJobReportData: job is required');

  const { results = {} } = opts;
  const now = new Date();
  const vin = job.vin ?? null;
  const tsToken = fmtFilenameTs(now);
  const safeVin = (vin ?? job.id ?? 'job').replace(/[^A-Za-z0-9_-]/g, '_');
  const filename = `srtlab-${safeVin}-${tsToken}.pdf`;

  // Census rows
  const censusRows = (job.census?.rows ?? []).map(r => ({
    code: r.code ?? '—',
    name: r.name ?? r.reason ?? '—',
    kind: r.kind ?? '—',
    vin: r.dump?.mod?.vins?.[0]?.vin ?? null,
  }));

  // Fix-plan steps merged with any in-memory results (WorkflowTab state wins)
  const steps = (job.fixPlan?.steps ?? []).map(s => {
    const res = results[s.id] ?? null;
    return {
      id: s.id,
      label: s.label,
      action: s.action,
      module: s.module ?? null,
      notes: s.notes ?? null,
      status: res?.status ?? 'pending',
      note: res?.note ?? null,
      finishedAt: res?.finishedAt ?? null,
    };
  });

  const blockers = job.fixPlan?.blockers ?? [];

  // Sign-off summary
  const signOff = job.signOff ?? null;

  // Audit events — sort ascending by timestamp so the PDF reads chronologically.
  // The API returns events newest-first; sorting by ts handles both orderings.
  const events = (job.events ?? [])
    .slice()
    .sort((a, b) => {
      const ta = a.ts ? new Date(a.ts).getTime() : 0;
      const tb = b.ts ? new Date(b.ts).getTime() : 0;
      return ta - tb;
    })
    .map(ev => ({
      ts: ev.ts ?? null,
      kind: ev.kind ?? '—',
      module: ev.module ?? null,
      payload: ev.payload ?? null,
    }));

  // Step totals
  const total = steps.length;
  const completed = steps.filter(s => s.status === 'ok').length;
  const failed = steps.filter(s => s.status === 'fail').length;
  const skipped = steps.filter(s => s.status === 'skipped').length;
  const pending = steps.filter(s => s.status === 'pending').length;

  return {
    kind: 'job',
    filename,
    title: job.title ?? job.id ?? 'Vehicle Job',
    jobId: job.id ?? null,
    vin,
    status: job.status ?? '—',
    createdAt: job.createdAt ?? null,
    updatedAt: job.updatedAt ?? null,
    censusRows,
    steps,
    blockers,
    totals: { total, completed, failed, skipped, pending },
    signOff,
    events,
    generatedAt: now.toISOString(),
  };
}
