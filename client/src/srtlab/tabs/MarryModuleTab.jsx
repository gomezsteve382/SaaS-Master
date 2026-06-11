/*
 * MarryModuleTab.jsx — Unified Marry/Sync tab consolidating vinsync, secsync,
 * modsync, and keyprog workflows using the marryModule() engine.
 *
 * Split-screen layout:
 *   LEFT: Workflow selector, module uploads, VIN input, Marry button
 *   RIGHT: Module cards, check results, verification status, checksum details, download
 */
import React, { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { marryModule } from '../lib/marryModule.js';
import { parseModule } from '../lib/parseModule.js';

// Simple spinner component
const Spinner = ({ className = '' }) => (
  <div className={`inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin ${className}`} />
);

const WORKFLOWS = {
  vinsync: {
    id: 'vinsync',
    label: 'VIN Sync',
    description: 'Stamp VIN across BCM → RFHUB → PCM',
    icon: '🏷️',
  },
  secsync: {
    id: 'secsync',
    label: 'SEC Sync',
    description: 'Sync SEC16/SEC6 across modules',
    icon: '🔐',
  },
  modsync: {
    id: 'modsync',
    label: 'Module Sync',
    description: 'Pair any source → any target module',
    icon: '🔗',
  },
  keyprog: {
    id: 'keyprog',
    label: 'Key Program',
    description: 'Virgin BCM re-key from source secret',
    icon: '🔑',
  },
};

export default function MarryModuleTab() {
  const [workflow, setWorkflow] = useState('modsync');
  const [sourceFile, setSourceFile] = useState(null);
  const [targetFile, setTargetFile] = useState(null);
  const [sourceInfo, setSourceInfo] = useState(null);
  const [targetInfo, setTargetInfo] = useState(null);
  const [vin, setVin] = useState('');
  const [fobikCount, setFobikCount] = useState(16);
  const [allowUnverified, setAllowUnverified] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [checksumDetailsOpen, setChecksumDetailsOpen] = useState(false);

  const handleSourceDrop = async (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    
    const file = files[0];
    const reader = new FileReader();
    reader.onload = async (event) => {
      const data = new Uint8Array(event.target.result);
      const info = parseModule(data, file.name);
      setSourceFile(data);
      setSourceInfo(info);
      setError(null);
    };
    reader.readAsArrayBuffer(file);
  };

  const handleTargetDrop = async (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    
    const file = files[0];
    const reader = new FileReader();
    reader.onload = async (event) => {
      const data = new Uint8Array(event.target.result);
      const info = parseModule(data, file.name);
      setTargetFile(data);
      setTargetInfo(info);
      setError(null);
    };
    reader.readAsArrayBuffer(file);
  };

  const handleMarry = async () => {
    if (!sourceFile || !targetFile) {
      setError('Both source and target modules required');
      return;
    }

    setIsRunning(true);
    setError(null);
    setResult(null);

    try {
      const marryResult = await marryModule({
        sourceData: sourceFile,
        sourceType: sourceInfo?.type,
        targetData: targetFile,
        targetType: targetInfo?.type,
        vin: workflow === 'vinsync' ? vin : undefined,
        fobikCount: workflow === 'keyprog' ? fobikCount : undefined,
        allowUnverified,
      });

      if (!marryResult.ok) {
        setError(marryResult.error || 'Marry operation failed');
        return;
      }

      setResult(marryResult);
    } catch (err) {
      setError(err.message || 'Unknown error during marry operation');
    } finally {
      setIsRunning(false);
    }
  };

  const downloadResult = () => {
    if (!result?.bytes) return;
    
    const blob = new Blob([result.bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `married_${result.targetType}.bin`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const currentWorkflow = WORKFLOWS[workflow];

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-purple-900 to-black p-6">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-4xl font-bold text-white mb-2">💍 Marry Modules</h1>
        <p className="text-gray-400 mb-8">Unified VIN/SEC/KEY synchronization engine</p>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* LEFT PANEL — Controls */}
          <div className="lg:col-span-1">
            <Card className="bg-gray-800 border-purple-600 p-6 space-y-6">
              {/* Workflow Selector */}
              <div>
                <Label className="text-white font-bold mb-4 block">Workflow</Label>
                <div className="space-y-2">
                  {Object.values(WORKFLOWS).map((w) => (
                    <label key={w.id} className="flex items-center gap-3 p-2 rounded hover:bg-purple-700 cursor-pointer transition">
                      <input
                        type="radio"
                        name="workflow"
                        value={w.id}
                        checked={workflow === w.id}
                        onChange={(e) => setWorkflow(e.target.value)}
                        className="w-4 h-4"
                      />
                      <span className="text-lg">{w.icon}</span>
                      <div>
                        <div className="font-semibold text-white text-sm">{w.label}</div>
                        <div className="text-xs text-gray-400">{w.description}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {/* Source Module Upload */}
              <div>
                <Label className="text-white font-bold mb-2 block">Source Module</Label>
                <div
                  onDrop={handleSourceDrop}
                  onDragOver={(e) => e.preventDefault()}
                  className="border-2 border-dashed border-purple-500 rounded-lg p-6 text-center cursor-pointer hover:border-purple-400 transition"
                >
                  {sourceInfo ? (
                    <div className="text-green-400">
                      <div className="font-bold">{sourceInfo.type}</div>
                      <div className="text-xs text-gray-400">{sourceInfo.size} bytes</div>
                      {sourceInfo.vin && <div className="text-xs text-gray-400">VIN: {sourceInfo.vin}</div>}
                    </div>
                  ) : (
                    <div className="text-gray-400">
                      <div className="text-2xl mb-2">📂</div>
                      <div className="text-sm">Drag & drop source module</div>
                    </div>
                  )}
                </div>
              </div>

              {/* Target Module Upload */}
              <div>
                <Label className="text-white font-bold mb-2 block">Target Module</Label>
                <div
                  onDrop={handleTargetDrop}
                  onDragOver={(e) => e.preventDefault()}
                  className="border-2 border-dashed border-pink-500 rounded-lg p-6 text-center cursor-pointer hover:border-pink-400 transition"
                >
                  {targetInfo ? (
                    <div className="text-green-400">
                      <div className="font-bold">{targetInfo.type}</div>
                      <div className="text-xs text-gray-400">{targetInfo.size} bytes</div>
                      {targetInfo.vin && <div className="text-xs text-gray-400">VIN: {targetInfo.vin}</div>}
                    </div>
                  ) : (
                    <div className="text-gray-400">
                      <div className="text-2xl mb-2">📂</div>
                      <div className="text-sm">Drag & drop target module</div>
                    </div>
                  )}
                </div>
              </div>

              {/* VIN Input (VIN Sync only) */}
              {workflow === 'vinsync' && (
                <div>
                  <Label className="text-white font-bold mb-2 block">VIN (17 chars)</Label>
                  <Input
                    type="text"
                    value={vin}
                    onChange={(e) => setVin(e.target.value.toUpperCase())}
                    maxLength={17}
                    placeholder="1C3CDXGJ9KH530589"
                    className="bg-gray-700 border-gray-600 text-white"
                  />
                </div>
              )}

              {/* FOBIK Count (Key Program only) */}
              {workflow === 'keyprog' && (
                <div>
                  <Label className="text-white font-bold mb-2 block">FOBIK Count</Label>
                  <Input
                    type="number"
                    value={fobikCount}
                    onChange={(e) => setFobikCount(parseInt(e.target.value))}
                    min={1}
                    max={255}
                    className="bg-gray-700 border-gray-600 text-white"
                  />
                </div>
              )}

              {/* Safety Gate */}
              <div className="flex items-center gap-2">
                <Checkbox
                  id="allowUnverified"
                  checked={allowUnverified}
                  onCheckedChange={setAllowUnverified}
                />
                <Label htmlFor="allowUnverified" className="text-gray-300 text-sm cursor-pointer">
                  Allow unverified target (Gen1/XC2268)
                </Label>
              </div>

              {/* Marry Button */}
              <button
                onClick={handleMarry}
                disabled={!sourceFile || !targetFile || isRunning}
                className="w-full bg-gradient-to-r from-purple-600 to-pink-600 text-white font-bold py-3 rounded-lg hover:shadow-lg transition disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isRunning ? (
                  <>
                    <Spinner className="w-4 h-4" />
                    Marrying...
                  </>
                ) : (
                  '💍 Marry Modules'
                )}
              </button>

              {/* Error Message */}
              {error && (
                <div className="bg-red-900 border border-red-600 text-red-200 p-3 rounded text-sm">
                  {error}
                </div>
              )}
            </Card>
          </div>

          {/* RIGHT PANEL — Results */}
          <div className="lg:col-span-2">
            <Card className="bg-gray-800 border-purple-600 p-6">
              {/* Workflow Description */}
              <div className="mb-6 p-4 bg-purple-900 rounded-lg border border-purple-600">
                <h3 className="text-white font-bold mb-2">{currentWorkflow.label}</h3>
                <p className="text-gray-300 text-sm">{currentWorkflow.description}</p>
              </div>

              {/* Module Cards */}
              {(sourceInfo || targetInfo) && (
                <div className="grid grid-cols-2 gap-4 mb-6">
                  {sourceInfo && (
                    <div className="bg-gray-700 p-4 rounded-lg border border-green-600">
                      <div className="text-green-400 font-bold mb-2">📦 Source</div>
                      <div className="text-sm text-gray-300 space-y-1">
                        <div><span className="text-gray-400">Type:</span> {sourceInfo.type}</div>
                        <div><span className="text-gray-400">Size:</span> {sourceInfo.size} bytes</div>
                        {sourceInfo.vin && <div><span className="text-gray-400">VIN:</span> {sourceInfo.vin}</div>}
                      </div>
                    </div>
                  )}
                  {targetInfo && (
                    <div className="bg-gray-700 p-4 rounded-lg border border-pink-600">
                      <div className="text-pink-400 font-bold mb-2">📦 Target</div>
                      <div className="text-sm text-gray-300 space-y-1">
                        <div><span className="text-gray-400">Type:</span> {targetInfo.type}</div>
                        <div><span className="text-gray-400">Size:</span> {targetInfo.size} bytes</div>
                        {targetInfo.vin && <div><span className="text-gray-400">VIN:</span> {targetInfo.vin}</div>}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Check Results */}
              {result && (
                <div className="space-y-6">
                  {/* Verification Status */}
                  <div className={`p-4 rounded-lg border ${result.verified ? 'bg-green-900 border-green-600' : 'bg-red-900 border-red-600'}`}>
                    <div className={`font-bold ${result.verified ? 'text-green-400' : 'text-red-400'}`}>
                      {result.verified ? '✓ Round-trip Verified' : '✗ Verification Failed'}
                    </div>
                    {result.grounding && (
                      <Badge className="mt-2 bg-purple-600">{result.grounding}</Badge>
                    )}
                  </div>

                  {/* Checks Table */}
                  {result.checks && result.checks.length > 0 && (
                    <div>
                      <h4 className="text-white font-bold mb-3">Verification Checks</h4>
                      <div className="space-y-2">
                        {result.checks.map((check, i) => (
                          <div key={i} className="flex items-center gap-3 p-3 bg-gray-700 rounded">
                            <span className={check.pass ? 'text-green-400' : 'text-red-400'}>
                              {check.pass ? '✓' : '✗'}
                            </span>
                            <div className="flex-1">
                              <div className="text-white font-semibold text-sm">{check.label}</div>
                              {check.detail && <div className="text-gray-400 text-xs">{check.detail}</div>}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Checksum Details */}
                  <div>
                    <button
                      onClick={() => setChecksumDetailsOpen(!checksumDetailsOpen)}
                      className="text-purple-400 hover:text-purple-300 font-semibold text-sm"
                    >
                      {checksumDetailsOpen ? '▼' : '▶'} Checksum Details
                    </button>
                    {checksumDetailsOpen && (
                      <div className="mt-3 p-3 bg-gray-700 rounded text-xs font-mono text-gray-300 space-y-1">
                        {result.details && Object.entries(result.details).map(([k, v]) => (
                          <div key={k}><span className="text-gray-500">{k}:</span> {String(v)}</div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Download Button */}
                  {result.ok && (
                    <button
                      onClick={downloadResult}
                      className="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-2 rounded-lg transition"
                    >
                      ⬇️ Download Married {result.targetType}.bin
                    </button>
                  )}
                </div>
              )}

              {/* Empty State */}
              {!result && (
                <div className="text-center py-12">
                  <div className="text-6xl mb-4">💍</div>
                  <div className="text-gray-400">Load modules and click "Marry Modules" to begin</div>
                </div>
              )}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
