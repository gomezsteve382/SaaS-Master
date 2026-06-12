# Agent OS Extraction Part 17 — LLM Planner + MCP Runtime Build

## What was built

This pack upgrades Goatmez Agent OS from a static demo runtime into a working v2 agent runtime.

The runtime now has:

- dynamic planner interface,
- OpenAI Responses API planner adapter,
- local rule-based fallback planner,
- multi-step agent loop,
- tool observation feedback loop,
- approval-aware tool execution,
- MCP connector mesh,
- stdio / HTTP / SSE style MCP connection support,
- MCP tool discovery,
- MCP tool registration as local runtime tools,
- CLI flags for agent selection, dry runs, approvals, and MCP config.

## Core architecture

```txt
User Mission
  -> CLI
  -> Agent Runtime
  -> Context Compiler
  -> Planner
      -> OpenAI Responses Planner if OPENAI_API_KEY exists
      -> Rule-Based Fallback Planner otherwise
  -> Tool Registry
  -> Permission Gateway
  -> Tool Execution
      -> Local Tool
      -> MCP Tool
  -> Event Ledger
  -> Task Engine
  -> Final Response
```

## Important clean-room boundary

The v2 repo is original code. It does not copy source from the reference package. It implements architecture-level patterns in a new codebase with new module names, new interfaces, and new implementation details.

## Planner contract

The planner returns one JSON action at a time:

```json
{
  "action": "respond | call_tool | finish",
  "thought": "brief operator note",
  "message": "final/respond text",
  "toolName": "tool name for call_tool",
  "input": {}
}
```

The planner only chooses. The runtime executes. This separation matters because it prevents the model from granting itself authority.

## Permission model

High-risk tools such as `file.write` and `shell.run` are blocked unless the request is explicitly approved. The CLI currently supports a development flag:

```bash
npm run dev -- --approve-all "write hello boss to notes/test.md"
```

Production should replace this with a real approvals dashboard.

## MCP model

MCP servers are configured in:

```txt
config/mcp.servers.json
```

The example lives at:

```txt
config/mcp.servers.example.json
```

Discovered MCP tools are converted into local runtime tools with this naming convention:

```txt
mcp.<serverId>.<toolName>
```

MCP tools default to approval-required.

## Validation performed

The v2 repo was tested with:

```bash
npm install --ignore-scripts
npm run typecheck -- --pretty false
npm run dev -- "inspect this workspace"
npm run dev -- "write hello boss to notes/test.md"
npm run dev -- --approve-all "write hello boss to notes/test.md"
```

Results:

- TypeScript typecheck passed.
- Workspace inspection worked in fallback mode.
- File write was blocked without approval.
- File write succeeded with explicit approval.

## Next build target

Part 18 should add the first dashboard layer:

- Next.js admin dashboard,
- live event log view,
- pending approvals screen,
- task list,
- agent selector,
- MCP server status panel.
