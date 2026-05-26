// The Forge upload returns: https://d2xsxph8kpxj0f.cloudfront.net/95647711/9B76mpgcQQAqByTTmtqNro/test-probe/test-file.bin
// The URL structure is: cloudfront/{userId}/{appId}/{relKey}
// So the uid for the download endpoint might be: {userId}/{appId} or just {userId} or {appId}

const forgeUrl = process.env.BUILT_IN_FORGE_API_URL || '';
const forgeKey = process.env.BUILT_IN_FORGE_API_KEY || '';
const appId = process.env.VITE_APP_ID || '';
const relKey = 'test-probe/test-file.bin'; // The file we just uploaded

// From the CloudFront URL: /95647711/9B76mpgcQQAqByTTmtqNro/test-probe/test-file.bin
const userId = '95647711'; // extracted from CloudFront URL

console.log('App ID:', appId);
console.log('User ID (from CF URL):', userId);

async function tryDownload(uidPath, label) {
  const url = `${forgeUrl}/v1/storage/download?path=${encodeURIComponent(uidPath)}`;
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${forgeKey}` },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    });
    const buf = Buffer.from(await r.arrayBuffer());
    const preview = buf.slice(0,100).toString().replace(/[^\x20-\x7e]/g,'?');
    console.log(`[${label}] ${r.status} len=${buf.length} | ${preview}`);
    if (r.status === 200 && buf.length > 10) return buf;
    return null;
  } catch(e) {
    console.log(`[${label}] ERROR: ${e.message}`);
    return null;
  }
}

// Try all combinations
const variants = [
  [`${userId}/${appId}/${relKey}`, 'userId/appId/relKey'],
  [`${userId}/${relKey}`, 'userId/relKey'],
  [`${appId}/${relKey}`, 'appId/relKey'],
  [`${appId}/${userId}/${relKey}`, 'appId/userId/relKey'],
  // The s3Key stored in DB: binaries/anonymous/lwFfTPqmyiAs/test-cda-minimal.swf
  // Try with userId prefix
  [`${userId}/binaries/anonymous/lwFfTPqmyiAs/test-cda-minimal.swf`, 'userId/s3Key'],
  [`${userId}/${appId}/binaries/anonymous/lwFfTPqmyiAs/test-cda-minimal.swf`, 'userId/appId/s3Key'],
];

for (const [path, label] of variants) {
  const buf = await tryDownload(path, label);
  if (buf) {
    console.log(`\n✅ SUCCESS with: ${label}`);
    console.log('Content:', buf.toString().slice(0, 50));
    break;
  }
}

// Also try: use the full CloudFront path after the domain as the uidPath
const cfPath = `${userId}/${appId}/${relKey}`;
console.log('\nTrying full CF path:', cfPath);
await tryDownload(cfPath, 'full-cf-path');
