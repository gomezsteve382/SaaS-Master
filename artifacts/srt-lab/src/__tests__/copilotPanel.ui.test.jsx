// @vitest-environment jsdom
//
// UI coverage for the always-available AI Co-pilot panel (CopilotPanel.jsx).
//
// The Co-pilot is now DB-backed: chats persist via the shared conversations
// API (scope="general") so they survive a page refresh. The panel:
//   • renders only when `open`, hides when closed
//   • close button + Escape key + scrim click call onClose
//   • on mount, hydrates the most recent general conversation (localStorage
//     pointer first, falling back to GET /conversations?scope=general)
//   • a send lazily creates a scope="general" conversation, then streams
//     `data: {content}` frames from POST /conversations/:id/messages into an
//     assistant bubble and re-enables the composer when the stream ends
//   • a suggestion chip sends its prompt
//   • "New chat" clears the active conversation (the saved one stays on the
//     server and remains browsable under Past chats)
//   • a mid-stream `data: {error}` frame rolls back the empty assistant
//     placeholder, preserves the user message, surfaces copilot-error, and
//     re-enables the input
//   • a 503 from the messages endpoint shows the "not configured" guidance
//   • closing the panel aborts the in-flight stream (abort-on-close)
//
// fetch + the streaming Response are stubbed; we never hit a real backend.

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';

import CopilotPanel from '../components/CopilotPanel.jsx';

