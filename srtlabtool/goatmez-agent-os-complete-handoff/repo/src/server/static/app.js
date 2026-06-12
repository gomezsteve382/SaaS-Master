const qs = (selector) => document.querySelector(selector);

function token() {
  return localStorage.getItem("goatmez_dashboard_token") || "";
}

function setToken(value) {
  if (value) localStorage.setItem("goatmez_dashboard_token", value);
  else localStorage.removeItem("goatmez_dashboard_token");
}

async function api(path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  const currentToken = token();
  if (currentToken) headers["x-goatmez-token"] = currentToken;
  const response = await fetch(path, { ...options, headers });
  const payload = await response.json();
  if (response.status === 401) {
    qs("#auth-panel").classList.remove("hidden");
    throw new Error(payload.error || "Dashboard token required.");
  }
  if (!response.ok) throw new Error(payload.error || `Request failed: ${response.status}`);
  return payload;
}

function badge(text, tone = "") {
  return `<span class="badge ${tone}">${escapeHtml(text)}</span>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function pretty(value) {
  return escapeHtml(JSON.stringify(value, null, 2));
}

async function checkAuth() {
  const status = await fetch("/api/auth/status").then((res) => res.json());
  if (status.protected && !token()) qs("#auth-panel").classList.remove("hidden");
  qs("#auth-state").textContent = status.protected ? "Protected" : "Unlocked local dev mode";
}


async function loadModelStatus() {
  const status = await api("/api/models/status");
  qs("#model-status").innerHTML = `
    <article class="card">
      <div class="card-title">${escapeHtml(status.model)}</div>
      ${badge(status.provider)} ${status.localFirst ? badge("local-first", "done") : badge("fallback")} ${status.hasApiKey ? badge("key configured", "done") : badge("no key needed / missing", "pending")}
      ${status.baseUrl ? `<p class="muted">Endpoint: ${escapeHtml(status.baseUrl)}</p>` : ""}
      ${(status.notes || []).map((note) => `<p class="muted">${escapeHtml(note)}</p>`).join("")}
    </article>`;
}

async function loadHealth() {
  const health = await api("/api/health");
  qs("#health").textContent = `Online • ${health.version} • ${health.dbDriver} DB • Scheduler ${health.schedulerEnabled ? "on" : "off"}`;
}

async function loadAgents() {
  const agents = await api("/api/agents");
  const current = qs("#agent").value;
  qs("#agent").innerHTML = agents.map((agent) => `<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.name)}</option>`).join("");
  qs("#schedule-agent").innerHTML = agents.map((agent) => `<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.name)}</option>`).join("");
  if (current) qs("#agent").value = current;
}

async function loadApprovals() {
  const approvals = await api("/api/approvals");
  const pending = approvals.filter((approval) => approval.status === "pending");
  qs("#approval-count").textContent = `${pending.length} pending`;
  qs("#approvals").innerHTML = approvals.length
    ? approvals.map((approval) => `
      <article class="card">
        <div class="card-title">${escapeHtml(approval.toolName)}</div>
        ${badge(approval.status, approval.status)} ${badge(approval.agentId)}
        <p class="muted">${escapeHtml(approval.reason)}</p>
        <pre>${pretty(approval.input)}</pre>
        ${approval.execution ? `<p class="muted">Result: ${escapeHtml(approval.execution.summary)}</p>` : ""}
        ${approval.status === "pending" ? `
          <div class="actions">
            <button class="good" data-approve-execute="${escapeHtml(approval.id)}">Approve & Execute</button>
            <button data-approve="${escapeHtml(approval.id)}">Approve Only</button>
            <button class="danger" data-reject="${escapeHtml(approval.id)}">Reject</button>
          </div>` : ""}
        ${approval.status === "approved" ? `
          <div class="actions">
            <button class="good" data-execute="${escapeHtml(approval.id)}">Execute approved call</button>
          </div>` : ""}
      </article>
    `).join("")
    : `<p class="muted">No approval requests yet.</p>`;

  document.querySelectorAll("[data-approve]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/approvals/${button.dataset.approve}/approve`, { method: "POST", body: JSON.stringify({ note: "Approved from dashboard" }) });
      await refreshAll();
    });
  });
  document.querySelectorAll("[data-approve-execute]").forEach((button) => {
    button.addEventListener("click", async () => {
      const payload = await api(`/api/approvals/${button.dataset.approveExecute}/approve-and-execute`, { method: "POST", body: JSON.stringify({ note: "Approved and executed from dashboard" }) });
      qs("#result").textContent = payload.result?.summary || JSON.stringify(payload, null, 2);
      await refreshAll();
    });
  });
  document.querySelectorAll("[data-reject]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/approvals/${button.dataset.reject}/reject`, { method: "POST", body: JSON.stringify({ note: "Rejected from dashboard" }) });
      await refreshAll();
    });
  });
  document.querySelectorAll("[data-execute]").forEach((button) => {
    button.addEventListener("click", async () => {
      const payload = await api(`/api/approvals/${button.dataset.execute}/execute`, { method: "POST", body: JSON.stringify({ note: "Executed from dashboard" }) });
      qs("#result").textContent = payload.result?.summary || JSON.stringify(payload, null, 2);
      await refreshAll();
    });
  });
}

