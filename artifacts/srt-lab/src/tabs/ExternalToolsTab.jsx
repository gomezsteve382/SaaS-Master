/**
 * ExternalToolsTab — lists vendored external tools (FCA PROXI Tool,
 * GPEC Unlocker) and lets the user launch or reveal them via the local
 * J2534 bridge.
 *
 * Also shows live status for both the J2534 Pass-Thru bridge and the
 * MicroPod II bridge, and lets the operator switch the active transport
 * (Task #613).
 */
import React, { useState, useCallback, useEffect } from 'react';
import { C } from '../lib/constants.js';
import { Card, Tag, Btn } from '../lib/ui.jsx';
import { getAutelState, useMicroPodStatus } from '../lib/bridgeClient.js';
import {
  getActiveTransport, setActiveTransport,
  TRANSPORT_J2534, TRANSPORT_MICROPOD,
} from '../lib/bridgeEngine.js';

const BRIDGE_DEFAULT   = 'http://localhost:8765';
const MICROPOD_DEFAULT = 'http://localhost:8766';

const TOOLS = [
  {
    id: 'fca-proxi',
    name: 'FCA PROXI Tool',
    version: '1.2.0.1',
    description:
      'Stellantis vehicle PROXI configuration reader / writer. PyInstaller bundle with Safengine-Shielden license bypass (shfolder.dll sideload) and HWID-locked .key blob.',
    runtime: 'Python 3.12 · pythonnet · WebView2',
    hwid: '2899614-B9E65D4-73F1D98-D6D5DCB',
    vendorDir: 'vendor/fca-proxi',
    exe: 'FCA_PROXI_Tool.exe',
    requiredFiles: ['FCA_PROXI_Tool.exe', 'shfolder.dll', 'chichitoworkshop.key', 'license.json'],
    icon: '🔧',
    note: 'Must launch from vendor folder so shfolder.dll sideload resolves before %SYSTEM32%.',
  },
  {
    id: 'gpec-unlocker',
    name: 'GPEC Unlocker',
    version: '1.0',
    description:
      'Continental GPEC2A EEPROM unlock tool. WinLicense-protected .NET binary (Framework 4.8.1). Runs without a separate license file — protection is structural.',
    runtime: '.NET Framework 4.8.1',
    hwid: null,
    vendorDir: 'vendor/gpec-unlocker',
    exe: 'GPEC_Unlocker.exe',
    requiredFiles: ['GPEC_Unlocker.exe'],
    icon: '🔓',
    note: 'Anti-debug protection active — do not launch under a debugger or inside a VM that is detectable.',
  },
];

function StatusBadge({ status, expectedHwid, liveHwid }) {
  const map = {
    present: { color: C.gn, label: '✓ Present' },
    missing: { color: C.er, label: '✗ Missing' },
    checking: { color: C.wn, label: '… Checking' },
    'wrong-hwid': { color: C.wn, label: '⚠ Wrong HWID' },
    'bridge-offline': { color: C.tm, label: '— Bridge offline' },
  };
  const { color, label } = map[status] ?? map['bridge-offline'];
  let title;
  if (status === 'wrong-hwid' && expectedHwid && liveHwid) {
    title = `Activation key is bound to HWID:\n  ${expectedHwid}\nLive machine HWID:\n  ${liveHwid}\n\nFCA PROXI Tool will refuse to start until the HWIDs match (or the shfolder.dll bypass intervenes).`;
  } else if (status === 'present' && expectedHwid && liveHwid) {
    title = `HWID match — bound to ${expectedHwid}`;
  }
  return (
    <span title={title}>
      <Tag color={color}>{label}</Tag>
    </span>
  );
}

// ─── MicroPod II live status panel ───────────────────────────────────────────