// A ReadableStream that emits the given SSE frames then closes.
function makeStream(frames) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n`));
      c.close();
    },
  });
}

function sse(stream) {
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

// SSE response that streams the given content chunks then a done frame.
function streamingResponse(chunks) {
  return sse(makeStream([...chunks.map((content) => ({ content })), { done: true }]));
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/* Route fetch calls by method + URL the way the persistent panel drives them.
 * Returns { calls } so tests can assert on what was sent. `onMessages` is a
 * factory invoked per POST /:id/messages call (so each gets a fresh stream). */
function installFetch({ list = [], conv = null, onMessages, onCreate } = {}) {
  const calls = [];
  global.fetch = vi.fn(async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ url: u, init, method });

    if (method === 'GET' && /\/anthropic\/conversations\?scope=/.test(u)) {
      return jsonResponse(200, list);
    }
    if (method === 'GET' && /\/anthropic\/conversations\/\d+$/.test(u)) {
      return jsonResponse(200, conv || { id: 1, scope: 'general', title: 'New chat', messages: [] });
    }
    if (method === 'POST' && /\/anthropic\/conversations$/.test(u)) {
      if (onCreate) return onCreate(init);
      return jsonResponse(201, { id: 1, scope: 'general', title: 'New chat' });
    }
    if (method === 'POST' && /\/conversations\/\d+\/messages$/.test(u)) {
      return onMessages ? onMessages(init) : streamingResponse(['ok']);
    }
    if (method === 'DELETE') return new Response(null, { status: 204 });
    return jsonResponse(404, { error: 'not found' });
  });
  return { calls };
}

const messagesCall = (calls) => calls.find((c) => /\/messages$/.test(c.url));

let originalFetch;

beforeEach(() => {
  originalFetch = global.fetch;
  try { localStorage.clear(); } catch { /* ignore */ }
  // Safe default so a mount's hydration never hits a real network.
  global.fetch = vi.fn(async () => jsonResponse(200, []));
});

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
  try { localStorage.clear(); } catch { /* ignore */ }
  vi.restoreAllMocks();
});

describe('CopilotPanel — visibility', () => {
  it('renders nothing when closed', () => {
    render(<CopilotPanel open={false} onClose={() => {}} />);
    expect(screen.queryByTestId('copilot-panel')).toBeNull();
  });

  it('renders the panel and composer when open', () => {
    render(<CopilotPanel open onClose={() => {}} />);
    expect(screen.getByTestId('copilot-panel')).toBeTruthy();
    expect(screen.getByTestId('copilot-input')).toBeTruthy();
    expect(screen.getByTestId('copilot-send')).toBeTruthy();
  });
});

describe('CopilotPanel — close affordances', () => {
  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(<CopilotPanel open onClose={onClose} />);
    fireEvent.click(screen.getByTestId('copilot-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose on Escape', () => {
    const onClose = vi.fn();
    render(<CopilotPanel open onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('CopilotPanel — hydration', () => {
  it('restores the most recent general conversation on mount', async () => {
    installFetch({
      list: [{ id: 7, scope: 'general', title: 'Prior chat', createdAt: Date.now() }],
      conv: {
        id: 7,
        scope: 'general',
        title: 'Prior chat',
        messages: [
          { role: 'user', content: 'earlier question' },
          { role: 'assistant', content: 'earlier answer' },
        ],
      },
    });

    render(<CopilotPanel open onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByTestId('copilot-msg-user').textContent).toBe('earlier question'),
    );
    expect(screen.getByTestId('copilot-msg-assistant').textContent).toBe('earlier answer');
  });

  it('ignores a stale pointer that resolves to a non-general conversation', async () => {
    try { localStorage.setItem('srt-copilot-last-conv', '99'); } catch { /* ignore */ }
    const { calls } = installFetch({
      list: [],
      // GET /conversations/99 returns a module-assistant chat — must be rejected.
      conv: { id: 99, scope: 'workspace:dodge-charger', title: 'IMMO', messages: [{ role: 'user', content: 'leaked' }] },
    });

    render(<CopilotPanel open onClose={() => {}} />);

    // Falls back to the (empty) general list, so the leaked message never shows
    // and the empty-state suggestions render instead.
    await waitFor(() => expect(screen.getAllByTestId('copilot-suggestion').length).toBeGreaterThan(0));
    expect(screen.queryByTestId('copilot-msg-user')).toBeNull();
    // It did attempt the pointer, then the scoped list fallback.
    expect(calls.some((c) => /\/conversations\/99$/.test(c.url))).toBe(true);
    expect(calls.some((c) => /\/conversations\?scope=general$/.test(c.url))).toBe(true);
  });
});

describe('CopilotPanel — streaming a reply', () => {
  it('streams content into an assistant bubble and re-enables the composer', async () => {
    const { calls } = installFetch({
      list: [],
      onMessages: () => streamingResponse(['Hello ', 'world']),
    });

    render(<CopilotPanel open onClose={() => {}} />);
    const input = screen.getByTestId('copilot-input');
    fireEvent.change(input, { target: { value: 'hi there' } });
    fireEvent.click(screen.getByTestId('copilot-send'));

    // User message renders immediately.
    expect(screen.getByTestId('copilot-msg-user').textContent).toBe('hi there');

    // Assistant reply accumulates from the streamed chunks.
    await waitFor(() =>
      expect(screen.getByTestId('copilot-msg-assistant').textContent).toBe('Hello world'),
    );

    // A scoped conversation was created, then the turn POSTed to its messages
    // endpoint with the user content in the body.
    expect(calls.some((c) => c.method === 'POST' && /\/anthropic\/conversations$/.test(c.url))).toBe(true);
    const msgCall = messagesCall(calls);
    expect(msgCall).toBeTruthy();
    expect(JSON.parse(msgCall.init.body)).toEqual({ content: 'hi there' });

    // Composer cleared + re-enabled.
    expect(input.value).toBe('');
  });

  it('sends a suggestion chip prompt', async () => {
    const { calls } = installFetch({
      list: [],
      onMessages: () => streamingResponse(['answer']),
    });

    render(<CopilotPanel open onClose={() => {}} />);
    const chips = await screen.findAllByTestId('copilot-suggestion');
    fireEvent.click(chips[0]);

    await waitFor(() =>
      expect(screen.getByTestId('copilot-msg-assistant').textContent).toBe('answer'),
    );
    const msgCall = messagesCall(calls);
    expect(JSON.parse(msgCall.init.body).content).toBe(chips[0].textContent);
  });
});

describe('CopilotPanel — new chat', () => {
  it('clears the conversation when New chat is clicked', async () => {
    installFetch({ list: [], onMessages: () => streamingResponse(['done']) });

    render(<CopilotPanel open onClose={() => {}} />);
    fireEvent.change(screen.getByTestId('copilot-input'), { target: { value: 'q' } });
    fireEvent.click(screen.getByTestId('copilot-send'));
    await waitFor(() => expect(screen.getByTestId('copilot-msg-assistant')).toBeTruthy());

    fireEvent.click(screen.getByTestId('copilot-new'));
    expect(screen.queryByTestId('copilot-msg-user')).toBeNull();
    expect(screen.queryByTestId('copilot-msg-assistant')).toBeNull();
  });
});

describe('CopilotPanel — error handling', () => {
  it('rolls back the empty assistant bubble on a mid-stream error frame', async () => {
    installFetch({
      list: [],
      onMessages: () => sse(makeStream([{ error: 'rate_limited: backoff 30s' }])),
    });

    render(<CopilotPanel open onClose={() => {}} />);
    const input = screen.getByTestId('copilot-input');
    fireEvent.change(input, { target: { value: 'why mismatch?' } });
    fireEvent.click(screen.getByTestId('copilot-send'));

    // Error surfaces in the dedicated banner.
    await waitFor(() =>
      expect(screen.getByTestId('copilot-error').textContent).toMatch(/rate_limited/),
    );
    // User message is preserved so the user can edit & retry.
    expect(screen.getByTestId('copilot-msg-user').textContent).toBe('why mismatch?');
    // The empty assistant placeholder was dropped — no assistant bubble remains.
    expect(screen.queryByTestId('copilot-msg-assistant')).toBeNull();
    // Composer is re-enabled after the failure.
    expect(input.disabled).toBeFalsy();
  });

  it('shows the not-configured guidance on a 503 from the messages endpoint', async () => {
    installFetch({
      list: [],
      onMessages: () => jsonResponse(503, { error: 'AI service unavailable' }),
    });

    render(<CopilotPanel open onClose={() => {}} />);
    fireEvent.change(screen.getByTestId('copilot-input'), { target: { value: 'hi' } });
    fireEvent.click(screen.getByTestId('copilot-send'));

    await waitFor(() =>
      expect(screen.getByTestId('copilot-error').textContent).toMatch(/not configured/i),
    );
    // The failed request drops the empty assistant placeholder too.
    expect(screen.queryByTestId('copilot-msg-assistant')).toBeNull();
  });
});

describe('CopilotPanel — abort on close', () => {
  it('aborts the in-flight fetch when the panel is closed', async () => {
    let capturedSignal;
    // The messages POST never completes, so the stream is genuinely in-flight
    // when we close. The create POST resolves normally first.
    installFetch({
      list: [],
      onMessages: (init) => {
        capturedSignal = init.signal;
        const body = new ReadableStream({ start() { /* never closes */ } });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      },
    });

    const { rerender } = render(<CopilotPanel open onClose={() => {}} />);
    fireEvent.change(screen.getByTestId('copilot-input'), { target: { value: 'long task' } });
    fireEvent.click(screen.getByTestId('copilot-send'));

    await waitFor(() => expect(capturedSignal).toBeTruthy());
    expect(capturedSignal.aborted).toBe(false);

    // Closing the panel should abort the open stream via the cleanup effect.
    rerender(<CopilotPanel open={false} onClose={() => {}} />);
    await waitFor(() => expect(capturedSignal.aborted).toBe(true));
  });
});
