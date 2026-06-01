---
name: Global AI Co-pilot persistence
description: Durable rules for the global Co-pilot's prompt scoping and attachment handling
---

The global Co-pilot persists chats by reusing the shared conversations API with
`scope="general"` (rather than a bespoke store).

**System-prompt scoping rule:** the persistent co-pilot and the stateless
general-chat endpoint must share the SAME non-restrictive prompt. The conversations
message handler branches on `conv.scope`: `general` → non-restrictive; everything
else → the restrictive IMMO prompt; a `moduleContext` in the body always forces the
IMMO prompt + context block.
**Why:** a new co-pilot-like scope that falls through the branch would silently get
the restrictive module prompt and refuse normal questions.
**How to apply:** when adding any new conversational scope, extend the branch
explicitly — never let it default to the restrictive prompt.

**Attachment handling rule:** file attachments are deliberately folded into the
plain message text on the frontend, not sent as Anthropic content blocks.
**Why:** real image/PDF/binary support needs content-block message shapes + DB
changes — a backend+schema change, not an extension of the text-folding path.
**How to apply:** treat "add real binary/image co-pilot input" as a backend task;
do not try to bolt multimodal onto the existing folding path.
