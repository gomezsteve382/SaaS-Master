# Goatmez Agent OS Extraction — Part 01

## Boundary
The uploaded repo describes itself as reference and `UNLICENSED`, so this extraction does **not** copy its source code or proprietary wording. This is a clean-room architecture extraction: what systems exist, how they appear to relate, and how to rebuild the same category of product with original code.

## 1. Top-level repo identity

### Observed metadata
- Package name: `@External Provider-ai/Reference System-code`
- Version: `0.0.0-reference`
- License: `UNLICENSED`
- Runtime: Bun
- Language: TypeScript / TSX
- UI approach: React + Ink terminal UI, plus web/server pieces
- MCP dependency: `@modelcontextprotocol/sdk`
- Main CLI entry: `src/entrypoints/cli.tsx`
- Binary command exposed: `Reference System`

### Clean-room interpretation
This is not just a CLI chatbot. It is a complete agent runtime with:

1. CLI entrypoint
2. query engine
3. tool registry
4. command registry
5. permission layer
6. MCP client/server layer
7. terminal UI layer
8. state + memory systems
9. plugin / skill systems
10. server + observability infrastructure
11. deployment recipes

For Goatmez Agent OS, the equivalent product category is:

> A command-center runtime that lets LLM agents safely use tools, run tasks, remember context, connect to external systems, and report everything through a controllable interface.

---

## 2. Repository map

### Major top-level folders

| Folder | What it appears to represent | Clean-room rebuild meaning |
|---|---|---|
| `.github/` | workflows, repo automation, code ownership, agent instruction docs | CI/CD, repo standards, automated checks |
| `docker/` | containerization and proxy/deployment configs | Dockerized app deployment |
| `docs/` | architecture, bridge, commands, tools, subsystems, exploration guide | internal engineering docs |
| `grafana/` | dashboards for conversations, cost, infrastructure, overview | observability dashboards |
| `helm/` | Kubernetes deployment chart | enterprise/cloud deployment path |
| `mcp-server/` | standalone MCP server implementation | tool-server layer for external clients |
| `prompts/` | prompt/system behavior assets | agent behavior templates |
| `scripts/` | build, packaging, development scripts | build automation |
| `src/` | core application source | main Agent OS runtime |

---

## 3. `src/` high-level module map

These are the main source modules visible at shallow depth.

| Module | Approximate role | Goatmez rebuild equivalent |
|---|---|---|
| `main.tsx` | very large bundled/central runtime entry area | split into app bootstrap + runtime coordinator |
| `QueryEngine.ts` | core LLM/query orchestration | `AgentRuntime` / `PlannerExecutor` |
| `Tool.ts` | tool definition abstraction | `ToolSpec`, `ToolRegistry`, `ToolRunner` |
| `tools.ts` | central tool loading/export layer | `coreTools/index.ts` |
| `commands.ts` | command registry/definition layer | slash-command router |
| `Task.ts`, `tasks.ts` | task abstractions | task engine / queue job model |
| `context.ts` | runtime context | session context object |
| `history.ts` | conversation/history handling | message store + replay |
| `cost-tracker.ts` | cost accounting | usage ledger |
| `interactiveHelpers.tsx` | terminal UI helper behavior | CLI interaction helpers |
| `dialogLaunchers.tsx` | UI dialog flows | confirmations, settings, approvals |
| `entrypoints/` | executable entrypoints | CLI, SDK, server bootstrap |
| `components/` | React/Ink UI components | dashboard + terminal components |
| `commands/` | many command modules | `/mcp`, `/memory`, `/agents`, etc. |
| `services/` | business/service layer | external API adapters and internal services |
| `bridge/` | IDE bridge integration | VS Code/browser/native bridge |
| `server/` | web/server backend | API server + auth + DB |
| `schemas/` | validation schemas | Zod/Pydantic schemas |
| `migrations/` | database migrations | DB schema evolution |
| `plugins/` | plugin loading | extension marketplace/internal plugins |
| `skills/` | skill system | reusable workflows/packages |
| `hooks/` | React/runtime hooks | UI and runtime state hooks |
| `ink/` | terminal rendering subsystem | terminal app shell |
| `memdir/` | memory directory logic | file-based/project memory |
| `coordinator/` | multi-agent coordination | supervisor-agent orchestration |
| `remote/` | remote environment support | cloud/devbox agent execution |

