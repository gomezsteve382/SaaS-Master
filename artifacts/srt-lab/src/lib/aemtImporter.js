/* ============================================================================
 * aemtImporter.js — ingests AEMT-style job bundles (zip or loose files) and
 * converts them to native SRT Lab Key Prog presets + optional pre-write
 * backup stubs.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  AEMT BUNDLE CONTRACT (what we recognise)                               │
 * │                                                                         │
 * │  ZIP format  (.zip extension, passed as a single File/Uint8Array)       │
 * │    aemt_job.zip/                                                        │
 * │      BCM.bin | bcm_dump.bin | bcm.bin   (BCM D-FLASH, 8–128 KB)        │
 * │      RFHUB.bin | RFH.bin | rfh_dump.bin (RFHUB EEE, 2–8 KB)            │
 * │      PCM.bin | pcm_dump.bin | gpec2a.bin (GPEC2A, 4 or 8 KB)           │
 * │      job.json | profile.json | aemt.json | *.aemt | *.json              │
 * │        → { "vin": "<17-char>" }                                         │
 * │        or { "vehicle": { "vin": "…" } }                                 │
 * │        or { "job": { "vin": "…" } }                                     │
 * │                                                                         │
 * │  Loose files  (File[] from drag/drop or <input multiple>)               │
 * │    Any combination of the .bin files above + optional metadata file.    │
 * │    A .zip encountered in the loose list is transparently expanded.      │
 * │                                                                         │
 * │  Module role assignment                                                 │
 * │    Primary: identifyModule() — reads the binary header (most reliable)  │
 * │    Fallback: filename heuristic — BCM/RFH/RFHUB/PCM/GPEC2A keyword     │
 * │                                                                         │
 * │  VIN extraction order                                                   │
 * │    1. metadata JSON fields: vin · VIN · vehicle.vin · job.vin           │
 * │    2. BCM binary: info.vins[0].vin from identifyModule result           │
 * │    3. RFH binary: info.vins[0].vin from identifyModule result           │
 * │    4. Return null → caller must prompt the user for the VIN             │
 * │                                                                         │
 * │  To add new AEMT metadata schemas: extend extractVinFromMeta() below.   │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Exports:
 *   parseAemtBundle(rawFiles: {name:string, data:Uint8Array}[])
 *     → { roles:{BCM,RFH,PCM}, vin:string|null, meta:object|null, warnings:string[] }
 *       roles fields: { name:string, data:Uint8Array } | null
 *
 *   buildAemtPreset({ roles, vin, importName })
 *     → serialised preset object (v1 schema, same as serializePreset output)
 *       Note: checks are run via runKeyProgPatch; result captured regardless
 *       of pass/fail so the preset stores accurate badge state.
 *
 *   buildAemtBackupStubs({ roles, vin, timestamp })
 *     → array of { key, meta, payload } ready for the backup-index write path
 *       (follows the same shape as saveScanPlaceholders output)
 *
 *   AemtImportError — subclass of Error with a `details` array for per-issue
 *       messages shown in the error modal.
 * ============================================================================ */

import { unzipSync } from 'fflate';
import { identifyModule, runKeyProgPatch } from './keyProgWizard.js';
import { bytesToB64 } from './keyProgPresets.js';
import { getRow } from './moduleRegistry.js';

const BACKUP_KEY_PREFIX = 'srtlab_backup_';

/* ──── Error class ──── */

export class AemtImportError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'AemtImportError';
    this.details = details;
  }
}

/* ──── Filename heuristics (fallback when binary detection gives role=null) ──── */

function roleFromFilename(name) {
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (/bcm/.test(n)) return 'BCM';
  if (/rfhub|rfhb|rfh/.test(n)) return 'RFH';
  if (/gpec2a|pcm/.test(n)) return 'PCM';
  return null;
}

/* ──── VIN helpers ──── */

const VIN_RE = /^[1-9A-HJ-NPR-Z][0-9A-HJ-NPR-Z]{16}$/;

function cleanVin(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const v = raw.toUpperCase().trim().replace(/[^A-HJ-NPR-Z0-9]/g, '');
  return v.length === 17 && VIN_RE.test(v) ? v : null;
}

function extractVinFromMeta(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const candidates = [
    obj.vin, obj.VIN, obj.Vin,
    obj.vehicle?.vin, obj.vehicle?.VIN,
    obj.job?.vin, obj.job?.VIN,
    obj.profile?.vin, obj.profile?.VIN,
    obj.data?.vin, obj.data?.VIN,
  ];
  for (const c of candidates) {
    const v = cleanVin(c);
    if (v) return v;
  }
  return null;
}

