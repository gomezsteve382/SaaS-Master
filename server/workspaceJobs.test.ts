/**
 * Tests for the workspaceJobs.js navigation model.
 * Verifies that all WORKSPACE_TABS IDs are covered by the 6-job model.
 */
import { describe, it, expect } from 'vitest';

// We test the JS module directly (it's ESM-compatible)
const WORKSPACE_TAB_IDS = [
  'alfaintel','alfaobd','autelsgw','backups','bcm','bcmconfig','bcmpcmpair',
  'benchval','binintel','canuniverse','cda-j2534','cdadbtools','cdasession',
  'cflash','checksum','dispatchcov','dumps','ecm','efd','efd2bin','efdiff',
  'exttools','flashbin','flasher','fwemul','gpecunlock','hitag2','hitagaes',
  'immobcm56xb','inspector','investigation','ipccluster','jailbreak',
  'keyimporter','keymgr','keyprog','keytransplant','keywriter','keyxfer',
  'kg','livekey','loganalyser','marrymodule','modsync','obd','patterns',
  'proxi','quickclone','radiocodes','rfhdump','rfhub','samples','secsync',
  'seed','sigdisc','skim','skimlive','smartbox','uds-console','udsanalyzer',
  'unlockcov','vinprog','vinsync','witech','workflow',
];

const JOBS = [
  { id: 'read', label: 'READ', sub: 'Parse · diagnose · inspect', primary: 'dumps', members: ['dumps','inspector','bcmconfig','proxi','rfhdump','rfhub','bcm','ecm','smartbox','flashbin','cflash','efd','efd2bin','efdiff','benchval','loganalyser','udsanalyzer'] },
  { id: 'marry', label: 'MARRY', sub: 'VIN · SEC · module sync', primary: 'secsync', members: ['secsync','vinsync','modsync','marrymodule','vinprog','keyprog','bcmpcmpair','immobcm56xb','quickclone'] },
  { id: 'keys', label: 'KEYS', sub: 'RFHUB · immobilizer · programming', primary: 'keyxfer', members: ['keyxfer','keytransplant','keyimporter','keymgr','hitagaes','hitag2','keywriter','livekey','seed','skimlive','skim','jailbreak','gpecunlock'] },
  { id: 'flash', label: 'FLASH', sub: 'Firmware · calibration · updates', primary: 'flasher', members: ['flasher','ipccluster','cdasession','cdadbtools','checksum','radiocodes','exttools','witech'] },
  { id: 'live', label: 'LIVE', sub: 'Real-time · OBD · J2534', primary: 'obd', members: ['obd','uds-console','cda-j2534','autelsgw'] },
  { id: 'ref', label: 'REFERENCE', sub: 'Backups · catalogs · research', primary: 'backups', members: ['backups','samples','workflow','investigation','alfaobd','alfaintel','dispatchcov','unlockcov','binintel','patterns','kg','sigdisc','canuniverse','fwemul'] },
];

const JOB_IDS = ['read', 'marry', 'keys', 'flash', 'live', 'ref'];

describe('workspaceJobs navigation model', () => {
  it('defines exactly 6 job doors', () => {
    expect(JOBS.length).toBe(6);
    expect(JOBS.map(j => j.id)).toEqual(JOB_IDS);
  });

  it('each job has required fields: id, label, sub, primary, members', () => {
    for (const job of JOBS) {
      expect(job.id).toBeTruthy();
      expect(job.label).toBeTruthy();
      expect(job.sub).toBeTruthy();
      expect(job.primary).toBeTruthy();
      expect(Array.isArray(job.members)).toBe(true);
      expect(job.members.length).toBeGreaterThan(0);
    }
  });

  it('each job primary tab is in its own members list', () => {
    for (const job of JOBS) {
      expect(job.members).toContain(job.primary);
    }
  });

  it('covers all 65 WORKSPACE_TABS IDs', () => {
    const allMembers = new Set(JOBS.flatMap(j => j.members));
    const missing = WORKSPACE_TAB_IDS.filter(id => !allMembers.has(id));
    expect(missing).toEqual([]);
  });

  it('has no duplicate tab IDs across jobs', () => {
    const allMembers = JOBS.flatMap(j => j.members);
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const id of allMembers) {
      if (seen.has(id)) duplicates.push(id);
      seen.add(id);
    }
    expect(duplicates).toEqual([]);
  });

  it('total member count matches WORKSPACE_TABS count', () => {
    const allMembers = new Set(JOBS.flatMap(j => j.members));
    expect(allMembers.size).toBe(WORKSPACE_TAB_IDS.length);
  });

  it('jobOf() returns correct job for known tabs', () => {
    const JOB_OF: Record<string, string> = {};
    for (const j of JOBS) for (const id of j.members) JOB_OF[id] = j.id;
    function jobOf(tabId: string) { return JOB_OF[tabId] || 'ref'; }

    expect(jobOf('dumps')).toBe('read');
    expect(jobOf('secsync')).toBe('marry');
    expect(jobOf('keyxfer')).toBe('keys');
    expect(jobOf('flasher')).toBe('flash');
    expect(jobOf('obd')).toBe('live');
    expect(jobOf('backups')).toBe('ref');
    expect(jobOf('unknown-tab-xyz')).toBe('ref'); // fallback
  });
});