async function loadSchedules() {
  const schedules = await api("/api/schedules");
  qs("#schedule-count").textContent = `${schedules.filter((item) => item.enabled).length} active`;
  qs("#schedules").innerHTML = schedules.length
    ? schedules.map((schedule) => `
      <article class="card">
        <div class="card-title">${escapeHtml(schedule.title)}</div>
        ${badge(schedule.status, schedule.status)} ${badge(schedule.agentId)} ${badge(`every ${schedule.intervalMinutes}m`)}
        <p class="muted">Next: ${escapeHtml(schedule.nextRunAt)}</p>
        <p class="muted">${escapeHtml(schedule.message)}</p>
        ${schedule.lastResult ? `<p class="muted">Last: ${escapeHtml(schedule.lastResult.slice(0, 160))}${schedule.lastResult.length > 160 ? "..." : ""}</p>` : ""}
        ${schedule.lastError ? `<p class="muted">Error: ${escapeHtml(schedule.lastError)}</p>` : ""}
        <div class="actions">
          <button class="good" data-schedule-run="${escapeHtml(schedule.id)}">Run Now</button>
          <button class="danger" data-schedule-delete="${escapeHtml(schedule.id)}">Delete</button>
        </div>
      </article>`).join("")
    : `<p class="muted">No scheduled missions yet.</p>`;

  document.querySelectorAll("[data-schedule-run]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/schedules/${button.dataset.scheduleRun}/run-now`, { method: "POST", body: JSON.stringify({}) });
      await refreshAll();
    });
  });
  document.querySelectorAll("[data-schedule-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/schedules/${button.dataset.scheduleDelete}`, { method: "DELETE" });
      await refreshAll();
    });
  });
}

async function loadPlaybooks() {
  const playbooks = await api("/api/playbooks");
  qs("#playbook").innerHTML = playbooks.map((playbook) => `<option value="${escapeHtml(playbook.id)}">${escapeHtml(playbook.name)}</option>`).join("");
  qs("#playbooks").innerHTML = playbooks.length
    ? playbooks.map((playbook) => `
      <article class="card">
        <div class="card-title">${escapeHtml(playbook.name)}</div>
        ${badge(`${playbook.steps.length} steps`)} ${playbook.inputs?.length ? badge(`inputs: ${playbook.inputs.join(", ")}`) : badge("no inputs")}
        <p class="muted">${escapeHtml(playbook.description)}</p>
      </article>`).join("")
    : `<p class="muted">No playbooks configured.</p>`;
}

