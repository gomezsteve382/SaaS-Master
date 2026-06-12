import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { KnowledgeBaseStore, KnowledgeSearchMode } from "../core/knowledgeBaseStore.js";
import { ToolDefinition } from "../core/types.js";

function assertObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Input must be an object.");
  return input as Record<string, unknown>;
}

function assertSafeWorkspacePath(cwd: string, requested: unknown): string {
  if (typeof requested !== "string" || !requested.trim()) throw new Error("path is required.");
  const fullPath = resolve(cwd, requested);
  if (!fullPath.startsWith(resolve(cwd))) throw new Error("Path must stay inside the workspace.");
  if (!existsSync(fullPath)) throw new Error(`File not found: ${requested}`);
  const stat = statSync(fullPath);
  if (!stat.isFile()) throw new Error(`Path is not a file: ${requested}`);
  if (stat.size > 1_500_000) throw new Error("File is too large for local ingestion. Keep files under 1.5 MB for v13.");
  return fullPath;
}

function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((tag) => tag.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((tag) => tag.trim()).filter(Boolean);
  return [];
}

function parseMode(value: unknown): KnowledgeSearchMode | undefined {
  if (value === "keyword" || value === "vector" || value === "hybrid") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "keyword" || normalized === "vector" || normalized === "hybrid") return normalized;
  return undefined;
}

export function createKnowledgeListTool(store: KnowledgeBaseStore): ToolDefinition {
  return {
    name: "kb.list",
    description: "List documents that have been ingested into the local knowledge base.",
    riskLevel: "low",
    requiresApproval: false,
    allowedPermissionModes: ["read_only", "draft_only", "approval_required", "workspace_write", "trusted_operator"],
    inputSchema: { type: "object", properties: { limit: { type: "number" } }, additionalProperties: false },
    validate(input) {
      const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
      return { limit: typeof value.limit === "number" ? value.limit : Number(value.limit || 25) };
    },
    async execute(call) {
      const docs = store.listDocuments().slice(0, Math.max(1, Number((call.input as any).limit || 25)));
      return {
        ok: true,
        toolName: "kb.list",
        callId: call.id,
        output: docs,
        summary: `Knowledge base contains ${docs.length} visible document(s).`,
        audit: { count: docs.length }
      };
    }
  };
}

export function createKnowledgeReadTool(store: KnowledgeBaseStore): ToolDefinition {
  return {
    name: "kb.read",
    description: "Read an ingested knowledge-base document and its chunks by document id.",
    riskLevel: "low",
    requiresApproval: false,
    allowedPermissionModes: ["read_only", "draft_only", "approval_required", "workspace_write", "trusted_operator"],
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false },
    validate(input) {
      const body = assertObject(input);
      if (typeof body.id !== "string" || !body.id.trim()) throw new Error("id is required.");
      return { id: body.id.trim() };
    },
    async execute(call) {
      const found = store.getDocument((call.input as any).id);
      if (!found) throw new Error("Knowledge document not found.");
      return {
        ok: true,
        toolName: "kb.read",
        callId: call.id,
        output: found,
        summary: `Read ${found.document.title} with ${found.chunks.length} chunk(s).`,
        audit: { documentId: found.document.id, chunks: found.chunks.length }
      };
    }
  };
}

export function createKnowledgeSearchTool(store: KnowledgeBaseStore): ToolDefinition {
  return {
    name: "kb.search",
    description: "Search the local knowledge base and return ranked document chunks with highlights.",
    riskLevel: "low",
    requiresApproval: false,
    allowedPermissionModes: ["read_only", "draft_only", "approval_required", "workspace_write", "trusted_operator"],
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
        tags: { type: "array", items: { type: "string" } },
        mode: { type: "string", enum: ["keyword", "vector", "hybrid"] },
        hybridWeight: { type: "number", minimum: 0, maximum: 1 }
      },
      additionalProperties: false
    },
    validate(input) {
      const body = assertObject(input);
      if (typeof body.query !== "string" || !body.query.trim()) throw new Error("query is required.");
      return {
        query: body.query.trim(),
        limit: typeof body.limit === "number" ? body.limit : Number(body.limit || 10),
        tags: parseTags(body.tags),
        mode: parseMode(body.mode),
        hybridWeight: typeof body.hybridWeight === "number" ? body.hybridWeight : Number(body.hybridWeight)
      };
    },
    async execute(call) {
      const input = call.input as any;
      const search = await store.search(input.query, {
        limit: input.limit,
        tags: input.tags,
        mode: input.mode,
        hybridWeight: input.hybridWeight
      });
      return {
        ok: true,
        toolName: "kb.search",
        callId: call.id,
        output: search,
        summary: `Found ${search.results.length} knowledge result(s) for "${input.query}" (${search.effectiveMode} mode).`,
        audit: {
          query: input.query,
          count: search.results.length,
          requestedMode: search.requestedMode,
          effectiveMode: search.effectiveMode,
          fallbackReason: search.fallbackReason
        }
      };
    }
  };
}

