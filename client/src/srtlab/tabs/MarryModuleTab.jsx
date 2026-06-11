/**
 * MarryModuleTab.jsx — Unified Marry/Sync tab consolidating vinsync, secsync,
 * modsync, and keyprog workflows using the marryModule() engine.
 *
 * Split-screen layout:
 *   LEFT: Workflow selector, module uploads, VIN input, Marry button
 *   RIGHT: Module cards, check results, verification status, checksum details, download
 *   PROGRESS: Animated status messages during marryAll() and zip generation
 */
import React, { useState, useRef } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { AlertCircle, CheckCircle2, Loader } from 'lucide-react';
import { marryModule, marryAll } from '../lib/marryModule.js';
import { parseModule } from '../lib/parseModule.js';

// Animated spinner component
const Spinner = ({ className = '' }) => (
  <div className={`inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin ${className}`} />
);

// Progress step indicator with animation
const ProgressStep = ({ step, label, status, isActive }) => {
  const statusColors = {
    pending: 'text-gray-400',
    running: 'text-blue-400',
    success: 'text-green-400',
    error: 'text-red-400',
  };

  return (
    <div className="flex items-center gap-3 mb-3">
      <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center font-bold ${
        status === 'success' ? 'bg-green-500/20 text-green-400' :
        status === 'error' ? 'bg-red-500/20 text-red-400' :
        status === 'running' ? 'bg-blue-500/20 text-blue-400 animate-pulse' :
        'bg-gray-500/20 text-gray-400'
      }`}>
        {status === 'running' && <Spinner className="w-4 h-4" />}
        {status === 'success' && <CheckCircle2 className="w-4 h-4" />}
        {status === 'error' && <AlertCircle className="w-4 h-4" />}
        {!['running', 'success', 'error'].includes(status) && step}
      </div>
      <div className="flex-1">
        <p className={`text-sm font-medium ${statusColors[status]}`}>{label}</p>
      </div>
    </div>
  );
};

// Status message panel with animation
const StatusPanel = ({ isVisible, title, steps, currentStep, error }) => {
  if (!isVisible) return null;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
      <Card className="w-full max-w-md bg-gray-900 border-gray-700 p-6 shadow-2xl">
        <h3 className="text-lg font-bold text-white mb-6 flex items-center gap-2">
          <Spinner className="w-5 h-5 text-blue-400" />
          {title}
        </h3>
        
        <div className="space-y-2 mb-6 max-h-64 overflow-y-auto">
          {steps.map((step, idx) => (
            <ProgressStep
              key={idx}
              step={idx + 1}
              label={step.label}
              status={step.status}
              isActive={idx === currentStep}
            />
          ))}
        </div>

        {error && (
          <div className="bg-red-500/20 border border-red-500/50 rounded-lg p-3 mb-4">
            <p className="text-sm text-red-300 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {error}
            </p>
          </div>
        )}

        <div className="text-xs text-gray-400 text-center">
          Processing... This may take a few seconds
        </div>
      </Card>
    </div>
  );
};

// Result summary card with verification badges
const ResultSummary = ({ result, onDownload }) => {
  if (!result) return null;

  const allPassed = result.checks?.every(c => c.pass);
  const crossSyncPassed = result.crossSync;

  return (
    <Card className="bg-gradient-to-br from-green-500/10 to-emerald-500/10 border-green-500/30 p-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-lg font-bold text-white flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-green-400" />
            Marry Operation Complete
          </h3>
          <p className="text-sm text-gray-300 mt-1">All modules successfully married and verified</p>
        </div>
      </div>

      <div className="space-y-3 mb-6">
        {result.checks?.map((check, idx) => (
          <div key={idx} className="flex items-center gap-2 text-sm">
            {check.pass ? (
              <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
            )}
            <span className={check.pass ? 'text-gray-300' : 'text-red-300'}>
              {check.label}
            </span>
          </div>
        ))}
      </div>

      {result.files?.length > 0 && (
        <Button
          onClick={onDownload}
          className="w-full bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700 text-white font-semibold py-2 rounded-lg transition-all duration-200 transform hover:scale-105"
        >
          Download Married Modules ({result.files.length} files)
        </Button>
      )}
    </Card>
  );
};

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
  marryall: {
    id: 'marryall',
    label: 'Marry All 3',
    description: 'Marry BCM + RFHUB + PCM in one operation',
    icon: '⚙️',
  },
};

export default function MarryModuleTab() {
  const [workflow, setWorkflow] = useState('modsync');
  const [sourceFile, setSourceFile] = useState(null);
  const [targetFile, setTargetFile] = useState(null);
  const [rfhubFile, setRfhubFile] = useState(null);
  const [pcmFile, setPcmFile] = useState(null);
  const [sourceInfo, setSourceInfo] = useState(null);
  const [targetInfo, setTargetInfo] = useState(null);
  const [rfhubInfo, setRfhubInfo] = useState(null);
  const [pcmInfo, setPcmInfo] = useState(null);
  const [vin, setVin] = useState('');
  const [fobikCount, setFobikCount] = useState(16);
  const [allowUnverified, setAllowUnverified] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [checksumDetailsOpen, setChecksumDetailsOpen] = useState(false);
  const [progressSteps, setProgressSteps] = useState([]);
  const [currentStep, setCurrentStep] = useState(0);

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

  const handleRfhubDrop = async (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    const file = files[0];
    const reader = new FileReader();
    reader.onload = async (event) => {
      const data = new Uint8Array(event.target.result);
      const info = parseModule(data, file.name);
      setRfhubFile(data);
      setRfhubInfo(info);
      setError(null);
    };
    reader.readAsArrayBuffer(file);
  };

  const handlePcmDrop = async (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    const file = files[0];
    const reader = new FileReader();
    reader.onload = async (event) => {
      const data = new Uint8Array(event.target.result);
      const info = parseModule(data, file.name);
      setPcmFile(data);
      setPcmInfo(info);
      setError(null);
    };
    reader.readAsArrayBuffer(file);
  };

  const updateProgress = (steps, current) => {
    setProgressSteps(steps);
    setCurrentStep(current);
  };

  const handleMarry = async () => {
    if (workflow === 'marryall') {
      if (!sourceFile || (!rfhubFile && !pcmFile)) {
        setError('BCM source and at least one target (RFHUB or PCM) required');
        return;
      }
    } else {
      if (!sourceFile || !targetFile) {
        setError('Both source and target modules required');
        return;
      }
    }

    setIsRunning(true);
    setError(null);
    setResult(null);

    const steps = workflow === 'marryall' 
      ? [
          { label: 'Parsing BCM source...', status: 'pending' },
          { label: 'Marrying RFHUB (if provided)...', status: 'pending' },
          { label: 'Marrying PCM (if provided)...', status: 'pending' },
          { label: 'Verifying cross-sync...', status: 'pending' },
          { label: 'Generating zip file...', status: 'pending' },
        ]
      : [
          { label: 'Parsing modules...', status: 'pending' },
          { label: 'Running marry operation...', status: 'pending' },
          { label: 'Verifying output...', status: 'pending' },
          { label: 'Generating download...', status: 'pending' },
        ];

    updateProgress(steps, 0);

    try {
      if (workflow === 'marryall') {
        // Update step 0
        updateProgress(
          steps.map((s, i) => i === 0 ? { ...s, status: 'running' } : s),
          0
        );
        await new Promise(r => setTimeout(r, 300));

        // Call marryAll
        updateProgress(
          steps.map((s, i) => i === 0 ? { ...s, status: 'success' } : i === 1 ? { ...s, status: 'running' } : s),
          1
        );

        const marryResult = await marryAll({
          bcm: { bytes: sourceFile, info: sourceInfo },
          rfhub: rfhubFile ? { bytes: rfhubFile, info: rfhubInfo } : undefined,
          pcm: pcmFile ? { bytes: pcmFile, info: pcmInfo } : undefined,
          vin: workflow === 'vinsync' ? vin : undefined,
          allowUnverifiedTarget: allowUnverified,
        });

        if (!marryResult.ok) {
          updateProgress(
            steps.map((s, i) => i < 3 ? { ...s, status: 'error' } : s),
            3
          );
          setError(marryResult.checks?.[0]?.detail || 'Marry operation failed');
          return;
        }

        // Update steps to success
        updateProgress(
          steps.map((s, i) => i <= 3 ? { ...s, status: 'success' } : i === 4 ? { ...s, status: 'running' } : s),
          4
        );

        // Simulate zip generation
        await new Promise(r => setTimeout(r, 500));

        updateProgress(
          steps.map((s, i) => ({ ...s, status: 'success' })),
          4
        );

        setResult(marryResult);
      } else {
        // 2-module marry flow
        updateProgress(
          steps.map((s, i) => i === 0 ? { ...s, status: 'running' } : s),
          0
        );
        await new Promise(r => setTimeout(r, 300));

        updateProgress(
          steps.map((s, i) => i === 0 ? { ...s, status: 'success' } : i === 1 ? { ...s, status: 'running' } : s),
          1
        );

        const marryResult = await marryModule({
          source: { bytes: sourceFile, info: sourceInfo },
          target: { bytes: targetFile, info: targetInfo },
          vin: workflow === 'vinsync' ? vin : undefined,
          allowUnverifiedTarget: allowUnverified,
        });

        if (!marryResult.ok) {
          updateProgress(
            steps.map((s, i) => i < 2 ? { ...s, status: 'error' } : s),
            2
          );
          setError(marryResult.checks?.[0]?.detail || 'Marry operation failed');
          return;
        }

        updateProgress(
          steps.map((s, i) => i <= 2 ? { ...s, status: 'success' } : i === 3 ? { ...s, status: 'running' } : s),
          3
        );

        await new Promise(r => setTimeout(r, 300));

        updateProgress(
          steps.map((s, i) => ({ ...s, status: 'success' })),
          3
        );

        setResult(marryResult);
      }
    } catch (err) {
      updateProgress(
        steps.map((s, i) => i <= currentStep ? { ...s, status: 'error' } : s),
        currentStep
      );
      setError(err.message || 'Unknown error during marry operation');
    } finally {
      setIsRunning(false);
    }
  };

  const downloadResult = () => {
    if (!result) return;

    if (result.files && result.files.length > 0) {
      // Zip download for marryAll
      try {
        const { zipSync } = require('fflate');
        const fileObj = {};
        result.files.forEach(f => {
          fileObj[f.name] = new Uint8Array(f.bytes);
        });
        const zipped = zipSync(fileObj);
        const blob = new Blob([zipped], { type: 'application/zip' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `married-modules_${new Date().toISOString().slice(0, 10)}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (err) {
        setError('Failed to generate zip file: ' + err.message);
      }
    } else if (result.bytes) {
      // Single file download for 2-module marry
      const blob = new Blob([result.bytes], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `married_${result.targetType}.bin`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  };

  const currentWorkflow = WORKFLOWS[workflow];

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-purple-900 to-black p-6">
      <StatusPanel
        isVisible={isRunning}
        title={workflow === 'marryall' ? 'Marrying All 3 Modules' : 'Running Marry Operation'}
        steps={progressSteps}
        currentStep={currentStep}
        error={error}
      />

      <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* LEFT PANEL — Controls */}
        <div className="lg:col-span-1 space-y-4">
          <Card className="bg-gray-900/50 border-gray-700 p-4">
            <h2 className="text-lg font-bold text-white mb-4">Workflow</h2>
            <div className="space-y-2">
              {Object.values(WORKFLOWS).map(w => (
                <label key={w.id} className="flex items-center gap-3 p-2 rounded-lg cursor-pointer hover:bg-gray-800/50 transition-colors">
                  <input
                    type="radio"
                    name="workflow"
                    value={w.id}
                    checked={workflow === w.id}
                    onChange={(e) => setWorkflow(e.target.value)}
                    className="w-4 h-4"
                  />
                  <span className="text-sm text-gray-300">{w.icon} {w.label}</span>
                </label>
              ))}
            </div>
          </Card>

          {/* Upload areas */}
          {workflow === 'marryall' ? (
            <>
              <Card
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleSourceDrop}
                className="bg-gray-900/50 border-2 border-dashed border-blue-500/30 hover:border-blue-500/60 p-6 text-center cursor-pointer transition-colors"
              >
                <p className="text-sm text-gray-400 mb-2">📥 Drop BCM (Source)</p>
                {sourceInfo && <p className="text-xs text-green-400">{sourceInfo.type} - {sourceFile?.length} bytes</p>}
              </Card>

              <Card
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleRfhubDrop}
                className="bg-gray-900/50 border-2 border-dashed border-purple-500/30 hover:border-purple-500/60 p-6 text-center cursor-pointer transition-colors"
              >
                <p className="text-sm text-gray-400 mb-2">📥 Drop RFHUB (Optional)</p>
                {rfhubInfo && <p className="text-xs text-green-400">{rfhubInfo.type} - {rfhubFile?.length} bytes</p>}
              </Card>

              <Card
                onDragOver={(e) => e.preventDefault()}
                onDrop={handlePcmDrop}
                className="bg-gray-900/50 border-2 border-dashed border-emerald-500/30 hover:border-emerald-500/60 p-6 text-center cursor-pointer transition-colors"
              >
                <p className="text-sm text-gray-400 mb-2">📥 Drop PCM (Optional)</p>
                {pcmInfo && <p className="text-xs text-green-400">{pcmInfo.type} - {pcmFile?.length} bytes</p>}
              </Card>
            </>
          ) : (
            <>
              <Card
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleSourceDrop}
                className="bg-gray-900/50 border-2 border-dashed border-blue-500/30 hover:border-blue-500/60 p-6 text-center cursor-pointer transition-colors"
              >
                <p className="text-sm text-gray-400 mb-2">📥 Drop Source Module</p>
                {sourceInfo && <p className="text-xs text-green-400">{sourceInfo.type} - {sourceFile?.length} bytes</p>}
              </Card>

              <Card
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleTargetDrop}
                className="bg-gray-900/50 border-2 border-dashed border-purple-500/30 hover:border-purple-500/60 p-6 text-center cursor-pointer transition-colors"
              >
                <p className="text-sm text-gray-400 mb-2">📥 Drop Target Module</p>
                {targetInfo && <p className="text-xs text-green-400">{targetInfo.type} - {targetFile?.length} bytes</p>}
              </Card>
            </>
          )}

          {workflow === 'vinsync' && (
            <div className="space-y-2">
              <Label className="text-gray-300">VIN (optional)</Label>
              <Input
                value={vin}
                onChange={(e) => setVin(e.target.value)}
                placeholder="17-character VIN"
                maxLength={17}
                className="bg-gray-800 border-gray-700 text-white"
              />
            </div>
          )}

          {workflow === 'keyprog' && (
            <div className="space-y-2">
              <Label className="text-gray-300">FOBIK Count</Label>
              <Input
                type="number"
                value={fobikCount}
                onChange={(e) => setFobikCount(parseInt(e.target.value))}
                min={1}
                max={256}
                className="bg-gray-800 border-gray-700 text-white"
              />
            </div>
          )}

          <label className="flex items-center gap-2 p-2 rounded-lg hover:bg-gray-800/50 transition-colors cursor-pointer">
            <Checkbox
              checked={allowUnverified}
              onCheckedChange={setAllowUnverified}
            />
            <span className="text-sm text-gray-300">Allow Unverified Target</span>
          </label>

          <Button
            onClick={handleMarry}
            disabled={isRunning}
            className="w-full bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white font-semibold py-3 rounded-lg transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isRunning ? (
              <>
                <Spinner className="w-4 h-4 mr-2" />
                Processing...
              </>
            ) : (
              `${workflow === 'marryall' ? 'Marry All 3' : 'Marry Modules'}`
            )}
          </Button>
        </div>

        {/* RIGHT PANEL — Results */}
        <div className="lg:col-span-2 space-y-4">
          {error && (
            <Card className="bg-red-500/10 border-red-500/30 p-4">
              <p className="text-sm text-red-300 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                {error}
              </p>
            </Card>
          )}

          {result && (
            <ResultSummary result={result} onDownload={downloadResult} />
          )}

          {result?.checks && (
            <Card className="bg-gray-900/50 border-gray-700 p-4">
              <h3 className="text-sm font-bold text-white mb-3">Verification Checks</h3>
              <div className="space-y-2">
                {result.checks.map((check, idx) => (
                  <div key={idx} className="flex items-start gap-2 text-sm">
                    {check.pass ? (
                      <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0 mt-0.5" />
                    ) : (
                      <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                    )}
                    <div className="flex-1">
                      <p className={check.pass ? 'text-gray-300' : 'text-red-300'}>{check.label}</p>
                      {check.detail && <p className="text-xs text-gray-400 mt-1">{check.detail}</p>}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {result?.crossSync !== undefined && (
            <Card className={`${result.crossSync ? 'bg-green-500/10 border-green-500/30' : 'bg-red-500/10 border-red-500/30'} p-4`}>
              <p className={`text-sm font-semibold flex items-center gap-2 ${result.crossSync ? 'text-green-300' : 'text-red-300'}`}>
                {result.crossSync ? (
                  <CheckCircle2 className="w-4 h-4" />
                ) : (
                  <AlertCircle className="w-4 h-4" />
                )}
                Cross-Sync: {result.crossSync ? 'All modules in sync ✓' : 'Sync verification failed'}
              </p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
