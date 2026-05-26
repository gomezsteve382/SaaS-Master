const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

export function rewriteApiPath(input: string): string {
  if (BASE && input.startsWith("/api/")) {
    return BASE + input;
  }
  if (BASE && input === "/api") {
    return BASE + "/api";
  }
  return input;
}

export function installApiBaseFetchPatch(): void {
  if (typeof window === "undefined" || !BASE) return;
  const w = window as Window & { __srtlabuApiBasePatched?: boolean };
  if (w.__srtlabuApiBasePatched) return;
  w.__srtlabuApiBasePatched = true;

  const originalFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === "string") {
      return originalFetch(rewriteApiPath(input), init);
    }
    if (input instanceof URL) {
      if (input.origin === window.location.origin) {
        const rewritten = rewriteApiPath(input.pathname + input.search + input.hash);
        if (rewritten !== input.pathname + input.search + input.hash) {
          return originalFetch(window.location.origin + rewritten, init);
        }
      }
      return originalFetch(input, init);
    }
    const url = input.url;
    try {
      const u = new URL(url, window.location.origin);
      if (u.origin === window.location.origin) {
        const rewritten = rewriteApiPath(u.pathname + u.search + u.hash);
        if (rewritten !== u.pathname + u.search + u.hash) {
          return originalFetch(new Request(window.location.origin + rewritten, input), init);
        }
      }
    } catch {
      // fall through
    }
    return originalFetch(input, init);
  }) as typeof window.fetch;
}
