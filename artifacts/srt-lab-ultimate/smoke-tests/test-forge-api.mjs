// Run this from the Manus sandbox where BUILT_IN_FORGE_API_KEY is injected by the platform
const forgeUrl = process.env.BUILT_IN_FORGE_API_URL || '';
const forgeKey = process.env.BUILT_IN_FORGE_API_KEY || '';
const s3Key = 'binaries/anonymous/PrjyoBianXGj/CDA.swf';

console.log('Forge URL:', forgeUrl);
console.log('Forge Key length:', forgeKey.length);
console.log('s3Key:', s3Key);

async function probe(path, label) {
  try {
    const r = await fetch(forgeUrl + path, {
      headers: { Authorization: 'Bearer ' + forgeKey },
      signal: AbortSignal.timeout(15000),
    });
    const text = await r.text();
    console.log(`[${label}] ${r.status}: ${text.slice(0, 200)}`);
    return { status: r.status, text };
  } catch(e) {
    console.log(`[${label}] ERROR: ${e.message}`);
    return null;
  }
}

// Probe all possible Forge storage endpoints
await probe(`/v1/storage/url?key=${encodeURIComponent(s3Key)}&expires_in=3600`, 'storage/url');
await probe(`/v1/storage/presign?key=${encodeURIComponent(s3Key)}`, 'storage/presign');
await probe(`/v1/storage/presign?path=${encodeURIComponent(s3Key)}`, 'storage/presign-path');
await probe(`/v1/storage/signed-url?key=${encodeURIComponent(s3Key)}`, 'storage/signed-url');
await probe(`/v1/storage/download?path=${encodeURIComponent(s3Key)}`, 'storage/download-notrail');
await probe(`/v1/storage/download/?path=${encodeURIComponent(s3Key)}`, 'storage/download-trail');
await probe(`/v1/storage/info?key=${encodeURIComponent(s3Key)}`, 'storage/info');

// Also try downloading directly (follow redirects)
console.log('\n--- Direct download with redirect follow ---');
try {
  const r = await fetch(forgeUrl + `/v1/storage/download?path=${encodeURIComponent(s3Key)}`, {
    headers: { Authorization: 'Bearer ' + forgeKey },
    signal: AbortSignal.timeout(60000),
    redirect: 'follow',
  });
  const buf = Buffer.from(await r.arrayBuffer());
  const isHtml = buf.slice(0,15).toString().includes('<');
  console.log(`[direct-follow] ${r.status} len=${buf.length} isHtml=${isHtml} first8=${buf.slice(0,8).toString('hex')}`);
  if (!isHtml && buf.length > 10000) console.log('SUCCESS! Got real binary');
} catch(e) { console.log('ERROR:', e.message); }
