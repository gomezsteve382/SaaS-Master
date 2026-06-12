# Agent OS Extraction Part 12 — Context, Prompt, Message, and Token Runtime Deep Dive

## Boundary
This document is a clean-room architecture extraction. It does not reproduce source code, proprietary prompts, private constants, or line-by-line logic from the reference package. It converts observed module organization into an original rebuild spec for **Goatmez Agent OS**.

---

# 1. Why This Layer Matters

The context/prompt runtime is the part that turns a normal chat app into a serious agent platform.

A model does not simply receive the user's latest message. A mature agent runtime builds a structured input bundle that may include:

- System identity and operating policy.
- Developer/runtime instructions.
- Active project context.
- Open task state.
- Previous conversation messages.
- Memory snippets.
- Tool availability.
- MCP server capabilities.
- Safety and permission mode.
- Token budget constraints.
- Output style preferences.
- Pending interrupts or continuation state.

In Goatmez Agent OS, this layer becomes the **Context Compiler**.

It should answer one question before every model call:

> What does this agent need to know right now, and what must be kept out?

---

# 2. Observed Architectural Areas

The reference package separates this concern across several areas:

- Query runtime modules.
- Message transition modules.
- Token budget utilities.
- Context React providers.
- Message mappers.
- System initialization utilities.
- Memory extraction services.
- Settings and output style loaders.
- Tool prompt fragments.
- Agent prompt fragments.
- Skill prompt fragments.

Clean-room takeaway: **do not hardcode one giant prompt.** Build a prompt/context pipeline made from composable blocks.

---

# 3. Clean-Room Context Compiler Pattern

## 3.1 Core contract

Create a context compiler that receives a runtime request:

```txt
ContextCompileRequest
- user_message
- session_id
- agent_id
- workspace_id
- active_task_id?
- permission_mode
- enabled_tools[]
- enabled_mcp_servers[]
- memory_scopes[]
- output_style
- max_context_tokens
```

It returns:

```txt
CompiledContext
- system_blocks[]
- developer_blocks[]
- history_messages[]
- memory_blocks[]
- tool_definitions[]
- mcp_definitions[]
- task_state_block?
- final_user_message
- estimated_tokens
- excluded_items[]
- warnings[]
```

This makes context construction testable and inspectable.

---

# 4. Context Block Hierarchy

A strong agent OS should build context using priority tiers.

| Priority | Block type | Can be dropped? | Purpose |
|---|---|---:|---|
| P0 | Safety/runtime policy | No | Permission boundaries, dangerous actions, data handling |
| P1 | Agent identity | No | What this agent is and how it behaves |
| P2 | Active task state | Usually no | What job is underway |
| P3 | Tool/MCP definitions | Conditionally | What actions the model can request |
| P4 | Recent conversation | Conditionally | Immediate continuity |
| P5 | Project memory | Conditionally | Repo/business context |
| P6 | Long-term memory | Conditionally | Stable preferences and facts |
| P7 | Helpful examples | Yes | Style examples, few-shots, optional references |

Clean rebuild rule: when context is too large, drop from the bottom upward and record what was dropped.

---

# 5. Token Budget Strategy

## 5.1 Budget categories

Instead of one global budget, split budget by section:

| Section | Suggested default |
|---|---:|
| Runtime policy | 5–10% |
| Agent identity | 5% |
| Tools and MCP schemas | 20–35% |
| Recent messages | 25–40% |
| Memory | 10–20% |
| Task artifacts | 10–20% |
| Reserved output budget | Always reserved separately |

## 5.2 Budget algorithm

Clean-room algorithm:

1. Reserve output tokens first.
2. Insert required policy blocks.
3. Insert active task and latest user message.
4. Insert enabled tool definitions.
5. Insert most recent messages until the history budget is full.
6. Insert ranked memory snippets.
7. Insert optional style/examples only if room remains.
8. Produce an audit trail of excluded context.

## 5.3 Why audit trails matter

When an agent gives a bad answer, you need to know whether it failed because:

- The model reasoned poorly.
- The wrong tool was enabled.
- Memory was missing.
- The wrong context got pruned.
- The active task state was stale.