function extractVinFromModuleInfo(id) {
  const vins = id?.info?.vins;
  if (!Array.isArray(vins) || vins.length === 0) return null;
  return cleanVin(vins[0].vin);
}

/* ──── ZIP expansion ──── */

function expandZip(data) {
  const files = [];
  try {
    const entries = unzipSync(data);
    for (const [path, bytes] of Object.entries(entries)) {
      const namePart = path.split('/').filter(Boolean).pop();
      if (!namePart) continue;
      if (namePart.startsWith('.') || namePart.startsWith('__MACOSX')) continue;
      files.push({ name: namePart, data: bytes });
    }
  } catch (e) {
    throw new AemtImportError('Could not open ZIP: ' + e.message, [
      'Make sure the file is a valid .zip export from AEMT.',
      'Error detail: ' + e.message,
    ]);
  }
  return files;
}

/* ──── Core bundle parser ──── */

/**
 * parseAemtBundle — accepts an array of raw {name, data:Uint8Array} entries.
 * ZIP files in the list are transparently expanded. Returns recognised roles,
 * extracted VIN, raw metadata object, and a warnings list. Throws
 * AemtImportError with descriptive details on unrecoverable failures.
 */
export function parseAemtBundle(rawFiles) {
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    throw new AemtImportError('No files provided.', ['Pass at least one .bin or .zip file.']);
  }

  /* Expand any ZIPs; collect all flat {name, data} entries. */
  const flat = [];
  for (const f of rawFiles) {
    if (!f.data || !(f.data instanceof Uint8Array)) {
      throw new AemtImportError(
        'File "' + f.name + '" has no binary data.',
        ['Each file must be loaded as a Uint8Array before passing to parseAemtBundle.'],
      );
    }
    const lower = (f.name || '').toLowerCase();
    if (lower.endsWith('.zip')) {
      flat.push(...expandZip(f.data));
    } else {
      flat.push(f);
    }
  }

  if (flat.length === 0) {
    throw new AemtImportError('ZIP contained no usable files.', [
      'The ZIP must include at least one .bin module dump.',
    ]);
  }

  /* Separate metadata (JSON/.aemt) from binary dumps. */
  const metaFiles = [];
  const binFiles = [];
  for (const f of flat) {
    const lower = (f.name || '').toLowerCase();
    if (lower.endsWith('.json') || lower.endsWith('.aemt')) {
      metaFiles.push(f);
    } else if (lower.endsWith('.bin') || lower.endsWith('.BIN')) {
      binFiles.push(f);
    }
    /* Silently ignore unrecognised file types (e.g. AEMT exe/dll/txt). */
  }

  /* Parse metadata — try each metadata file in order. */
  let meta = null;
  for (const mf of metaFiles) {
    try {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(mf.data);
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        meta = parsed;
        break;
      }
    } catch {
      /* skip malformed JSON */
    }
  }

  if (binFiles.length === 0) {
    throw new AemtImportError(
      'No .bin module dump files found in the bundle.',
      [
        'Expected at least one of: BCM.bin, RFHUB.bin / RFH.bin, PCM.bin.',
        metaFiles.length > 0
          ? 'Found ' + metaFiles.length + ' metadata file(s) but no .bin dumps.'
          : 'The bundle appears to contain no recognised files.',
      ],
    );
  }

  /* Identify each binary's module role. */
  const roles = { BCM: null, RFH: null, PCM: null };
  const conflicts = {};
  const warnings = [];
  const unmatched = [];

  for (const f of binFiles) {
    let role = null;
    let idInfo = null;

    /* Primary: binary-header detection. */
    try {
      const id = identifyModule(f.data, f.name);
      if (id.role) {
        role = id.role;
        idInfo = id;
      }
    } catch {
      /* identifyModule can throw on corrupt data — fall through to filename. */
    }

    /* Fallback: filename heuristic. */
    if (!role) {
      role = roleFromFilename(f.name);
    }

    if (!role) {
      unmatched.push(f.name);
      continue;
    }

    if (roles[role]) {
      /* Collision: keep the one that identifyModule recognised; warn about dupe. */
      if (idInfo) {
        warnings.push(
          'Duplicate ' + role + ' file: "' + roles[role].name + '" vs "' + f.name + '". '
          + 'Using "' + f.name + '" (recognised by binary header).',
        );
        roles[role] = { name: f.name, data: f.data, _id: idInfo };
      } else {
        warnings.push(
          'Duplicate ' + role + ' file: "' + f.name + '" ignored (keeping "' + roles[role].name + '").',
        );
        if (!conflicts[role]) conflicts[role] = [];
        conflicts[role].push(f.name);
      }
    } else {
      roles[role] = { name: f.name, data: f.data, _id: idInfo };
    }
  }

  if (unmatched.length > 0) {
    warnings.push(
      'Skipped ' + unmatched.length + ' unrecognised .bin file(s): ' + unmatched.join(', ') + '.',
    );
  }

  /* Extract VIN. */
  let vin = null;

  /* 1. Metadata JSON */
  if (meta) vin = extractVinFromMeta(meta);

  /* 2. BCM binary */
  if (!vin && roles.BCM?._id) {
    vin = extractVinFromModuleInfo(roles.BCM._id);
  }

  /* 3. RFH binary */
  if (!vin && roles.RFH?._id) {
    vin = extractVinFromModuleInfo(roles.RFH._id);
  }

  /* Clean up internal _id field from the role objects before returning. */
  const cleanRoles = {};
  for (const [k, v] of Object.entries(roles)) {
    if (!v) { cleanRoles[k] = null; continue; }
    cleanRoles[k] = { name: v.name, data: v.data };
  }

  return { roles: cleanRoles, vin, meta, warnings };
}