function MicroPodStatusPanel({ activeTransport, onTransportChange }) {
  const mp = useMicroPodStatus(5000);

  const daemonReachable = !mp.loading && !mp.error;
  const podPresent      = daemonReachable && mp.podPresent;
  const channelUp       = daemonReachable && mp.connected;
  const fw              = mp.status?.versions?.firmware || null;
  const serial          = mp.status?.serial || null;
  const pyusbOk         = mp.status?.pyusbAvailable !== false;

  let podBadgeColor = C.tm;
  let podBadgeLabel = '— Not detected';
  if (!daemonReachable)       { podBadgeColor = C.er;  podBadgeLabel = '✗ Daemon offline'; }
  else if (!pyusbOk)          { podBadgeColor = C.er;  podBadgeLabel = '✗ pyusb missing';  }
  else if (podPresent && channelUp) { podBadgeColor = C.gn; podBadgeLabel = '✓ Connected'; }
  else if (podPresent)        { podBadgeColor = C.wn;  podBadgeLabel = '⚡ Present (idle)'; }

  const isMicroPodActive = activeTransport === TRANSPORT_MICROPOD;

  return (
    <Card style={{ marginBottom: 16, borderColor: isMicroPodActive ? C.a3 : C.bd }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ fontSize: 28 }}>🔌</div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
            <span style={{ fontWeight: 900, fontSize: 14, color: C.tx }}>wiTECH MicroPod II</span>
            <Tag color={podBadgeColor}>{podBadgeLabel}</Tag>
            {isMicroPodActive && <Tag color={C.a3}>ACTIVE TRANSPORT</Tag>}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, auto) 1fr', gap: '4px 18px', marginBottom: 8 }}>
            <div>
              <div style={{ fontSize: 8, color: C.tm, letterSpacing: 1.2 }}>DAEMON</div>
              <div style={{ fontSize: 11, fontFamily: 'JetBrains Mono', color: daemonReachable ? C.gn : C.er }}>
                {daemonReachable ? mp.status?.url || MICROPOD_DEFAULT : 'offline'}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 8, color: C.tm, letterSpacing: 1.2 }}>FIRMWARE</div>
              <div style={{ fontSize: 11, fontFamily: 'JetBrains Mono', color: fw ? C.tx : C.ts }}>
                {fw || (daemonReachable ? '—' : '—')}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 8, color: C.tm, letterSpacing: 1.2 }}>SERIAL</div>
              <div style={{ fontSize: 11, fontFamily: 'JetBrains Mono', color: serial ? C.tx : C.ts }}>
                {serial || '—'}
              </div>
            </div>
            {!pyusbOk && (
              <div style={{ gridColumn: '1 / -1', marginTop: 4 }}>
                <span style={{ fontSize: 11, color: C.er }}>
                  ⚠ pyusb not installed on bridge host —{' '}
                  <code style={{ fontFamily: 'monospace' }}>pip install pyusb</code>
                </span>
              </div>
            )}
          </div>

          <div style={{ fontSize: 11, color: C.ts, marginBottom: 8, lineHeight: 1.5 }}>
            OEM Mopar transport. Runs via{' '}
            <code style={{ fontFamily: 'monospace', fontSize: 10 }}>micropod_bridge.py</code> on{' '}
            <code style={{ fontFamily: 'monospace', fontSize: 10 }}>{MICROPOD_DEFAULT}</code>.
            All offline-flash / VIN-write / reset flows route through this adapter when selected.
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Btn
              onClick={() => onTransportChange(TRANSPORT_MICROPOD)}
              color={isMicroPodActive ? C.a3 : C.tm}
              disabled={isMicroPodActive}
            >
              {isMicroPodActive ? '✓ Selected' : 'Use MicroPod II'}
            </Btn>
            <Btn onClick={() => mp.refresh()} color={C.tm} outline>
              ↺ Refresh
            </Btn>
            {!daemonReachable && (
              <span style={{ fontSize: 10, color: C.ts }}>
                Start daemon: <code style={{ fontFamily: 'monospace' }}>python3 micropod_bridge.py</code>
              </span>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

// ─── J2534 status panel ───────────────────────────────────────────────────────

function J2534StatusPanel({ activeTransport, onTransportChange, bridgeUrl }) {
  const isJ2534Active = activeTransport === TRANSPORT_J2534;

  return (
    <Card style={{ marginBottom: 16, borderColor: isJ2534Active ? C.gn : C.bd }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ fontSize: 28 }}>⚡</div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
            <span style={{ fontWeight: 900, fontSize: 14, color: C.tx }}>Autel MaxiFlash J2534</span>
            {isJ2534Active && <Tag color={C.gn}>ACTIVE TRANSPORT</Tag>}
          </div>
          <div style={{ fontSize: 11, color: C.ts, marginBottom: 8 }}>
            SGW-capable J2534 Pass-Thru via{' '}
            <code style={{ fontFamily: 'monospace', fontSize: 10 }}>j2534_bridge.py</code> on{' '}
            <code style={{ fontFamily: 'monospace', fontSize: 10 }}>{bridgeUrl}</code>.
          </div>
          <Btn
            onClick={() => onTransportChange(TRANSPORT_J2534)}
            color={isJ2534Active ? C.gn : C.tm}
            disabled={isJ2534Active}
          >
            {isJ2534Active ? '✓ Selected' : 'Use J2534 Pass-Thru'}
          </Btn>
        </div>
      </div>
    </Card>
  );
}

// ─── Main tab ─────────────────────────────────────────────────────────────────

export default function ExternalToolsTab() {
  const [bridgeUrl, setBridgeUrl] = useState(BRIDGE_DEFAULT);
  const [toolStatus, setToolStatus] = useState(() =>
    Object.fromEntries(TOOLS.map((t) => [t.id, { status: 'checking' }]))
  );
  const [launching, setLaunching] = useState({});
  const [revealing, setRevealing] = useState({});
  const [messages, setMessages] = useState({});

  // Transport selector state (Task #613)
  const [activeTransport, setActiveTransportState] = useState(getActiveTransport);

  const handleTransportChange = useCallback((t) => {
    const next = setActiveTransport(t);
    setActiveTransportState(next);
  }, []);

  const bridgeUrl_ = useCallback(() => {
    try {
      return getAutelState().url || BRIDGE_DEFAULT;
    } catch {
      return BRIDGE_DEFAULT;
    }
  }, []);

  const checkTools = useCallback(async () => {
    const url = bridgeUrl_();
    setBridgeUrl(url);
    const statuses = {};
    for (const tool of TOOLS) {
      try {
        const res = await fetch(`${url}/tools/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toolId: tool.id }),
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        statuses[tool.id] = {
          status: json.status ?? 'missing',
          expectedHwid: json.expectedHwid,
          liveHwid: json.liveHwid,
          hwidSource: json.hwidSource,
        };
      } catch {
        statuses[tool.id] = { status: 'bridge-offline' };
      }
    }
    setToolStatus(statuses);
  }, [bridgeUrl_]);

  useEffect(() => {
    checkTools();
    const t = setInterval(checkTools, 12000);
    return () => clearInterval(t);
  }, [checkTools]);

  const launch = useCallback(
    async (tool) => {
      setLaunching((prev) => ({ ...prev, [tool.id]: true }));
      setMessages((prev) => ({ ...prev, [tool.id]: null }));
      try {
        const res = await fetch(`${bridgeUrl}/tools/launch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toolId: tool.id }),
          signal: AbortSignal.timeout(8000),
        });
        const json = await res.json().catch(() => ({}));
        if (json.ok) {
          setMessages((prev) => ({ ...prev, [tool.id]: { type: 'ok', text: `Launched PID ${json.pid ?? '?'}` } }));
        } else {
          setMessages((prev) => ({
            ...prev,
            [tool.id]: { type: 'err', text: json.error ?? 'Launch failed' },
          }));
        }
      } catch (e) {
        setMessages((prev) => ({
          ...prev,
          [tool.id]: {
            type: 'err',
            text:
              e.name === 'TimeoutError'
                ? 'Bridge timed out — is j2534_bridge.py running?'
                : e.message ?? String(e),
          },
        }));
      } finally {
        setLaunching((prev) => ({ ...prev, [tool.id]: false }));
      }
    },
    [bridgeUrl]
  );

  const reveal = useCallback(
    async (tool) => {
      setRevealing((prev) => ({ ...prev, [tool.id]: true }));
      try {
        const res = await fetch(`${bridgeUrl}/tools/reveal`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toolId: tool.id }),
          signal: AbortSignal.timeout(5000),
        });
        const json = await res.json().catch(() => ({}));
        if (!json.ok) {
          setMessages((prev) => ({
            ...prev,
            [tool.id]: { type: 'err', text: json.error ?? 'Reveal failed' },
          }));
        }
      } catch (e) {
        setMessages((prev) => ({
          ...prev,
          [tool.id]: {
            type: 'err',
            text: e.name === 'TimeoutError' ? 'Bridge timed out' : e.message ?? String(e),
          },
        }));
      } finally {
        setRevealing((prev) => ({ ...prev, [tool.id]: false }));
      }
    },
    [bridgeUrl]
  );

  const bridgeOffline = Object.values(toolStatus).every((s) => (s?.status ?? s) === 'bridge-offline');

  return (
    <div>
      <Card style={{ marginBottom: 16, background: '#FFF3E0', borderColor: '#FF8F00' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <div style={{ fontSize: 24 }}>🧰</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 900, fontSize: 13, color: '#7A3800', letterSpacing: 0.5 }}>
              EXTERNAL TOOLS — INTERNAL BENCH USE ONLY
            </div>
            <div style={{ fontSize: 12, color: '#7A3800', marginTop: 4, lineHeight: 1.6 }}>
              These vendored binaries are pre-staged with their license bypass intact in{' '}
              <code style={{ fontFamily: 'monospace', fontSize: 11 }}>artifacts/srt-lab/vendor/</code>.
              Launch requires the local J2534 bridge (
              <code style={{ fontFamily: 'monospace', fontSize: 11 }}>j2534_bridge.py</code>) running on{' '}
              <code style={{ fontFamily: 'monospace', fontSize: 11 }}>{bridgeUrl}</code>.
              Do not redistribute.
            </div>
          </div>
        </div>
      </Card>

      {/* ── Transport selector (Task #613) ── */}
      <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 10, color: C.tm, letterSpacing: 1.8, fontFamily: 'JetBrains Mono' }}>
          UDS TRANSPORT
        </span>
        <span style={{ flex: 1, height: 1, background: `linear-gradient(to right, ${C.a3}55, transparent)` }} />
      </div>

      <J2534StatusPanel
        activeTransport={activeTransport}
        onTransportChange={handleTransportChange}
        bridgeUrl={bridgeUrl}
      />

      <MicroPodStatusPanel
        activeTransport={activeTransport}
        onTransportChange={handleTransportChange}
      />

      {bridgeOffline && (
        <Card style={{ marginBottom: 16, background: '#FCE4EC', borderColor: C.er }}>
          <div style={{ fontSize: 12, color: C.er, fontWeight: 700 }}>
            ⚠ J2534 bridge offline — Launch and Reveal require the local bridge daemon. Run{' '}
            <code style={{ fontFamily: 'monospace' }}>python3 j2534_bridge.py</code> on the bench machine, then{' '}
            <span
              onClick={checkTools}
              style={{ textDecoration: 'underline', cursor: 'pointer' }}
            >
              refresh status
            </span>
            .
          </div>
        </Card>
      )}

      {/* ── Tool launch / reveal section ── */}
      <div style={{ marginBottom: 8, marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 10, color: C.tm, letterSpacing: 1.8, fontFamily: 'JetBrains Mono' }}>
          VENDORED TOOLS
        </span>
        <span style={{ flex: 1, height: 1, background: `linear-gradient(to right, ${C.tm}55, transparent)` }} />
        <Btn onClick={checkTools} color={C.tm} outline>
          ↺ Refresh status
        </Btn>
      </div>

      {TOOLS.map((tool) => {
        const ts = toolStatus[tool.id] ?? { status: 'checking' };
        const status = ts.status ?? 'checking';
        const expectedHwid = ts.expectedHwid ?? tool.hwid;
        const liveHwid = ts.liveHwid;
        const msg = messages[tool.id];
        const isLaunching = !!launching[tool.id];
        const isRevealing = !!revealing[tool.id];
        const canAct = status === 'present' && !bridgeOffline;

        return (
          <Card key={tool.id} style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ fontSize: 32 }}>{tool.icon}</div>
              <div style={{ flex: 1, minWidth: 260 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
                  <span style={{ fontWeight: 900, fontSize: 15, color: C.tx }}>{tool.name}</span>
                  <Tag color={C.tm}>v{tool.version}</Tag>
                  <StatusBadge status={status} expectedHwid={expectedHwid} liveHwid={liveHwid} />
                </div>
                <div style={{ fontSize: 12, color: C.ts, lineHeight: 1.6, marginBottom: 8 }}>
                  {tool.description}
                </div>
                <div style={{ fontSize: 11, color: C.tm, marginBottom: 4 }}>
                  <strong>Runtime:</strong> {tool.runtime}
                </div>
                {tool.hwid && (
                  <div style={{ fontSize: 11, color: C.tm, fontFamily: 'monospace', marginBottom: 4 }}>
                    <strong>HWID (expected):</strong> {expectedHwid || tool.hwid}
                  </div>
                )}
                {tool.hwid && liveHwid && (
                  <div
                    style={{
                      fontSize: 11,
                      color: status === 'wrong-hwid' ? C.er : C.gn,
                      fontFamily: 'monospace',
                      marginBottom: 4,
                    }}
                  >
                    <strong>HWID (live):</strong> {liveHwid}{' '}
                    {status === 'wrong-hwid' ? '— mismatch' : '— match'}
                  </div>
                )}
                <div style={{ fontSize: 11, color: C.tm, marginBottom: 4 }}>
                  <strong>Vendor path:</strong>{' '}
                  <code style={{ fontFamily: 'monospace', fontSize: 10 }}>{tool.vendorDir}/</code>
                </div>
                <div style={{ fontSize: 11, color: C.tm, marginBottom: 4 }}>
                  <strong>Required files:</strong> {tool.requiredFiles.join(', ')}
                </div>
                <div
                  style={{
                    fontSize: 10,
                    color: C.wn,
                    background: C.wn + '18',
                    borderRadius: 6,
                    padding: '4px 8px',
                    marginTop: 6,
                    marginBottom: 10,
                    lineHeight: 1.5,
                  }}
                >
                  ⚠ {tool.note}
                </div>

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Btn
                    onClick={() => launch(tool)}
                    color={canAct ? C.gn : C.tm}
                    disabled={!canAct || isLaunching}
                  >
                    {isLaunching ? '⏳ Launching…' : '▶ Launch'}
                  </Btn>
                  <Btn
                    onClick={() => reveal(tool)}
                    color={C.a3}
                    outline
                    disabled={bridgeOffline || isRevealing}
                  >
                    {isRevealing ? '…' : '📂 Reveal in folder'}
                  </Btn>
                </div>

                {msg && (
                  <div
                    style={{
                      marginTop: 8,
                      fontSize: 12,
                      fontWeight: 700,
                      color: msg.type === 'ok' ? C.gn : C.er,
                    }}
                  >
                    {msg.type === 'ok' ? '✓' : '✗'} {msg.text}
                  </div>
                )}
              </div>
            </div>
          </Card>
        );
      })}

      <Card style={{ marginTop: 8, background: C.c2 }}>
        <div style={{ fontWeight: 900, fontSize: 12, color: C.tm, marginBottom: 8 }}>
          HOW LAUNCH WORKS
        </div>
        <div style={{ fontSize: 11, color: C.ts, lineHeight: 1.7 }}>
          <div>1. Bridge verifies that all required files are present and their sizes match <code>manifest.json</code>.</div>
          <div>2. EXE is spawned via <code>subprocess.Popen</code> with <code>cwd</code> set to the vendor folder.</div>
          <div>3. For FCA PROXI Tool: Windows finds <code>shfolder.dll</code> in the CWD before searching <code>%SYSTEM32%</code>, activating the Safengine-Shielden license bypass.</div>
          <div>4. stdout/stderr are streamed back but not displayed here (check bridge console).</div>
          <div>5. "Reveal in folder" calls <code>explorer.exe /select,{'{exe}'}</code> on Windows or <code>open -R</code> on macOS.</div>
        </div>
      </Card>
    </div>
  );
}
