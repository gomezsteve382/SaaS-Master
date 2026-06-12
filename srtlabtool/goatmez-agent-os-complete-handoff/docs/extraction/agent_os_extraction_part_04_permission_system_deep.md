# Goatmez Agent OS Extraction — Part 04: Permission System Deep Dive

## Safety note
This is an architecture extraction, not a source-code reproduction. The uploaded repo is marked `UNLICENSED` and describes itself as reference, so this pack converts observed patterns into a clean-room design we can rebuild with original code.

## Executive summary
The permission system is not a single yes/no check. It is a full decision pipeline that combines:

1. Permission modes.
2. Rule sources.
3. Tool-specific checks.
4. Shell/file safety checks.
5. Automated classifiers.
6. Hook-based overrides.
7. Interactive user approval.
8. Background-agent fallback behavior.
9. Persistent rule updates.
10. Telemetry/audit logging.

For Goatmez Agent OS, this layer is the gate between the model and the outside world. Every dangerous capability must cross this bridge.

---

## Core permission concepts

### Permission modes
Observed modes include:

- `default` — normal cautious behavior.
- `acceptEdits` — likely allows file edits while still controlling broader actions.
- `bypassPermissions` — elevated mode, guarded by availability checks.
- `dontAsk` — non-interactive deny behavior.
- `plan` — planning-only or restricted execution behavior.
- `auto` — classifier-assisted mode behind feature gates.
- `bubble` — internal/nested routing mode.

### Clean-room equivalent
Use these modes:

```text
SAFE_PLAN      = no external writes, no shell writes, no sends
DEFAULT        = ask for writes/destructive/open-world actions
AUTO_APPROVE   = allow low-risk read/search actions, classifier-check medium risk
EDIT_TRUSTED   = allow workspace file edits, ask for shell/network/destructive
BYPASS         = power-user mode, disabled by default, requires explicit unlock
BACKGROUND     = no prompts; deny or defer anything requiring confirmation
```

---

## Rule sources

The repo separates rule origins. This matters because a company policy should outrank a session choice.

Observed source classes:

- User settings.
- Project settings.
- Local settings.
- Flag/CLI settings.
- Policy/managed settings.
- Command-created session rules.
- Temporary session rules.

### Clean-room precedence model

Recommended order:

1. Enterprise/managed deny.
2. Project deny.
3. User deny.
4. Session deny.
5. Enterprise/managed allow.
6. Project allow.
7. User allow.
8. Session allow.
9. Ask rules.
10. Mode default.

Deny should generally beat allow unless the product has a highly explicit override path.

---

## Permission rule shape

Observed conceptual rule:

```text
Rule = {
  source: where it came from,
  behavior: allow | deny | ask,
  value: {
    toolName: string,
    optionalRuleContent: string pattern
  }
}
```

Examples of clean-room rule strings:

```text
Bash(ls *)
Bash(git status)
FileRead(src/**)
FileEdit(src/**)
MCP(gmail.send_email)
MCP(gh.create_issue)
Agent(researcher)
```

The key design idea: a rule can target the whole tool or a pattern inside that tool.

---

## Decision result model

The repo uses richer outcomes than true/false.

Clean-room version:

```ts
type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: object; reason?: DecisionReason }
  | { behavior: 'ask'; message: string; suggestions?: PermissionUpdate[]; reason?: DecisionReason }
  | { behavior: 'deny'; message: string; reason: DecisionReason }
  | { behavior: 'passthrough'; message: string; reason?: DecisionReason }
```

`updatedInput` is important. Permission checks can normalize or constrain the input before execution.

---

## Decision reason taxonomy

Observed reason categories include:

- Rule matched.
- Mode required approval.
- Hook required/denied.
- Classifier decision.
- Async agent limitation.
- Sandbox override.
- Working directory issue.
- Safety check.
- Subcommand split results.
- Permission-prompt tool result.
- Other.

### Why this matters
A serious agent system needs explainability. The user should see:

```text
Denied because: Bash command writes outside allowed workspace.
Source: project policy.
Suggested fix: run inside /workspace/project or request workspace access.
```

---

## Permission pipeline reconstruction

### Step 1 — Tool exists and input validates
Before permission checks, the runtime finds the tool and validates input against its schema.

If invalid:

- Return a tool error.
- Do not run permissions.
- Do not execute.

### Step 2 — Tool-specific validation
Each tool can implement its own input validation.

Examples:

- Bash validates command semantics.
- File tools validate paths.
- MCP tools validate server/tool name.
- Agent tool validates agent type and isolation mode.

### Step 3 — Blanket deny filtering
Before the model even sees tools, blanket-denied tools are removed from the visible tool list. This is huge. It prevents the model from planning around forbidden tools.

Clean-room rule:

```text
If tool has blanket deny, remove it from model-visible registry.
```

### Step 4 — Rule match
Match against:

- Full tool name.
- Alias.
- MCP fully qualified name.
- MCP server prefix.
- Tool-specific content pattern.

### Step 5 — Mode behavior
If no rule resolves it, the permission mode decides the default.

Examples:

- Plan mode asks/denies execution tools.
- Background mode denies anything requiring UI.
- Bypass mode allows more, but not necessarily everything.

### Step 6 — Safety checks
For shell/file tools, deterministic safety checks should run before classifier calls.

