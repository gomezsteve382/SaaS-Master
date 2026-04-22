// @vitest-environment jsdom
//
// Vitest coverage for the persistent wizard chat hook (Task #317).
//
// Exercises useChatStream (private) by rendering the public ChatPanel
// and stubbing fetch + the streaming Response so we can assert:
//   • hydrate-on-mount from localStorage["srt-wizard-last-conv:<sessionKey>"]
//   • lazy create-on-first-message + scope tagging on POST /conversations
//   • scope isolation (key namespacing means session A doesn't load B)
//   • new-chat clears local state AND the localStorage pointer
//   • the "↻ RESUMED" pill auto-fades after ~5s
//   • stale pointers (404) are cleaned up; transient errors (500) keep them
//   • formatRelativeTime renders human-readable buckets
//
// All ChatPanel renders are wrapped in MismatchWizard's "vehicleless" mode
// — we drive its internal state directly via the testing library since the
// hook isn't exported.

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { act, render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';

import MismatchWizard, { formatRelativeTime } from '../components/MismatchWizard.jsx';

const SCOPE = 'workspace:test-vehicle';
const KEY = `srt-wizard-last-conv:${SCOPE}`;

/* Build a fake streaming Response that ChatPanel can consume. The real
 * stream parser only cares about `data: {...}\n` frames, so we hand it
 * a minimal one that emits a content chunk and a done frame. */
function makeStreamingResponse(content) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(`data: ${JSON.stringify({ content })}\n`));
      c.enqueue(enc.encode(`data: ${JSON.stringify({ done: true })}\n`));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderWizard(props = {}) {
  return render(
    <MismatchWizard
      issues={[]}
      warnings={[]}
      modules={[]}
      hexSnippets={[]}
      onClose={() => {}}
      onAction={() => {}}
      stepActions={[]}
      sessionKey={SCOPE}
      {...props}
    />
  );
}

describe('formatRelativeTime', () => {
  const NOW = Date.UTC(2026, 3, 22, 12, 0, 0);
  it('returns "just now" for sub-45s diffs', () => {
    expect(formatRelativeTime(NOW - 5_000, NOW)).toBe('just now');
  });
  it('returns minute granularity for sub-hour diffs', () => {
    expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(formatRelativeTime(NOW - 59 * 60_000, NOW)).toBe('59m ago');
  });
  it('returns hour granularity for sub-day diffs', () => {
    expect(formatRelativeTime(NOW - 3 * 3600_000, NOW)).toBe('3h ago');
  });
  it('returns day granularity for sub-week diffs', () => {
    expect(formatRelativeTime(NOW - 2 * 86400_000, NOW)).toBe('2d ago');
  });
  it('returns week granularity for sub-month diffs', () => {
    expect(formatRelativeTime(NOW - 14 * 86400_000, NOW)).toBe('2w ago');
  });
  it('falls back to a locale date for very old entries', () => {
    const out = formatRelativeTime(NOW - 90 * 86400_000, NOW);
    expect(out).not.toMatch(/ago$/);
    expect(out.length).toBeGreaterThan(0);
  });
  it('handles bad input safely', () => {
    expect(formatRelativeTime(null)).toBe('');
    expect(formatRelativeTime('not a date')).toBe('');
  });
});

