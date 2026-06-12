import { ConnectorRegistry } from "./connectorRegistry.js";
import { ConnectorActionStore } from "./connectorActionStore.js";
import { OAuthTokenManager } from "./oauthTokenManager.js";
import { redactObject } from "../security/redaction.js";

export interface ProviderAdapterOptions {
  registry: ConnectorRegistry;
  oauth: OAuthTokenManager;
  actions: ConnectorActionStore;
}

function jsonFromText(text: string): unknown {
  if (!text.trim()) return undefined;
  try { return JSON.parse(text); } catch { return text.slice(0, 4000); }
}

function base64Url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function cleanHeader(value: string): string {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function gmailRawMessage(input: { to: string; subject: string; body: string; cc?: string }): string {
  const headers = [
    `To: ${cleanHeader(input.to)}`,
    input.cc ? `Cc: ${cleanHeader(input.cc)}` : undefined,
    `Subject: ${cleanHeader(input.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    input.body
  ].filter(Boolean).join("\r\n");
  return base64Url(headers);
}

function metadataString(registry: ConnectorRegistry, connectorId: string, key: string, fallback = ""): string {
  const value = registry.require(connectorId).metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export class ProviderAdapters {
  constructor(private readonly options: ProviderAdapterOptions) {}

  async refreshGoogleToken(connectorId: "gmail" | "calendar", agentId: string, dryRun = true): Promise<unknown> {
    const status = this.options.registry.decideAccess(connectorId, agentId);
    if (!status.allowed) throw new Error(status.reason);
    const action = this.options.actions.start({
      connectorId,
      action: "oauth.refresh_google_token",
      agentId,
      dryRun,
      request: { connectorId, dryRun, executionInput: { connectorId } }
    });
    try {
      const result = await this.options.oauth.refresh({ connectorId, dryRun, accessTokenSecret: "GOOGLE_ACCESS_TOKEN" });
      this.options.actions.complete(action.id, result);
      return { actionId: action.id, ...result };
    } catch (error) {
      this.options.actions.fail(action.id, error);
      throw error;
    }
  }

  async gmailCreateDraft(input: { to: string; subject: string; body: string; cc?: string; dryRun?: boolean }, agentId: string, replayOf?: string): Promise<unknown> {
    const connectorId = "gmail";
    const status = this.options.registry.decideAccess(connectorId, agentId);
    if (!status.allowed) throw new Error(status.reason);
    const raw = gmailRawMessage(input);
    const url = "https://gmail.googleapis.com/gmail/v1/users/me/drafts";
    const request = { method: "POST", url, body: { message: { raw } }, dryRun: input.dryRun !== false, executionInput: { ...input } };
    const action = this.options.actions.start({ connectorId, action: "gmail.create_draft", agentId, dryRun: input.dryRun !== false, request, replayOf });
    try {
      if (input.dryRun !== false) {
        const prepared = { mode: "dry-run", request: redactObject({ ...request, body: { message: { raw: `${raw.slice(0, 32)}...` } } }), note: "Set dryRun=false after approval to create the draft." };
        this.options.actions.complete(action.id, prepared);
        return { actionId: action.id, ...prepared };
      }
      const token = await this.options.oauth.accessToken(connectorId, { accessTokenSecret: "GOOGLE_ACCESS_TOKEN" });
      const response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ message: { raw } })
      });
      const payload = { ok: response.ok, status: response.status, body: jsonFromText(await response.text()) };
      this.options.actions.complete(action.id, payload);
      return { actionId: action.id, ...payload };
    } catch (error) {
      this.options.actions.fail(action.id, error);
      throw error;
    }
  }

  async calendarCreateEvent(input: { title: string; startTime: string; endTime: string; attendees?: string[]; location?: string; description?: string; calendarId?: string; dryRun?: boolean }, agentId: string, replayOf?: string): Promise<unknown> {
    const connectorId = "calendar";
    const status = this.options.registry.decideAccess(connectorId, agentId);
    if (!status.allowed) throw new Error(status.reason);
    const calendarId = encodeURIComponent(input.calendarId || "primary");
    const url = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`;
    const body = {
      summary: input.title,
      start: { dateTime: input.startTime },
      end: { dateTime: input.endTime },
      attendees: (input.attendees || []).map((email) => ({ email })),
      location: input.location,
      description: input.description
    };
    const request = { method: "POST", url, body, dryRun: input.dryRun !== false, executionInput: { ...input } };
    const action = this.options.actions.start({ connectorId, action: "calendar.create_event", agentId, dryRun: input.dryRun !== false, request, replayOf });
    try {
      if (input.dryRun !== false) {
        const prepared = { mode: "dry-run", request, note: "Set dryRun=false after approval to create the calendar event." };
        this.options.actions.complete(action.id, prepared);
        return { actionId: action.id, ...prepared };
      }
      const token = await this.options.oauth.accessToken(connectorId, { accessTokenSecret: "GOOGLE_ACCESS_TOKEN" });
      const response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = { ok: response.ok, status: response.status, body: jsonFromText(await response.text()) };
      this.options.actions.complete(action.id, payload);
      return { actionId: action.id, ...payload };
    } catch (error) {
      this.options.actions.fail(action.id, error);
      throw error;
    }
  }

  async ghlSearchContacts(input: { query: string; limit?: number; locationId?: string; dryRun?: boolean }, agentId: string, replayOf?: string): Promise<unknown> {
    const connectorId = "ghl";
    const status = this.options.registry.decideAccess(connectorId, agentId);
    if (!status.allowed) throw new Error(status.reason);
    const baseUrl = metadataString(this.options.registry, connectorId, "baseUrl", "https://services.leadconnectorhq.com").replace(/\/+$/, "");
    const version = metadataString(this.options.registry, connectorId, "version", "2021-07-28");
    const locationId = input.locationId || this.options.oauth.vault.tryResolve("GHL_LOCATION_ID", connectorId) || metadataString(this.options.registry, connectorId, "locationId", "");
    const url = `${baseUrl}/contacts/search`;
    const body: Record<string, unknown> = { query: input.query, pageLimit: input.limit ?? 20 };
    if (locationId) body.locationId = locationId;
    const request = { method: "POST", url, headers: { Version: version, "Content-Type": "application/json" }, body, dryRun: input.dryRun !== false, executionInput: { ...input } };
    const action = this.options.actions.start({ connectorId, action: "ghl.search_contacts", agentId, dryRun: input.dryRun !== false, request, replayOf });
    try {
      if (input.dryRun !== false) {
        const prepared = { mode: "dry-run", request, note: "Set dryRun=false after approval to search GHL contacts." };
        this.options.actions.complete(action.id, prepared);
        return { actionId: action.id, ...prepared };
      }
      const token = this.options.oauth.vault.resolve("GHL_API_KEY", connectorId);
      const response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, Version: version, "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = { ok: response.ok, status: response.status, body: jsonFromText(await response.text()) };
      this.options.actions.complete(action.id, payload);
      return { actionId: action.id, ...payload };
    } catch (error) {
      this.options.actions.fail(action.id, error);
      throw error;
    }
  }

  async stripeRetrieveAccount(input: { dryRun?: boolean }, agentId: string, apiKey: string, replayOf?: string): Promise<unknown> {
    const connectorId = "stripe";
    const status = this.options.registry.decideAccess(connectorId, agentId);
    if (!status.allowed) throw new Error(status.reason);
    const request = { method: "GET", url: "https://api.stripe.com/v1/account", dryRun: input.dryRun !== false, executionInput: { ...input } };
    const action = this.options.actions.start({ connectorId, action: "stripe.retrieve_account", agentId, dryRun: input.dryRun !== false, request, replayOf });
    try {
      if (input.dryRun !== false) {
        const prepared = { mode: "dry-run", request, note: "Set dryRun=false to call Stripe account introspection. This does not charge or modify customers." };
        this.options.actions.complete(action.id, prepared);
        return { actionId: action.id, ...prepared };
      }
      const response = await fetch(request.url, { headers: { authorization: `Bearer ${apiKey}` } });
      const payload = { ok: response.ok, status: response.status, body: jsonFromText(await response.text()) };
      this.options.actions.complete(action.id, payload);
      return { actionId: action.id, ...payload };
    } catch (error) {
      this.options.actions.fail(action.id, error);
      throw error;
    }
  }
}
