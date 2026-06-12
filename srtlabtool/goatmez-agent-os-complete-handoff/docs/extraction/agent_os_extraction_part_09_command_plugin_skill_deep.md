# Agent OS Extraction Part 09 — Command, Plugin, and Skill Systems Deep Dive

## Boundary
This is an architecture extraction, not a source-code republication. The uploaded package is marked `UNLICENSED` and its package metadata says `private: true`, so this document extracts design patterns, module responsibilities, and clean-room rebuild requirements only.

## What This Layer Does
The command/plugin/skill layer is the human-facing control surface of the agent runtime.

It lets the user:

1. Type slash commands.
2. Install or reload extensions.
3. Activate reusable skill packs.
4. Change runtime settings.
5. Trigger workflows that may call the LLM, tools, MCP servers, local scripts, or UI dialogs.

In a clean rebuild, this layer becomes the **Operator Console API**.

---

## 1. Command System Pattern

### Observed locations

- `src/commands.ts`
- `src/commands/`
- `src/commands/*/index.ts`
- `src/commands/*/*.tsx`
- `src/components/HelpV2/`
- `src/screens/REPL.tsx`

### Functional role

Commands are user-invoked control actions. They are not the same as tools.

A **tool** is something the model can call.
A **command** is something the human can call.

This separation is important because commands can:

- Alter local settings.
- Render UI flows.
- Inject a prepared prompt into the model.
- Trigger diagnostics.
- Open plugin managers.
- Create MCP configs.
- Start onboarding flows.
- Resume old sessions.
- Control permissions.

### Command categories

The repo’s docs describe three major command styles:

| Command style | Purpose | Clean-room equivalent |
|---|---|---|
| Prompt command | Turns user command into a structured LLM task | `PromptBackedCommand` |
| Local command | Runs deterministic local logic | `LocalCommand` |
| JSX/UI command | Opens an interactive terminal UI | `InteractiveCommand` |

### Clean-room interface

A clean implementation should define commands like this:

```ts
export interface AgentCommand {
  name: string;
  aliases?: string[];
  description: string;
  category: CommandCategory;
  requiresAuth?: boolean;
  run(ctx: CommandContext, args: string[]): Promise<CommandResult>;
}
```

Recommended command result types:

```ts
type CommandResult =
  | { type: "text"; content: string }
  | { type: "prompt"; prompt: string; allowedTools?: string[] }
  | { type: "view"; component: string; props?: unknown }
  | { type: "action"; action: RuntimeAction };
```

---

## 2. Command Registry

### Observed pattern

The central command registry imports command modules and exposes them as a single list. Conditional imports and feature flags are used to include or exclude commands based on build mode, environment, or user type.

### Rebuild pattern

Create a registry that supports:

1. Static built-in commands.
2. Plugin-contributed commands.
3. Skill-contributed commands.
4. Workspace/project commands.
5. Admin-only commands.
6. Feature-flagged commands.

Recommended layout:

```txt
apps/cli/src/commands/
  registry.ts
  types.ts
  builtin/
    help.ts
    cost.ts
    memory.ts
    mcp.ts
    permissions.ts
    agents.ts
    tasks.ts
    plugins.ts
```

### Registry responsibilities

The registry should:

- Deduplicate commands by name.
- Resolve aliases.
- Enforce command permissions.
- Validate arguments.
- Attach metadata for help UI.
- Hide internal or disabled commands.
- Allow plugins to register commands safely.

---

## 3. High-Value Commands to Rebuild First

### `/help`
Shows available commands, tools, MCP servers, agents, and shortcuts.

### `/mcp`
Manage MCP servers:

- Add server.
- Remove server.
- Authenticate server.
- List available tools/resources.
- Check health.

### `/permissions`
Manage permission rules:

- Allow tool pattern.
- Deny tool pattern.
- Reset permissions.
- Export/import policy.

### `/agents`
Manage agent profiles:

- Create agent.
- Assign system prompt.
- Assign tool set.
- Assign memory scope.
- Run agent.

### `/tasks`
Manage long-running jobs:

- Create task.
- List tasks.
- Stop task.
- View task output.

### `/memory`
Read/write memory layers:

- Project memory.
- User memory.
- Agent memory.
- Team memory.

### `/plugin`
Manage extensions:

- Install plugin.
- Enable/disable plugin.
- Show plugin trust warning.
- Validate plugin manifest.

