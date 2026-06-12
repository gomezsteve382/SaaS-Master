import { z } from "zod";
import { ToolDefinition } from "../core/types.js";
import { ConnectorRegistry } from "../connectors/connectorRegistry.js";
import { ConnectorExecutionHub } from "../connectors/connectorExecutor.js";
import { ProviderAdapters } from "../connectors/providerAdapters.js";
import { CredentialVault } from "../security/credentialVault.js";

const emptySchema = z.object({});
const healthSchema = z.object({ connectorId: z.string().optional() });
const httpSchema = z.object({
  connectorId: z.string(),
  method: z.string().optional(),
  path: z.string().optional(),
  url: z.string().optional(),
  headers: z.record(z.string()).optional(),
  query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  body: z.unknown().optional(),
  dryRun: z.boolean().optional(),
  timeoutMs: z.number().optional()
});
const openAiSchema = z.object({ prompt: z.string(), model: z.string().optional(), maxOutputTokens: z.number().optional(), dryRun: z.boolean().optional() });
const ghlSearchSchema = z.object({ query: z.string(), limit: z.number().optional(), dryRun: z.boolean().optional() });
const gmailDraftSchema = z.object({ to: z.string(), subject: z.string(), body: z.string(), cc: z.string().optional(), dryRun: z.boolean().optional() });
const calendarDraftSchema = z.object({ title: z.string(), startTime: z.string(), endTime: z.string(), attendees: z.array(z.string()).optional(), location: z.string().optional(), description: z.string().optional(), dryRun: z.boolean().optional() });
const stripeWebhookSchema = z.object({ eventType: z.string(), payload: z.record(z.unknown()).optional(), dryRun: z.boolean().optional() });
const oauthRefreshSchema = z.object({ connectorId: z.enum(["gmail", "calendar"]), dryRun: z.boolean().optional() });
const gmailCreateDraftSchema = z.object({ to: z.string(), subject: z.string(), body: z.string(), cc: z.string().optional(), dryRun: z.boolean().optional() });
const calendarCreateEventSchema = z.object({ title: z.string(), startTime: z.string(), endTime: z.string(), attendees: z.array(z.string()).optional(), location: z.string().optional(), description: z.string().optional(), calendarId: z.string().optional(), dryRun: z.boolean().optional() });
const stripeAccountSchema = z.object({ dryRun: z.boolean().optional() });

type EmptyInput = z.infer<typeof emptySchema>;
type HealthInput = z.infer<typeof healthSchema>;
type HttpInput = z.infer<typeof httpSchema>;
type OpenAiInput = z.infer<typeof openAiSchema>;
type GhlSearchInput = z.infer<typeof ghlSearchSchema>;
type GmailDraftInput = z.infer<typeof gmailDraftSchema>;
type CalendarDraftInput = z.infer<typeof calendarDraftSchema>;
type StripeWebhookInput = z.infer<typeof stripeWebhookSchema>;
type OAuthRefreshInput = z.infer<typeof oauthRefreshSchema>;
type GmailCreateDraftInput = z.infer<typeof gmailCreateDraftSchema>;
type CalendarCreateEventInput = z.infer<typeof calendarCreateEventSchema>;
type StripeAccountInput = z.infer<typeof stripeAccountSchema>;

const readModes = ["read_only", "draft_only", "approval_required", "workspace_write", "trusted_operator"] as const;
const actionModes = ["approval_required", "workspace_write", "trusted_operator"] as const;

export function createConnectorListTool(registry: ConnectorRegistry): ToolDefinition<EmptyInput> {
  return {
    name: "connector.list",
    description: "Lists configured connector profiles, readiness, required setup, and agent allowlists without exposing secrets.",
    riskLevel: "low",
    requiresApproval: false,
    allowedPermissionModes: [...readModes],
    inputSchema: { type: "object", additionalProperties: false },
    validate(input) { return emptySchema.parse(input ?? {}); },
    async execute(call) {
      const connectors = registry.list();
      return { ok: true, toolName: "connector.list", callId: call.id, output: connectors, summary: `Found ${connectors.length} connector profile(s).`, audit: { count: connectors.length } };
    }
  };
}

