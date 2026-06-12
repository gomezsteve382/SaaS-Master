# Goatmez Agent OS Extraction — Part 03: MCP Layer

## Clean-Room Boundary

This is an architectural extraction only. It does not reproduce reference implementation code. It converts the observed design into an original blueprint for Goatmez Agent OS.

---

## 1. What MCP Does In This Architecture

MCP is the universal connector layer. Instead of hardcoding every integration inside the agent runtime, MCP lets external services expose:

- tools the agent can call
- resources the agent can read
- prompts/templates the agent can request
- auth flows the runtime can handle

This is how the system becomes expandable. Gmail, Calendar, GHL, browser, filesystem, databases, Slack, Stripe, and custom business systems can all become MCP servers.

**Clean-room principle:** built-in tools are the core muscles; MCP is the plug-in nervous system.

---

## 2. Two MCP Directions

The repo has both sides of MCP:

### A. MCP Client

The agent runtime connects outward to MCP servers and imports their tools/resources into the main tool registry.

```text
Agent Runtime -> MCP Client -> External MCP Server -> Tool/Resource
```

### B. MCP Server

The app can also expose its own capabilities as an MCP server so other clients can call it.

```text
External Client -> Goatmez MCP Server -> Goatmez Agent Tools
```

For Goatmez Agent OS, we need both.

---

## 3. MCP Transport Types

The architecture supports multiple connection styles:

| Transport | Use Case |
|---|---|
| `stdio` | Local tools launched as child processes |
| `http` | Remote streamable HTTP MCP servers |
| `sse` | Server-sent events style remote MCP |
| `ws` | WebSocket-based MCP servers |
| `sdk` | In-process SDK-provided server |
| IDE-specific transports | Editor extension connections |

Goatmez v1 should support:

1. `stdio` for local private tools
2. `http` for hosted business connectors
3. `sse` only if a vendor requires it

---

## 4. MCP Config Schema

The observed config model centers around an `mcpServers` map keyed by server name.

Clean-room config example:

```json
{
  "mcpServers": {
    "ghl": {
      "type": "http",
      "url": "https://mcp.yourdomain.com/ghl",
      "headers": {
        "Authorization": "Bearer ${GHL_MCP_TOKEN}"
      }
    },
    "local-files": {
      "type": "stdio",
      "command": "node",
      "args": ["./servers/files/dist/index.js"],
      "env": {
        "ROOT_DIR": "./workspace"
      }
    }
  }
}
```

Supported config fields:

| Field | Meaning |
|---|---|
| `type` | stdio/http/sse/ws/sdk |
| `command` | executable for local stdio server |
| `args` | command arguments |
| `env` | environment variables for local process |
| `url` | remote server URL |
| `headers` | static auth/custom headers |
| `headersHelper` | helper command that returns dynamic headers |
| `oauth` | OAuth configuration |
| `scope` | where the config came from: local/user/project/enterprise/plugin/etc. |

---

## 5. Config Scopes

The repo distinguishes server config origins. This matters because trust and permissions differ by source.

Observed scope concepts:

| Scope | Meaning |
|---|---|
| local | current working/project local config |
| user | user-level config |
| project | committed/shared project config |
| dynamic | runtime-injected config |
| enterprise | managed organization config |
| managed | policy-controlled config |
| plugin | provided by installed plugin/marketplace |
| remote/proxy | provided through hosted session/connector |

Goatmez v1 scope model:

```text
local        = developer machine only
workspace    = project/team shared
user         = Steven's personal tool config
business     = company-approved connectors
marketplace  = later third-party plugins
```

---

## 6. MCP Connection Lifecycle

The runtime should treat each MCP server as a state machine.

```text
discovered
  -> pending
  -> connected
  -> failed
  -> needs_auth
  -> disabled
```

Connection object responsibilities:

- hold MCP client instance
- store server name/type/capabilities
- store server instructions
- expose cleanup/disconnect
- track auth status
- track resources/tools/prompts
- recover from session expiration

Clean-room type:

```ts
type McpConnection =
  | { status: 'pending'; name: string; config: McpServerConfig }
  | { status: 'connected'; name: string; client: McpClient; capabilities: McpCapabilities }
  | { status: 'failed'; name: string; error: string }
  | { status: 'needs_auth'; name: string; authUrl?: string }
  | { status: 'disabled'; name: string }
```

---

## 7. How MCP Tools Enter the Main Tool Registry

Flow:

1. Load MCP configs.
2. Connect to each enabled server.
3. Ask server for available tools.
4. Normalize tool names.
5. Wrap each MCP tool as a normal runtime tool.
6. Attach `mcpInfo` containing original server/tool names.
7. Add permission and deny-rule support.
8. Merge with built-in tools.
9. Deduplicate by name, with built-ins winning.

Important pattern: MCP tools should be indistinguishable from built-in tools at call time, but internally they retain their server identity.

Clean-room naming:

```text
mcp__{serverName}__{toolName}
```

Example:

```text
mcp__ghl__create_contact
mcp__gmail__send_draft
mcp__calendar__find_availability
```

---

## 8. MCP Resource Tools

The system separates **tools** from **resources**.

Tools perform actions:

```text
create_contact, send_email, search_files
```

Resources expose readable items:

```text
crm://contacts/123
calendar://events/today
files://reports/client.pdf
```

Core MCP resource tools:

| Tool | Purpose |
|---|---|
| list resources | show resources exposed by MCP servers |
| read resource | fetch one specific resource |

Goatmez use cases:

- read CRM contact profile
- read latest lead notes
- read calendar events
- read uploaded documents
- read GHL workflows
- read SEO crawl results

---

## 9. MCP Auth / Elicitation

