/* ─────────────────────────────────────────────────────────────────────────
 * Workspace JOB MODEL — single source of truth for the back-end navigation.
 *
 * The tool has ~60 workspace tabs. Left on their own they sprawl into three
 * competing menus (rail / cards / drawer) that each name the same operation
 * differently. This file collapses them into SIX "job doors" — the things a
 * tech actually sits down to do:
 *
 *     READ · MARRY · KEYS · FLASH · LIVE · REFERENCE
 *
 * Every workspace tab id belongs to exactly one job. Opening a door lands you
 * on its `primary` tab; the door's `members` become the mode-strip at the top
 * of that workspace. The rail, the landing cards, and the Advanced/Reference
 * drawer all read their labels from here, so one job wears ONE name everywhere.
 *
 * Membership reuses the maintainer's own WORKSPACE_CATEGORIES grouping, with
 * two adjustments agreed in the UI rebuild: KEYS is split out of MARRY, and the
 * old DATA + INTEL buckets fold together under REFERENCE (research/catalog
 * surfaces a bench tech opens rarely).
 * ──────────────────────────────────────────────────────────────────────── */

export const JOBS = [
  {
    id: 'read',
    label: 'READ MODULE',
    sub: 'Parse one module image',
    primary: 'inspector',
    members: ['inspector', 'bcm', 'rfhub', 'ecm', 'skim', 'skimlive',
              'smartbox', 'immobcm56xb', 'bcmconfig', 'proxi'],
  },
  {
    id: 'marry',
    label: 'MARRY / SYNC',
    sub: 'Pair a module into a set',
    primary: 'secsync',
    members: ['secsync', 'vinsync', 'modsync'],
  },
  {
    id: 'keys',
    label: 'KEYS',
    sub: 'Program · transfer · PIN',
    primary: 'keyprog',
    members: ['keyprog', 'keyxfer', 'keymgr', 'livekey',
              'keywriter', 'radiocodes', 'seed', 'jailbreak'],
  },
  {
    id: 'flash',
    label: 'FLASH',
    sub: 'Patch · program firmware',
    primary: 'flasher',
    members: ['flasher', 'cflash', 'gpecunlock', 'efd', 'efd2bin',
              'fwemul', 'vinprog', 'cdasession'],
  },
  {
    id: 'live',
    label: 'LIVE OBD',
    sub: 'Connected UDS sessions',
    primary: 'obd',
    members: ['obd', 'uds-console', 'udsanalyzer', 'loganalyser'],
  },
  {
    id: 'ref',
    label: 'REFERENCE',
    sub: 'Backups · catalogs · research',
    primary: 'backups',
    members: ['backups', 'samples', 'workflow', 'investigation',
              'alfaobd', 'alfaintel', 'binintel', 'dispatchcov', 'unlockcov',
              'canuniverse', 'patterns', 'kg', 'sigdisc', 'cda6db', 'exttools'],
  },
];

/* The Diagnose landing. It is a HOME destination, not a job — pinned above the
 * job doors in the rail — so landing on it lights HOME, not a job door. It is
 * deliberately NOT a member of any job (JOB_OF.dumps is undefined), and is
 * excluded from the Advanced drawer (it's the home screen, not a tool). */
export const HOME = { key: 'dumps', label: 'Diagnose', sub: 'Drop → verdict → fix' };

/* Rail / drawer order. */
export const JOB_ORDER = JOBS.map((j) => j.id);

/* tab id → job id. */
export const JOB_OF = (() => {
  const m = {};
  for (const j of JOBS) for (const id of j.members) m[id] = j.id;
  return m;
})();

/* job id → its definition. */
export const JOB_BY_ID = Object.fromEntries(JOBS.map((j) => [j.id, j]));

/* job id → display label (one name per job, used by rail + drawer + cards). */
export const JOB_LABEL = Object.fromEntries(JOBS.map((j) => [j.id, j.label]));

/* Resolve the job a tab belongs to (falls back to REFERENCE so a newly-added
 * tab is always reachable instead of silently vanishing from the drawer). */
export function jobOf(tabId) {
  return JOB_OF[tabId] || 'ref';
}
