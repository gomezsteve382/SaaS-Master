import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { KnowledgeEmbeddingProvider, KnowledgeEmbeddingProviderMode } from "./knowledgeEmbeddings.js";
import { makeId } from "./id.js";
import { cosineSimilarity } from "./vectorMath.js";

export interface KnowledgeChunk {
  id: string;
  documentId: string;
  index: number;
  text: string;
  tokenEstimate: number;
  keywords: string[];
  createdAt: string;
  embedding?: KnowledgeChunkEmbedding;
}

export interface KnowledgeChunkEmbedding {
  vector: number[];
  provider: Exclude<KnowledgeEmbeddingProviderMode, "off">;
  model: string;
  dimensions: number;
  createdAt: string;
}

export interface KnowledgeDocument {
  id: string;
  title: string;
  sourceType: "file" | "text" | "url_note";
  source: string;
  tags: string[];
  checksum: string;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface KnowledgeSearchResult {
  document: KnowledgeDocument;
  chunk: KnowledgeChunk;
  score: number;
  highlights: string[];
  scoreDetails?: {
    keywordScore?: number;
    vectorScore?: number;
    hybridScore?: number;
  };
}

export type KnowledgeSearchMode = "keyword" | "vector" | "hybrid";

export interface KnowledgeSearchOptions {
  limit?: number;
  tags?: string[];
  mode?: KnowledgeSearchMode;
  hybridWeight?: number;
}

export interface KnowledgeSearchResponse {
  requestedMode: KnowledgeSearchMode;
  effectiveMode: KnowledgeSearchMode;
  fallbackReason?: string;
  results: KnowledgeSearchResult[];
}

export interface KnowledgeVectorizationStatus {
  provider: KnowledgeEmbeddingProviderMode;
  model: string;
  enabled: boolean;
  embeddedChunks: number;
  failedChunks: number;
  failureReason?: string;
}

export interface KnowledgeReindexOptions {
  documentId?: string;
  force?: boolean;
  limit?: number;
}

export interface KnowledgeReindexStatus {
  requestedDocumentId?: string;
  provider: KnowledgeEmbeddingProviderMode;
  model: string;
  enabled: boolean;
  processedChunks: number;
  updatedChunks: number;
  skippedChunks: number;
  failedChunks: number;
  updatedDocuments: number;
  failureReason?: string;
}

interface KnowledgeDatabaseShape {
  version: 2;
  updatedAt: string;
  documents: KnowledgeDocument[];
  chunks: KnowledgeChunk[];
}

const emptyKnowledgeDatabase = (): KnowledgeDatabaseShape => ({
  version: 2,
  updatedAt: new Date().toISOString(),
  documents: [],
  chunks: []
});

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function checksum(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}

function tokenize(value: string): string[] {
  const stop = new Set(["the", "and", "for", "with", "that", "this", "from", "are", "you", "your", "into", "will", "have", "has", "not", "but", "was", "were", "can", "all", "our", "out", "use", "using", "how", "what", "when", "where", "why"]);
  return [...new Set(value.toLowerCase().match(/[a-z0-9_#.-]{3,}/g) ?? [])].filter((word) => !stop.has(word));
}

function chunkText(text: string, maxChars = 1400): string[] {
  const paragraphs = text.split(/\n\s*\n/g).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs.length ? paragraphs : [text]) {
    if ((current + "\n\n" + paragraph).trim().length > maxChars && current.trim()) {
      chunks.push(current.trim());
      current = paragraph;
    } else {
      current = (current ? `${current}\n\n${paragraph}` : paragraph).trim();
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.flatMap((chunk) => {
    if (chunk.length <= maxChars * 1.5) return [chunk];
    const split: string[] = [];
    for (let cursor = 0; cursor < chunk.length; cursor += maxChars) split.push(chunk.slice(cursor, cursor + maxChars));
    return split;
  });
}

function normalizeSearchMode(value: unknown, fallback: KnowledgeSearchMode = "keyword"): KnowledgeSearchMode {
  if (value === "keyword" || value === "vector" || value === "hybrid") return value;
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "keyword" || normalized === "vector" || normalized === "hybrid") return normalized;
  return fallback;
}

function toLimit(value: unknown, fallback = 10): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(100, Math.floor(parsed)));
}

function toHybridWeight(value: unknown, fallback = 0.5): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

function toReindexLimit(value: unknown): number {
  if (value === undefined || value === null || value === "") return Number.MAX_SAFE_INTEGER;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return Number.MAX_SAFE_INTEGER;
  return Math.max(1, Math.min(25_000, Math.floor(parsed)));
}

function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]");
}

function parseEmbedding(raw: unknown): KnowledgeChunkEmbedding | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const vector = Array.isArray(value.vector) ? value.vector.map((item) => Number(item)).filter((item) => Number.isFinite(item)) : [];
  if (!vector.length) return undefined;
  const provider = value.provider === "mock" || value.provider === "openai" ? value.provider : undefined;
  if (!provider) return undefined;
  const model = typeof value.model === "string" && value.model.trim() ? value.model.trim() : "unknown";
  const dimensions = Number.isFinite(Number(value.dimensions)) ? Math.max(1, Math.floor(Number(value.dimensions))) : vector.length;
  const createdAt = typeof value.createdAt === "string" && value.createdAt.trim() ? value.createdAt : new Date().toISOString();
  return { vector, provider, model, dimensions, createdAt };
}

