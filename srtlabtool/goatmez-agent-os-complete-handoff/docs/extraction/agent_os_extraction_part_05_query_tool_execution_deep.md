# Goatmez Agent OS Extraction — Part 05: Query + Tool Execution Deep Dive

## Safety note
This is a clean-room architecture extraction. It explains patterns, flow, and rebuild strategy without copying proprietary source.

## Executive summary
The core runtime is an event loop around model calls and tool calls. The pattern is:

```text
User input
→ process/normalize context
→ build system prompt + tools
→ call model stream
→ collect assistant/tool_use blocks
→ execute tools with permissions
→ append tool_result messages
→ call model again if needed
→ repeat until final answer or limit
```

The big insight: the model does not “run tools.” The runtime does. The model requests tool calls; the orchestrator validates, permissions, executes, records, and feeds results back.

---

## Main actors

### QueryEngine
Represents one conversation/session lifecycle. It owns:

- Mutable conversation messages.
- File-read cache.
- Total usage/cost tracking.
- Abort controller.
- Permission denials.
- Skill discovery tracking.
- Loaded nested memory paths.
- Submit-message turn lifecycle.

Clean-room equivalent:

```ts
class AgentSession {
  messages: Message[]
  usage: UsageLedger
  fileCache: FileStateCache
  abortController: AbortController
  permissionDenials: PermissionDenial[]

  async *submit(input: UserInput): AsyncGenerator<SessionEvent> {}
}
```

### query loop
This is the lower-level generator that streams model events and tool events.

Responsibilities:

- Prepare model request.
- Stream partial assistant messages.
- Detect tool_use blocks.
- Start streaming tool execution when enabled.
- Handle fallback/retry.
- Enforce context/token limits.
- Handle compaction.
- Run stop hooks.
- Emit final answer.

### Tool executor
Executes tool calls after or during model streaming.

Two modes observed:

1. Batch execution after assistant message completes.
2. Streaming execution as tool_use blocks arrive.

---

## Message model

Clean-room message categories:

```text
UserMessage
AssistantMessage
ToolUseBlock
ToolResultBlock
ProgressMessage
AttachmentMessage
SystemMessage
TombstoneMessage
ToolUseSummaryMessage
```

Key design rule: every tool use ID must have a matching tool result. Orphaned tool calls break follow-up model calls.

---

## Turn lifecycle in detail

### 1. Receive user input
Input may be text or structured content blocks.

Preprocessing can include:

- Slash command parsing.
- File attachments.
- Image attachments.
- Memory injection.
- Working directory context.
- Plugin/skill expansion.
- System/user context augmentation.

### 2. Build process input context
The runtime creates a context object with everything tools need:

- Tool list.
- Commands.
- MCP clients.
- Agent definitions.
- Permission context.
- App state getter/setter.
- File cache.
- Abort controller.
- Notification callbacks.
- UI callbacks.
- Session metadata.

Clean-room equivalent:

```ts
type ToolUseContext = {
  sessionId: string
  agentId?: string
  tools: ToolRegistry
  mcpClients: MCPClientRegistry
  permissionContext: PermissionContext
  memory: MemoryContext
  appState: AppStateStore
  abort: AbortController
  emitProgress(event: ProgressEvent): void
}
```

### 3. Compose system prompt
The system prompt is assembled from stable parts:

- Base assistant identity.
- Tool instructions.
- Environment details.
- Project memory.
- Agent-specific instructions.
- User-provided append/custom prompt.
- Mode-specific restrictions.

The repo cares about prompt-cache stability. Tool ordering and prompt byte stability are treated as performance features.

### 4. Call model
The runtime passes:

- Messages.
- System prompt.
- Tool schemas.
- Thinking config.
- Model choice.
- MCP tool info.
- Agent definitions.
- Permission mode info.
- Budget/turn limits.

The model streams back content blocks.

### 5. Collect tool calls
When a content block of type `tool_use` arrives:

- Store it in the current assistant message.
- Track ID/name/input.
- Optionally start execution immediately if streaming tool execution is on.
- Backfill observable inputs for transcripts without mutating API-bound input.

Clean-room rule: never mutate the exact object that will be used for prompt-cache-sensitive replay.

### 6. Streaming fallback handling
If the stream falls back/retries, partial messages are tombstoned and tool executions from the failed stream are discarded.

Clean-room equivalent:

```text
If stream attempt invalidates partial response:
  mark old assistant chunks as tombstoned
  discard in-progress tool results
  reset tool_use list
  retry model call
```

### 7. Tool execution
Each tool call goes through:

```text
find tool
→ validate schema
→ validate input
→ permission check
→ pre-tool hooks
→ execute
→ post-tool hooks
→ map result to tool_result
→ persist huge output if needed
→ render/update UI
→ record transcript
```

### 8. Continue if needed
If any tool calls were executed, append tool results and call the model again.

Loop stops when:

- No tool_use blocks appear.
- Max turns reached.
- Abort requested.
- Budget reached.
- Stop hook blocks continuation.
- Fatal API/tool error.

---

## Tool concurrency model

The repo has a smart execution strategy:

- Tools declare whether they are concurrency-safe for a given input.
- Consecutive safe tools can run in parallel.
- Unsafe tools run serially.
- Context modifiers from tools are queued/applied carefully.
- Max concurrency is capped by environment config.

Clean-room implementation:

```ts
function partitionToolCalls(calls: ToolCall[]): ToolBatch[] {
  // group consecutive read-only/concurrency-safe calls
}

for (const batch of batches) {
  if (batch.concurrent) runAllWithLimit(batch.calls)
  else runSerial(batch.calls)
}
```

### What should be concurrency-safe?

Usually safe:

- File reads.
- Grep/search.
- Glob/list.
- Web fetch/search.
- Read-only MCP calls.

Usually unsafe:

- File writes/edits.
- Shell commands that mutate state.
- Sending emails/texts.
- Database writes.
- CRM updates.
- Anything with side effects.

---

## StreamingToolExecutor pattern

This is one of the strongest architectural ideas.

It tracks each tool as:

```text
id
block
assistant message
status: queued | executing | completed | yielded
isConcurrencySafe
promise
results
pendingProgress
contextModifiers
```

### Behavior

- Starts safe tools immediately if possible.
- Blocks unsafe tools until no other tools are running.
- Buffers results so output order matches tool request order.
- Emits progress as it happens.
- Cancels sibling tools when a parallel tool errors.
- Produces synthetic tool errors for discarded/interrupted tools.

### Clean-room version

```ts
class StreamingExecutor {
  addTool(call: ToolCall): void
  private canExecute(call): boolean
  private processQueue(): Promise<void>
  async *remainingResults(): AsyncGenerator<ToolExecutionEvent>
  discard(): void
}
```

---

## Tool result storage

The repo has a max-result-size concept. Large tool results can be persisted externally and replaced with a preview/path.

Clean-room rule:

```text
If tool output > threshold:
  store full output in artifact/blob table
  return concise preview + artifact reference to model
```

Recommended thresholds:

- Shell output: 50k chars.
- Search output: 20k chars.
- File read: self-bounded by line/byte ranges.
- MCP response: 30k chars.
- Browser scrape: summarize first, store full page.

---

## Abort/interruption model

The runtime uses abort controllers at multiple levels:

- Session abort.
- Tool sibling abort.
- Child agent abort.
- Background task kill.

Clean-room design:

```text
SessionAbortController
  ├── ModelRequestAbort
  ├── ToolBatchAbort
  │    ├── ToolCallAbort
  │    └── SiblingAbort
  └── ChildAgentAbort
```

If a user interrupts:

- Cancel cancellable tools.
- Let block-mode tools finish or safely terminate.
- Return synthetic rejected tool_result for consistency.

---

## Cost and budget controls

Observed runtime tracks:

- Usage per model call.
- Total API duration.
- Total cost.
- Max budget.
- Max turns.
- Context blocking limit.
- Auto-compaction.

Clean-room budget policy:

```text
session.maxTurns
session.maxCostUsd
session.maxTokens
workflow.maxRuntimeSeconds
agent.maxToolCalls
agent.maxConsecutiveFailures
```

---

## Tool-use summaries

After a batch of tools, the runtime can generate a short summary of tool activity for UI/continuation.

Clean-room version:

```text
Tool batch summary:
- Read 3 files
- Edited 1 file
- Ran tests, 2 failed
- Next step: fix failing import
```

This is valuable for dashboards and mobile views.

---

## Goatmez Agent OS execution loop

### Minimal v1 loop

```ts
while (turns < maxTurns) {
  const response = await model.complete({messages, tools, system})
  messages.push(response.assistantMessage)

  const toolCalls = extractToolCalls(response)
  if (toolCalls.length === 0) break

  for await (const event of executor.run(toolCalls)) {
    emit(event)
    if (event.type === 'tool_result') messages.push(event.message)
  }
}
```

### Production v2 loop

Add:

- Streaming tool execution.
- Concurrency grouping.
- Permission queue.
- Hook system.
- Output storage.
- Cost tracking.
- Compaction.
- Background tasks.
- Session replay.

---

## Rebuild checklist

1. Define message types.
2. Define tool call/result types.
3. Build basic model loop.
4. Add tool registry.
5. Add permission service.
6. Add serial executor.
7. Add concurrency-safe batching.
8. Add streaming executor.
9. Add progress events.
10. Add output persistence.
11. Add session storage/replay.
12. Add budget and max-turn controls.
13. Add compaction.
14. Add dashboard event stream.

---

## Takeaway
The “agent magic” is mostly disciplined orchestration. The model proposes actions, but the runtime controls reality. Goatmez Agent OS should be built around that principle: model creativity inside a strict execution cage.
