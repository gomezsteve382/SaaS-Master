import { Router } from "express";

const router = Router();

/* Key-photo reader — reads a photo of a transponder key / key-programmer
 * readout / packaging label and extracts the Autel-style 8-hex (4-byte) Key ID
 * that the offline Charger RFHUB key adder needs. Vision one-shot (non-stream):
 * the client POSTs a base64 image, we ask Claude to return strict JSON, and we
 * hand back a normalized { keyId, found, notes, candidates }.
 *
 * No persistence, no module context — it is a pure image->Key-ID convenience so
 * the operator does not have to hand-transcribe the ID off a photo. The ID is
 * still shown for the operator to confirm before it is written anywhere. */

const ALLOWED_MEDIA = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

// ~7.5 MB of raw image once base64 is decoded (the app caps the JSON body at
// 10 MB; leave headroom for the JSON envelope).
const MAX_BASE64_LEN = 10 * 1024 * 1024;

const PROMPT = [
  "You are reading a single photo for an FCA/Stellantis (Dodge/Chrysler/Jeep/Ram)",
  "automotive locksmith. The photo shows a transponder key, a key-programmer",
  "screen (e.g. Autel, Xhorse), or key packaging/a label.",
  "",
  "Your job: find the KEY ID — an 8-character hexadecimal value (4 bytes), often",
  'labelled "ID", "Key ID", "Chip ID", or shown on the programmer readout. It uses',
  "only the characters 0-9 and A-F and is exactly 8 characters long (ignore any",
  "spaces, dashes, or 0x prefix between the characters).",
  "",
  "Respond with STRICT JSON and nothing else, in this exact shape:",
  '{"keyId":"<8 uppercase hex chars, or empty string if none is clearly readable>",',
  '"found":<true|false>,',
  '"candidates":["<other 8-hex values you can see>"],',
  '"notes":"<one short sentence: what you saw / why unsure>"}',
  "",
  "Rules:",
  "- Only report keyId when you are confident it is exactly 8 hex characters.",
  "- If several 8-hex values appear, put the most likely Key ID in keyId and the",
  "  rest in candidates.",
  "- Never invent or guess digits you cannot read. If unsure, set found=false and",
  "  keyId to an empty string and explain in notes.",
].join("\n");

const HEX8 = /^[0-9A-F]{8}$/;

/* Pull the first parseable top-level JSON object out of noisy model output.
 * Scans brace-balanced (string- and escape-aware) candidate spans starting at
 * each `{` and returns the first that JSON.parse accepts. Tolerant of prose
 * before/after, trailing braces, or multiple objects. */
function extractFirstJsonObject(text: string): Record<string, unknown> | null {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inStr = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, i + 1));
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              return parsed as Record<string, unknown>;
            }
          } catch {
            // Not valid JSON from this `{`; fall through to the next one.
          }
          break;
        }
      }
    }
  }
  return null;
}

function normalizeHex(value: unknown): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/0x/gi, "").replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  return HEX8.test(cleaned) ? cleaned : "";
}

router.post("/key-photo", async (req, res) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let anthropic: any;
  try {
    const mod = await import("@workspace/integrations-anthropic-ai");
    anthropic = mod.anthropic;
  } catch {
    res.status(503).json({ error: "AI service unavailable: Anthropic integration not configured" });
    return;
  }
  if (!anthropic) {
    res.status(503).json({ error: "AI service unavailable" });
    return;
  }

  try {
    const { imageBase64, mediaType } = req.body as {
      imageBase64?: string;
      mediaType?: string;
    };

    if (!imageBase64 || typeof imageBase64 !== "string") {
      res.status(400).json({ error: "imageBase64 is required" });
      return;
    }
    if (!mediaType || !ALLOWED_MEDIA.has(mediaType)) {
      res.status(400).json({
        error: "mediaType must be one of image/png, image/jpeg, image/webp, image/gif",
      });
      return;
    }
    // Accept either a raw base64 string or a full data: URL.
    const base64 = imageBase64.replace(/^data:[^,]*,/, "");
    if (base64.length > MAX_BASE64_LEN) {
      res.status(413).json({ error: "Image is too large (max ~7.5 MB)." });
      return;
    }

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: base64 },
            },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    });

    const text: string = Array.isArray(response?.content)
      ? response.content
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter((b: any) => b?.type === "text")
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((b: any) => b.text)
          .join("")
      : "";

    // The model is asked for strict JSON, but be defensive: pull the first
    // parseable JSON object out of whatever came back.
    const parsed = extractFirstJsonObject(text) ?? {};

    const keyId = normalizeHex(parsed.keyId);
    const candidates = Array.isArray(parsed.candidates)
      ? Array.from(
          new Set(
            parsed.candidates
              .map(normalizeHex)
              .filter((c: string) => c && c !== keyId),
          ),
        )
      : [];
    const notes = typeof parsed.notes === "string" ? parsed.notes.slice(0, 300) : "";

    res.json({
      keyId,
      found: !!keyId,
      candidates,
      notes,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    req.log?.error?.({ err: message }, "key-photo extraction failed");
    res.status(500).json({ error: message });
  }
});

export default router;
