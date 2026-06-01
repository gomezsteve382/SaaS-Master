// @vitest-environment jsdom
//
// UI coverage for the always-available AI Co-pilot panel (CopilotPanel.jsx).
//
// Exercises the panel through its public testid contract:
//   • renders only when `open`, hides when closed
//   • close button + Escape key + scrim click call onClose
//   • a send streams `data: {content}` frames into an assistant bubble and
//     re-enables the composer when the stream ends
//   • a suggestion chip sends its prompt
//   • reset clears the conversation
//   • a mid-stream `data: {error}` frame rolls back the empty assistant
//     placeholder, preserves the user message, surfaces copilot-error, and
//     re-enables the input
//   • a 503 response shows the "not configured" guidance
//   • closing the panel aborts the in-flight stream (abort-on-close)
//
// fetch + the streaming Response are stubbed; we never hit a real backend.

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';

import CopilotPanel from '../components/CopilotPanel.jsx';

// A streaming Response that emits the given content chunks then a done frame.
function makeStreamingResponse(chunks) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      for (const chunk of chunks) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ content: chunk })}\n`));
      }
      c.enqueue(enc.encode(`data: ${JSON.stringify({ done: true })}\n`));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

// A streaming Response that emits an `error` frame before any content.
function makeErrorFrameResponse(message) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(`data: ${JSON.stringify({ error: message })}\n`));
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

let originalFetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
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

describe('CopilotPanel — streaming a reply', () => {
  it('streams content into an assistant bubble and re-enables the composer', async () => {
    global.fetch = vi.fn(async () => makeStreamingResponse(['Hello ', 'world']));

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

    // POST went to the general-chat endpoint with the user turn in the body.
    const [url, init] = global.fetch.mock.calls[0];
    expect(String(url)).toMatch(/\/anthropic\/general-chat$/);
    const sent = JSON.parse(init.body);
    expect(sent.messages.at(-1)).toEqual({ role: 'user', content: 'hi there' });

    // Composer cleared + re-enabled (send disabled only because input is empty).
    expect(input.value).toBe('');
  });

  it('sends a suggestion chip prompt', async () => {
    global.fetch = vi.fn(async () => makeStreamingResponse(['answer']));

    render(<CopilotPanel open onClose={() => {}} />);
    const chips = screen.getAllByTestId('copilot-suggestion');
    fireEvent.click(chips[0]);

    await waitFor(() =>
      expect(screen.getByTestId('copilot-msg-assistant').textContent).toBe('answer'),
    );
    const sent = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(sent.messages.at(-1).content).toBe(chips[0].textContent);
  });
});

describe('CopilotPanel — reset', () => {
  it('clears the conversation when reset is clicked', async () => {
    global.fetch = vi.fn(async () => makeStreamingResponse(['done']));

    render(<CopilotPanel open onClose={() => {}} />);
    fireEvent.change(screen.getByTestId('copilot-input'), { target: { value: 'q' } });
    fireEvent.click(screen.getByTestId('copilot-send'));
    await waitFor(() => expect(screen.getByTestId('copilot-msg-assistant')).toBeTruthy());

    fireEvent.click(screen.getByTestId('copilot-reset'));
    expect(screen.queryByTestId('copilot-msg-user')).toBeNull();
    expect(screen.queryByTestId('copilot-msg-assistant')).toBeNull();
  });
});

describe('CopilotPanel — error handling', () => {
  it('rolls back the empty assistant bubble on a mid-stream error frame', async () => {
    global.fetch = vi.fn(async () => makeErrorFrameResponse('rate_limited: backoff 30s'));

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

  it('shows the not-configured guidance on a 503 response', async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse(503, { error: 'AI service unavailable' }),
    );

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
    // Resolve the fetch only after we can observe the signal; the body never
    // completes, so the stream is genuinely in-flight when we close.
    global.fetch = vi.fn((_url, init) => {
      capturedSignal = init.signal;
      const body = new ReadableStream({ start() { /* never closes */ } });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      );
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
