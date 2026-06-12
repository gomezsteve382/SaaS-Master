import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeBaseStore } from "../core/knowledgeBaseStore.js";
import { createKnowledgeEmbeddingProvider } from "../core/knowledgeEmbeddings.js";
import { CredentialVault } from "../security/credentialVault.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "goatmez-kb-v14-"));
  try {
    process.env.GOATMEZ_VAULT_KEY = "local-dev-master-key-123456";
    process.env.GOATMEZ_VAULT_PATH = join(root, "vault.json");
    process.env.GOATMEZ_KB_PATH = join(root, "knowledge.json");
    process.env.GOATMEZ_KB_DEFAULT_SEARCH_MODE = "keyword";

    process.env.GOATMEZ_KB_EMBEDDINGS_PROVIDER = "mock";
    const mockVault = new CredentialVault(process.env.GOATMEZ_VAULT_PATH, process.env.GOATMEZ_VAULT_KEY);
    const mockStore = new KnowledgeBaseStore(root, ".goatmez/knowledge.json", {
      embeddings: createKnowledgeEmbeddingProvider(mockVault)
    });

    await mockStore.ingestText({
      title: "PCM Notes",
      text: "PCM calibration mismatch can trigger drivetrain warnings and limp behavior.",
      tags: ["pcm", "diagnostics"]
    });
    await mockStore.ingestText({
      title: "BCM Notes",
      text: "BCM module sync should validate VIN and key pairing before final write.",
      tags: ["bcm", "vin"]
    });

    const keyword = await mockStore.search("vin key pairing", { mode: "keyword", limit: 5 });
    assert(keyword.effectiveMode === "keyword", "Keyword mode should stay keyword.");
    assert(keyword.results.length > 0, "Keyword search should return results.");

    const vector = await mockStore.search("drivetrain warning", { mode: "vector", limit: 5 });
    assert(vector.effectiveMode === "vector", "Vector mode should remain vector in mock mode.");
    assert(vector.results.length > 0, "Vector search should return results in mock mode.");

    const hybrid = await mockStore.search("module vin validation", { mode: "hybrid", limit: 5, hybridWeight: 0.5 });
    assert(hybrid.effectiveMode === "hybrid", "Hybrid mode should remain hybrid in mock mode.");
    assert(hybrid.results.length > 0, "Hybrid search should return results in mock mode.");

    process.env.GOATMEZ_KB_EMBEDDINGS_PROVIDER = "openai";
    const openAiVault = new CredentialVault(process.env.GOATMEZ_VAULT_PATH, process.env.GOATMEZ_VAULT_KEY);
    const fallbackStore = new KnowledgeBaseStore(root, ".goatmez/knowledge.json", {
      embeddings: createKnowledgeEmbeddingProvider(openAiVault)
    });
    await fallbackStore.ingestText({
      title: "Fallback Test",
      text: "This text validates fallback when OpenAI key is missing in vault.",
      tags: ["fallback"]
    });
    const fallback = await fallbackStore.search("fallback", { mode: "vector", limit: 5 });
    assert(fallback.effectiveMode === "keyword", "Vector mode should fallback to keyword without vault OpenAI key.");
    assert(Boolean(fallback.fallbackReason), "Fallback reason should be returned when vector mode degrades.");

    console.log("Knowledge v14 validation passed.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
