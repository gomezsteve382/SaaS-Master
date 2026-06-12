# Agent OS Extraction Part 13 — File, Code, Shell, Search, and Sandbox Tooling Deep Dive

## Boundary
This is a clean-room architecture extraction. It summarizes capabilities and rebuild patterns without reproducing proprietary source.

---

# 1. Why This Layer Is the Muscle

The file/code/shell tool layer is what turns an AI assistant into a working developer agent.

Without it, the model can only talk.
With it, the agent can:

- Read project files.
- Search code.
- Edit files.
- Write new files.
- Run shell commands.
- Validate changes.
- inspect git state.
- Execute tests.
- Work inside a sandbox.
- Ask for approval before risky actions.

For Goatmez Agent OS, this becomes the **Execution Toolbelt**.

---

# 2. Observed Tool Families

The reference package has tool categories that map to these clean-room families:

| Tool family | Purpose | Goatmez equivalent |
|---|---|---|
| Read tools | Inspect files/resources | `file.read`, `workspace.list`, `search.glob` |
| Search tools | Find files/text/symbols | `search.grep`, `search.symbols` |
| Write/edit tools | Create or change files | `file.write`, `file.patch` |
| Shell tools | Execute commands | `shell.run` |
| Notebook tools | Modify notebook-like docs | Later module |
| Web tools | Search/fetch pages | `web.search`, `web.fetch` |
| Agent tools | Delegate to subagents | `agent.run` |
| Task tools | Create/manage work units | `task.create`, `task.update` |
| MCP tools | External tools from servers | `mcp.call_tool` |

---

# 3. Tool Contract Pattern

Every tool should have one standardized contract.

```ts
ToolDefinition
- name
- description
- input_schema
- risk_level
- permission_required
- timeout_ms
- allowed_contexts
- handler
- render_result?
```

## Result format

```ts
ToolResult
- ok: boolean
- tool_name
- call_id
- started_at
- finished_at
- output
- error?
- artifacts[]
- permission_decision?
- audit
```

This enables consistent logging, UI rendering, retries, and approvals.

---

# 4. Read/Search Tools

## 4.1 File read tool

Clean-room behavior:

1. Normalize requested path.
2. Ensure path stays inside allowed workspace roots.
3. Reject binary or oversized files unless explicit mode supports it.
4. Read only requested ranges when possible.
5. Return line-numbered excerpts for model-friendly use.
6. Log path, byte size, and truncation status.

## 4.2 Glob/search tool

Clean-room behavior:

1. Respect ignore files.
2. Exclude secrets, environment files, dependency folders, and build outputs by default.
3. Limit result counts.
4. Sort by relevance or path.
5. Return paths only, not full file contents.

## 4.3 Grep tool

Clean-room behavior:

1. Accept pattern + include/exclude globs.
2. Limit file count and match count.
3. Return snippets with file path and line numbers.
4. Use safe defaults to avoid scanning massive directories.

---

# 5. Edit/Write Tools

## 5.1 File write tool

Risk profile: medium to high.

Clean-room behavior:

1. Require permission unless running in trusted auto mode.
2. Prevent writes outside workspace.
3. Create parent directories only if allowed.
4. Preserve existing files unless overwrite is explicit.
5. Record before/after metadata.
6. Generate an artifact log.

## 5.2 File patch tool

Best practice: prefer patches over full overwrites.

Clean-room behavior:

1. Read current file.
2. Apply structured patch.
3. Validate patch applies exactly once unless user chooses broader mode.
4. Produce a diff summary.
5. Save rollback snapshot.
6. Return changed lines and validation notes.

## 5.3 Rollback support

Every destructive write should create an undo record:

```txt
.rollback/{timestamp}-{tool_call_id}.json
```

Contains:

- path,
- previous content hash,
- previous content or patch inverse,
- action metadata.

---

# 6. Shell Tool

The shell tool is the most dangerous and the most powerful.

## 6.1 Command classification

Classify command risk before execution:

| Risk | Examples | Default behavior |
|---|---|---|
| read_only | `ls`, `cat`, `grep`, `git status` | Allow or fast approve |
| build/test | `npm test`, `pytest`, `bun run build` | Allow with logging |
| write_local | `touch`, `mkdir`, formatters | Approval or workspace-only |
| network | `curl`, package installs | Approval |
| destructive | `rm`, `git reset --hard`, DB drops | Explicit approval |
| privilege | `sudo`, chmod broad changes | Deny or manual approve |

## 6.2 Shell execution lifecycle

```txt
LLM requests shell.run
  -> validate input
  -> classify command
  -> permission gateway
  -> sandbox decision
  -> execute with timeout
  -> stream output
  -> redact secrets
  -> return summary + logs
```

## 6.3 Shell guardrails

The clean-room version should include:

- timeout per command,
- cwd locked to workspace,
- environment allowlist,
- output truncation,
- command risk classifier,
- denylist for obvious destructive patterns,
- allowlist for safe commands,
- secret redaction,
- audit log.

---

# 7. Sandbox Pattern

A sandbox should isolate execution from the host system.

## 7.1 V1 sandbox

For v1, implement a simple workspace sandbox:

- restricted current working directory,
- explicit allowed paths,
- no privileged commands,
- no shell access to parent dirs,
- command timeout,
- optional no-network mode.

## 7.2 V2 sandbox

Later, add:

- Docker container execution,
- ephemeral worktrees,
- network policy,
- CPU/memory limits,
- artifact extraction,
- per-agent sandbox profiles.

---

# 8. Code Tool UX Pattern

The model needs output that is compact but actionable.

Tool results should include:

- What happened.
- What changed.
- Where it changed.
- Whether output was truncated.
- Next suggested verification command.

Example clean-room result shape:

```json
{
  "ok": true,
  "summary": "Updated 2 files and created 1 test.",
  "changed_files": ["src/runtime.ts", "tests/runtime.test.ts"],
  "verification": "npm test",
  "audit_id": "tool_123"
}
```

---

# 9. Goatmez Agent OS Toolbelt V1

Build these first:

1. `workspace.list`
2. `file.read`
3. `file.write`
4. `file.patch`
5. `search.grep`
6. `search.glob`
7. `shell.run`
8. `task.create`
9. `task.update`
10. `agent.run`

---

# 10. Permission Coupling

Every tool should declare risk. The permission gateway should decide whether:

- it can run immediately,
- it needs user approval,
- it must be denied,
- it must run in sandbox,
- it must be escalated to manual mode.

The tool itself should not be responsible for business policy. Tools should expose risk facts. The gateway decides.

---

# 11. Clean-Room Implementation Notes

Do not copy tool handlers from the reference package. Implement the behavior from first principles using:

- Node `fs/promises` for file operations,
- `child_process` or `execa` style execution for shell,
- custom command classification,
- simple JSON schemas or Zod schemas,
- a central audit logger.

---

# 12. Power Move for Steven

This toolbelt is the foundation for:

- AI app builder,
- credit report letter generator,
- GHL workflow builder,
- SEO crawler,
- ECM/VIN diagnostic assistant,
- content automation engine,
- VA replacement agent.

Every specialized bot becomes a different agent profile over the same execution toolbelt.
