#!/usr/bin/env node
/**
 * audit-dispatch-gap.mjs — Task #829
 *
 * Cross-references ROUTINE_CATALOG_FROM_EXE (1,696 routines, source-of-truth)
 * against UDS_FRAME_TO_ROUTINES (resolved UDS dispatch frame → routine_id map)
 * to identify catalog routines that have NO known dispatch frame — the actual
 * coverage gap.
 *
 * Writes artifacts/srt-lab/src/lib/dispatchGapReport.generated.js.
 *
 * Run: pnpm -F @workspace/scripts run audit:dispatch-gap
 */

import { writeFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ROUTINE_CATALOG_FROM_EXE } from "../../artifacts/srt-lab/src/lib/routineCatalogFromExe.generated.js";
import { UDS_FRAME_TO_ROUTINES } from "../../artifacts/srt-lab/src/lib/dispatchToRoutine.generated.js";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const IN_CATALOG  = resolve(ROOT, "artifacts/srt-lab/src/lib/routineCatalogFromExe.generated.js");
const IN_DISPATCH = resolve(ROOT, "artifacts/srt-lab/src/lib/dispatchToRoutine.generated.js");
const OUT  = resolve(ROOT, "artifacts/srt-lab/src/lib/dispatchGapReport.generated.js");

const TIER1_ROUTINE_IDS = [2504, 1520, 1126, 1750, 1751, 2505, 2507, 1367];

function buildResolvedSet() {
  const set = new Set();
  for (const rids of Object.values(UDS_FRAME_TO_ROUTINES)) {
    if (!Array.isArray(rids)) continue;
    for (const rid of rids) set.add(Number(rid));
  }
  return set;
}

function buildFrameIndex() {
  // rid → sorted unique list of frames
  const map = new Map();
  for (const [frame, rids] of Object.entries(UDS_FRAME_TO_ROUTINES)) {
    if (!Array.isArray(rids)) continue;
    for (const rid of rids) {
      const n = Number(rid);
      if (!map.has(n)) map.set(n, new Set());
      map.get(n).add(frame);
    }
  }
  const out = {};
  for (const [rid, frames] of map.entries()) {
    out[rid] = [...frames].sort();
  }
  return out;
}

function main() {
  const resolved = buildResolvedSet();
  const framesByRid = buildFrameIndex();

  const ridList = Object.keys(ROUTINE_CATALOG_FROM_EXE)
    .map((k) => Number(k))
    .sort((a, b) => a - b);

  const totalRoutines = ridList.length;
  let coveredCount = 0;
  let gapCount = 0;

  // ECU family aggregation
  const byEcuRaw = new Map(); // family → { total, covered, gap, gapRoutineIds: [] }
  for (const rid of ridList) {
    const row = ROUTINE_CATALOG_FROM_EXE[rid] || {};
    const family = (row["0"] || "(unknown)");
    const isCovered = resolved.has(rid);
    if (isCovered) coveredCount++;
    else gapCount++;
    if (!byEcuRaw.has(family)) {
      byEcuRaw.set(family, { total: 0, covered: 0, gap: 0, gapRoutineIds: [] });
    }
    const bucket = byEcuRaw.get(family);
    bucket.total++;
    if (isCovered) bucket.covered++;
    else {
      bucket.gap++;
      bucket.gapRoutineIds.push(rid);
    }
  }

  // Build sorted-by-family ECU report (top 50 gap ids per family)
  const sortedFamilies = [...byEcuRaw.keys()].sort((a, b) => String(a).localeCompare(String(b)));
  const DISPATCH_GAP_BY_ECU = {};
  for (const fam of sortedFamilies) {
    const b = byEcuRaw.get(fam);
    DISPATCH_GAP_BY_ECU[fam] = {
      total: b.total,
      covered: b.covered,
      gap: b.gap,
      gapRoutineIds: b.gapRoutineIds.slice(0, 50),
    };
  }

  // Tier-1 status
  let tier1Covered = 0;
  let tier1Gap = 0;
  const TIER1_STATUS = TIER1_ROUTINE_IDS.map((rid) => {
    const row = ROUTINE_CATALOG_FROM_EXE[rid] || null;
    const covered = resolved.has(rid);
    if (covered) tier1Covered++; else tier1Gap++;
    return {
      rid,
      covered,
      ecuFamily: row ? (row["0"] || null) : null,
      friendlyName: row ? (row["1"] || null) : null,
      dispatchFrames: framesByRid[rid] || [],
    };
  });

  const coveragePct = totalRoutines === 0
    ? 0
    : Math.round((coveredCount / totalRoutines) * 10000) / 100;

  // Idempotency: derive generatedAt from input-file mtimes so re-running
  // against unchanged inputs produces byte-identical output.
  const mtimeMs = Math.max(
    statSync(IN_CATALOG).mtimeMs,
    statSync(IN_DISPATCH).mtimeMs,
  );
  const generatedAt = new Date(mtimeMs).toISOString();

  const DISPATCH_GAP_META = {
    totalRoutines,
    coveredCount,
    gapCount,
    coveragePct,
    tier1Total: TIER1_ROUTINE_IDS.length,
    tier1Covered,
    tier1Gap,
    generatedAt,
  };

  const header = `// AUTO-GENERATED. DO NOT EDIT BY HAND.
// Run: pnpm -F @workspace/scripts run audit:dispatch-gap
//
// Task #829 — Routine→UDS dispatch coverage gap report.
// Cross-references ROUTINE_CATALOG_FROM_EXE against UDS_FRAME_TO_ROUTINES.
`;

  const body = [
    "export const DISPATCH_GAP_META = " + JSON.stringify(DISPATCH_GAP_META, null, 2) + ";",
    "export const TIER1_ROUTINE_IDS = " + JSON.stringify(TIER1_ROUTINE_IDS) + ";",
    "export const DISPATCH_GAP_BY_ECU = " + JSON.stringify(DISPATCH_GAP_BY_ECU, null, 2) + ";",
    "export const TIER1_STATUS = " + JSON.stringify(TIER1_STATUS, null, 2) + ";",
    "",
  ].join("\n\n");

  writeFileSync(OUT, header + "\n" + body);
  console.error(
    `wrote ${OUT}  total=${totalRoutines} covered=${coveredCount} gap=${gapCount} (${coveragePct}%) tier1 covered=${tier1Covered}/${TIER1_ROUTINE_IDS.length}`
  );
}

main();
