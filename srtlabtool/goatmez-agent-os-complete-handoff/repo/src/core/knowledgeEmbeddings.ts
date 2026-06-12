import { createHash } from "node:crypto";
import { CredentialVault } from "../security/credentialVault.js";
import { normalizeL2 } from "./vectorMath.js";

export type KnowledgeEmbeddingProviderMode = "off" | "mock" | "openai";

export interface KnowledgeEmbeddingRequest {
  text: string;
}

export interface KnowledgeEmbeddingVector {
  vector: number[];
  model: string;
  provider: Exclude<KnowledgeEmbeddingProviderMode, "off">;
  dimensions: number;
}

export interface KnowledgeEmbeddingProvider {
  readonly mode: KnowledgeEmbeddingProviderMode;
  readonly enabled: boolean;
  readonly model: string;
  readonly reason?: string;
  embed(input: KnowledgeEmbeddingRequest): Promise<KnowledgeEmbeddingVector>;
}

function toMode(value: string | undefined): KnowledgeEmbeddingProviderMode {
  const normalized = (value || "off").trim().toLowerCase();
  if (normalized === "mock" || normalized === "openai" || normalized === "off") return normalized;
  return "off";
}

function toPositiveInt(input: string | undefined, fallback: number, min = 8, max = 4096): number {
  const value = Number(input);
  if (!Number.isFinite(value) || value < min) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function hashToFloat(token: string, salt: string): number {
  const digest = createHash("sha256").update(`${salt}:${token}`).digest();
  const raw = digest.readUInt32BE(0) / 0xffffffff;
  return raw * 2 - 1;
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]");
}

class MockEmbeddingProvider implements KnowledgeEmbeddingProvider {
  readonly mode = "mock" as const;
  readonly enabled = true;
  readonly model = "mock-embedding-v1";

  constructor(private readonly dimensions: number) {}

  async embed(input: KnowledgeEmbeddingRequest): Promise<KnowledgeEmbeddingVector> {
    const raw = input.text.trim().toLowerCase();
    const tokens = raw.match(/[a-z0-9_#.-]{2,}/g) ?? [];
    const seedTokens = tokens.length ? tokens : [raw || "empty"];
    const vector = new Array(this.dimensions).fill(0);

    for (const token of seedTokens) {
      for (let hop = 0; hop < 4; hop += 1) {
        const signed = hashToFloat(token, `hop-${hop}`);
        const indexRaw = Math.abs(Math.floor(hashToFloat(token, `idx-${hop}`) * 1_000_000));
        const index = indexRaw % this.dimensions;
        vector[index] += signed;
      }
    }

    const normalized = normalizeL2(vector);
    return {
      vector: normalized,
      model: this.model,
      provider: "mock",
      dimensions: normalized.length
    };
  }
}

class OpenAiEmbeddingProvider implements KnowledgeEmbeddingProvider {
  readonly mode = "openai" as const;
  readonly enabled = true;

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly baseUrl: string
  ) {}

  async embed(input: KnowledgeEmbeddingRequest): Promise<KnowledgeEmbeddingVector> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        input: input.text,
        encoding_format: "float"
      })
    });

    if (!response.ok) {
      const raw = await response.text();
      const excerpt = raw.slice(0, 240);
      throw new Error(`OpenAI embeddings request failed (${response.status}): ${sanitizeError(excerpt)}`);
    }

    const payload = await response.json() as {
      data?: Array<{ embedding?: number[] }>;
      model?: string;
    };
    const vector = payload.data?.[0]?.embedding;
    if (!Array.isArray(vector) || !vector.length || !vector.every((item) => Number.isFinite(item))) {
      throw new Error("OpenAI embeddings response did not include a valid vector.");
    }
    return {
      vector: normalizeL2(vector.map((value) => Number(value))),
      model: payload.model || this.model,
      provider: "openai",
      dimensions: vector.length
    };
  }
}

class DisabledEmbeddingProvider implements KnowledgeEmbeddingProvider {
  readonly enabled = false;

  constructor(
    readonly mode: KnowledgeEmbeddingProviderMode,
    readonly model: string,
    readonly reason: string
  ) {}

  async embed(): Promise<KnowledgeEmbeddingVector> {
    throw new Error(this.reason);
  }
}

export function createKnowledgeEmbeddingProvider(vault: CredentialVault): KnowledgeEmbeddingProvider {
  const mode = toMode(process.env.GOATMEZ_KB_EMBEDDINGS_PROVIDER);
  const mockDimensions = toPositiveInt(process.env.GOATMEZ_KB_MOCK_EMBED_DIMENSIONS, 192);
  const openAiModel = (process.env.GOATMEZ_KB_EMBEDDINGS_MODEL || "text-embedding-3-small").trim();
  const openAiBaseUrl = (process.env.GOATMEZ_KB_EMBEDDINGS_BASE_URL || "https://api.openai.com/v1").trim().replace(/\/+$/, "");

  if (mode === "off") {
    return new DisabledEmbeddingProvider("off", "none", "Embeddings provider is disabled (GOATMEZ_KB_EMBEDDINGS_PROVIDER=off).");
  }
  if (mode === "mock") {
    return new MockEmbeddingProvider(mockDimensions);
  }

  if (!vault.configured) {
    return new DisabledEmbeddingProvider(
      "openai",
      openAiModel,
      "OpenAI embeddings require a configured vault key (set GOATMEZ_VAULT_KEY)."
    );
  }

  const apiKey = vault.tryResolve("OPENAI_API_KEY", "openai") || vault.tryResolve("OPENAI_API_KEY", "workspace");
  if (!apiKey) {
    return new DisabledEmbeddingProvider(
      "openai",
      openAiModel,
      "OpenAI embeddings key is missing in vault. Save OPENAI_API_KEY under 'openai' or 'workspace' scope."
    );
  }

  return new OpenAiEmbeddingProvider(apiKey, openAiModel, openAiBaseUrl);
}
