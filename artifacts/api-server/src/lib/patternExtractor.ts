/**
 * Pattern Extractor (Task #695).
 *
 * Takes a parsed analysis blob (output from parseModule / backup payload) and
 * emits canonical patterns + KG triples ready for DB upsert.
 *
 * All functions are pure: no DB access, no side effects.
 */

import crypto from "crypto";

export type PatternCategory =
  | "vin_encoding"
  | "seed_key_constant"
  | "skim_layout"
  | "calibration_id"
  | "crc_table"
  | "xor_key"
  | "module_signature"
  | "security_bytes"
  | "unknown";

export interface ExtractedPattern {
  category: PatternCategory;
  label: string;
  signatureBytes: string | null;
  signatureHash: string;
  confidence: number;
  notes: string | null;
}

export type KgNodeType =
  | "VIN"
  | "MODULE"
  | "ALGO"
  | "CANID"
  | "CALIBID"
  | "SECBYTES";

export type KgEdgeType =
  | "seen_together"
  | "patched_from"
  | "shares_secret_with"
  | "uses_algo"
  | "has_calibration";

export interface KgNodeSpec {
  nodeType: KgNodeType;
  label: string;
  metadata: Record<string, unknown>;
}

export interface KgEdgeSpec {
  fromLabel: string;
  fromType: KgNodeType;
  toLabel: string;
  toType: KgNodeType;
  edgeType: KgEdgeType;
  meta?: Record<string, unknown>;
}

export interface ExtractionResult {
  patterns: ExtractedPattern[];
  nodes: KgNodeSpec[];
  edges: KgEdgeSpec[];
}

/** SHA-256 hex of content, truncated to 16 chars for the dedup key. */
function hashSig(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 32);
}

/** Convert a byte array to a hex string "AB CD EF…" */
function toHex(bytes: ArrayLike<number>): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

/** Parse hex string back to bytes for hashing */
function hexToBytes(hex: string): number[] {
  const clean = hex.replace(/\s+/g, "").replace(/^0x/i, "");
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    const b = parseInt(clean.slice(i, i + 2), 16);
    if (!isNaN(b)) out.push(b);
  }
  return out;
}

function isValidVin(s: unknown): s is string {
  if (typeof s !== "string") return false;
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(s);
}

function isHexLike(s: unknown): boolean {
  if (typeof s !== "string") return false;
  return /^[0-9a-fA-F ]+$/.test(s.trim()) && s.trim().length > 0;
}

/**
 * Extract patterns and KG triples from a parsed analysis blob.
 *
 * The blob is the JSON `payload` field of a module backup or the direct
 * `parseModule()` output. The caller must also pass an `analysisId` string
 * (typically the backup ID) for provenance.
 */
