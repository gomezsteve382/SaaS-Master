/* jobLauncher — job-first routing layer. Turns the 50-tool drawer into a handful
   of jobs: each JOB_KIND pre-stages the VIN + a job record and routes to the right
   tab. Pure/testable (the bus-touching and tab-switching come in as injected
   deps), modeled on exportSafetyGate.js. */

export const JOB_KINDS = [
  { key: 'add-key',  label: 'Add a Key',          sub: 'Program a transponder / fob',     targetTab: 'keyxfer',  needsVin: true,  icon: '🔑' },
  { key: 'akl',      label: 'All Keys Lost',       sub: 'Extract PIN + program first key',  targetTab: 'akl',      needsVin: false, icon: '🔐' },
  { key: 'bcm-swap', label: 'Replace / Clone BCM', sub: 'VIN + SEC16 + pairing',            targetTab: 'bcm',      needsVin: true,  icon: '🧠' },
  { key: 'vin-sync', label: 'Sync VIN',            sub: 'VIN + security across modules',     targetTab: 'modsync',  needsVin: true,  icon: '🔄' },
  { key: 'read-live',label: 'Read live',           sub: 'Scan + read modules on the bus',    targetTab: 'topology', needsVin: false, icon: '🗺️' },
];

export function jobKind(key) {
  return JOB_KINDS.find(k => k.key === key) || null;
}

/* Start a job: validate, create the job record, pre-stage the VIN context, route.
   `createJob`/`newJobId` are injected (the launcher passes the real vehicleJobs
   fns; tests pass mocks). `ctx` is the MasterVin context; `setTab` is the router.
   Sequence matters: await createJob -> setJobId -> hydrateFromJob -> setVin ->
   setTab, so the target tab sees a populated context on its first render. */
export async function startJob({ kind, vin, ctx, setTab, createJob, newJobId } = {}) {
  const k = jobKind(kind);
  if (!k) return { ok: false, error: 'unknown job kind: ' + kind };
  const cleanVin = (vin || '').trim().toUpperCase();
  if (k.needsVin && cleanVin.length !== 17) {
    return { ok: false, error: 'A 17-character VIN is required to start "' + k.label + '".' };
  }
  let created = null;
  try {
    if (typeof createJob === 'function') {
      created = await createJob({
        id: typeof newJobId === 'function' ? newJobId() : undefined,
        vin: cleanVin || null,
        kind: k.key,
        title: `${k.label} — ${cleanVin || 'no VIN'}`,
        status: 'in-progress',
      });
      if (ctx && created && created.id) ctx.setJobId?.(created.id);
      if (ctx && created) ctx.hydrateFromJob?.(created);
    }
    if (ctx && cleanVin) ctx.setVin?.(cleanVin);
    if (typeof setTab === 'function') setTab(k.targetTab);
    return { ok: true, jobId: created?.id || null, targetTab: k.targetTab, kind: k.key };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}
