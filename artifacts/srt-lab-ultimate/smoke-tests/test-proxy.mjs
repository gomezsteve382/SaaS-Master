import { config } from 'dotenv';
config();

const s3Key = 'binaries/anonymous/PrjyoBianXGj/CDA.swf';
const swarmSecret = process.env.SWARM_DELEGATE_SECRET || '';
const manusBase = 'https://srtlabult.manus.space';

console.log('Swarm secret length:', swarmSecret.length);
console.log('Swarm secret:', swarmSecret);

// Test the file-proxy endpoint
const url = `${manusBase}/api/file-proxy?key=${encodeURIComponent(s3Key)}`;
console.log('URL:', url);

const r = await fetch(url, {
  headers: { 'x-swarm-secret': swarmSecret },
  signal: AbortSignal.timeout(60000),
});
console.log('Status:', r.status);
console.log('Content-Type:', r.headers.get('content-type'));
console.log('Content-Length:', r.headers.get('content-length'));
const buf = Buffer.from(await r.arrayBuffer());
console.log('Body length:', buf.length);
console.log('First 16 bytes hex:', buf.slice(0,16).toString('hex'));
const isHtml = buf.slice(0,15).toString().includes('<');
console.log('Is HTML:', isHtml);
if (!isHtml && buf.length > 10000) {
  console.log('\n✅ SUCCESS! Got real binary data');
  console.log('Magic bytes:', buf.slice(0,4).toString('hex'));
} else {
  console.log('Body preview:', buf.slice(0,200).toString());
}
