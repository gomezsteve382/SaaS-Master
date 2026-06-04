/* Friendly Web Serial error classification + port lifecycle helpers.

   Browsers throw the same generic `Failed to execute 'open' on 'SerialPort':
   Failed to open serial port.` for every flavor of "can't open" — the port
   is held by another tab/app, the cable was unplugged, the OS denied access,
   the user hit Cancel on the picker. Without classification the tech sees
   one cryptic error and has no idea which one happened. This module maps
   those cases to specific, plain-English messages and a one-click recovery
   path. Used by initAdapter.js, obdEngine.js, and the OBD/Bench/Swarm tabs
   that roll their own connect logic. */

/** Classify a thrown DOMException / Error from requestPort/open into a
    structured friendly error.
    Returns { kind, friendly, repickRequired }
      kind — 'cancelled' | 'busy' | 'disconnected' | 'permission'
             | 'already_open' | 'unsupported' | 'generic'
      friendly — sentence the user should actually see
      repickRequired — true when Retry alone won't help (need requestPort)
*/
export function classifySerialError(e) {
  const name = (e && e.name) || '';
  const msg = String((e && e.message) || e || '').toLowerCase();

  // User hit Cancel on the chooser, or no port was selected.
  if (name === 'NotFoundError' || /no port (was )?selected|user cancel/.test(msg)) {
    return {
      kind: 'cancelled',
      friendly: 'No port selected — pick the OBD adapter from the browser dialog and try again.',
      repickRequired: true,
    };
  }
  // Port is already open in this same page (we never released it).
  if (name === 'InvalidStateError' || /already open/.test(msg)) {
    return {
      kind: 'already_open',
      friendly: 'This serial port is already open in this tab. Click Disconnect first, then reconnect.',
      repickRequired: false,
    };
  }
  // Cable yanked between requestPort and open, or device went away mid-session.
  if (/disconnect|no longer|device.*lost|not found|gone/.test(msg)) {
    return {
      kind: 'disconnected',
      friendly: 'Adapter is disconnected — re-plug the OBD cable, then click Retry.',
      repickRequired: false,
    };
  }
  // The big one: another app/tab is holding the port. Chrome reports this as
  // a NetworkError on Linux/Mac, a generic "Failed to open serial port" on
  // Windows, and sometimes "Access denied" / "resource busy" / "in use"
  // depending on platform. Importantly: Windows surfaces a busy-lock as
  // "Access denied" — we MUST classify those as busy (close-the-other-app)
  // before falling through to the SecurityError branch (reload-and-re-grant),
  // otherwise the tech is sent down the wrong recovery path.
  if (
    name === 'NetworkError' ||
    /failed to open serial port|access (is )?denied|resource busy|in use|busy/.test(msg)
  ) {
    return {
      kind: 'busy',
      friendly:
        'Serial port is busy — close any other app or browser tab using the adapter ' +
        '(Arduino IDE, PuTTY, OBDLink app, other SRT Lab tabs), then click Retry.',
      repickRequired: false,
    };
  }
  // Permission revoked / SecurityError — only after the busy check, so that
  // Windows "Access denied" busy-locks aren't misrouted here.
  if (name === 'SecurityError' || /\bsecurity\b|permission/.test(msg)) {
    return {
      kind: 'permission',
      friendly: 'Browser blocked access to the serial port. Reload the page and re-grant permission when prompted.',
      repickRequired: true,
    };
  }
  return {
    kind: 'generic',
    friendly: 'Adapter init failed: ' + ((e && e.message) || e),
    repickRequired: false,
  };
}

/** Release every lock on a (possibly half-opened) port. Safe to call on
    null / partially-acquired handles. Always awaits, never throws. */
export async function cleanupPort(port, reader, writer) {
  try { await reader?.cancel(); } catch { /* ignore */ }
  try { reader?.releaseLock(); }   catch { /* ignore */ }
  try { await writer?.close(); }   catch { /* ignore */ }
  try { writer?.releaseLock(); }   catch { /* ignore */ }
  try { await port?.close(); }     catch { /* ignore */ }
}

/** Return the first port the user has previously granted to this origin,
    or null. Used for Retry without re-prompting. */
export async function getReusablePort() {
  if (typeof navigator === 'undefined' || !navigator.serial) return null;
  try {
    const ports = await navigator.serial.getPorts();
    return (ports && ports[0]) || null;
  } catch { return null; }
}

/** Open the picker and return the chosen SerialPort. Throws on cancel. */
export async function requestNewPort() {
  if (typeof navigator === 'undefined' || !navigator.serial) {
    const err = new Error('Web Serial not supported');
    err.name = 'NotSupportedError';
    throw err;
  }
  return navigator.serial.requestPort();
}

/** Wrap the requestPort + open() flow with classification, cleanup of any
    half-opened state, and an option to reuse the previously-granted port
    (so Retry doesn't force the user to re-pick after closing the conflicting
    app). Returns { ok, port?, error? }. Never throws. */
export async function openSerialPort({
  addLog,
  baudRate = 115200,
  reusePort = true,
  forceRepick = false,
} = {}) {
  if (typeof navigator === 'undefined' || !navigator.serial) {
    const error = {
      kind: 'unsupported',
      friendly: 'Web Serial not supported in this browser — use Chrome or Edge.',
      repickRequired: false,
    };
    addLog?.(error.friendly, 'error');
    return { ok: false, error };
  }
  let port = null;
  try {
    if (!forceRepick && reusePort) {
      port = await getReusablePort();
    }
    if (!port) {
      port = await requestNewPort();
    }
    await port.open({ baudRate });
    return { ok: true, port };
  } catch (e) {
    const cls = classifySerialError(e);
    addLog?.(cls.friendly, cls.kind === 'cancelled' ? 'warn' : 'error');
    // Best-effort: a port that threw on open() may be in a weird half-open
    // state. close() will no-op if it never opened.
    try { await port?.close?.(); } catch { /* ignore */ }
    return { ok: false, error: { ...cls, port } };
  }
}

/** Subscribe to navigator.serial 'disconnect' events for a specific port.
    Returns an unsubscribe function. The callback fires when the cable is
    yanked mid-session for the given port (or any port, if `port` is null). */
export function onPortDisconnect(port, cb) {
  if (typeof navigator === 'undefined' || !navigator.serial) return () => {};
  const handler = (e) => {
    // The event's `target` is the SerialPort that disconnected on Chrome;
    // some polyfills put it on `e.port`. Match either.
    if (!port || e.target === port || e.port === port) {
      try { cb(e); } catch { /* ignore */ }
    }
  };
  try { navigator.serial.addEventListener('disconnect', handler); } catch { /* ignore */ }
  return () => {
    try { navigator.serial.removeEventListener('disconnect', handler); } catch { /* ignore */ }
  };
}