export function createConnectorHealthTool(hub: ConnectorExecutionHub): ToolDefinition<HealthInput> {
  return {
    name: "connector.health",
    description: "Runs local connector readiness checks for one connector or all connectors. Does not call external APIs.",
    riskLevel: "low",
    requiresApproval: false,
    allowedPermissionModes: [...readModes],
    inputSchema: { type: "object", properties: { connectorId: { type: "string" } }, additionalProperties: false },
    validate(input) { return healthSchema.parse(input ?? {}); },
    async execute(call) {
      const output = call.input.connectorId ? hub.health(call.input.connectorId) : hub.listHealth();
      return { ok: true, toolName: "connector.health", callId: call.id, output, summary: "Connector readiness check complete.", audit: { connectorId: call.input.connectorId } };
    }
  };
}

export function createConnectorHttpRequestTool(hub: ConnectorExecutionHub): ToolDefinition<HttpInput> {
  return {
    name: "connector.http.request",
    description: "Executes or dry-runs an allowlisted connector HTTP request using vault-backed authentication and redacted logs.",
    riskLevel: "high",
    requiresApproval: true,
    allowedPermissionModes: [...actionModes],
    inputSchema: { type: "object", properties: { connectorId: { type: "string" }, method: { type: "string" }, path: { type: "string" }, url: { type: "string" }, headers: { type: "object" }, query: { type: "object" }, body: {}, dryRun: { type: "boolean" }, timeoutMs: { type: "number" } }, required: ["connectorId"], additionalProperties: false },
    validate(input) { return httpSchema.parse(input ?? {}); },
    async execute(call) {
      const output = await hub.httpRequest(call.input, call.requestedBy);
      return { ok: true, toolName: "connector.http.request", callId: call.id, output, summary: `Connector HTTP ${call.input.dryRun === false ? "request executed" : "request prepared"}.`, audit: { connectorId: call.input.connectorId, method: call.input.method || "GET", dryRun: call.input.dryRun !== false } };
    }
  };
}

export function createOpenAiResponsesConnectorTool(hub: ConnectorExecutionHub): ToolDefinition<OpenAiInput> {
  return {
    name: "connector.openai.responses",
    description: "Prepares or executes an OpenAI Responses API request through the connector vault and redacts credentials in logs.",
    riskLevel: "medium",
    requiresApproval: true,
    allowedPermissionModes: [...actionModes],
    inputSchema: { type: "object", properties: { prompt: { type: "string" }, model: { type: "string" }, maxOutputTokens: { type: "number" }, dryRun: { type: "boolean" } }, required: ["prompt"], additionalProperties: false },
    validate(input) { return openAiSchema.parse(input ?? {}); },
    async execute(call) {
      const output = await hub.openAiResponses(call.input, call.requestedBy);
      return { ok: true, toolName: "connector.openai.responses", callId: call.id, output, summary: `OpenAI connector ${call.input.dryRun === false ? "executed" : "prepared"}.`, audit: { dryRun: call.input.dryRun !== false, model: call.input.model } };
    }
  };
}

export function createGhlSearchContactsTool(adapters: ProviderAdapters): ToolDefinition<GhlSearchInput> {
  return {
    name: "connector.ghl.search_contacts",
    description: "Prepares or executes a GoHighLevel contact search request using the GHL connector profile.",
    riskLevel: "medium",
    requiresApproval: true,
    allowedPermissionModes: [...actionModes],
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" }, dryRun: { type: "boolean" } }, required: ["query"], additionalProperties: false },
    validate(input) { return ghlSearchSchema.parse(input ?? {}); },
    async execute(call) {
      const output = await adapters.ghlSearchContacts(call.input, call.requestedBy);
      return { ok: true, toolName: "connector.ghl.search_contacts", callId: call.id, output, summary: `GHL contact search ${call.input.dryRun === false ? "executed" : "prepared"}.`, audit: { query: call.input.query, dryRun: call.input.dryRun !== false } };
    }
  };
}