function parseDocument(raw: unknown): KnowledgeDocument | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === "string" && value.id.trim() ? value.id.trim() : makeId("kbdoc");
  const sourceType = value.sourceType === "file" || value.sourceType === "text" || value.sourceType === "url_note" ? value.sourceType : "text";
  const title = typeof value.title === "string" && value.title.trim() ? value.title.trim() : "Untitled knowledge document";
  const source = typeof value.source === "string" && value.source.trim() ? value.source.trim() : title;
  const tags = Array.isArray(value.tags) ? value.tags.map(String).map((item) => item.trim()).filter(Boolean) : [];
  const checksumValue = typeof value.checksum === "string" && value.checksum.trim() ? value.checksum.trim() : checksum(`${title}\n${source}`);
  const chunkCount = Number.isFinite(Number(value.chunkCount)) ? Math.max(0, Math.floor(Number(value.chunkCount))) : 0;
  const createdAt = typeof value.createdAt === "string" && value.createdAt.trim() ? value.createdAt : new Date().toISOString();
  const updatedAt = typeof value.updatedAt === "string" && value.updatedAt.trim() ? value.updatedAt : createdAt;
  const metadata = value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata) ? value.metadata as Record<string, unknown> : {};
  return { id, sourceType, title, source, tags, checksum: checksumValue, chunkCount, createdAt, updatedAt, metadata };
}

function parseChunk(raw: unknown): KnowledgeChunk | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const text = typeof value.text === "string" ? value.text.trim() : "";
  if (!text) return undefined;
  const id = typeof value.id === "string" && value.id.trim() ? value.id.trim() : makeId("kbchunk");
  const documentId = typeof value.documentId === "string" && value.documentId.trim() ? value.documentId.trim() : "";
  if (!documentId) return undefined;
  const index = Number.isFinite(Number(value.index)) ? Math.max(0, Math.floor(Number(value.index))) : 0;
  const tokenEstimate = Number.isFinite(Number(value.tokenEstimate)) ? Math.max(0, Math.floor(Number(value.tokenEstimate))) : Math.ceil(text.length / 4);
  const keywords = Array.isArray(value.keywords) ? value.keywords.map(String).map((item) => item.trim().toLowerCase()).filter(Boolean) : tokenize(text).slice(0, 40);
  const createdAt = typeof value.createdAt === "string" && value.createdAt.trim() ? value.createdAt : new Date().toISOString();
  const embedding = parseEmbedding(value.embedding);
  return { id, documentId, index, text, tokenEstimate, keywords, createdAt, embedding };
}

export class KnowledgeBaseStore {
  readonly path: string;
  private readonly defaultSearchMode: KnowledgeSearchMode;
  private readonly defaultHybridWeight: number;

  constructor(
    private readonly cwd: string,
    path = ".goatmez/knowledge.json",
    private readonly options: { embeddings?: KnowledgeEmbeddingProvider } = {}
  ) {
    this.path = resolve(cwd, process.env.GOATMEZ_KB_PATH || path);
    this.defaultSearchMode = normalizeSearchMode(process.env.GOATMEZ_KB_DEFAULT_SEARCH_MODE, "keyword");
    this.defaultHybridWeight = toHybridWeight(process.env.GOATMEZ_KB_HYBRID_KEYWORD_WEIGHT, 0.5);
  }