### `/doctor`
Run environment checks:

- Auth status.
- Model connectivity.
- MCP health.
- Shell availability.
- Database status.
- File permission status.

---

## 4. Plugin System Pattern

### Observed locations

- `src/plugins/`
- `src/services/plugins/`
- `src/commands/plugin/`
- `src/utils/plugins/`

### What plugins appear to contribute

The plugin layer is an extension mechanism. A proper clean-room implementation should allow plugins to contribute:

- Commands.
- Tools.
- Skills.
- Prompt fragments.
- MCP server definitions.
- UI panels.
- Hooks/events.
- Permission presets.

### Plugin lifecycle

Recommended lifecycle:

```txt
Discover -> Validate -> Trust Gate -> Install -> Load -> Register -> Execute -> Update/Disable
```

### Plugin manifest shape

Clean-room manifest:

```json
{
  "name": "goatmez-ghl-plugin",
  "version": "1.0.0",
  "description": "GoHighLevel automation tools",
  "author": "Goatmez Media",
  "entry": "dist/index.js",
  "permissions": [
    "network:https://api.gohighlevel.com",
    "tool:crm.read",
    "tool:crm.write"
  ],
  "contributes": {
    "tools": ["ghl.searchContacts", "ghl.updateLead"],
    "commands": ["ghl"],
    "skills": ["lead-followup"]
  }
}
```

### Trust model

Plugins should never run automatically with full rights. Use:

- Signed manifests later.
- Human approval at install.
- Runtime permission prompts.
- Sandboxed execution.
- Per-plugin scopes.
- Audit logs.

---

## 5. Skill System Pattern

### Observed locations

- `src/skills/`
- `src/skills/bundled/`
- `src/components/skills/`
- `src/tools/SkillTool/`
- `src/utils/skills/`
- `Skill.md`

### What a skill is

A skill is a reusable workflow package. It is not just a prompt. It can include:

- Instructions.
- Assets.
- Scripts.
- Tool preferences.
- Validation rules.
- Examples.
- Domain-specific operating procedure.

In your ecosystem, skills are where we encode business playbooks.

Examples:

- Credit report violation review.
- GHL workflow builder.
- Local SEO audit.
- Facebook content calendar generator.
- ECM VIN programming diagnostic assistant.
- Skool community onboarding sequence.

### Clean-room skill directory

```txt
skills/
  credit-plug-intake/
    skill.md
    manifest.json
    examples/
    templates/
    scripts/
  ghl-workflow-builder/
    skill.md
    manifest.json
    templates/
```

### Skill manifest

```json
{
  "name": "credit-plug-intake",
  "version": "1.0.0",
  "description": "Qualify and onboard credit repair leads",
  "allowedTools": ["gmail.sendDraft", "calendar.create", "ghl.createContact"],
  "requiresApprovalFor": ["gmail.send", "ghl.updateOpportunity"],
  "memoryScope": "agent",
  "entrypoint": "skill.md"
}
```

---

## 6. Clean Goatmez Implementation

### Build this as three layers

```txt
Command Layer
  Human-triggered runtime controls.

Plugin Layer
  Installed extensions and integrations.

Skill Layer
  Repeatable operating procedures and business workflows.
```

### Recommended first business skills

1. `credit-plug-lead-qualifier`
2. `ghl-workflow-builder`
3. `seo-business-breakdown`
4. `facebook-content-engine`
5. `ecm-diagnostic-assistant`
6. `dispute-letter-generator`
7. `empire-architect-daily-operator`

---

## 7. Rebuild Checklist

- [ ] Define `AgentCommand` interface.
- [ ] Build command parser.
- [ ] Build command registry.
- [ ] Implement `/help`.
- [ ] Implement `/doctor`.
- [ ] Implement `/mcp`.
- [ ] Implement `/permissions`.
- [ ] Define plugin manifest.
- [ ] Build plugin validator.
- [ ] Build plugin trust approval UI.
- [ ] Define skill manifest.
- [ ] Build skill loader.
- [ ] Expose skills as callable tools.
- [ ] Add audit logs for command/plugin/skill execution.

## Key Takeaway
The repo’s command/plugin/skill architecture shows the real product pattern: a strong agent platform needs a **human command plane**, an **extension plane**, and a **workflow packaging plane**. For Goatmez Agent OS, this becomes the control system that lets you create, install, operate, and monetize specialized agents.
