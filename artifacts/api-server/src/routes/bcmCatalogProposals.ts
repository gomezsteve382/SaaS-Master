import { Router, type IRouter } from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Catalog-growth review queue for Task #617.
 *
 * The Log Analyser tab (`artifacts/srt-lab/src/tabs/LogAnalyserTab.jsx`) walks
 * a before/after candump diff and proposes new BCM DIDs/fields. Operators
 * review each proposal and ACCEPT to append it here. This file is the
 * **only** sink for the workflow — `bcmFeatureCatalog.generated.js` is never
 * touched automatically; promoting a proposal to the real catalog is a
 * deliberate, human-only step.
 */

const router: IRouter = Router();

// Anchor the proposals path to this source file rather than process.cwd()
// so the route works regardless of where the API server is launched from
// (monorepo root, artifacts/api-server, deployment image, etc.).
// __dirname here resolves to artifacts/api-server/src/routes; the
// proposals JSON lives at artifacts/srt-lab/src/lib/.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROPOSALS_PATH = path.resolve(
  __dirname,
  "../../../srt-lab/src/lib/bcmCatalogProposals.json",
);

const MAX_PROPOSALS = 1000;

interface Proposal {
  did: string;
  beforeBytes: string;
  afterBytes: string;
  firstDiffOffset?: number;
  suggestedFieldName?: string;
  notes?: string;
  acceptedAt?: string;
  beforeFile?: string;
  afterFile?: string;
  txId?: string;
  rxId?: string;
}

interface ProposalsFile {
  $schema?: string;
  _meta: { purpose: string; createdAt: string };
  proposals: Proposal[];
}

async function loadFile(): Promise<ProposalsFile> {
  const raw = await fs.readFile(PROPOSALS_PATH, "utf-8");
  const parsed = JSON.parse(raw) as ProposalsFile;
  if (!parsed.proposals || !Array.isArray(parsed.proposals)) {
    throw new Error("bcmCatalogProposals.json missing proposals array");
  }
  return parsed;
}

async function saveFile(file: ProposalsFile): Promise<void> {
  await fs.writeFile(PROPOSALS_PATH, JSON.stringify(file, null, 2) + "\n", "utf-8");
}

function isValidDid(s: unknown): s is string {
  return typeof s === "string" && /^0x[0-9A-Fa-f]{1,4}$/.test(s);
}
function isHexBytes(s: unknown): s is string {
  return typeof s === "string" && /^([0-9A-Fa-f]{2}\s?)*$/.test(s) && s.length <= 4096;
}

router.get("/bcm-catalog-proposals", async (req, res) => {
  try {
    const file = await loadFile();
    res.json(file);
  } catch (err) {
    req.log?.error?.({ err }, "load proposals failed");
    res.status(500).json({ error: "load_failed", message: String((err as Error).message) });
  }
});

router.post("/bcm-catalog-proposals", async (req, res) => {
  const body = req.body ?? {};
  const incoming: unknown[] = Array.isArray(body.proposals) ? body.proposals : [];
  if (!incoming.length) {
    res.status(400).json({ error: "no_proposals" });
    return;
  }

  const cleaned: Proposal[] = [];
  for (const item of incoming) {
    const p = item as Record<string, unknown>;
    if (!isValidDid(p.did)) { res.status(400).json({ error: "bad_did", item: p }); return; }
    if (!isHexBytes(p.beforeBytes)) { res.status(400).json({ error: "bad_before", item: p }); return; }
    if (!isHexBytes(p.afterBytes)) { res.status(400).json({ error: "bad_after", item: p }); return; }
    cleaned.push({
      did: p.did,
      beforeBytes: p.beforeBytes,
      afterBytes: p.afterBytes,
      firstDiffOffset: typeof p.firstDiffOffset === "number" ? p.firstDiffOffset : undefined,
      suggestedFieldName: typeof p.suggestedFieldName === "string" ? p.suggestedFieldName : undefined,
      notes: typeof p.notes === "string" ? p.notes : "Human review required before merging into bcmFeatureCatalog.generated.js",
      beforeFile: typeof p.beforeFile === "string" ? p.beforeFile : undefined,
      afterFile: typeof p.afterFile === "string" ? p.afterFile : undefined,
      txId: typeof p.txId === "string" ? p.txId : undefined,
      rxId: typeof p.rxId === "string" ? p.rxId : undefined,
      acceptedAt: new Date().toISOString(),
    });
  }

  try {
    const file = await loadFile();
    // Composite-key dedupe: a single DID can legitimately surface multiple
    // distinct proposals across captures (different toggles → different
    // before/after byte windows). Key on DID + beforeBytes + afterBytes +
    // firstDiffOffset so a re-acceptance of the same observation upserts
    // (refreshes acceptedAt / suggested name), but unrelated entries on
    // the same DID coexist in the review queue.
    const keyOf = (p: Proposal) =>
      `${p.did.toLowerCase()}|${(p.beforeBytes || "").toLowerCase()}|${(p.afterBytes || "").toLowerCase()}|${p.firstDiffOffset ?? -1}`;
    const byKey = new Map<string, Proposal>();
    for (const p of file.proposals) byKey.set(keyOf(p), p);
    for (const p of cleaned) byKey.set(keyOf(p), p);
    file.proposals = Array.from(byKey.values()).slice(-MAX_PROPOSALS);
    await saveFile(file);
    res.json({ ok: true, accepted: cleaned.length, total: file.proposals.length });
  } catch (err) {
    req.log?.error?.({ err }, "append proposals failed");
    res.status(500).json({ error: "append_failed", message: String((err as Error).message) });
  }
});

router.delete("/bcm-catalog-proposals", async (req, res) => {
  try {
    const file = await loadFile();
    file.proposals = [];
    await saveFile(file);
    res.json({ ok: true });
  } catch (err) {
    req.log?.error?.({ err }, "clear proposals failed");
    res.status(500).json({ error: "clear_failed", message: String((err as Error).message) });
  }
});

export default router;