export function createGmailDraftTool(registry: ConnectorRegistry): ToolDefinition<GmailDraftInput> {
  return {
    name: "connector.gmail.create_draft_payload",
    description: "Builds a Gmail draft payload for review. It does not send email; execution is connector-ready scaffolding only.",
    riskLevel: "medium",
    requiresApproval: true,
    allowedPermissionModes: [...actionModes],
    inputSchema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, cc: { type: "string" }, dryRun: { type: "boolean" } }, required: ["to", "subject", "body"], additionalProperties: false },
    validate(input) { return gmailDraftSchema.parse(input ?? {}); },
    async execute(call) {
      const decision = registry.decideAccess("gmail", call.requestedBy);
      if (!decision.allowed) throw new Error(decision.reason);
      return { ok: true, toolName: "connector.gmail.create_draft_payload", callId: call.id, output: { connectorId: "gmail", mode: "draft-payload", to: call.input.to, cc: call.input.cc, subject: call.input.subject, body: call.input.body, send: false }, summary: "Gmail draft payload prepared for review.", audit: { to: call.input.to, subject: call.input.subject } };
    }
  };
}

export function createCalendarDraftTool(registry: ConnectorRegistry): ToolDefinition<CalendarDraftInput> {
  return {
    name: "connector.calendar.create_event_payload",
    description: "Builds a calendar event payload for review. It does not create the event until a real calendar connector is wired.",
    riskLevel: "medium",
    requiresApproval: true,
    allowedPermissionModes: [...actionModes],
    inputSchema: { type: "object", properties: { title: { type: "string" }, startTime: { type: "string" }, endTime: { type: "string" }, attendees: { type: "array", items: { type: "string" } }, location: { type: "string" }, description: { type: "string" }, dryRun: { type: "boolean" } }, required: ["title", "startTime", "endTime"], additionalProperties: false },
    validate(input) { return calendarDraftSchema.parse(input ?? {}); },
    async execute(call) {
      const decision = registry.decideAccess("calendar", call.requestedBy);
      if (!decision.allowed) throw new Error(decision.reason);
      return { ok: true, toolName: "connector.calendar.create_event_payload", callId: call.id, output: { connectorId: "calendar", mode: "event-payload", ...call.input }, summary: "Calendar event payload prepared for review.", audit: { title: call.input.title, startTime: call.input.startTime, endTime: call.input.endTime } };
    }
  };
}

export function createStripeWebhookTool(registry: ConnectorRegistry): ToolDefinition<StripeWebhookInput> {
  return {
    name: "connector.stripe.webhook_payload",
    description: "Builds a Stripe/webhook event payload for downstream workflow testing without charging or modifying customers.",
    riskLevel: "medium",
    requiresApproval: true,
    allowedPermissionModes: [...actionModes],
    inputSchema: { type: "object", properties: { eventType: { type: "string" }, payload: { type: "object" }, dryRun: { type: "boolean" } }, required: ["eventType"], additionalProperties: false },
    validate(input) { return stripeWebhookSchema.parse(input ?? {}); },
    async execute(call) {
      const decision = registry.decideAccess("stripe", call.requestedBy);
      if (!decision.allowed) throw new Error(decision.reason);
      return { ok: true, toolName: "connector.stripe.webhook_payload", callId: call.id, output: { connectorId: "stripe", mode: "webhook-payload", eventType: call.input.eventType, payload: call.input.payload ?? {} }, summary: "Stripe/webhook payload prepared for testing.", audit: { eventType: call.input.eventType } };
    }
  };
}