async function loadWorkflowRuns() {
  const runs = await api("/api/workflows/runs");
  qs("#workflow-runs").innerHTML = runs.length
    ? runs.map((run) => `
      <article class="card">
        <div class="card-title">${escapeHtml(run.playbookName)}</div>
        ${badge(run.status, run.status)} ${badge(`${run.steps.length} steps`)}
        <p class="muted">${escapeHtml(run.updatedAt)}</p>
        ${run.steps.map((step) => `<p class="muted">${escapeHtml(step.title)} — ${escapeHtml(step.status)}</p>`).join("")}
      </article>`).join("")
    : `<p class="muted">No workflow runs yet.</p>`;
}

async function loadMissions() {
  const missions = await api("/api/missions");
  qs("#missions").innerHTML = missions.length
    ? missions.map((mission) => `
      <article class="card">
        <div class="card-title">${escapeHtml(mission.message)}</div>
        ${badge(mission.status, mission.status)} ${badge(mission.agentId)} ${badge(mission.planner)}
        <p class="muted">${escapeHtml(mission.updatedAt)}</p>
        ${mission.result ? `<p class="muted">${escapeHtml(mission.result.slice(0, 180))}${mission.result.length > 180 ? "..." : ""}</p>` : ""}
        ${mission.error ? `<p class="muted">Error: ${escapeHtml(mission.error)}</p>` : ""}
      </article>`).join("")
    : `<p class="muted">No missions yet.</p>`;
}

async function loadTasks() {
  const tasks = await api("/api/tasks");
  qs("#tasks").innerHTML = tasks.length
    ? tasks.map((task) => `
      <article class="card">
        <div class="card-title">${escapeHtml(task.title)}</div>
        ${badge(task.status, task.status)} ${badge(task.agentId)}
        <p class="muted">${escapeHtml(task.updatedAt)}</p>
        ${task.notes?.length ? `<p class="muted">${escapeHtml(task.notes.at(-1))}</p>` : ""}
      </article>`).join("")
    : `<p class="muted">No tasks yet.</p>`;
}

async function loadMemory() {
  const memories = await api("/api/memory");
  qs("#memory").innerHTML = memories.length
    ? memories.map((memory) => `
      <article class="card">
        <div class="card-title">${escapeHtml(memory.scope)}</div>
        ${badge(`importance ${memory.importance}`)}
        <p class="muted">${escapeHtml(memory.content)}</p>
      </article>`).join("")
    : `<p class="muted">No memory records yet.</p>`;
}

async function loadKnowledge() {
  const docs = await api("/api/knowledge");
  qs("#knowledge-docs").innerHTML = docs.length
    ? docs.map((doc) => `
      <article class="card">
        <div class="card-title">${escapeHtml(doc.title)}</div>
        ${badge(`${doc.chunkCount} chunks`)} ${badge(doc.sourceType)} ${(doc.tags || []).map((tag) => badge(tag)).join(" ")}
        <p class="muted">${escapeHtml(doc.source)}</p>
        ${doc.metadata?.embedding ? `<p class="muted">Embeddings: ${escapeHtml(String(doc.metadata.embedding.embeddedChunks || 0))} embedded, ${escapeHtml(String(doc.metadata.embedding.failedChunks || 0))} failed (${escapeHtml(doc.metadata.embedding.provider || "off")})</p>` : ""}
        <p class="muted">Updated: ${escapeHtml(doc.updatedAt)}</p>
        <div class="actions">
          <button data-kb-reindex="${escapeHtml(doc.id)}">Reindex</button>
          <button class="danger" data-kb-delete="${escapeHtml(doc.id)}">Delete</button>
        </div>
      </article>`).join("")
    : `<p class="muted">No knowledge documents yet. Ingest README.md or paste an SOP to start building local retrieval memory.</p>`;

  document.querySelectorAll("[data-kb-reindex]").forEach((button) => {
    button.addEventListener("click", async () => {
      const payload = await api("/api/knowledge/reindex", {
        method: "POST",
        body: JSON.stringify({ documentId: button.dataset.kbReindex, force: false })
      });
      const output = payload.output || {};
      qs("#knowledge-results").innerHTML = `
        <article class="card">
          <div class="card-title">Knowledge Reindex Complete</div>
          ${badge(`provider ${output.provider || "off"}`)} ${badge(`model ${output.model || "none"}`)}
          <p class="muted">Processed: ${escapeHtml(String(output.processedChunks || 0))}, Updated: ${escapeHtml(String(output.updatedChunks || 0))}, Skipped: ${escapeHtml(String(output.skippedChunks || 0))}, Failed: ${escapeHtml(String(output.failedChunks || 0))}</p>
          ${output.failureReason ? `<p class="muted">Note: ${escapeHtml(output.failureReason)}</p>` : ""}
        </article>`;
      await refreshAll();
    });
  });

  document.querySelectorAll("[data-kb-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/knowledge/${button.dataset.kbDelete}`, { method: "DELETE" });
      await refreshAll();
    });
  });
}

