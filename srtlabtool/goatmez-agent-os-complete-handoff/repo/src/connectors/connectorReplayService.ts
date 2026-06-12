import { ConnectorActionStore } from "./connectorActionStore.js";
import { ConnectorExecutionHub } from "./connectorExecutor.js";
import { ProviderAdapters } from "./providerAdapters.js";
import { CredentialVault } from "../security/credentialVault.js";

export interface ConnectorReplayServiceOptions {
  actions: ConnectorActionStore;
  hub: ConnectorExecutionHub;
  adapters: ProviderAdapters;
  vault: CredentialVault;
}

function requestInput(actionRequest: unknown): Record<string, unknown> {
  const request = actionRequest && typeof actionRequest === "object" ? actionRequest as Record<string, unknown> : {};
  const executionInput = request.executionInput;
  if (executionInput && typeof executionInput === "object" && !Array.isArray(executionInput)) return executionInput as Record<string, unknown>;
  return request;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String) : undefined;
}

export class ConnectorReplayService {
  constructor(private readonly options: ConnectorReplayServiceOptions) {}

  async executePrepared(actionId: string, operatorAgentId = "operator"): Promise<unknown> {
    const prepared = this.options.actions.get(actionId);
    if (!prepared) throw new Error(`Connector action not found: ${actionId}`);
    if (prepared.status !== "prepared") throw new Error(`Connector action '${actionId}' is not executable. Current status: ${prepared.status}.`);
    if (prepared.dryRun !== true) throw new Error(`Connector action '${actionId}' is not a dry-run prepared action.`);

    const agentId = prepared.agentId || operatorAgentId;
    const input = requestInput(prepared.request);
    let result: unknown;

    if (prepared.action === "gmail.create_draft") {
      result = await this.options.adapters.gmailCreateDraft({
        to: String(input.to || ""),
        subject: String(input.subject || ""),
        body: String(input.body || ""),
        cc: typeof input.cc === "string" ? input.cc : undefined,
        dryRun: false
      }, agentId, prepared.id);
    } else if (prepared.action === "calendar.create_event") {
      result = await this.options.adapters.calendarCreateEvent({
        title: String(input.title || "Untitled event"),
        startTime: String(input.startTime || new Date().toISOString()),
        endTime: String(input.endTime || new Date(Date.now() + 3600000).toISOString()),
        attendees: stringArray(input.attendees) || [],
        location: typeof input.location === "string" ? input.location : undefined,
        description: typeof input.description === "string" ? input.description : undefined,
        calendarId: typeof input.calendarId === "string" ? input.calendarId : undefined,
        dryRun: false
      }, agentId, prepared.id);
    } else if (prepared.action === "ghl.search_contacts") {
      result = await this.options.adapters.ghlSearchContacts({
        query: String(input.query || ""),
        limit: typeof input.limit === "number" ? input.limit : Number(input.limit || 20),
        locationId: typeof input.locationId === "string" ? input.locationId : undefined,
        dryRun: false
      }, agentId, prepared.id);
    } else if (prepared.action === "openai.responses") {
      result = await this.options.hub.openAiResponses({
        prompt: String(input.prompt || ""),
        model: typeof input.model === "string" ? input.model : undefined,
        maxOutputTokens: typeof input.maxOutputTokens === "number" ? input.maxOutputTokens : Number(input.maxOutputTokens || 600),
        dryRun: false
      }, agentId, prepared.id);
    } else if (prepared.action === "stripe.retrieve_account") {
      const apiKey = this.options.vault.resolve("STRIPE_SECRET_KEY", "stripe");
      result = await this.options.adapters.stripeRetrieveAccount({ dryRun: false }, agentId, apiKey, prepared.id);
    } else if (prepared.action.startsWith("http.")) {
      const request = prepared.request as Record<string, unknown>;
      result = await this.options.hub.httpRequest({
        connectorId: String(request.connectorId || prepared.connectorId),
        method: String(request.method || "GET"),
        url: typeof request.url === "string" ? request.url : undefined,
        path: typeof request.path === "string" ? request.path : undefined,
        headers: request.headers && typeof request.headers === "object" ? request.headers as Record<string, string> : undefined,
        query: request.query && typeof request.query === "object" ? request.query as any : undefined,
        body: request.body,
        dryRun: false
      }, agentId, prepared.id);
    } else {
      throw new Error(`Connector replay is not implemented for action '${prepared.action}'.`);
    }

    const executedActionId = typeof result === "object" && result && "actionId" in result ? String((result as any).actionId) : "unknown";
    const executedAction = executedActionId !== "unknown" ? this.options.actions.get(executedActionId) : undefined;
    if (!executedAction) throw new Error(`Connector replay executed but could not find child action: ${executedActionId}`);
    return {
      ok: true,
      prepared: this.options.actions.markReplayed(prepared.id, executedAction, result),
      executed: executedAction,
      result
    };
  }
}