export function createOAuthRefreshGoogleTokenTool(adapters: ProviderAdapters): ToolDefinition<OAuthRefreshInput> {
  return {
    name: "connector.oauth.refresh_google_token",
    description: "Prepares or executes a Google OAuth refresh-token exchange for Gmail/Calendar and stores the access token in the encrypted vault.",
    riskLevel: "high",
    requiresApproval: true,
    allowedPermissionModes: [...actionModes],
    inputSchema: { type: "object", properties: { connectorId: { enum: ["gmail", "calendar"] }, dryRun: { type: "boolean" } }, required: ["connectorId"], additionalProperties: false },
    validate(input) { return oauthRefreshSchema.parse(input ?? {}); },
    async execute(call) {
      const output = await adapters.refreshGoogleToken(call.input.connectorId, call.requestedBy, call.input.dryRun !== false);
      return { ok: true, toolName: "connector.oauth.refresh_google_token", callId: call.id, output, summary: `Google OAuth token refresh ${call.input.dryRun === false ? "executed" : "prepared"}.`, audit: { connectorId: call.input.connectorId, dryRun: call.input.dryRun !== false } };
    }
  };
}

export function createGmailCreateDraftTool(adapters: ProviderAdapters): ToolDefinition<GmailCreateDraftInput> {
  return {
    name: "connector.gmail.create_draft",
    description: "Prepares or creates a Gmail draft using OAuth access-token refresh and replay-safe connector action history.",
    riskLevel: "high",
    requiresApproval: true,
    allowedPermissionModes: [...actionModes],
    inputSchema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, cc: { type: "string" }, dryRun: { type: "boolean" } }, required: ["to", "subject", "body"], additionalProperties: false },
    validate(input) { return gmailCreateDraftSchema.parse(input ?? {}); },
    async execute(call) {
      const output = await adapters.gmailCreateDraft(call.input, call.requestedBy);
      return { ok: true, toolName: "connector.gmail.create_draft", callId: call.id, output, summary: `Gmail draft ${call.input.dryRun === false ? "created" : "prepared"}.`, audit: { to: call.input.to, subject: call.input.subject, dryRun: call.input.dryRun !== false } };
    }
  };
}

export function createCalendarCreateEventTool(adapters: ProviderAdapters): ToolDefinition<CalendarCreateEventInput> {
  return {
    name: "connector.calendar.create_event",
    description: "Prepares or creates a Google Calendar event using OAuth access-token refresh and connector action history.",
    riskLevel: "high",
    requiresApproval: true,
    allowedPermissionModes: [...actionModes],
    inputSchema: { type: "object", properties: { title: { type: "string" }, startTime: { type: "string" }, endTime: { type: "string" }, attendees: { type: "array", items: { type: "string" } }, location: { type: "string" }, description: { type: "string" }, calendarId: { type: "string" }, dryRun: { type: "boolean" } }, required: ["title", "startTime", "endTime"], additionalProperties: false },
    validate(input) { return calendarCreateEventSchema.parse(input ?? {}); },
    async execute(call) {
      const output = await adapters.calendarCreateEvent(call.input, call.requestedBy);
      return { ok: true, toolName: "connector.calendar.create_event", callId: call.id, output, summary: `Calendar event ${call.input.dryRun === false ? "created" : "prepared"}.`, audit: { title: call.input.title, startTime: call.input.startTime, dryRun: call.input.dryRun !== false } };
    }
  };
}

export function createStripeRetrieveAccountTool(adapters: ProviderAdapters, vault: CredentialVault): ToolDefinition<StripeAccountInput> {
  return {
    name: "connector.stripe.retrieve_account",
    description: "Prepares or executes a safe Stripe account introspection request. It does not charge, refund, or modify customers.",
    riskLevel: "medium",
    requiresApproval: true,
    allowedPermissionModes: [...actionModes],
    inputSchema: { type: "object", properties: { dryRun: { type: "boolean" } }, additionalProperties: false },
    validate(input) { return stripeAccountSchema.parse(input ?? {}); },
    async execute(call) {
      const apiKey = vault.resolve("STRIPE_SECRET_KEY", "stripe");
      const output = await adapters.stripeRetrieveAccount(call.input, call.requestedBy, apiKey);
      return { ok: true, toolName: "connector.stripe.retrieve_account", callId: call.id, output, summary: `Stripe account introspection ${call.input.dryRun === false ? "executed" : "prepared"}.`, audit: { dryRun: call.input.dryRun !== false } };
    }
  };
}
