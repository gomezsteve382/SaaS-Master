/**
 * SRT Lab — Per-Agent MCP Server Endpoints
 *
 * Each specialist agent gets its own MCP endpoint:
 *   /mcp/ghost    — Crypto tools only
 *   /mcp/phantom  — Protocol tools only
 *   /mcp/specter  — Code recovery tools only
 *   /mcp/wraith   — Memory tools only
 *   /mcp/shade    — Security tools only
 *
 * External MCP clients can connect to individual agents for
 * domain-specific analysis.
 */

import express from "express";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { tools, getToolByName } from "../tools/index.js";
import { SPECIALIST_AGENTS, type SwarmAgent } from "./agents.js";

// ─── Create MCP Server for a specific agent ─────────────────────────────────

function createAgentMCPServer(agent: SwarmAgent): Server {
  const agentTools = tools.filter(t => agent.toolNames.includes(t.name));

  const server = new Server(
    {
      name: `srt-lab-${agent.id}`,
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );

  // List only this agent's tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: agentTools.map((t) => ({
        name: t.name,
        description: `[${agent.codename}] ${t.description}`,
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

  // Call tool — restricted to this agent's tool set
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = agentTools.find(t => t.name === name);

    if (!tool) {
      return {
        content: [{ type: "text", text: `[${agent.codename}] Tool '${name}' not available. Available: ${agentTools.map(t => t.name).join(", ")}` }],
        isError: true,
      };
    }

    const filePath = (args as any)?.file_path || (args as any)?.filePath || "";

    try {
      const startTime = Date.now();
      const result = await tool.call(args as Record<string, unknown>, filePath);
      const durationMs = Date.now() - startTime;
      console.log(`[MCP/${agent.codename}] Tool ${name} completed in ${durationMs}ms`);

      return {
        content: [{ type: "text", text: result }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `[${agent.codename}] Tool error: ${err.message}` }],
        isError: true,
      };
    }
  });

  // Resources — agent info
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        {
          uri: `srtlab://${agent.id}/info`,
          name: `${agent.codename} Agent Info`,
          description: `Information about the ${agent.codename} specialist agent`,
          mimeType: "text/plain",
        },
      ],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: "text/plain",
          text: `${agent.codename} — ${agent.specialty}
Experience: ${agent.yearsExp} years
Tools: ${agent.toolNames.join(", ")}

System Prompt:
${agent.systemPrompt.slice(0, 500)}...`,
        },
      ],
    };
  });

  return server;
}

// ─── Register per-agent MCP routes on an Express app ────────────────────────

export function registerAgentMCPRoutes(app: express.Express): void {
  for (const agent of SPECIALIST_AGENTS) {
    const basePath = `/mcp/${agent.id}`;
    const transports = new Map<string, StreamableHTTPServerTransport>();

    // POST /mcp/{agentId} — JSON-RPC requests
    app.post(basePath, async (req, res) => {
      const sessionId = (req.headers["mcp-session-id"] as string) ?? undefined;
      let transport = sessionId ? transports.get(sessionId) : undefined;

      if (!transport) {
        const server = createAgentMCPServer(agent);
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

    // GET /mcp/{agentId} — SSE stream
    app.get(basePath, async (req, res) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId || !transports.has(sessionId)) {
        res.status(400).json({ error: `Invalid session for ${agent.codename}` });
        return;
      }
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res);
    });

    // DELETE /mcp/{agentId} — Close session
    app.delete(basePath, async (req, res) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!;
        await transport.close();
        transports.delete(sessionId);
      }
      res.status(200).json({ ok: true });
    });

    console.log(`  [MCP] ${agent.codename} agent endpoint: ${basePath} (${agent.toolNames.length} tools)`);
  }

  // Health check for all agents
  app.get("/mcp/agents", (_req, res) => {
    res.json({
      agents: SPECIALIST_AGENTS.map(a => ({
        id: a.id,
        codename: a.codename,
        specialty: a.specialty,
        yearsExp: a.yearsExp,
        tools: a.toolNames,
        endpoint: `/mcp/${a.id}`,
      })),
    });
  });
}
