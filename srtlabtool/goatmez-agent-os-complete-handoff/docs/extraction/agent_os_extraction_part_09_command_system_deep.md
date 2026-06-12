# Goatmez Agent OS Extraction — Part 09: Command System Deep Dive

## Clean-room notice
This document extracts architecture patterns only. It does not reproduce proprietary source, hidden prompts, secret algorithms, or implementation text from the uploaded repository.

## What this layer does
The command layer is the human-facing control surface for an agent runtime. It turns typed slash commands, CLI flags, dashboard buttons, and automation triggers into structured actions against the agent system.

In the inspected repository, commands are not random helper scripts. They form a modular command bus with categories for:

- session management
- model/runtime configuration
- MCP server management
- permission management
- memory management
- task scheduling
- agent/subagent control
- plugin/skill loading
- debugging and diagnostics
- export/share/status utilities
- onboarding and setup flows

## Architectural pattern
A strong command system needs four pieces:

1. **Command registry**
   - Holds all available commands.
   - Provides metadata: name, aliases, description, category, argument schema, visibility.
   - Supports built-in commands and plugin-provided commands.

2. **Command parser**
   - Detects command prefix, such as `/mcp`, `/permissions`, `/memory`, `/agent`.
   - Splits command name from arguments.
   - Validates arguments before execution.

3. **Command executor**
   - Runs the command handler.
   - Injects context: active session, user config, workspace, tool registry, permissions, logger.
   - Returns structured output for terminal/dashboard rendering.

4. **Command UI renderer**
   - Converts command result into display cards, tables, confirmations, errors, or interactive prompts.

## Command lifecycle
The clean flow should be:

```text
User input
  -> detect slash command
  -> parse command name and args
  -> lookup command definition
  -> validate args
  -> check command-level permission
  -> execute handler
  -> emit events/logs
  -> render result
```

## Command definition interface
For Goatmez Agent OS, use an original schema like this:

```ts
export type CommandContext = {
  sessionId: string;
  workspaceId: string;
  userId: string;
  services: AgentServices;
  logger: Logger;
};

export type CommandDefinition<TArgs = unknown> = {
  name: string;
  aliases?: string[];
  category: 'session' | 'agent' | 'mcp' | 'tool' | 'memory' | 'permission' | 'task' | 'system';
  description: string;
  usage: string;
  dangerous?: boolean;
  parse: (raw: string[]) => TArgs;
  run: (args: TArgs, ctx: CommandContext) => Promise<CommandResult>;
};
```

## Core command groups to rebuild

### 1. Session commands
Purpose: control the live conversation/runtime state.

Recommended commands:

- `/new` — start a new session
- `/resume <session>` — restore a previous session
- `/summary` — summarize current session
- `/export` — export session transcript
- `/status` — show model, tools, permissions, active tasks
- `/clear` — clear visible context or session cache

### 2. Agent commands
Purpose: create and manage specialist agents.

Recommended commands:

- `/agents` — list available agents
- `/agent create` — define new specialist agent
- `/agent run <name> <task>` — run a specialist agent
- `/agent memory <name>` — inspect agent memory summary
- `/agent stop <id>` — stop a running agent

### 3. MCP commands
Purpose: manage external tool servers.

Recommended commands:

- `/mcp list`
- `/mcp add <name> <transport> <config>`
- `/mcp remove <name>`
- `/mcp connect <name>`
- `/mcp disconnect <name>`
- `/mcp tools <name>`
- `/mcp auth <name>`

### 4. Permission commands
Purpose: inspect and edit tool access.

Recommended commands:

- `/permissions`
- `/allow <tool> <scope>`
- `/deny <tool> <scope>`
- `/rules`
- `/rules add`
- `/rules remove`
- `/trusted-workspaces`

### 5. Memory commands
Purpose: control persistent memory.

Recommended commands:

- `/memory show`
- `/memory add`
- `/memory forget`
- `/memory compact`
- `/memory search`

### 6. Task commands
Purpose: schedule, monitor, and stop background work.

Recommended commands:

- `/tasks`
- `/task create`
- `/task get <id>`
- `/task stop <id>`
- `/task update <id>`
- `/cron list`
- `/cron create`
- `/cron delete`

### 7. Plugin/skill commands
Purpose: extend the runtime without editing core code.

Recommended commands:

- `/plugins`
- `/plugin install`
- `/plugin remove`
- `/plugin trust`
- `/skills`
- `/skill run`

## Clean rebuild rule
Commands should never directly perform dangerous operations. They should call services. Example:

Bad pattern:

```text
Command directly writes files, opens browser, sends email, mutates database.
```

Good pattern:

```text
Command -> service method -> permission check -> tool execution -> audit log -> result.
```

## Command service boundaries

### CommandRegistry
Responsibilities:
- register commands
- detect duplicate names/aliases
- list commands by category
- resolve aliases

### CommandParser
Responsibilities:
- parse raw user text
- determine whether it is command or natural language
- tokenize arguments
- handle quoted strings

### CommandExecutor
Responsibilities:
- validate command exists
- run command-level permission checks
- execute handler
- catch errors
- log lifecycle events

### CommandResultRenderer
Responsibilities:
- terminal rendering
- dashboard rendering
- API response rendering

## Data model

```ts
export type CommandRunRecord = {
  id: string;
  sessionId: string;
  commandName: string;
  args: Record<string, unknown>;
  startedAt: string;
  endedAt?: string;
  status: 'ok' | 'error' | 'denied';
  error?: string;
};
```

## Why this matters for Goatmez Agent OS
The command layer becomes your remote control. Instead of hardcoding features in the UI, every important action becomes command-addressable:

- run lead generation
- scan a website
- draft outreach
- inspect a credit report
- generate a dispute letter
- create a GHL workflow
- schedule content
- launch a specialist agent

This makes the system usable from:

- terminal
- web dashboard
- voice command
- mobile app
- webhook
- scheduled automation

## Rebuild priority
Build commands in this order:

1. `/status`
2. `/tools`
3. `/permissions`
4. `/mcp list`
5. `/agent run`
6. `/memory show`
7. `/tasks`
8. `/plugin list`

## Immediate implementation target
For the starter system, create:

```text
src/commands/
  CommandRegistry.ts
  CommandParser.ts
  CommandExecutor.ts
  builtins/
    status.ts
    tools.ts
    permissions.ts
    mcp.ts
    agents.ts
    tasks.ts
```

## Frank verdict
The command system is not cosmetic. It is how an agent platform becomes controllable. A serious Agent OS needs every important capability available through a command bus, then the dashboard becomes just one client sitting on top of it.
