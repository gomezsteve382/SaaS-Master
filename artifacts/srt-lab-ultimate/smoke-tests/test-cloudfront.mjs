// Test if CloudFront URL is accessible from the Manus sandbox
const cfUrl = 'https://d2xsxph8kpxj0f.cloudfront.net/95647711/9B76mpgcQQAqByTTmtqNro/binaries/anonymous/4uD7q4IpBZBH/CDA.swf';

console.log('Testing CloudFront URL from Manus sandbox...');
const r = await fetch(cfUrl, { signal: AbortSignal.timeout(30000) });
console.log('Status:', r.status);
console.log('Content-Type:', r.headers.get('content-type'));
console.log('Content-Length:', r.headers.get('content-length'));
const buf = Buffer.from(await r.arrayBuffer());
console.log('Body length:', buf.length);
console.log('First 16 bytes:', buf.slice(0,16).toString('hex'));
const isHtml = buf.slice(0,15).toString().includes('<');
console.log('Is HTML:', isHtml);
if (!isHtml && buf.length > 10000) {
  console.log('\n✅ CloudFront URL is directly accessible from Manus sandbox!');
  console.log('Magic bytes:', buf.slice(0,4).toString('hex'));
  // Check if it is a real SWF (FWS or CWS or ZWS)
  const magic = buf.slice(0,3).toString('ascii');
  console.log('SWF magic:', magic, '(FWS=uncompressed, CWS=zlib, ZWS=lzma)');
} else {
  console.log('Body preview:', buf.slice(0,200).toString());
}
