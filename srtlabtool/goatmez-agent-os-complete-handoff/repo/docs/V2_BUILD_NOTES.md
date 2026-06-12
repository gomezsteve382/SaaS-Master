# Goatmez Agent OS v2 Build Notes

## Clean-room boundary

This repo is original code written from architecture-level specs. It is not a line-by-line translation or redistribution of any reference package.

## Planner contract

The planner returns one JSON decision at a time:

```json
{
  "action": "respond | call_tool | finish",
  "thought": "brief operator note",
  "message": "text when action is respond or finish",
  "toolName": "tool name when action is call_tool",
  "input": {}
}
```

The runtime decides whether the tool call is allowed. This keeps model reasoning separate from operational authority.

## MCP contract

MCP servers are declared in `config/mcp.servers.json`. Enabled servers are connected at startup. Their tools are discovered and registered into the local tool registry using this naming pattern:

```txt
mcp.<serverId>.<toolName>
```

All MCP tools default to approval-required unless the config says otherwise.

## Approval model

The CLI currently supports a coarse `--approve-all` flag for development. Production should replace that with:

- persistent approval records,
- per-tool review screens,
- user identity/audit records,
- scoped approvals with expiration,
- replay protection.

## Why direct HTTP for OpenAI

The OpenAI planner adapter uses `fetch` against the Responses API directly so the repo does not depend on a specific OpenAI SDK version. It expects the model to return strict JSON and validates the resulting action before runtime execution.
