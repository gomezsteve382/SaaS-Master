import { z } from "zod";
import { ToolDefinition } from "../core/types.js";
import { CredentialVault } from "../security/credentialVault.js";

const statusSchema = z.object({});
const listSchema = z.object({ scope: z.string().optional() });
const checkSchema = z.object({ name: z.string(), scope: z.string().optional() });

type VaultStatusInput = z.infer<typeof statusSchema>;
type VaultListInput = z.infer<typeof listSchema>;
type VaultCheckInput = z.infer<typeof checkSchema>;

export function createVaultStatusTool(vault: CredentialVault): ToolDefinition<VaultStatusInput> {
  return {
    name: "vault.status",
    description: "Shows whether the local encrypted credential vault is configured and how many secrets are stored. Does not reveal secret values.",
    riskLevel: "low",
    requiresApproval: false,
    allowedPermissionModes: ["read_only", "draft_only", "approval_required", "workspace_write", "trusted_operator"],
    inputSchema: { type: "object", additionalProperties: false },
    validate(input: unknown): VaultStatusInput {
      return statusSchema.parse(input ?? {});
    },
    async execute(call) {
      const secrets = vault.list();
      return {
        ok: true,
        toolName: "vault.status",
        callId: call.id,
        output: { configured: vault.configured, path: vault.path, secretCount: secrets.length },
        summary: vault.configured ? `Vault configured with ${secrets.length} stored secret(s).` : "Vault is locked. Set GOATMEZ_VAULT_KEY.",
        audit: { secretCount: secrets.length, configured: vault.configured }
      };
    }
  };
}

export function createVaultListTool(vault: CredentialVault): ToolDefinition<VaultListInput> {
  return {
    name: "vault.list",
    description: "Lists credential vault metadata with masked previews only. Never returns secret plaintext.",
    riskLevel: "low",
    requiresApproval: false,
    allowedPermissionModes: ["read_only", "draft_only", "approval_required", "workspace_write", "trusted_operator"],
    inputSchema: { type: "object", properties: { scope: { type: "string" } }, additionalProperties: false },
    validate(input: unknown): VaultListInput {
      return listSchema.parse(input ?? {});
    },
    async execute(call) {
      const scope = call.input.scope;
      const secrets = vault.list().filter((secret) => !scope || secret.scope === scope);
      return {
        ok: true,
        toolName: "vault.list",
        callId: call.id,
        output: secrets,
        summary: `Found ${secrets.length} vault secret metadata record(s).`,
        audit: { scope, count: secrets.length }
      };
    }
  };
}

export function createVaultCheckTool(vault: CredentialVault): ToolDefinition<VaultCheckInput> {
  return {
    name: "vault.check",
    description: "Checks whether a named secret exists in a scope. Does not reveal the secret value.",
    riskLevel: "low",
    requiresApproval: false,
    allowedPermissionModes: ["read_only", "draft_only", "approval_required", "workspace_write", "trusted_operator"],
    inputSchema: { type: "object", properties: { name: { type: "string" }, scope: { type: "string" } }, required: ["name"], additionalProperties: false },
    validate(input: unknown): VaultCheckInput {
      return checkSchema.parse(input ?? {});
    },
    async execute(call) {
      const scope = call.input.scope || "workspace";
      const exists = vault.has(call.input.name, scope) || (scope !== "workspace" && vault.has(call.input.name, "workspace"));
      return {
        ok: true,
        toolName: "vault.check",
        callId: call.id,
        output: { name: call.input.name, scope, exists },
        summary: exists ? `Secret '${call.input.name}' is configured.` : `Secret '${call.input.name}' is missing.`,
        audit: { name: call.input.name, scope, exists }
      };
    }
  };
}