function renderKnowledgeResults(payload = {}) {
  const results = Array.isArray(payload.results) ? payload.results : [];
  const requestedMode = payload.requestedMode || "keyword";
  const effectiveMode = payload.effectiveMode || requestedMode;
  const fallbackReason = payload.fallbackReason;
  const statusCard = `
    <article class="card">
      <div class="card-title">Search Mode</div>
      ${badge(`requested ${requestedMode}`)} ${badge(`effective ${effectiveMode}`)}
      ${fallbackReason ? `<p class="muted">Fallback: ${escapeHtml(fallbackReason)}</p>` : ""}
    </article>`;
  qs("#knowledge-results").innerHTML = results.length
    ? `${statusCard}${results.map((result) => `
      <article class="card">
        <div class="card-title">${escapeHtml(result.document.title)}</div>
        ${badge(`score ${result.score}`)} ${badge(`chunk ${result.chunk.index + 1}`)} ${(result.highlights || []).map((item) => badge(item)).join(" ")}
        <p class="muted">${escapeHtml(result.chunk.text.slice(0, 700))}${result.chunk.text.length > 700 ? "..." : ""}</p>
      </article>`).join("")}`
    : `${statusCard}<p class="muted">No knowledge results yet.</p>`;
}

async function loadTools() {
  const agent = qs("#agent").value || "operator";
  const tools = await api(`/api/tools?agent=${encodeURIComponent(agent)}`);
  qs("#tools").innerHTML = tools.length
    ? tools.map((tool) => `
      <article class="card">
        <div class="card-title">${escapeHtml(tool.name)}</div>
        ${badge(tool.riskLevel, tool.riskLevel)} ${tool.requiresApproval ? badge("approval required", "pending") : badge("auto allowed", "low")}
        <p class="muted">${escapeHtml(tool.description)}</p>
      </article>`).join("")
    : `<p class="muted">No tools available for this agent.</p>`;
}


async function loadVault() {
  const payload = await api("/api/vault");
  qs("#vault-state").textContent = payload.configured ? `${payload.secrets.length} secret(s) stored` : "Locked: set GOATMEZ_VAULT_KEY";
  qs("#vault").innerHTML = payload.secrets.length
    ? payload.secrets.map((secret) => `
      <article class="card">
        <div class="card-title">${escapeHtml(secret.name)}</div>
        ${badge(secret.scope)} ${secret.provider ? badge(secret.provider) : ""} ${badge(secret.maskedPreview)}
        <p class="muted">Updated: ${escapeHtml(secret.updatedAt)}</p>
        ${secret.lastAccessedAt ? `<p class="muted">Last used: ${escapeHtml(secret.lastAccessedAt)}</p>` : ""}
        <div class="actions"><button class="danger" data-secret-delete="${escapeHtml(secret.id)}">Delete</button></div>
      </article>`).join("")
    : `<p class="muted">No vault secrets saved yet. Add a master key in .env, then save connector secrets here.</p>`;

  document.querySelectorAll("[data-secret-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/vault/secrets/${button.dataset.secretDelete}`, { method: "DELETE" });
      await refreshAll();
    });
  });
}

