import { ConnectorRegistry, ConnectorStatus } from "./connectorRegistry.js";
import { CredentialVault } from "../security/credentialVault.js";
import { maskSecret, redactObject } from "../security/redaction.js";
import { ConnectorActionStore } from "./connectorActionStore.js";

export interface ConnectorHealthResult {
  connectorId: string;
  ready: boolean;
  enabled: boolean;
  type: string;
  riskLevel: string;
  missingSecrets: string[];
  allowedAgents: string[];
  metadata: Record<string, unknown>;
  checks: string[];
}

export interface HttpExecutionInput {
  connectorId: string;
  method?: string;
  path?: string;
  url?: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  dryRun?: boolean;
  timeoutMs?: number;
  replayOf?: string;
}

export interface ConnectorExecutionHubOptions {
  registry: ConnectorRegistry;
  vault: CredentialVault;
  actions?: ConnectorActionStore;
}

function sanitizePath(path: string): string {
  const clean = String(path || "/").trim() || "/";
  if (/^https?:\/\//i.test(clean)) throw new Error("Use url for absolute URLs, not path.");
  if (clean.includes("..")) throw new Error("Connector path cannot contain '..'.");
  return clean.startsWith("/") ? clean : `/${clean}`;
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, string | number | boolean>): string {
  const url = new URL(sanitizePath(path), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
  return url.toString();
}

function extractJsonSafely(text: string): unknown {
  if (!text.trim()) return undefined;
  try { return JSON.parse(text); } catch { return text.slice(0, 4000); }
}

export class ConnectorExecutionHub {
  constructor(private readonly options: ConnectorExecutionHubOptions) {}

  listHealth(): ConnectorHealthResult[] {
    return this.options.registry.list().map((connector) => this.health(connector.id));
  }

  health(connectorId: string): ConnectorHealthResult {
    const status = this.options.registry.status(connectorId);
    const checks = [
      status.enabled ? "enabled" : "disabled",
      status.ready ? "required setup present" : `missing setup: ${status.missingSecrets.join(", ") || "none"}`,
      status.allowedAgents?.length ? `allowed agents: ${status.allowedAgents.join(", ")}` : "available to any configured agent",
      `type: ${status.type}`,
      `risk: ${status.riskLevel}`
    ];
    return {
      connectorId: status.id,
      ready: status.ready,
      enabled: status.enabled,
      type: status.type,
      riskLevel: status.riskLevel || "medium",
      missingSecrets: status.missingSecrets,
      allowedAgents: status.allowedAgents ?? [],
      metadata: status.metadata ?? {},
      checks
    };
  }

  ensureAllowed(connectorId: string, agentId: string): ConnectorStatus {
    const decision = this.options.registry.decideAccess(connectorId, agentId);
    if (!decision.allowed) throw new Error(decision.reason);
    return decision.status;
  }

  async httpRequest(input: HttpExecutionInput, agentId: string, replayOf?: string): Promise<unknown> {
    const status = this.ensureAllowed(input.connectorId, agentId);
    const method = String(input.method || "GET").toUpperCase();
    const metadata = status.metadata ?? {};
    const baseUrl = typeof metadata.baseUrl === "string" ? metadata.baseUrl : "";
    const url = input.url ? String(input.url) : buildUrl(baseUrl, input.path || "/", input.query);
    if (!/^https?:\/\//i.test(url)) throw new Error(`Connector '${input.connectorId}' needs metadata.baseUrl or an absolute url.`);

    const headers: Record<string, string> = { ...(input.headers ?? {}) };
    const authHeader = typeof metadata.authHeader === "string" ? metadata.authHeader : "Authorization";
    const authScheme = typeof metadata.authScheme === "string" ? metadata.authScheme : "Bearer";
    const secretName = typeof metadata.primarySecret === "string" ? metadata.primarySecret : status.requiredSecrets?.[0];
    if (secretName && !headers[authHeader]) {
      const secret = this.options.vault.resolve(secretName, input.connectorId);
      headers[authHeader] = authScheme ? `${authScheme} ${secret}` : secret;
    }
    const defaultHeaders = metadata.defaultHeaders && typeof metadata.defaultHeaders === "object" && !Array.isArray(metadata.defaultHeaders)
      ? metadata.defaultHeaders as Record<string, string>
      : {};
    Object.assign(headers, defaultHeaders, headers);

    const prepared = {
      connectorId: input.connectorId,
      method,
      url,
      headers: redactObject(headers),
      body: input.body ?? undefined,
      path: input.path,
      query: input.query,
      executionInput: { ...input }
    };

    const action = this.options.actions?.start({
      connectorId: input.connectorId,
      action: `http.${method.toLowerCase()}`,
      agentId,
      dryRun: input.dryRun !== false,
      request: prepared,
      replayOf: input.replayOf || replayOf
    });

    if (input.dryRun !== false) {
      const result = { mode: "dry-run", prepared, note: "Set dryRun=false to execute the HTTP request." };
      if (action) this.options.actions?.complete(action.id, result);
      return { actionId: action?.id, ...result };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(input.timeoutMs || 15000)));
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: ["GET", "HEAD"].includes(method) ? undefined : JSON.stringify(input.body ?? {}),
        signal: controller.signal
      });
      const text = await response.text();
      const result = {
        connectorId: input.connectorId,
        status: response.status,
        ok: response.ok,
        headers: redactObject(Object.fromEntries(response.headers.entries())),
        body: extractJsonSafely(text)
      };
      if (action) this.options.actions?.complete(action.id, result);
      return { actionId: action?.id, ...result };
    } catch (error) {
      if (action) this.options.actions?.fail(action.id, error);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async openAiResponses(input: { prompt: string; model?: string; maxOutputTokens?: number; dryRun?: boolean }, agentId: string, replayOf?: string): Promise<unknown> {
    const status = this.ensureAllowed("openai", agentId);
    const apiKey = this.options.vault.resolve("OPENAI_API_KEY", "openai");
    const model = input.model || this.options.registry.metadataString("openai", "defaultModel", "gpt-4.1-mini");
    const body = { model, input: input.prompt, max_output_tokens: input.maxOutputTokens ?? 600 };
    const prepared = { connectorId: status.id, endpoint: "POST /v1/responses", model, apiKey: maskSecret(apiKey), body, executionInput: { ...input } };
    const action = this.options.actions?.start({ connectorId: "openai", action: "openai.responses", agentId, dryRun: input.dryRun !== false, request: prepared, replayOf });
    if (input.dryRun !== false) {
      const result = { mode: "dry-run", prepared, note: "Set dryRun=false to call the provider." };
      if (action) this.options.actions?.complete(action.id, result);
      return { actionId: action?.id, ...result };
    }
    try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    const result = { ok: response.ok, status: response.status, body: extractJsonSafely(text) };
    if (action) this.options.actions?.complete(action.id, result);
    return { actionId: action?.id, ...result };
    } catch (error) {
      if (action) this.options.actions?.fail(action.id, error);
      throw error;
    }
  }
}