---

## 4. Core product formula

The repo’s architecture points to this formula:

```text
User Input
  -> CLI / UI / API entrypoint
  -> Command parser or Query Engine
  -> Context builder
  -> LLM request builder
  -> Tool call planner
  -> Permission gateway
  -> Tool execution / MCP call / subagent call
  -> Result normalization
  -> Conversation state update
  -> UI render + logs + telemetry
```

Clean-room Goatmez formula:

```text
Steven Command
  -> War Room Dashboard / CLI
  -> Commander Agent
  -> Policy + Permission Check
  -> Specialist Agent / MCP Tool
  -> Execution Sandbox
  -> Result + Evidence
  -> Approval Gate when needed
  -> Memory + CRM/File/DB update
  -> Activity Log
```

---

## 5. Dependency signal extraction

Important dependencies reveal the product capabilities:

| Dependency | Signal | Goatmez equivalent |
|---|---|---|
| `@External Provider-ai/sdk` | direct LLM API client | OpenAI/External Provider provider adapters |
| `@modelcontextprotocol/sdk` | MCP support | MCP tool server/client layer |
| `react` + `ink` ecosystem | terminal UI | CLI control center |
| `better-sqlite3`, `postgres`, `drizzle-orm` | local and server persistence | Postgres + SQLite local cache |
| `zod` | schema validation | typed tool and config schemas |
| `node-pty`, `xterm` | terminal/shell integration | safe shell/browsing workbench |
| `vscode-jsonrpc`, LSP packages | editor/code intelligence | code assistant tooling |
| `pino`, OpenTelemetry, Sentry | logging/telemetry | audit logs + observability |
| `ws`, `undici`, `axios` | HTTP/WebSocket integrations | live dashboard/API calls |
| `ignore`, `picomatch`, `chokidar` | file scanning/watching | project workspace indexing |

Takeaway: the system is built like a developer agent that can act in a project workspace, not like a simple prompt wrapper.

---

## 6. Rebuild target: Goatmez Agent OS v1

### Minimum clean-room modules

```text
goatmez-agent-os/
  apps/
    web-dashboard/          # Next.js dashboard
    cli/                    # optional terminal CLI
  services/
    api/                    # FastAPI or Node API
    worker/                 # task runner
    mcp-gateway/            # MCP client/server layer
  packages/
    agent-runtime/          # planner/executor loop
    tool-registry/          # tool specs and permission metadata
    permissions/            # approval gateway
    memory/                 # memory APIs and vector store
    connectors/             # Gmail, Calendar, GHL, files, browser
    observability/          # logs, traces, usage/costs
  infra/
    docker/
    postgres/
    redis/
```

### Core database tables

```text
users
agents
agent_tools
sessions
messages
tool_calls
tool_permissions
memories
tasks
workflow_runs
audit_logs
api_keys
mcp_servers
```

### Core service objects

```text
AgentRuntime
CommanderAgent
SpecialistAgent
ToolRegistry
PermissionGateway
McpGateway
MemoryManager
TaskQueue
WorkflowRunner
AuditLogger
CostTracker
```

---

## 7. First implementation priority

Build this in order:

1. `ToolSpec` standard
2. `ToolRegistry`
3. `PermissionGateway`
4. `AgentRuntime` loop
5. `McpGateway`
6. memory store
7. task queue
8. web dashboard
9. specialist agents
10. workflow builder

This gives you the same **class of system** without touching the proprietary implementation.

---

## 8. Part 02 target

Next extraction should focus on the **Tool System**:

- what tools exist
- tool categories
- how tool modules are organized
- permission implications
- clean-room `ToolSpec` design
- which Goatmez tools to build first

