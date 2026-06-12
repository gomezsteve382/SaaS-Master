import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CredentialVault } from "../security/credentialVault.js";
import { RiskLevel } from "../core/types.js";

export type ConnectorType = "api" | "mcp" | "browser" | "database" | "webhook" | "custom";

export interface ConnectorConfig {
  id: string;
  name: string;
  type: ConnectorType;
  enabled: boolean;
  requiredSecrets?: string[];
  allowedAgents?: string[];
  description?: string;
  riskLevel?: RiskLevel;
  metadata?: Record<string, unknown>;
}

export interface ConnectorStatus extends ConnectorConfig {
  ready: boolean;
  missingSecrets: string[];
  secretCount: number;
  agentAllowlistActive: boolean;
}

export interface ConnectorAccessDecision {
  allowed: boolean;
  ready: boolean;
  reason: string;
  status: ConnectorStatus;
}

export class ConnectorRegistry {
  private readonly connectors = new Map<string, ConnectorConfig>();

  constructor(private readonly vault: CredentialVault) {}

  static async fromConfig(cwd: string, vault: CredentialVault): Promise<ConnectorRegistry> {
    const registry = new ConnectorRegistry(vault);
    const path = resolve(cwd, process.env.GOATMEZ_CONNECTORS_CONFIG || "config/connectors.json");
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as ConnectorConfig[];
      for (const connector of parsed) registry.register(connector);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      const fallback = resolve(cwd, "config/connectors.example.json");
      try {
        const raw = await readFile(fallback, "utf8");
        const parsed = JSON.parse(raw) as ConnectorConfig[];
        for (const connector of parsed) registry.register({ ...connector, enabled: false });
      } catch {
        // No connector config yet.
      }
    }
    return registry;
  }

  register(config: ConnectorConfig): void {
    if (!config.id || !config.name || !config.type) throw new Error("Connector config requires id, name, and type.");
    this.connectors.set(config.id, {
      ...config,
      requiredSecrets: config.requiredSecrets ?? [],
      allowedAgents: config.allowedAgents ?? [],
      riskLevel: config.riskLevel ?? "medium",
      metadata: config.metadata ?? {}
    });
  }

  list(): ConnectorStatus[] {
    return [...this.connectors.values()].map((connector) => this.status(connector.id));
  }

  enabled(): ConnectorStatus[] {
    return this.list().filter((connector) => connector.enabled);
  }

  get(id: string): ConnectorConfig | undefined {
    return this.connectors.get(id);
  }

  require(id: string): ConnectorConfig {
    const connector = this.get(id);
    if (!connector) throw new Error(`Unknown connector: ${id}`);
    return connector;
  }

  status(id: string): ConnectorStatus {
    const connector = this.connectors.get(id);
    if (!connector) throw new Error(`Unknown connector: ${id}`);
    const requiredSecrets = connector.requiredSecrets ?? [];
    const missingSecrets = requiredSecrets.filter((secret) => !this.vault.has(secret, connector.id) && !this.vault.has(secret, "workspace"));
    const allowedAgents = connector.allowedAgents ?? [];
    return {
      ...connector,
      requiredSecrets,
      allowedAgents,
      riskLevel: connector.riskLevel ?? "medium",
      metadata: connector.metadata ?? {},
      ready: connector.enabled && missingSecrets.length === 0,
      missingSecrets,
      secretCount: requiredSecrets.length - missingSecrets.length,
      agentAllowlistActive: allowedAgents.length > 0
    };
  }

  decideAccess(connectorId: string, agentId: string): ConnectorAccessDecision {
    const status = this.status(connectorId);
    if (!status.enabled) return { allowed: false, ready: false, reason: `Connector '${connectorId}' is disabled.`, status };
    if (!status.ready) return { allowed: false, ready: false, reason: `Connector '${connectorId}' is missing required setup: ${status.missingSecrets.join(", ") || "unknown"}.`, status };
    const allowedAgents = status.allowedAgents ?? [];
    if (allowedAgents.length > 0 && !allowedAgents.includes(agentId)) {
      return { allowed: false, ready: status.ready, reason: `Agent '${agentId}' is not allowed to use connector '${connectorId}'.`, status };
    }
    return { allowed: true, ready: true, reason: `Connector '${connectorId}' is ready for agent '${agentId}'.`, status };
  }

  metadataString(id: string, key: string, fallback = ""): string {
    const value = this.require(id).metadata?.[key];
    return typeof value === "string" ? value : fallback;
  }

  metadataObject(id: string, key: string): Record<string, unknown> {
    const value = this.require(id).metadata?.[key];
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }
}
