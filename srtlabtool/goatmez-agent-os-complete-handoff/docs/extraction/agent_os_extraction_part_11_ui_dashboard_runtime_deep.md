# Goatmez Agent OS Extraction — Part 11: UI, Terminal, and Runtime Surfaces Deep Dive

## Clean-room notice
This document extracts architecture patterns only. It does not reproduce proprietary source, hidden prompts, secret algorithms, or implementation text from the uploaded repository.

## What this layer does
The inspected repository has multiple user surfaces, including terminal UI components, command handlers, server/web areas, remote bridge modules, and UI components for tools, permissions, MCP, agents, memory, tasks, and settings.

The design lesson: an Agent OS should not be tied to one interface. The terminal, web dashboard, voice layer, mobile view, and API should all talk to the same runtime services.

## Surface architecture

```text
User Surface
  -> API/Command Adapter
  -> Runtime Services
  -> Agent Orchestrator
  -> Tool/Permission/MCP/Memory/Task systems
```

Surfaces should be thin. They should render and collect input. They should not contain core business logic.

## Recommended Goatmez surfaces

### 1. Web dashboard
Primary control center.

Views:
- Command Center home
- Agents
- Tasks
- Tools
- MCP Servers
- Permissions
- Memory
- Sessions
- Logs
- Settings
- Artifacts

### 2. Terminal CLI
Power-user mode.

Use cases:
- start a local session
- run an agent against a repo
- connect MCP servers
- inspect logs
- run diagnostics

### 3. Voice command layer
Fast execution layer.

Use cases:
- “Run the SEO agent on this website.”
- “Check today’s lead follow-ups.”
- “Create a Facebook post for JC’s tint.”
- “Launch Credit Plug on this credit report.”

### 4. API/webhook layer
Automation layer.

Use cases:
- GHL webhook triggers an agent task
- form submission starts lead qualification
- scheduled job creates reports
- external app launches workflow

## UI component system
A serious dashboard needs reusable blocks:

- AgentCard
- TaskCard
- ToolCallCard
- PermissionRequestModal
- MCPServerStatus
- MemoryRecordTable
- SessionTimeline
- ArtifactPreview
- CommandPalette
- RunLogViewer

## Permission UI pattern
Permission requests should be rich, not generic.

Different tool categories need different previews:

### File edit/write
Show:
- file path
- diff preview
- created/modified/deleted status
- allow once / allow always / deny

### Shell/browser action
Show:
- command/action
- risk level
- working directory/domain
- reason the agent wants it

### Email/SMS/CRM action
Show:
- recipient/contact
- message preview
- irreversible warning
- send now / save draft / deny

### MCP server connection
Show:
- server name
- transport type
- tools exposed
- permission scope requested

## Runtime event stream
The UI should subscribe to events rather than polling everything.

Event types:

```ts
export type RuntimeEvent =
  | { type: 'session.message'; sessionId: string; role: string; content: string }
  | { type: 'tool.started'; taskId: string; toolName: string; callId: string }
  | { type: 'tool.completed'; taskId: string; toolName: string; callId: string }
  | { type: 'permission.requested'; requestId: string; toolName: string }
  | { type: 'permission.resolved'; requestId: string; decision: 'allow' | 'deny' }
  | { type: 'task.status'; taskId: string; status: string }
  | { type: 'agent.status'; agentId: string; status: string };
```

## Dashboard information architecture

```text
/dashboard
  /agents
    /:agentId
  /tasks
    /:taskId
  /tools
    /:toolName
  /mcp
    /:serverId
  /permissions
  /memory
  /sessions
    /:sessionId
  /artifacts
  /settings
```

## Core dashboard pages

### Command Center Home
Show:
- active agents
- active tasks
- waiting permissions
- recent outputs
- quick launch workflows

### Agents Page
Show:
- agent roster
- tools assigned to each agent
- memory scope
- task history
- enable/disable toggle

### Tasks Page
Show:
- live task board
- progress
- result summaries
- errors
- approvals waiting

### MCP Page
Show:
- server list
- connection status
- exposed tools
- auth status
- trust level

### Permissions Page
Show:
- pending approvals
- recent denials
- allow/deny rules
- trusted workspaces/domains

### Tool Logs Page
Show:
- all tool calls
- inputs/outputs redacted where needed
- duration
- success/failure
- cost estimate

## API routes to build

```text
POST   /api/sessions
GET    /api/sessions/:id
POST   /api/sessions/:id/messages
GET    /api/sessions/:id/events

GET    /api/agents
POST   /api/agents
POST   /api/agents/:id/run

GET    /api/tasks
POST   /api/tasks
GET    /api/tasks/:id
POST   /api/tasks/:id/cancel

GET    /api/tools
POST   /api/tools/:name/call

GET    /api/mcp/servers
POST   /api/mcp/servers
POST   /api/mcp/servers/:id/connect
POST   /api/mcp/servers/:id/disconnect

GET    /api/permissions/pending
POST   /api/permissions/:id/resolve

GET    /api/memory
POST   /api/memory
DELETE /api/memory/:id
```

## UI tech recommendation

### Frontend
- Next.js
- React
- Tailwind
- shadcn/ui
- Zustand or TanStack Query
- Server-sent events or WebSocket for runtime stream

### Backend
- FastAPI or Node/NestJS
- Postgres
- Redis queue
- MCP client/service layer
- OpenAI/External Provider/local model adapters

## Terminal UI recommendation
Keep terminal simple at first:

```text
goat status
goat run "research this lead"
goat agents
goat mcp list
goat permissions
goat tasks
```

## Frank verdict
The UI is not the product. The runtime is the product. The UI is the war room window into the machine. Build the runtime clean first, then give it multiple control surfaces.
