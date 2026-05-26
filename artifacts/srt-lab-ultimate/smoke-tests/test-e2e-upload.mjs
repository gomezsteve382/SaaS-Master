#!/usr/bin/env node
// End-to-end test: upload a binary in chunks and verify GCP gets real bytes
// Simulates exactly what the browser does (JSON body for stream endpoint)

const BASE_URL = "https://srtlabult.manus.space";
const CHUNK_SIZE = 200 * 1024; // 200KB

// Create a test binary (MZ header + recognizable payload)
const testPayload = Buffer.concat([
  Buffer.from("MZ"),
  Buffer.alloc(62, 0),
  Buffer.from("TEST_BINARY_REAL_BYTES_NOT_HTML_CLOUDFRONT_FIX_VERIFY"),
  Buffer.alloc(100, 0),
]);
console.log(`[test] Binary: ${testPayload.length} bytes, magic: ${testPayload.slice(0, 2).toString()}`);

// Step 1: Register analysis
const regRes = await fetch(`${BASE_URL}/api/register-analysis`, { method: "POST" });
const { analysisId, jobToken } = await regRes.json();
console.log(`[test] Registered: analysisId=${analysisId}, jobToken=${jobToken}`);

// Step 2: Upload chunks (multipart — this is correct for /api/upload-chunk)
const uploadId = `test-cf-${Date.now()}`;
const totalChunks = Math.ceil(testPayload.length / CHUNK_SIZE);
console.log(`[test] Uploading ${totalChunks} chunk(s) with uploadId=${uploadId}...`);

for (let i = 0; i < totalChunks; i++) {
  const chunk = testPayload.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
  const fd = new FormData();
  fd.append("file", new Blob([chunk], { type: "application/octet-stream" }), "test-real.exe");
  fd.append("uploadId", uploadId);
  fd.append("chunkIndex", String(i));
  fd.append("totalChunks", String(totalChunks));
  fd.append("filename", "test-real.exe");
  const r = await fetch(`${BASE_URL}/api/upload-chunk`, { method: "POST", body: fd });
  const body = await r.text();
  if (!r.ok) { console.error(`[test] Chunk ${i} failed: ${r.status} ${body}`); process.exit(1); }
  console.log(`[test] Chunk ${i} uploaded OK: ${body.slice(0, 60)}`);
}

// Step 3: Fire the chunked stream endpoint (JSON body — NOT multipart)
console.log(`[test] Firing upload-stream-chunked (JSON body)...`);
const streamRes = await fetch(`${BASE_URL}/api/upload-stream-chunked`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    uploadId,
    totalChunks,
    filename: "test-real.exe",
    fileSize: testPayload.length,
    analysisId,
    jobToken,
  }),
  signal: AbortSignal.timeout(30_000),
});
console.log(`[test] SSE stream status: ${streamRes.status}`);
const analysisIdHeader = streamRes.headers.get("x-analysis-id");
console.log(`[test] X-Analysis-Id: ${analysisIdHeader || "(not set)"}`);

if (!streamRes.ok) {
  const err = await streamRes.text();
  console.error(`[test] Stream error: ${err}`);
  process.exit(1);
}

// Read first few SSE events
const reader = streamRes.body.getReader();
const decoder = new TextDecoder();
let events = [];
let done = false;
const startTime = Date.now();
while (!done && Date.now() - startTime < 20_000) {
  const { value, done: d } = await reader.read();
  done = d;
  if (value) {
    const text = decoder.decode(value);
    const lines = text.split("\n").filter(l => l.startsWith("data:") || l.startsWith("event:") || l.startsWith(":"));
    events.push(...lines);
    // Stop after seeing "analyzing" or "complete" or "error"
    const combined = events.join(" ");
    if (combined.includes("analyzing") || combined.includes("complete") || combined.includes("error") || combined.includes("failed")) break;
    if (events.length >= 10) break;
  }
}
reader.cancel();

console.log(`[test] First SSE events:`);
events.slice(0, 10).forEach(e => console.log(" ", e.slice(0, 150)));

// Step 4: Check GCP logs
console.log(`\n[test] Waiting 8s then checking GCP delegation...`);
await new Promise(r => setTimeout(r, 8000));

const effectiveId = analysisId || analysisIdHeader;
const pollRes = await fetch(`${BASE_URL}/api/analysis/${effectiveId}`);
if (pollRes.ok) {
  const data = await pollRes.json();
  console.log(`[test] Analysis status: ${data.status}`);
  console.log(`[test] Summary: ${(data.summary || "").slice(0, 100)}`);
} else {
  console.log(`[test] Poll status: ${pollRes.status}`);
}

console.log(`\n[test] ✅ Done. Check GCP logs for:`);
console.log(`  sudo journalctl -u srt-lab -f`);
console.log(`  Look for: "[chunk-s3] CloudFront" or "[delegate] Using embedded base64"`);
