# Agent OS Extraction Part 10 — Memory and Task Systems Deep Dive

## Boundary
This document extracts architectural patterns only. It does not reproduce proprietary source. The uploaded repository identifies itself as unlicensed/private, so this is a clean-room rebuild spec.

---

# 1. Why Memory and Tasks Matter

An agent without memory is just a chatbot.
An agent without tasks is just a conversation.

The memory/task layer turns a chat loop into an operating system:

- Memory stores what matters.
- Tasks let work continue beyond one message.
- Outputs become inspectable artifacts.
- Agents can coordinate work over time.
- The user can resume, review, stop, or redirect execution.

For Goatmez Agent OS, this is where your agents become employees.

---

# 2. Observed Areas

Relevant folders/files include:

- `src/services/SessionMemory/`
- `src/services/extractMemories/`
- `src/services/teamMemorySync/`
- `src/components/memory/`
- `src/commands/memory/`
- `src/utils/memory/`
- `src/tasks/`
- `src/Task.ts`
- `src/tasks.ts`
- `src/tools/TaskCreateTool/`
- `src/tools/TaskGetTool/`
- `src/tools/TaskListTool/`
- `src/tools/TaskOutputTool/`
- `src/tools/TaskStopTool/`
- `src/tools/TaskUpdateTool/`
- `src/components/tasks/`
- `src/commands/tasks/`

---

# 3. Memory Architecture Pattern

## Memory scopes

A mature agent system should separate memory by scope:

| Scope | Meaning | Example |
|---|---|---|
| Session memory | Current conversation state | Current goal, open files, active plan |
| Project memory | Workspace-specific facts | Repo conventions, environment setup |
| User memory | Stable user preferences | Brand voice, preferred stack |
| Agent memory | Individual specialist memory | Credit Plug remembers lead handling SOPs |
| Team memory | Shared across agent group | Campaign status, task board, client context |
| Organization memory | Admin-controlled company knowledge | SOPs, policies, compliance rules |

## Clean-room memory schema

```ts
export interface MemoryRecord {
  id: string;
  scope: "session" | "project" | "user" | "agent" | "team" | "org";
  ownerId?: string;
  agentId?: string;
  projectId?: string;
  key: string;
  value: string;
  tags: string[];
  source: "user" | "assistant" | "tool" | "import";
  confidence: number;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}
```

## Extraction pipeline

The repo has an extraction-oriented service area, which suggests this pipeline:

```txt
Conversation/Event -> Candidate Memory -> Classify -> Deduplicate -> Store -> Retrieve by Context
```

Clean rebuild:

1. Capture conversation events.
2. Detect stable facts and instructions.
3. Reject short-lived/trivial data.
4. Ask approval for sensitive memory.
5. Store structured record.
6. Retrieve memory by scope and relevance.
7. Inject into prompt or tool context.

---

# 4. Memory Retrieval Pattern

Recommended retrieval order:

```txt
1. Session state
2. Active task state
3. Agent profile
4. Project memory
5. Relevant vector search memories
6. User preferences
7. Org policies
```

Memory should not be dumped blindly into prompts. Use budgets:

```ts
interface MemoryBudget {
  maxRecords: number;
  maxTokens: number;
  includeScopes: MemoryScope[];
  excludeTags?: string[];
}
```

---

# 5. Task System Pattern

## What tasks do

Tasks are persistent units of work that can outlive a single LLM turn.

They need:

- ID
- title
- status
- owning agent
- created by
- input payload
- output stream
- logs
- tool calls
- permission checkpoints
- cancellation support
- artifact references

## Clean task states

```txt
queued -> running -> waiting_for_approval -> completed
                         |              -> failed
                         |              -> cancelled
                         -> blocked
```

## Clean-room task schema

```ts
export interface AgentTask {
  id: string;
  title: string;
  status: "queued" | "running" | "waiting_for_approval" | "blocked" | "completed" | "failed" | "cancelled";
  agentId: string;
  parentTaskId?: string;
  input: unknown;
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}
```

## Task event stream

Every task should produce append-only events:

```ts
type TaskEvent =
  | { type: "created"; taskId: string }
  | { type: "started"; taskId: string }
  | { type: "message"; role: "agent" | "tool" | "system"; content: string }
  | { type: "tool_call"; toolName: string; input: unknown }
  | { type: "permission_request"; requestId: string }
  | { type: "artifact"; path: string }
  | { type: "completed"; result: unknown }
  | { type: "failed"; error: string };
```

---

# 6. Task Tools

Observed task tools map directly to clean-room capabilities:

| Tool | Clean-room behavior |
|---|---|
| TaskCreate | Start a job |
| TaskUpdate | Change metadata/status |
| TaskGet | Retrieve details |
| TaskList | Show task queue |
| TaskOutput | Read output/logs/artifacts |
| TaskStop | Cancel/kill task |

For Goatmez Agent OS, these become the backbone of the dashboard.

---

# 7. Agent Worker Pattern

Recommended runtime:

```txt
Task Queue -> Worker -> Agent Runtime -> Tool Gateway -> Event Store -> Dashboard
```

Use:

- BullMQ/Redis for queueing.
- Postgres for task records.
- S3/local storage for artifacts.
- WebSockets/SSE for live updates.
- Permission gateway before risky tools.

---

# 8. Business Task Examples

## Credit Plug

```txt
Task: Qualify new lead
Steps:
1. Read lead form.
2. Ask qualifying questions.
3. Score readiness.
4. Draft SMS/email follow-up.
5. If qualified, create calendar booking prompt.
```

## GHL Workflow Builder

```txt
Task: Build campaign workflow
Steps:
1. Read campaign goal.
2. Generate sequence.
3. Request approval.
4. Use browser/API tools to create tags/actions/delays.
5. Save audit log.
```

## SEO Breakdown Bot

```txt
Task: Analyze local business website
Steps:
1. Crawl site.
2. Extract services/locations.
3. Score SEO basics.
4. Generate checklist.
5. Draft pitch email.
```

---

# 9. Rebuild Checklist

- [ ] Create `memory_records` table.
- [ ] Create `task_records` table.
- [ ] Create `task_events` table.
- [ ] Build memory extraction service.
- [ ] Build memory retrieval service.
- [ ] Build task queue.
- [ ] Build worker runtime.
- [ ] Build task tools.
- [ ] Build task dashboard.
- [ ] Add stop/cancel support.
- [ ] Add approval checkpoints.
- [ ] Add artifact storage.

## Key Takeaway
Memory gives the agent context. Tasks give the agent endurance. Together, they turn a one-off assistant into a controllable digital workforce.
