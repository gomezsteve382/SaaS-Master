/**
 * RelayStatusBar — shows relay connection state and adapter picker.
 * Placed at the top of the UDS tab.
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { RelayClient, RELAY_DEFAULT_URL } from './relayClient.js';

// Singleton relay client shared across the app
let _sharedRelay = null;
export function getSharedRelay() {
  if (!_sharedRelay) _sharedRelay = new RelayClient(RELAY_DEFAULT_URL);
  return _sharedRelay;
}

const STATUS_LABEL = {
  disconnected: 'Not Connected',
  connecting:   'Connecting…',
  connected:    'Connected',
  error:        'Connection Error',
};

const STATUS_COLOR = {
  disconnected: '#6b7280',
  connecting:   '#f59e0b',
  connected:    '#22c55e',
  error:        '#ef4444',
};

export function RelayStatusBar({ onRelayReady }) {
  const relay = getSharedRelay();
  const [status, setStatus]       = useState(relay.status);
  const [adapters, setAdapters]   = useState([]);
  const [selectedAdapter, setSelectedAdapter] = useState(null);
  const [channelId, setChannelId] = useState(null);
  const [error, setError]         = useState(null);
  const [protocol, setProtocol]   = useState('CAN');
  const [baudRate, setBaudRate]   = useState(500000);
  const [expanded, setExpanded]   = useState(false);

  // Subscribe to relay status changes
  useEffect(() => {
    const unsub = relay.onStatusChange(s => setStatus(s));
    return unsub;
  }, [relay]);

  const handleConnect = useCallback(async () => {
    setError(null);
    try {
      await relay.connect(5000);
      const list = await relay.listAdapters();
      setAdapters(list);
      if (list.length > 0 && selectedAdapter === null) {
        setSelectedAdapter(list[0].id);
      }
    } catch (e) {
      setError(e.message);
    }
  }, [relay, selectedAdapter]);

  const handleOpenChannel = useCallback(async () => {
    if (selectedAdapter === null) return;
    setError(null);
    try {
      const result = await relay.openChannel({
        adapterId: selectedAdapter,
        protocol,
        baudRate: parseInt(baudRate, 10),
        flags: 0,
      });
      setChannelId(result.channelId);
      if (onRelayReady) onRelayReady({ relay, channelId: result.channelId });
    } catch (e) {
      setError(e.message);
    }
  }, [relay, selectedAdapter, protocol, baudRate, onRelayReady]);

  const handleCloseChannel = useCallback(async () => {
    if (channelId === null) return;
    try {
      await relay.closeChannel({ channelId });
      setChannelId(null);
      if (onRelayReady) onRelayReady(null);
    } catch (e) {
      setError(e.message);
    }
  }, [relay, channelId, onRelayReady]);

  const handleDisconnect = useCallback(async () => {
    if (channelId !== null) await handleCloseChannel();
    relay.disconnect();
    setAdapters([]);
    setSelectedAdapter(null);
    setChannelId(null);
  }, [relay, channelId, handleCloseChannel]);

  const dot = (
    <span style={{
      display: 'inline-block',
      width: 8, height: 8,
      borderRadius: '50%',
      backgroundColor: STATUS_COLOR[status],
      marginRight: 6,
      boxShadow: status === 'connected' ? `0 0 6px ${STATUS_COLOR.connected}` : 'none',
      transition: 'background-color 0.3s, box-shadow 0.3s',
    }} />
  );

  return (
    <div style={{
      background: '#111',
      border: '1px solid #222',
      borderRadius: 6,
      marginBottom: 12,
      fontFamily: 'monospace',
      fontSize: 12,
    }}>
      {/* Header row */}
      <div
        onClick={() => setExpanded(e => !e)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '6px 12px', cursor: 'pointer', userSelect: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {dot}
          <span style={{ color: STATUS_COLOR[status], fontWeight: 600 }}>
            J2534 RELAY — {STATUS_LABEL[status]}
          </span>
          {channelId !== null && (
            <span style={{ color: '#22c55e', marginLeft: 12 }}>
              ▶ CH {channelId} · {protocol} · {(baudRate/1000).toFixed(0)}k
            </span>
          )}
        </div>
        <span style={{ color: '#555', fontSize: 10 }}>{expanded ? '▲' : '▼'}</span>
      </div>

      {/* Expanded panel */}
      {expanded && (
        <div style={{ padding: '8px 12px 12px', borderTop: '1px solid #222' }}>
          {error && (
            <div style={{
              background: '#2a0a0a', border: '1px solid #7f1d1d',
              borderRadius: 4, padding: '6px 10px', color: '#fca5a5',
              marginBottom: 8, fontSize: 11,
            }}>
              ✗ {error}
            </div>
          )}

          {/* Connection controls */}
          {status === 'disconnected' || status === 'error' ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <span style={{ color: '#6b7280' }}>Relay URL:</span>
              <span style={{ color: '#9ca3af' }}>{RELAY_DEFAULT_URL}</span>
              <button
                onClick={handleConnect}
                style={{
                  background: '#1e3a1e', border: '1px solid #22c55e',
                  color: '#22c55e', borderRadius: 4, padding: '3px 10px',
                  cursor: 'pointer', fontSize: 11,
                }}
              >
                Connect
              </button>
            </div>
          ) : status === 'connecting' ? (
            <div style={{ color: '#f59e0b', marginBottom: 8 }}>Connecting to relay agent…</div>
          ) : (
            <>
              {/* Adapter picker */}
              {adapters.length > 0 && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ color: '#6b7280' }}>Adapter:</span>
                  <select
                    value={selectedAdapter ?? ''}
                    onChange={e => setSelectedAdapter(parseInt(e.target.value, 10))}
                    disabled={channelId !== null}
                    style={{
                      background: '#1a1a1a', border: '1px solid #333',
                      color: '#e5e7eb', borderRadius: 4, padding: '2px 6px', fontSize: 11,
                    }}
                  >
                    {adapters.map(a => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>

                  <span style={{ color: '#6b7280' }}>Protocol:</span>
                  <select
                    value={protocol}
                    onChange={e => setProtocol(e.target.value)}
                    disabled={channelId !== null}
                    style={{
                      background: '#1a1a1a', border: '1px solid #333',
                      color: '#e5e7eb', borderRadius: 4, padding: '2px 6px', fontSize: 11,
                    }}
                  >
                    <option value="CAN">CAN</option>
                    <option value="ISO15765">ISO 15765</option>
                    <option value="SW_CAN_PS">SW CAN</option>
                  </select>

                  <span style={{ color: '#6b7280' }}>Baud:</span>
                  <select
                    value={baudRate}
                    onChange={e => setBaudRate(parseInt(e.target.value, 10))}
                    disabled={channelId !== null}
                    style={{
                      background: '#1a1a1a', border: '1px solid #333',
                      color: '#e5e7eb', borderRadius: 4, padding: '2px 6px', fontSize: 11,
                    }}
                  >
                    <option value={125000}>125k</option>
                    <option value={250000}>250k</option>
                    <option value={500000}>500k</option>
                    <option value={1000000}>1M</option>
                  </select>
                </div>
              )}

              {/* Channel controls */}
              <div style={{ display: 'flex', gap: 8 }}>
                {channelId === null ? (
                  <button
                    onClick={handleOpenChannel}
                    disabled={selectedAdapter === null}
                    style={{
                      background: '#1e3a1e', border: '1px solid #22c55e',
                      color: '#22c55e', borderRadius: 4, padding: '4px 12px',
                      cursor: selectedAdapter === null ? 'not-allowed' : 'pointer',
                      fontSize: 11, opacity: selectedAdapter === null ? 0.5 : 1,
                    }}
                  >
                    Open Channel
                  </button>
                ) : (
                  <button
                    onClick={handleCloseChannel}
                    style={{
                      background: '#2a1a1a', border: '1px solid #ef4444',
                      color: '#ef4444', borderRadius: 4, padding: '4px 12px',
                      cursor: 'pointer', fontSize: 11,
                    }}
                  >
                    Close Channel
                  </button>
                )}
                <button
                  onClick={handleDisconnect}
                  style={{
                    background: '#1a1a1a', border: '1px solid #374151',
                    color: '#9ca3af', borderRadius: 4, padding: '4px 12px',
                    cursor: 'pointer', fontSize: 11,
                  }}
                >
                  Disconnect
                </button>
              </div>

              {adapters.length === 0 && (
                <div style={{ color: '#6b7280', marginTop: 6, fontSize: 11 }}>
                  No adapters found. Check that your J2534 adapter driver is installed.
                </div>
              )}
            </>
          )}

          {/* Setup hint */}
          <div style={{ color: '#374151', marginTop: 10, fontSize: 10, lineHeight: 1.5 }}>
            Requires srt-relay.js running on this machine: &nbsp;
            <code style={{ color: '#4b5563' }}>node srt-relay.js</code>
            &nbsp;(Windows only — needs J2534 adapter driver installed)
          </div>
        </div>
      )}
    </div>
  );
}
