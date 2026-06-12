import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeId } from "../core/id.js";
import { maskSecret } from "./redaction.js";

export interface VaultSecretRecord {
  id: string;
  name: string;
  scope: string;
  provider?: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface VaultSecretSummary {
  id: string;
  name: string;
  scope: string;
  provider?: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string;
  configured: boolean;
  maskedPreview: string;
}

interface VaultFileShape {
  version: 1;
  updatedAt: string;
  secrets: VaultSecretRecord[];
}

export interface SetSecretInput {
  name: string;
  value: string;
  scope?: string;
  provider?: string;
  description?: string;
}

export class CredentialVault {
  private readonly vaultPath: string;
  private cachedPlaintext = new Map<string, string>();

  constructor(path = process.env.GOATMEZ_VAULT_PATH || ".goatmez/vault.json", private readonly masterKey = process.env.GOATMEZ_VAULT_KEY || "") {
    this.vaultPath = join(process.cwd(), path);
  }

  get configured(): boolean {
    return this.masterKey.trim().length >= 16;
  }

  get path(): string {
    return this.vaultPath;
  }

  list(): VaultSecretSummary[] {
    return this.read().secrets
      .map((secret) => ({
        id: secret.id,
        name: secret.name,
        scope: secret.scope,
        provider: secret.provider,
        description: secret.description,
        createdAt: secret.createdAt,
        updatedAt: secret.updatedAt,
        lastAccessedAt: secret.lastAccessedAt,
        configured: true,
        maskedPreview: this.maskByRecord(secret)
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  has(name: string, scope = "workspace"): boolean {
    return Boolean(this.findRecord(name, scope));
  }

  set(input: SetSecretInput): VaultSecretSummary {
    this.assertConfigured();
    const cleanName = this.cleanName(input.name);
    const cleanScope = this.cleanScope(input.scope);
    const value = String(input.value || "");
    if (!value) throw new Error("Secret value is required.");

    const now = new Date().toISOString();
    const encrypted = this.encrypt(value);
    let summary: VaultSecretSummary | undefined;

    this.mutate((db) => {
      const existing = db.secrets.find((item) => this.sameSecret(item, cleanName, cleanScope));
      const record: VaultSecretRecord = {
        id: existing?.id || makeId("secret"),
        name: cleanName,
        scope: cleanScope,
        provider: input.provider?.trim() || existing?.provider,
        description: input.description?.trim() || existing?.description,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        lastAccessedAt: existing?.lastAccessedAt,
        ...encrypted
      };
      db.secrets = [record, ...db.secrets.filter((item) => item.id !== record.id)];
      this.cachedPlaintext.set(this.cacheKey(cleanName, cleanScope), value);
      summary = this.toSummary(record, value);
    });

    return summary!;
  }

  resolve(name: string, scope = "workspace"): string {
    this.assertConfigured();
    const cleanName = this.cleanName(name);
    const cleanScope = this.cleanScope(scope);
    const key = this.cacheKey(cleanName, cleanScope);
    const cached = this.cachedPlaintext.get(key);
    if (cached) return cached;

    const record = this.findRecord(cleanName, cleanScope) || (cleanScope !== "workspace" ? this.findRecord(cleanName, "workspace") : undefined);
    if (!record) throw new Error(`Secret '${cleanName}' was not found in scope '${cleanScope}'.`);

    const value = this.decrypt(record);
    this.cachedPlaintext.set(key, value);
    this.touch(record.id);
    return value;
  }

  tryResolve(name: string, scope = "workspace"): string | undefined {
    try {
      return this.resolve(name, scope);
    } catch {
      return undefined;
    }
  }

  delete(id: string): boolean {
    let deleted = false;
    this.mutate((db) => {
      const before = db.secrets.length;
      const removed = db.secrets.find((item) => item.id === id);
      db.secrets = db.secrets.filter((item) => item.id !== id);
      deleted = db.secrets.length !== before;
      if (removed) this.cachedPlaintext.delete(this.cacheKey(removed.name, removed.scope));
    });
    return deleted;
  }

  resolveTemplate(value: string, scope = "workspace"): string {
    return value.replace(/\$\{vault:([^}]+)\}|vault:([A-Za-z0-9_.:-]+)/g, (_match, bracketed, bare) => {
      const name = String(bracketed || bare || "").trim();
      return this.resolve(name, scope);
    });
  }

  resolveEnv(env: Record<string, string> | undefined, scope = "workspace"): Record<string, string> | undefined {
    if (!env) return env;
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) next[key] = this.resolveTemplate(String(value), scope);
    return next;
  }

  redactEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
    if (!env) return env;
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) next[key] = String(value).includes("vault:") ? "${vault:****}" : maskSecret(String(value));
    return next;
  }

