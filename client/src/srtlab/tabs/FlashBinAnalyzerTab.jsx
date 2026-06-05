/**
 * FlashBinAnalyzerTab.jsx
 * Drop any raw .bin flash dump — get a full structural breakdown:
 * ECU type, region map, VIN scan, SEC bytes, part numbers, strings, entropy heatmap.
 */
import { useState, useCallback } from 'react';
import { analyzeFlashBin, formatAnalysisReport } from '../lib/flashBinAnalyzer.js';

// ─── ENTROPY COLOR ────────────────────────────────────────────────────────────
function entropyColor(ent, ffPct) {
  if (ffPct > 90) return '#374151'; // erased — dark gray
  if (ent < 2)    return '#1e3a5f'; // near-zero entropy — dark blue
  if (ent < 4)    return '#1d4ed8'; // low entropy — blue (data/cal)
  if (ent < 5.5)  return '#0891b2'; // medium-low — cyan (cal tables)
  if (ent < 6.5)  return '#059669'; // medium — green (code)
  if (ent < 7.5)  return '#d97706'; // high — amber (dense code)
  return '#dc2626';                  // very high — red (packed/encrypted)
}

function EntropyBar({ entropyMap }) {
  if (!entropyMap || entropyMap.length === 0) return null;
  const total = entropyMap.reduce((s, b) => s + b.size, 0);
  return (
    <div className="space-y-2">
      <div className="flex h-8 w-full rounded overflow-hidden border border-white/10">
        {entropyMap.map((b, i) => (
          <div
            key={i}
            title={`Block ${b.index}: 0x${b.start.toString(16).toUpperCase()}–0x${b.end.toString(16).toUpperCase()}\nEntropy: ${b.entropy.toFixed(2)}\nFF: ${b.ffPercent.toFixed(0)}%\n${b.label}`}
            style={{
              width: `${(b.size / total) * 100}%`,
              backgroundColor: entropyColor(b.entropy, b.ffPercent),
              minWidth: '1px',
            }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-3 text-xs text-gray-400">
        {[
          { color: '#374151', label: 'Erased (FF)' },
          { color: '#1d4ed8', label: 'Low entropy / data' },
          { color: '#0891b2', label: 'Cal tables' },
          { color: '#059669', label: 'Code' },
          { color: '#d97706', label: 'Dense code' },
          { color: '#dc2626', label: 'Packed / encrypted' },
        ].map(({ color, label }) => (
          <span key={label} className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ backgroundColor: color }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── SECTION WRAPPER ─────────────────────────────────────────────────────────
function Section({ title, children, accent = '#f59e0b' }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 overflow-hidden">
      <div
        className="px-4 py-2 text-xs font-bold tracking-widest uppercase"
        style={{ borderLeft: `3px solid ${accent}`, color: accent }}
      >
        {title}
      </div>
      <div className="px-4 pb-4 pt-2">{children}</div>
    </div>
  );
}

// ─── BADGE ───────────────────────────────────────────────────────────────────
function Badge({ children, color = '#f59e0b', bg = 'rgba(245,158,11,0.12)' }) {
  return (
    <span
      className="inline-block px-2 py-0.5 rounded text-xs font-bold font-mono"
      style={{ color, backgroundColor: bg, border: `1px solid ${color}33` }}
    >
      {children}
    </span>
  );
}

// ─── HEX DISPLAY ─────────────────────────────────────────────────────────────
function HexValue({ hex, virgin }) {
  return (
    <span className="font-mono text-xs">
      <span className={virgin ? 'text-gray-500' : 'text-green-400'}>{hex}</span>
      {virgin && <span className="ml-2 text-gray-500 italic">VIRGIN</span>}
    </span>
  );
}

// ─── MAIN COMPONENT ──────────────────────────────────────────────────────────
export default function FlashBinAnalyzerTab() {
  const [analysis, setAnalysis] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const processFile = useCallback((file) => {
    if (!file) return;
    setLoading(true);
    setError(null);
    setAnalysis(null);

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const bytes = new Uint8Array(e.target.result);
        const result = analyzeFlashBin(bytes, file.name);
        setAnalysis(result);
      } catch (err) {
        setError(err.message || 'Analysis failed');
      } finally {
        setLoading(false);
      }
    };
    reader.onerror = () => {
      setError('Failed to read file');
      setLoading(false);
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }, [processFile]);

  const onFileInput = useCallback((e) => {
    const file = e.target.files[0];
    if (file) processFile(file);
  }, [processFile]);

  const downloadReport = useCallback(() => {
    if (!analysis) return;
    const text = formatAnalysisReport(analysis);
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = analysis.filename.replace(/\.[^.]+$/, '') + '_analysis.txt';
    a.click();
    URL.revokeObjectURL(url);
  }, [analysis]);

  return (
    <div className="space-y-6 text-sm text-gray-200">
      {/* Header */}
      <div>
        <h2 className="text-lg font-bold tracking-widest uppercase" style={{ color: '#f59e0b' }}>
          🔬 Flash BIN Analyzer
        </h2>
        <p className="text-gray-400 text-xs mt-1">
          Drop any raw <code className="text-amber-400">.bin</code> flash dump — ECU detection, region map, VIN scan, SEC bytes, part numbers, entropy heatmap.
        </p>
      </div>

      {/* Drop zone */}
      <div
        onDrop={onDrop}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onClick={() => document.getElementById('flash-bin-input').click()}
        className="rounded-xl border-2 border-dashed cursor-pointer transition-all duration-200 flex flex-col items-center justify-center py-10 gap-3"
        style={{
          borderColor: dragOver ? '#f59e0b' : '#374151',
          backgroundColor: dragOver ? 'rgba(245,158,11,0.06)' : 'rgba(255,255,255,0.02)',
        }}
        data-testid="flash-bin-dropzone"
      >
        <input
          id="flash-bin-input"
          type="file"
          accept=".bin"
          className="hidden"
          onChange={onFileInput}
        />
        <div className="text-3xl">📂</div>
        <div className="text-gray-400 text-sm">
          {loading ? 'Analyzing…' : 'Drop a .bin file here or click to browse'}
        </div>
        <div className="text-gray-600 text-xs">
          GPEC2A · GPEC3 · BCM · TCM · RFHUB · EXT EEPROM · any raw flash dump
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-red-400 text-sm">
          ✗ {error}
        </div>
      )}

      {/* Results */}
      {analysis && (
        <div className="space-y-4" data-testid="flash-bin-results">

          {/* File summary header */}
          <div className="rounded-xl border border-white/10 bg-white/5 px-5 py-4 flex flex-wrap items-start gap-4 justify-between">
            <div className="space-y-1">
              <div className="font-mono text-base font-bold text-white">{analysis.filename}</div>
              <div className="flex flex-wrap gap-2 mt-1">
                <Badge color="#94a3b8">{analysis.sizeLabel}</Badge>
                <Badge color="#94a3b8">{analysis.size.toLocaleString()} bytes</Badge>
                <Badge color="#94a3b8">{analysis.sizeHex}</Badge>
                <Badge
                  color={analysis.likelyEncrypted ? '#f87171' : '#34d399'}
                  bg={analysis.likelyEncrypted ? 'rgba(248,113,113,0.1)' : 'rgba(52,211,153,0.1)'}
                >
                  ent {analysis.overallEntropy.toFixed(2)}
                </Badge>
                <Badge color="#94a3b8">FF {analysis.overallFfPct.toFixed(0)}%</Badge>
              </div>
              {analysis.likelyEncrypted && (
                <div className="text-red-400 text-xs mt-1">
                  ⚠ Entropy &gt; 7.9 — likely encrypted or compressed (not a raw flash dump)
                </div>
              )}
            </div>
            <button
              onClick={downloadReport}
              className="px-3 py-1.5 rounded text-xs font-bold border transition-colors"
              style={{ borderColor: '#f59e0b44', color: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.08)' }}
            >
              ⬇ Download Report (.txt)
            </button>
          </div>

          {/* ECU Detection */}
          {analysis.detected ? (
            <Section title="ECU Detection" accent="#10b981">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2 text-xs">
                <div>
                  <span className="text-gray-500 uppercase tracking-wider">Type</span>
                  <div className="font-bold text-green-400 text-sm mt-0.5">{analysis.detected.label}</div>
                </div>
                <div>
                  <span className="text-gray-500 uppercase tracking-wider">Chip</span>
                  <div className="font-mono text-white mt-0.5">{analysis.detected.chip}</div>
                </div>
                <div>
                  <span className="text-gray-500 uppercase tracking-wider">Architecture</span>
                  <div className="font-mono text-gray-300 mt-0.5">{analysis.detected.architecture}</div>
                </div>
                <div>
                  <span className="text-gray-500 uppercase tracking-wider">Programmer</span>
                  <div className="font-mono text-amber-400 mt-0.5">{analysis.detected.programmer}</div>
                </div>
                <div className="sm:col-span-2">
                  <span className="text-gray-500 uppercase tracking-wider">Notes</span>
                  <div className="text-gray-300 mt-0.5">{analysis.detected.notes}</div>
                </div>
              </div>
            </Section>
          ) : (
            <Section title="ECU Detection" accent="#ef4444">
              <div className="text-red-400 text-sm">
                No ECU profile matched this file size ({analysis.sizeLabel}).
                {analysis.likelyEncrypted && ' File appears to be encrypted — not a raw flash dump.'}
              </div>
            </Section>
          )}

          {/* Region Map */}
          {analysis.regions.length > 0 && (
            <Section title="Flash Region Map" accent="#6366f1">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="text-gray-500 uppercase tracking-wider text-left">
                    <th className="pb-2 pr-4">Start</th>
                    <th className="pb-2 pr-4">End</th>
                    <th className="pb-2 pr-4">Size</th>
                    <th className="pb-2 pr-4">Region</th>
                    <th className="pb-2">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {analysis.regions.map((r, i) => {
                    const sz = r.end - r.start + 1;
                    const szStr = sz >= 1048576 ? `${(sz/1048576).toFixed(2)} MB` : sz >= 1024 ? `${(sz/1024).toFixed(0)} KB` : `${sz} B`;
                    return (
                      <tr key={i} className="hover:bg-white/5">
                        <td className="py-1.5 pr-4 text-blue-400">0x{r.start.toString(16).toUpperCase().padStart(6,'0')}</td>
                        <td className="py-1.5 pr-4 text-blue-400">0x{r.end.toString(16).toUpperCase().padStart(6,'0')}</td>
                        <td className="py-1.5 pr-4 text-gray-300">{szStr}</td>
                        <td className="py-1.5 pr-4 text-white font-bold">{r.name}</td>
                        <td className="py-1.5 text-gray-400">{r.notes}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Section>
          )}

          {/* Entropy Heatmap */}
          <Section title="Entropy Heatmap" accent="#8b5cf6">
            <EntropyBar entropyMap={analysis.entropyMap} />
            <div className="mt-3 text-xs text-gray-500">
              Hover over a color block to see the exact range, entropy, and FF%. Each block = {
                analysis.size <= 65536 ? '4 KB' : '64 KB'
              }.
            </div>
          </Section>

          {/* VIN Scan */}
          <Section title={`VIN Scan${analysis.vins.length > 0 ? ` — ${analysis.vins.length} found` : ' — none found'}`} accent="#06b6d4">
            {analysis.vins.length === 0 ? (
              <div className="text-gray-500 text-xs">
                No VIN-like strings found with known WMI prefixes.
                {analysis.detected && analysis.detected.id.startsWith('GPEC2A_LB') &&
                  ' Expected — VINs live in the EXT EEPROM (95320/95640), not in the LB18 flash region.'}
              </div>
            ) : (
              <div className="space-y-1">
                {analysis.vins.map((v, i) => (
                  <div key={i} className="flex items-center gap-3 font-mono text-xs">
                    <span className="text-blue-400">0x{v.offset.toString(16).toUpperCase().padStart(6,'0')}</span>
                    <span className="text-white font-bold text-sm">{v.vin}</span>
                    {v.reversed && <Badge color="#a78bfa">stored reversed</Badge>}
                    {v.knownWmi && <Badge color="#34d399">✓ known WMI</Badge>}
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* Security Bytes */}
          <Section title={`Security Bytes${analysis.secBytes.length > 0 ? ` — ${analysis.secBytes.length} region${analysis.secBytes.length > 1 ? 's' : ''}` : ''}`} accent="#f43f5e">
            {analysis.secBytes.length === 0 ? (
              <div className="text-gray-500 text-xs">
                No SEC byte offsets defined for this ECU type.
                {analysis.detected && analysis.detected.id.startsWith('GPEC2A_LB') &&
                  ' SEC6 lives in the EXT EEPROM (95320/95640), not in the LB18 flash region.'}
              </div>
            ) : (
              <div className="space-y-2">
                {analysis.secBytes.map((s, i) => (
                  <div key={i} className="flex items-center gap-3 text-xs">
                    <span className="font-mono text-blue-400">0x{s.offset.toString(16).toUpperCase().padStart(6,'0')}</span>
                    <span className="text-gray-400">[{s.label}]</span>
                    <HexValue hex={s.hex} virgin={s.virgin} />
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* Part Numbers */}
          {analysis.partNumbers.length > 0 && (
            <Section title={`Part Numbers / Calibration IDs — ${analysis.partNumbers.length} found`} accent="#f59e0b">
              <div className="space-y-1">
                {analysis.partNumbers.map((p, i) => (
                  <div key={i} className="flex items-start gap-3 text-xs">
                    <span className="font-mono text-blue-400 shrink-0">0x{p.offset.toString(16).toUpperCase().padStart(6,'0')}</span>
                    <span className="font-mono font-bold text-amber-400">{p.value}</span>
                    <span className="text-gray-500 truncate">{p.context.slice(0, 60)}</span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Copyright */}
          {analysis.copyright && (
            <Section title="Copyright / Watermark" accent="#10b981">
              <div className="text-xs">
                <span className="font-mono text-blue-400">0x{analysis.copyright.offset.toString(16).toUpperCase().padStart(6,'0')}</span>
                <p className="text-gray-300 mt-1 leading-relaxed">{analysis.copyright.text}</p>
              </div>
            </Section>
          )}

          {/* Notable Strings */}
          {analysis.interestingStrings.filter(s => s.text !== analysis.copyright?.text).length > 0 && (
            <Section title="Notable Strings" accent="#64748b">
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {analysis.interestingStrings
                  .filter(s => s.text !== analysis.copyright?.text)
                  .map((s, i) => (
                    <div key={i} className="flex items-start gap-3 text-xs">
                      <span className="font-mono text-blue-400 shrink-0">0x{s.offset.toString(16).toUpperCase().padStart(6,'0')}</span>
                      <span className="text-gray-300 font-mono break-all">{s.text.slice(0, 120)}</span>
                    </div>
                  ))}
              </div>
            </Section>
          )}

          {/* Entropy block table (collapsed by default, expandable) */}
          <Section title="Entropy Block Table" accent="#475569">
            <div className="max-h-64 overflow-y-auto">
              <table className="w-full text-xs font-mono">
                <thead className="sticky top-0 bg-gray-900">
                  <tr className="text-gray-500 uppercase tracking-wider text-left">
                    <th className="pb-2 pr-3">#</th>
                    <th className="pb-2 pr-3">Range</th>
                    <th className="pb-2 pr-3">Entropy</th>
                    <th className="pb-2 pr-3">FF%</th>
                    <th className="pb-2">Type</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {analysis.entropyMap.map((b, i) => (
                    <tr key={i} className="hover:bg-white/5">
                      <td className="py-1 pr-3 text-gray-500">{b.index}</td>
                      <td className="py-1 pr-3 text-blue-400">
                        0x{b.start.toString(16).toUpperCase().padStart(6,'0')}–0x{b.end.toString(16).toUpperCase().padStart(6,'0')}
                      </td>
                      <td className="py-1 pr-3" style={{ color: entropyColor(b.entropy, b.ffPercent) }}>
                        {b.entropy.toFixed(2)}
                      </td>
                      <td className="py-1 pr-3 text-gray-400">{b.ffPercent.toFixed(0)}%</td>
                      <td className="py-1 text-gray-400">{b.label}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

        </div>
      )}
    </div>
  );
}
