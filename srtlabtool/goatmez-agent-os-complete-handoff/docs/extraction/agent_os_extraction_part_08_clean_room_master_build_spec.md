# Goatmez Agent OS — Clean-Room Master Build Spec

## Mission
Build a clean, original agent platform inspired by modern agent-runtime architecture patterns:

```text
Commander UI + Agent Runtime + Tool Registry + MCP Servers + Permission Gateway + Memory + Task Engine
```

No reference/proprietary source should be copied. This is an original implementation plan.

---

## Product name candidates

- Goatmez Agent OS
- Goatmez Command Center
- The Digital War Room OS
- Empire Architect Runtime
- Agent War Room

Recommended: **Goatmez Agent OS** for the platform, **Digital War Room** for the dashboard/community branding.

---

## System architecture

```text
Frontend Dashboard
  ↓
Backend API
  ↓
Agent Runtime
  ↓
Tool Registry
  ↓
Permission Gateway
  ↓
MCP Servers / Native Tools
  ↓
External Systems
```

Parallel services:

```text
Memory Service
Task Service
Event Stream
Audit Log
Artifact Store
Scheduler
Auth/RBAC
```

---

## Recommended stack

### Frontend

- Next.js
- React
- Tailwind
- shadcn/ui
- EventSource/WebSocket for live runs

### Backend

Option A: FastAPI + Python agent runtime.

Best for fast building, AI workflows, PDF parsing, automation.

Option B: Node/TypeScript runtime.

Best for MCP ecosystem alignment and full-stack TypeScript.

Recommended for Steven: **FastAPI backend + TypeScript MCP servers**. This gives you Python power for AI/PDF/automation and TypeScript for MCP integrations.

### Database

- Postgres
- pgvector
- Redis for queue/cache

### Workers

- Celery/RQ if Python.
- BullMQ if Node.

### Browser automation

- Playwright.

### Deployment

- DigitalOcean droplet or app platform.
- Docker Compose first.
- Kubernetes later only if needed.

---

## Core modules

### 1. Agent Runtime

Responsibilities:

- Own conversation state.
- Call model.
- Parse tool calls.
- Execute tools.
- Loop until completion.
- Track cost/turns.
- Stream events.

Files to build:

```text
backend/agents/runtime.py
backend/agents/session.py
backend/agents/messages.py
backend/agents/model_client.py
backend/agents/event_stream.py
```

### 2. Tool Registry

Responsibilities:

- Register native tools.
- Register MCP tools.
- Validate input schemas.
- Provide model-visible schemas.
- Filter tools by permission/agent.

Files:

```text
backend/tools/base.py
backend/tools/registry.py
backend/tools/native/files.py
backend/tools/native/web.py
backend/tools/native/tasks.py
backend/tools/mcp_adapter.py
```

### 3. Permission Gateway

Responsibilities:

- Evaluate every tool call.
- Apply rules.
- Create approval requests.
- Persist allow/deny choices.
- Log decisions.

Files:

```text
backend/permissions/types.py
backend/permissions/service.py
backend/permissions/rules.py
backend/permissions/path_safety.py
backend/permissions/shell_safety.py
backend/permissions/classifier.py
```

### 4. MCP Manager

Responsibilities:

- Store MCP server configs.
- Connect/reconnect.
- Discover tools/resources.
- Wrap tools into registry.
- Handle auth status.

Files:

```text
backend/mcp/config.py
backend/mcp/manager.py
backend/mcp/client.py
backend/mcp/tool_wrapper.py
backend/mcp/auth.py
```

### 5. Agent Registry

Responsibilities:

- Load built-in/custom agents.
- Merge definitions by precedence.
- Filter by policy.
- Spawn child agents.

Files:

```text
backend/agents/definitions.py
backend/agents/loader.py
backend/agents/spawn.py
backend/agents/builtin/*.yaml
```

### 6. Task Engine

Responsibilities:

- Run background agents.
- Track status/progress.
- Stop/kill tasks.
- Save output artifacts.

Files:

```text
backend/tasks/models.py
backend/tasks/runner.py
backend/tasks/queue.py
backend/tasks/artifacts.py
```

### 7. Memory Service

Responsibilities:

- Session memory.
- Project memory.
- Agent memory.
- Vector retrieval.
- Summaries/compaction.

Files:

```text
backend/memory/service.py
backend/memory/vector_store.py
backend/memory/summary.py
backend/memory/scopes.py
```

### 8. Dashboard

Pages:

```text
/dashboard
/agents
/sessions
/tasks
/approvals
/tools
/mcp
/memory
/workflows
/settings
```

---

## Database schema v1

```sql
users
workspaces
projects
agents
sessions
messages
tool_calls
tool_results
permission_rules
approval_requests
mcp_servers
mcp_tools
tasks
artifacts
memories
workflow_runs
audit_events
```

---

## Core runtime pseudocode

