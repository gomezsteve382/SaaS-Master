# Agent OS Extraction Part 11 — UI, Bridge, Server, and Observability Deep Dive

## Boundary
This is a clean-room architecture extraction. No proprietary source is reproduced.

---

# 1. Big Picture

The repo is not just a CLI. It has a terminal UI, web/server pieces, IDE bridge plumbing, telemetry, database support, deployment configs, Docker, Helm, Grafana dashboards, and remote session transport.

That means the product pattern is:

```txt
CLI / Terminal UI
        |
Bridge / Remote Transports
        |
Core Agent Runtime
        |
Server API + DB + Observability
        |
Dashboard / IDE / Remote Clients
```

For Goatmez Agent OS, this maps perfectly to:

```txt
Local CLI + Web Dashboard + Agent Runtime + MCP Servers + Cloud Control Plane
```

---

# 2. Terminal UI Pattern

## Observed areas

- `src/components/`
- `src/ink/`
- `src/screens/`
- `src/hooks/`
- `src/main.tsx`
- `src/replLauncher.tsx`

## What it does

The UI layer renders:

- Chat messages.
- Tool calls.
- Tool results.
- Permission dialogs.
- Diff views.
- MCP status.
- Help screens.
- Skill views.
- Task panels.
- Onboarding flows.
- Settings screens.

The repo uses a React-style component system for terminal rendering. The clean-room lesson is not the specific UI code. It is the architecture:

```txt
Runtime events -> App state -> UI components -> user interaction -> runtime actions
```

## Clean-room UI contract

Define UI-independent runtime events:

```ts
type RuntimeEvent =
  | { type: "assistant_message"; content: string }
  | { type: "tool_call"; toolName: string; input: unknown }
  | { type: "tool_result"; toolName: string; result: unknown }
  | { type: "permission_request"; request: PermissionRequest }
  | { type: "task_update"; taskId: string; status: string }
  | { type: "error"; message: string };
```

Then render those events in:

- CLI.
- Web dashboard.
- Mobile dashboard later.
- IDE panel later.

---

# 3. Permission UI Pattern

## Observed areas

- `src/components/permissions/`
- `src/hooks/toolPermission/`

The permission UI is highly componentized by tool type:

- Bash approval.
- File edit approval.
- File write approval.
- Web fetch approval.
- Skill approval.
- Plan mode approval.
- Notebook edit approval.
- Computer use approval.

## Clean-room design

Each permission request should include:

```ts
interface PermissionRequest {
  id: string;
  toolName: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  summary: string;
  inputPreview: string;
  requestedByAgentId: string;
  taskId?: string;
  options: PermissionOption[];
}
```

Common approval choices:

- Allow once.
- Always allow for this pattern.
- Deny once.
- Always deny for this pattern.
- Edit request.
- Switch to plan mode.

---

# 4. Bridge Pattern

## Observed areas

- `src/bridge/`
- `src/cli/transports/`
- `src/commands/bridge/`
- `src/services/api/`

The bridge appears to support remote/IDE-style interaction with the local agent runtime. It includes session handling, authentication, message routing, permission callbacks, inbound attachments, and transports.

## Clean-room bridge architecture

```txt
Client UI <-> Bridge Transport <-> Session Router <-> Agent Runtime
```

Supported clients:

- CLI.
- Browser dashboard.
- VS Code extension.
- Remote web session.
- Mobile app later.

Transport options:

- WebSocket for live sessions.
- Server-Sent Events for streaming output.
- HTTP for control actions.
- Local IPC for desktop/IDE integration.

## Bridge message types

```ts
type BridgeMessage =
  | { type: "start_session"; sessionId: string }
  | { type: "user_message"; content: string }
  | { type: "runtime_event"; event: RuntimeEvent }
  | { type: "permission_response"; requestId: string; approved: boolean }
  | { type: "attach_file"; fileId: string }
  | { type: "stop"; taskId?: string };
```

---

# 5. Server Pattern

## Observed areas

- `src/server/`
- `src/server/api/`
- `src/server/auth/`
- `src/server/db/`
- `src/server/security/`
- `src/server/observability/`
- `drizzle.config.ts`

The server layer suggests a product-ready control plane:

- API routes.
- Auth.
- Database.
- Security.
- Observability.
- Web UI support.

## Clean-room server stack

Recommended for Goatmez Agent OS:

- Backend: FastAPI or Node/NestJS.
- DB: Postgres.
- Queue: Redis/BullMQ or Celery/RQ.
- Realtime: WebSocket/SSE.
- Auth: JWT + role-based permissions.
- Logs: OpenTelemetry-compatible events.
- Metrics: Prometheus/Grafana.

## Core API endpoints

```txt
POST   /api/sessions
GET    /api/sessions/:id
POST   /api/sessions/:id/messages
GET    /api/sessions/:id/events

GET    /api/agents
POST   /api/agents
PATCH  /api/agents/:id

GET    /api/tasks
POST   /api/tasks
GET    /api/tasks/:id
POST   /api/tasks/:id/stop
GET    /api/tasks/:id/events

GET    /api/tools
POST   /api/tools/:name/invoke

GET    /api/mcp/servers
POST   /api/mcp/servers
DELETE /api/mcp/servers/:id

GET    /api/permissions
POST   /api/permissions/rules
```

---

# 6. Observability Pattern

## Observed areas

- `src/services/analytics/`
- `src/server/observability/`
- `grafana/`
- Docker and Helm deployment files

A serious agent runtime needs visibility:

- Token usage.
- Cost per task.
- Tool call counts.
- Failure rates.
- Permission denials.
- MCP health.
- Latency by model.
- Queue wait time.
- Agent productivity.

## Clean-room metric names

```txt
agent_task_started_total
agent_task_completed_total
agent_task_failed_total
agent_tool_calls_total
agent_permission_requests_total
agent_permission_denied_total
agent_llm_tokens_input_total
agent_llm_tokens_output_total
agent_llm_cost_usd_total
agent_mcp_server_connected
agent_runtime_errors_total
```

---

# 7. Goatmez Dashboard Screens

Build these first:

1. **War Room Home**
   - Active agents
   - Running tasks
   - Alerts
   - Cost today

2. **Agent Builder**
   - Name
   - Role
   - Tools
   - MCP servers
   - Memory scope
   - Approval rules

3. **Task Board**
   - Queued/running/completed/failed
   - Live event stream
   - Stop/retry buttons

4. **Tool Registry**
   - Tool list
   - Risk level
   - Test tool
   - Enable/disable

5. **MCP Manager**
   - Add server
   - Auth server
   - List tools/resources
   - Health check

6. **Permission Center**
   - Pending approvals
   - Rules
   - Audit log

7. **Memory Vault**
   - User/project/agent/team memories
   - Edit/delete/export

---

# 8. Rebuild Checklist

- [ ] Create runtime event contract.
- [ ] Build CLI renderer.
- [ ] Build web dashboard renderer.
- [ ] Build permission request UI.
- [ ] Build WebSocket/SSE event stream.
- [ ] Build bridge transport abstraction.
- [ ] Build API server.
- [ ] Build DB schema.
- [ ] Build observability metrics.
- [ ] Build dashboard screens.
- [ ] Add audit log exports.

## Key Takeaway
The UI/bridge/server layers turn an agent from a local script into a real platform. This is the difference between “a bot” and an operating system you can control, sell, monitor, and scale.
