# Goatmez Agent OS — Clean-Room Architecture Audit

## Executive Decision
The uploaded repo is useful as an architectural reference, but it should not be copied, packaged, or used as a dependency. The package declares itself `UNLICENSED` and identifies as outside reference source, so the safest move is clean-room implementation: study the patterns, then rebuild original code and original prompts.

## What the Repo Appears to Be
A TypeScript/Bun agent runtime with a terminal UI, web/admin surfaces, MCP client/server support, tool invocation, permissions, tasks, plugin/skill support, IDE bridge support, telemetry, and deployment assets.

Key stats from inspection:
- 2,498 files total
- Major app language: TypeScript/TSX
- Runtime/build: Bun
- UI: React + Ink terminal UI, plus a web app folder
- MCP SDK: `@modelcontextprotocol/sdk`
- Persistence: SQLite/Postgres-related dependencies and Drizzle config
- Observability: OpenTelemetry, Sentry, Prometheus/Grafana assets
- Deployment: Docker, Helm, Vercel-related files

## Top-Level Architecture Pattern
The architecture is an AI operating system, not a single chatbot.

The system breaks into these layers:

1. **Entrypoint Layer**
   - CLI boot
   - MCP server mode
   - SDK schemas/types
   - startup/init flow

2. **Conversation / Query Engine Layer**
   - REPL screen
   - main runtime loop
   - message processing
   - context compaction
   - prompt contribution from tools/skills/MCP

3. **Tool Runtime Layer**
   - Tools are self-contained modules with schema, permission checks, execution, and UI rendering.
   - Important categories: file I/O, shell execution, web search/fetch, MCP tools, LSP tools, notebook tools, config, brief/summary tools, plan/worktree tools, agent tools.

4. **Permission Layer**
   - Every meaningful tool call is routed through permission checks.
   - Modes include prompt-based approval, plan approval, auto/bypass modes.
   - Rule patterns resemble `Bash(git *)`, `FileEdit(/src/*)`, `FileRead(*)`.

5. **MCP Layer**
   - Acts as MCP client to consume outside tools/resources.
   - Can run as MCP server to expose its own tools/resources.
   - Supports MCP auth, tool discovery, resource listing, resource reading, server approval, connectivity monitoring.

6. **Task / Agent Layer**
   - Local shell tasks
   - Local agent tasks
   - Remote agent tasks
   - In-process teammate tasks
   - Background/dream tasks
   - Main session as task

7. **Coordinator / Multi-Agent Layer**
   - Team creation/deletion
   - Sub-agent spawning
   - Inter-agent messaging
   - Feature-gated coordinator mode

8. **Memory Layer**
   - Project memory
   - User memory
   - Extracted memories
   - Team memory sync
   - Memory commands and remember-style workflows

9. **Plugin / Skill Layer**
   - Plugin discovery, installation, loading, execution, and update notifications.
   - Skills are reusable workflows with prompts/tool configs.
   - MCP resources can become skills.

10. **Bridge Layer**
   - IDE connection concepts for VS Code/JetBrains.
   - Messaging protocol, session runner, JWT/auth utilities, permission callbacks.
   - Chrome/native host references appear in bridge docs/files.

11. **Observability / Ops Layer**
   - Cost tracking
   - diagnostics/doctor command
   - logs
   - metrics
   - Grafana dashboards
   - deployment manifests

## Clean-Room Blueprint for Goatmez Agent OS

### Product Name
Goatmez Agent OS / Goatmez Command Center

### Core Principle
Build the factory that creates agents, not just one agent.

### Recommended V1 Stack
- Frontend: Next.js dashboard
- Backend: FastAPI or Node.js/NestJS
- Agent runtime: Python-first for speed, TypeScript optional for dashboard/MCP servers
- Database: Postgres
- Vector memory: pgvector first, Qdrant later if needed
- Queue: Redis + Celery/RQ or BullMQ
- MCP: official MCP SDK servers for tools
- Browser automation: Playwright
- Auth: Clerk/Auth.js/Supabase Auth depending on speed preference
- Logs: structured JSON logs + dashboard viewer
- Deployment: Docker Compose first, then DigitalOcean/GCP

## Goatmez Agent OS V1 Modules

### 1. Agent Registry
Stores every agent:
- name
- role
- system instructions
- allowed tools
- memory scope
- risk level
- owner
- active/inactive status

### 2. Tool Registry
Every tool has:
- tool name
- description
- input schema
- output schema
- risk level: read, write, external-send, money, destructive
- permission requirement
- implementation type: native, MCP, browser, API, shell

### 3. Permission Gateway
All tool calls go through one approval gate.

Permission levels:
- Read-only: auto approve
- Draft/write-local: auto or batch approve
- External send: approval required
- Delete/money/legal action: approval required
- Browser automation on sensitive systems: approval required

### 4. MCP Manager
Dashboard for:
- connected MCP servers
- available tools
- resource browsing
- server health
- auth status
- per-agent tool assignment

