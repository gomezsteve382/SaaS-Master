/* Fix Plan builder (Task #501).
 *
 * Translates a Census (from moduleCensus.js) into an ordered list of Fix
 * Steps the Workflow Runner executes one at a time. Each step is a small,
 * testable record so the runner UI never has to know algorithm details:
 *
 *   {
 *     id,
 *     module,            — code from the registry (e.g. "BCM")
 *     action,            — vinWrite | sec16Patch | pairing | flash | verify | manual
 *     label,             — short user-facing line
 *     notes,             — long description shown in the runner detail pane
 *     requiresSecurityAccess: { tx, rx, level }  | null
 *     expectedTraffic:   — string list of UDS frames the step typically sends
 *   }
 *
 * Ordering rules (Task #501 spec):
 *   1. Sign-off blockers first: missing modules, unknown dumps.
 *   2. VIN mismatches in dependency order: BCM → RFHUB → ECM → others.
 *   3. SEC16 patches before any pairing.
 *   4. Pairing (BCM↔RFHUB, RFHUB↔FOBs) after VIN writes.
 *   5. Verification reads at the end so the Sign-Off summary has fresh data.
 */

const VIN_WRITE_PRIORITY = { BCM: 1, RFHUB: 2, ECM: 3, ADCM: 4 };
function vinPriority(code) {
  return VIN_WRITE_PRIORITY[code] ?? 50;
}

function rowToTarget(row) {
  if (!row) return null;
  if (row.tx == null || row.rx == null) return null;
  return { tx: row.tx, rx: row.rx, code: row.code, label: row.name || row.code };
}

let _seq = 0;
function step(partial) {
  _seq++;
  return {
    id: `step_${Date.now().toString(36)}_${_seq}`,
    requiresSecurityAccess: null,
    expectedTraffic: [],
    notes: "",
    ...partial,
  };
}

/**
 * @param {object} cfg
 * @param {{rows:Array,summary:object}} cfg.census
 * @param {string} cfg.targetVin
 * @param {object} [cfg.options]
 * @param {boolean} [cfg.options.includeSec16Patch=true]
 * @param {boolean} [cfg.options.includePairing=true]
 * @param {boolean} [cfg.options.includeVerify=true]
 * @returns {{steps: Array, blockers: Array<string>}}
 */
export function buildFixPlan({ census, targetVin = "", options = {} } = {}) {
  const opts = {
    includeSec16Patch: true,
    includePairing: true,
    includeVerify: true,
    ...options,
  };
  const blockers = [];
  const steps = [];
  if (!census || !Array.isArray(census.rows)) {
    return { steps, blockers: ["census missing"] };
  }

  // ── 1. Sign-off blockers ──────────────────────────────────────────────
  for (const row of census.rows) {
    if (row.kind === "missing") {
      blockers.push(`Missing dump: ${row.code}`);
    } else if (row.kind === "unknown") {
      blockers.push(`Unknown dump for slot: ${row.name || row.code}`);
    } else if (row.kind === "extra") {
      blockers.push(`Extra dump not in expected platform list: ${row.code}`);
    }
  }

  // ── 2. VIN writes, dependency-ordered ─────────────────────────────────
  const vinRows = census.rows
    .filter((r) => r.kind === "mismatch" && rowToTarget(r))
    .sort((a, b) => vinPriority(a.code) - vinPriority(b.code));

  for (const row of vinRows) {
    const target = rowToTarget(row);
    steps.push(
      step({
        module: row.code,
        action: "vinWrite",
        label: `Write VIN ${targetVin || "<target>"} → ${row.code}`,
        notes:
          `Module currently reads VIN ${row.actualVin || "(unknown)"}. ` +
          `Send 27 01 / 27 02 SecurityAccess at level 0x01 then 2E F1 90 …` +
          ` followed by the platform's per-DID mirror writes.`,
        requiresSecurityAccess: { tx: target.tx, rx: target.rx, level: 0x01 },
        expectedTraffic: [
          "27 01 (request seed)",
          "27 02 <key>",
          `2E F1 90 ${targetVin || "<target>"}`,
          "2E 7B 90 …",
          "2E 7B 88 …",
        ],
      }),
    );
  }

  // ── 3. SEC16 patches before pairing ───────────────────────────────────
  if (opts.includeSec16Patch) {
    const bcmRow = census.rows.find((r) => r.code === "BCM" && r.dump);
    if (bcmRow && bcmRow.kind !== "missing") {
      steps.push(
        step({
          module: "BCM",
          action: "sec16Patch",
          label: "Apply SEC16 patch to BCM image (offline)",
          notes:
            "Compute SEC16 region from the loaded BCM dump and stage the " +
            "patched image in the Backups tab so the bench programmer can flash it.",
          expectedTraffic: ["(offline — image edit only)"],
        }),
      );
    }
  }

  // ── 4. Pairing ────────────────────────────────────────────────────────
  if (opts.includePairing) {
    const haveBcm = census.rows.some((r) => r.code === "BCM" && r.dump);
    const haveRfhub = census.rows.some((r) => r.code === "RFHUB" && r.dump);
    if (haveBcm && haveRfhub) {
      const bcm = rowToTarget(census.rows.find((r) => r.code === "BCM"));
      steps.push(
        step({
          module: "RFHUB",
          action: "pairing",
          label: "Pair RFHUB ↔ BCM (key prog session)",
          notes:
            "Run the Key Prog tab pairing routine so the new RFHUB accepts " +
            "fobs minted against the new BCM SEC16.",
          requiresSecurityAccess: bcm ? { tx: bcm.tx, rx: bcm.rx, level: 0x01 } : null,
          expectedTraffic: [
            "10 03 (extended diag)",
            "27 01 / 27 02 (BCM unlock)",
            "31 01 …  (start RFHUB pairing routine)",
          ],
        }),
      );
    }
  }

  // ── 5. Verify reads ───────────────────────────────────────────────────
  if (opts.includeVerify) {
    const verified = census.rows.filter((r) => rowToTarget(r) && r.kind !== "missing");
    for (const row of verified) {
      steps.push(
        step({
          module: row.code,
          action: "verify",
          label: `Read-back VIN from ${row.code} and confirm match`,
          notes:
            `Issue 22 F1 90 (and per-DID mirrors) and confirm the response ` +
            `equals the target VIN.`,
          expectedTraffic: ["22 F1 90", "22 7B 90", "22 7B 88"],
        }),
      );
    }
  }

  return { steps, blockers };
}

/* Helper: produce a Sign-Off summary from the census + the runner's per-step
   results. Mirrors what the Sign-Off panel shows so it can be persisted
   verbatim to vehicle_jobs.signOff. */
export function buildSignOff({ census, plan, results = {}, targetVin = "" }) {
  const stepResults = (plan?.steps || []).map((s) => ({
    id: s.id,
    module: s.module,
    action: s.action,
    label: s.label,
    status: results[s.id]?.status || "skipped",
    note: results[s.id]?.note || "",
    finishedAt: results[s.id]?.finishedAt || null,
  }));
  const completed = stepResults.filter((r) => r.status === "ok").length;
  const failed = stepResults.filter((r) => r.status === "fail").length;
  return {
    targetVin,
    generatedAt: new Date().toISOString(),
    censusSummary: census?.summary || null,
    blockers: plan?.blockers || [],
    steps: stepResults,
    totals: {
      total: stepResults.length,
      completed,
      failed,
      skipped: stepResults.length - completed - failed,
    },
    ready: failed === 0 && (plan?.blockers || []).length === 0,
  };
}