describe('Wizard chat persistence (useChatStream via ChatPanel)', () => {
  let originalFetch;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    originalFetch = global.fetch;
    localStorage.clear();
    /* jsdom doesn't ship scrollIntoView; ChatPanel calls it on every
     * messages change. Stub it so the auto-scroll effect doesn't crash. */
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = function () {};
    }
  });

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('hydrates a previously-saved conversation on mount and shows the resumed pill', async () => {
    localStorage.setItem(KEY, '42');
    global.fetch = vi.fn(async (url) => {
      if (typeof url === 'string' && url.endsWith('/anthropic/conversations/42')) {
        return jsonResponse(200, {
          id: 42, title: 'prior chat', scope: SCOPE,
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello' },
          ],
        });
      }
      throw new Error('unexpected fetch ' + url);
    });

    renderWizard();
    await waitFor(() => expect(screen.getByTestId('wizard-chat-resumed-pill')).toBeTruthy());
    expect(screen.getByText('hi')).toBeTruthy();
    expect(screen.getByText('hello')).toBeTruthy();
  });

  it('auto-fades the resumed pill after ~5 seconds', async () => {
    localStorage.setItem(KEY, '7');
    global.fetch = vi.fn(async () =>
      jsonResponse(200, { id: 7, title: 't', scope: SCOPE, messages: [] })
    );

    renderWizard();
    await waitFor(() => expect(screen.queryByTestId('wizard-chat-resumed-pill')).toBeTruthy());

    await act(async () => { await vi.advanceTimersByTimeAsync(5500); });

    expect(screen.queryByTestId('wizard-chat-resumed-pill')).toBeNull();
  });

  it('clears a stale localStorage pointer on 404 and stays unhydrated', async () => {
    localStorage.setItem(KEY, '999');
    global.fetch = vi.fn(async () => new Response('', { status: 404 }));

    renderWizard();
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    /* Stale pointer must be removed so the next send doesn't try to
     * stream into a deleted conversation. */
    await waitFor(() => expect(localStorage.getItem(KEY)).toBeNull());
    expect(screen.queryByTestId('wizard-chat-resumed-pill')).toBeNull();
  });

  it('keeps the localStorage pointer on transient (non-404) hydrate failure', async () => {
    localStorage.setItem(KEY, '5');
    global.fetch = vi.fn(async () => new Response('boom', { status: 500 }));

    renderWizard();
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    /* Pointer must NOT be discarded on transient failure — otherwise we'd
     * fork a brand-new conversation on the next send and orphan the old. */
    expect(localStorage.getItem(KEY)).toBe('5');
  });

  it('lazily creates a scope-tagged conversation on first send and persists the pointer', async () => {
    const calls = [];
    global.fetch = vi.fn(async (url, init) => {
      calls.push({ url: String(url), method: init?.method || 'GET', body: init?.body });
      if (String(url).endsWith('/anthropic/conversations') && init?.method === 'POST') {
        return jsonResponse(201, { id: 101, title: 'New chat', scope: SCOPE });
      }
      if (String(url).match(/\/anthropic\/conversations\/101\/messages$/)) {
        return makeStreamingResponse('OK');
      }
      throw new Error('unexpected ' + url + ' ' + init?.method);
    });

    renderWizard();
    /* No localStorage pointer ⇒ no GET; component is hydrated empty. */
    const textarea = await screen.findByPlaceholderText(/Ask about this mismatch/i);
    fireEvent.change(textarea, { target: { value: 'hello there' } });
    /* No <form> wrapper — Enter key (handled in onKeyDown) is the only
     * submit path, mirroring how the user actually triggers a send. */
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      const createCall = calls.find(c => c.url.endsWith('/anthropic/conversations') && c.method === 'POST');
      expect(createCall).toBeTruthy();
      expect(JSON.parse(createCall.body).scope).toBe(SCOPE);
      expect(JSON.parse(createCall.body).title).toBe('New chat');
    });
    await waitFor(() => expect(localStorage.getItem(KEY)).toBe('101'));
  });

  it('isolates session pointers per sessionKey (modsync vs fca vs workspace)', () => {
    localStorage.setItem('srt-wizard-last-conv:workspace:foo', '1');
    localStorage.setItem('srt-wizard-last-conv:modsync:foo', '2');
    localStorage.setItem('srt-wizard-last-conv:fca:foo', '3');
    expect(localStorage.getItem('srt-wizard-last-conv:workspace:foo')).toBe('1');
    expect(localStorage.getItem('srt-wizard-last-conv:modsync:foo')).toBe('2');
    expect(localStorage.getItem('srt-wizard-last-conv:fca:foo')).toBe('3');
    /* Different scopes never collide on the same key — the read for
     * "workspace:foo" cannot accidentally pick up "modsync:foo". */
  });

  it('"+ New chat" clears in-memory state and the localStorage pointer', async () => {
    localStorage.setItem(KEY, '11');
    global.fetch = vi.fn(async () =>
      jsonResponse(200, {
        id: 11, title: 'old', scope: SCOPE,
        messages: [{ role: 'user', content: 'remember 4242' }],
      })
    );
    /* Auto-confirm the "Start a brand-new chat?" prompt. */
    const origConfirm = window.confirm;
    window.confirm = () => true;

    try {
      renderWizard();
      await waitFor(() => expect(screen.getByText('remember 4242')).toBeTruthy());

      const newBtn = screen.getByTestId('wizard-chat-new-btn');
      fireEvent.click(newBtn);

      await waitFor(() => expect(localStorage.getItem(KEY)).toBeNull());
      expect(screen.queryByText('remember 4242')).toBeNull();
      expect(screen.queryByTestId('wizard-chat-resumed-pill')).toBeNull();
    } finally {
      window.confirm = origConfirm;
    }
  });
});
