import FormData from 'form-data';

const forgeUrl = process.env.BUILT_IN_FORGE_API_URL || '';
const forgeKey = process.env.BUILT_IN_FORGE_API_KEY || '';

console.log('Forge URL:', forgeUrl);
console.log('Forge Key length:', forgeKey.length);

// Upload a tiny test file and see what key/url format is returned
const testData = Buffer.from('SRT LAB TEST BINARY DATA 0xDEADBEEF');
const relKey = 'test-probe/test-file.bin';

const fd = new FormData();
fd.append('file', testData, { filename: 'test-file.bin', contentType: 'application/octet-stream' });
fd.append('path', relKey);

console.log('\n--- Uploading test file ---');
const uploadRes = await fetch(`${forgeUrl}/v1/storage/upload`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${forgeKey}`,
    ...fd.getHeaders(),
  },
  body: fd.getBuffer(),
  signal: AbortSignal.timeout(30000),
});

console.log('Upload status:', uploadRes.status);
const uploadBody = await uploadRes.text();
console.log('Upload response:', uploadBody);

if (uploadRes.ok) {
  const data = JSON.parse(uploadBody);
  console.log('\nReturned key:', data.key);
  console.log('Returned url:', data.url);
  
  // Now try to download using the returned key
  const returnedKey = data.key;
  console.log('\n--- Trying to download with returned key ---');
  
  // Try 1: use key directly in download endpoint
  const r1 = await fetch(`${forgeUrl}/v1/storage/download?path=${encodeURIComponent(returnedKey)}`, {
    headers: { Authorization: `Bearer ${forgeKey}` },
    signal: AbortSignal.timeout(15000),
  });
  console.log('[download with returned key] status:', r1.status, 'body:', (await r1.text()).slice(0, 200));
  
  // Try 2: use the returned url directly
  if (data.url && data.url.startsWith('http')) {
    const r2 = await fetch(data.url, { signal: AbortSignal.timeout(15000) });
    const buf = Buffer.from(await r2.arrayBuffer());
    console.log('[download from returned url] status:', r2.status, 'len:', buf.length, 'content:', buf.toString().slice(0, 50));
  }
  
  // Try 3: use /manus-storage/ path
  if (data.url && data.url.startsWith('/manus-storage/')) {
    const internalUrl = `http://localhost:${process.env.PORT || 3000}${data.url}`;
    console.log('[manus-storage internal]', internalUrl);
    try {
      const r3 = await fetch(internalUrl, { signal: AbortSignal.timeout(15000) });
      const buf = Buffer.from(await r3.arrayBuffer());
      console.log('[manus-storage internal] status:', r3.status, 'len:', buf.length, 'content:', buf.toString().slice(0, 50));
    } catch(e) { console.log('[manus-storage internal] ERROR:', e.message); }
  }
}
