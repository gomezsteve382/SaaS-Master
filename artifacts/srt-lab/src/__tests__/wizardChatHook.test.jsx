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
    sessionStorage.clear();
    /* The wizard now defaults to a simplified guided view; the persistent
     * chat panel only mounts when "Advanced" is on. Pre-flip the per-scope
     * sessionStorage flag so renderWizard() boots straight into advanced
     * mode and the ChatPanel under test is in the DOM. */
    sessionStorage.setItem(`srt-advanced:wizard:${SCOPE}`, '1');
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

  it('rolls back the empty assistant placeholder when the stream emits an error frame mid-flight', async () => {
    /* Server creates the conv, then streams an `error:` frame BEFORE
     * any content chunks — the placeholder assistant bubble has no text
     * yet, so the rollback in useChatStream's catch block must drop it.
     * The hook contract:
     *   • surface the error via the `error` state
     *   • drop the trailing *empty* assistant bubble — otherwise the
     *     user sees a silent dead reply that looks like Claude went
     *     mute, with no way to tell apart from a slow stream
     *   • keep the user's own message visible so they can edit & retry. */
    global.fetch = vi.fn(async (url, init) => {
      if (String(url).endsWith('/anthropic/conversations') && init?.method === 'POST') {
        return jsonResponse(201, { id: 202, title: 'New chat', scope: SCOPE });
      }
      if (String(url).match(/\/anthropic\/conversations\/202\/messages$/)) {
        const enc = new TextEncoder();
        const body = new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(`data: ${JSON.stringify({ error: 'rate_limited: backoff 30s' })}\n`));
            c.close();
          },
        });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      throw new Error('unexpected ' + url + ' ' + init?.method);
    });

    renderWizard();
    const textarea = await screen.findByPlaceholderText(/Ask about this mismatch/i);
    fireEvent.change(textarea, { target: { value: 'why is BCM mismatched?' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    /* Error message surfaces in the UI. */
    await waitFor(() => expect(screen.getByText(/rate_limited: backoff 30s/)).toBeTruthy());
    /* User message is preserved so the user can edit & retry. */
    expect(screen.getByText('why is BCM mismatched?')).toBeTruthy();
    /* Streaming flag must be off and the input re-enabled — a stuck
     * `streaming=true` would silently swallow the next Enter keypress
     * and look like the wizard had hung. */
    expect(textarea.disabled).toBe(false);
    /* Direct rollback assertion: the placeholder assistant bubble
     * (avatar emoji '🤖') is rendered once per assistant message AND
     * once in the chat header. After rollback there should be zero
     * assistant messages, so exactly ONE '🤖' remains in the DOM
     * (the header). The user's own avatar '👤' should appear exactly
     * once (their preserved prompt). */
    const text = document.body.textContent || '';
    const robots = (text.match(/🤖/g) || []).length;
    const users = (text.match(/👤/g) || []).length;
    expect(robots).toBe(1); /* header only — no assistant bubble */
    expect(users).toBe(1);  /* one preserved user message */
  });

  it('keeps hydrated=false on transient hydrate failure so autoGreet does not fork a new conversation', async () => {
    /* Pointer present, but the GET fails with 500. The hook must NOT
     * mark the session hydrated — otherwise the autoGreet effect would
     * fire, POST a brand-new /conversations, and orphan the saved one. */
    localStorage.setItem(KEY, '77');
    const calls = [];
    global.fetch = vi.fn(async (url, init) => {
      calls.push({ url: String(url), method: init?.method || 'GET' });
      return new Response('boom', { status: 500 });
    });

    /* Provide issues+modules so MismatchWizard internally computes a
     * non-null autoGreet. With autoGreet set, the only thing preventing
     * a fork is hydrated staying false. */
    renderWizard({ issues: ['BCM SEC16 mismatch'], modules: ['BCM'] });
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    /* Give React a few ticks to (incorrectly) fire any auto-greet effect. */
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });

    /* Crucial invariant: no POST to /conversations was made. */
    const createCalls = calls.filter(c => c.url.endsWith('/anthropic/conversations') && c.method === 'POST');
    expect(createCalls.length).toBe(0);
    /* Pointer is untouched (validated separately above) and the resumed
     * pill never appeared because hydration didn't complete. */
    expect(localStorage.getItem(KEY)).toBe('77');
    expect(screen.queryByTestId('wizard-chat-resumed-pill')).toBeNull();
  });

  it('shows a Retry button on transient hydrate failure and re-hydrates against the saved pointer when clicked', async () => {
    /* First GET fails 500 → header shows Retry button + error message;
     * pointer is preserved (covered separately). Click Retry → second
     * GET returns 200 with the saved messages → resumed pill appears,
     * messages render, and the error banner disappears. The wizard is
     * never remounted. */
    localStorage.setItem(KEY, '55');
    let getCalls = 0;
    global.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith('/anthropic/conversations/55')) {
        getCalls += 1;
        if (getCalls === 1) return new Response('boom', { status: 500 });
        return jsonResponse(200, {
          id: 55, title: 'recovered', scope: SCOPE,
          messages: [{ role: 'user', content: 'saved question' }],
        });
      }
      throw new Error('unexpected ' + url);
    });

    renderWizard();

    /* Header surfaces a clear, clickable Retry control alongside the error. */
    const retryBtn = await screen.findByTestId('wizard-chat-hydrate-retry-btn');
    expect(retryBtn).toBeTruthy();
    expect(screen.getByTestId('wizard-chat-hydrate-error')).toBeTruthy();
    /* Pointer survived the failure so retry can target the same conversation. */
    expect(localStorage.getItem(KEY)).toBe('55');

    fireEvent.click(retryBtn);

    /* Second GET is issued against the same id and succeeds. */
    await waitFor(() => expect(getCalls).toBe(2));
    /* Saved messages render and the resumed pill confirms recovery. */
    await waitFor(() => expect(screen.getByText('saved question')).toBeTruthy());
    expect(screen.getByTestId('wizard-chat-resumed-pill')).toBeTruthy();
    /* Error banner is gone now that hydration completed. */
    expect(screen.queryByTestId('wizard-chat-hydrate-error')).toBeNull();
  });

  it('switching to a past session updates the localStorage pointer to that session id', async () => {
    /* Start with no pointer ⇒ chat boots empty. Open Past Sessions,
     * server returns one prior chat, click it ⇒ pointer should now
     * reference the switched-to id, not the absent original. */
    global.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/anthropic/conversations?scope=')) {
        return jsonResponse(200, [
          { id: 88, title: 'older chat', scope: SCOPE, createdAt: Date.now() - 60_000 },
        ]);
      }
      if (u.endsWith('/anthropic/conversations/88')) {
        return jsonResponse(200, {
          id: 88, title: 'older chat', scope: SCOPE,
          messages: [{ role: 'user', content: 'older question' }],
        });
      }
      throw new Error('unexpected ' + url);
    });

    renderWizard();
    /* Wait for hydrated empty state */
    await screen.findByPlaceholderText(/Ask about this mismatch/i);
    expect(localStorage.getItem(KEY)).toBeNull();

    fireEvent.click(screen.getByTestId('wizard-chat-past-sessions-btn'));
    /* Wait for the past-session row to appear, then click it. */
    const row = await screen.findByTestId('wizard-chat-past-session-88');
    fireEvent.click(row);

    await waitFor(() => expect(localStorage.getItem(KEY)).toBe('88'));
    /* And the switched-in conversation messages render. */
    expect(screen.getByText('older question')).toBeTruthy();
  });

  it('deleting the currently-active session clears the localStorage pointer for this scope only', async () => {
    /* Active session #11 is hydrated from the pointer. Open Past
     * Sessions, delete that same id ⇒ deleteSession() detects
     * convIdRef.current === id and triggers startNewSession(), which
     * must remove only the THIS-scope pointer (not any sibling scope's
     * pointer). */
    localStorage.setItem(KEY, '11');
    /* Sibling scope's pointer must survive a delete in the test scope. */
    localStorage.setItem('srt-wizard-last-conv:modsync:test-vehicle', '999');

    let listCallCount = 0;
    global.fetch = vi.fn(async (url, init) => {
      const u = String(url);
      const method = init?.method || 'GET';
      if (u.endsWith('/anthropic/conversations/11') && method === 'DELETE') {
        /* Must use a `null` body — `new Response('', {status: 204})` throws
         * in jsdom because 204 responses cannot have a body. Earlier
         * iterations of this test silently swallowed that throw, masking
         * the assertion. */
        return new Response(null, { status: 204 });
      }
      if (u.endsWith('/anthropic/conversations/11')) {
        return jsonResponse(200, {
          id: 11, title: 'current', scope: SCOPE,
          messages: [{ role: 'user', content: 'q1' }],
        });
      }
      if (u.includes('/anthropic/conversations?scope=')) {
        listCallCount += 1;
        /* First load shows the active session; after delete the list is empty. */
        if (listCallCount === 1) {
          return jsonResponse(200, [{ id: 11, title: 'current', scope: SCOPE, createdAt: Date.now() }]);
        }
        return jsonResponse(200, []);
      }
      throw new Error('unexpected ' + url + ' ' + method);
    });

    /* Auto-confirm the destructive prompt. */
    const origConfirm = window.confirm;
    window.confirm = () => true;

    try {
      renderWizard();
      await waitFor(() => expect(screen.getByText('q1')).toBeTruthy());

      fireEvent.click(screen.getByTestId('wizard-chat-past-sessions-btn'));
      const row = await screen.findByTestId('wizard-chat-past-session-11');
      const trash = row.querySelector('button[title="Delete this chat"]');
      expect(trash).toBeTruthy();
      await act(async () => { fireEvent.click(trash); });

      await waitFor(() => expect(localStorage.getItem(KEY)).toBeNull());
      /* Sibling scope's pointer is untouched — scope isolation must hold
       * even through destructive ops. */
      expect(localStorage.getItem('srt-wizard-last-conv:modsync:test-vehicle')).toBe('999');
      /* Active conversation is cleared from view. */
      expect(screen.queryByText('q1')).toBeNull();
    } finally {
      window.confirm = origConfirm;
    }
  });

  it('skips malformed SSE frames without killing the stream', async () => {
    /* The stream parser must tolerate a garbage `data:` line and still
     * apply subsequent valid content frames. This guards against a
     * single bad chunk poisoning the rest of an Anthropic response. */
    global.fetch = vi.fn(async (url, init) => {
      if (String(url).endsWith('/anthropic/conversations') && init?.method === 'POST') {
        return jsonResponse(201, { id: 303, title: 'New chat', scope: SCOPE });
      }
      if (String(url).match(/\/anthropic\/conversations\/303\/messages$/)) {
        const enc = new TextEncoder();
        const body = new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(`data: {not json\n`));
            c.enqueue(enc.encode(`data: ${JSON.stringify({ content: 'hello ' })}\n`));
            c.enqueue(enc.encode(`data: ${JSON.stringify({ content: 'world' })}\n`));
            c.enqueue(enc.encode(`data: ${JSON.stringify({ done: true })}\n`));
            c.close();
          },
        });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      throw new Error('unexpected ' + url);
    });

    renderWizard();
    const textarea = await screen.findByPlaceholderText(/Ask about this mismatch/i);
    fireEvent.change(textarea, { target: { value: 'hi' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => expect(screen.getByText('hello world')).toBeTruthy());
  });

  it('shows pastError when Past sessions list endpoint returns a 500', async () => {
    /* Open "Past sessions ▾" while the list endpoint is hard-down.
     * refreshPastSessions() must surface the failure into pastError so
     * the user sees a "✗ HTTP 500" message instead of a perpetual
     * "Loading…" spinner that hides the outage. */
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/anthropic/conversations?scope=')) {
        return new Response('boom', { status: 500 });
      }
      throw new Error('unexpected ' + url);
    });

    renderWizard();
    await screen.findByPlaceholderText(/Ask about this mismatch/i);

    fireEvent.click(screen.getByTestId('wizard-chat-past-sessions-btn'));

    /* Error text rendered with the leading ✗ marker. */
    await waitFor(() => expect(screen.getByText(/✗ HTTP 500/)).toBeTruthy());
    /* "Loading…" placeholder must NOT be visible alongside the error —
     * the render guards `pastSessions === null && !pastError`, so a
     * regression that leaves pastSessions=null on failure would surface
     * here as a duplicate Loading row. */
    expect(screen.queryByText(/Loading…/)).toBeNull();
  });

  it('"↻ refresh" after the server recovers populates the list and clears the error', async () => {
    /* First list call fails (500), second call (after the user clicks
     * "↻ refresh") succeeds and returns one session. The error banner
     * must disappear and the recovered session row must render. */
    let listCallCount = 0;
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/anthropic/conversations?scope=')) {
        listCallCount += 1;
        if (listCallCount === 1) return new Response('boom', { status: 500 });
        return jsonResponse(200, [
          { id: 55, title: 'recovered chat', scope: SCOPE, createdAt: Date.now() - 30_000 },
        ]);
      }
      throw new Error('unexpected ' + url);
    });

    renderWizard();
    await screen.findByPlaceholderText(/Ask about this mismatch/i);

    fireEvent.click(screen.getByTestId('wizard-chat-past-sessions-btn'));
    await waitFor(() => expect(screen.getByText(/✗ HTTP 500/)).toBeTruthy());

    /* Locate the "↻ refresh" button inside the panel and click it. */
    const panel = screen.getByTestId('wizard-chat-past-sessions-panel');
    const refreshBtn = Array.from(panel.querySelectorAll('button')).find(
      b => /refresh/i.test(b.textContent || '')
    );
    expect(refreshBtn).toBeTruthy();
    fireEvent.click(refreshBtn);

    /* Recovered row appears and the error banner is gone. */
    await waitFor(() => expect(screen.getByTestId('wizard-chat-past-session-55')).toBeTruthy());
    expect(screen.queryByText(/✗ HTTP 500/)).toBeNull();
    expect(screen.getByText('recovered chat')).toBeTruthy();
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
