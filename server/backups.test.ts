import { describe, it, expect, beforeAll, afterAll } from "vitest";

const BASE = "http://localhost:3000/api/backups";

describe("/api/backups REST API", () => {
  const testKey = "srtlab_backup_RFHUB_TEST_" + Date.now();

  it("POST /api/backups — creates a backup", async () => {
    const res = await fetch(BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: testKey,
        module: "RFHUB",
        vin: "1C4RJFBG0LC999999",
        didCount: 6,
        tx: 0x700,
        rx: 0x708,
        timestamp: "2026-06-04T00:00:00.000Z",
        payload: { module: "RFHUB", dids: { "61840": { name: "VIN", hex: "31433452" } } },
        checksum: "deadbeef",
        snapshotKind: "pre-write",
        preWriteKey: null,
      }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.id).toBe(testKey);
  });

  it("GET /api/backups — lists backups", async () => {
    const res = await fetch(BASE);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.backups)).toBe(true);
    const found = json.backups.find((b: any) => b.id === testKey);
    expect(found).toBeDefined();
    expect(found.module).toBe("RFHUB");
    expect(found.vin).toBe("1C4RJFBG0LC999999");
    expect(found.didCount).toBe(6);
  });

  it("GET /api/backups/:id — retrieves a single backup payload", async () => {
    const res = await fetch(`${BASE}/${encodeURIComponent(testKey)}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBe(testKey);
    expect(json.payload).toBeDefined();
    expect(json.payload.module).toBe("RFHUB");
  });

  it("GET /api/backups/:id — returns 404 for missing key", async () => {
    const res = await fetch(`${BASE}/nonexistent_key_xyz`);
    expect(res.status).toBe(404);
  });

  it("DELETE /api/backups/:id — deletes a single backup", async () => {
    const res = await fetch(`${BASE}/${encodeURIComponent(testKey)}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    // Confirm it's gone
    const check = await fetch(`${BASE}/${encodeURIComponent(testKey)}`);
    expect(check.status).toBe(404);
  });

  it("POST /api/backups — returns 400 for missing fields", async () => {
    const res = await fetch(BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vin: "test" }),
    });
    expect(res.status).toBe(400);
  });

  it("DELETE /api/backups — clears all backups", async () => {
    // Create a temp backup first
    await fetch(BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "temp_clear_test", module: "BCM", vin: "TEST", payload: {} }),
    });
    const delRes = await fetch(BASE, { method: "DELETE" });
    expect(delRes.status).toBe(200);
    const listRes = await fetch(BASE);
    const json = await listRes.json();
    expect(json.backups.length).toBe(0);
  });
});
