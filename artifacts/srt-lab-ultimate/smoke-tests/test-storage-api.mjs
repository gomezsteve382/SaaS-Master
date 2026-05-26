import FormData from "form-data";
import { readFileSync } from "fs";

// Load env
const envFile = readFileSync("/opt/.manus/webdev.sh.env", "utf8");
const env = {};
for (const line of envFile.split("\n")) {
  const m = line.match(/^export\s+(\w+)="?([^"]*)"?/);
  if (m) env[m[1]] = m[2];
}

const FORGE_API_URL = env.BUILT_IN_FORGE_API_URL || process.env.BUILT_IN_FORGE_API_URL;
const FORGE_API_KEY = env.BUILT_IN_FORGE_API_KEY || process.env.BUILT_IN_FORGE_API_KEY;

console.log("FORGE_API_URL:", FORGE_API_URL ? FORGE_API_URL.substring(0, 50) + "..." : "MISSING");
console.log("FORGE_API_KEY:", FORGE_API_KEY ? `SET (${FORGE_API_KEY.length} chars)` : "MISSING");

// Upload a test chunk
const testKey = "chunks/test-probe-123/0";
const fd = new FormData();
fd.append("file", Buffer.from("hello world test chunk"), { filename: "0", contentType: "application/octet-stream" });
fd.append("path", testKey);

console.log("\n--- Testing upload ---");
const uploadRes = await fetch(`${FORGE_API_URL}/v1/storage/upload`, {
  method: "POST",
  headers: { Authorization: `Bearer ${FORGE_API_KEY}`, ...fd.getHeaders() },
  body: fd.getBuffer(),
});
console.log("Upload status:", uploadRes.status);
const uploadData = await uploadRes.json();
console.log("Upload result:", JSON.stringify(uploadData));

// Try download with path param
console.log("\n--- Testing download with ?path= ---");
const dlRes1 = await fetch(`${FORGE_API_URL}/v1/storage/download?path=${encodeURIComponent(testKey)}`, {
  headers: { Authorization: `Bearer ${FORGE_API_KEY}` },
});
console.log("Download (?path=) status:", dlRes1.status);
if (!dlRes1.ok) {
  console.log("Error:", await dlRes1.text());
} else {
  console.log("Content:", Buffer.from(await dlRes1.arrayBuffer()).toString());
}

// Try download with key param
console.log("\n--- Testing download with ?key= ---");
const dlRes2 = await fetch(`${FORGE_API_URL}/v1/storage/download?key=${encodeURIComponent(testKey)}`, {
  headers: { Authorization: `Bearer ${FORGE_API_KEY}` },
});
console.log("Download (?key=) status:", dlRes2.status);
if (!dlRes2.ok) {
  console.log("Error:", await dlRes2.text());
} else {
  console.log("Content:", Buffer.from(await dlRes2.arrayBuffer()).toString());
}

// Try via manus-storage proxy URL
const storageUrl = uploadData.url || `/manus-storage/${testKey}`;
console.log("\n--- Testing via manus-storage proxy URL:", storageUrl, "---");
const dlRes3 = await fetch(`http://localhost:3001${storageUrl}`);
console.log("Proxy status:", dlRes3.status);
if (dlRes3.ok) {
  console.log("Content:", Buffer.from(await dlRes3.arrayBuffer()).toString());
} else {
  console.log("Error:", await dlRes3.text().catch(() => "no body"));
}
