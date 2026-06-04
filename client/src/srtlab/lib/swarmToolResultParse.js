/**
 * Parsers for the swarm tool-result text emitted by
 * `artifacts/api-server/.../investigationSwarm/toolExecutor.ts`.
 *
 * Each `agent_tool_result` event from the SSE stream carries a `preview`
 * field (first ~200 chars of the raw tool output). These helpers turn
 * that text into structured pointers the dump-inspector UI can
 * deep-link from: pattern_lookup → byte offsets, kg_query → BCM
 * DEnn DIDs + unlock-catalog hits.
 *
 * Strictly text in, structured pointers out — no DOM, no fetch.
 */

/** Match `0x000123` style offsets at the start of a pattern_lookup hit line. */
const OFFSET_LINE_RX = /^0x([0-9A-Fa-f]{4,8})\b/;

/** Parse pattern_lookup result text → ascending list of unique byte offsets. */
export function parsePatternLookupOffsets(text) {
  if (typeof text !== "string" || !text) return [];
  const seen = new Set();
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const m = trimmed.match(OFFSET_LINE_RX);
    if (!m) continue;
    const off = parseInt(m[1], 16);
    if (!Number.isFinite(off) || off < 0) continue;
    if (seen.has(off)) continue;
    seen.add(off);
    out.push(off);
  }
  return out.sort((a, b) => a - b);
}

/** Match a `[bcm-feature] DExx  GROUP / NAME  bit=… len=…` row. */
const BCM_FEATURE_RX =
  /^\[bcm-feature\]\s+(DE[0-9A-Fa-f]{2}|0x2023)\s+([^/]+?)\s*\/\s*([^\s]+)/;

/** Parse kg_query result text → BCM feature rows (DID + group + field name). */
export function parseKgQueryBcmFeatures(text) {
  if (typeof text !== "string" || !text) return [];
  const out = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(BCM_FEATURE_RX);
    if (!m) continue;
    const did = m[1].toUpperCase().replace(/^0X/, "0x");
    const group = m[2].trim();
    const field = m[3].trim();
    const key = `${did}|${group}|${field}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ did, group, field });
  }
  return out;
}

/**
 * Match an `[unlock] <name>  family=<f>  algorithm=<a>  status=<s>` row.
 * The describeUnlock() emitter joins on two spaces so the regex is
 * tolerant of single or multi-space gaps.
 */
const UNLOCK_RX =
  /^\[unlock\]\s+(.+?)\s+family=(\S+)\s+algorithm=(\S+)\s+status=(\S+)/;

/** Parse kg_query result text → unlock-catalog hits (name + family + algorithm). */
export function parseKgQueryUnlocks(text) {
  if (typeof text !== "string" || !text) return [];
  const out = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(UNLOCK_RX);
    if (!m) continue;
    const name = m[1].trim();
    const family = m[2];
    const algorithm = m[3];
    const status = m[4];
    const key = `${name}|${family}|${algorithm}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, family, algorithm, status });
  }
  return out;
}