async function loadConnectors() {
  const connectors = await api("/api/connectors");
  qs("#connectors").innerHTML = connectors.length
    ? connectors.map((connector) => `
      <article class="card">
        <div class="card-title">${escapeHtml(connector.name)}</div>
        ${badge(connector.enabled ? "enabled" : "disabled", connector.enabled ? "done" : "")} ${badge(connector.ready ? "ready" : "missing setup", connector.ready ? "done" : "blocked")} ${badge(connector.type)} ${badge(connector.riskLevel || "medium", connector.riskLevel || "medium")}
        <p class="muted">${escapeHtml(connector.description || "No description")}</p>
        ${connector.requiredSecrets?.length ? `<p class="muted">Secrets: ${escapeHtml(connector.requiredSecrets.join(", "))}</p>` : `<p class="muted">No secrets required.</p>`}
        ${connector.missingSecrets?.length ? `<p class="muted">Missing: ${escapeHtml(connector.missingSecrets.join(", "))}</p>` : ""}
      </article>`).join("")
    : `<p class="muted">No connector profiles configured yet.</p>`;
}


async function loadSetupWizard() {
  const profiles = await api("/api/setup/connectors");
  qs("#setup-wizard").innerHTML = profiles.length
    ? profiles.map((profile) => `
      <article class="card">
        <div class="card-title">${escapeHtml(profile.name)} <code>${escapeHtml(profile.connectorId)}</code></div>
        ${badge(profile.enabled ? "enabled" : "disabled", profile.enabled ? "done" : "blocked")} ${badge(profile.ready ? "ready" : "needs setup", profile.ready ? "done" : "pending")}
        <p class="muted">${escapeHtml(profile.description || "Connector setup profile")}</p>
        ${(profile.requiredSecrets || []).map((secret) => `<p class="muted">${secret.configured ? "✓" : "•"} ${escapeHtml(secret.name)} — ${escapeHtml(secret.description)}</p>`).join("")}
        <details>
          <summary>Setup steps</summary>
          ${(profile.steps || []).map((step) => `<p class="muted">${escapeHtml(step)}</p>`).join("")}
        </details>
      </article>`).join("")
    : `<p class="muted">No setup profiles found.</p>`;
}

async function loadConnectorHealth() {
  const health = await api("/api/connectors/health");
  const rows = Array.isArray(health) ? health : [health];
  qs("#connector-health").innerHTML = rows.length
    ? rows.map((item) => `
      <article class="card">
        <div class="card-title">${escapeHtml(item.connectorId)}</div>
        ${badge(item.enabled ? "enabled" : "disabled", item.enabled ? "done" : "")} ${badge(item.ready ? "ready" : "not ready", item.ready ? "done" : "blocked")} ${badge(item.type)} ${badge(item.riskLevel, item.riskLevel)}
        ${(item.checks || []).map((check) => `<p class="muted">${escapeHtml(check)}</p>`).join("")}
      </article>`).join("")
    : `<p class="muted">No connector health records yet.</p>`;
}

async function loadConnectorActions() {
  const actions = await api("/api/connectors/actions?limit=50");
  qs("#connector-actions").innerHTML = actions.length
    ? actions.map((action) => `
      <article class="card">
        <div class="card-title">${escapeHtml(action.connectorId)} — ${escapeHtml(action.action)}</div>
        ${badge(action.status, action.status)} ${badge(action.agentId)} ${action.dryRun ? badge("dry-run") : badge("executed", "done")}
        <p class="muted">${escapeHtml(action.updatedAt)}</p>
        ${action.error ? `<p class="muted">Error: ${escapeHtml(action.error)}</p>` : ""}
        ${action.status === "prepared" ? `<div class="actions"><button class="good" data-connector-execute="${escapeHtml(action.id)}">Execute Prepared Action</button></div>` : ""}
      </article>`).join("")
    : `<p class="muted">No connector actions recorded yet.</p>`;

  document.querySelectorAll("[data-connector-execute]").forEach((button) => {
    button.addEventListener("click", async () => {
      const payload = await api(`/api/connectors/actions/${button.dataset.connectorExecute}/execute`, {
        method: "POST",
        body: JSON.stringify({ agentId: "operator" })
      });
      qs("#provider-result").textContent = JSON.stringify(payload, null, 2);
      await refreshAll();
    });
  });
}

