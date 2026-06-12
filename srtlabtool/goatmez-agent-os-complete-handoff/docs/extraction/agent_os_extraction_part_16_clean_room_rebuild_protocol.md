# Agent OS Extraction Part 16 — Clean-Room Rebuild Protocol

## Purpose

This is the operating rulebook for rebuilding Goatmez Agent OS from architecture patterns without copying proprietary/unlicensed source.

The goal is not to clone a product. The goal is to build Steven's own agent platform using original code, original names, original prompts, and original workflows.

---

# 1. The Line We Do Not Cross

We do not copy:

- source files,
- function bodies,
- exact comments,
- proprietary prompt text,
- private constants,
- unique strings,
- exact schemas where they are unique,
- exact folder names where they imply identity/brand,
- reference credentials or internal service references.

We can use:

- public concepts,
- general architecture patterns,
- general capability lists,
- file/folder-level observations,
- behavioral descriptions,
- original clean-room interfaces,
- original code written from scratch.

---

# 2. Two-Person Clean-Room Ideal

Best practice would separate roles:

## Analyst

- Reviews reference material.
- Writes high-level specs.
- Avoids code-level reproduction.
- Documents behavior, interfaces, constraints, and workflows.

## Builder

- Does not read reference source.
- Implements from specs only.
- Uses original naming and logic.

In our workflow, we simulate this by creating extraction packs first, then implementing from those packs only.

---

# 3. Spec-First Rule

Every feature must go through this path:

```txt
Reference observation
  -> architecture note
  -> clean-room spec
  -> original interface
  -> original implementation
  -> tests
```

No direct path from reference code to implementation.

---

# 4. Naming Rule

Use Steven's product vocabulary, not the reference package vocabulary.

Examples:

| Reference-type concept | Goatmez name |
|---|---|
| Query loop | Mission Runtime |
| Tool system | Toolbelt |
| Permission layer | Approval Gate |
| Memory | War Room Memory |
| Task system | Mission Board |
| Agent/subagent | Operators |
| MCP layer | Connector Mesh |
| Context assembly | Context Compiler |
| Observability | Operations Ledger |

---

# 5. Implementation Stack

Recommended v1 stack:

- **Core runtime:** TypeScript/Node or Bun.
- **Dashboard:** Next.js.
- **API:** FastAPI or Node API.
- **Database:** Postgres.
- **Queue:** Redis + BullMQ or Celery.
- **Vector memory:** pgvector first, dedicated vector DB later.
- **MCP:** official MCP SDK.
- **Browser automation:** Playwright.
- **Auth:** Clerk/Auth.js or custom JWT for internal version.
- **Deployment:** Docker + DigitalOcean.

Steven's existing projects already use FastAPI, Next.js, Redis, and DigitalOcean, so this fits his ecosystem.

---

# 6. Build Order

## Phase 1 — Core Runtime

1. Agent profiles.
2. Context compiler.
3. Tool registry.
4. Permission gateway.
5. Event ledger.
6. Memory store.
7. Task engine.
8. CLI runner.

## Phase 2 — MCP Connector Mesh

1. MCP server registry.
2. MCP client manager.
3. Tool discovery.
4. Permission mapping.
5. OAuth/secrets handling.
6. Health checks.

## Phase 3 — Dashboard

1. Agent list.
2. Task board.
3. Tool logs.
4. Approval queue.
5. Memory browser.
6. MCP server manager.
7. Workspace settings.

## Phase 4 — Business Agents

1. Credit Plug.
2. Empire Architect.
3. Goatmez Media Content Agent.
4. SEO Hunter.
5. GHL Workflow Builder.
6. Facebook Marketplace Responder.
7. ECM Diagnostic Assistant.

---

# 7. Minimum Viable Agent OS

The MVP should do this:

```txt
Create agent
Assign tools
Send task
Compile context
Call model
Request tool
Ask approval if risky
Run tool
Save event log
Update task
Return result
```

That is the whole operating system in one loop.

---

# 8. Safety Profiles

Create permission profiles:

| Profile | Behavior |
|---|---|
| `read_only` | Can inspect files/data only |
| `draft_only` | Can draft but cannot send/change |
| `workspace_write` | Can modify files inside approved workspace |
| `approval_required` | Must ask before every action |
| `trusted_operator` | Can run approved tools automatically |
| `locked_down` | No tools, chat only |

For client work, default to `draft_only` or `approval_required`.

---

# 9. Original Agent Profiles

## Credit Plug

- Reads credit reports.
- Detects dispute opportunities.
- Drafts compliant letters.
- Does not file/send without approval.

## Empire Architect

- Turns ideas into plans.
- Creates task boards.
- Tracks open loops.
- Pushes daily execution.

## SEO Hunter

- Crawls websites.
- Identifies local SEO gaps.
- Drafts outreach.
- Builds audit reports.

## GHL Builder

- Drafts workflow maps.
- Uses browser automation or API connectors.
- Requires approval before publishing automations.

## ECM Diagnostic Assistant

- Organizes VIN/module data.
- Explains diagnostic steps.
- Generates shop notes.
- Avoids unsafe vehicle instructions without confirmation.

---

# 10. Immediate Next Build Target

Create the starter repo with:

```txt
goatmez-agent-os/
  src/core/agentRuntime.ts
  src/core/contextCompiler.ts
  src/core/toolRegistry.ts
  src/core/permissionGateway.ts
  src/core/eventLedger.ts
  src/core/memoryStore.ts
  src/core/taskEngine.ts
  src/core/mcpConnectorMesh.ts
  src/tools/fileTools.ts
  src/tools/shellTool.ts
  src/agents/defaultAgents.ts
  src/cli.ts
```

This repo should be original and runnable.
