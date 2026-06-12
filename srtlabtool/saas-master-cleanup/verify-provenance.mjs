import { readFileSync } from 'node:fs';
const dir = '/tmp/SaaS-Master/artifacts/srt-lab/src/lib/';
const algos = readFileSync(dir + 'algos.js', 'utf8');
const { ALGO_GROUNDING, groundingFor, GROUNDING } = await import(dir + 'algoProvenance.js');

// extract ALGOS[].id from the const ALGOS = [ ... ]; block
const block = algos.slice(algos.indexOf('const ALGOS=['), algos.indexOf('];', algos.indexOf('const ALGOS=[')));
const ids = [...block.matchAll(/\{id:'([^']+)'/g)].map((m) => m[1]);

let problems = 0;
for (const id of ids) {
  if (!ALGO_GROUNDING[id]) { console.log('MISSING grounding for ALGOS id:', id); problems++; }
}
for (const id of Object.keys(ALGO_GROUNDING)) {
  if (!ids.includes(id)) { console.log('grounding for unknown id (orphan):', id); problems++; }
}
// default safety: unknown id must be unverified
if (groundingFor('definitely-not-real').level !== GROUNDING.UNVERIFIED) { console.log('default is not unverified!'); problems++; }

const counts = {};
for (const id of ids) { const l = (ALGO_GROUNDING[id] || {}).level || '(none)'; counts[l] = (counts[l] || 0) + 1; }
console.log('\nALGOS grounding:', counts, ` total=${ids.length}`);
console.log(problems ? `FAIL: ${problems} problem(s)` : 'OK: every algorithm has an honest grounding entry');
process.exit(problems ? 1 : 0);