/* ──── Preset builder ──── */

/**
 * buildAemtPreset — takes the parsed roles + a confirmed VIN and produces a
 * v1-schema preset object. Runs the wizard checks pipeline so the stored
 * checksAllGreen flag is accurate. The VIN must be 17 chars (caller is
 * responsible for prompting the user if parseAemtBundle returned null).
 *
 * Throws AemtImportError if a required module is missing.
 */
export function buildAemtPreset({ roles, vin, importName }) {
  if (!vin || vin.length !== 17) {
    throw new AemtImportError(
      'VIN is required to build a preset.',
      ['The bundle did not contain a readable VIN. Enter it manually when prompted.'],
    );
  }

  const missing = ['BCM', 'RFH', 'PCM'].filter((r) => !roles[r]);
  if (missing.length > 0) {
    throw new AemtImportError(
      'Missing required module dump(s): ' + missing.join(', ') + '.',
      missing.map((r) => r + ' module dump was not found in the bundle.'),
    );
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  const name = importName
    || ('AEMT import \u2014 ' + vin + ' \u2014 ' + dateStr);

  /* Serialize files to dataB64. */
  const files = {};
  for (const role of ['BCM', 'RFH', 'PCM']) {
    const f = roles[role];
    files[role] = { name: f.name, dataB64: bytesToB64(f.data) };
  }

  /* Run wizard checks — a throw here means the binary data is corrupt or
   * incompatible; surface it as a hard AemtImportError rather than silently
   * recording 0/0 checks (which would let a bad preset through). */
  let checks = [];
  let checksPassed = 0;
  let checksTotal = 0;
  let checksAllGreen = false;

  try {
    const result = runKeyProgPatch({
      bcm: roles.BCM, rfh: roles.RFH, pcm: roles.PCM, vin, promoteBank: false,
    });
    if (Array.isArray(result.checks)) {
      checks = result.checks.map((c) => ({
        label: String(c.label || ''),
        pass: !!c.pass,
        detail: c.detail ? String(c.detail) : '',
      }));
      checksPassed = checks.filter((c) => c.pass).length;
      checksTotal = checks.length;
      checksAllGreen = checksTotal > 0 && checks.every((c) => c.pass);
    }
  } catch (err) {
    throw new AemtImportError(
      'Module validation failed — the dump data may be corrupt or incompatible.',
      [
        'runKeyProgPatch: ' + (err.message || String(err)),
        'Verify that each .bin file is a clean, full-length read of the correct module.',
        'BCM: D-FLASH (8–128 KB), RFHUB: EEE (2–8 KB), PCM: GPEC2A (4 or 8 KB).',
      ],
    );
  }

  const id = 'kp_aemt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);

  return {
    id,
    name,
    vin,
    createdAt: new Date().toISOString(),
    files,
    checks,
    checksPassed,
    checksTotal,
    checksAllGreen,
    source: 'aemt-import',
  };
}

/* ──── Backup stub builder ──── */

/**
 * buildAemtBackupStubs — creates synthetic pre-write backup entries from AEMT
 * module dumps. These follow the same shape as backupModule() output so
 * the Restore flow can consume them. We populate VIN DID 0xF190 from the
 * binary where available; all other DIDs are marked missing (no live OBD).
 *
 * Returns an array of { key, meta, payload } objects. The caller writes
 * them to localStorage and POSTs them to /api/backups.
 */
export function buildAemtBackupStubs({ roles, vin, timestamp }) {
  const ts = timestamp || new Date().toISOString();
  const stubs = [];

  /* role → moduleRegistry code.
   * BCM  → BCM  (tx:0x750, rx:0x758)
   * RFH  → RFHUB (tx:0x75F, rx:0x767)
   * PCM  → ECM  (tx:0x7E0, rx:0x7E8)  */
  const moduleMap = {
    BCM: 'BCM',
    RFH: 'RFHUB',
    PCM: 'ECM',
  };

  const hx = (n, w = 2) => n.toString(16).toUpperCase().padStart(w, '0');

  for (const [role, moduleCode] of Object.entries(moduleMap)) {
    const f = roles[role];
    if (!f) continue;

    /* Look up the canonical CAN address from the module registry so the
     * resulting stub is compatible with the existing OBD restore pipeline. */
    const regRow = getRow(moduleCode);
    const tx = regRow?.tx ?? null;
    const rx = regRow?.rx ?? null;

    const dids = {};
    const safeVin = vin || 'unknown';

    /* DID 0xF190 — VIN */
    if (safeVin && safeVin !== 'unknown') {
      const bytes = Array.from(safeVin).map((c) => c.charCodeAt(0) & 0xFF);
      dids[0xF190] = {
        name: 'VIN',
        critical: true,
        hex: bytes.map((b) => hx(b)).join(''),
        ascii: safeVin,
        bytes,
      };
    }

    const key = BACKUP_KEY_PREFIX + moduleCode + '_' + safeVin + '_aemt' + Date.now()
      + '_' + role.toLowerCase();

    const payload = {
      module: moduleCode,
      tx,
      rx,
      timestamp: ts,
      placeholder: true,
      snapshotKind: 'pre-write',
      preWriteKey: key,
      source: 'aemt-import',
      aemtFile: f.name,
      dids,
    };

    const meta = {
      key,
      id: key,
      module: moduleCode,
      vin: safeVin,
      timestamp: ts,
      didCount: Object.keys(dids).length,
      tx,
      rx,
      placeholder: true,
      snapshotKind: 'pre-write',
      preWriteKey: key,
      source: 'aemt-import',
    };

    stubs.push({ key, meta, payload });
  }

  return stubs;
}

/* ──── High-level driver (used by UI handlers) ──── */

/**
 * importAemtBundle — end-to-end: parse → prompt VIN if needed → build preset
 * + backup stubs → write to localStorage + /api/backups + /api/key-prog-... etc.
 *
 * This is a pure logic function; all storage writes are delegated back to the
 * caller via the returned result so the UI layers (KeyProgTab, BackupsTab) can
 * use their existing write-through paths without this module needing to import
 * them (which would create a circular dependency).
 *
 * @param rawFiles  {name, data:Uint8Array}[]
 * @param opts.importName   optional preset name override
 * @param opts.promptVin    async (partialInfo) => string|null — called when VIN
 *                          cannot be auto-detected; return null to abort
 *
 * @returns {
 *   preset,          // v1 preset object (not yet written to storage)
 *   backupStubs,     // [{key, meta, payload}] (not yet written to storage)
 *   vin,
 *   roles,
 *   warnings,
 *   checksAllGreen,
 *   checksPassed,
 *   checksTotal,
 * }
 */
export async function importAemtBundle(rawFiles, { importName, promptVin } = {}) {
  const { roles, vin: detectedVin, meta, warnings } = parseAemtBundle(rawFiles);

  let vin = detectedVin;

  if (!vin && typeof promptVin === 'function') {
    vin = await promptVin({ roles, meta, warnings });
    if (!vin) {
      const cancelErr = new AemtImportError(
        'Import cancelled — VIN is required.',
        ['A 17-character VIN is needed to create a Key Prog preset.'],
      );
      cancelErr.cancelled = true;
      throw cancelErr;
    }
  }

  if (!vin) {
    throw new AemtImportError(
      'VIN not found in bundle.',
      [
        'The bundle metadata did not contain a VIN, and none could be read from the module files.',
        'Enter the VIN manually in the import dialog.',
      ],
    );
  }

  const preset = buildAemtPreset({ roles, vin, importName });
  const backupStubs = buildAemtBackupStubs({ roles, vin });

  return {
    preset,
    backupStubs,
    vin,
    roles,
    warnings,
    checksAllGreen: preset.checksAllGreen,
    checksPassed: preset.checksPassed,
    checksTotal: preset.checksTotal,
  };
}
