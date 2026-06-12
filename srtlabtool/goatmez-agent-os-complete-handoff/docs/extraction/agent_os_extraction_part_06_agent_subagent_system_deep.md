# Goatmez Agent OS Extraction — Part 06: Agent + Subagent System Deep Dive

## Safety note
Clean-room architecture extraction only. No proprietary implementation should be copied.

## Executive summary
The Agent tool turns the main assistant into a dispatcher. Instead of one model doing everything, the runtime can spawn specialized agents with their own prompts, tools, permissions, memory, model choice, working directory, and execution mode.

This is the blueprint for Goatmez Agent OS: one Commander, many operators.

---

## Agent definition model

Observed agent definitions include fields like:

- Agent type/name.
- When-to-use description.
- Tool allowlist.
- Tool denylist.
- Skills to preload.
- MCP servers required or injected.
- Hooks.
- Color/UI metadata.
- Model override.
- Effort level.
- Permission mode.
- Max turns.
- Source: built-in, user, project, policy, plugin.
- Background behavior.
- Initial prompt.
- Memory scope.
- Isolation mode.
- Critical reminder.

Clean-room schema:

```ts
type AgentDefinition = {
  id: string
  name: string
  description: string
  whenToUse: string
  systemPrompt: string
  tools?: string[]
  disallowedTools?: string[]
  mcpServers?: AgentMcpSpec[]
  skills?: string[]
  model?: 'fast' | 'smart' | 'cheap' | string
  effort?: 'low' | 'medium' | 'high'
  permissionMode?: PermissionMode
  maxTurns?: number
  memoryScope?: 'none' | 'session' | 'project' | 'user'
  background?: boolean
  isolation?: 'same_workspace' | 'worktree' | 'remote'
  hooks?: HookDefinition[]
}
```

---

## Agent sources and precedence

Observed source groups:

- Built-in agents.
- Plugin agents.
- User settings agents.
- Project settings agents.
- Flag agents.
- Managed/policy agents.

The runtime resolves active agents by merging groups and letting later groups override earlier groups by agent type.

Clean-room precedence suggestion:

1. Built-in defaults.
2. Plugin agents.
3. User agents.
4. Project agents.
5. Workspace/org managed agents.

For company systems, managed policy should be able to disable or constrain agents.

---

## Built-in agent archetypes

Observed built-in names suggest these categories:

- General purpose agent.
- Explore/research agent.
- Plan agent.
- Verification agent.
- Statusline/setup helper.
- Reference System-code guide agent.

Goatmez versions:

```text
Commander          — routes work and decomposes missions
Research Scout     — searches, reads, summarizes
Builder            — writes code/files
Verifier           — runs tests/checks
CRM Operator       — updates GHL/CRM records
Inbox Operator     — triages/drafts email
Sales Closer       — drafts follow-ups and offers
Compliance Analyst — reviews credit/legal docs
Content Producer   — creates posts/scripts/assets
SEO Hunter         — audits websites and creates pitches
```

---

## Agent tool input

Observed Agent tool supports:

- Description.
- Prompt.
- Subagent type.
- Model override.
- Run in background.
- Name/team fields for multi-agent addressing.
- Permission mode.
- Isolation mode.
- CWD override.

Clean-room input:

```ts
type SpawnAgentInput = {
  description: string
  prompt: string
  agentType?: string
  model?: string
  runInBackground?: boolean
  name?: string
  teamName?: string
  permissionMode?: PermissionMode
  cwd?: string
  isolation?: 'worktree' | 'remote'
}
```

---

## Agent execution flow

### Step 1 — Select agent definition
If `agentType` is missing, default to general-purpose.

Then:

- Confirm agent exists.
- Confirm not denied by permissions.
- Confirm required MCP servers are available.
- Confirm allowed agent types if a policy restricts them.

### Step 2 — Build child context
Child agent inherits selected parent context but can override:

- System prompt.
- Tool set.
- Permission mode.
- Model.
- Effort.
- CWD.
- Memory scope.
- MCP clients.
- Max turns.

### Step 3 — Filter tools
Agent tools are filtered by:

- Agent allowlist.
- Agent denylist.
- Global permission deny rules.
- Async/background constraints.
- Coordinator/worker mode constraints.

### Step 4 — Create prompt/messages
The child receives:

- Agent system prompt.
- Environment details.
- Task prompt.
- Optional initial prompt.
- Optional parent context/messages.
- Optional memory snapshot.

