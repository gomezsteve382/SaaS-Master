/**
 * S3 storage helper using the built-in Forge storage API.
 * Uses multipart/form-data as required by the Forge /v1/storage/upload endpoint.
 */
import FormData from "form-data";

const FORGE_API_URL = process.env.BUILT_IN_FORGE_API_URL || "";
const FORGE_API_KEY = process.env.BUILT_IN_FORGE_API_KEY || "";

export interface StorageResult {
  key: string;
  url: string;
}

/**
 * Upload a binary buffer to S3 storage via the Forge API.
 * Returns the storage key and URL for accessing the file.
 */
export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType: string = "application/octet-stream"
): Promise<StorageResult> {
  if (!FORGE_API_URL || !FORGE_API_KEY) {
    console.warn("[storage] Forge API not configured — file bytes not persisted to S3");
    return { key: relKey, url: `/manus-storage/${relKey}` };
  }

  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
  const filename = relKey.split("/").pop() || "file.bin";

  const fd = new FormData();
  fd.append("file", buffer, { filename, contentType });
  fd.append("path", relKey);

  const response = await fetch(`${FORGE_API_URL}/v1/storage/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${FORGE_API_KEY}`,
      ...fd.getHeaders(),
    },
    body: fd.getBuffer(),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`[storage] Upload failed (${response.status}): ${text}`);
    // Don't fail the whole upload — analysis result is still valuable
    return { key: relKey, url: `/manus-storage/${relKey}` };
  }

  const result = (await response.json()) as any;
  return {
    key: result.key || relKey,
    url: result.url || `/manus-storage/${relKey}`,
  };
}

/**
 * Get a presigned URL for downloading a file from S3 storage.
 * Falls back to the /manus-storage/ path if Forge API is not configured.
 */
export async function storageGet(
  relKey: string,
  expiresIn: number = 3600
): Promise<StorageResult> {
  if (!FORGE_API_URL || !FORGE_API_KEY) {
    return { key: relKey, url: `/manus-storage/${relKey}` };
  }

  const response = await fetch(
    `${FORGE_API_URL}/v1/storage/url?key=${encodeURIComponent(relKey)}&expires_in=${expiresIn}`,
    {
      headers: { Authorization: `Bearer ${FORGE_API_KEY}` },
    }
  );

  if (!response.ok) {
    // Fall back to direct path
    return { key: relKey, url: `/manus-storage/${relKey}` };
  }

  const result = (await response.json()) as any;
  return {
    key: relKey,
    url: result.url || `/manus-storage/${relKey}`,
  };
}
