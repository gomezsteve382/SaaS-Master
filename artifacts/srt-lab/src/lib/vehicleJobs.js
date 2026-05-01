/* Vehicle Job client (Task #501).
 *
 * Thin fetch wrapper over /api/vehicle-jobs so the WorkflowTab can stay
 * focused on UI. Mirrors the patterns used by lib/diffReports.js and
 * lib/backups.js: server is the source of truth, but every list/get
 * resolves a JSON payload directly without a localStorage cache layer
 * (jobs are small and the runner is always online by definition — a
 * job that can't reach the server can't actually drive J2534 anyway).
 */

const API_BASE = "/api/vehicle-jobs";

function newJobId() {
  return "job_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

async function asJson(res) {
  if (!res.ok) {
    let body = "";
    try {
      body = await res.text();
    } catch {
      // ignore
    }
    throw new Error(`vehicle-jobs ${res.status}: ${body || res.statusText}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export async function listJobs({ vin, status } = {}) {
  const qs = new URLSearchParams();
  if (vin) qs.set("vin", vin);
  if (status) qs.set("status", status);
  const url = qs.toString() ? `${API_BASE}?${qs}` : API_BASE;
  const data = await asJson(await fetch(url, { headers: { Accept: "application/json" } }));
  return Array.isArray(data?.jobs) ? data.jobs : [];
}

export async function getJob(id) {
  if (!id) return null;
  const data = await asJson(
    await fetch(`${API_BASE}/${encodeURIComponent(id)}`, {
      headers: { Accept: "application/json" },
    }),
  );
  return data;
}

export async function createJob({ id, vin, title, vehicle, status, owner } = {}) {
  if (!vin) throw new Error("createJob: vin required");
  const finalId = id || newJobId();
  return asJson(
    await fetch(API_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: finalId, vin: vin.toUpperCase(), title, vehicle, status, owner }),
    }),
  );
}

export async function patchJob(id, patch) {
  if (!id) throw new Error("patchJob: id required");
  return asJson(
    await fetch(`${API_BASE}/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch || {}),
    }),
  );
}

export async function deleteJob(id) {
  if (!id) throw new Error("deleteJob: id required");
  return asJson(
    await fetch(`${API_BASE}/${encodeURIComponent(id)}`, { method: "DELETE" }),
  );
}

export async function appendEvent(id, { kind, module, payload } = {}) {
  if (!id) throw new Error("appendEvent: id required");
  if (!kind) throw new Error("appendEvent: kind required");
  return asJson(
    await fetch(`${API_BASE}/${encodeURIComponent(id)}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, module, payload }),
    }),
  );
}

export async function listEvents(id) {
  if (!id) return [];
  const data = await asJson(
    await fetch(`${API_BASE}/${encodeURIComponent(id)}/events`, {
      headers: { Accept: "application/json" },
    }),
  );
  return Array.isArray(data?.events) ? data.events : [];
}

export { newJobId };