async function loadMcp() {
  const payload = await api("/api/mcp");
  qs("#mcp").innerHTML = payload.servers.length
    ? payload.servers.map((server) => `
      <article class="card">
        <div class="card-title">${escapeHtml(server.name || server.id)}</div>
        ${badge(server.enabled ? "enabled" : "disabled", server.enabled ? "done" : "")} ${badge(server.transport)}
        <p class="muted">${escapeHtml(server.url || [server.command, ...(server.args || [])].filter(Boolean).join(" ") || "No endpoint configured")}</p>
      </article>`).join("")
    : `<p class="muted">No MCP servers configured yet.</p>`;
}

async function loadEvents() {
  const events = await api("/api/events?limit=80");
  qs("#events").innerHTML = events.length
    ? events.map((event) => `
      <article class="event">
        <div><code>${escapeHtml(event.timestamp)}</code></div>
        <div>${badge(event.type)}</div>
        <pre>${pretty(event.payload)}</pre>
      </article>`).join("")
    : `<p class="muted">No events written yet.</p>`;
}

async function refreshAll() {
  await Promise.allSettled([loadHealth(), loadAgents()]);
  await Promise.allSettled([loadModelStatus(), loadApprovals(), loadSchedules(), loadPlaybooks(), loadWorkflowRuns(), loadMissions(), loadTasks(), loadMemory(), loadKnowledge(), loadTools(), loadVault(), loadConnectors(), loadSetupWizard(), loadConnectorHealth(), loadConnectorActions(), loadMcp(), loadEvents()]);
}

qs("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setToken(qs("#dashboard-token").value.trim());
  qs("#auth-panel").classList.add("hidden");
  await refreshAll();
});

qs("#clear-token").addEventListener("click", async () => {
  setToken("");
  qs("#dashboard-token").value = "";
  await checkAuth();
});

qs("#mission-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = qs("#result");
  result.textContent = "Running mission...";
  try {
    const payload = await api("/api/run", {
      method: "POST",
      body: JSON.stringify({
        agentId: qs("#agent").value,
        message: qs("#message").value,
        dryRun: qs("#dryRun").checked,
        approveAll: qs("#approveAll").checked
      })
    });
    result.textContent = payload.result;
    await refreshAll();
  } catch (error) {
    result.textContent = error.message || String(error);
  }
});

qs("#memory-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const content = qs("#memory-content").value.trim();
  if (!content) return;
  await api("/api/memory", {
    method: "POST",
    body: JSON.stringify({ scope: "workspace", content, importance: 2 })
  });
  qs("#memory-content").value = "";
  await refreshAll();
});

qs("#schedule-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = qs("#schedule-title").value.trim() || "Scheduled mission";
  const message = qs("#schedule-message").value.trim();
  if (!message) return;
  await api("/api/schedules", {
    method: "POST",
    body: JSON.stringify({
      title,
      message,
      agentId: qs("#schedule-agent").value,
      intervalMinutes: Number(qs("#schedule-interval").value || 60)
    })
  });
  qs("#schedule-title").value = "";
  qs("#schedule-message").value = "";
  await refreshAll();
});

qs("#workflow-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const playbookId = qs("#playbook").value;
  const rawInputs = qs("#workflow-inputs").value.trim();
  const inputs = {};
  if (rawInputs) {
    for (const line of rawInputs.split("\n")) {
      const [key, ...valueParts] = line.split("=");
      if (key && valueParts.length) inputs[key.trim()] = valueParts.join("=").trim();
    }
  }
  const payload = await api("/api/workflows/run", {
    method: "POST",
    body: JSON.stringify({ playbookId, inputs, dryRun: qs("#workflow-dry-run").checked })
  });
  qs("#result").textContent = `Workflow ${payload.run.status}: ${payload.run.playbookName}`;
  await refreshAll();
});