Recommended checks:

- Writes outside workspace.
- Hidden sensitive folders: `.git`, `.ssh`, `.env`, `.Reference System`, credentials.
- Destructive commands: `rm -rf`, disk formatting, credential exfiltration patterns.
- Network exfiltration combined with secret reads.
- Git destructive operations.
- Shell redirection creating/overwriting files.
- Chained commands with mixed safe/unsafe operations.

### Step 7 — Hooks
Hooks can pre-approve, require approval, deny, or modify inputs.

Clean-room hook phases:

```text
BeforePermissionCheck
BeforeToolUse
AfterToolUseSuccess
AfterToolUseFailure
OnPermissionDenied
```

### Step 8 — Classifier-assisted auto mode
The repo has classifier-related logic for Bash and transcript-level auto mode. The clean-room design should use classifier support only as a second opinion, never as the only safety layer.

Recommended classifier outputs:

```json
{
  "decision": "allow|ask|deny",
  "risk": "low|medium|high",
  "reason": "short human-readable reason",
  "matched_policy": "optional rule name",
  "confidence": "low|medium|high"
}
```

Fail closed for high-risk actions. Fail to prompt for medium-risk actions. Allow only low-risk, high-confidence actions.

### Step 9 — Interactive permission UI
If decision is `ask`, the UI receives:

- Tool name.
- Human description.
- Input summary.
- Risk explanation.
- Suggested actions.
- One-time allow.
- Always allow matching rule.
- Deny.
- Always deny matching rule.

### Step 10 — Persist update
When user picks “always allow” or “always deny,” convert the choice into a permission update.

Recommended destinations:

- Session only.
- Local project settings.
- User global settings.
- Managed policy — admin only.

---

## Background agent behavior

Background agents cannot show prompts reliably. The repo tracks cases where permission prompts should be avoided.

Clean-room rule:

```text
If background task needs permission:
  if policy allows auto-defer:
    pause task and ask user in dashboard
  else:
    deny tool call with explanation
```

Better product design: create a “Pending Approvals” inbox in the dashboard so background agents can pause instead of fail.

---

## Permission system for Goatmez Agent OS

### Database tables

```sql
permission_rules
- id
- source
- scope_type: user | project | agent | workspace | org
- scope_id
- behavior: allow | ask | deny
- tool_name
- rule_pattern
- created_by
- created_at
- expires_at nullable
- enabled

permission_events
- id
- session_id
- agent_id
- tool_name
- input_summary
- decision
- reason_type
- reason_text
- source
- created_at

approval_requests
- id
- session_id
- agent_id
- tool_name
- input_json
- description
- risk_level
- status: pending | approved | denied | expired
- requested_at
- resolved_at
- resolved_by
```

### Permission service interface

```ts
interface PermissionService {
  evaluate(request: ToolPermissionRequest): Promise<PermissionDecision>
  createApproval(request: ApprovalRequest): Promise<ApprovalTicket>
  resolveApproval(id: string, decision: UserApprovalDecision): Promise<void>
  addRule(rule: PermissionRule): Promise<void>
  removeRule(ruleId: string): Promise<void>
}
```

### Permission request shape

```ts
type ToolPermissionRequest = {
  sessionId: string
  agentId?: string
  toolName: string
  input: unknown
  toolMetadata: {
    isReadOnly: boolean
    isDestructive: boolean
    isOpenWorld: boolean
    isMcp: boolean
    mcpServer?: string
  }
  workspace: {
    cwd: string
    allowedDirectories: string[]
  }
  mode: PermissionMode
}
```

---

## High-value rebuild features

### 1. Permission simulator
Before running a workflow, show the user what permissions it will probably need.

Example:

```text
This workflow may request:
- Read files in /uploads
- Search web
- Draft Gmail messages
- Create CRM notes
- Ask before sending emails
```

### 2. Agent-specific permission profiles
Each agent gets a permission profile.

Examples:

```text
Credit Plug: can read uploaded PDFs, draft letters, update CRM; cannot send without approval.
SEO Hunter: can browse, scrape public pages, draft emails; cannot send bulk emails without approval.
Empire Architect: can read tasks/calendar; cannot delete anything.
```

### 3. Approval queue
Dashboard panel:

```text
Pending approvals
- Sales Agent wants to send email to 42 leads
- VA Agent wants to archive 13 emails
- Dev Agent wants to run migration
```

### 4. Trust ladder
Agents earn more autonomy only after successful runs.

```text
Level 0: Plan only
Level 1: Read/search
Level 2: Draft/write local files
Level 3: Execute low-risk automations
Level 4: Execute approved workflows
Level 5: Admin override only
```

---

## Clean-room implementation order

1. Define `Tool`, `PermissionDecision`, and `PermissionRule` types.
2. Build static rule matcher.
3. Add tool metadata: read-only, destructive, open-world, MCP.
4. Add path validation.
5. Add shell command classifier-lite using deterministic rules.
6. Add approval queue.
7. Add dashboard UI.
8. Add persistent rules.
9. Add LLM-based classifier as optional assist.
10. Add audit logs and replay.

---

## Takeaway
The permission layer is the control tower. Without it, agents are toys or liabilities. With it, Goatmez Agent OS becomes a serious operator platform: powerful, auditable, and safe enough to trust with real business workflows.
