---
name: Global AI Co-pilot persistence
description: How the global Co-pilot panel persists chats and how its system prompt is chosen
---

The global AI Co-pilot (CopilotPanel.jsx, surfaced from App.jsx FAB) persists
chats by reusing the shared conversations API with `scope="general"`.

**System prompt selection** lives in api-server `routes/anthropic/conversations.ts`
POST `/conversations/:id/messages`: it branches on `conv.scope`. `scope==="general"`
gets `GENERAL_SYSTEM_PROMPT` (non-restrictive, answers anything); any other scope
gets the IMMO `SYSTEM_PROMPT`. A `moduleContext` in the body always overrides to
`SYSTEM_PROMPT` + context block (module-assistant conversations).

**Why:** both the stateless `/general-chat` endpoint and the persistent co-pilot
must share the same non-restrictive prompt, so `GENERAL_SYSTEM_PROMPT` was moved
to `_shared.ts`. If you add another co-pilot-like scope, extend the branch — don't
default new scopes to the restrictive module prompt unintentionally.

**Restore-on-open:** localStorage pointer `srt-copilot-last-conv` holds the last
conversation id; on mount the hook hydrates it, falling back to the newest
`?scope=general` conversation if the pointer is missing/stale.

**File attachments** are folded into the plain message text on the frontend, not
sent as separate content blocks — so they ride the existing conversations
messages path with no backend, multimodal, or DB change.
**Why:** images/PDF/binary would require Anthropic content-block message shapes +
DB changes (major arch), so they are deliberately rejected with a note pointing
users to the Data Management module-load flow. If you ever need real binary/image
support, that is a backend+schema change, not an extension of this folding path.
