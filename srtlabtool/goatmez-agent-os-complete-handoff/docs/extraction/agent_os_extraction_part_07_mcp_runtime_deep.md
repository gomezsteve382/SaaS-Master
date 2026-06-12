# Goatmez Agent OS Extraction — Part 07: MCP Runtime Deep Dive

## Safety note
This is a clean-room architecture extraction. It explains MCP runtime patterns without copying proprietary source.

## Executive summary
MCP is the adapter layer that lets an agent talk to outside systems as tools. The observed repo treats MCP servers as first-class tool providers with connection states, transport types, auth handling, resources, prompts, tool normalization, permission integration, and dynamic reconnect/toggle behavior.

For Goatmez Agent OS, MCP is how your agents get hands:

```text
Gmail MCP
Calendar MCP
GHL MCP
Browser MCP
Filesystem MCP
Postgres MCP
Stripe MCP
Facebook MCP
Credit Report MCP
Vehicle/ECM MCP
```

---

## MCP server lifecycle

Observed connection states:

```text
pending
connected
failed
needs-auth
disabled
```

Clean-room state machine:

```text
configured
→ pending
→ connected
→ failed
→ pending retry
→ connected

configured
→ pending
→ needs_auth
→ auth_completed
→ pending
→ connected

connected
→ disabled
→ pending reconnect
```

---

## MCP config model

Observed config supports multiple transports:

- `stdio`
- `sse`
- `http`
- `ws`
- `sdk`
- IDE-specific SSE/WS
- Reference System.ai proxy-style config

Clean-room config:

```ts
type McpServerConfig =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string,string> }
  | { type: 'http'; url: string; headers?: Record<string,string>; oauth?: OAuthConfig }
  | { type: 'sse'; url: string; headers?: Record<string,string>; oauth?: OAuthConfig }
  | { type: 'ws'; url: string; headers?: Record<string,string> }
  | { type: 'sdk'; name: string }
```

### Scope
Observed scopes include:

- local
- user
- project
- dynamic
- enterprise/managed
- plugin-provided

Clean-room scopes:

```text
user       = available to user across projects
project    = saved to current project
workspace  = company/team managed
session    = temporary runtime injection
plugin     = installed package owns it
agent      = only available to specific agent
```

---

## MCP client object

A connected server should expose:

```ts
type ConnectedMcpServer = {
  name: string
  status: 'connected'
  client: McpClient
  capabilities: ServerCapabilities
  serverInfo?: { name: string; version: string }
  instructions?: string
  config: ScopedMcpServerConfig
  cleanup(): Promise<void>
}
```

Failed/disabled/needs-auth records should preserve config so reconnect can happen without losing settings.

---

## Tool discovery

MCP server connection flow:

1. Start transport.
2. Initialize MCP client.
3. Read server capabilities.
4. List tools.
5. Normalize tool names.
6. Convert MCP tools into internal Tool objects.
7. List resources if supported.
8. List prompts/commands if supported.
9. Merge tools into the runtime tool pool.
10. Filter by permissions.

---

## Tool name normalization

MCP servers may expose names that collide with built-ins or contain invalid characters. The repo normalizes and builds names like:

```text
mcp__serverName__toolName
```

Clean-room naming rule:

```text
Internal name: mcp.<server>.<tool>
Model-safe name: mcp__server__tool
Display name: Server: Tool
```

Keep original server/tool names in metadata:

```ts
type McpToolInfo = {
  serverName: string
  originalToolName: string
  normalizedToolName: string
}
```

---

## MCP tool wrapper

An MCP tool becomes an internal Tool with:

- Name.
- Description.
- Input JSON Schema.
- Permission check.
- Call function.
- Result mapper.
- UI renderer.
- MCP metadata passthrough.

Clean-room wrapper:

```ts
function wrapMcpTool(server, toolDef): Tool {
  return {
    name: `mcp__${safe(server.name)}__${safe(toolDef.name)}`,
    isMcp: true,
    mcpInfo: { serverName: server.name, toolName: toolDef.name },
    inputJSONSchema: toolDef.inputSchema,
    async call(input, ctx) {
      return server.client.callTool(toolDef.name, input)
    }
  }
}
```

---

## MCP permission integration

MCP tools should not bypass normal tool permissions.

Permission rule targets:

```text
MCP server-level:
mcp__gmail
mcp.gmail.*

Specific tool:
mcp__gmail__send_email
mcp.gmail.send_email

Pattern:
mcp.gmail.send_email(to:*@trusted-domain.com)
```

Recommended default policy:

```text
MCP read/list/search tools: allow or ask depending on sensitivity.
MCP write/update/create tools: ask.
MCP send/delete/payment tools: ask every time unless explicit trusted workflow.
MCP auth/admin tools: deny unless manually enabled.
```

---

## MCP resources

MCP resources are not tools; they are readable items exposed by a server.

Examples:

