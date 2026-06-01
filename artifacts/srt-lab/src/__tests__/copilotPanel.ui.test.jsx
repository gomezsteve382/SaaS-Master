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
import { MasterVinContext } from '../lib/masterVinContext.jsx';

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
function installFetch({ list = [], conv = null, onMessages, onToolMessages, onCreate, onPatch } = {}) {
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
    if (method === 'POST' && /\/conversations\/\d+\/tool-messages$/.test(u)) {
      return onToolMessages ? onToolMessages(init) : streamingResponse(['ok']);
    }
    if (method === 'POST' && /\/conversations\/\d+\/messages$/.test(u)) {
      return onMessages ? onMessages(init) : streamingResponse(['ok']);
    }
    if (method === 'PATCH' && /\/anthropic\/conversations\/\d+$/.test(u)) {
      if (onPatch) return onPatch(init);
      const body = JSON.parse(init.body || '{}');
      return jsonResponse(200, { id: 1, scope: 'general', title: body.title });
    }
    if (method === 'DELETE') return new Response(null, { status: 204 });
    return jsonResponse(404, { error: 'not found' });
  });
  return { calls };
}

const messagesCall = (calls) => calls.find((c) => /\/messages$/.test(c.url));
const toolMessagesCall = (calls) => calls.find((c) => /\/tool-messages$/.test(c.url));

/* Minimal MasterVinContext value: the panel only reads vin / vinValid /
 * loadedDumps, so we hand-craft those rather than spin up the real provider. */
function benchValue({ vin = '1C3CDZBT5DN500000', loadedDumps = [] } = {}) {
  return { vin, vinValid: vin.length === 17, loadedDumps };
}

/* A loaded-dump entry shaped like MasterVinContext.addDump output, with real
 * bytes under `mod.data` so the panel can build the binaryBase64 payload. */
function makeDump({ type = 'BCM', filename = 'bcm.bin', bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]) } = {}) {
  return {
    hash: `${type}-${filename}`,
    type,
    name: filename,
    filename,
    size: bytes.length,
    mod: { type, data: bytes, vins: [] },
    addedAt: Date.now(),
    source: 'Dumps tab',
  };
}

function renderWithBench(value, props = {}) {
  return render(
    <MasterVinContext.Provider value={value}>
      <CopilotPanel open onClose={() => {}} {...props} />
    </MasterVinContext.Provider>,
  );
}

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

