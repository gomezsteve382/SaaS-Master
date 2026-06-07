import aesjsImport from 'aes-js';

const aesjs = aesjsImport?.default || aesjsImport;

const DEFAULT_PASSWORD = '2Simple2Gu3ss';
const SQLITE_MAGIC = new TextEncoder().encode('SQLite format 3\0');

class Cda6CodecError extends Error {
  constructor(message) {
    super(message);
    this.name = 'Cda6CodecError';
  }
}

function bytesToHex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function startsWithSQLiteMagic(bytes) {
  if (!bytes || bytes.length < SQLITE_MAGIC.length) return false;
  for (let index = 0; index < SQLITE_MAGIC.length; index += 1) {
    if (bytes[index] !== SQLITE_MAGIC[index]) return false;
  }
  return true;
}

function parsePassword(password = DEFAULT_PASSWORD) {
  const passwordBytes = new TextEncoder().encode(password);
  let cipherName = 'aes128';
  let prefixLength = 0;
  let keyLength = 16;

  const startsWith = (prefix) => {
    const prefixBytes = new TextEncoder().encode(prefix);
    if (passwordBytes.length <= prefixBytes.length) return false;
    return prefixBytes.every((byte, index) => passwordBytes[index] === byte);
  };

  if (startsWith('rc4:')) {
    cipherName = 'rc4';
    prefixLength = 4;
    keyLength = 256;
  } else if (startsWith('aes128:')) {
    cipherName = 'aes128';
    prefixLength = 7;
    keyLength = 16;
  } else if (startsWith('aes256:')) {
    cipherName = 'aes256';
    prefixLength = 7;
    keyLength = 32;
  }

  const material = passwordBytes.slice(prefixLength, prefixLength + keyLength);
  if (!material.length) {
    throw new Cda6CodecError('Password has no key material after the optional codec prefix.');
  }

  const expanded = new Uint8Array(keyLength);
  for (let index = 0; index < expanded.length; index += 1) {
    expanded[index] = material[index % material.length];
  }

  return { cipherName, key: expanded, keyHex: bytesToHex(expanded) };
}

function detectPageLayout(data, pageSizeOverride, reserveOverride) {
  if (!data || data.length < 24) {
    throw new Cda6CodecError('Input is too small to contain a SQLite database page.');
  }

  let pageSize = pageSizeOverride;
  if (!pageSize) {
    pageSize = (data[16] << 8) | data[17];
    if (pageSize === 1) pageSize = 65536;
  }

  const reserve = reserveOverride ?? data[20];
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) {
    throw new Cda6CodecError(`Invalid or unsupported page size detected: ${pageSize}.`);
  }
  if (reserve < 0 || reserve >= pageSize) {
    throw new Cda6CodecError(`Invalid reserve byte count: ${reserve}.`);
  }
  if (data.length % pageSize !== 0) {
    throw new Cda6CodecError(
      `Input size ${data.length} is not an exact multiple of the detected page size ${pageSize}.`,
    );
  }

  return { pageSize, reserve };
}

function createAesEncryptor(key) {
  if (!aesjs?.ModeOfOperation?.ecb) {
    throw new Cda6CodecError('AES-ECB implementation is unavailable in the browser bundle.');
  }
  const ecb = new aesjs.ModeOfOperation.ecb(Array.from(key));
  return (block) => Uint8Array.from(ecb.encrypt(Array.from(block)));
}

function cryptPage(page, pageNumber, key, pageSize, reserve) {
  const usable = pageSize - reserve;
  const iv = new Uint8Array(16);
  iv[0] = pageNumber & 0xff;
  iv[1] = (pageNumber >>> 8) & 0xff;
  iv[2] = (pageNumber >>> 16) & 0xff;
  iv[3] = (pageNumber >>> 24) & 0xff;
  iv.set(page.slice(usable, usable + Math.min(reserve, 12)), 4);

  const encryptBlock = createAesEncryptor(key);
  const body = new Uint8Array(page.slice(0, usable));
  let block = encryptBlock(iv);

  for (let offset = 0; offset < usable; offset += 16) {
    const blockLength = Math.min(16, usable - offset);
    for (let index = 0; index < blockLength; index += 1) {
      body[offset + index] ^= block[index];
    }
    block = encryptBlock(block);
  }

  if (pageNumber === 1 && usable >= 24) {
    body.set(page.slice(16, 24), 16);
  }

  const output = new Uint8Array(pageSize);
  output.set(body, 0);
  output.set(page.slice(usable, pageSize), usable);
  return output;
}

function decryptCda6Database(inputBytes, options = {}) {
  const data = inputBytes instanceof Uint8Array ? inputBytes : new Uint8Array(inputBytes);
  const { password = DEFAULT_PASSWORD, pageSize: pageSizeOverride, reserve: reserveOverride } = options;
  const { pageSize, reserve } = detectPageLayout(data, pageSizeOverride, reserveOverride);
  const { cipherName, key, keyHex } = parsePassword(password);

  if (cipherName === 'rc4') {
    throw new Cda6CodecError(
      'The recovered CDA6 browser tool implements the AES page codec. The rc4: legacy path was identified in the DLL but is not required for the supplied databases.',
    );
  }

  const output = new Uint8Array(data.length);
  for (let offset = 0; offset < data.length; offset += pageSize) {
    const pageNumber = offset / pageSize + 1;
    output.set(cryptPage(data.slice(offset, offset + pageSize), pageNumber, key, pageSize, reserve), offset);
  }

  return {
    bytes: output,
    cipherName,
    keyHex,
    pageSize,
    reserve,
    sqliteHeaderOk: startsWithSQLiteMagic(output),
  };
}

function prepareCda6DatabaseBytes(inputBytes, options = {}) {
  const data = inputBytes instanceof Uint8Array ? inputBytes : new Uint8Array(inputBytes);
  if (startsWithSQLiteMagic(data)) {
    const { pageSize, reserve } = detectPageLayout(data, options.pageSize, options.reserve);
    const parsed = parsePassword(options.password || DEFAULT_PASSWORD);
    return {
      bytes: data,
      cipherName: parsed.cipherName,
      keyHex: parsed.keyHex,
      pageSize,
      reserve,
      sqliteHeaderOk: true,
      alreadyDecrypted: true,
    };
  }

  return { ...decryptCda6Database(data, options), alreadyDecrypted: false };
}

export {
  Cda6CodecError,
  DEFAULT_PASSWORD,
  SQLITE_MAGIC,
  bytesToHex,
  decryptCda6Database,
  detectPageLayout,
  parsePassword,
  prepareCda6DatabaseBytes,
  startsWithSQLiteMagic,
};