```text
file://docs/brand-guide
crm://contact/123
calendar://event/abc
repo://pull-request/42
```

Clean-room design:

- `ListMcpResourcesTool`
- `ReadMcpResourceTool`
- Resource cache.
- Resource permission rules.
- Resource previews in dashboard.

---

## MCP prompts/commands

MCP servers can expose prompts. The repo appears to map server prompts into commands in some cases.

Clean-room concept:

```text
MCP prompt = reusable workflow starter.
Example: /gmail-draft-followup, /crm-update-lead, /seo-audit-site
```

For Goatmez Agent OS, MCP prompts become workflow templates.

---

## Auth handling

Observed patterns:

- OAuth config.
- Callback port.
- Auth metadata URL.
- Needs-auth status.
- Auth error thrown from tool call layer.
- Keychain/cache clearing.
- Step-up detection.

Clean-room auth flow:

```text
Tool call returns 401/auth error
→ mark server needs_auth
→ create auth request
→ notify dashboard
→ user completes OAuth
→ reconnect server
→ retry optionally
```

Store secrets outside normal config:

- OS keychain for desktop.
- Encrypted DB secret vault for server.
- Environment variables for deployment.

Never place OAuth tokens in agent-visible context.

---

## Transport strategy

### stdio
Best for local tools.

Examples:

- Local filesystem.
- Local browser controller.
- Local OCR/PDF parser.
- Local vehicle diagnostic bridge.

### HTTP/SSE
Best for hosted APIs.

Examples:

- GHL.
- Gmail gateway.
- Calendar gateway.
- Stripe.
- Search service.

### WebSocket
Best for live streaming/control.

Examples:

- Browser session.
- Remote desktop.
- Realtime voice.

### SDK
Best for in-process tools.

Examples:

- Internal task control.
- Database adapter.
- File/artifact store.

---

## Goatmez MCP server list

### Priority 1: Core business tools

```text
mcp.gmail
- search_email
- read_email
- create_draft
- send_email [ask]
- archive_email [ask]

mcp.calendar
- list_events
- create_event [ask]
- update_event [ask]

mcp.ghl
- search_contact
- update_contact [ask]
- create_opportunity [ask]
- add_note
- trigger_workflow [ask]
```

### Priority 2: Agent OS tools

```text
mcp.files
- list_files
- read_file
- write_file [ask]
- edit_file [ask]

mcp.browser
- open_page
- scrape_page
- click [ask]
- fill_form [ask]

mcp.db
- query_readonly
- insert [ask]
- update [ask]
- delete [deny/default]
```

### Priority 3: Steven-specific empire tools

```text
mcp.credit_report
- parse_pdf
- detect_negative_items
- detect_fcra_issues
- generate_dispute_letter

mcp.seo
- crawl_site
- audit_local_seo
- generate_pitch

mcp.ecm
- decode_vcap
- vin_compare
- module_report
```

---

## MCP registry database

```sql
mcp_servers
- id
- name
- scope
- type
- config_json
- enabled
- status
- created_at
- updated_at

mcp_tools
- id
- server_id
- original_name
- normalized_name
- description
- input_schema_json
- is_read_only
- is_destructive
- discovered_at

mcp_auth_states
- id
- server_id
- status
- oauth_provider
- token_secret_ref
- expires_at

mcp_resources
- id
- server_id
- uri
- name
- mime_type
- metadata_json
```

---

## Clean-room MCP manager interface

```ts
interface McpManager {
  connect(serverName: string): Promise<McpConnection>
  disconnect(serverName: string): Promise<void>
  reconnect(serverName: string): Promise<McpConnection>
  listTools(serverName: string): Promise<Tool[]>
  listResources(serverName: string): Promise<McpResource[]>
  callTool(serverName: string, toolName: string, input: unknown): Promise<McpResult>
  markNeedsAuth(serverName: string, error: AuthError): Promise<void>
}
```

---

## Dashboard features

MCP page should show:

- Server name.
- Status.
- Transport.
- Tool count.
- Resource count.
- Last connected.
- Auth status.
- Toggle enabled/disabled.
- Reconnect button.
- Permission profile.
- Test tool call.

---

## Rebuild checklist

1. Define MCP config schemas.
2. Build MCP server registry.
3. Implement stdio transport.
4. Implement HTTP/SSE transport.
5. Connect and list tools.
6. Wrap MCP tools into internal Tool objects.
7. Add MCP permission matching.
8. Add needs-auth handling.
9. Add dashboard status panel.
10. Add per-agent MCP injection.
11. Add resource list/read tools.
12. Add hosted GHL/Gmail/Calendar MCP servers.

---

## Takeaway
MCP is the plugboard. Agents become powerful when each one gets the exact tools it needs, no more and no less. Goatmez Agent OS should treat MCP servers like controlled business weapons: registered, permissioned, logged, and assigned to specific agents.
