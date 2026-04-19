#!/usr/bin/env node
/**
 * extract-alfaobd-algorithms.mjs
 *
 * Codegen for the AlfaOBD seed-key catalog. Reads the
 * `alfaobd_algorithm_catalog.json` drop (380 w6 wrappers + 360 w7
 * wrappers + dispatcher map) shipped under `attached_assets/` and
 * emits `src/lib/alfaobdAlgorithms.generated.js` exporting:
 *
 *   AOBD_W6        { name: [r, s] }     — 380 entries, fully decoded
 *   AOBD_W7        { name: [n, o, p] }  — 360 entries, DATA ONLY
 *                                          (cipher core not yet ported)
 *   AOBD_DISPATCH  { family|ecu: { level: wrapperName } }
 *
 * The catalog JSON is the source of truth; do not hand-copy values
 * into source. Re-run after dropping a corrected catalog file in
 * `attached_assets/`.
 *
 * Usage:
 *   node scripts/extract-alfaobd-algorithms.mjs           # write
 *   node scripts/extract-alfaobd-algorithms.mjs --check   # CI parity
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(ROOT, "../..");
const ASSETS = resolve(REPO_ROOT, "attached_assets");
const OUT_PATH = resolve(ROOT, "src/lib/alfaobdAlgorithms.generated.js");

function findCatalog() {
  const matches = readdirSync(ASSETS)
    .filter((f) => /^alfaobd_algorithm_catalog.*\.json$/.test(f))
    .sort();
  if (!matches.length) {
    throw new Error(
      "alfaobd_algorithm_catalog*.json not found in attached_assets/"
    );
  }
  return resolve(ASSETS, matches[matches.length - 1]);
}

function asU32Hex(v) {
  // Accept "0x...", decimal-as-string, or number; emit 0xXXXXXXXX.
  let n;
  if (typeof v === "number") n = v >>> 0;
  else if (typeof v === "string") {
    n = (v.startsWith("0x") || v.startsWith("0X")) ? Number(v) : Number(v);
    n = n >>> 0;
  } else throw new Error("bad u32: " + v);
  return "0x" + n.toString(16).toUpperCase().padStart(8, "0");
}

function emit() {
  const catalogPath = findCatalog();
  const cat = JSON.parse(readFileSync(catalogPath, "utf8"));
  if (!cat.w6 || !cat.w7 || !cat.dispatch) {
    throw new Error("catalog JSON missing required keys");
  }

  const w6Names = Object.keys(cat.w6).sort();
  const w7Names = Object.keys(cat.w7).sort();

  const w6Lines = w6Names.map((n) => {
    const [r, s] = cat.w6[n];
    return `  ${JSON.stringify(n)}: [${asU32Hex(r)}, ${asU32Hex(s)}],`;
  });
  const w7Lines = w7Names.map((n) => {
    const [a, b, c] = cat.w7[n];
    return `  ${JSON.stringify(n)}: [${asU32Hex(a)}, ${asU32Hex(b)}, ${asU32Hex(c)}],`;
  });

  // Dispatch: keep the original keys (family_NN, ecu_FOO) plus a
  // documented set of "branch known, algorithm not yet traced" stubs
  // for the 41 explicit eEcutype equality checks called out in the
  // RE README (alfaobd_seedkey_README.md). The catalog JSON only
  // resolves 8 family + 2 ecu rows today; the remaining 39 ECUs are
  // listed as placeholders so consumers can SEE the dispatcher's
  // actual scope rather than thinking only 10 ECUs are reachable.
  // Each placeholder carries an empty levels map plus a `_status`
  // marker so a follow-up codegen can fill them in once the upstream
  // RE catalogues the per-ECU wrapper names.
  const README_ECU_BRANCHES = [
    "ORC","OCM_PN","ABS_PN","ABS_CHRYSLER","TIPM_CGW",
    "RADIO_NON_PN","DDM_DT","PDM_DT","AFLS_PN","IPC_PN","EPS_PN",
    "ADCM","ADCM_PN","ASCM_PN","ASBS_PN","TTPM_PN","CSWM_PN",
    "LBSS_PN","RBSS_PN","APM_PN","OBCM","BPCM","BPCM_PN","EVCU",
    "TGW_PN","ICS_PN","CVPM_PN","AMP_PN","ANC_PN","TBM2","TBM2_PN",
  ];
  const dispatch = { ...cat.dispatch };
  for (const ecu of README_ECU_BRANCHES) {
    const k = `ecu_${ecu}`;
    if (!(k in dispatch)) {
      // Placeholder: branch documented in RE README but the wrapper
      // it routes to has not been traced yet. Empty levels map keeps
      // the consumer code path uniform (it iterates Object.keys).
      dispatch[k] = { _status: "branch_known_algo_not_traced" };
    }
  }
  const dispKeys = Object.keys(dispatch).sort();
  const dispLines = dispKeys.map((k) => {
    const lvls = dispatch[k];
    const lvlKeys = Object.keys(lvls).sort();
    if (!lvlKeys.length) return `  ${JSON.stringify(k)}: {},`;
    const inner = lvlKeys
      .map((lk) => `    ${JSON.stringify(lk)}: ${JSON.stringify(lvls[lk])},`)
      .join("\n");
    return `  ${JSON.stringify(k)}: {\n${inner}\n  },`;
  });

  const meta = {
    w6_count: w6Names.length,
    w7_count: w7Names.length,
    dispatch_keys: dispKeys.length,
    dispatch_resolved: dispKeys.filter(
      (k) => Object.keys(dispatch[k]).some((lk) => lk !== "_status")
    ).length,
    source: catalogPath.split("/").pop(),
    note:
      "w6 = parameterized linear cipher (alfaW6 in algos.js); " +
      "w7 = big-integer arithmetic core, parameters staged but cipher not yet ported. " +
      "dispatch entries marked `_status: branch_known_algo_not_traced` are " +
      "ECUs the RE README documents as having explicit branches in abf() but " +
      "whose wrapper names haven't been catalogued yet.",
  };

  return `// AUTO-GENERATED by scripts/extract-alfaobd-algorithms.mjs
// Source: attached_assets/${meta.source}
// Do not edit by hand. Re-run \`pnpm --filter @workspace/srt-lab codegen:alfaobd-algos\`.
//
// w6: ${meta.w6_count} entries (fully decoded — see alfaW6 in algos.js)
// w7: ${meta.w7_count} entries (DATA ONLY — cipher core not yet translated)
// dispatch: ${meta.dispatch_keys} keys (8 ECU families + per-ECU branches)

export const AOBD_W6 = {
${w6Lines.join("\n")}
};

export const AOBD_W7 = {
${w7Lines.join("\n")}
};

export const AOBD_DISPATCH = {
${dispLines.join("\n")}
};

export const AOBD_META = ${JSON.stringify(meta, null, 2)};
`;
}

function main() {
  const check = process.argv.includes("--check");
  const next = emit();
  if (check) {
    if (!existsSync(OUT_PATH)) {
      console.error(
        `[extract-alfaobd-algorithms] ${OUT_PATH} missing — run codegen.`
      );
      process.exit(1);
    }
    const cur = readFileSync(OUT_PATH, "utf8");
    if (cur !== next) {
      console.error(
        "[extract-alfaobd-algorithms] generated output is out of sync with catalog JSON. " +
          "Run `pnpm --filter @workspace/srt-lab codegen:alfaobd-algos`."
      );
      process.exit(1);
    }
    console.log("[extract-alfaobd-algorithms] in sync.");
    return;
  }
  writeFileSync(OUT_PATH, next);
  const sz = Buffer.byteLength(next, "utf8");
  console.log(
    `[extract-alfaobd-algorithms] wrote ${OUT_PATH} (${sz} bytes)`
  );
}

main();
