/**
 * workspaceJobs.js — Single source of truth for the workspace navigation model.
 * Defines 6 "job doors" (READ, MARRY, KEYS, FLASH, LIVE, REFERENCE) and maps
 * all ~61 tabs to their parent job. The rail, drawer, mode-strip, and job-cards
 * all derive from this model — changes here propagate everywhere.
 *
 * Tab IDs must match the `id` field in WORKSPACE_TABS (App.jsx).
 */

export const JOBS = [
  {
    id: 'read',
    label: 'READ',
    sub: 'Parse · diagnose · inspect',
    primary: 'dumps',
    members: [
      // Core dump analysis
      'dumps', 'inspector', 'bcmconfig', 'proxi',
      // Specialized dump readers
      'rfhdump', 'rfhub', 'bcm', 'ecm', 'smartbox',
      // Flash / binary analysis
      'flashbin', 'cflash', 'efd', 'efd2bin', 'efdiff', 'benchval',
      // Logs and traces
      'loganalyser', 'udsanalyzer',
    ],
  },
  {
    id: 'marry',
    label: 'MARRY',
    sub: 'VIN · SEC · module sync',
    primary: 'secsync',
    members: [
      // Core sync workflows
      'secsync', 'vinsync', 'modsync', 'marrymodule',
      // VIN programming
      'vinprog', 'keyprog',
      // BCM/PCM pairing
      'bcmpcmpair', 'immobcm56xb',
      // Quick wizard
      'quickclone',
    ],
  },
  {
    id: 'keys',
    label: 'KEYS',
    sub: 'RFHUB · immobilizer · programming',
    primary: 'keyxfer',
    members: [
      // Key programming and transfer
      'keyxfer', 'keytransplant', 'keyimporter', 'keymgr',
      // Transponder readers
      'hitagaes', 'hitag2',
      // Key writing and management
      'keywriter', 'livekey',
      // Seed/key algorithms
      'seed',
      // Immobilizer tools
      'skimlive', 'skim', 'jailbreak',
      // GPEC unlock
      'gpecunlock',
    ],
  },
  {
    id: 'flash',
    label: 'FLASH',
    sub: 'Firmware · calibration · updates',
    primary: 'flasher',
    members: [
      // ECM/PCM flashing
      'flasher', 'ipccluster',
      // CDA6 / UDS programming sessions
      'cdasession', 'cdadbtools',
      // Checksum and validation tools
      'checksum',
      // Radio codes
      'radiocodes',
      // External tools
      'exttools', 'witech',
    ],
  },
  {
    id: 'live',
    label: 'LIVE',
    sub: 'Real-time · OBD · J2534',
    primary: 'obd',
    members: [
      // Live OBD and UDS sessions
      'obd', 'uds-console', 'cda-j2534', 'autelsgw',
    ],
  },
  {
    id: 'ref',
    label: 'REFERENCE',
    sub: 'Backups · catalogs · research',
    primary: 'backups',
    members: [
      // History and samples
      'backups', 'samples', 'workflow',
      // AI and investigation
      'investigation',
      // AlfaOBD catalogs
      'alfaobd', 'alfaintel',
      // Coverage and dispatch
      'dispatchcov', 'unlockcov',
      // Knowledge and research
      'binintel', 'patterns', 'kg', 'sigdisc', 'canuniverse',
      // Firmware emulation
      'fwemul',
    ],
  },
];

/**
 * The Diagnose landing. It is a HOME destination, not a job — pinned above the
 * job doors in the rail — so landing on it lights HOME, not a job door. It is
 * deliberately NOT a member of any job (JOB_OF.dumps is undefined), and is
 * excluded from the Advanced drawer (it's the home screen, not a tool).
 *
 * NOTE: 'dumps' is also listed in the READ job so it appears in the drawer.
 * The HOME constant is used by the rail to render the special HOME button.
 */
export const HOME = { key: 'dumps', label: 'Diagnose', sub: 'Drop → verdict → fix' };

/**
 * Rail / drawer order.
 */
export const JOB_ORDER = JOBS.map((j) => j.id);

/**
 * tab id → job id. Falls back to 'ref' (REFERENCE) so a newly-added tab is
 * always reachable instead of silently vanishing from the drawer.
 */
export const JOB_OF = (() => {
  const m = {};
  for (const j of JOBS) for (const id of j.members) m[id] = j.id;
  return m;
})();

/**
 * job id → its definition.
 */
export const JOB_BY_ID = Object.fromEntries(JOBS.map((j) => [j.id, j]));

/**
 * job id → display label (one name per job, used by rail + drawer + cards).
 */
export const JOB_LABEL = Object.fromEntries(JOBS.map((j) => [j.id, j.label]));

/**
 * Resolve the job a tab belongs to (falls back to REFERENCE so a newly-added
 * tab is always reachable instead of silently vanishing from the drawer).
 */
export function jobOf(tabId) {
  return JOB_OF[tabId] || 'ref';
}