Remote connectors may require auth. The observed design includes:

- OAuth config
- auth server metadata URL
- callback port
- headers helpers
- auth-needed connection state
- elicitation handler for URL prompts/auth steps
- retry behavior after auth/session refresh

Goatmez v1 should support:

1. API key/bearer token headers
2. OAuth later
3. “needs auth” dashboard state
4. test connection button
5. per-server secrets stored encrypted

---

## 10. MCP Output Handling

MCP results can be text, JSON, image, binary, or resource links. The runtime needs to:

- sanitize output
- estimate size
- truncate when too large
- persist large/binary results to artifact storage
- convert images safely
- surface structured content to SDK/dashboard consumers
- preserve metadata on errors

Clean-room result pipeline:

```text
MCP result
  -> validate protocol shape
  -> sanitize unicode / unsafe fields
  -> estimate size
  -> persist large binaries
  -> truncate model-facing preview
  -> attach artifact links
  -> return to agent loop
```

---

## 11. Standalone MCP Server Pattern

The standalone MCP server sub-project has three clean architectural pieces:

| Piece | Purpose |
|---|---|
| shared server factory | Defines tools/resources once |
| stdio entrypoint | Local Reference System/Desktop/CLI use |
| HTTP/SSE entrypoint | Remote hosted use |

Clean-room server layout:

```text
servers/ghl-mcp/
  src/server.ts      # define tools/resources
  src/stdio.ts       # local transport
  src/http.ts        # hosted transport
  src/auth.ts        # API key/OAuth checks
  package.json
  Dockerfile
```

---

## 12. Goatmez MCP Server Roadmap

### Server 1: Files MCP

Tools:

- `search_files`
- `read_file`
- `write_file`
- `create_project_folder`
- `save_artifact`

Resources:

- `files://workspace/*`
- `artifacts://task/{id}`

### Server 2: GHL MCP

Tools:

- `search_contacts`
- `create_contact`
- `update_contact`
- `add_tag`
- `create_opportunity`
- `send_sms`
- `send_email`
- `create_workflow_task`

Resources:

- `ghl://contacts/{id}`
- `ghl://pipelines`
- `ghl://workflows`

### Server 3: Gmail MCP

Tools:

- `search_emails`
- `read_email`
- `draft_email`
- `send_email`
- `label_email`

Resources:

- `gmail://threads/{id}`
- `gmail://labels`

### Server 4: Calendar MCP

Tools:

- `search_events`
- `create_event`
- `update_event`
- `find_free_time`

Resources:

- `calendar://events/today`
- `calendar://availability/week`

### Server 5: Browser MCP

Tools:

- `open_page`
- `click`
- `type`
- `screenshot`
- `extract_text`
- `run_workflow`

High-risk; should require strict approvals.

### Server 6: Credit Repair MCP

Tools:

- `parse_credit_report`
- `detect_negative_items`
- `detect_possible_fcra_issues`
- `generate_dispute_letter_draft`
- `save_client_update`

Resources:

- `credit://clients/{id}/reports`
- `credit://letters/{id}`

---

## 13. Dashboard Requirements For MCP

The War Room dashboard should show:

- connected servers
- disconnected/failed servers
- tools exposed by each server
- resources exposed by each server
- auth status
- last successful ping
- last tool run
- permission rules per server/tool
- enable/disable switch
- test tool call UI
- logs and artifacts

---

## 14. MCP Security Rules

Minimum rules:

1. No MCP server gets dangerous permissions by default.
2. Remote MCP servers cannot access local files unless explicitly configured.
3. Browser/CRM/email tools require human approval for sends, deletes, payments, or irreversible actions.
4. Each server gets a scope and trust level.
5. Tool names must be normalized to prevent prompt/tool injection through names.
6. Results must be sanitized before entering the model context.
7. Secrets live outside prompts and logs.
8. Audit every tool call.

Risk categories:

| Risk | Examples | Default |
|---|---|---|
| read | search, list, read resource | allow with logs |
| write | create draft, update CRM note | ask once / policy-based |
| destructive | delete, overwrite, send, charge card | require approval |
| external comms | email/SMS/posting | require approval |
| credentialed browser | logged-in browser automation | strict approval |

---

## 15. Goatmez Implementation Plan

### Phase 1 — MCP Core

- Create MCP config loader
- Implement stdio connection
- Implement HTTP connection
- List tools from server
- Wrap MCP tools into local registry
- Call MCP tool and return normalized result
- Show MCP server status in dashboard

### Phase 2 — First Local Server

Build `files-mcp`:

- stdio transport
- file search/read only first
- project-root sandbox
- no write until permissions are done

### Phase 3 — Business Connectors

Build:

- GHL MCP
- Gmail MCP
- Calendar MCP
- browser MCP

### Phase 4 — Plugin Marketplace

Later:

- install server package
- validate manifest
- scope permissions
- show trust warning
- enable/disable per agent

---

## 16. Original Goatmez MCP Type Sketch

```ts
type McpServerConfig =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> }

type WrappedMcpTool = Tool & {
  origin: 'mcp'
  serverName: string
  remoteToolName: string
  trustLevel: 'local' | 'business' | 'third_party'
}
```

```ts
async function wrapMcpTool(server, remoteTool): Promise<WrappedMcpTool> {
  return {
    name: `mcp__${server.name}__${remoteTool.name}`,
    description: remoteTool.description,
    schema: remoteTool.inputSchema,
    risk: classifyRisk(remoteTool),
    async run(input, ctx) {
      return await server.client.callTool(remoteTool.name, input)
    }
  }
}
```

---

## 17. Next Extraction

Part 04 should cover the **Permission System**, because MCP and tools are only safe if every action flows through a strong approval/rule engine.
