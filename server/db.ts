import { eq, desc, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, users, sessions, uploads, operations, auditLogs, backups } from "../drizzle/schema";
import type { InsertUpload, InsertOperation, InsertAuditLog, InsertBackup } from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// --- Sessions ---

export async function createSession(userId: number, title?: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(sessions).values({ userId, title: title || null });
  return { id: Number(result[0].insertId) };
}

export async function getUserSessions(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(sessions).where(eq(sessions.userId, userId)).orderBy(desc(sessions.createdAt)).limit(50);
}

export async function getSession(sessionId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  return result[0];
}

// --- Uploads ---

export async function createUpload(data: InsertUpload) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(uploads).values(data);
  return { id: Number(result[0].insertId) };
}

export async function getSessionUploads(sessionId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(uploads).where(eq(uploads.sessionId, sessionId)).orderBy(desc(uploads.createdAt));
}

export async function getUpload(uploadId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(uploads).where(eq(uploads.id, uploadId)).limit(1);
  return result[0];
}

// --- Operations ---

export async function createOperation(data: InsertOperation) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(operations).values(data);
  return { id: Number(result[0].insertId) };
}

export async function getSessionOperations(sessionId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(operations).where(eq(operations.sessionId, sessionId)).orderBy(desc(operations.createdAt));
}

// --- Audit Logs ---

export async function createAuditLog(data: InsertAuditLog) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(auditLogs).values(data);
}

export async function getUserAuditLogs(userId: number, limit = 100) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(auditLogs).where(eq(auditLogs.userId, userId)).orderBy(desc(auditLogs.createdAt)).limit(limit);
}

export async function getSessionAuditLogs(sessionId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(auditLogs).where(eq(auditLogs.sessionId, sessionId)).orderBy(desc(auditLogs.createdAt));
}

// --- Backups ---

export async function createBackup(data: {
  backupKey: string;
  userId?: number | null;
  module: string;
  vin?: string | null;
  didCount?: number;
  tx?: number | null;
  rx?: number | null;
  timestamp?: string | null;
  checksum?: string | null;
  snapshotKind?: string | null;
  preWriteKey?: string | null;
  payload?: any;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(backups).values({
    backupKey: data.backupKey,
    userId: data.userId ?? null,
    module: data.module,
    vin: data.vin ?? null,
    didCount: data.didCount ?? 0,
    tx: data.tx ?? null,
    rx: data.rx ?? null,
    timestamp: data.timestamp ?? null,
    checksum: data.checksum ?? null,
    snapshotKind: data.snapshotKind ?? null,
    preWriteKey: data.preWriteKey ?? null,
    payload: data.payload ?? null,
  }).onDuplicateKeyUpdate({
    set: {
      module: data.module,
      vin: data.vin ?? null,
      didCount: data.didCount ?? 0,
      tx: data.tx ?? null,
      rx: data.rx ?? null,
      timestamp: data.timestamp ?? null,
      checksum: data.checksum ?? null,
      snapshotKind: data.snapshotKind ?? null,
      preWriteKey: data.preWriteKey ?? null,
      payload: data.payload ?? null,
    },
  });
  return { ok: true };
}

export async function listBackups(userId?: number) {
  const db = await getDb();
  if (!db) return [];
  // Return all backups (the client-side audit system is not user-scoped in the SRT Lab)
  return db.select({
    id: backups.backupKey,
    key: backups.backupKey,
    module: backups.module,
    vin: backups.vin,
    didCount: backups.didCount,
    tx: backups.tx,
    rx: backups.rx,
    timestamp: backups.timestamp,
    checksum: backups.checksum,
    snapshotKind: backups.snapshotKind,
    preWriteKey: backups.preWriteKey,
    createdAt: backups.createdAt,
  }).from(backups).orderBy(desc(backups.createdAt)).limit(200);
}

export async function getBackupByKey(key: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(backups).where(eq(backups.backupKey, key)).limit(1);
  return result[0];
}

export async function deleteBackupByKey(key: string) {
  const db = await getDb();
  if (!db) return;
  await db.delete(backups).where(eq(backups.backupKey, key));
}

export async function deleteAllBackups() {
  const db = await getDb();
  if (!db) return;
  await db.delete(backups);
}
