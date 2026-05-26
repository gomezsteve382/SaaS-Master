#!/usr/bin/env node
/**
 * SRT Lab MCP Server
 *
 * Exposes all 8 binary analysis tools as a proper MCP server that external
 * clients (Claude Desktop, VS Code Copilot, Cursor, etc.) can connect to.
 *
 * Supports:
 *   - Streamable HTTP transport (POST /mcp for JSON-RPC, GET /mcp for SSE)
 *   - Legacy SSE transport (GET /sse, POST /messages)
 *   - Health check at GET /health
 *
 * Environment:
 *   MCP_PORT    — HTTP port (default: 3100)
 *   MCP_API_KEY — Optional bearer token for authentication
 *
 * Usage:
 *   npx tsx server/mcp.ts
 *   # or
 *   pnpm mcp:start
 */

import express from "express";
import { randomUUID } from "node:crypto";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { tools, getToolByName } from "./tools/index.js";

const MCP_PORT = parseInt(process.env.MCP_PORT ?? "3100", 10);
const API_KEY = process.env.MCP_API_KEY;

// ─── MCP Server Factory ─────────────────────────────────────────────────────

function createSRTLabServer(): Server {
  const server = new Server(
    {
      name: "srt-lab-ultimate",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );

  // ── List Tools ──────────────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: {
          type: "object" as const,
          properties: Object.fromEntries(
            Object.entries(t.inputSchema.properties).map(([key, val]) => [
              key,
              {
                type: (val as any).type,
                description: (val as any).description,
                ...(val as any).enum ? { enum: (val as any).enum } : {},
              },
            ])
          ),
          required: t.inputSchema.required || [],
        },
      })),
    };
  });

  // ── Call Tool ───────────────────────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = getToolByName(name);

    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    // The tool needs a file path. Check if one was provided in args,
    // otherwise create a temp placeholder.
    const filePath = (args as any)?.file_path || (args as any)?.filePath || "";

    try {
      const startTime = Date.now();
      const result = await tool.call(args as Record<string, unknown>, filePath);
      const durationMs = Date.now() - startTime;

      console.log(`[MCP] Tool ${name} completed in ${durationMs}ms (${result.length} chars)`);

      return {
        content: [{ type: "text", text: result }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Tool error: ${err.message}` }],
        isError: true,
      };
    }
  });

  // ── List Resources (metadata about the server) ─────────────────────────
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        {
          uri: "srtlab://info",
          name: "SRT Lab Info",
          description: "Information about SRT Lab: Ultimate Edition and its capabilities",
          mimeType: "text/plain",
        },
      ],
    };
  });

  // ── Read Resource ──────────────────────────────────────────────────────
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === "srtlab://info") {
      return {
        contents: [
          {
            uri,
            mimeType: "text/plain",
            text: `SRT Lab: Ultimate Edition — AI-Powered Reverse Engineering Agent

Available tools:
${tools.map((t) => `  - ${t.name}: ${t.description}`).join("\n")}

This MCP server exposes binary analysis tools for:
- FCA/Stellantis automotive module reverse engineering
- PE/ELF binary analysis, import/export extraction
- PyInstaller decompilation and Python bytecode recovery
- CRC algorithm detection, seed key extraction
- CAN bus ID discovery, UDS security access analysis
- SKIM pairing, RFHUB programming, GPEC unlock sequences

Connect from Claude Desktop, VS Code, Cursor, or any MCP client.`,
          },
        ],
      };
    }

    return { contents: [] };
  });

  return server;
}

// ─── Auth Middleware ──────────────────────────────────────────────────────────

function authMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  if (!API_KEY) return next();
  if (req.path === "/health") return next();

  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${API_KEY}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// ─── Streamable HTTP Transport ───────────────────────────────────────────────

async function startStreamableHTTP(app: express.Express): Promise<void> {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post("/mcp", async (req, res) => {
    const sessionId = (req.headers["mcp-session-id"] as string) ?? undefined;
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      const server = createSRTLabServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      await server.connect(transport);

      transport.onclose = () => {
        if (transport!.sessionId) {
          transports.delete(transport!.sessionId);
        }
      };
    }

    await transport.handleRequest(req, res, req.body);

    if (transport.sessionId && !transports.has(transport.sessionId)) {
      transports.set(transport.sessionId, transport);
    }
  });

  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: "Invalid or missing session ID" });
      return;
    }
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.close();
      transports.delete(sessionId);
    }
    res.status(200).json({ ok: true });
  });
}

// ─── Legacy SSE Transport ────────────────────────────────────────────────────

async function startLegacySSE(app: express.Express): Promise<void> {
  const transports = new Map<string, SSEServerTransport>();

  app.get("/sse", async (_req, res) => {
    const server = createSRTLabServer();
    const transport = new SSEServerTransport("/messages", res);
    transports.set(transport.sessionId, transport);
    transport.onclose = () => {
      transports.delete(transport.sessionId);
    };
    await server.connect(transport);
  });

  app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(400).json({ error: "Unknown session" });
      return;
    }
    await transport.handlePostMessage(req, res, req.body);
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);

  // Health check
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server: "srt-lab-ultimate-mcp",
      version: "1.0.0",
      tools: tools.map((t) => t.name),
    });
  });

  // Register both transports
  await startStreamableHTTP(app);
  await startLegacySSE(app);

  app.listen(MCP_PORT, () => {
    console.log(`\n  SRT Lab MCP Server listening on port ${MCP_PORT}`);
    console.log(`  ─────────────────────────────────────────────`);
    console.log(`  Streamable HTTP: POST/GET http://localhost:${MCP_PORT}/mcp`);
    console.log(`  Legacy SSE:      GET http://localhost:${MCP_PORT}/sse`);
    console.log(`  Health:          GET http://localhost:${MCP_PORT}/health`);
    console.log(`  Tools:           ${tools.map((t) => t.name).join(", ")}`);
    if (API_KEY) console.log("  Auth:            Bearer token required");
    console.log();
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
