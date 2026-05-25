import {useCallback, useEffect, useRef, useState} from "react";
import {writeCandumpLog} from "@workspace/uds";

/**
 * In-memory ring-buffered candump recorder.
 *
 * Hooks into any frame stream the host tab already has (J2534 raw CAN
 * tab, SWARM tab) by exposing an `addFrame({ts, iface, id, ext, data})`
 * callback. The host calls `addFrame` for every frame it observes; this
 * hook handles ring-buffer overflow, download, and "open in analyser"
 * handoff via a one-shot global slot consumed by `LogAnalyserTab`.
 *
 * Defaults to a 50,000-frame cap (≈ 4 MB log file at 80 chars/line).
 */
export function useCanRecorder({cap = 50_000, iface = 'can0'} = {}) {
  const [recording, setRecording] = useState(false);
  const [count, setCount] = useState(0);
  const [overflowed, setOverflowed] = useState(false);
  const startTsRef = useRef(0);
  const buf = useRef([]);

  const start = useCallback(() => {
    buf.current = [];
    startTsRef.current = performance.now() / 1000;
    setCount(0);
    setOverflowed(false);
    setRecording(true);
  }, []);

  const stop = useCallback(() => { setRecording(false); }, []);

  const clear = useCallback(() => {
    buf.current = [];
    setCount(0);
    setOverflowed(false);
  }, []);

  const addFrame = useCallback((f) => {
    if (!recording) return;
    if (buf.current.length >= cap) {
      // Ring-overflow: drop the oldest frame so the live tail stays
      // intact. The UI surfaces the overflow flag so users know.
      buf.current.shift();
      setOverflowed(true);
    }
    const ts = typeof f.ts === 'number' ? f.ts : (performance.now() / 1000) - startTsRef.current;
    const data = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data || []);
    buf.current.push({
      ts, iface: f.iface || iface,
      id: f.id|0, ext: !!f.ext, fd: !!f.fd, rtr: !!f.rtr,
      data, fdFlags: f.fdFlags ?? null,
    });
    setCount(buf.current.length);
  }, [recording, cap, iface]);

  const toLog = useCallback(() => writeCandumpLog(buf.current), []);

  const download = useCallback((name = `srtlab-${Date.now()}.log`) => {
    const blob = new Blob([toLog()], {type:'text/plain'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [toLog]);

  const openInAnalyser = useCallback((onSwitchTab) => {
    if (typeof window !== 'undefined') {
      window.__srtLabAnalyserHandoff = {
        text: toLog(),
        name: `live-capture-${Date.now()}.log`,
      };
      // Dispatch an app-level event so any host that wires the listener
      // (App.jsx) can switch to the LOG ANALYSER tab without each calling
      // tab having to thread an onSwitchTab prop down.
      try { window.dispatchEvent(new CustomEvent('srtlab:open-analyser')); } catch {}
    }
    if (onSwitchTab) onSwitchTab('loganalyser');
  }, [toLog]);

  // Task #724 — same handoff mechanism but routed to the UDS Analyzer tab
  // so users can jump from a live capture straight into post-mortem NRC /
  // session diagnosis without copy-pasting through the Log Analyser first.
  const openInUdsAnalyzer = useCallback((onSwitchTab) => {
    if (typeof window !== 'undefined') {
      window.__srtLabUdsAnalyzerHandoff = {
        text: toLog(),
        name: `live-capture-${Date.now()}.log`,
      };
      try { window.dispatchEvent(new CustomEvent('srtlab:open-uds-analyzer')); } catch {}
    }
    if (onSwitchTab) onSwitchTab('udsanalyzer');
  }, [toLog]);

  return {
    recording, count, overflowed,
    start, stop, clear, addFrame,
    download, openInAnalyser, openInUdsAnalyzer, toLog,
    frames: buf.current,
  };
}

/**
 * Consume a one-shot handoff payload set by `useCanRecorder.openInAnalyser`.
 * Returns null when no handoff is pending; the consumer (LogAnalyserTab)
 * calls this on mount to load the live capture.
 */
export function consumeAnalyserHandoff() {
  if (typeof window === 'undefined') return null;
  const h = window.__srtLabAnalyserHandoff;
  if (!h) return null;
  delete window.__srtLabAnalyserHandoff;
  return h;
}

/**
 * Task #724 — counterpart to `consumeAnalyserHandoff`, but for the UDS
 * Analyzer tab. Consumed once on mount by `UdsAnalyzerTab` to pre-load
 * a live capture handed off from a recorder card.
 */
export function consumeUdsAnalyzerHandoff() {
  if (typeof window === 'undefined') return null;
  const h = window.__srtLabUdsAnalyzerHandoff;
  if (!h) return null;
  delete window.__srtLabUdsAnalyzerHandoff;
  return h;
}
