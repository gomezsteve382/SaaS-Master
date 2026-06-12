# Build Notes

## Clean-room status

This starter repo is original code. It was written from the extraction specs, not copied from the reference package.

## What to build next

### LLM planner adapter

Add a planner that converts a user task into one of:

- assistant response,
- tool call,
- task update,
- approval request.

### MCP connector mesh

Wire the official MCP SDK into `src/core/mcpConnectorMesh.ts`.

### Dashboard

Create a Next.js app that reads:

- event log,
- tasks,
- agents,
- approvals,
- memory,
- MCP status.

### Persistence

Replace in-memory stores with Postgres tables.
