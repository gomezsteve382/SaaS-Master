# Agent OS Extraction Part 14 — Settings, Config, Feature Flags, and Policy Layer Deep Dive

## Boundary
Clean-room extraction only. This document describes system design patterns and original rebuild requirements.

---

# 1. Why This Layer Matters

The settings/config/policy layer is the difference between a toy agent and a controllable product.

Without it, every behavior is hardcoded.
With it, you can change:

- model selection,
- permission mode,
- enabled tools,
- enabled MCP servers,
- workspace trust,
- output style,
- memory behavior,
- cost limits,
- team policies,
- experimental features,
- security restrictions.

For Goatmez Agent OS, this layer becomes the **Control Plane**.

---

# 2. Observed Areas

The reference package separates config concerns across:

- runtime settings utilities,
- settings validation,
- managed settings,
- permission validation,
- tool validation,
- migration scripts,
- feature flag services,
- output style loaders,
- MCP config readers,
- package/build flags,
- server-side auth and policy modules.

Clean-room takeaway: config is not one file. It is layered.

---

# 3. Config Layering Model

Goatmez Agent OS should support layered config in this order:

| Priority | Source | Example |
|---:|---|---|
| 1 | System enforced policy | Disable dangerous tools globally |
| 2 | Team/org policy | Agency-wide approval rules |
| 3 | Workspace config | Project-specific MCP servers |
| 4 | Agent config | Credit Plug has CRM tools enabled |
| 5 | User settings | Output style, default model |
| 6 | Session overrides | Temporary safe mode |
| 7 | CLI/runtime flags | `--no-network`, `--debug` |

Highest priority wins.

---

# 4. Clean-Room Settings Schema

## 4.1 Global settings

```ts
GlobalSettings
- default_model
- default_permission_mode
- telemetry_enabled
- memory_enabled
- max_monthly_cost
- allowed_mcp_servers[]
- blocked_tools[]
- approved_workspaces[]
```

## 4.2 Workspace settings

```ts
WorkspaceSettings
- workspace_id
- root_paths[]
- trusted: boolean
- enabled_agents[]
- enabled_tools[]
- enabled_mcp_servers[]
- default_output_style
- environment_profile
```

## 4.3 Agent settings

```ts
AgentSettings
- agent_id
- name
- role
- model
- tools[]
- memory_scopes[]
- permission_profile
- max_steps
- max_cost_per_task
```

---

# 5. Feature Flags

Feature flags let you ship safely.

## 5.1 Flag categories

| Category | Examples |
|---|---|
| UI flags | new dashboard view, terminal panel |
| Runtime flags | planner v2, context compiler v2 |
| Tool flags | enable browser tool, enable shell tool |
| MCP flags | enable remote MCP auth |
| Safety flags | stricter command classifier |
| Business flags | agency white-label mode |

## 5.2 Flag evaluation

Evaluate flags by:

- environment,
- user/org,
- workspace,
- agent,
- risk mode,
- version.

---

# 6. Policy Layer

Settings say what the user wants.
Policy says what the system allows.

## 6.1 Policy examples

- A user may want shell access, but policy requires approval.
- An agent may request network calls, but policy blocks unknown domains.
- A workspace may enable file writing, but policy restricts paths.
- A client-facing agent may draft emails but not send them automatically.

## 6.2 Policy decision shape

```ts
PolicyDecision
- allowed: boolean
- requires_approval: boolean
- reason
- policy_id
- risk_level
- conditions[]
```

---

# 7. Migrations

Any serious agent OS needs migrations because settings evolve.

## 7.1 Migration contract

```ts
Migration
- id
- description
- applies_to_version
- run(settings): updated_settings
```

## 7.2 Why it matters

When you change permission modes, model names, or tool schemas, old workspaces should not break.

---

# 8. Validation

Every config file should be validated before use.

Validation catches:

- unknown tool names,
- invalid permission modes,
- paths outside workspace,
- disabled MCP servers,
- invalid model IDs,
- missing secrets,
- bad JSON/YAML.

---

# 9. Output Styles

Output style should be configurable but bounded.

For Steven's ecosystem, examples:

- `frank`: direct, strategic, no fluff.
- `operator`: step-by-step execution mode.
- `sales_general`: persuasive sales/copy mode.
- `legal_careful`: citation-heavy compliance mode.
- `builder`: code/spec focused.

Output styles are prompt blocks, not random personality toggles.

---

# 10. Goatmez Agent OS Control Plane V1

Build first:

1. `settings.schema.ts`
2. `settings.loader.ts`
3. `settings.merger.ts`
4. `policy.engine.ts`
5. `featureFlags.ts`
6. `migrations/`
7. `outputStyles/`
8. `workspace.config.json`
9. `agent.config.json`

---

# 11. Admin Dashboard Requirements

The dashboard should let Steven control:

- Agents.
- Tools.
- MCP servers.
- Permission profiles.
- Memory scopes.
- Cost limits.
- Logs.
- Approval queues.
- Feature flags.
- Client/workspace configs.

This turns the agent stack into a sellable platform, not just a CLI.
