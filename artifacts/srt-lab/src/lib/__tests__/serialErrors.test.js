/* serialErrors — unit coverage for the friendly Web Serial recovery helpers
   added in #161. The module is the single chokepoint every tab uses to
   open a serial port; getting the classification wrong sends a tech down
   the wrong recovery path (e.g. "reload and re-grant" when really another
   app holds the port). These tests pin the classification table AND the
   port lifecycle (cleanup-on-fail, reuse-vs-repick, disconnect listener
   match-by-port). navigator.serial is stubbed per-test. */

import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {
  classifySerialError,
  cleanupPort,
  getReusablePort,
  requestNewPort,
  openSerialPort,
  onPortDisconnect,
} from '../serialErrors.js';

/* Build a fake DOMException-ish error. JSDOM-less node has no DOMException
   but the classifier only reads .name and .message, so an Object literal
   with a custom `name` is enough. */
function err(name, message){
  const e = new Error(message);
  e.name = name;
  return e;
}

/* Minimal navigator.serial stub. Each test installs the methods it needs
   and restores in afterEach so tests don't leak state. Node 22 makes
   `navigator` a getter on globalThis, so we have to defineProperty
   instead of assigning directly. */
let originalDescriptor;
function installNavigator(serial){
  if (originalDescriptor === undefined) {
    originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator') || null;
  }
  Object.defineProperty(globalThis, 'navigator', {
    value: serial === undefined ? undefined : { serial },
    configurable: true,
    writable: true,
  });
}
function uninstallNavigator(){
  if (originalDescriptor) Object.defineProperty(globalThis, 'navigator', originalDescriptor);
  else delete globalThis.navigator;
  originalDescriptor = undefined;
}

describe('classifySerialError', () => {
  it('cancelled (NotFoundError from picker)', () => {
    const r = classifySerialError(err('NotFoundError', 'No port selected by the user.'));
    expect(r.kind).toBe('cancelled');
    expect(r.repickRequired).toBe(true);
    expect(r.friendly).toMatch(/pick the OBD adapter/);
  });

  it('cancelled (message-based fallback when name is generic)', () => {
    const r = classifySerialError(err('Error', 'No port was selected'));
    expect(r.kind).toBe('cancelled');
  });

  it('already_open (InvalidStateError)', () => {
    const r = classifySerialError(err('InvalidStateError', 'The port is already open.'));
    expect(r.kind).toBe('already_open');
    expect(r.repickRequired).toBe(false);
    expect(r.friendly).toMatch(/already open in this tab/);
  });

  it('disconnected (cable yanked between requestPort and open)', () => {
    const r = classifySerialError(err('Error', 'The device has been lost.'));
    expect(r.kind).toBe('disconnected');
    expect(r.friendly).toMatch(/re-plug/);
  });

  it('busy (NetworkError on Linux/Mac)', () => {
    const r = classifySerialError(err('NetworkError', 'Failed to open serial port.'));
    expect(r.kind).toBe('busy');
    expect(r.repickRequired).toBe(false);
    expect(r.friendly).toMatch(/Arduino IDE|other SRT Lab tabs/);
  });

  it('busy (Windows reports "Access denied" when another app holds the port)', () => {
    /* This is the classification trap that prompted the comment in
       serialErrors.js — Windows says "Access denied" for busy-locks but
       the obvious branch for that string is SecurityError → permission.
       If this test ever flips to "permission" the tech will be told to
       reload and re-grant when the real fix is to close OBDLink/Arduino. */
    const r = classifySerialError(err('Error', 'Access denied.'));
    expect(r.kind).toBe('busy');
  });

  it('busy (resource busy / in use / generic busy keyword)', () => {
    expect(classifySerialError(err('Error', 'resource busy')).kind).toBe('busy');
    expect(classifySerialError(err('Error', 'Port is in use')).kind).toBe('busy');
  });

  it('permission (SecurityError with no busy keywords)', () => {
    const r = classifySerialError(err('SecurityError', 'Permission denied by policy.'));
    expect(r.kind).toBe('permission');
    expect(r.repickRequired).toBe(true);
    expect(r.friendly).toMatch(/Reload the page/);
  });

  it('generic fallback for unknown errors', () => {
    const r = classifySerialError(err('WeirdError', 'something exploded'));
    expect(r.kind).toBe('generic');
    expect(r.friendly).toMatch(/something exploded/);
  });

  it('tolerates non-Error inputs (null / string)', () => {
    expect(classifySerialError(null).kind).toBe('generic');
    expect(classifySerialError('boom').kind).toBe('generic');
    expect(classifySerialError(undefined).kind).toBe('generic');
  });
});

