import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, CheckCircle2, Upload, Download, Zap } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { parseAutelKeyOcr, buildKeySlot, writeKeySlotToRfhub, listRfhubKeySlots } from '../lib/keyImporter';

export default function KeyImporterTab({ preloadedRfhub = null }) {
  const [autelImage, setAutelImage] = useState(null);
  const [autelImageFile, setAutelImageFile] = useState(null);
  const [rfhubFile, setRfhubFile] = useState(null);
  const [rfhubData, setRfhubData] = useState(preloadedRfhub || null);
  
  const [extractedKeys, setExtractedKeys] = useState(null);
  const [selectedSlot, setSelectedSlot] = useState('0');
  const [keySlots, setKeySlots] = useState([]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [modifiedRfhub, setModifiedRfhub] = useState(null);
  
  const analyzeKeyPhoto = trpc.system.analyzeKeyPhoto.useMutation();
  
  // Initialize with preloaded RFHUB if provided
  React.useEffect(() => {
    if (preloadedRfhub && rfhubData === preloadedRfhub) {
      const slots = listRfhubKeySlots(preloadedRfhub);
      setKeySlots(slots);
      setStatus(`✓ RFHUB loaded (${slots.filter(s => !s.isEmpty).length}/8 slots populated)`);
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
      // Read file as base64
      const reader = new FileReader();
      reader.onload = async (evt) => {
        const base64 = evt.target?.result;
        setAutelImage(base64);
        
        // Send to Claude vision for OCR
        const result = await analyzeKeyPhoto.mutateAsync({
          imageBase64: base64,
          prompt: `This is an Autel IM608 HITAG 2 / PCF7945/53 key programmer screenshot.

Extract these fields:
1. From the "Parameter" section (top-right area): "Low SK" and "High SK" hex values
2. From the "Chip info" section (left): "Low SK" and "High SK" hex values  
3. From "Chip data" section (right): Page 0, Page 1, Page 2, Page 3 hex values
4. "Chip ID" hex value (top-left)

Return ALL values found in this exact format:
Chip ID: XXXXXXXX
Low SK: XXXXXXXX
High SK: XXXXXXXX
Page 0: XXXXXXXX
Page 1: XXXXXXXX
Page 2: XXXXXXXX
Page 3: XXXXXXXX

If a field shows multiple values (Parameter vs Chip info), prefer the Parameter section values. Return hex only, no 0x prefix.`,
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
      
      // List current key slots
      const slots = listRfhubKeySlots(data);
      setKeySlots(slots);
      setStatus(`✓ RFHUB loaded (${slots.filter(s => !s.isEmpty).length}/8 slots populated)`);
    };
    reader.readAsArrayBuffer(file);
  };
  
  // Write extracted key to RFHUB
  const handleWriteKey = () => {
    if (!extractedKeys || !rfhubData) {
      setError('Please upload both Autel image and RFHUB file');
      return;
    }
    
    if (!extractedKeys.lowSk || !extractedKeys.highSk) {
      setError('Could not extract valid key data from image');
      return;
    }
    
    const keySlot = buildKeySlot(extractedKeys.lowSk, extractedKeys.highSk);
    if (!keySlot) {
      setError('Failed to build key slot from extracted data');
      return;
    }
    
    const slotNum = parseInt(selectedSlot, 10);
    const result = writeKeySlotToRfhub(rfhubData, slotNum, keySlot);
    
    if (!result.success) {
      setError(result.error);
      return;
    }
    
    setModifiedRfhub(result.modified);
    setStatus(`✓ Key written to slot ${slotNum}`);
    
    // Update slot list
    const updatedSlots = listRfhubKeySlots(result.modified);
    setKeySlots(updatedSlots);
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
    a.download = `RFHUB_KEY_IMPORTED_${new Date().toISOString().slice(0, 10)}.bin`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  
  return (
    <div className="space-y-6 p-6">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold mb-2">Key Importer</h1>
        <p className="text-gray-600 mb-6">Extract HITAG 2 keys from Autel screenshots and write to RFHUB</p>
        
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
            <Label className="text-lg font-semibold mb-4 block">Step 1: Upload Autel Key Screenshot</Label>
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
            <Label className="text-lg font-semibold mb-4 block">Step 2: Upload RFHUB File</Label>
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
            
            {keySlots.length > 0 && (
              <div className="mt-4 p-4 bg-blue-50 rounded">
                <p className="text-sm font-semibold mb-2">Current Key Slots:</p>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  {keySlots.map(slot => (
                    <div key={slot.slot} className={`p-2 rounded ${slot.isEmpty ? 'bg-gray-100 text-gray-500' : 'bg-green-100 text-green-700 font-semibold'}`}>
                      Slot {slot.slot}: {slot.isEmpty ? 'empty' : 'programmed'}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>
        </div>
        
        {/* Slot Selection & Write */}
        {extractedKeys && rfhubData && (
          <Card className="p-6 mb-6">
            <Label className="text-lg font-semibold mb-4 block">Step 3: Select Target Slot & Write</Label>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
              <div>
                <Label htmlFor="slot-select" className="block text-sm font-medium mb-2">Target Slot</Label>
                <Select value={selectedSlot} onValueChange={setSelectedSlot}>
                  <SelectTrigger id="slot-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[0, 1, 2, 3, 4, 5, 6, 7].map(i => (
                      <SelectItem key={i} value={String(i)}>
                        Slot {i} {keySlots[i]?.isEmpty ? '(empty)' : '(programmed)'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button onClick={handleWriteKey} className="bg-blue-600 hover:bg-blue-700">
                <Zap className="h-4 w-4 mr-2" />
                Write Key
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
                <p className="text-sm text-green-700">Key written to slot {selectedSlot}. Ready to download and program.</p>
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