qs("#knowledge-search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = qs("#knowledge-query").value.trim();
  if (!query) return;
  const mode = qs("#knowledge-mode").value || "keyword";
  const hybridWeight = Number(qs("#knowledge-hybrid-weight").value);
  const payload = await api("/api/knowledge/search", {
    method: "POST",
    body: JSON.stringify({ query, limit: 10, mode, hybridWeight })
  });
  renderKnowledgeResults(payload);
});

qs("#knowledge-file-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const path = qs("#knowledge-file-path").value.trim();
  if (!path) return;
  const payload = await api("/api/knowledge/file", { method: "POST", body: JSON.stringify({ path, tags: ["workspace"] }) });
  const vectorization = payload.result?.output?.vectorization;
  qs("#knowledge-results").innerHTML = `
    <article class="card">
      <div class="card-title">${escapeHtml(payload.result?.summary || "File ingested")}</div>
      ${vectorization ? `<p class="muted">Vectors: ${escapeHtml(String(vectorization.embeddedChunks || 0))} embedded, ${escapeHtml(String(vectorization.failedChunks || 0))} failed (${escapeHtml(vectorization.provider || "off")})</p>` : ""}
      ${vectorization?.failureReason ? `<p class="muted">Vector fallback: ${escapeHtml(vectorization.failureReason)}</p>` : ""}
    </article>`;
  qs("#knowledge-file-path").value = "";
  await refreshAll();
});

qs("#knowledge-text-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = qs("#knowledge-title").value.trim();
  const text = qs("#knowledge-text").value.trim();
  const tags = qs("#knowledge-tags").value.split(",").map((tag) => tag.trim()).filter(Boolean);
  if (!title || !text) return;
  const payload = await api("/api/knowledge/text", { method: "POST", body: JSON.stringify({ title, text, tags }) });
  const vectorization = payload.output?.vectorization;
  qs("#knowledge-results").innerHTML = `
    <article class="card">
      <div class="card-title">${escapeHtml(payload.output?.document?.title || "Knowledge saved")}</div>
      <p class="muted">${escapeHtml((payload.output?.chunks?.length || 0) + " chunk(s) created")}</p>
      ${vectorization ? `<p class="muted">Vectors: ${escapeHtml(String(vectorization.embeddedChunks || 0))} embedded, ${escapeHtml(String(vectorization.failedChunks || 0))} failed (${escapeHtml(vectorization.provider || "off")})</p>` : ""}
      ${vectorization?.failureReason ? `<p class="muted">Vector fallback: ${escapeHtml(vectorization.failureReason)}</p>` : ""}
    </article>`;
  qs("#knowledge-title").value = "";
  qs("#knowledge-tags").value = "";
  qs("#knowledge-text").value = "";
  await refreshAll();
});

qs("#knowledge-reindex-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const documentId = qs("#knowledge-reindex-document-id").value.trim();
  const limitRaw = Number(qs("#knowledge-reindex-limit").value);
  const force = qs("#knowledge-reindex-force").checked;
  const payload = await api("/api/knowledge/reindex", {
    method: "POST",
    body: JSON.stringify({
      documentId: documentId || undefined,
      force,
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined
    })
  });
  const output = payload.output || {};
  qs("#knowledge-results").innerHTML = `
    <article class="card">
      <div class="card-title">Knowledge Reindex Complete</div>
      ${badge(`provider ${output.provider || "off"}`)} ${badge(`model ${output.model || "none"}`)}
      <p class="muted">Processed: ${escapeHtml(String(output.processedChunks || 0))}, Updated: ${escapeHtml(String(output.updatedChunks || 0))}, Skipped: ${escapeHtml(String(output.skippedChunks || 0))}, Failed: ${escapeHtml(String(output.failedChunks || 0))}</p>
      ${output.failureReason ? `<p class="muted">Note: ${escapeHtml(output.failureReason)}</p>` : ""}
    </article>`;
  qs("#knowledge-reindex-document-id").value = "";
  qs("#knowledge-reindex-limit").value = "";
  qs("#knowledge-reindex-force").checked = false;
  await refreshAll();
});

