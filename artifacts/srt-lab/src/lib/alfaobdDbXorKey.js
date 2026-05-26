// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-db-xor-key.bin (1024 bytes).
// Run `node scripts/generate-alfaobd-db-xor-key.mjs` to regenerate.
//
// 1024-byte repeating XOR key recovered from the AlfaOBD SQLite catalog DB
// via Kasiski autocorrelation (51x random spike at period 1024) + SQLite
// header/B-tree constraint cracking. The recovered key is ~90-95% correct:
// the first 100 bytes (SQLite header) are guaranteed correct, text data
// throughout the DB decrypts cleanly, but ~5-10% of bytes at hot-variance
// offsets may still need refinement. Numeric integer columns (like the
// fgaipcroutines routine IDs table) are still corrupted by the residual
// errors.
//
// Source: alfaobd-complete-package-with-dbs.zip (received 2026-05-25).

const KEY_BASE64 = [
  "cD8TcQ+ZDBIMHvOL3DqUjJABsVtAkr3phbBCjDDiG/VNzruAJFtoR91qG/Qof69YgghAuKv942Xf",
  "Uh6/dg0WW85smboXnzICzbX63Q2PKzqKH1UVlrLOz+VFEixf+IbT0Cj/U6+17E1c5a91pz6SrvnV",
  "+uRqVaa0ggLsIdcspiqJd10wX0hI7S+UazwnLclaU2LX61K/XSsILcrPMgQShD8gWbEBZG214KCO",
  "Ft2mdWMonFzjprTkhXaBGoUq93d3aDn8iobEbEl/XN+DjJXvgJygmPP/QW8q9iUMLFkxJcAxP/2w",
  "7oeakHsWsIFouVpzEVgsNDBeap2FwxJSVymfau96kdbkWowgDsnX/rlkcoKDPfXQS6lI4WHZhNLd",
  "0M/n0DLcEm+Wiufily1tTdxUMCB1psRpKbuiMMXRWeTqLcKTvWgkBTdQLhpQoSuGRatP8XIdcBsm",
  "iCoRlTiaWht86Gm7Etw8/KSUjkob3ZkVb+KPaitRaSRT9mjME2immjUmoSEjzfxQECILO6egcGZd",
  "ioTgl2plls3jz76wajv62s6CmGiWx6aaOozlyX3IhoT8Hz0d5JLvM5RvwEY0NowA33/y31Dv9OBn",
  "p+rmsSxFKeZvsF3JGLarGwJ+oDW5RAwwXL9p7FhRF3OyOd2LcC82ROUlv/0P7ZCdNWEWRcWqxLZJ",
  "OAZESDZyRI2BQnMx3JMAnPLmv/aBdsJ7jh6TCQnpAX03XAixoVEKUn4IJT87X5tIuc8mSwAmjL8F",
  "RI5Mt4ARZv28UkiMgxjHzrAOxQDf0nV/qa43DRsXL/aCaELcuNUoH54o5BNqEy7ecf7LiqIzZoC2",
  "Z5h1yOGDyEIwqUmKbrlN8PRMBEED4poPkBdxDgLzlmcJ9zSMpwTcxfLEMt9g1BfrAcGYwF1m2bVz",
  "6+7I4flneGSOB4L2xyiLNshwzd/Bjy6SKrI50axVcGh0pM7uqvy2Nn1qRYQ6dKlbh6nMlEwq80P8",
  "U7U5KyIuq4KvsyqBhx/5FsTm81kPZ0rKrzxmuthG1lO2oojc9uv0amZE7vhfPrOj8EWGL0j8owwQ",
  "6+nJgU5TXrt2r+ClmFVrv4fLXyA8BJ8FtM4z2n7DKWoPMIne0AETJnHnAltmuDIZI7SaAysi6jTK",
  "6bNhHjQbHjwZRz8SUcjsqoXN58pkwL44ak9Q90tkDgNh8Q1oM7z4TGXMcdOGoxbe3TqwpH+ubV60",
  "zA3raKyFdoJdcy/olwn4epRcaIdmisAtRXNLX50U9sjFYGwdpgtPZSmbU7pA1x/cq5KPW/grLbwt",
  "yablj6lK3b3fhNW6qdyTGxJ8/qkaF8UnzwRu6WHcFL7HATtVAgm7o+hSJRKfMDNh2UER0OEPMQ==",
].join("");

/** The 1024-byte XOR key as a Uint8Array. */
export const ALFAOBD_DB_XOR_KEY = new Uint8Array(
  atob(KEY_BASE64)
    .split("")
    .map((c) => c.charCodeAt(0))
);

/** Decrypt an AlfaOBD SQLite .db file by XORing with the 1024-byte repeating key. */
export function decryptAlfaobdDb(ciphertext) {
  const out = new Uint8Array(ciphertext.length);
  for (let i = 0; i < ciphertext.length; i++) {
    out[i] = ciphertext[i] ^ ALFAOBD_DB_XOR_KEY[i % 1024];
  }
  return out;
}

export const ALFAOBD_DB_XOR_KEY_META = {
  byteLength: 1024,
  recoveryMethod: "Kasiski autocorrelation + SQLite-page structural constraints",
  accuracy: "~90-95% (first 100 bytes guaranteed; text data clean; numeric ints partially corrupted)",
  validatedAgainst: "alfaobd_encrypted_may3.db (68224000 bytes = 66625 * 1024 pages)",
  source: "attached_assets/alfaobd-db-xor-key.bin",
};
