/**
 * GoatMez Key Importer — offline transponder-key adder for MPC-based
 * Charger/Challenger RFHUB 4 KB dumps (8-slot key table @0xC5E).
 *
 * Upload an Autel/Xhorse key programmer screenshot → OCR extracts the Chip ID
 * (which IS the Key ID) → addCharKey writes the correct 6-byte record
 * (UID byte-reversed + derived index + flag) into the highest free slot →
 * download the patched RFHUB. Original file is never modified.
 *
 * Uses the golden-tested addCharKey() from charRfhubKeyTable.js which handles:
 * - UID byte-reversal (Chip ID → storage order)
 * - Index byte derivation (mod-255 checksum)
 * - Highest-free-slot placement (keys pack toward slot 8)
 * - Duplicate detection
 * - Mirror write (primary + mirror copy)
 * - No checksum needed (none covers this region)
 */

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, CheckCircle2, Upload, Download, Zap, Key, Info } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { parseAutelKeyOcr } from '../lib/keyImporter';
import {
  parseCharKeyTable,
  isCharRfhubKeyTable,
  addCharKey,
  deriveCharKeyIndex,
  CHAR_KEY_FLAG_PRESENT,
} from '../lib/charRfhubKeyTable.js';

export default function GoatMezKeyImporterTab({ preloadedRfhub = null }) {
  const [autelImage, setAutelImage] = useState(null);
  const [rfhubFile, setRfhubFile] = useState(null);
  const [rfhubData, setRfhubData] = useState(preloadedRfhub || null);
  const [rfhubFilename, setRfhubFilename] = useState('');
  
  const [extractedKeys, setExtractedKeys] = useState(null);
  const [keyId, setKeyId] = useState('');
  const [manualKeyId, setManualKeyId] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [modifiedRfhub, setModifiedRfhub] = useState(null);
  const [addResult, setAddResult] = useState(null);
  
  const analyzeKeyPhoto = trpc.system.analyzeKeyPhoto.useMutation();
  
  // Parse key table whenever RFHUB data changes
  const keyTable = useMemo(() => {
    if (!rfhubData) return null;
    if (!isCharRfhubKeyTable(rfhubData)) return { ok: false, error: 'Not a recognized Charger RFHUB key table' };
    return parseCharKeyTable(rfhubData);
  }, [rfhubData]);
  
  // Derive index from current keyId
  const derivedIndex = useMemo(() => {
    if (!/^[0-9a-fA-F]{8}$/.test(keyId)) return null;
    return deriveCharKeyIndex(keyId);
  }, [keyId]);
  
  // Initialize with preloaded RFHUB if provided
  useEffect(() => {
    if (preloadedRfhub) {
      setRfhubData(preloadedRfhub);
      if (isCharRfhubKeyTable(preloadedRfhub)) {
        const parsed = parseCharKeyTable(preloadedRfhub);
        const freeCount = parsed.ok ? parsed.slots.filter(s => s.empty).length : 0;
        setStatus(`✓ RFHUB loaded (${8 - freeCount}/8 keys present, ${freeCount} slots free)`);
      } else {
        setError('KEY TABLE NOT FOUND — Charger 8-slot key table not found at 0xC5E (mirror/separator check failed).');
      }
    }
  }, [preloadedRfhub]);
  
  // Handle Autel image upload
  const handleAutelImageUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    
    setStatus('Analyzing key screenshot...');
    setError('');
    setExtractedKeys(null);
    setKeyId('');
    
    try {
      const reader = new FileReader();
      reader.onload = async (evt) => {
        const base64 = evt.target?.result;
        setAutelImage(base64);
        
        // Send to Claude vision for OCR
        const result = await analyzeKeyPhoto.mutateAsync({
          imageBase64: base64,
          prompt: `This is a key programmer screenshot (Autel IM608, Xhorse, or similar) showing a HITAG 2 / PCF7945/53 transponder key readout.

I need the CHIP ID (also called "Key ID" or "UID") — this is the 8-character hex value that uniquely identifies this physical transponder chip.

Look for:
1. "Chip ID" field (usually top-left area) — this is the PRIMARY value I need
2. "Low SK" and "High SK" from the Parameter or Chip info section (secondary)
3. Page data (Page 0-3) if visible

Return ALL values found in this exact format:
Chip ID: XXXXXXXX
Low SK: XXXXXXXX
High SK: XXXXXXXX
Page 0: XXXXXXXX
Page 1: XXXXXXXX
Page 2: XXXXXXXX
Page 3: XXXXXXXX

The Chip ID is the MOST IMPORTANT field — it is the Key ID used to register this transponder in the RFHUB module. Return hex only, no 0x prefix.`,
        });
        
        // Parse the OCR result
        const parsed = parseAutelKeyOcr(result);
        setExtractedKeys(parsed);
        
        if (parsed.chipId && /^[0-9a-fA-F]{8}$/i.test(parsed.chipId)) {
          setKeyId(parsed.chipId.toUpperCase());
          setManualKeyId(parsed.chipId.toUpperCase());
          setStatus(`✓ Key ID extracted: ${parsed.chipId.toUpperCase()}`);
        } else if (parsed.confidence > 0) {
          setStatus('No Chip ID could be read confidently — ' + (parsed.notes || 'Enter it manually below.'));
        } else {
          setError('Could not extract key data from image. Enter the Chip ID manually below.');
          setStatus('');
        }
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
    e.target.value = '';
    
    if (file.size !== 4096) {
      setError(`RFHUB must be exactly 4096 bytes, got ${file.size}`);
      return;
    }
    
    setRfhubFile(file);
    setRfhubFilename(file.name);
    setError('');
    setModifiedRfhub(null);
    setAddResult(null);
    
    const reader = new FileReader();
    reader.onload = (evt) => {
      const data = new Uint8Array(evt.target?.result);
      setRfhubData(data);
      
      if (!isCharRfhubKeyTable(data)) {
        setError('KEY TABLE NOT FOUND — Charger 8-slot key table not found at 0xC5E (mirror/separator check failed). This tool only supports the MPC Charger/Challenger 8-slot table.');
        return;
      }
      
      const parsed = parseCharKeyTable(data);
      if (parsed.ok) {
        const freeCount = parsed.slots.filter(s => s.empty).length;
        setStatus(`✓ RFHUB loaded (${8 - freeCount}/8 keys present, ${freeCount} slots free)`);
      }
    };
    reader.readAsArrayBuffer(file);
  };
  
  // Handle manual Key ID input
  const handleManualKeyIdChange = (e) => {
    const val = e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 8).toUpperCase();
    setManualKeyId(val);
    if (/^[0-9a-fA-F]{8}$/.test(val)) {
      setKeyId(val);
    }
  };
  
  // Add key to RFHUB
  const handleAddKey = useCallback(() => {
    setError('');
    
    if (!rfhubData) {
      setError('Please upload an RFHUB file first.');
      return;
    }
    
    if (!/^[0-9a-fA-F]{8}$/.test(keyId)) {
      setError('Key ID must be exactly 8 hex characters (e.g., 6D0EF991).');
      return;
    }
    
    const result = addCharKey(rfhubData, {
      keyId: keyId,
      flag: CHAR_KEY_FLAG_PRESENT, // 0x01 = HITAG 2
    });
    
    if (!result.ok) {
      setError(result.error);
      return;
    }
    
    setModifiedRfhub(result.bytes);
    setAddResult(result);
    setStatus(`✓ Key ${result.keyId} added to slot ${result.slot} (index 0x${result.indexLow.toString(16).toUpperCase().padStart(2, '0')}) — ${result.keyCountAfter} keys now present`);
  }, [rfhubData, keyId]);
  
  // Download modified RFHUB
  const handleDownload = useCallback(() => {
    if (!modifiedRfhub || !addResult) return;
    
    const baseName = rfhubFilename ? rfhubFilename.replace(/\.[^.]+$/, '') : 'RFHUB';
    const fname = `${baseName}_KEY_${addResult.keyId}_ADDED.bin`;
    
    const blob = new Blob([modifiedRfhub], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [modifiedRfhub, addResult, rfhubFilename]);
  
  const keyIdValid = /^[0-9a-fA-F]{8}$/.test(keyId);
  const freeSlots = keyTable?.ok ? keyTable.slots.filter(s => s.empty).length : 0;
  const canAdd = keyTable?.ok && keyIdValid && freeSlots > 0 && !modifiedRfhub;
  
  return (
    <div className="space-y-6 p-6">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold mb-2">GoatMez Key Importer</h1>
        <p className="text-gray-600 mb-6">
          Extract Chip ID from Autel/Xhorse screenshots and add the transponder key to a Charger/Challenger RFHUB dump.
          Uses the correct 6-byte record format with auto-derived index byte and highest-free-slot placement.
        </p>
        
        {error && (
          <Alert variant="destructive" className="mb-6">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        
        {status && !error && (
          <Alert className="mb-6 border-green-200 bg-green-50">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            <AlertDescription className="text-green-800">{status}</AlertDescription>
          </Alert>
        )}
        
        {/* Info Banner */}
        <Alert className="mb-6 border-blue-200 bg-blue-50">
          <Info className="h-4 w-4 text-blue-600" />
          <AlertDescription className="text-blue-800 text-sm">
            <strong>How it works:</strong> The Chip ID from your Autel/Xhorse readout IS the Key ID.
            It gets byte-reversed for storage, paired with an auto-derived index byte (mod-255 checksum),
            and written to the highest free slot with its mirror copy. No checksum covers this region —
            the original file is never modified, and the write cannot brick the immobilizer.
          </AlertDescription>
        </Alert>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          {/* Step 1: Key Photo Upload */}
          <Card className="p-6">
            <h3 className="text-lg font-semibold mb-1">READ KEY ID FROM PHOTO</h3>
            <p className="text-xs text-gray-500 mb-4">
              Upload a clear photo of the key, the programmer readout (Autel / Xhorse), or the packaging label.
              The Key ID is read off the image and filled in below for you to confirm — nothing is written to a module from the photo.
            </p>
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center cursor-pointer hover:border-blue-500 transition"
                 onClick={() => document.getElementById('goatmez-autel-input')?.click()}>
              {autelImage ? (
                <div>
                  <img src={autelImage} alt="Key readout" className="max-h-40 mx-auto mb-3 rounded" />
                  <p className="text-sm text-gray-600">Click to change image</p>
                </div>
              ) : (
                <div>
                  <Upload className="h-10 w-10 mx-auto mb-3 text-gray-400" />
                  <p className="font-semibold text-sm mb-1">Upload key photo</p>
                  <p className="text-xs text-gray-500">PNG · JPG · WEBP</p>
                </div>
              )}
              <input
                id="goatmez-autel-input"
                type="file"
                accept="image/*"
                onChange={handleAutelImageUpload}
                className="hidden"
              />
            </div>
            
            {/* Extracted data display */}
            {extractedKeys && (
              <div className="mt-4 p-3 bg-blue-50 rounded text-xs font-mono space-y-1">
                {extractedKeys.chipId && <p><span className="font-bold">Chip ID:</span> {extractedKeys.chipId}</p>}
                {extractedKeys.lowSk && <p><span className="font-bold">Low SK:</span> {extractedKeys.lowSk}</p>}
                {extractedKeys.highSk && <p><span className="font-bold">High SK:</span> {extractedKeys.highSk}</p>}
                {extractedKeys.page0 && <p className="text-gray-600">Page 0: {extractedKeys.page0}</p>}
                {extractedKeys.page1 && <p className="text-gray-600">Page 1: {extractedKeys.page1}</p>}
                {extractedKeys.page2 && <p className="text-gray-600">Page 2: {extractedKeys.page2}</p>}
                {extractedKeys.page3 && <p className="text-gray-600">Page 3: {extractedKeys.page3}</p>}
              </div>
            )}
            
            {/* Manual Key ID input */}
            <div className="mt-4">
              <label className="text-xs font-bold uppercase tracking-wide text-gray-600 block mb-1">
                Key ID (Chip ID) — 8 hex chars
              </label>
              <input
                type="text"
                value={manualKeyId}
                onChange={handleManualKeyIdChange}
                placeholder="e.g. 6D0EF991"
                className="w-full px-3 py-2 border rounded font-mono text-sm uppercase tracking-wider"
                maxLength={8}
              />
              {keyIdValid && derivedIndex != null && (
                <p className="text-xs text-green-700 mt-1 font-mono">
                  ✓ Index: 0x{derivedIndex.toString(16).toUpperCase().padStart(2, '0')} (auto-derived) · Flag: 0x01 (HITAG 2)
                </p>
              )}
              {manualKeyId.length > 0 && manualKeyId.length < 8 && (
                <p className="text-xs text-amber-600 mt-1">{8 - manualKeyId.length} more hex chars needed</p>
              )}
            </div>
          </Card>
          
          {/* Step 2: RFHUB Upload */}
          <Card className="p-6">
            <h3 className="text-lg font-semibold mb-1">LOAD RFHUB DUMP</h3>
            <p className="text-xs text-gray-500 mb-4">
              Upload the 4 KB RFHUB EEPROM dump from your bench reader.
              The 8-slot key table at 0x0C5E will be parsed and displayed.
            </p>
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center cursor-pointer hover:border-blue-500 transition"
                 onClick={() => document.getElementById('goatmez-rfhub-input')?.click()}>
              {rfhubFile || preloadedRfhub ? (
                <div>
                  <CheckCircle2 className="h-10 w-10 mx-auto mb-3 text-green-600" />
                  <p className="font-semibold text-sm">{rfhubFilename || 'Preloaded RFHUB'}</p>
                  <p className="text-xs text-gray-600">Click to change file</p>
                </div>
              ) : (
                <div>
                  <Upload className="h-10 w-10 mx-auto mb-3 text-gray-400" />
                  <p className="font-semibold text-sm mb-1">Upload RFHUB (4KB)</p>
                  <p className="text-xs text-gray-500">Must be exactly 4096 bytes</p>
                </div>
              )}
              <input
                id="goatmez-rfhub-input"
                type="file"
                accept=".bin"
                onChange={handleRfhubUpload}
                className="hidden"
              />
            </div>
            
            {/* Key Table State */}
            {keyTable && keyTable.ok && (
              <div className="mt-4 p-3 bg-gray-50 rounded">
                <p className="text-xs font-bold uppercase tracking-wide text-gray-600 mb-2">KEY TABLE STATE</p>
                <div className="grid grid-cols-4 gap-1">
                  {keyTable.slots.map((slot, i) => (
                    <div key={i} className={`text-center p-2 rounded text-xs font-mono ${
                      slot.empty ? 'bg-gray-200 text-gray-500' : 'bg-green-100 text-green-800 font-bold'
                    }`}>
                      <div className="text-[10px] text-gray-400">Slot {slot.slot}</div>
                      {slot.empty ? 'EMPTY' : slot.keyId?.slice(0, 6) + '…'}
                    </div>
                  ))}
                </div>
                <p className="text-xs text-gray-600 mt-2">
                  {freeSlots} free slot{freeSlots !== 1 ? 's' : ''} · Next key → slot {
                    keyTable.slots.filter(s => s.empty).length > 0
                      ? keyTable.slots.reduce((best, s) => s.empty && s.slot > (best?.slot || 0) ? s : best, null)?.slot || '?'
                      : 'FULL'
                  } (highest free)
                </p>
              </div>
            )}
            
            {keyTable && !keyTable.ok && rfhubData && (
              <div className="mt-4 p-3 bg-red-50 rounded border border-red-200">
                <p className="text-xs font-bold text-red-700 uppercase">KEY TABLE NOT FOUND</p>
                <p className="text-xs text-red-600 mt-1">{keyTable.error}</p>
              </div>
            )}
          </Card>
        </div>
        
        {/* Step 3: Add Key */}
        {keyIdValid && keyTable?.ok && !modifiedRfhub && (
          <Card className="p-6 mb-6 border-blue-200 bg-blue-50/50">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-semibold text-blue-900">Ready to Add Key</p>
                <p className="text-sm text-blue-700 font-mono">
                  Key ID: {keyId} → stored as {
                    keyId.match(/.{2}/g)?.reverse().join(' ') || '?'
                  } · Index: 0x{derivedIndex?.toString(16).toUpperCase().padStart(2, '0') || '??'} · Flag: 0x01
                </p>
                <p className="text-xs text-blue-600 mt-1">
                  Will be placed in the highest free slot. Original file is never modified.
                </p>
              </div>
              <Button 
                onClick={handleAddKey} 
                disabled={!canAdd}
                className="bg-blue-600 hover:bg-blue-700 text-white"
              >
                <Key className="h-4 w-4 mr-2" />
                Add Key to RFHUB
              </Button>
            </div>
            {freeSlots === 0 && (
              <p className="text-xs text-red-600 mt-2 font-bold">⚠ Key table is full (8/8 slots occupied). Cannot add.</p>
            )}
          </Card>
        )}
        
        {/* Step 4: Download */}
        {modifiedRfhub && addResult && (
          <Card className="p-6 bg-green-50 border-green-200">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-semibold text-green-900">✓ Key Added Successfully</p>
                <p className="text-sm text-green-700 font-mono">
                  {addResult.keyId} → slot {addResult.slot} at 0x{addResult.offset.toString(16).toUpperCase()} + mirror 0x{addResult.mirrorOffset.toString(16).toUpperCase()}
                </p>
                <p className="text-xs text-green-600 mt-1">
                  {addResult.keyCountAfter} keys now present · Index: 0x{addResult.indexLow.toString(16).toUpperCase().padStart(2, '0')} ({addResult.indexDerived ? 'auto-derived' : 'manual override'})
                </p>
              </div>
              <Button onClick={handleDownload} className="bg-green-600 hover:bg-green-700 text-white">
                <Download className="h-4 w-4 mr-2" />
                Download RFHUB
              </Button>
            </div>
          </Card>
        )}
        
        {/* Key Table Hex View */}
        {keyTable?.ok && rfhubData && (
          <Card className="p-6 mt-6">
            <h3 className="text-sm font-bold uppercase tracking-wide text-red-700 mb-2">KEY TABLE HEX — 0x0C5E…0x0CDD</h3>
            <p className="text-xs text-gray-600 mb-3">
              Read-only view of the 8-slot key table. Each slot is 16 bytes: [4B UID rev][1B idx][1B flag] FF FF [6B mirror] FF FF.
              The tinted bytes are the 128-byte table window; bytes written by an add are highlighted in red.
            </p>
            <div className="font-mono text-xs overflow-x-auto">
              <div className="flex gap-4 mb-1 text-[10px] text-gray-400">
                <span className="inline-flex items-center gap-1"><span className="w-3 h-3 bg-gray-100 border rounded"></span> table region</span>
                {modifiedRfhub && <span className="inline-flex items-center gap-1"><span className="w-3 h-3 bg-red-100 border border-red-200 rounded"></span> changed by add</span>}
              </div>
              {Array.from({ length: 8 }, (_, row) => {
                const off = 0x0C5E + row * 16;
                const displayData = modifiedRfhub || rfhubData;
                return (
                  <div key={row} className="flex items-center gap-2 py-0.5">
                    <span className="text-gray-400 w-12">0x{off.toString(16).toUpperCase().padStart(4, '0')}</span>
                    <span className="flex gap-1">
                      {Array.from({ length: 16 }, (_, col) => {
                        const byteOff = off + col;
                        const byte = displayData[byteOff];
                        const changed = modifiedRfhub && rfhubData[byteOff] !== modifiedRfhub[byteOff];
                        return (
                          <span key={col} className={`px-0.5 rounded ${changed ? 'bg-red-200 text-red-900 font-bold' : 'bg-gray-100'}`}>
                            {byte.toString(16).toUpperCase().padStart(2, '0')}
                          </span>
                        );
                      })}
                    </span>
                  </div>
                );
              })}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
