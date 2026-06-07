import aesjsImport from 'aes-js';

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

function aesCbcDecryptBytes(cipherBytes, keyBytes, ivBytes, {stripPadding=true}={}){
  if(!aesjs?.ModeOfOperation?.cbc) throw new Error('AES-CBC implementation is unavailable in the browser bundle.');
  if(!(cipherBytes?.length) || cipherBytes.length % 16 !== 0) throw new Error('AES-CBC ciphertext length must be a non-zero multiple of 16 bytes.');
  if(![16,24,32].includes(keyBytes?.length || 0)) throw new Error('AES key must be 16, 24, or 32 bytes.');
  if((ivBytes?.length || 0) !== 16) throw new Error('AES-CBC IV must be exactly 16 bytes.');
  const cbc = new aesjs.ModeOfOperation.cbc(Array.from(keyBytes), Array.from(ivBytes));
  const decrypted = Uint8Array.from(cbc.decrypt(Array.from(cipherBytes)));
  return stripPadding ? stripPkcs7(decrypted) : decrypted;
}

function decodePlaintext(bytes){
  const text = UTF8_DECODER.decode(bytes || new Uint8Array());
  return text.replace(/\u0000+$/g,'');
}

async function derivePbkdf2KeyBytes(password, saltBytes, iterations=1000, hash='SHA-1', keyBits=128){
  if(!globalThis.crypto?.subtle) throw new Error('PBKDF2 requires Web Crypto support in this browser.');
  const material = await globalThis.crypto.subtle.importKey('raw', UTF8.encode(String(password || '')), 'PBKDF2', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits({name:'PBKDF2', salt:saltBytes, iterations:Number(iterations) || 1000, hash}, material, Number(keyBits) || 128);
  return new Uint8Array(bits);
}

async function decryptPbkdf2AesCbc({cipherBytes,password,saltBytes,ivBytes,iterations=1000,hash='SHA-1',keyBits=128,stripPadding=true}){
  const keyBytes = await derivePbkdf2KeyBytes(password, saltBytes, iterations, hash, keyBits);
  const plainBytes = aesCbcDecryptBytes(cipherBytes, keyBytes, ivBytes, {stripPadding});
  return {keyBytes, plainBytes, plaintext:decodePlaintext(plainBytes), plaintextHex:bytesToHex(plainBytes)};
}

const HTTP_TRAFFIC_KEY_HEX = '92A37213F50DF30D1783EDC3F30D6DD3';
const HTTP_TRAFFIC_IV_HEX = '90212351DF2FE34F08013CA1E34FBC91';
const EHTML_LOG_KEY_HEX = '351671435E75217F9CA5A11D218EBD09';
const CONFIG_PASSWORD = '1(3(r3@m$@ndw1ch';

export {
  CONFIG_PASSWORD,
  EHTML_LOG_KEY_HEX,
  HTTP_TRAFFIC_IV_HEX,
  HTTP_TRAFFIC_KEY_HEX,
  aesCbcDecryptBytes,
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  decodeCipherInput,
  decodePlaintext,
  decryptPbkdf2AesCbc,
  derivePbkdf2KeyBytes,
  hexToBytes,
  stripPkcs7,
};