  private sameSecret(secret: VaultSecretRecord, name: string, scope: string): boolean {
    return secret.name.toLowerCase() === name.toLowerCase() && secret.scope.toLowerCase() === scope.toLowerCase();
  }

  private findRecord(name: string, scope: string): VaultSecretRecord | undefined {
    return this.read().secrets.find((item) => this.sameSecret(item, name, scope));
  }

  private touch(id: string): void {
    this.mutate((db) => {
      const secret = db.secrets.find((item) => item.id === id);
      if (secret) {
        secret.lastAccessedAt = new Date().toISOString();
        secret.updatedAt = secret.updatedAt || secret.lastAccessedAt;
      }
    });
  }

  private toSummary(record: VaultSecretRecord, plain?: string): VaultSecretSummary {
    return {
      id: record.id,
      name: record.name,
      scope: record.scope,
      provider: record.provider,
      description: record.description,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastAccessedAt: record.lastAccessedAt,
      configured: true,
      maskedPreview: plain ? maskSecret(plain) : this.maskByRecord(record)
    };
  }

  private maskByRecord(record: VaultSecretRecord): string {
    const cached = this.cachedPlaintext.get(this.cacheKey(record.name, record.scope));
    return cached ? maskSecret(cached) : "stored-encrypted";
  }

  private encrypt(plain: string): Pick<VaultSecretRecord, "iv" | "tag" | "ciphertext"> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.keyBytes(), iv);
    const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { iv: iv.toString("base64"), tag: tag.toString("base64"), ciphertext: ciphertext.toString("base64") };
  }

  private decrypt(record: VaultSecretRecord): string {
    const decipher = createDecipheriv("aes-256-gcm", this.keyBytes(), Buffer.from(record.iv, "base64"));
    decipher.setAuthTag(Buffer.from(record.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]).toString("utf8");
  }

  private keyBytes(): Buffer {
    this.assertConfigured();
    return createHash("sha256").update(this.masterKey, "utf8").digest();
  }

  private assertConfigured(): void {
    if (!this.configured) throw new Error("Credential vault is locked. Set GOATMEZ_VAULT_KEY to at least 16 characters.");
  }

  private cleanName(name: string): string {
    const clean = String(name || "").trim();
    if (!clean) throw new Error("Secret name is required.");
    if (!/^[A-Za-z0-9_.:-]+$/.test(clean)) throw new Error("Secret name may only contain letters, numbers, dot, dash, colon, and underscore.");
    return clean;
  }

  private cleanScope(scope?: string): string {
    const clean = String(scope || "workspace").trim() || "workspace";
    if (!/^[A-Za-z0-9_.:-]+$/.test(clean)) throw new Error("Secret scope may only contain letters, numbers, dot, dash, colon, and underscore.");
    return clean;
  }

  private cacheKey(name: string, scope: string): string {
    return `${scope.toLowerCase()}::${name.toLowerCase()}`;
  }

  private read(): VaultFileShape {
    if (!existsSync(this.vaultPath)) return { version: 1, updatedAt: new Date().toISOString(), secrets: [] };
    const raw = readFileSync(this.vaultPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<VaultFileShape>;
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      secrets: Array.isArray(parsed.secrets) ? parsed.secrets : []
    };
  }

  private write(next: VaultFileShape): void {
    mkdirSync(dirname(this.vaultPath), { recursive: true });
    const clean = { version: 1 as const, updatedAt: new Date().toISOString(), secrets: next.secrets };
    const tmp = `${this.vaultPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(clean, null, 2) + "\n", "utf8");
    renameSync(tmp, this.vaultPath);
  }

  private mutate(mutator: (db: VaultFileShape) => void): void {
    const db = this.read();
    mutator(db);
    this.write(db);
  }
}
