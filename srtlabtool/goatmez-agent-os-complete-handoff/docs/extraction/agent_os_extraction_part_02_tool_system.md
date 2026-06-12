# Goatmez Agent OS Extraction — Part 02: Tool System

## Legal / Clean-Room Boundary

The source package is labeled as unlicensed/reference, so this extraction does **not** reproduce implementation code. This document captures architecture, concepts, responsibilities, and a rebuild plan for an original Goatmez Agent OS tool layer.

---

## 1. What the Tool System Is

The tool system is the agent runtime's hands. The model does not directly touch the computer, files, web, MCP servers, browser, or task engine. Instead, it emits a structured tool call. The runtime validates it, checks permissions, executes the tool, captures progress/results, then returns a normalized result back into the conversation loop.

In practical terms, the tool layer is the difference between a chatbot and an operating agent.

**Core idea:** every capability is wrapped as a typed, permission-aware, UI-renderable tool.

---

## 2. Tool Lifecycle

A complete tool call follows this path:

1. **Model chooses tool** based on tool name, description, prompt contribution, and JSON/Zod schema.
2. **Runtime parses streamed arguments** as the model produces them.
3. **Input validation** verifies shape, required fields, path safety, command safety, or mode restrictions.
4. **Permission check** decides whether to allow, deny, prompt user, auto-approve, or modify input.
5. **Execution** runs the actual operation.
6. **Progress events** stream back to the UI while the tool runs.
7. **Result mapping** converts internal output into model-facing tool result blocks.
8. **UI rendering** shows readable terminal/dashboard output.
9. **Context mutation** optionally updates session state, memory, file cache, tasks, or messages.
10. **Next loop** sends the result back to the LLM so it can continue.

Clean-room rebuild pattern:

```text
LLM tool_use
  -> ToolRegistry.find(name)
  -> Tool.validate(input)
  -> PermissionGateway.authorize(tool, input, context)
  -> ToolRunner.execute(tool, input)
  -> ResultStore.persist_if_large(result)
  -> Conversation.append(tool_result)
  -> Continue agent loop
```

---

## 3. Tool Object Contract

The tool contract has these conceptual fields:

| Field | Purpose |
|---|---|
| `name` | Stable canonical tool name used by the model/runtime |
| `aliases` | Backward-compatible names |
| `description()` | Dynamic explanation of what the tool does |
| `inputSchema` | Strict parameter validation, usually Zod-style object schema |
| `inputJSONSchema` | Direct JSON schema for MCP/dynamic tools |
| `call()` | Actual execution function |
| `validateInput()` | Tool-specific validation before permission |
| `checkPermissions()` | Tool-specific approval requirements |
| `isEnabled()` | Feature/environment gating |
| `isReadOnly()` | Marks safe reads vs mutations |
| `isDestructive()` | Marks irreversible actions |
| `isConcurrencySafe()` | Whether parallel calls are safe |
| `interruptBehavior()` | Cancel vs block if user interrupts |
| `prompt()` | Tool-specific system prompt instructions |
| `renderToolUseMessage()` | UI display for invocation |
| `renderToolResultMessage()` | UI display for result |
| `toAutoClassifierInput()` | Compact security-classifier representation |
| `mapToolResultToToolResultBlockParam()` | Converts internal output to LLM-facing result |
| `maxResultSizeChars` | Prevents huge outputs from bloating context |
| `mcpInfo` | Original MCP server/tool identity for external tools |
| `shouldDefer` / `alwaysLoad` | Tool-search / prompt-cache optimization flags |

The clean-room takeaway: **tools must be self-describing, self-validating, permission-aware, and UI-aware.**

---

## 4. ToolUseContext: What Every Tool Receives

A tool receives a session context object that gives access to runtime services. It includes:

| Context Area | What It Enables |
|---|---|
| Current command registry | Tools can access slash commands or command metadata |
| Debug/verbose flags | Different behavior for normal vs debug mode |
| Active model config | Tool behavior can adjust to model/session type |
| Available tools | Tools can inspect or delegate to other tools |
| MCP clients/resources | Tools can invoke external MCP servers/resources |
| Non-interactive mode | Allows CLI/SDK behavior without prompts |
| Agent definitions | Sub-agent tools can spawn named agents |
| System prompt overrides | Custom/append system prompt handling |
| Abort controller | Safe cancellation |
| File state cache | Avoid stale reads and detect file changes |
| App state getter/setter | Session state, task registry, UI state |
| Notifications | UI/OS-level alerts |
| Elicitation handler | MCP auth/URL flow support |
| Tool JSX renderer | Terminal UI component injection |
| Memory trigger state | Avoid duplicate memory/context injection |

Clean-room design:

```text
ToolContext = {
  session,
  permissions,
  filesystem,
  mcp,
  memory,
  tasks,
  ui,
  logger,
  abortSignal,
  userMode,
}
```

