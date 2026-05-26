import React, { useEffect, useState, useCallback } from "react";
import { fetchDownloadCount, trackDownload, subscribeDownloadCount, getCachedCount } from "./downloadAssets.js";
import { C } from "./constants.js";

export function useDownloadCount(assetId) {
  const [count, setCount] = useState(() => getCachedCount(assetId));
  useEffect(() => {
    let alive = true;
    fetchDownloadCount(assetId).then(n => { if (alive) setCount(n); });
    const unsub = subscribeDownloadCount(assetId, n => { if (alive) setCount(n); });
    return () => { alive = false; unsub(); };
  }, [assetId]);
  const track = useCallback(() => trackDownload(assetId), [assetId]);
  return [count, track];
}

/**
 * Tiny inline counter chip for use next to a download button.
 */
export function DownloadCounter({ assetId, style }) {
  const [count] = useDownloadCount(assetId);
  if (count <= 0) return null;
  return (
    <span style={{
      fontSize: 10, color: C.tm, letterSpacing: 0.3, fontWeight: 600,
      ...style,
    }}>
      ⬇ {count.toLocaleString()} download{count === 1 ? "" : "s"} globally
    </span>
  );
}
