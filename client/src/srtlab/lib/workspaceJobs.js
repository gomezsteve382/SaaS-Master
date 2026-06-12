/**
 * workspaceJobs.js — Single source of truth for the workspace navigation model.
 * Defines 6 "job doors" (READ, MARRY, KEYS, FLASH, LIVE, REFERENCE) and maps
 * all ~61 tabs to their parent job. The rail, drawer, mode-strip, and job-cards
 * all derive from this model — changes here propagate everywhere.
 */

export const JOBS = [
  {
    id: 'read',
    label: 'READ',
    sub: 'Parse · diagnose · inspect',
    primary: 'ipccluster',
    members: [
      'ipccluster', 'bcmconfig', 'rfhubconfig', 'pcmconfig',
      'bcmparse', 'rfhparse', 'pcmparse', 'immoparse',
      'proxi', 'canuniverse', 'patterns', 'sigdisc',
    ],
  },
  {
    id: 'marry',
    label: 'MARRY',
    sub: 'VIN · SEC · module sync',
    primary: 'secsync',
    members: [
      'secsync', 'vinsync', 'modsync', 'keyprog',
      'marrymodule',
    ],
  },
  {
    id: 'keys',
    label: 'KEYS',
    sub: 'RFHUB · immobilizer · programming',
    primary: 'keyxfer',
    members: [
      'keyxfer', 'keyprogram', 'rfhubkeytransplant',
      'immoprogram', 'gpec2aimmo',
    ],
  },
  {
    id: 'flash',
    label: 'FLASH',
    sub: 'Firmware · calibration · updates',
    primary: 'cdaj2534',
    members: [
      'cdaj2534', 'modulesync', 'twintab', 'flashtab',
      'fwupdate', 'calibupdate',
    ],
  },
  {
    id: 'live',
    label: 'LIVE',
    sub: 'Real-time · monitoring · diagnostics',
    primary: 'livedata',
    members: [
      'livedata', 'livediag', 'rfhubmonitor', 'bcmmonitor',
      'canmonitor', 'j2534monitor',
    ],
  },
  {
    id: 'ref',
    label: 'REFERENCE',
    sub: 'Backups · catalogs · research',
    primary: 'backups',
    members: [
      'backups', 'samples', 'workflow', 'investigation',
      'alfaobd', 'alfaintel', 'binintel', 'dispatchcov', 'unlockcov',
      'canuniverse', 'patterns', 'kg', 'sigdisc', 'cda6db', 'exttools',
    ],
  },
];

/**
 * The Diagnose landing. It is a HOME destination, not a job — pinned above the
 * job doors in the rail — so landing on it lights HOME, not a job door. It is
 * deliberately NOT a member of any job (JOB_OF.dumps is undefined), and is
 * excluded from the Advanced drawer (it's the home screen, not a tool).
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