describe('CopilotPanel — rename a past chat', () => {
  it('PATCHes a new title and reflects it in the list', async () => {
    const { calls } = installFetch({
      list: [{ id: 5, scope: 'general', title: 'Old name', createdAt: Date.now() }],
    });

    render(<CopilotPanel open onClose={() => {}} />);
    // Open the Past chats panel.
    fireEvent.click(screen.getByTestId('copilot-history'));
    await waitFor(() => expect(screen.getByTestId('copilot-past-5')).toBeTruthy());

    // Enter rename mode, type a new title, save.
    fireEvent.click(screen.getByTestId('copilot-past-rename-5'));
    const input = await screen.findByTestId('copilot-past-rename-input-5');
    fireEvent.change(input, { target: { value: 'Charger SEC16 notes' } });
    fireEvent.click(screen.getByTestId('copilot-past-rename-save-5'));

    // The PATCH was sent with the trimmed title.
    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH' && /\/conversations\/5$/.test(c.url));
      expect(patch).toBeTruthy();
      expect(JSON.parse(patch.init.body)).toEqual({ title: 'Charger SEC16 notes' });
    });

    // The list shows the new title and the editor is gone.
    await waitFor(() =>
      expect(screen.getByTestId('copilot-past-5').textContent).toMatch(/Charger SEC16 notes/),
    );
    expect(screen.queryByTestId('copilot-past-rename-input-5')).toBeNull();
  });

  it('cancels rename on Escape without sending a PATCH', async () => {
    const { calls } = installFetch({
      list: [{ id: 8, scope: 'general', title: 'Keep me', createdAt: Date.now() }],
    });

    render(<CopilotPanel open onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('copilot-history'));
    await waitFor(() => expect(screen.getByTestId('copilot-past-8')).toBeTruthy());

    fireEvent.click(screen.getByTestId('copilot-past-rename-8'));
    const input = await screen.findByTestId('copilot-past-rename-input-8');
    fireEvent.change(input, { target: { value: 'discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByTestId('copilot-past-rename-input-8')).toBeNull());
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(screen.getByTestId('copilot-past-8').textContent).toMatch(/Keep me/);
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

describe('CopilotPanel — file attachments', () => {
  it('attaches a text file and folds its contents into the sent message', async () => {
    const { calls } = installFetch({ list: [], onMessages: () => streamingResponse(['ok']) });

    render(<CopilotPanel open onClose={() => {}} />);

    const file = new File(['line one\nline two'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByTestId('copilot-attach-input'), { target: { files: [file] } });

    // A removable chip appears for the attached file.
    await waitFor(() => expect(screen.getByTestId('copilot-attachment').textContent).toMatch(/notes\.txt/));

    fireEvent.change(screen.getByTestId('copilot-input'), { target: { value: 'summarize this' } });
    fireEvent.click(screen.getByTestId('copilot-send'));

    await waitFor(() => expect(messagesCall(calls)).toBeTruthy());
    const body = JSON.parse(messagesCall(calls).init.body);
    expect(body.content).toMatch(/summarize this/);
    expect(body.content).toMatch(/Attached file: notes\.txt/);
    expect(body.content).toMatch(/line one\nline two/);

    // Chip cleared after sending.
    await waitFor(() => expect(screen.queryByTestId('copilot-attachment')).toBeNull());
  });

  it('allows sending with only an attachment (no typed text)', async () => {
    const { calls } = installFetch({ list: [], onMessages: () => streamingResponse(['ok']) });

    render(<CopilotPanel open onClose={() => {}} />);

    // Send is disabled with no text and no attachment.
    expect(screen.getByTestId('copilot-send').disabled).toBe(true);

    const file = new File(['payload'], 'data.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByTestId('copilot-attach-input'), { target: { files: [file] } });

    await waitFor(() => expect(screen.getByTestId('copilot-send').disabled).toBe(false));
    fireEvent.click(screen.getByTestId('copilot-send'));

    await waitFor(() => expect(messagesCall(calls)).toBeTruthy());
    expect(JSON.parse(messagesCall(calls).init.body).content).toMatch(/Attached file: data\.csv/);
  });

  it('removes an attachment when its remove button is clicked', async () => {
    installFetch({ list: [] });

    render(<CopilotPanel open onClose={() => {}} />);

    const file = new File(['x'], 'a.json', { type: 'application/json' });
    fireEvent.change(screen.getByTestId('copilot-attach-input'), { target: { files: [file] } });

    await waitFor(() => expect(screen.getByTestId('copilot-attachment')).toBeTruthy());
    fireEvent.click(screen.getByTestId('copilot-attachment-remove'));
    expect(screen.queryByTestId('copilot-attachment')).toBeNull();
  });

  it('rejects a binary file with an inline note and attaches nothing', async () => {
    installFetch({ list: [] });

    render(<CopilotPanel open onClose={() => {}} />);

    const bin = new File(['abc\u0000def'], 'dump.bin', { type: 'application/octet-stream' });
    fireEvent.change(screen.getByTestId('copilot-attach-input'), { target: { files: [bin] } });

    await waitFor(() => expect(screen.getByTestId('copilot-attach-error').textContent).toMatch(/binary/i));
    expect(screen.queryByTestId('copilot-attachment')).toBeNull();
  });

  it('rejects a file over the per-file size cap (256 KB)', async () => {
    installFetch({ list: [] });

    render(<CopilotPanel open onClose={() => {}} />);

    const big = new File(['a'.repeat(256 * 1024 + 1)], 'huge.log', { type: 'text/plain' });
    fireEvent.change(screen.getByTestId('copilot-attach-input'), { target: { files: [big] } });

    await waitFor(() => expect(screen.getByTestId('copilot-attach-error').textContent).toMatch(/over 256\.0 KB/));
    expect(screen.queryByTestId('copilot-attachment')).toBeNull();
  });

  it('rejects files past the max count (6) but keeps the first six', async () => {
    installFetch({ list: [] });

    render(<CopilotPanel open onClose={() => {}} />);

    const files = Array.from({ length: 7 }, (_, i) => new File(['x'], `f${i}.txt`, { type: 'text/plain' }));
    fireEvent.change(screen.getByTestId('copilot-attach-input'), { target: { files } });

    await waitFor(() => expect(screen.getAllByTestId('copilot-attachment').length).toBe(6));
    expect(screen.getByTestId('copilot-attach-error').textContent).toMatch(/max 6 files/);
  });

  it('rejects a file that would push the batch over the total cap (512 KB)', async () => {
    installFetch({ list: [] });

    render(<CopilotPanel open onClose={() => {}} />);

    // Three 200 KB files (each under the 256 KB per-file cap): the first two fit
    // (400 KB), the third pushes past the 512 KB total and is skipped.
    const a = new File(['a'.repeat(200 * 1024)], 'a.log', { type: 'text/plain' });
    const b = new File(['b'.repeat(200 * 1024)], 'b.log', { type: 'text/plain' });
    const c = new File(['c'.repeat(200 * 1024)], 'c.log', { type: 'text/plain' });
    fireEvent.change(screen.getByTestId('copilot-attach-input'), { target: { files: [a, b, c] } });

    await waitFor(() => expect(screen.getAllByTestId('copilot-attachment').length).toBe(2));
    expect(screen.getByTestId('copilot-attach-error').textContent).toMatch(/c\.log \(total over 512\.0 KB\)/);
  });

  it('accepts files dropped onto the panel', async () => {
    installFetch({ list: [] });

    render(<CopilotPanel open onClose={() => {}} />);

    const file = new File(['dropped'], 'drop.txt', { type: 'text/plain' });
    fireEvent.drop(screen.getByTestId('copilot-panel'), { dataTransfer: { files: [file] } });

    await waitFor(() => expect(screen.getByTestId('copilot-attachment').textContent).toMatch(/drop\.txt/));
  });

  it('folds multiple attachments into the message in order with fenced headers', async () => {
    const { calls } = installFetch({ list: [], onMessages: () => streamingResponse(['ok']) });

    render(<CopilotPanel open onClose={() => {}} />);

    const f1 = new File(['alpha'], 'one.txt', { type: 'text/plain' });
    const f2 = new File(['beta'], 'two.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByTestId('copilot-attach-input'), { target: { files: [f1, f2] } });

    await waitFor(() => expect(screen.getAllByTestId('copilot-attachment').length).toBe(2));

    fireEvent.change(screen.getByTestId('copilot-input'), { target: { value: 'see attached' } });
    fireEvent.click(screen.getByTestId('copilot-send'));

    await waitFor(() => expect(messagesCall(calls)).toBeTruthy());
    const content = JSON.parse(messagesCall(calls).init.body).content;
    // Typed prose comes first, then each file fenced, in pick order.
    expect(content.indexOf('see attached')).toBe(0);
    expect(content).toMatch(/--- Attached file: one\.txt \([^)]+\) ---\nalpha\n--- end of one\.txt ---/);
    expect(content).toMatch(/--- Attached file: two\.txt \([^)]+\) ---\nbeta\n--- end of two\.txt ---/);
    expect(content.indexOf('one.txt')).toBeLessThan(content.indexOf('two.txt'));
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

describe('CopilotPanel — bench context (loaded dumps + detach toggle)', () => {
  it('reads loaded dumps: shows the bench bar and sends to /tool-messages with context + bytes', async () => {
    const { calls } = installFetch({ list: [], onToolMessages: () => streamingResponse(['ok']) });

    renderWithBench(benchValue({ loadedDumps: [makeDump()] }));

    // The bench bar appears and advertises the loaded module + attached bytes.
    const bar = screen.getByTestId('copilot-bench-bar');
    expect(bar).toBeTruthy();
    expect(bar.textContent).toMatch(/Reading your bench/i);
    expect(bar.textContent).toMatch(/1 module/);
    expect(bar.textContent).toMatch(/bytes attached/);

    fireEvent.change(screen.getByTestId('copilot-input'), { target: { value: 'inspect this dump' } });
    fireEvent.click(screen.getByTestId('copilot-send'));

    // The turn routes to the tool-use endpoint with module context + bytes.
    await waitFor(() => expect(toolMessagesCall(calls)).toBeTruthy());
    const body = JSON.parse(toolMessagesCall(calls).init.body);
    expect(body.content).toBe('inspect this dump');
    expect(body.moduleContext).toBeTruthy();
    expect(Array.isArray(body.moduleContext.modules)).toBe(true);
    expect(body.moduleContext.modules[0]).toMatch(/BCM/);
    expect(typeof body.binaryBase64).toBe('string');
    expect(body.binaryBase64.length).toBeGreaterThan(0);

    // It did NOT fall back to the plain text endpoint.
    expect(messagesCall(calls)).toBeUndefined();
  });

  it('respects the detach toggle: switching to Detached falls back to /messages with no module context', async () => {
    const { calls } = installFetch({ list: [], onMessages: () => streamingResponse(['ok']) });

    renderWithBench(benchValue({ loadedDumps: [makeDump()] }));

    // Detach the bench context.
    fireEvent.click(screen.getByTestId('copilot-bench-toggle'));
    expect(screen.getByTestId('copilot-bench-bar').textContent).toMatch(/detached/i);

    fireEvent.change(screen.getByTestId('copilot-input'), { target: { value: 'general question' } });
    fireEvent.click(screen.getByTestId('copilot-send'));

    // With the bench detached, the request goes to the plain text endpoint
    // with no module context and no bytes.
    await waitFor(() => expect(messagesCall(calls)).toBeTruthy());
    const body = JSON.parse(messagesCall(calls).init.body);
    expect(body.content).toBe('general question');
    expect(body.moduleContext).toBeUndefined();
    expect(body.binaryBase64).toBeUndefined();

    // The tool-use endpoint was never hit.
    expect(toolMessagesCall(calls)).toBeUndefined();
  });

  it('with no dumps loaded: renders no bench bar and uses /messages (current behavior)', async () => {
    const { calls } = installFetch({ list: [], onMessages: () => streamingResponse(['ok']) });

    renderWithBench(benchValue({ vin: '', loadedDumps: [] }));

    // Nothing on the bench → no bench bar at all.
    expect(screen.queryByTestId('copilot-bench-bar')).toBeNull();

    fireEvent.change(screen.getByTestId('copilot-input'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('copilot-send'));

    await waitFor(() => expect(messagesCall(calls)).toBeTruthy());
    expect(JSON.parse(messagesCall(calls).init.body)).toEqual({ content: 'hello' });
    expect(toolMessagesCall(calls)).toBeUndefined();
  });
});
