import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, CheckCircle2, Upload, Zap, ArrowRight } from 'lucide-react';
import { detectRfhubType, getRfhubTypeName } from '../lib/rfhubTypeDetector';
import KeyImporterTab from './KeyImporterTab';
import FreshAutoKeyImporterTab from './FreshAutoKeyImporterTab';

export default function KeyImporterRouter() {
  const [rfhubFile, setRfhubFile] = useState(null);
  const [rfhubData, setRfhubData] = useState(null);
  const [detectedType, setDetectedType] = useState(null);
  const [detection, setDetection] = useState(null);
  const [error, setError] = useState('');
  const [routerMode, setRouterMode] = useState('detect'); // 'detect' | 'mpc' | 'freshAuto'
  
  // Handle RFHUB upload and auto-detect
  const handleRfhubUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    if (file.size !== 4096) {
      setError(`RFHUB must be exactly 4096 bytes, got ${file.size}`);
      setRfhubFile(null);
      setRfhubData(null);
      setDetectedType(null);
      setDetection(null);
      return;
    }
    
    setRfhubFile(file);
    setError('');
    
    const reader = new FileReader();
    reader.onload = (evt) => {
      const data = new Uint8Array(evt.target?.result);
      setRfhubData(data);
      
      // Auto-detect type
      const result = detectRfhubType(data);
      setDetection(result);
      setDetectedType(result.type);
      
      // Auto-route if confidence is high
      if (result.confidence >= 70) {
        setRouterMode(result.type);
      }
    };
    reader.readAsArrayBuffer(file);
  };
  
  // Handle manual type selection
  const handleSelectType = (type) => {
    setRouterMode(type);
  };
  
  // Render detection UI
  if (routerMode === 'detect') {
    return (
      <div className="space-y-6 p-6">
        <div className="max-w-2xl mx-auto">
          <h1 className="text-3xl font-bold mb-2">Key Importer</h1>
          <p className="text-gray-600 mb-6">Upload an RFHUB file to auto-detect its type and import keys from Autel screenshots</p>
          
          {error && (
            <Alert variant="destructive" className="mb-6">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          
          <Card className="p-8">
            <label className="text-lg font-semibold mb-4 block">Step 1: Upload RFHUB File (4KB)</label>
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-12 text-center cursor-pointer hover:border-blue-500 transition"
                 onClick={() => document.getElementById('rfhub-input').click()}>
              {rfhubFile ? (
                <div>
                  <CheckCircle2 className="h-12 w-12 mx-auto mb-4 text-green-600" />
                  <p className="font-semibold">{rfhubFile.name}</p>
                  <p className="text-sm text-gray-600 mt-2">Click to change file</p>
                </div>
              ) : (
                <div>
                  <Upload className="h-12 w-12 mx-auto mb-4 text-gray-400" />
                  <p className="font-semibold mb-2">Click to upload RFHUB (4KB)</p>
                  <p className="text-sm text-gray-500">or drag and drop</p>
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
            
            {detection && (
              <div className="mt-8 p-6 bg-blue-50 rounded-lg border border-blue-200">
                <div className="flex items-start gap-4">
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-blue-900 mb-2">RFHUB Type Detection</p>
                    <p className="text-lg font-bold text-blue-900 mb-1">{getRfhubTypeName(detection.type)}</p>
                    <p className="text-sm text-blue-800 mb-4">{detection.reason}</p>
                    <p className="text-xs text-blue-700">Confidence: {detection.confidence}%</p>
                  </div>
                  <div className="text-3xl">
                    {detection.type === 'freshAuto' ? '🔄' : '🔑'}
                  </div>
                </div>
                
                {detection.confidence >= 70 ? (
                  <div className="mt-6 flex gap-3">
                    <Button 
                      onClick={() => handleSelectType(detection.type)}
                      className="flex-1 bg-blue-600 hover:bg-blue-700"
                    >
                      <Zap className="h-4 w-4 mr-2" />
                      Continue to {getRfhubTypeName(detection.type)} Importer
                    </Button>
                  </div>
                ) : (
                  <div className="mt-6 space-y-3">
                    <p className="text-sm font-semibold text-blue-900">Low confidence. Select manually:</p>
                    <div className="flex gap-3">
                      <Button 
                        onClick={() => handleSelectType('mpc')}
                        variant="outline"
                        className="flex-1"
                      >
                        MPC (Charger/Challenger)
                      </Button>
                      <Button 
                        onClick={() => handleSelectType('freshAuto')}
                        variant="outline"
                        className="flex-1"
                      >
                        FreshAuto (Gen1/Gen2)
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </Card>
        </div>
      </div>
    );
  }
  
  // Route to MPC importer
  if (routerMode === 'mpc') {
    return (
      <div>
        <div className="p-4 bg-blue-50 border-b border-blue-200">
          <div className="max-w-4xl mx-auto flex items-center gap-3">
            <Button 
              variant="ghost" 
              size="sm"
              onClick={() => setRouterMode('detect')}
              className="text-blue-600 hover:text-blue-700"
            >
              ← Back to Detection
            </Button>
            <span className="text-sm text-blue-800">
              <span className="font-semibold">MPC (Charger/Challenger)</span> — 8-slot key table
            </span>
          </div>
        </div>
        <KeyImporterTab preloadedRfhub={rfhubData} />
      </div>
    );
  }
  
  // Route to FreshAuto importer
  if (routerMode === 'freshAuto') {
    return (
      <div>
        <div className="p-4 bg-amber-50 border-b border-amber-200">
          <div className="max-w-4xl mx-auto flex items-center gap-3">
            <Button 
              variant="ghost" 
              size="sm"
              onClick={() => setRouterMode('detect')}
              className="text-amber-600 hover:text-amber-700"
            >
              ← Back to Detection
            </Button>
            <span className="text-sm text-amber-800">
              <span className="font-semibold">FreshAuto (Gen1/Gen2)</span> — ring buffer format
            </span>
          </div>
        </div>
        <FreshAutoKeyImporterTab preloadedRfhub={rfhubData} />
      </div>
    );
  }
}
