import { readFileSync } from "node:fs";
const dir = "/tmp/SaaS-Master/artifacts/srt-lab/src/";
const app = readFileSync(dir + "App.jsx", "utf8");
const shell = readFileSync(dir + "components/CommandShell.jsx", "utf8");

const tabsBlock = app.slice(app.indexOf("const WORKSPACE_TABS"), app.indexOf("const WORKSPACE_CATEGORIES"));
const tabIds = [...tabsBlock.matchAll(/\{id:'([^']+)'/g)].map(m => m[1]);

const catBlock = app.slice(app.indexOf("const WORKSPACE_CATEGORIES"), app.indexOf("function VehicleWorkspace"));
const catPairs = [...catBlock.matchAll(/'?([\w-]+)'?\s*:\s*'(MODULES|MARRY|FLASH|LIVE|DATA|INTEL)'/g)];
const catMap = Object.fromEntries(catPairs.map(m => [m[1], m[2]]));

const order = shell.match(/SECTION_ORDER = \[([^\]]+)\]/)[1].match(/\w+/g);
const metaKeys = [...shell.slice(shell.indexOf("CATEGORY_META")).matchAll(/^ {2}(\w+):\s*\{label/gm)].map(m => m[1]);

const PRIMARY = new Set(["dumps", "vinsync", "secsync", "keyxfer", "uds-console", "vinprog", "obd", "investigation"]);
const FOOTER = new Set(["workflow", "canuniverse"]);

let problems = 0;
for (const id of tabIds) {
  if (id === "info" || PRIMARY.has(id) || FOOTER.has(id)) continue;
  if (!catMap[id]) { console.log("VANISH (uncategorized -> drops from drawer):", id); problems++; }
}
for (const [id, c] of Object.entries(catMap)) if (!order.includes(c)) { console.log("BAD category value:", id, c); problems++; }
for (const id of Object.keys(catMap)) if (!tabIds.includes(id)) { console.log("category for unknown tab:", id); problems++; }
for (const k of order) if (!metaKeys.includes(k)) { console.log("SECTION_ORDER key missing from CATEGORY_META:", k); problems++; }
for (const k of metaKeys) if (!order.includes(k)) { console.log("CATEGORY_META key missing from SECTION_ORDER:", k); problems++; }

// per-group counts (drawer-visible only)
const counts = {};
for (const id of tabIds) {
  if (PRIMARY.has(id) || FOOTER.has(id) || id === "info") continue;
  const c = catMap[id]; counts[c] = (counts[c] || 0) + 1;
}
console.log("\ndrawer groups:", order.map(k => `${k}=${counts[k] || 0}`).join("  "));
console.log(`tabs=${tabIds.length} categorized=${Object.keys(catMap).length}`);
console.log(problems ? `FAIL: ${problems} problem(s)` : "OK: all tabs reachable, categories valid, sections aligned");
process.exit(problems ? 1 : 0);
