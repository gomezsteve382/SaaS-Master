import { config } from 'dotenv';
config();

const s3Key = 'binaries/anonymous/PrjyoBianXGj/CDA.swf';
const forgeUrl = process.env.BUILT_IN_FORGE_API_URL || '';
const forgeKey = process.env.BUILT_IN_FORGE_API_KEY || '';
const appId = process.env.VITE_APP_ID || '';

console.log('Forge URL:', forgeUrl);
console.log('Forge Key length:', forgeKey.length);
console.log('App ID:', appId);

async function GET(url, label) {
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${forgeKey}` },
      signal: AbortSignal.timeout(20000),
      redirect: 'follow',
    });
    const buf = Buffer.from(await r.arrayBuffer());
    const preview = buf.slice(0, 120).toString().replace(/[^\x20-\x7e]/g, '?');
    console.log(`[${label}] ${r.status} len=${buf.length} | ${preview}`);
    return { status: r.status, buf };
  } catch (e) {
    console.log(`[${label}] ERROR: ${e.message}`);
    return null;
  }
}

// Try every known Forge storage endpoint variant
const paths = [
  // uid/path variants
  `${forgeUrl}/v1/storage/download?path=${encodeURIComponent(appId + '/' + s3Key)}`,
  `${forgeUrl}/v1/storage/download?path=${encodeURIComponent(s3Key.replace('binaries/anonymous/', appId + '/'))}`,
  // Just the relative part after anonymous/
  `${forgeUrl}/v1/storage/download?path=${encodeURIComponent(s3Key.replace('binaries/anonymous/', ''))}`,
  // With app ID as uid
  `${forgeUrl}/v1/storage/download?path=${appId}/${encodeURIComponent(s3Key)}`,
  // Try /v1/storage/object
  `${forgeUrl}/v1/storage/object?path=${encodeURIComponent(s3Key)}`,
  `${forgeUrl}/v1/storage/object/${encodeURIComponent(s3Key)}`,
  // Try /v1/files
  `${forgeUrl}/v1/files?path=${encodeURIComponent(s3Key)}`,
  // Try the chunk download pattern from batch-queue.ts
  `${forgeUrl}/v1/storage/download?path=${encodeURIComponent('anonymous/' + s3Key.split('/').slice(2).join('/'))}`,
];

for (const [i, url] of paths.entries()) {
  const res = await GET(url, `variant-${i+1}`);
  if (res && res.status === 200 && res.buf.length > 10000) {
    const isHtml = res.buf.slice(0,15).toString().includes('<');
    if (!isHtml) {
      console.log(`\n✅ SUCCESS with variant-${i+1}!`);
      console.log('URL pattern:', url.replace(forgeUrl, '{FORGE}').slice(0, 150));
      console.log('Bytes:', res.buf.length);
      console.log('Magic:', res.buf.slice(0,4).toString('hex'));
      process.exit(0);
    }
  }
}

// Try the Manus file-proxy approach (used in an older version of the code)
console.log('\n--- Trying Manus file-proxy ---');
const manusProxy = `https://srtlabult.manus.space/api/file-proxy?key=${encodeURIComponent(s3Key)}`;
await GET(manusProxy, 'manus-file-proxy');

// Try direct CloudFront URL pattern
console.log('\n--- Trying CloudFront direct ---');
// The s3Url stored in DB for this file
const cfUrl = `https://d2xsxph8kpxj0f.cloudfront.net/${s3Key}`;
await GET(cfUrl, 'cloudfront-direct');

// Try with a signed cookie approach - check what URL the DB has stored
console.log('\n--- Checking DB for stored s3Url ---');
try {
  const r = await fetch('https://srtlabult.manus.space/api/analysis/fKQZhl9HwhJe');
  const data = await r.json();
  console.log('storageStatus:', data.storageStatus);
  // Try to get the binary via the reanalyze endpoint which fetches from s3Url
} catch(e) { console.log('DB check error:', e.message); }