### Step 5 — Execute child query loop
The child runs the same model/tool loop as the main session, but with child context.

### Step 6 — Return summarized result
The parent receives a tool result containing:

- Final response.
- Status.
- Partial results if failed/interrupted.
- Task ID if background.
- Metadata: model, turns, cost, tool calls.

---

## Background agents

Observed behavior includes local agent tasks, remote agent tasks, progress tracking, notifications, kill/stop operations, output files, and background registration.

Clean-room background agent states:

```text
pending
running
waiting_for_approval
completed
failed
killed
```

Background task record:

```ts
type AgentTask = {
  id: string
  agentId: string
  sessionId: string
  description: string
  status: TaskStatus
  startedAt: Date
  endedAt?: Date
  outputArtifactId?: string
  progressSummary?: string
  pendingApprovalId?: string
}
```

---

## Agent isolation

Observed isolation options include worktree and remote. Clean-room strategy:

### Same workspace
Fastest. Good for read-only or low-risk agents.

### Worktree isolation
Create a temporary git worktree for coding agents. Allows edits without touching main working copy until approved.

### Remote isolation
Run in a container/VM/sandbox. Best for risky builds, untrusted repos, or long-running tasks.

Goatmez implementation path:

1. Same workspace for v1.
2. Docker workspace copy for v2.
3. Git worktree for code projects.
4. Remote DigitalOcean runner later.

---

## Agent MCP injection

Observed agent definitions can reference existing MCP servers or define inline MCP servers.

Clean-room pattern:

```ts
type AgentMcpSpec =
  | { ref: string }
  | { name: string; config: McpServerConfig }
```

Use cases:

- Gmail Agent gets Gmail MCP only.
- Calendar Agent gets Calendar MCP only.
- SEO Agent gets Browser/Search MCP.
- CRM Agent gets GHL MCP.
- Credit Agent gets document parser + CRM + email draft MCP.

---

## Agent memory

Observed memory scopes include user/project/local and snapshot behavior.

Clean-room memory design:

```text
Session memory: temporary conversation state.
Project memory: project rules, repo notes, brand instructions.
User memory: stable preferences and identity.
Agent memory: lessons learned by a specific agent type.
Workflow memory: state for recurring automations.
```

Agent memory should be permissioned. A Sales Agent should not automatically read private legal memory unless granted.

---

## Multi-agent/team behavior

Observed hints include teammate tasks, send-message tool, named agents, teams, coordinator mode, and worker permissions.

Clean-room team pattern:

```text
Commander creates team:
- Research Scout
- Builder
- Verifier

Commander sends tasks.
Workers return progress.
Commander combines final output.
```

Message routing:

```ts
type AgentMessage = {
  from: AgentId
  to: AgentId | 'team' | 'commander'
  content: string
  requiresResponse: boolean
}
```

---

## Goatmez Agent OS recommended default agents

### 1. Commander
Mission planner. No direct dangerous tools. Delegates.

Tools:

- Spawn agent.
- Read task state.
- Ask user.
- Create plan.

### 2. Research Scout
Reads/searches only.

Tools:

- Web search.
- File read.
- Browser fetch.
- Notes writer only to research artifacts.

### 3. Builder
Writes files/code.

Tools:

- File read/write/edit.
- Shell limited to dev commands.
- Git status/diff.

Requires approval for destructive shell.

### 4. Verifier
Runs tests and audits.

Tools:

- Shell test commands.
- File read.
- Static analysis.

### 5. Business Operator
Handles Gmail, calendar, CRM drafts.

Tools:

- Gmail draft, not send by default.
- Calendar read/create with approval.
- GHL update with approval.

### 6. Credit Plug Agent
Credit repair workflow agent.

Tools:

- PDF parser.
- Violation detector.
- Letter generator.
- CRM updater.
- Email draft.

No sending/filing without approval.

---

## Rebuild checklist

1. Create `agents/` registry with JSON/Markdown definitions.
2. Build `AgentDefinition` loader.
3. Merge built-in/project/user agents.
4. Add Agent tool schema.
5. Build child context generator.
6. Implement tool filtering per agent.
7. Implement background task table.
8. Add progress events.
9. Add task stop/kill.
10. Add agent memory scopes.
11. Add MCP per-agent injection.
12. Add worktree/container isolation.
13. Add team messaging.

---

## Takeaway
This is the “factory that creates bots.” The Agent tool is how one assistant becomes a company of specialized workers. Goatmez Agent OS should make this visual, permissioned, and tied to real business workflows.