export function extractFromAnalysis(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  blob: Record<string, any>,
  analysisId: string,
): ExtractionResult {
  const patterns: ExtractedPattern[] = [];
  const nodes: KgNodeSpec[] = [];
  const edges: KgEdgeSpec[] = [];

  /* ── helpers ──────────────────────────────────────────────────────── */
  function addPattern(p: ExtractedPattern) {
    if (!patterns.some((x) => x.category === p.category && x.signatureHash === p.signatureHash)) {
      patterns.push(p);
    }
  }

  function addNode(n: KgNodeSpec) {
    if (!nodes.some((x) => x.nodeType === n.nodeType && x.label === n.label)) {
      nodes.push(n);
    }
  }

  function addEdge(e: KgEdgeSpec) {
    if (
      !edges.some(
        (x) =>
          x.fromLabel === e.fromLabel &&
          x.fromType === e.fromType &&
          x.toLabel === e.toLabel &&
          x.toType === e.toType &&
          x.edgeType === e.edgeType,
      )
    ) {
      edges.push(e);
    }
  }

  /* ── VIN extraction ────────────────────────────────────────────────── */
  const vinCandidates: string[] = [];

  function tryVin(v: unknown, source: string, moduleType?: string) {
    if (!isValidVin(v)) return;
    const vin = v as string;
    if (!vinCandidates.includes(vin)) vinCandidates.push(vin);

    const sigBytes = toHex(Array.from(vin).map((c) => c.charCodeAt(0)));
    addPattern({
      category: "vin_encoding",
      label: `VIN: ${vin} (${source})`,
      signatureBytes: sigBytes,
      signatureHash: hashSig(`vin:${vin}`),
      confidence: 0.95,
      notes: moduleType ? `Observed in ${moduleType} module` : null,
    });
    addNode({
      nodeType: "VIN",
      label: vin,
      metadata: { source, analysisId },
    });
  }

  tryVin(blob.vin, "root", blob.module || blob.moduleType);
  tryVin(blob.info?.vin, "info.vin", blob.module);
  tryVin(blob.parsedVin, "parsedVin", blob.module);

  if (Array.isArray(blob.vins)) {
    blob.vins.forEach((v: unknown) => tryVin(v, "vins[]", blob.module));
  }

  /* XC2268 / ZF8HP multi-slot VINs */
  const xc = blob.info?.xc2268;
  if (xc) {
    tryVin(xc.slot1?.vin, "xc2268.slot1", "XC2268_RFHUB");
    tryVin(xc.slot2?.vin, "xc2268.slot2", "XC2268_RFHUB");
  }
  const zf = blob.info?.zf8hp;
  if (zf) {
    tryVin(zf.slot1?.vin, "zf8hp.slot1", "ZF_8HP_TCU");
    tryVin(zf.slot2?.vin, "zf8hp.slot2", "ZF_8HP_TCU");
  }

  /* ── Module type / signature ────────────────────────────────────────── */
  const moduleType: string =
    blob.module || blob.moduleType || blob.type || blob.info?.type || "UNKNOWN";
  const partNumber: string = blob.partNumber || blob.pn || blob.info?.pn || "";
  const swVersion: string =
    blob.swVersion || blob.softwareVersion || blob.info?.swVersion || "";

  if (moduleType && moduleType !== "UNKNOWN") {
    const sigContent = `module:${moduleType}:${partNumber}:${swVersion}`;
    addPattern({
      category: "module_signature",
      label: `${moduleType}${partNumber ? " P/N " + partNumber : ""}${swVersion ? " SW " + swVersion : ""}`,
      signatureBytes: null,
      signatureHash: hashSig(sigContent),
      confidence: 0.9,
      notes: null,
    });
    addNode({
      nodeType: "MODULE",
      label: `${moduleType}${partNumber ? "::" + partNumber : ""}`,
      metadata: { moduleType, partNumber, swVersion, analysisId },
    });
  }

  /* ── Security bytes (SEC16 / SEC6) ─────────────────────────────────── */
  const sec16: unknown =
    blob.sec16 || blob.info?.sec16 || blob.bcmSec16 || blob.rfhubSec16;
  if (sec16 && isHexLike(sec16)) {
    const bytes = hexToBytes(sec16 as string);
    if (bytes.length >= 4) {
      const sigHex = toHex(bytes);
      addPattern({
        category: "security_bytes",
        label: `SEC16: ${(sec16 as string).trim().toUpperCase().slice(0, 24)}…`,
        signatureBytes: sigHex,
        signatureHash: hashSig(`sec16:${sigHex}`),
        confidence: 0.88,
        notes: `Module: ${moduleType}`,
      });
      const secLabel = `SEC16:${(sec16 as string).trim().toUpperCase().slice(0, 12)}`;
      addNode({
        nodeType: "SECBYTES",
        label: secLabel,
        metadata: { moduleType, analysisId },
      });
      if (moduleType && moduleType !== "UNKNOWN") {
        addEdge({
          fromLabel: `${moduleType}${partNumber ? "::" + partNumber : ""}`,
          fromType: "MODULE",
          toLabel: secLabel,
          toType: "SECBYTES",
          edgeType: "shares_secret_with",
          meta: { analysisId },
        });
      }
    }
  }

  const sec6: unknown = blob.sec6 || blob.info?.sec6 || blob.pcmSec6;
  if (sec6 && isHexLike(sec6)) {
    const bytes = hexToBytes(sec6 as string);
    if (bytes.length >= 4) {
      const sigHex = toHex(bytes);
      addPattern({
        category: "security_bytes",
        label: `SEC6: ${(sec6 as string).trim().toUpperCase().slice(0, 18)}…`,
        signatureBytes: sigHex,
        signatureHash: hashSig(`sec6:${sigHex}`),
        confidence: 0.85,
        notes: `Module: ${moduleType}`,
      });
    }
  }

  /* ── Calibration IDs ────────────────────────────────────────────────── */
  const calIds: string[] = [];
  if (typeof blob.calibrationId === "string") calIds.push(blob.calibrationId);
  if (typeof blob.info?.calibrationId === "string")
    calIds.push(blob.info.calibrationId);
  if (Array.isArray(blob.calibrationIds))
    calIds.push(...blob.calibrationIds.filter((x: unknown) => typeof x === "string"));

  for (const calId of calIds) {
    if (!calId.trim()) continue;
    addPattern({
      category: "calibration_id",
      label: `Cal ID: ${calId}`,
      signatureBytes: null,
      signatureHash: hashSig(`calid:${calId}`),
      confidence: 0.9,
      notes: `Module: ${moduleType}`,
    });
    addNode({
      nodeType: "CALIBID",
      label: calId,
      metadata: { moduleType, analysisId },
    });
    if (moduleType && moduleType !== "UNKNOWN") {
      addEdge({
        fromLabel: `${moduleType}${partNumber ? "::" + partNumber : ""}`,
        fromType: "MODULE",
        toLabel: calId,
        toType: "CALIBID",
        edgeType: "has_calibration",
        meta: { analysisId },
      });
    }
  }

  /* ── CAN TX/RX IDs ──────────────────────────────────────────────────── */
  const tx: unknown = blob.tx ?? blob.txId ?? blob.canTx;
  const rx: unknown = blob.rx ?? blob.rxId ?? blob.canRx;
  if (typeof tx === "number" && tx > 0) {
    addNode({
      nodeType: "CANID",
      label: `0x${tx.toString(16).toUpperCase().padStart(3, "0")}`,
      metadata: { role: "TX", moduleType, analysisId },
    });
    if (moduleType && moduleType !== "UNKNOWN") {
      addEdge({
        fromLabel: `${moduleType}${partNumber ? "::" + partNumber : ""}`,
        fromType: "MODULE",
        toLabel: `0x${tx.toString(16).toUpperCase().padStart(3, "0")}`,
        toType: "CANID",
        edgeType: "seen_together",
        meta: { role: "TX", analysisId },
      });
    }
  }
  if (typeof rx === "number" && rx > 0) {
    addNode({
      nodeType: "CANID",
      label: `0x${rx.toString(16).toUpperCase().padStart(3, "0")}`,
      metadata: { role: "RX", moduleType, analysisId },
    });
  }

  /* ── Seed-key algo hints ────────────────────────────────────────────── */
  const algoHint: unknown = blob.algoHint || blob.seedKeyAlgo || blob.info?.algoHint;
  if (typeof algoHint === "string" && algoHint.trim()) {
    addPattern({
      category: "seed_key_constant",
      label: `Algo hint: ${algoHint}`,
      signatureBytes: null,
      signatureHash: hashSig(`algo:${algoHint}`),
      confidence: 0.75,
      notes: `Module: ${moduleType}`,
    });
    addNode({
      nodeType: "ALGO",
      label: algoHint,
      metadata: { moduleType, analysisId },
    });
    if (moduleType && moduleType !== "UNKNOWN") {
      addEdge({
        fromLabel: `${moduleType}${partNumber ? "::" + partNumber : ""}`,
        fromType: "MODULE",
        toLabel: algoHint,
        toType: "ALGO",
        edgeType: "uses_algo",
        meta: { analysisId },
      });
    }
  }

  /* ── Cross-VIN "seen_together" edges ───────────────────────────────── */
  if (vinCandidates.length > 1 && moduleType && moduleType !== "UNKNOWN") {
    for (let i = 0; i < vinCandidates.length; i++) {
      for (let j = i + 1; j < vinCandidates.length; j++) {
        addEdge({
          fromLabel: vinCandidates[i]!,
          fromType: "VIN",
          toLabel: vinCandidates[j]!,
          toType: "VIN",
          edgeType: "seen_together",
          meta: { moduleType, analysisId },
        });
      }
    }
  }

  if (vinCandidates.length > 0 && moduleType && moduleType !== "UNKNOWN") {
    const modLabel = `${moduleType}${partNumber ? "::" + partNumber : ""}`;
    for (const vin of vinCandidates) {
      addEdge({
        fromLabel: vin,
        fromType: "VIN",
        toLabel: modLabel,
        toType: "MODULE",
        edgeType: "seen_together",
        meta: { analysisId },
      });
    }
  }

  return { patterns, nodes, edges };
}