### 5. Task Engine
Supports:
- one-shot tasks
- scheduled tasks
- recurring workflows
- background jobs
- task logs
- cancellation
- retries
- human approvals

### 6. Memory System
Scopes:
- global user memory
- business memory
- agent memory
- project memory
- client memory

Memory should be auditable and editable. Nothing mission-critical should be hidden.

### 7. Workflow Builder
No-code/low-code builder:
- trigger
- planner
- tool execution steps
- condition branches
- human approval steps
- final report/action

Example workflow:
Lead Finder -> Scrape site -> Score lead -> Draft email -> Human approval -> Send -> Schedule follow-up.

### 8. Agent Dashboard
Screens:
- Agents
- Tasks
- Tool Registry
- MCP Servers
- Memory
- Approvals
- Logs
- Workflows
- Settings

## Priority Agents for Steven

### Credit Plug Agent
Lead intake, qualification, FAQs, appointment handoff, CRM updates.

### Dispute/Compliance Agent
Credit report parsing, negative item analysis, violation spotting, letter drafting. Requires legal disclaimers and approval gates.

### VA Replacement Agent
Email triage, calendar management, CRM updates, follow-ups, reporting.

### SEO Hunter Agent
Find local businesses, audit websites, identify SEO gaps, draft pitch emails.

### Content General Agent
Create posts, captions, reels scripts, long-form scripts, content calendars.

### Browser Operator Agent
Uses Playwright to operate web apps under strict permissions.

### Dev Agent
Reads code, creates patches, runs tests, opens PR-style summaries.

## Implementation Roadmap

### Phase 0 — Legal/Safety Guardrail
Do not copy files, strings, prompts, or proprietary structure directly. Use only the abstract architecture patterns.

### Phase 1 — Skeleton
Build backend, database, auth, and dashboard shell.

Tables:
- agents
- tools
- mcp_servers
- tasks
- task_events
- approvals
- memories
- workflows
- workflow_runs
- files
- audit_logs

### Phase 2 — Tool Runtime
Implement native tools:
- file read/write sandbox
- web fetch/search
- browser automation starter
- Gmail/Calendar connectors where authorized
- CRM/GHL connector
- shell only inside sandbox

### Phase 3 — MCP Runtime
Add MCP client manager:
- register server
- list tools
- call tools
- list/read resources
- auth status
- health checks

### Phase 4 — Agent Runner
Implement:
- planner prompt
- tool call loop
- permission interception
- memory retrieval
- final answer/report
- error recovery

### Phase 5 — Tasks and Workflows
Add background jobs, schedules, recurring jobs, and workflow designer.

### Phase 6 — Multi-Agent Coordinator
Add commander agent that delegates to specialists.

### Phase 7 — Production Hardening
Add audit logs, usage limits, org settings, team permissions, backups, metrics, and deployment pipeline.

## Database Skeleton

```sql
create table agents (
  id uuid primary key,
  name text not null,
  role text not null,
  instructions text not null,
  memory_scope text default 'agent',
  risk_level text default 'medium',
  is_active boolean default true,
  created_at timestamptz default now()
);

create table tools (
  id uuid primary key,
  name text not null unique,
  description text,
  kind text not null,
  risk_level text not null,
  input_schema jsonb,
  output_schema jsonb,
  enabled boolean default true
);

create table agent_tools (
  agent_id uuid references agents(id),
  tool_id uuid references tools(id),
  permission_mode text default 'ask',
  primary key(agent_id, tool_id)
);

create table tasks (
  id uuid primary key,
  agent_id uuid references agents(id),
  title text not null,
  prompt text not null,
  status text default 'queued',
  result jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table approvals (
  id uuid primary key,
  task_id uuid references tasks(id),
  tool_name text not null,
  proposed_input jsonb not null,
  risk_level text not null,
  status text default 'pending',
  decided_at timestamptz
);

create table memories (
  id uuid primary key,
  scope text not null,
  scope_id text,
  content text not null,
  embedding vector,
  source text,
  created_at timestamptz default now()
);
```

## Clean Tool Interface

Every tool should implement this original interface:

```ts
type ToolRisk = 'read' | 'write' | 'external_send' | 'money' | 'destructive';

type AgentTool<I, O> = {
  name: string;
  description: string;
  risk: ToolRisk;
  inputSchema: unknown;
  outputSchema: unknown;
  canRun(context: ToolContext, input: I): Promise<PermissionDecision>;
  run(context: ToolContext, input: I): Promise<O>;
};
```

## The Big Strategic Takeaway
Modern agent systems are built from five primitives:

1. Model reasoning
2. Tool registry
3. Permission gateway
4. Memory/context system
5. Task/workflow orchestration

If we build those five cleanly, Goatmez Agent OS can power every later product: Credit Plug, Dispute Bot, VA Agent, SEO bot, Facebook ops bot, and the AI Command Center.