  read(): KnowledgeDatabaseShape {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<KnowledgeDatabaseShape> & { version?: number };
      const documents = Array.isArray(parsed.documents) ? parsed.documents.map(parseDocument).filter(Boolean) as KnowledgeDocument[] : [];
      const chunks = Array.isArray(parsed.chunks) ? parsed.chunks.map(parseChunk).filter(Boolean) as KnowledgeChunk[] : [];
      const migrated: KnowledgeDatabaseShape = {
        version: 2,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
        documents,
        chunks
      };
      if (parsed.version !== 2) this.write(migrated);
      return migrated;
    } catch (error: any) {
      if (error?.code === "ENOENT") return emptyKnowledgeDatabase();
      throw error;
    }
  }

  write(next: KnowledgeDatabaseShape): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify({ ...next, updatedAt: new Date().toISOString() }, null, 2));
  }

  listDocuments(): KnowledgeDocument[] {
    return [...this.read().documents].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getDocument(id: string): { document: KnowledgeDocument; chunks: KnowledgeChunk[] } | undefined {
    const db = this.read();
    const document = db.documents.find((item) => item.id === id);
    if (!document) return undefined;
    return { document, chunks: db.chunks.filter((chunk) => chunk.documentId === id).sort((a, b) => a.index - b.index) };
  }

  async ingestText(input: { title: string; text: string; source?: string; sourceType?: KnowledgeDocument["sourceType"]; tags?: string[]; metadata?: Record<string, unknown> }): Promise<{ document: KnowledgeDocument; chunks: KnowledgeChunk[]; replacedExisting: boolean; vectorization: KnowledgeVectorizationStatus }> {
    const text = normalizeText(input.text);
    if (!text) throw new Error("Knowledge text is empty.");
    const now = new Date().toISOString();
    const digest = checksum(`${input.title}\n${text}`);
    const pieces = chunkText(text);
    const documentId = makeId("kbdoc");
    const vectorization: KnowledgeVectorizationStatus = {
      provider: this.options.embeddings?.mode || "off",
      model: this.options.embeddings?.model || "none",
      enabled: Boolean(this.options.embeddings?.enabled),
      embeddedChunks: 0,
      failedChunks: 0
    };

    const document: KnowledgeDocument = {
      id: documentId,
      title: input.title.trim() || "Untitled knowledge document",
      sourceType: input.sourceType || "text",
      source: input.source || input.title,
      tags: [...new Set((input.tags || []).map((tag) => tag.trim()).filter(Boolean))],
      checksum: digest,
      chunkCount: pieces.length,
      createdAt: now,
      updatedAt: now,
      metadata: { ...(input.metadata || {}) }
    };
    const chunks = pieces.map((piece, index): KnowledgeChunk => ({
      id: makeId("kbchunk"),
      documentId,
      index,
      text: piece,
      tokenEstimate: Math.ceil(piece.length / 4),
      keywords: tokenize(piece).slice(0, 40),
      createdAt: now
    }));

    if (this.options.embeddings?.enabled) {
      let vectorizationFailed = false;
      for (const chunk of chunks) {
        if (vectorizationFailed) {
          vectorization.failedChunks += 1;
          continue;
        }
        try {
          const embedded = await this.options.embeddings.embed({ text: chunk.text });
          chunk.embedding = {
            vector: embedded.vector,
            provider: embedded.provider,
            model: embedded.model,
            dimensions: embedded.dimensions,
            createdAt: now
          };
          vectorization.embeddedChunks += 1;
        } catch (error) {
          vectorization.failedChunks += 1;
          vectorization.failureReason = sanitizeError(error);
          vectorizationFailed = true;
        }
      }
    } else if (this.options.embeddings?.reason) {
      vectorization.failureReason = this.options.embeddings.reason;
    }

    document.metadata.embedding = {
      provider: vectorization.provider,
      model: vectorization.model,
      enabled: vectorization.enabled,
      embeddedChunks: vectorization.embeddedChunks,
      failedChunks: vectorization.failedChunks,
      ...(vectorization.failureReason ? { failureReason: vectorization.failureReason } : {})
    };

    let replacedExisting = false;
    const db = this.read();
    const existing = db.documents.find((item) => item.checksum === digest || (item.source === document.source && item.title === document.title));
    if (existing) {
      replacedExisting = true;
      document.id = existing.id;
      document.createdAt = existing.createdAt;
      document.updatedAt = now;
      for (const chunk of chunks) chunk.documentId = existing.id;
      db.documents = [document, ...db.documents.filter((item) => item.id !== existing.id)];
      db.chunks = [...chunks, ...db.chunks.filter((chunk) => chunk.documentId !== existing.id)];
    } else {
      db.documents = [document, ...db.documents];
      db.chunks = [...chunks, ...db.chunks];
    }
    this.write(db);
    return { document, chunks, replacedExisting, vectorization };
  }

  async search(query: string, options: KnowledgeSearchOptions = {}): Promise<KnowledgeSearchResponse> {
    const cleanQuery = query.trim();
    const requestedMode = normalizeSearchMode(options.mode, this.defaultSearchMode);
    if (!cleanQuery) {
      return {
        requestedMode,
        effectiveMode: requestedMode,
        results: []
      };
    }

    const limit = toLimit(options.limit, 10);
    const queryTokens = tokenize(cleanQuery);
    const tagFilter = new Set((options.tags || []).map((tag) => tag.toLowerCase()));
    const db = this.read();
    const docsById = new Map(db.documents.map((document) => [document.id, document]));
    const scopedChunks = db.chunks.filter((chunk) => {
      const document = docsById.get(chunk.documentId);
      if (!document) return false;
      if (tagFilter.size && !document.tags.some((tag) => tagFilter.has(tag.toLowerCase()))) return false;
      return true;
    });

    const keywordEntries = scopedChunks.map((chunk) => {
      const document = docsById.get(chunk.documentId)!;
      const haystack = `${document.title}\n${document.tags.join(" ")}\n${chunk.text}`.toLowerCase();
      let keywordScore = 0;
      for (const token of queryTokens) {
        if (haystack.includes(token)) keywordScore += 4;
        if (chunk.keywords.includes(token)) keywordScore += 3;
      }
      if (haystack.includes(cleanQuery.toLowerCase())) keywordScore += 10;
      const highlights = queryTokens.slice(0, 6).filter((token) => haystack.includes(token));
      return { document, chunk, keywordScore, highlights };
    });

    const keywordResults = keywordEntries
      .filter((entry) => entry.keywordScore > 0)
      .sort((left, right) => right.keywordScore - left.keywordScore)
      .slice(0, limit)
      .map((entry): KnowledgeSearchResult => ({
        document: entry.document,
        chunk: entry.chunk,
        score: entry.keywordScore,
        highlights: entry.highlights,
        scoreDetails: { keywordScore: entry.keywordScore }
      }));

    if (requestedMode === "keyword") {
      return { requestedMode, effectiveMode: "keyword", results: keywordResults };
    }

    const vectorChunks = scopedChunks.filter((chunk) => chunk.embedding?.vector?.length);
    if (!this.options.embeddings?.enabled) {
      return {
        requestedMode,
        effectiveMode: "keyword",
        fallbackReason: this.options.embeddings?.reason || "Embeddings provider is unavailable.",
        results: keywordResults
      };
    }

    if (!vectorChunks.length) {
      return {
        requestedMode,
        effectiveMode: "keyword",
        fallbackReason: "No vectors are stored yet. Re-ingest content with embeddings enabled.",
        results: keywordResults
      };
    }

    let queryVector: number[] = [];
    try {
      queryVector = (await this.options.embeddings.embed({ text: cleanQuery })).vector;
    } catch (error) {
      return {
        requestedMode,
        effectiveMode: "keyword",
        fallbackReason: `Vector query failed: ${sanitizeError(error)}`,
        results: keywordResults
      };
    }

    const vectorEntries = vectorChunks.map((chunk) => {
      const document = docsById.get(chunk.documentId)!;
      const vector = chunk.embedding!.vector;
      const cosine = cosineSimilarity(queryVector, vector);
      const vectorScore = (cosine + 1) / 2;
      const haystack = `${document.title}\n${document.tags.join(" ")}\n${chunk.text}`.toLowerCase();
      const highlights = queryTokens.slice(0, 6).filter((token) => haystack.includes(token));
      return { document, chunk, vectorScore, highlights };
    });

    if (requestedMode === "vector") {
      const results = vectorEntries
        .sort((left, right) => right.vectorScore - left.vectorScore)
        .slice(0, limit)
        .map((entry): KnowledgeSearchResult => ({
          document: entry.document,
          chunk: entry.chunk,
          score: Number((entry.vectorScore * 100).toFixed(3)),
          highlights: entry.highlights,
          scoreDetails: { vectorScore: Number(entry.vectorScore.toFixed(6)) }
        }));
      return { requestedMode, effectiveMode: "vector", results };
    }

    const keywordByChunk = new Map(keywordEntries.map((entry) => [entry.chunk.id, entry.keywordScore]));
    const vectorByChunk = new Map(vectorEntries.map((entry) => [entry.chunk.id, entry.vectorScore]));
    const keywordMax = Math.max(1, ...keywordEntries.map((entry) => entry.keywordScore));
    const weight = toHybridWeight(options.hybridWeight, this.defaultHybridWeight);

    const hybridResults = scopedChunks
      .map((chunk) => {
        const document = docsById.get(chunk.documentId)!;
        const keywordScore = keywordByChunk.get(chunk.id) || 0;
        const vectorScore = vectorByChunk.get(chunk.id) || 0;
        const keywordNormalized = keywordScore > 0 ? keywordScore / keywordMax : 0;
        const hybridScore = (weight * keywordNormalized) + ((1 - weight) * vectorScore);
        const haystack = `${document.title}\n${document.tags.join(" ")}\n${chunk.text}`.toLowerCase();
        const highlights = queryTokens.slice(0, 6).filter((token) => haystack.includes(token));
        return {
          document,
          chunk,
          highlights,
          keywordScore,
          vectorScore,
          hybridScore
        };
      })
      .sort((left, right) => right.hybridScore - left.hybridScore)
      .slice(0, limit)
      .map((entry): KnowledgeSearchResult => ({
        document: entry.document,
        chunk: entry.chunk,
        score: Number((entry.hybridScore * 100).toFixed(3)),
        highlights: entry.highlights,
        scoreDetails: {
          keywordScore: entry.keywordScore,
          vectorScore: Number(entry.vectorScore.toFixed(6)),
          hybridScore: Number(entry.hybridScore.toFixed(6))
        }
      }));

    return { requestedMode, effectiveMode: "hybrid", results: hybridResults };
  }

  async reindexEmbeddings(options: KnowledgeReindexOptions = {}): Promise<KnowledgeReindexStatus> {
    const status: KnowledgeReindexStatus = {
      requestedDocumentId: options.documentId,
      provider: this.options.embeddings?.mode || "off",
      model: this.options.embeddings?.model || "none",
      enabled: Boolean(this.options.embeddings?.enabled),
      processedChunks: 0,
      updatedChunks: 0,
      skippedChunks: 0,
      failedChunks: 0,
      updatedDocuments: 0
    };

    const db = this.read();
    const documentFilter = typeof options.documentId === "string" && options.documentId.trim() ? options.documentId.trim() : undefined;
    const documents = documentFilter ? db.documents.filter((document) => document.id === documentFilter) : [...db.documents];
    if (documentFilter && documents.length === 0) {
      status.failureReason = `Knowledge document not found: ${documentFilter}`;
      return status;
    }

    if (!this.options.embeddings?.enabled) {
      status.failureReason = this.options.embeddings?.reason || "Embeddings provider is unavailable.";
      return status;
    }

    const now = new Date().toISOString();
    const targetDocumentIds = new Set(documents.map((document) => document.id));
    const force = options.force === true;
    const limit = toReindexLimit(options.limit);
    const affectedDocuments = new Set<string>();

    for (const chunk of db.chunks) {
      if (!targetDocumentIds.has(chunk.documentId)) continue;
      if (status.processedChunks >= limit) break;
      status.processedChunks += 1;

      const alreadyFresh = Boolean(
        !force &&
        chunk.embedding &&
        chunk.embedding.provider === this.options.embeddings.mode &&
        chunk.embedding.model === this.options.embeddings.model &&
        chunk.embedding.vector.length > 0
      );
      if (alreadyFresh) {
        status.skippedChunks += 1;
        continue;
      }

      try {
        const embedded = await this.options.embeddings.embed({ text: chunk.text });
        chunk.embedding = {
          vector: embedded.vector,
          provider: embedded.provider,
          model: embedded.model,
          dimensions: embedded.dimensions,
          createdAt: now
        };
        status.updatedChunks += 1;
        affectedDocuments.add(chunk.documentId);
      } catch (error) {
        status.failedChunks += 1;
        if (!status.failureReason) status.failureReason = sanitizeError(error);
      }
    }

    if (affectedDocuments.size > 0) {
      for (const document of db.documents) {
        if (!affectedDocuments.has(document.id)) continue;
        const docChunks = db.chunks.filter((chunk) => chunk.documentId === document.id);
        const embeddedChunks = docChunks.filter((chunk) => chunk.embedding?.vector?.length).length;
        const failedChunks = Math.max(0, docChunks.length - embeddedChunks);
        document.updatedAt = now;
        document.metadata = {
          ...(document.metadata || {}),
          embedding: {
            provider: status.provider,
            model: status.model,
            enabled: status.enabled,
            embeddedChunks,
            failedChunks
          }
        };
      }
      status.updatedDocuments = affectedDocuments.size;
      this.write(db);
    }

    return status;
  }

  deleteDocument(id: string): boolean {
    const db = this.read();
    const before = db.documents.length;
    db.documents = db.documents.filter((document) => document.id !== id);
    db.chunks = db.chunks.filter((chunk) => chunk.documentId !== id);
    const deleted = db.documents.length !== before;
    if (deleted) this.write(db);
    return deleted;
  }
}
