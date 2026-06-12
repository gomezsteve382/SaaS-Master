import { CredentialVault } from "../security/credentialVault.js";
import { maskSecret, redactObject } from "../security/redaction.js";

export interface OAuthRefreshInput {
  connectorId: string;
  tokenUrl?: string;
  clientIdSecret?: string;
  clientSecretSecret?: string;
  refreshTokenSecret?: string;
  accessTokenSecret?: string;
  scope?: string;
  dryRun?: boolean;
}

export interface OAuthRefreshResult {
  connectorId: string;
  dryRun: boolean;
  tokenUrl: string;
  accessTokenSecret: string;
  prepared: Record<string, unknown>;
  saved?: boolean;
  tokenPreview?: string;
  expiresIn?: number;
  tokenType?: string;
  raw?: unknown;
}

function formEncode(data: Record<string, string>): string {
  return new URLSearchParams(data).toString();
}

function extractJson(text: string): unknown {
  if (!text.trim()) return undefined;
  try { return JSON.parse(text); } catch { return text.slice(0, 4000); }
}

export class OAuthTokenManager {
  constructor(public readonly vault: CredentialVault) {}

  async refresh(input: OAuthRefreshInput): Promise<OAuthRefreshResult> {
    const connectorId = input.connectorId;
    const tokenUrl = input.tokenUrl || "https://oauth2.googleapis.com/token";
    const clientIdSecret = input.clientIdSecret || "GOOGLE_CLIENT_ID";
    const clientSecretSecret = input.clientSecretSecret || "GOOGLE_CLIENT_SECRET";
    const refreshTokenSecret = input.refreshTokenSecret || "GOOGLE_REFRESH_TOKEN";
    const accessTokenSecret = input.accessTokenSecret || "GOOGLE_ACCESS_TOKEN";

    const clientId = this.vault.resolve(clientIdSecret, connectorId);
    const clientSecret = this.vault.resolve(clientSecretSecret, connectorId);
    const refreshToken = this.vault.resolve(refreshTokenSecret, connectorId);
    const body: Record<string, string> = {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    };
    if (input.scope) body.scope = input.scope;

    const prepared = {
      method: "POST",
      url: tokenUrl,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: redactObject(body)
    };

    if (input.dryRun !== false) {
      return { connectorId, dryRun: true, tokenUrl, accessTokenSecret, prepared };
    }

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formEncode(body)
    });
    const raw = extractJson(await response.text()) as any;
    if (!response.ok) {
      throw new Error(`OAuth refresh failed for ${connectorId}: HTTP ${response.status} ${JSON.stringify(raw)}`);
    }
    const accessToken = raw?.access_token;
    if (typeof accessToken !== "string" || !accessToken) throw new Error(`OAuth refresh for ${connectorId} did not return an access_token.`);
    this.vault.set({ name: accessTokenSecret, scope: connectorId, provider: connectorId, value: accessToken, description: "OAuth access token refreshed by Goatmez Agent OS" });
    return {
      connectorId,
      dryRun: false,
      tokenUrl,
      accessTokenSecret,
      prepared,
      saved: true,
      tokenPreview: maskSecret(accessToken),
      expiresIn: typeof raw?.expires_in === "number" ? raw.expires_in : undefined,
      tokenType: typeof raw?.token_type === "string" ? raw.token_type : undefined,
      raw: redactObject(raw)
    };
  }

  async accessToken(connectorId: string, refreshOptions: Omit<OAuthRefreshInput, "connectorId" | "dryRun"> = {}): Promise<string> {
    const accessTokenSecret = refreshOptions.accessTokenSecret || "GOOGLE_ACCESS_TOKEN";
    const existing = this.vault.tryResolve(accessTokenSecret, connectorId);
    if (existing) return existing;
    await this.refresh({ ...refreshOptions, connectorId, accessTokenSecret, dryRun: false });
    return this.vault.resolve(accessTokenSecret, connectorId);
  }
}
