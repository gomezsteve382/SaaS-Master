#!/usr/bin/env node
// Test: upload a tiny chunk then download it to find the correct path format
import FormDataNode from "form-data";

const FORGE_URL = "https://forge.manus.ai";
const FORGE_KEY = process.env.BUILT_IN_FORGE_API_KEY;
const APP_ID = process.env.VITE_APP_ID;

if (!FORGE_KEY) { console.error("BUILT_IN_FORGE_API_KEY not set"); process.exit(1); }
console.log("FORGE_KEY:", FORGE_KEY.slice(0, 8) + "...");
console.log("APP_ID:", APP_ID);

// Step 1: Upload a test chunk
const testKey = `chunks/test-download-probe/${Date.now()}/0`;
const testData = Buffer.from("HELLO_CHUNK_TEST_BYTES_12345");

console.log(`\n=== UPLOAD test chunk to key: ${testKey} ===`);
const fd = new FormDataNode();
fd.append("file", testData, { filename: "chunk-0", contentType: "application/octet-stream" });
fd.append("path", testKey);

const uploadRes = await fetch(`${FORGE_URL}/v1/storage/upload`, {
  method: "POST",
  headers: { Authorization: `Bearer ${FORGE_KEY}`, ...fd.getHeaders() },
  body: fd.getBuffer(),
});
console.log("Upload status:", uploadRes.status);
const uploadBody = await uploadRes.text();
console.log("Upload body:", uploadBody.slice(0, 300));

if (!uploadRes.ok) {
  console.error("Upload failed — cannot test download");
  process.exit(1);
}

// Parse the returned URL/key from upload response
let returnedUrl = "";
try {
  const parsed = JSON.parse(uploadBody);
  returnedUrl = parsed.url || parsed.key || "";
  console.log("Returned URL:", returnedUrl);
} catch {}

// Step 2: Try every download path format
const pathsToTry = [
  testKey,
  `${APP_ID}/${testKey}`,
  returnedUrl,
];

for (const path of pathsToTry) {
  if (!path) continue;
  const url = `${FORGE_URL}/v1/storage/download?path=${encodeURIComponent(path)}`;
  console.log(`\n=== DOWNLOAD attempt: path=${path} ===`);
  const r = await fetch(url, { headers: { Authorization: `Bearer ${FORGE_KEY}` } });
  console.log("Status:", r.status, "Content-Type:", r.headers.get("content-type"));
  const body = await r.arrayBuffer();
  const text = Buffer.from(body).toString("utf8", 0, 100);
  console.log("Body (first 100 bytes):", text);
  if (r.ok && text.includes("HELLO_CHUNK_TEST_BYTES")) {
    console.log("✅ WORKING PATH FORMAT:", path);
    break;
  }
}