qs("#vault-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = qs("#vault-name").value.trim();
  const value = qs("#vault-value").value;
  if (!name || !value) return;
  await api("/api/vault/secrets", {
    method: "POST",
    body: JSON.stringify({
      name,
      value,
      scope: qs("#vault-scope").value.trim() || "workspace",
      provider: qs("#vault-provider").value.trim() || undefined
    })
  });
  qs("#vault-name").value = "";
  qs("#vault-value").value = "";
  qs("#vault-provider").value = "";
  await refreshAll();
});


qs("#connector-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const bodyText = qs("#connector-body").value.trim();
  let body = undefined;
  if (bodyText) {
    try { body = JSON.parse(bodyText); } catch (error) { qs("#connector-result").textContent = "Invalid JSON body: " + (error.message || String(error)); return; }
  }
  try {
    const payload = await api("/api/connectors/http/dry-run", {
      method: "POST",
      body: JSON.stringify({
        connectorId: qs("#connector-id").value.trim(),
        method: qs("#connector-method").value.trim() || "GET",
        path: qs("#connector-path").value.trim() || "/",
        body
      })
    });
    qs("#connector-result").textContent = JSON.stringify(payload.output, null, 2);
    await refreshAll();
  } catch (error) {
    qs("#connector-result").textContent = error.message || String(error);
  }
});

qs("#google-oauth-dry").addEventListener("click", async () => {
  const payload = await api("/api/connectors/oauth/google/refresh/dry-run", {
    method: "POST",
    body: JSON.stringify({ connectorId: "gmail" })
  });
  qs("#provider-result").textContent = JSON.stringify(payload.output, null, 2);
  await refreshAll();
});

qs("#ghl-search-dry").addEventListener("click", async () => {
  const payload = await api("/api/connectors/ghl/search/dry-run", {
    method: "POST",
    body: JSON.stringify({ query: "test", limit: 10 })
  });
  qs("#provider-result").textContent = JSON.stringify(payload.output, null, 2);
  await refreshAll();
});

qs("#gmail-draft-dry").addEventListener("click", async () => {
  const payload = await api("/api/connectors/gmail/draft/dry-run", {
    method: "POST",
    body: JSON.stringify({ to: "client@example.com", subject: "Draft from Goatmez Agent OS", body: "This is a safe dry-run Gmail draft." })
  });
  qs("#provider-result").textContent = JSON.stringify(payload.output, null, 2);
  await refreshAll();
});

qs("#calendar-event-dry").addEventListener("click", async () => {
  const start = new Date(Date.now() + 3600000).toISOString();
  const end = new Date(Date.now() + 7200000).toISOString();
  const payload = await api("/api/connectors/calendar/event/dry-run", {
    method: "POST",
    body: JSON.stringify({ title: "Goatmez Agent OS Test Event", startTime: start, endTime: end, attendees: [] })
  });
  qs("#provider-result").textContent = JSON.stringify(payload.output, null, 2);
  await refreshAll();
});

qs("#refresh").addEventListener("click", refreshAll);
qs("#agent").addEventListener("change", loadTools);

checkAuth().then(refreshAll).catch((error) => {
  qs("#result").textContent = error.message || String(error);
});
setInterval(() => {
  Promise.allSettled([loadModelStatus(), loadApprovals(), loadSchedules(), loadWorkflowRuns(), loadMissions(), loadTasks(), loadMemory(), loadKnowledge(), loadVault(), loadConnectors(), loadSetupWizard(), loadConnectorHealth(), loadConnectorActions(), loadEvents(), loadHealth()]);
}, 5000);