describe('cleanupPort', () => {
  it('handles all-null inputs without throwing', async () => {
    await expect(cleanupPort(null, null, null)).resolves.toBeUndefined();
  });

  it('releases reader/writer locks and closes the port in order', async () => {
    const calls = [];
    const reader = {
      cancel: vi.fn(async () => { calls.push('reader.cancel'); }),
      releaseLock: vi.fn(() => { calls.push('reader.release'); }),
    };
    const writer = {
      close: vi.fn(async () => { calls.push('writer.close'); }),
      releaseLock: vi.fn(() => { calls.push('writer.release'); }),
    };
    const port = { close: vi.fn(async () => { calls.push('port.close'); }) };
    await cleanupPort(port, reader, writer);
    expect(calls).toEqual([
      'reader.cancel', 'reader.release',
      'writer.close',  'writer.release',
      'port.close',
    ]);
  });

  it('swallows individual step failures so later steps still run', async () => {
    const calls = [];
    const reader = {
      cancel: vi.fn(async () => { throw new Error('cancel-fail'); }),
      releaseLock: vi.fn(() => { calls.push('reader.release'); }),
    };
    const writer = {
      close: vi.fn(async () => { throw new Error('writer-fail'); }),
      releaseLock: vi.fn(() => { calls.push('writer.release'); }),
    };
    const port = { close: vi.fn(async () => { calls.push('port.close'); }) };
    await expect(cleanupPort(port, reader, writer)).resolves.toBeUndefined();
    // releaseLock + port.close still ran even though cancel/writer.close threw.
    expect(calls).toEqual(['reader.release', 'writer.release', 'port.close']);
  });
});

describe('getReusablePort', () => {
  afterEach(uninstallNavigator);

  it('returns null when navigator.serial is unavailable', async () => {
    installNavigator(undefined);
    expect(await getReusablePort()).toBeNull();
  });

  it('returns the first previously-granted port', async () => {
    const port = {id:'A'};
    installNavigator({ getPorts: vi.fn(async () => [port, {id:'B'}]) });
    expect(await getReusablePort()).toBe(port);
  });

  it('returns null when no ports have been granted yet', async () => {
    installNavigator({ getPorts: vi.fn(async () => []) });
    expect(await getReusablePort()).toBeNull();
  });

  it('returns null when getPorts throws (browser policy revoked)', async () => {
    installNavigator({ getPorts: vi.fn(async () => { throw new Error('blocked'); }) });
    expect(await getReusablePort()).toBeNull();
  });
});

describe('requestNewPort', () => {
  afterEach(uninstallNavigator);

  it('throws a NotSupportedError when Web Serial is missing', async () => {
    installNavigator(undefined);
    await expect(requestNewPort()).rejects.toMatchObject({ name: 'NotSupportedError' });
  });

  it('proxies through to navigator.serial.requestPort', async () => {
    const port = {id:'picked'};
    const requestPort = vi.fn(async () => port);
    installNavigator({ requestPort });
    expect(await requestNewPort()).toBe(port);
    expect(requestPort).toHaveBeenCalledOnce();
  });
});

