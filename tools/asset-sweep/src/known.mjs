/**
 * Comparators for "is this already wired into the SRT Lab artifact?"
 *
 * Loaded by reading the live source files in `artifacts/srt-lab/src/lib/`
 * and `artifacts/srt-lab/public/` so the moment a new algorithm or DLL
 * lands in the in-app catalog, the next sweep automatically removes it
 * from the generated extended catalog.
 *
 * We deliberately load these at runtime (rather than baking constants in)
 * so the sweep tool has zero hand-maintained state.
 */
import {readFileSync, existsSync} from "node:fs";
import {resolve} from "node:path";

// ── In-app algorithm catalogs ────────────────────────────────────────────
const ALGOS_JS = "artifacts/srt-lab/src/lib/algos.js";
const CANFLASH_JS = "artifacts/srt-lab/src/lib/canflashAlgos.js";
const ALFA_GEN_JS = "artifacts/srt-lab/src/lib/alfaobdAlgorithms.generated.js";

/**
 * Build a Set of canonical algorithm "tags" already known to the app.
 *
 * Tags are normalised to a lowercase, snake-case form so the asset-side
 * Python names (`huntsville_radio_unlock`, `cf_huntsville_radio`,
 * `cfHuntsvilleRadio`) all collapse onto the same key.
 */
export function loadKnownAlgorithmTags(repoRoot) {
  const known = new Set();
  const reIdent = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
  for (const rel of [ALGOS_JS, CANFLASH_JS, ALFA_GEN_JS]) {
    const p = resolve(repoRoot, rel);
    if (!existsSync(p)) continue;
    const src = readFileSync(p, "utf8");
    // Pick up function declarations + exports + ALGOS / dispatch keys.
    const reExport = /export\s*\{([^}]+)\}/g;
    let em;
    while ((em = reExport.exec(src)) !== null) {
      for (const part of em[1].split(",")) {
        const id = part.trim().split(/\s+as\s+/)[0].trim();
        if (id) known.add(canonical(id));
      }
    }
    const reFn = /function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
    let fm;
    while ((fm = reFn.exec(src)) !== null) {
      known.add(canonical(fm[1]));
    }
    // ALGOS = [{ id: 'gpec2', ... }, ...] — also pull the id strings.
    const reId = /id\s*:\s*['"]([^'"]+)['"]/g;
    let im;
    while ((im = reId.exec(src)) !== null) {
      known.add(canonical(im[1]));
    }
    // Generated AlfaOBD wrapper names live in AOBD_W6/AOBD_W7 maps as bare
    // keys like `'a0': [...]`. Capture them so the report doesn't double-
    // count the 380+360 wrappers as "new".
    const reW = /^\s*"([A-Za-z][A-Za-z0-9_]{0,8})"\s*:\s*\[/gm;
    let wm;
    while ((wm = reW.exec(src)) !== null) {
      known.add("alfa_w_" + canonical(wm[1]));
    }
  }
  // Manually whitelist the canflash family aliases we know are equivalences
  // (`ngc4_trans` is byte-identical to `ngc_engine`, so the asset port aliases
  // them — both should resolve to "already known").
  for (const alias of [
    "ngc_engine", "ngc4_trans", "ngc_transmission", "venom_pcm", "gpec",
    "huntsville_radio", "huntsville_bcm", "yazaki_fcm", "motorola_tipm7",
    "trw_abs", "bosch_abs", "may_scofield_itm", "wcm", "alpine_rak",
  ]) known.add(canonical(alias));
  return known;
}

/**
 * Build a Set of CRC primitive shape signatures already in `crc.js`.
 * Signature = "<kind>:<polyHex>:<initHex>". We don't try to match by name
 * (the file uses `crc16`, `crc8_42`, `crc8rf`, `crc8_65`) — the constants
 * are the actual identity.
 */
export function loadKnownCrcSignatures(repoRoot) {
  const known = new Set();
  const p = resolve(repoRoot, "artifacts/srt-lab/src/lib/crc.js");
  if (!existsSync(p)) return known;
  const src = readFileSync(p, "utf8");
  // crc16 (poly=0x1021, init=0xFFFF) — CCITT-FALSE
  if (/0x1021/.test(src)) known.add("crc16:0x1021:0xFFFF");
  // crc8_42 (poly=0x42, init=0x2E)
  if (/0x42/.test(src) && /0x2E/.test(src)) known.add("crc8:0x42:0x2E");
  // crc8rf (poly=0xA0, init=0x54)
  if (/0xA0/i.test(src) && /0x54/.test(src)) known.add("crc8r:0xA0:0x54");
  // crc8_65 (poly=0x65, init=0xBF)
  if (/0x65/.test(src) && /0xBF/i.test(src)) known.add("crc8:0x65:0xBF");
  // RFHUB per-VIN polys (5F08, 71DE, 8C5B, 535D, 1189, 589B)
  for (const p of ["0x5F08", "0x71DE", "0x8C5B", "0x535D", "0x1189", "0x589B"]) {
    if (new RegExp(p, "i").test(src)) known.add(`crc16:${p.toUpperCase()}:rfhub_known`);
  }
  return known;
}

/**
 * The current production unlock catalog: maps DLL filename → existing record
 * so the sweep can answer "is this DLL already covered?". Keys are the bare
 * filename (`huntsville_bcm.dll`), case-sensitive to match the on-disk
 * convention used by the catalog generator.
 */
export function loadKnownUnlockDlls(repoRoot) {
  const map = new Map();
  const p = resolve(repoRoot, "artifacts/srt-lab/public/unlock_catalog.json");
  if (!existsSync(p)) return map;
  const cat = JSON.parse(readFileSync(p, "utf8"));
  for (const e of cat.entries || []) {
    if (e && e.file) map.set(e.file, e);
  }
  return map;
}

function canonical(name) {
  // Lowercase + strip common prefixes/suffixes. The asset corpus mixes a
  // dozen naming conventions for the same algorithm (`unlock_huntsville_bcm`,
  // `cf_huntsville_bcm`, `cfHuntsvilleBCM`, `huntsville_bcm_unlock`,
  // `algo_huntsville_bcm`); collapsing them all here means the
  // already_in_app comparator works with a single Set lookup.
  let n = String(name).trim();
  n = n.replace(/^(algo_|unlock_|cf_|cf|alfa_?|aobd_?)/i, "");
  n = n.replace(/(_unlock|_key|_seedkey)$/i, "");
  // camelCase → snake_case
  n = n.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  // collapse repeated separators
  n = n.replace(/_+/g, "_").replace(/^_|_$/g, "");
  return n;
}

export {canonical};
