import "dotenv/config";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSystem } from "../app/createSystem.js";
import { makeId } from "../core/id.js";
import { executeApprovedToolCall } from "../core/approvalExecutor.js";
import { getModelRouterStatus } from "../models/modelRouter.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const staticRoot = resolve(__dirname, "static");

type JsonBody = Record<string, unknown>;

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function getDashboardToken(): string {
  return (process.env.GOATMEZ_DASHBOARD_TOKEN || "").trim();
}

function isAuthorized(req: IncomingMessage): boolean {
  const token = getDashboardToken();
  if (!token) return true;
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const header = req.headers["x-goatmez-token"];
  const bearer = typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Bearer ")
    ? req.headers.authorization.slice("Bearer ".length)
    : "";
  return header === token || bearer === token || url.searchParams.get("token") === token;
}

async function readJson(req: IncomingMessage): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw) as JsonBody;
}

async function readJsonl(path: string, limit = 100): Promise<unknown[]> {
  let raw = "";
  try {
    raw = await readFile(path, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .slice(-limit)
    .reverse();
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const requested = pathname === "/" ? "dashboard.html" : pathname.replace(/^\//, "");
  const fullPath = resolve(staticRoot, requested);
  if (!fullPath.startsWith(staticRoot)) return sendText(res, 403, "Forbidden");
  const ext = extname(fullPath);
  res.writeHead(200, { "content-type": contentTypes[ext] ?? "application/octet-stream" });
  createReadStream(fullPath)
    .on("error", () => sendText(res, 404, "Not found"))
    .pipe(res);
}

async function main(): Promise<void> {
  const port = Number(process.env.GOATMEZ_DASHBOARD_PORT || 8787);
  const system = await createSystem();
  const schedulerEnabled = (process.env.GOATMEZ_SCHEDULER_ENABLED || "true").toLowerCase() !== "false";
  const schedulerPollMs = Math.max(2500, Number(process.env.GOATMEZ_SCHEDULER_POLL_MS || 15000));

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const { pathname } = url;

      if (pathname.startsWith("/api/")) {
        if (req.method === "GET" && pathname === "/api/auth/status") {
          return sendJson(res, 200, { protected: Boolean(getDashboardToken()), ok: true });
        }
        if (!isAuthorized(req)) {
          return sendJson(res, 401, { ok: false, error: "Dashboard token required." });
        }

        if (req.method === "GET" && pathname === "/api/health") {
          return sendJson(res, 200, {
            ok: true,
            version: "1.0.0",
            cwd: system.cwd,
            dbDriver: system.db.driverName,
            dbUpdatedAt: system.db.read().updatedAt,
            schedulerEnabled,
            time: new Date().toISOString()
          });
        }

        if (req.method === "GET" && pathname === "/api/agents") {
          return sendJson(res, 200, [...system.agents.values()]);
        }

        if (req.method === "GET" && pathname === "/api/models/status") {
          return sendJson(res, 200, getModelRouterStatus());
        }

        if (req.method === "GET" && pathname === "/api/tools") {
          const agentId = url.searchParams.get("agent") || "operator";
          const agent = system.agents.get(agentId) ?? [...system.agents.values()][0];
          return sendJson(res, 200, system.tools.descriptorsFor(agent));
        }

        if (req.method === "GET" && pathname === "/api/tasks") {
          return sendJson(res, 200, system.tasks.list());
        }

        if (req.method === "GET" && pathname === "/api/missions") {
          return sendJson(res, 200, system.missions.list());
        }

        if (req.method === "GET" && pathname === "/api/memory") {
          return sendJson(res, 200, system.memory.list());
        }

        if (req.method === "POST" && pathname === "/api/memory") {
          const body = await readJson(req);
          const scope = typeof body.scope === "string" && body.scope.trim() ? body.scope.trim() : "workspace";
          const content = typeof body.content === "string" ? body.content.trim() : "";
          const importance = typeof body.importance === "number" ? body.importance : 1;
          if (!content) return sendJson(res, 400, { ok: false, error: "Memory content is required." });
          return sendJson(res, 200, system.memory.add(scope, content, importance));
        }

        if (req.method === "GET" && pathname === "/api/schedules") {
          return sendJson(res, 200, system.schedules.list());
        }

        if (req.method === "POST" && pathname === "/api/schedules") {
          const body = await readJson(req);
          const title = typeof body.title === "string" ? body.title.trim() : "Scheduled mission";
          const message = typeof body.message === "string" ? body.message.trim() : "";
          const agentId = typeof body.agentId === "string" ? body.agentId : "operator";
          const intervalMinutes = typeof body.intervalMinutes === "number" ? body.intervalMinutes : Number(body.intervalMinutes || 60);
          const startAt = typeof body.startAt === "string" && body.startAt.trim() ? body.startAt : undefined;
          if (!message) return sendJson(res, 400, { ok: false, error: "Scheduled mission message is required." });
          if (!system.agents.has(agentId)) return sendJson(res, 400, { ok: false, error: `Unknown agent: ${agentId}` });
          return sendJson(res, 200, system.schedules.create({ title, message, agentId, intervalMinutes, startAt }));
        }

        const scheduleDeleteMatch = pathname.match(/^\/api\/schedules\/([^/]+)$/);
        if (req.method === "DELETE" && scheduleDeleteMatch) {
          const deleted = system.schedules.delete(scheduleDeleteMatch[1]);
          return sendJson(res, deleted ? 200 : 404, { ok: deleted });
        }

        const scheduleRunMatch = pathname.match(/^\/api\/schedules\/([^/]+)\/run-now$/);
        if (req.method === "POST" && scheduleRunMatch) {
          const id = scheduleRunMatch[1];
          const current = system.schedules.get(id);
          if (!current) return sendJson(res, 404, { ok: false, error: "Schedule not found." });
          system.schedules.update(id, { nextRunAt: new Date(0).toISOString(), enabled: true, status: "idle" });
          const executed = await system.schedules.runDueOnce();
          return sendJson(res, 200, { ok: true, executed });
        }

        if (req.method === "GET" && pathname === "/api/playbooks") {
          return sendJson(res, 200, system.playbooks.list());
        }

        if (req.method === "GET" && pathname === "/api/workflows/runs") {
          return sendJson(res, 200, system.workflows.listRuns());
        }

        if (req.method === "POST" && pathname === "/api/workflows/run") {
          const body = await readJson(req);
          const playbookId = typeof body.playbookId === "string" ? body.playbookId : "";
          const playbook = system.playbooks.get(playbookId);
          if (!playbook) return sendJson(res, 404, { ok: false, error: `Unknown playbook: ${playbookId}` });
          const inputs = typeof body.inputs === "object" && body.inputs ? body.inputs as Record<string, string> : {};
          const approveAll = body.approveAll === true;
          const dryRun = body.dryRun === true;
          const run = await system.workflows.run({ playbook, inputs, approveAll, dryRun, workspaceId: "local" });
          return sendJson(res, 200, { ok: true, run });
        }


        if (req.method === "GET" && pathname === "/api/knowledge") {
          return sendJson(res, 200, system.knowledge.listDocuments());
        }

        if (req.method === "POST" && pathname === "/api/knowledge/reindex") {
          const body = await readJson(req);
          const documentId = typeof body.documentId === "string" && body.documentId.trim()
            ? body.documentId.trim()
            : undefined;
          const force = body.force === true;
          const limit = typeof body.limit === "number" ? body.limit : Number(body.limit);
          const output = await system.knowledge.reindexEmbeddings({
            documentId,
            force,
            limit: Number.isFinite(limit) ? limit : undefined
          });
          await system.ledger.record({
            type: "knowledge.reindexed",
            workspaceId: "local",
            sessionId: "dashboard",
            payload: {
              documentId: output.requestedDocumentId,
              provider: output.provider,
              model: output.model,
              processedChunks: output.processedChunks,
              updatedChunks: output.updatedChunks,
              skippedChunks: output.skippedChunks,
              failedChunks: output.failedChunks,
              failureReason: output.failureReason
            }
          });
          return sendJson(res, 200, { ok: true, output });
        }

        if (req.method === "POST" && pathname === "/api/knowledge/search") {
          const body = await readJson(req);
          const query = typeof body.query === "string" ? body.query.trim() : "";
          const limit = typeof body.limit === "number" ? body.limit : Number(body.limit || 10);
          const tags = Array.isArray(body.tags) ? body.tags.map(String) : [];
          const modeRaw = body.mode === "keyword" || body.mode === "vector" || body.mode === "hybrid"
            ? body.mode
            : typeof body.mode === "string"
              ? body.mode.trim().toLowerCase()
              : undefined;
          const mode = modeRaw === "keyword" || modeRaw === "vector" || modeRaw === "hybrid" ? modeRaw : undefined;
          const hybridWeight = typeof body.hybridWeight === "number"
            ? body.hybridWeight
            : Number(body.hybridWeight);
          if (!query) return sendJson(res, 400, { ok: false, error: "query is required." });
          const search = await system.knowledge.search(query, {
            limit,
            tags,
            mode,
            hybridWeight: Number.isFinite(hybridWeight) ? hybridWeight : undefined
          });
          return sendJson(res, 200, { ok: true, ...search });
        }

        if (req.method === "POST" && pathname === "/api/knowledge/text") {
          const body = await readJson(req);
          const title = typeof body.title === "string" ? body.title.trim() : "";
          const text = typeof body.text === "string" ? body.text : "";
          const tags = Array.isArray(body.tags) ? body.tags.map(String) : typeof body.tags === "string" ? body.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : [];
          if (!title || !text.trim()) return sendJson(res, 400, { ok: false, error: "title and text are required." });
          const output = await system.knowledge.ingestText({ title, text, tags });
          await system.ledger.record({
            type: "knowledge.text_ingested",
            workspaceId: "local",
            sessionId: "dashboard",
            payload: { documentId: output.document.id, title: output.document.title, chunks: output.chunks.length }
          });
          return sendJson(res, 200, { ok: true, output });
        }

        if (req.method === "POST" && pathname === "/api/knowledge/file") {
          const body = await readJson(req);
          const path = typeof body.path === "string" ? body.path.trim() : "";
          const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : path;
          const tags = Array.isArray(body.tags) ? body.tags.map(String) : typeof body.tags === "string" ? body.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : [];
          if (!path) return sendJson(res, 400, { ok: false, error: "path is required." });
          const tool = system.tools.get("kb.ingestFile");
          const result = await tool.execute({ id: makeId("api"), toolName: "kb.ingestFile", input: tool.validate({ path, title, tags }), requestedBy: "dashboard", workspaceId: "local", sessionId: "dashboard", approved: true });
          await system.ledger.record({ type: "knowledge.file_ingested", workspaceId: "local", sessionId: "dashboard", payload: { path, result: result.summary } });
          return sendJson(res, result.ok ? 200 : 400, { ok: result.ok, result });
        }

        const knowledgeMatch = pathname.match(/^\/api\/knowledge\/([^/]+)$/);
        if (knowledgeMatch && req.method === "GET") {
          const found = system.knowledge.getDocument(knowledgeMatch[1]);
          return found ? sendJson(res, 200, found) : sendJson(res, 404, { ok: false, error: "Knowledge document not found." });
        }
        if (knowledgeMatch && req.method === "DELETE") {
          const deleted = system.knowledge.deleteDocument(knowledgeMatch[1]);
          if (deleted) await system.ledger.record({ type: "knowledge.document_deleted", workspaceId: "local", sessionId: "dashboard", payload: { documentId: knowledgeMatch[1] } });
          return sendJson(res, deleted ? 200 : 404, { ok: deleted });
        }

        if (req.method === "GET" && pathname === "/api/db") {
          return sendJson(res, 200, system.db.read());
        }

        if (req.method === "GET" && pathname === "/api/events") {
          const limit = Number(url.searchParams.get("limit") || 100);
          return sendJson(res, 200, await readJsonl(join(process.cwd(), ".goatmez/events.jsonl"), limit));
        }

        if (req.method === "GET" && pathname === "/api/approvals") {
          return sendJson(res, 200, await system.approvals.list());
        }

        if (req.method === "POST" && pathname === "/api/run") {
          const body = await readJson(req);
          const message = typeof body.message === "string" && body.message.trim() ? body.message.trim() : "inspect this workspace";
          const agentId = typeof body.agentId === "string" ? body.agentId : "operator";
          const approveAll = body.approveAll === true;
          const dryRun = body.dryRun === true;
          const result = await system.runtime.run({
            workspaceId: "local",
            sessionId: makeId("web"),
            agentId,
            message,
            cwd: system.cwd,
            approveAll,
            dryRun
          });
          return sendJson(res, 200, { ok: true, result });
        }

        const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/(approve|reject|execute|approve-and-execute)$/);
        if (req.method === "POST" && approvalMatch) {
          const [, id, action] = approvalMatch;
          const body = (await readJson(req).catch(() => ({}))) as JsonBody;
          const note = typeof body.note === "string" ? body.note : undefined;

          if (action === "approve" || action === "reject") {
            const record = await system.approvals.decide(id, action === "approve" ? "approved" : "rejected", note);
            return sendJson(res, 200, record);
          }

          if (action === "approve-and-execute") {
            await system.approvals.decide(id, "approved", note || "Approved and executed from dashboard");
          }

          try {
            const payload = await executeApprovedToolCall(
              { agents: system.agents, tools: system.tools, approvals: system.approvals, ledger: system.ledger },
              id,
              note || "Executed from dashboard"
            );
            return sendJson(res, 200, payload);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const status = message.includes("not found") ? 404 : 409;
            return sendJson(res, status, { ok: false, error: message });
          }
        }

        if (req.method === "GET" && pathname === "/api/vault") {
          return sendJson(res, 200, {
            configured: system.vault.configured,
            path: system.vault.path,
            secrets: system.vault.list()
          });
        }

        if (req.method === "POST" && pathname === "/api/vault/secrets") {
          const body = await readJson(req);
          const name = typeof body.name === "string" ? body.name.trim() : "";
          const value = typeof body.value === "string" ? body.value : "";
          const scope = typeof body.scope === "string" && body.scope.trim() ? body.scope.trim() : "workspace";
          const provider = typeof body.provider === "string" && body.provider.trim() ? body.provider.trim() : undefined;
          const description = typeof body.description === "string" && body.description.trim() ? body.description.trim() : undefined;
          if (!name || !value) return sendJson(res, 400, { ok: false, error: "Secret name and value are required." });
          const secret = system.vault.set({ name, value, scope, provider, description });
          await system.ledger.record({
            type: "vault.secret_saved",
            workspaceId: "local",
            sessionId: "dashboard",
            payload: { name: secret.name, scope: secret.scope, provider: secret.provider }
          });
          return sendJson(res, 200, { ok: true, secret });
        }

        const vaultDeleteMatch = pathname.match(/^\/api\/vault\/secrets\/([^/]+)$/);
        if (req.method === "DELETE" && vaultDeleteMatch) {
          const deleted = system.vault.delete(vaultDeleteMatch[1]);
          if (deleted) {
            await system.ledger.record({
              type: "vault.secret_deleted",
              workspaceId: "local",
              sessionId: "dashboard",
              payload: { id: vaultDeleteMatch[1] }
            });
          }
          return sendJson(res, deleted ? 200 : 404, { ok: deleted });
        }

        if (req.method === "GET" && pathname === "/api/setup/connectors") {
          const connectorId = url.searchParams.get("id");
          return sendJson(res, 200, connectorId ? system.setupWizard.profile(connectorId) : system.setupWizard.list());
        }

        if (req.method === "POST" && pathname === "/api/setup/secrets") {
          const body = await readJson(req);
          const connectorId = typeof body.connectorId === "string" ? body.connectorId.trim() : "";
          const name = typeof body.name === "string" ? body.name.trim() : "";
          const value = typeof body.value === "string" ? body.value : "";
          const description = typeof body.description === "string" ? body.description : undefined;
          if (!connectorId || !name || !value) return sendJson(res, 400, { ok: false, error: "connectorId, name, and value are required." });
          const secret = system.setupWizard.saveSecret({ connectorId, name, value, description });
          await system.ledger.record({
            type: "setup.secret_saved",
            workspaceId: "local",
            sessionId: "dashboard",
            payload: { connectorId, name: secret.name, scope: secret.scope }
          });
          return sendJson(res, 200, { ok: true, secret, profile: system.setupWizard.profile(connectorId) });
        }

        if (req.method === "GET" && pathname === "/api/connectors") {
          return sendJson(res, 200, system.connectors.list());
        }

        if (req.method === "GET" && pathname === "/api/connectors/health") {
          const connectorId = url.searchParams.get("id");
          return sendJson(res, 200, connectorId ? system.connectorHub.health(connectorId) : system.connectorHub.listHealth());
        }

        if (req.method === "POST" && pathname === "/api/connectors/http/dry-run") {
          const body = await readJson(req);
          const connectorId = typeof body.connectorId === "string" ? body.connectorId : "";
          if (!connectorId) return sendJson(res, 400, { ok: false, error: "connectorId is required." });
          const output = await system.connectorHub.httpRequest({ ...body, connectorId, dryRun: true } as any, "operator");
          return sendJson(res, 200, { ok: true, output });
        }

        if (req.method === "GET" && pathname === "/api/connectors/actions") {
          const limit = Number(url.searchParams.get("limit") || 100);
          return sendJson(res, 200, system.connectorActions.list(limit));
        }
        const connectorReplayMatch = pathname.match(/^\/api\/connectors\/actions\/([^/]+)\/execute$/);
        if (req.method === "POST" && connectorReplayMatch) {
          const body = (await readJson(req).catch(() => ({}))) as JsonBody;
          const agentId = typeof body.agentId === "string" ? body.agentId : "operator";
          const output = await system.connectorReplay.executePrepared(connectorReplayMatch[1], agentId);
          await system.ledger.record({
            type: "connector.action_replayed",
            workspaceId: "local",
            sessionId: "dashboard",
            payload: { preparedActionId: connectorReplayMatch[1], agentId }
          });
          return sendJson(res, 200, output);
        }


        if (req.method === "POST" && pathname === "/api/connectors/oauth/google/refresh/dry-run") {
          const body = await readJson(req);
          const connectorId = body.connectorId === "calendar" ? "calendar" : "gmail";
          const output = await system.providerAdapters.refreshGoogleToken(connectorId, "operator", true);
          return sendJson(res, 200, { ok: true, output });
        }

        if (req.method === "POST" && pathname === "/api/connectors/ghl/search/dry-run") {
          const body = await readJson(req);
          const output = await system.providerAdapters.ghlSearchContacts({
            query: String(body.query || ""),
            limit: typeof body.limit === "number" ? body.limit : Number(body.limit || 20),
            locationId: typeof body.locationId === "string" ? body.locationId : undefined,
            dryRun: true
          }, "operator");
          return sendJson(res, 200, { ok: true, output });
        }

        if (req.method === "POST" && pathname === "/api/connectors/gmail/draft/dry-run") {
          const body = await readJson(req);
          const output = await system.providerAdapters.gmailCreateDraft({
            to: String(body.to || ""),
            subject: String(body.subject || ""),
            body: String(body.body || ""),
            cc: typeof body.cc === "string" ? body.cc : undefined,
            dryRun: true
          }, "operator");
          return sendJson(res, 200, { ok: true, output });
        }

        if (req.method === "POST" && pathname === "/api/connectors/calendar/event/dry-run") {
          const body = await readJson(req);
          const output = await system.providerAdapters.calendarCreateEvent({
            title: String(body.title || "Untitled event"),
            startTime: String(body.startTime || new Date().toISOString()),
            endTime: String(body.endTime || new Date(Date.now() + 3600000).toISOString()),
            attendees: Array.isArray(body.attendees) ? body.attendees.map(String) : [],
            location: typeof body.location === "string" ? body.location : undefined,
            description: typeof body.description === "string" ? body.description : undefined,
            calendarId: typeof body.calendarId === "string" ? body.calendarId : undefined,
            dryRun: true
          }, "operator");
          return sendJson(res, 200, { ok: true, output });
        }

        if (req.method === "GET" && pathname === "/api/mcp") {
          return sendJson(res, 200, {
            servers: system.mesh.listServers(),
            note: "Enabled servers are connected at startup and their tools are exposed through the tool registry. Vault references are redacted in this response."
          });
        }

        return sendJson(res, 404, { ok: false, error: "Unknown API route" });
      }

      return serveStatic(pathname, res);
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.listen(port, () => {
    console.log(`Goatmez Agent OS dashboard running at http://localhost:${port}`);
    if (getDashboardToken()) console.log("Dashboard token protection is enabled.");
  });

  const schedulerTimer = schedulerEnabled
    ? setInterval(() => {
        system.schedules.runDueOnce().catch((error) => console.error("Scheduler error:", error));
      }, schedulerPollMs)
    : undefined;

  const shutdown = async () => {
    if (schedulerTimer) clearInterval(schedulerTimer);
    server.close();
    await system.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