describe('openSerialPort', () => {
  afterEach(uninstallNavigator);

  it('reports unsupported and never throws when navigator.serial is missing', async () => {
    installNavigator(undefined);
    const log = vi.fn();
    const r = await openSerialPort({ addLog: log });
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe('unsupported');
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/Web Serial not supported/), 'error');
  });

  it('reuses a previously-granted port (no picker prompt) when reusePort is true', async () => {
    const port = { open: vi.fn(async () => {}), close: vi.fn() };
    const requestPort = vi.fn(async () => { throw new Error('should not be called'); });
    installNavigator({
      getPorts: vi.fn(async () => [port]),
      requestPort,
    });
    const r = await openSerialPort({ baudRate: 38400 });
    expect(r.ok).toBe(true);
    expect(r.port).toBe(port);
    expect(port.open).toHaveBeenCalledWith({ baudRate: 38400 });
    expect(requestPort).not.toHaveBeenCalled();
  });

  it('forceRepick bypasses the cached port and re-prompts the picker', async () => {
    const cached = { id:'cached', open: vi.fn(async () => {}) };
    const fresh = { id:'fresh', open: vi.fn(async () => {}) };
    installNavigator({
      getPorts: vi.fn(async () => [cached]),
      requestPort: vi.fn(async () => fresh),
    });
    const r = await openSerialPort({ forceRepick: true });
    expect(r.ok).toBe(true);
    expect(r.port).toBe(fresh);
    expect(cached.open).not.toHaveBeenCalled();
    expect(fresh.open).toHaveBeenCalledOnce();
  });

  it('reusePort=false ignores the cached port and prompts the picker', async () => {
    const cached = { id:'cached', open: vi.fn(async () => {}) };
    const fresh = { id:'fresh', open: vi.fn(async () => {}) };
    installNavigator({
      getPorts: vi.fn(async () => [cached]),
      requestPort: vi.fn(async () => fresh),
    });
    const r = await openSerialPort({ reusePort: false });
    expect(r.ok).toBe(true);
    expect(r.port).toBe(fresh);
    expect(cached.open).not.toHaveBeenCalled();
  });

  it('falls through to the picker when no port has been previously granted', async () => {
    const fresh = { id:'fresh', open: vi.fn(async () => {}) };
    installNavigator({
      getPorts: vi.fn(async () => []),
      requestPort: vi.fn(async () => fresh),
    });
    const r = await openSerialPort({});
    expect(r.ok).toBe(true);
    expect(r.port).toBe(fresh);
  });

  it('classifies a busy error and cleans up the half-opened port', async () => {
    const closeSpy = vi.fn(async () => {});
    const port = {
      open: vi.fn(async () => { throw err('NetworkError', 'Failed to open serial port.'); }),
      close: closeSpy,
    };
    installNavigator({
      getPorts: vi.fn(async () => [port]),
      requestPort: vi.fn(),
    });
    const log = vi.fn();
    const r = await openSerialPort({ addLog: log });
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe('busy');
    expect(r.error.port).toBe(port);
    expect(closeSpy).toHaveBeenCalled(); // half-open cleanup
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/Serial port is busy/), 'error');
  });

  it('classifies cancellation as a warn-level log (not error)', async () => {
    installNavigator({
      getPorts: vi.fn(async () => []),
      requestPort: vi.fn(async () => { throw err('NotFoundError', 'No port selected.'); }),
    });
    const log = vi.fn();
    const r = await openSerialPort({ addLog: log });
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe('cancelled');
    expect(log).toHaveBeenCalledWith(expect.any(String), 'warn');
  });

  it('never throws even when port.close() also throws during cleanup', async () => {
    const port = {
      open: vi.fn(async () => { throw err('NetworkError', 'busy'); }),
      close: vi.fn(async () => { throw new Error('close also failed'); }),
    };
    installNavigator({
      getPorts: vi.fn(async () => [port]),
      requestPort: vi.fn(),
    });
    await expect(openSerialPort({})).resolves.toMatchObject({ ok: false });
  });
});

describe('onPortDisconnect', () => {
  afterEach(uninstallNavigator);

  it('returns a no-op unsubscribe when navigator.serial is missing', () => {
    installNavigator(undefined);
    const off = onPortDisconnect({}, () => {});
    expect(typeof off).toBe('function');
    expect(() => off()).not.toThrow();
  });

  it('fires the callback only for the matching port (e.target shape)', () => {
    const listeners = [];
    installNavigator({
      addEventListener: (name, h) => { if (name === 'disconnect') listeners.push(h); },
      removeEventListener: (name, h) => {
        const i = listeners.indexOf(h); if (i >= 0) listeners.splice(i, 1);
      },
    });
    const port = { id:'mine' };
    const other = { id:'other' };
    const cb = vi.fn();
    const off = onPortDisconnect(port, cb);
    listeners[0]({ target: other });
    expect(cb).not.toHaveBeenCalled();
    listeners[0]({ target: port });
    expect(cb).toHaveBeenCalledOnce();
    off();
    expect(listeners.length).toBe(0);
  });

  it('also matches when the event uses e.port (polyfill shape)', () => {
    const listeners = [];
    installNavigator({
      addEventListener: (n, h) => { if (n === 'disconnect') listeners.push(h); },
      removeEventListener: () => {},
    });
    const port = { id:'mine' };
    const cb = vi.fn();
    onPortDisconnect(port, cb);
    listeners[0]({ port });
    expect(cb).toHaveBeenCalledOnce();
  });

  it('with port=null, fires for every disconnect (used by global handlers)', () => {
    const listeners = [];
    installNavigator({
      addEventListener: (n, h) => { if (n === 'disconnect') listeners.push(h); },
      removeEventListener: () => {},
    });
    const cb = vi.fn();
    onPortDisconnect(null, cb);
    listeners[0]({ target: { id:'A' } });
    listeners[0]({ target: { id:'B' } });
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('a throwing callback does not break the listener', () => {
    const listeners = [];
    installNavigator({
      addEventListener: (n, h) => { if (n === 'disconnect') listeners.push(h); },
      removeEventListener: () => {},
    });
    const cb = vi.fn(() => { throw new Error('boom'); });
    onPortDisconnect(null, cb);
    expect(() => listeners[0]({ target: {} })).not.toThrow();
    expect(cb).toHaveBeenCalled();
  });
});
