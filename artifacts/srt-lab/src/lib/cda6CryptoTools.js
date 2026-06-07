import aesjsImport from 'aes-js';
import CryptoJS from 'crypto-js';

const aesjs = aesjsImport?.default || aesjsImport;
const UTF8 = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', {fatal:false});

function bytesToHex(bytes){
  return Array.from(bytes || [], (value)=>Number(value).toString(16).padStart(2,'0')).join('').toUpperCase();
}

function hexToBytes(hex){
  const clean = String(hex || '').replace(/^0x/i,'').replace(/[^0-9a-fA-F]/g,'');
  if(clean.length % 2 !== 0) throw new Error('Hex input must contain an even number of hex characters.');
  const out = new Uint8Array(clean.length / 2);
  for(let index=0; index<out.length; index+=1){
    out[index] = parseInt(clean.slice(index*2, index*2+2), 16);
  }
  return out;
}

function base64ToBytes(base64){
  const clean = String(base64 || '').trim().replace(/\s+/g,'');
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for(let index=0; index<binary.length; index+=1) out[index] = binary.charCodeAt(index);
  return out;
}

function bytesToBase64(bytes){
  let binary = '';
  for(const byte of bytes || []) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeCipherInput(input, encoding='auto'){
  const value = String(input || '').trim();
  if(!value) return new Uint8Array();
  if(encoding === 'hex') return hexToBytes(value);
  if(encoding === 'base64') return base64ToBytes(value);
  const compact = value.replace(/\s+/g,'');
  if(/^(0x)?[0-9a-fA-F\s:-]+$/.test(value) && compact.replace(/^0x/i,'').replace(/[:-]/g,'').length % 2 === 0){
    return hexToBytes(value);
  }
  return base64ToBytes(value);
}

function stripPkcs7(bytes){
  if(!bytes.length) return bytes;
  const pad = bytes[bytes.length - 1];
  if(pad < 1 || pad > 16 || pad > bytes.length) return bytes;
  for(let index=bytes.length-pad; index<bytes.length; index+=1){
    if(bytes[index] !== pad) return bytes;
  }
  return bytes.slice(0, bytes.length - pad);
}

function stripNullPadding(bytes){
  let end = bytes?.length || 0;
  while(end > 0 && bytes[end - 1] === 0) end -= 1;
  return bytes.slice(0, end);
}

function applyPaddingMode(bytes, padding='pkcs7'){
  if(padding === false || padding === 'none') return bytes;
  if(padding === 'null' || padding === 'zero') return stripNullPadding(bytes);
  return stripPkcs7(bytes);
}

function aesCbcDecryptBytes(cipherBytes, keyBytes, ivBytes, {stripPadding=true, padding}={}){
  if(!aesjs?.ModeOfOperation?.cbc) throw new Error('AES-CBC implementation is unavailable in the browser bundle.');
  if(!(cipherBytes?.length) || cipherBytes.length % 16 !== 0) throw new Error('AES-CBC ciphertext length must be a non-zero multiple of 16 bytes.');
  if(![16,24,32].includes(keyBytes?.length || 0)) throw new Error('AES key must be 16, 24, or 32 bytes.');
  if((ivBytes?.length || 0) !== 16) throw new Error('AES-CBC IV must be exactly 16 bytes.');
  const cbc = new aesjs.ModeOfOperation.cbc(Array.from(keyBytes), Array.from(ivBytes));
  const decrypted = Uint8Array.from(cbc.decrypt(Array.from(cipherBytes)));
  if(stripPadding === false) return decrypted;
  return applyPaddingMode(decrypted, padding || 'pkcs7');
}

function aesEcbDecryptBytes(cipherBytes, keyBytes, {stripPadding=true, padding='pkcs7'}={}){
  if(!aesjs?.ModeOfOperation?.ecb) throw new Error('AES-ECB implementation is unavailable in the browser bundle.');
  if(!(cipherBytes?.length) || cipherBytes.length % 16 !== 0) throw new Error('AES-ECB ciphertext length must be a non-zero multiple of 16 bytes.');
  if(![16,24,32].includes(keyBytes?.length || 0)) throw new Error('AES key must be 16, 24, or 32 bytes.');
  const ecb = new aesjs.ModeOfOperation.ecb(Array.from(keyBytes));
  const decrypted = Uint8Array.from(ecb.decrypt(Array.from(cipherBytes)));
  if(stripPadding === false) return decrypted;
  return applyPaddingMode(decrypted, padding);
}

function decodePlaintext(bytes){
  const text = UTF8_DECODER.decode(bytes || new Uint8Array());
  return text.replace(/\u0000+$/g,'');
}

function wordArrayToBytes(wordArray){
  const out = new Uint8Array(wordArray.sigBytes);
  for(let index=0; index<wordArray.sigBytes; index+=1){
    out[index] = (wordArray.words[index >>> 2] >>> (24 - (index % 4) * 8)) & 0xff;
  }
  return out;
}

function deriveCdaConfigKeyBytes(password=CONFIG_PASSWORD){
  return wordArrayToBytes(CryptoJS.MD5(CryptoJS.enc.Utf8.parse(String(password || ''))));
}

function decryptCdaConfigBytes(cipherBytes, password=CONFIG_PASSWORD){
  const keyBytes = deriveCdaConfigKeyBytes(password);
  const plainBytes = aesEcbDecryptBytes(cipherBytes, keyBytes, {padding:'pkcs7'});
  return {keyBytes, plainBytes, plaintext:decodePlaintext(plainBytes), plaintextHex:bytesToHex(plainBytes)};
}

async function derivePbkdf2KeyBytes(password, saltBytes, iterations=1000, hash='SHA-1', keyBits=128){
  if(!globalThis.crypto?.subtle) throw new Error('PBKDF2 requires Web Crypto support in this browser.');
  const material = await globalThis.crypto.subtle.importKey('raw', UTF8.encode(String(password || '')), 'PBKDF2', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits({name:'PBKDF2', salt:saltBytes, iterations:Number(iterations) || 1000, hash}, material, Number(keyBits) || 128);
  return new Uint8Array(bits);
}

async function decryptPbkdf2AesCbc({cipherBytes,password,saltBytes,ivBytes,iterations=1000,hash='SHA-1',keyBits=128,stripPadding=true,padding='pkcs7'}){
  const keyBytes = await derivePbkdf2KeyBytes(password, saltBytes, iterations, hash, keyBits);
  const plainBytes = aesCbcDecryptBytes(cipherBytes, keyBytes, ivBytes, {stripPadding,padding});
  return {keyBytes, plainBytes, plaintext:decodePlaintext(plainBytes), plaintextHex:bytesToHex(plainBytes)};
}

const HTTP_TRAFFIC_KEY_HEX = '92A37213F50DF30D1783EDC3F30D6DD3';
const HTTP_TRAFFIC_IV_HEX = '90212351DF2FE34F08013CA1E34FBC91';
const EHTML_LOG_KEY_HEX = '351671435E75217F9CA5A11D218EBD09';
const EHTML_LOG_IV_HEX = 'E0EF3A7BAA3CFED196384784E41BBC1E';
const CONFIG_PASSWORD = '1(3(r3@m$@ndw1ch';
const CONFIG_KEY_HEX = bytesToHex(deriveCdaConfigKeyBytes(CONFIG_PASSWORD));

export {
  CONFIG_KEY_HEX,
  CONFIG_PASSWORD,
  EHTML_LOG_IV_HEX,
  EHTML_LOG_KEY_HEX,
  HTTP_TRAFFIC_IV_HEX,
  HTTP_TRAFFIC_KEY_HEX,
  aesCbcDecryptBytes,
  aesEcbDecryptBytes,
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  decodeCipherInput,
  decodePlaintext,
  decryptCdaConfigBytes,
  decryptPbkdf2AesCbc,
  deriveCdaConfigKeyBytes,
  derivePbkdf2KeyBytes,
  hexToBytes,
  stripNullPadding,
  stripPkcs7,
};
