// The error says: "invalid uidPath format, expected {uid}/{filePath}"
// This means the path must be EXACTLY two segments: {uid}/{filePath}
// where uid is a single token (no slashes) and filePath is the rest

const forgeUrl = process.env.BUILT_IN_FORGE_API_URL || '';
const forgeKey = process.env.BUILT_IN_FORGE_API_KEY || '';
const appId = process.env.VITE_APP_ID || '';
const userId = '95647711';

// The test file we uploaded: relKey = 'test-probe/test-file.bin'
// CloudFront URL: /95647711/9B76mpgcQQAqByTTmtqNro/test-probe/test-file.bin
// So uid might be: "95647711" and filePath: "9B76mpgcQQAqByTTmtqNro/test-probe/test-file.bin"
// Or uid: "9B76mpgcQQAqByTTmtqNro" and filePath: "test-probe/test-file.bin"

async function tryPath(path, label) {
  const url = `${forgeUrl}/v1/storage/download?path=${encodeURIComponent(path)}`;
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${forgeKey}` },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    });
    const buf = Buffer.from(await r.arrayBuffer());
    const preview = buf.slice(0,120).toString().replace(/[^\x20-\x7e]/g,'?');
    console.log(`[${label}] ${r.status} len=${buf.length} | ${preview}`);
    if (r.status === 200 && buf.length > 5) return buf;
    return null;
  } catch(e) {
    console.log(`[${label}] ERROR: ${e.message}`);
    return null;
  }
}

// The key insight: {uid}/{filePath} means uid has NO slashes
// uid candidates: userId (95647711), appId (9B76mpgcQQAqByTTmtqNro), forgeKey itself
// filePath candidates: the rest of the path

const variants = [
  // uid=userId, filePath=appId/relKey
  [`${userId}/${appId}/test-probe/test-file.bin`, 'uid=userId filePath=appId/relKey'],
  // uid=appId, filePath=relKey  
  [`${appId}/test-probe/test-file.bin`, 'uid=appId filePath=relKey'],
  // uid=userId, filePath=relKey (skipping appId)
  [`${userId}/test-probe/test-file.bin`, 'uid=userId filePath=relKey'],
  // Maybe the uid is a combined token
  [`${userId}${appId}/test-probe/test-file.bin`, 'uid=userId+appId filePath=relKey'],
  // Maybe uid is the forgeKey itself
  [`${forgeKey}/test-probe/test-file.bin`, 'uid=forgeKey filePath=relKey'],
  // Try with the full s3Key as filePath under userId
  [`${userId}/${appId}/binaries/anonymous/4uD7q4IpBZBH/CDA.swf`, 'uid=userId filePath=appId/cda-s3key'],
  // Try appId as uid with full s3Key
  [`${appId}/binaries/anonymous/4uD7q4IpBZBH/CDA.swf`, 'uid=appId filePath=cda-s3key'],
];

for (const [path, label] of variants) {
  const buf = await tryPath(path, label);
  if (buf) {
    console.log(`\n✅ SUCCESS with: ${label}`);
    console.log('Content:', buf.toString().slice(0, 80));
    process.exit(0);
  }
}

console.log('\nAll variants failed. The /v1/storage/download endpoint may require a different auth token or format.');
console.log('\nChecking if there is a /v1/storage/list endpoint to understand the structure...');
const listRes = await fetch(`${forgeUrl}/v1/storage/list`, {
  headers: { Authorization: `Bearer ${forgeKey}` },
  signal: AbortSignal.timeout(10000),
});
console.log('List status:', listRes.status, await listRes.text().then(t => t.slice(0,300)));
