import { describe, it, expect, beforeEach } from 'vitest';

if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(String(k), String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => { store.clear(); },
    key: (i) => Array.from(store.keys())[i] || null,
    get length() { return store.size; },
  };
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  };
}

import {
  getCurrentTech, setCurrentTech, getRecentTechs, forgetRecentTech,
} from '../techIdentity.js';

beforeEach(() => { localStorage.clear(); });

describe('techIdentity', () => {
  it('returns null when no tech is configured', () => {
    expect(getCurrentTech()).toBeNull();
    expect(getRecentTechs()).toEqual([]);
  });

  it('reads the legacy srtlab_tech key for back-compat', () => {
    localStorage.setItem('srtlab_tech', 'Jordan M.');
    expect(getCurrentTech()).toBe('Jordan M.');
  });

  it('setCurrentTech trims, persists, and prepends to recents', () => {
    setCurrentTech('  Alex Bench  ');
    expect(getCurrentTech()).toBe('Alex Bench');
    expect(getRecentTechs()).toEqual(['Alex Bench']);
  });

  it('switching techs moves the new one to the front of recents and dedupes', () => {
    setCurrentTech('Alex');
    setCurrentTech('Jordan');
    setCurrentTech('Alex'); // already present, should bubble up
    expect(getCurrentTech()).toBe('Alex');
    expect(getRecentTechs()).toEqual(['Alex', 'Jordan']);
  });

  it('case-insensitive dedupe in recents', () => {
    setCurrentTech('Alex');
    setCurrentTech('alex');
    expect(getRecentTechs()).toEqual(['alex']);
  });

  it('passing empty value clears the current tech but keeps recents', () => {
    setCurrentTech('Alex');
    setCurrentTech('Jordan');
    setCurrentTech('');
    expect(getCurrentTech()).toBeNull();
    expect(getRecentTechs()).toEqual(['Jordan', 'Alex']);
  });

  it('forgetRecentTech removes the entry', () => {
    setCurrentTech('Alex');
    setCurrentTech('Jordan');
    forgetRecentTech('Alex');
    expect(getRecentTechs()).toEqual(['Jordan']);
  });

  it('caps recents at 8 entries', () => {
    for (let i = 0; i < 12; i++) setCurrentTech('Tech ' + i);
    const recents = getRecentTechs();
    expect(recents).toHaveLength(8);
    expect(recents[0]).toBe('Tech 11');
  });

  it('truncates absurdly long names to 120 chars', () => {
    const huge = 'X'.repeat(500);
    setCurrentTech(huge);
    expect(getCurrentTech().length).toBe(120);
  });
});
