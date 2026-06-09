import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, CheckCircle2, Upload, Download, Zap } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { parseAutelKeyOcr } from '../lib/keyImporter';
import { parseFreshAutoRingBuffer, injectKeyIntoFreshAutoRingBuffer, listFreshAutoKeys } from '../lib/freshAutoKeyImporter';

export default function FreshAutoKeyImporterTab({ preloadedRfhub = null }) {
  const [autelImage, setAutelImage] = useState(null);
  const [autelImageFile, setAutelImageFile] = useState(null);
  const [rfhubFile, setRfhubFile] = useState(null);
  const [rfhubData, setRfhubData] = useState(preloadedRfhub || null);
  
  const [extractedKeys, setExtractedKeys] = useState(null);
  const [ringBufferState, setRingBufferState] = useState(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [modifiedRfhub, setModifiedRfhub] = useState(null);
  const [injectedSlot, setInjectedSlot] = useState(null);
  
  const analyzeKeyPhoto = trpc.system.analyzeKeyPhoto.useMutation();
  
  // Initialize with preloaded RFHUB if provided
  React.useEffect(() => {
    if (preloadedRfhub && rfhubData === preloadedRfhub) {
      const state = parseFreshAutoRingBuffer(preloadedRfhub);
      setRingBufferState(state);
      const populatedCount = state.slots.filter(s => !s.isEmpty).length;
      setStatus(`✓ FreshAuto RFHUB loaded (${populatedCount}/8 slots populated, write pointer at slot ${state.writePointer >= 0 ? state.writePointer : 'N/A'})`);
    }
  }, [preloadedRfhub]);
  
  // Handle Autel image upload
  const handleAutelImageUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setAutelImageFile(file);
    setStatus('Analyzing Autel key screenshot...');
    setError('');
    
    try {
      const reader = new FileReader();
      reader.onload = async (evt) => {
        const base64 = evt.target?.result;
        setAutelImage(base64);
        
        // Send to Claude vision for OCR
        const result = await analyzeKeyPhoto.mutateAsync({
          imageBase64: base64,
          prompt: `Extract the HITAG 2 key data from this Autel key screenshot. 
          Look for fields labeled "Low SK" and "High SK" in the Parameter section.
          Return ONLY the hex values in this format:
          Low SK: XXXXXXXX
          High SK: XXXXXXXX`,
        });
        
        // Parse the OCR result
        const parsed = parseAutelKeyOcr(result);
        
        if (parsed.confidence === 0) {
          setError('Could not extract key data from image. Please check the screenshot quality.');
          setExtractedKeys(null);
          setStatus('');
          return;
        }
        
        setExtractedKeys(parsed);
        setStatus(`✓ Key extracted (confidence: ${parsed.confidence}%)`);
      };
      reader.readAsDataURL(file);
    } catch (err) {
      setError(`Failed to analyze image: ${err.message}`);
      setStatus('');
    }
  };
  
  // Handle RFHUB file upload
  const handleRfhubUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    if (file.size !== 4096) {
      setError(`RFHUB must be exactly 4096 bytes, got ${file.size}`);
      return;
    }
    
    setRfhubFile(file);
    setError('');
    
    const reader = new FileReader();
    reader.onload = (evt) => {
      const data = new Uint8Array(evt.target?.result);
      setRfhubData(data);
      
      // Parse ring buffer state
      const state = parseFreshAutoRingBuffer(data);
      setRingBufferState(state);
      
      const populatedCount = state.slots.filter(s => !s.isEmpty).length;
      setStatus(`✓ FreshAuto RFHUB loaded (${populatedCount}/8 slots populated, write pointer at slot ${state.writePointer >= 0 ? state.writePointer : 'N/A'})`);
    };
    reader.readAsArrayBuffer(file);
  };
  
  // Inject key into ring buffer
  const handleInjectKey = () => {
    if (!extractedKeys || !rfhubData) {
      setError('Please upload both Autel image and RFHUB file');
      return;
    }
    
    if (!extractedKeys.lowSk || !extractedKeys.highSk) {
      setError('Could not extract valid key data from image');
      return;
    }
    
    // Build 16-byte key (Low SK + High SK)
    const keyHex = extractedKeys.lowSk + extractedKeys.highSk;
    
    const result = injectKeyIntoFreshAutoRingBuffer(rfhubData, keyHex);
    
    if (!result.success) {
      setError(result.error);
      return;
    }
    
    setModifiedRfhub(result.modified);
    setInjectedSlot(result.slotUsed);
    setStatus(`✓ Key injected into slot ${result.slotUsed}`);
    
    // Update ring buffer display
    const updatedState = parseFreshAutoRingBuffer(result.modified);
    setRingBufferState(updatedState);
  };
  
  // Download modified RFHUB
  const handleDownload = () => {
    if (!modifiedRfhub) {
      setError('No modified RFHUB to download');
      return;
    }
    
    const blob = new Blob([modifiedRfhub], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `RFHUB_FRESHUTO_KEY_IMPORTED_${new Date().toISOString().slice(0, 10)}.bin`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  
  return (
    <div className="space-y-6 p-6">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold mb-2">FreshAuto Key Importer</h1>
        <p className="text-gray-600 mb-6">Extract HITAG 2 keys from Autel screenshots and inject into FreshAuto ring buffer RFHUB</p>
        
        {error && (
          <Alert variant="destructive" className="mb-6">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        
        {status && (
          <Alert className="mb-6 border-green-200 bg-green-50">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            <AlertDescription className="text-green-800">{status}</AlertDescription>
          </Alert>
        )}
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          {/* Autel Image Upload */}
          <Card className="p-6">
            <label className="text-lg font-semibold mb-4 block">Step 1: Upload Autel Key Screenshot</label>
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center cursor-pointer hover:border-blue-500 transition"
                 onClick={() => document.getElementById('autel-input').click()}>
              {autelImage ? (
                <div>
                  <img src={autelImage} alt="Autel key" className="max-h-48 mx-auto mb-4 rounded" />
                  <p className="text-sm text-gray-600">Click to change image</p>
                </div>
              ) : (
                <div>
                  <Upload className="h-12 w-12 mx-auto mb-4 text-gray-400" />
                  <p className="font-semibold mb-2">Click to upload Autel screenshot</p>
                  <p className="text-sm text-gray-500">or drag and drop</p>
                </div>
              )}
              <input
                id="autel-input"
                type="file"
                accept="image/*"
                onChange={handleAutelImageUpload}
                className="hidden"
              />
            </div>
            
            {extractedKeys && (
              <div className="mt-4 p-4 bg-blue-50 rounded">
                <p className="text-sm font-semibold mb-2">Extracted Keys:</p>
                <div className="space-y-1 font-mono text-sm">
                  <p><span className="font-semibold">Low SK:</span> {extractedKeys.lowSk}</p>
                  <p><span className="font-semibold">High SK:</span> {extractedKeys.highSk}</p>
                  <p className="text-xs text-gray-600 mt-2">Confidence: {extractedKeys.confidence}%</p>
                </div>
              </div>
            )}
          </Card>
          
          {/* RFHUB Upload */}
          <Card className="p-6">
            <label className="text-lg font-semibold mb-4 block">Step 2: Upload FreshAuto RFHUB (4KB)</label>
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center cursor-pointer hover:border-blue-500 transition"
                 onClick={() => document.getElementById('rfhub-input').click()}>
              {rfhubFile ? (
                <div>
                  <CheckCircle2 className="h-12 w-12 mx-auto mb-4 text-green-600" />
                  <p className="font-semibold">{rfhubFile.name}</p>
                  <p className="text-sm text-gray-600">Click to change file</p>
                </div>
              ) : (
                <div>
                  <Upload className="h-12 w-12 mx-auto mb-4 text-gray-400" />
                  <p className="font-semibold mb-2">Click to upload RFHUB (4KB)</p>
                  <p className="text-sm text-gray-500">Must be exactly 4096 bytes</p>
                </div>
              )}
              <input
                id="rfhub-input"
                type="file"
                accept=".bin"
                onChange={handleRfhubUpload}
                className="hidden"
              />
            </div>
            
            {ringBufferState && (
              <div className="mt-4 p-4 bg-blue-50 rounded">
                <p className="text-sm font-semibold mb-2">Ring Buffer State:</p>
                <div className="text-xs space-y-1">
                  <p>Write Pointer: Slot {ringBufferState.writePointer >= 0 ? ringBufferState.writePointer : 'N/A'}</p>
                  <p>Populated: {ringBufferState.slots.filter(s => !s.isEmpty).length}/8</p>
                  <p className="font-mono">Checksum: {ringBufferState.checksum.toString(16).toUpperCase().padStart(2, '0')}</p>
                </div>
              </div>
            )}
          </Card>
        </div>
        
        {/* Inject Button */}
        {extractedKeys && rfhubData && (
          <Card className="p-6 mb-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-semibold">Step 3: Inject Key into Ring Buffer</p>
                <p className="text-sm text-gray-600">Next slot will be {ringBufferState?.writePointer !== undefined ? ringBufferState.writePointer + 1 : '?'}</p>
              </div>
              <Button onClick={handleInjectKey} className="bg-blue-600 hover:bg-blue-700">
                <Zap className="h-4 w-4 mr-2" />
                Inject Key
              </Button>
            </div>
          </Card>
        )}
        
        {/* Download */}
        {modifiedRfhub && (
          <Card className="p-6 bg-green-50 border-green-200">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-semibold text-green-900">✓ RFHUB Modified Successfully</p>
                <p className="text-sm text-green-700">Key injected into slot {injectedSlot}. Ready to download and program.</p>
              </div>
              <Button onClick={handleDownload} className="bg-green-600 hover:bg-green-700">
                <Download className="h-4 w-4 mr-2" />
                Download RFHUB
              </Button>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