export function createKnowledgeIngestFileTool(cwd: string, store: KnowledgeBaseStore): ToolDefinition {
  return {
    name: "kb.ingestFile",
    description: "Ingest a workspace text/markdown/code file into the local knowledge base for future agent retrieval.",
    riskLevel: "medium",
    requiresApproval: false,
    allowedPermissionModes: ["approval_required", "workspace_write", "trusted_operator"],
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" }, title: { type: "string" }, tags: { type: "array", items: { type: "string" } } },
      additionalProperties: false
    },
    validate(input) {
      const body = assertObject(input);
      return { path: String(body.path || "").trim(), title: typeof body.title === "string" ? body.title.trim() : undefined, tags: parseTags(body.tags) };
    },
    async execute(call) {
      const input = call.input as any;
      const fullPath = assertSafeWorkspacePath(cwd, input.path);
      const raw = readFileSync(fullPath, "utf8");
      const result = await store.ingestText({ title: input.title || input.path, text: raw, source: input.path, sourceType: "file", tags: input.tags, metadata: { sizeBytes: Buffer.byteLength(raw) } });
      return {
        ok: true,
        toolName: "kb.ingestFile",
        callId: call.id,
        output: result,
        summary: `${result.replacedExisting ? "Updated" : "Ingested"} ${result.document.title} into knowledge base with ${result.chunks.length} chunk(s).`,
        audit: { documentId: result.document.id, path: input.path, chunks: result.chunks.length }
      };
    }
  };
}

export function createKnowledgeIngestTextTool(store: KnowledgeBaseStore): ToolDefinition {
  return {
    name: "kb.ingestText",
    description: "Ingest pasted text into the local knowledge base with a title and optional tags.",
    riskLevel: "medium",
    requiresApproval: false,
    allowedPermissionModes: ["approval_required", "workspace_write", "trusted_operator"],
    inputSchema: {
      type: "object",
      required: ["title", "text"],
      properties: { title: { type: "string" }, text: { type: "string" }, tags: { type: "array", items: { type: "string" } } },
      additionalProperties: false
    },
    validate(input) {
      const body = assertObject(input);
      if (typeof body.title !== "string" || !body.title.trim()) throw new Error("title is required.");
      if (typeof body.text !== "string" || !body.text.trim()) throw new Error("text is required.");
      return { title: body.title.trim(), text: body.text, tags: parseTags(body.tags) };
    },
    async execute(call) {
      const input = call.input as any;
      const result = await store.ingestText({ title: input.title, text: input.text, source: input.title, sourceType: "text", tags: input.tags });
      return {
        ok: true,
        toolName: "kb.ingestText",
        callId: call.id,
        output: result,
        summary: `${result.replacedExisting ? "Updated" : "Ingested"} ${result.document.title} into knowledge base with ${result.chunks.length} chunk(s).`,
        audit: { documentId: result.document.id, chunks: result.chunks.length }
      };
    }
  };
}

export function createKnowledgeReindexTool(store: KnowledgeBaseStore): ToolDefinition {
  return {
    name: "kb.reindex",
    description: "Rebuild embeddings for existing knowledge chunks without re-ingesting documents.",
    riskLevel: "medium",
    requiresApproval: false,
    allowedPermissionModes: ["approval_required", "workspace_write", "trusted_operator"],
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string" },
        force: { type: "boolean" },
        limit: { type: "number" }
      },
      additionalProperties: false
    },
    validate(input) {
      const body = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
      return {
        documentId: typeof body.documentId === "string" && body.documentId.trim() ? body.documentId.trim() : undefined,
        force: body.force === true,
        limit: typeof body.limit === "number" ? body.limit : Number(body.limit)
      };
    },
    async execute(call) {
      const input = call.input as any;
      const output = await store.reindexEmbeddings({
        documentId: input.documentId,
        force: input.force,
        limit: Number.isFinite(input.limit) ? input.limit : undefined
      });
      return {
        ok: true,
        toolName: "kb.reindex",
        callId: call.id,
        output,
        summary: `Reindex complete: ${output.updatedChunks} updated, ${output.skippedChunks} skipped, ${output.failedChunks} failed.`,
        audit: {
          documentId: output.requestedDocumentId,
          provider: output.provider,
          model: output.model,
          processed: output.processedChunks,
          updated: output.updatedChunks,
          skipped: output.skippedChunks,
          failed: output.failedChunks,
          failureReason: output.failureReason
        }
      };
    }
  };
}