Context audit logs turn mystery failures into fixable engineering problems.

---

# 6. Message Transition Pattern

A mature runtime treats conversation messages as state transitions, not just chat bubbles.

## 6.1 Message types

Goatmez Agent OS should model at least:

- `user_message`
- `assistant_message`
- `tool_request`
- `tool_result`
- `permission_request`
- `permission_decision`
- `task_event`
- `system_event`
- `memory_event`
- `error_event`
- `summary_event`

## 6.2 Transition rules

Example transition rules:

| Current event | Valid next events |
|---|---|
| user_message | assistant_message, tool_request, permission_request |
| tool_request | permission_request, tool_result, error_event |
| permission_request | permission_decision |
| permission_decision approved | tool_result |
| permission_decision denied | assistant_message, error_event |
| assistant_message | user_message, task_event, summary_event |

This prevents broken runs where the model asks for tools that never resolve or permission decisions that never map back to the pending action.

---

# 7. System Prompt Construction Pattern

## 7.1 Avoid one prompt to rule them all

For Goatmez Agent OS, split prompt construction into named blocks:

```txt
/agents/{agent_id}/identity.md
/policies/runtime.md
/policies/tool-use.md
/policies/permissions.md
/workspaces/{workspace_id}/project-context.md
/styles/{style_id}.md
/skills/{skill_id}/instructions.md
```

Then compile them into a single ordered context package at runtime.

## 7.2 Prompt block metadata

Each block should have metadata:

```txt
PromptBlock
- id
- scope: global | workspace | agent | skill | task
- priority
- token_estimate
- version
- source_path
- enabled_when
```

This lets you debug prompt behavior like software.

---

# 8. Memory Retrieval Pattern

## 8.1 Ranking signals

Use memory retrieval that ranks by:

- semantic similarity to the current task,
- recency,
- user-pinned importance,
- agent-specific relevance,
- workspace relevance,
- verified vs unverified memory status.

## 8.2 Memory injection limits

Never dump all memory into the prompt. Inject only the minimum useful memory.

Suggested rule:

- 3–8 memories for normal tasks.
- 10–15 for large planning tasks.
- 0 for privacy-sensitive or fresh-user contexts unless needed.

---

# 9. Tool Definition Injection Pattern

The model should only see tools that are available for the current context.

Example filters:

- Agent role.
- Workspace permissions.
- Current permission mode.
- User approval status.
- Connected MCP server health.
- Risk score of the requested task.

This prevents the model from planning around tools it cannot actually use.

---

# 10. Clean-Room Interfaces

## 10.1 Context compiler

```ts
export interface ContextCompiler {
  compile(input: ContextCompileRequest): Promise<CompiledContext>;
}
```

## 10.2 Context providers

```ts
export interface ContextProvider {
  id: string;
  priority: number;
  collect(input: ContextCompileRequest): Promise<ContextBlock[]>;
}
```

## 10.3 Token manager

```ts
export interface TokenBudgeter {
  fit(blocks: ContextBlock[], budget: TokenBudget): BudgetedContext;
}
```

---

# 11. Goatmez Agent OS Rebuild Requirements

## Must build first

1. Context compiler.
2. Message event store.
3. Basic token estimator.
4. Memory provider.
5. Tool definition provider.
6. Task state provider.
7. Context audit logger.

## Should build later

1. Semantic token-aware summarizer.
2. Workspace context indexer.
3. Skill context provider.
4. Automatic stale context detector.
5. Context replay debugger.

---

# 12. First Implementation Target

The first version should support this flow:

```txt
User sends task
  -> runtime loads agent profile
  -> context compiler loads policy + memory + enabled tools
  -> permission gateway filters risky tools
  -> LLM receives compiled context
  -> LLM returns assistant message or tool request
  -> event store records transition
```

This is enough to power a real v1 agent.

---

# 13. What We Are Rebuilding, Not Copying

We are rebuilding these concepts in original form:

- Context providers.
- Prompt block composition.
- Message state transitions.
- Token budget enforcement.
- Memory injection.
- Tool definition gating.
- Context audit logs.

We are not copying proprietary source, prompts, comments, constants, or unique implementation details.