---

## 5. Tool Registry

The registry is the source of truth for all built-in capabilities. It combines:

1. **Base built-in tools**
2. **Feature-gated tools**
3. **Environment-gated internal tools**
4. **MCP tools loaded at runtime**
5. **Filtered tools based on permission deny rules**
6. **Deferred tools hidden behind tool search**

The registry also has a “simple mode” that reduces tools to a minimal set, usually shell/read/edit only.

Clean-room architecture:

```text
ToolRegistry
  - register(tool)
  - registerMcpTool(serverName, tool)
  - getVisibleTools(permissionContext)
  - filterByDenyRules()
  - filterByMode(simple, plan, readonly, noninteractive)
  - sortForPromptCacheStability()
  - dedupeByName(builtInsWin)
```

---

## 6. Always-Available Core Tools

The repo's documented and observed core tool families include:

### File System

| Tool Family | Purpose | Goatmez Equivalent |
|---|---|---|
| File Read | Read text/images/PDF/notebooks with limits | `file.read` |
| File Write | Create/overwrite files | `file.write` |
| File Edit | Precise search/replace edits | `file.edit` |
| Glob | File discovery by pattern | `file.glob` |
| Grep | Content search | `file.grep` |
| Notebook Edit | Modify notebook cells | optional later |
| Todo Write | Structured todo/task scratchpad | `task.todo.write` |

### Shell / Execution

| Tool Family | Purpose | Goatmez Equivalent |
|---|---|---|
| Bash | Run shell commands | `shell.run` |
| PowerShell | Windows shell support | optional later |
| REPL | Sandboxed code execution wrapper | `code.repl` later |

### Agent / Orchestration

| Tool Family | Purpose | Goatmez Equivalent |
|---|---|---|
| Agent | Spawn sub-agent | `agent.spawn` |
| Send Message | Agent-to-agent messaging | `agent.message` |
| Team Create/Delete | Parallel teams/swarms | `team.create`, `team.delete` |
| Plan Mode | Separate plan from execution | `mode.plan.enter/exit` |
| Worktree | Isolated code workspace | `workspace.enter/exit` |
| Synthetic Output | Structured output helper | `output.structured` |

### Task Engine

| Tool Family | Purpose | Goatmez Equivalent |
|---|---|---|
| Task Create | Start background task | `task.create` |
| Task Update | Update task metadata/status | `task.update` |
| Task Get/List | Inspect task state | `task.get`, `task.list` |
| Task Output | Retrieve completed output | `task.output` |
| Task Stop | Cancel/stop running task | `task.stop` |

### Web / External

| Tool Family | Purpose | Goatmez Equivalent |
|---|---|---|
| Web Fetch | Fetch a URL | `web.fetch` |
| Web Search | Search web | `web.search` |
| MCP Tool | Invoke external MCP tools | `mcp.call` |
| MCP Resource List/Read | Discover/read MCP resources | `mcp.resources.list/read` |
| MCP Auth | Handle MCP auth | `mcp.auth` |
| Tool Search | Discover deferred tools | `tool.search` |
| LSP | Code intelligence | `code.lsp` |
| Skill | Execute installed skill | `skill.run` |

---

## 7. Feature-Gated Tool Pattern

The repo uses feature flags and environment checks to decide whether tools load. Examples of gated categories:

| Gate Type | Example Capability |
|---|---|
| User/internal gate | REPL, internal config, experimental tools |
| Feature flag | proactive sleep, browser, monitor, workflow scripts, cron triggers |
| Env var | LSP tool, verify-plan tool, simple mode |
| Platform check | PowerShell availability |
| Test mode | testing-only permission tool |

Clean-room rebuild:

```ts
interface FeatureFlags {
  enableBrowser: boolean
  enableMcp: boolean
  enableTasks: boolean
  enableLsp: boolean
  enableCron: boolean
  enableTeams: boolean
  enableDangerousTools: boolean
}
```

No tool should be globally available just because it exists. It must pass feature, permission, and environment filters.

---

## 8. Permission Model Inside Tool System

The tool layer is deeply tied to permissions.

Permission inputs include:

- current permission mode
- additional allowed working directories
- always-allow rules
- always-deny rules
- always-ask rules
- bypass availability
- auto mode availability
- dangerous stripped rules
- no-prompt mode for background agents
- plan-mode restoration state

Permission modes observed/documented:

| Mode | Behavior |
|---|---|
| default | Ask for risky actions |
| plan | Plan first, execute after approval |
| bypass | Approve everything, dangerous |
| auto | Classifier/hooks decide |

Clean-room permission return values should include:

```text
allow(input)
deny(reason)
ask(prompt, choices)
modify_and_allow(updatedInput)
```

---

## 9. Tool Result Handling

A good agent cannot dump unlimited output into context. The repo uses:

- max result size per tool
- result previews
- persistent storage for oversized outputs
- separate UI rendering vs model-facing content
- search-text extraction for transcript search
- structured metadata for MCP SDK consumers

Clean-room implementation:

```text
ToolResult = {
  ok: boolean,
  data: unknown,
  display: UiBlock,
  modelContent: ToolResultBlock,
  persistedPath?: string,
  metadata?: object,
  newMessages?: Message[],
  contextPatch?: ContextPatch
}
```

---

## 10. Concurrency / Interrupt Design

Tools declare whether they are concurrency-safe. Default should be **not safe**.

Examples:

- Read/search tools can usually run in parallel.
- File writes/edits should usually be serialized.
- Shell commands depend on command semantics.
- Background tasks should not mutate the same state concurrently.

Interrupt behavior:

| Behavior | Meaning |
|---|---|
| cancel | Stop the tool when user sends a new message |
| block | Let tool finish; queue user input |

Clean-room scheduler:

```text
ToolRunner
  - queue unsafe tools
  - parallelize safe reads/searches
  - attach AbortSignal
  - record progress events
  - enforce timeout/resource limits
```

---

## 11. Security Lessons From Specific Tool Families

### Bash/Shell

The shell tool is the highest-risk primitive. It requires:

- command parsing
- destructive command detection
- path validation
- read-only mode validation
- sandbox decisioning
- security classifier input
- permission prompts
- timeout management

Goatmez v1 should **not** start with unrestricted shell. Use command allowlists first.

### File Edit / Write

File mutation should require:

- exact path validation
- workspace boundary check
- diff preview
- user approval for overwrite
- rollback history
- audit log

### Web Fetch / Search

Web tools should be read-only by default but still controlled:

- domain allow/deny rules
- citation/provenance tracking
- content length limits
- no hidden credential forwarding

### Agent Spawn

Sub-agents need reduced permissions by default:

- bounded tool list
- bounded budget
- no user-prompt dependency unless interactive
- inherited but restricted memory
- parent-child logging

---

## 12. Goatmez Agent OS Tool System v1

### Minimum Viable Tool Set

Start with these 12:

1. `file.read`
2. `file.write`
3. `file.edit`
4. `file.search`
5. `shell.run.safe`
6. `web.fetch`
7. `web.search`
8. `mcp.call`
9. `mcp.resources.list`
10. `agent.spawn`
11. `task.create`
12. `task.status`

### Database Tables

```sql
agents(id, name, role, system_prompt, allowed_tools, created_at)
tools(id, name, type, schema_json, is_enabled, risk_level)
tool_runs(id, agent_id, tool_name, input_json, status, output_ref, started_at, finished_at)
permissions(id, agent_id, tool_name, rule_type, pattern, created_at)
tasks(id, parent_agent_id, title, status, assigned_agent_id, output_ref, created_at)
artifacts(id, task_id, path, mime_type, size_bytes, sha256, created_at)
```

### Backend Services

```text
ToolRegistryService
PermissionGateway
ToolRunner
McpBridgeService
TaskService
ArtifactStore
AuditLogger
```

### API Endpoints

```http
GET    /tools
POST   /tools/{name}/validate
POST   /tools/{name}/run
GET    /tool-runs/{id}
POST   /permissions/rules
GET    /agents/{id}/tools
POST   /agents/{id}/tools
```

---

## 13. Rebuild Pseudocode

```ts
type Tool<I, O> = {
  name: string
  description: string
  schema: JsonSchema
  risk: 'read' | 'write' | 'destructive' | 'external'
  concurrency: 'safe' | 'exclusive'
  validate(input: unknown): I
  authorize(input: I, ctx: ToolContext): Promise<AuthDecision>
  run(input: I, ctx: ToolContext): Promise<O>
  render?(output: O): UiBlock
}
```

```ts
async function runTool(name: string, rawInput: unknown, ctx: ToolContext) {
  const tool = registry.get(name)
  const input = tool.validate(rawInput)
  const decision = await permissionGateway.authorize(tool, input, ctx)

  if (decision.type === 'deny') throw new Error(decision.reason)
  if (decision.type === 'ask') return await ui.promptForApproval(decision)

  const run = await audit.startToolRun(ctx.agentId, name, input)
  try {
    const output = await scheduler.execute(tool, decision.input ?? input, ctx)
    return await results.finalize(run.id, output)
  } catch (err) {
    await audit.failToolRun(run.id, err)
    throw err
  }
}
```

---

## 14. What To Build Next

Part 03 should extract the **MCP layer**, because MCP is how this becomes a real agent platform instead of a closed tool bundle.

The next clean-room deliverable should include:

- MCP client architecture
- MCP server config format
- tool wrapping for MCP tools
- resource list/read system
- auth/elicitation flow
- local stdio server pattern
- remote HTTP/SSE server pattern
- Goatmez MCP server templates for GHL, Gmail, Calendar, CRM, files, browser, and databases