```python
async def run_turn(session_id: str, user_input: str):
    session = await load_session(session_id)
    context = await build_context(session)

    session.messages.append(UserMessage(user_input))

    for turn in range(session.max_turns):
        response = await model.stream(
            messages=session.messages,
            system=context.system_prompt,
            tools=context.visible_tools,
        )

        session.messages.append(response.assistant_message)
        yield AssistantEvent(response.assistant_message)

        tool_calls = response.tool_calls
        if not tool_calls:
            break

        async for event in tool_executor.run(tool_calls, context):
            yield event
            if event.type == 'tool_result':
                session.messages.append(event.message)

    await save_session(session)
```

---

## Tool interface v1

```python
class Tool(Protocol):
    name: str
    description: str
    input_schema: dict
    is_mcp: bool = False

    def is_read_only(self, input: dict) -> bool: ...
    def is_destructive(self, input: dict) -> bool: ...
    def is_concurrency_safe(self, input: dict) -> bool: ...
    async def validate(self, input: dict, ctx: ToolContext) -> ValidationResult: ...
    async def call(self, input: dict, ctx: ToolContext) -> ToolResult: ...
```

---

## Agent definition YAML

```yaml
id: credit_plug
name: Credit Plug
when_to_use: Analyze credit reports, find issues, draft dispute letters, update client workflows.
system_prompt: |
  You are Credit Plug, a careful credit repair operations agent...
tools:
  - file.read
  - credit_report.parse
  - credit_report.detect_violations
  - letter.generate
  - gmail.create_draft
  - ghl.add_note
disallowed_tools:
  - gmail.send_email
  - file.delete
permission_mode: default
memory_scope: project
max_turns: 12
background: false
```

---

## First 10 native tools to build

1. `file.read`
2. `file.write` with approval
3. `file.edit` with diff approval
4. `shell.run` with strict safety
5. `web.search`
6. `web.fetch`
7. `task.create`
8. `task.status`
9. `agent.spawn`
10. `ask_user`

---

## First 5 MCP servers to build

### 1. Gmail MCP

- Search emails.
- Read thread.
- Create draft.
- Send draft with approval.

### 2. Calendar MCP

- List events.
- Create event with approval.
- Update event with approval.

### 3. GHL MCP

- Search contact.
- Add note.
- Update opportunity.
- Trigger workflow with approval.

### 4. Browser MCP

- Open page.
- Scrape page.
- Extract links.
- Fill forms with approval.

### 5. Credit Report MCP

- Parse PDF.
- Extract accounts.
- Identify negative items.
- Generate dispute strategy.

---

## Approval policies

Default asks:

```text
send email
send SMS
delete/archive data
charge/refund money
post to social media
submit forms
update CRM status
run destructive shell
write outside workspace
trigger bulk workflows
```

Default allows:

```text
read uploaded files
search within workspace
draft email
draft social posts
create local artifact
read CRM/contact info if connected
read calendar availability
```

---

## Dashboard layout

### Command screen

- Chat with Commander.
- Tool activity timeline.
- Running agents sidebar.
- Pending approvals drawer.

### Agent screen

- Agent cards.
- Tool access.
- Permission mode.
- Memory scope.
- Last runs.

### MCP screen

- Server status.
- Tools discovered.
- Auth status.
- Toggle/reconnect.
- Test call.

### Approvals screen

- Pending action.
- Risk explanation.
- Input preview.
- Approve once.
- Approve always.
- Deny.
- Deny always.

---

## Milestone plan

### Milestone 1 — Runtime skeleton

- FastAPI app.
- Postgres models.
- Basic session/chat.
- Model call.
- No tools yet.

### Milestone 2 — Tool registry

- Tool interface.
- File read.
- Web fetch.
- Tool call loop.

### Milestone 3 — Permission gateway

- Rule engine.
- Approval queue.
- Dashboard approvals.

### Milestone 4 — Agent spawning

- Agent definitions.
- Agent tool.
- Child session runs.

### Milestone 5 — MCP

- MCP config.
- Connect one stdio server.
- Wrap tools.
- Permissions for MCP.

### Milestone 6 — Business integrations

- Gmail.
- Calendar.
- GHL.

### Milestone 7 — Credit Plug workflow

- PDF parser.
- Negative item extraction.
- Dispute letter drafting.
- CRM note.
- Email draft.

---

## Non-negotiable engineering rules

1. Every tool call gets logged.
2. Every side effect crosses permissions.
3. Every background task has a kill switch.
4. Every agent has a tool allowlist.
5. Every MCP server has status/auth tracking.
6. Model output never directly mutates external systems.
7. Sending/posting/deleting always requires approval until explicitly trusted.
8. Secrets never enter prompts.
9. Large outputs become artifacts.
10. Sessions are replayable.

---

## Takeaway
The clean-room rebuild is absolutely doable. The goal is not to clone another product. The goal is to build Steven’s business operating system: agents that can think, use tools, ask permission, remember, execute workflows, and report back from one command center.
