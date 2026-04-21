/* SHA-256 checksum helpers for module backup integrity.
   Uses the Web Crypto API (window.crypto.subtle) — async, no dependencies.
   Works on any Uint8Array or flat number array of bytes. */

export async function sha256Hex(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const hashBuf = await window.crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* Concatenate every non-missing DID's raw bytes from a backup's dids map.
   The resulting Uint8Array is the canonical input for the backup checksum. */
export function backupDidsToBytes(dids) {
  const all = [];
  for (const data of Object.values(dids || {})) {
    if (!data.missing && Array.isArray(data.bytes) && data.bytes.length > 0) {
      all.push(...data.bytes);
    }
  }
  return new Uint8Array(all);
}
