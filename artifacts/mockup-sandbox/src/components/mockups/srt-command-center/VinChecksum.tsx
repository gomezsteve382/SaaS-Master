import React, { useState } from "react";
import { AppShell } from "./_shared/AppShell";
import { 
  Cpu, 
  CheckCircle2, 
  AlertTriangle, 
  ShieldAlert, 
  Fingerprint, 
  Database, 
  ArrowRight,
  RefreshCw,
  Search,
  CheckSquare
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// Mock Data
const MODULES = [
  { id: "bcm", name: "Body Control Module (BCM)", vin: "2C3CDXL94MH500418", crc: "A8F1", status: "ok" },
  { id: "rfhub", name: "Radio Frequency Hub (RFHUB)", vin: "2C3CDXL94MH500418", crc: "3C9B", status: "ok" },
  { id: "pcm", name: "Powertrain Control Module (PCM)", vin: "2C3CDXL94MH500418", crc: "77D2", status: "ok" },
  { id: "ipc", name: "Instrument Panel Cluster (IPC)", vin: "1C4RJFDJ7DC513874", crc: "FF01", status: "mismatch" },
];

export function VinChecksum() {
  const [targetVin, setTargetVin] = useState("2C3CDXL94MH500418");
  const [selectedModules, setSelectedModules] = useState<string[]>(["ipc"]);
  const [isWriting, setIsWriting] = useState(false);

  const toggleModule = (id: string) => {
    setSelectedModules(prev => 
      prev.includes(id) ? prev.filter(m => m !== id) : [...prev, id]
    );
  };

  const selectAll = () => {
    if (selectedModules.length === MODULES.length) {
      setSelectedModules([]);
    } else {
      setSelectedModules(MODULES.map(m => m.id));
    }
  };

  // Basic mock validation
  const isValidLen = targetVin.length === 17;
  const isDodge = targetVin.startsWith("2C3");
  const modelYear = isValidLen ? "2021 (M)" : "Unknown";

  return (
    <AppShell active="vin">
      <div 
        className="h-full flex flex-col overflow-y-auto"
        style={{ 
          backgroundColor: "var(--srt-base)", 
          color: "var(--srt-ink)",
          padding: "24px"
        }}
      >
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-display uppercase tracking-wider" style={{ color: "var(--srt-ink)" }}>
              VIN Integrity & Checksum
            </h1>
            <p className="text-sm font-mono mt-1" style={{ color: "var(--srt-muted)" }}>
              SEC-16 WRITE AUTHORIZATION REQUIRED FOR GPEC2A/RFHUB
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="font-mono bg-white" style={{ borderColor: "var(--srt-line)" }}>
              <ShieldAlert className="w-3 h-3 mr-2" style={{ color: "var(--srt-red)" }} />
              SEC-16: UNLOCKED
            </Badge>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          {/* Left Column: Module State */}
          <div className="xl:col-span-2 flex flex-col gap-6">
            <Card style={{ backgroundColor: "var(--srt-panel)", borderColor: "var(--srt-line)" }} className="shadow-sm rounded-none border">
              <CardHeader className="border-b pb-3 px-4 pt-4" style={{ borderColor: "var(--srt-line)" }}>
                <CardTitle className="font-display text-lg flex items-center gap-2">
                  <Database className="w-5 h-5" style={{ color: "var(--srt-muted)" }} />
                  Module State Map
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="border-b" style={{ borderColor: "var(--srt-line)", backgroundColor: "#f9f9f9" }}>
                      <TableHead className="w-[50px] text-center">
                        <Checkbox 
                          checked={selectedModules.length === MODULES.length}
                          onCheckedChange={selectAll}
                          className="border-gray-300"
                        />
                      </TableHead>
                      <TableHead className="font-mono text-xs text-gray-500 uppercase">Module</TableHead>
                      <TableHead className="font-mono text-xs text-gray-500 uppercase">Stored VIN</TableHead>
                      <TableHead className="font-mono text-xs text-gray-500 uppercase">CRC16</TableHead>
                      <TableHead className="font-mono text-xs text-gray-500 uppercase">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {MODULES.map((mod) => (
                      <TableRow key={mod.id} className="border-b" style={{ borderColor: "var(--srt-line)" }}>
                        <TableCell className="text-center">
                          <Checkbox 
                            checked={selectedModules.includes(mod.id)}
                            onCheckedChange={() => toggleModule(mod.id)}
                            className="border-gray-300"
                          />
                        </TableCell>
                        <TableCell className="font-medium flex items-center gap-2">
                          <Cpu className="w-4 h-4 text-gray-400" />
                          {mod.name}
                        </TableCell>
                        <TableCell>
                          <span 
                            className="font-mono text-sm px-2 py-1 rounded"
                            style={{ 
                              backgroundColor: mod.status === 'mismatch' ? '#fee2e2' : '#f0fdf4',
                              color: mod.status === 'mismatch' ? 'var(--srt-red)' : 'var(--srt-good)',
                              border: `1px solid ${mod.status === 'mismatch' ? '#fca5a5' : '#bbf7d0'}`
                            }}
                          >
                            {mod.vin}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="font-mono text-xs text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded border border-gray-200">
                            0x{mod.crc}
                          </span>
                        </TableCell>
                        <TableCell>
                          {mod.status === 'ok' ? (
                            <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200 rounded-sm font-mono text-xs">
                              <CheckCircle2 className="w-3 h-3 mr-1" /> VALID
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200 rounded-sm font-mono text-xs">
                              <AlertTriangle className="w-3 h-3 mr-1" /> MISMATCH
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {/* Action Bar */}
            <Card style={{ backgroundColor: "var(--srt-panel)", borderColor: "var(--srt-line)" }} className="shadow-sm rounded-none border">
              <CardContent className="p-4 flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm">
                  <ShieldAlert className="w-4 h-4" style={{ color: "var(--srt-warn)" }} />
                  <span className="font-mono text-gray-600">SAFETY LOCK: Cannot write VIN to VIRGIN module state.</span>
                </div>
                <div className="flex items-center gap-3">
                  <Button variant="outline" className="font-display tracking-wide rounded-none border-gray-300">
                    <CheckSquare className="w-4 h-4 mr-2" />
                    VERIFY CHECKSUMS
                  </Button>
                  <Button 
                    className="font-display tracking-wide rounded-none text-white hover:bg-red-800 transition-colors"
                    style={{ backgroundColor: "var(--srt-red)" }}
                    disabled={selectedModules.length === 0 || !isValidLen || isWriting}
                    onClick={() => {
                      setIsWriting(true);
                      setTimeout(() => setIsWriting(false), 2000);
                    }}
                  >
                    {isWriting ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Fingerprint className="w-4 h-4 mr-2" />}
                    WRITE VIN TO SELECTED
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Right Column: Settings & Analysis */}
          <div className="flex flex-col gap-6">
            {/* Target VIN Panel */}
            <Card style={{ backgroundColor: "var(--srt-panel)", borderColor: "var(--srt-line)" }} className="shadow-sm rounded-none border">
              <CardHeader className="border-b pb-3 px-4 pt-4" style={{ borderColor: "var(--srt-line)" }}>
                <CardTitle className="font-display text-lg flex items-center gap-2">
                  <Search className="w-5 h-5" style={{ color: "var(--srt-muted)" }} />
                  Target VIN Definition
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 flex flex-col gap-4">
                <div>
                  <label className="text-xs font-mono text-gray-500 uppercase mb-1 block">New Vehicle Identification Number</label>
                  <Input 
                    value={targetVin}
                    onChange={(e) => setTargetVin(e.target.value.toUpperCase())}
                    className="font-mono text-lg tracking-widest uppercase rounded-none border-gray-300 focus-visible:ring-1 focus-visible:ring-red-600"
                    maxLength={17}
                    placeholder="ENTER 17-CHAR VIN"
                  />
                </div>
                
                <div className="bg-gray-50 border border-gray-200 p-3 flex flex-col gap-2">
                  <div className="flex justify-between items-center text-sm font-mono border-b border-gray-200 pb-2">
                    <span className="text-gray-500">Length</span>
                    <span className={isValidLen ? "text-green-600 font-bold" : "text-red-600 font-bold"}>
                      {targetVin.length} / 17
                    </span>
                  </div>
                  <div className="flex justify-between items-center text-sm font-mono border-b border-gray-200 pb-2">
                    <span className="text-gray-500">WMI Decode</span>
                    <span className="text-gray-900">{isDodge ? "Dodge NA" : "Unknown"}</span>
                  </div>
                  <div className="flex justify-between items-center text-sm font-mono border-b border-gray-200 pb-2">
                    <span className="text-gray-500">Model Year</span>
                    <span className="text-gray-900">{modelYear}</span>
                  </div>
                  <div className="flex justify-between items-center text-sm font-mono pt-1">
                    <span className="text-gray-500">Check Digit</span>
                    <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200 rounded-sm font-mono text-[10px]">
                      PASS
                    </Badge>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Checksum Analysis */}
            <Card style={{ backgroundColor: "var(--srt-panel)", borderColor: "var(--srt-line)" }} className="shadow-sm rounded-none border">
              <CardHeader className="border-b pb-3 px-4 pt-4" style={{ borderColor: "var(--srt-line)" }}>
                <CardTitle className="font-display text-lg flex items-center gap-2">
                  <RefreshCw className="w-5 h-5" style={{ color: "var(--srt-muted)" }} />
                  Checksum Pre-flight
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 flex flex-col gap-4">
                <p className="text-xs font-mono text-gray-500 leading-relaxed">
                  Previews CRC16/CRC32 generation for selected modules based on target VIN offset.
                </p>

                {selectedModules.includes('ipc') && (
                  <div className="border border-red-200 bg-red-50 p-3 relative overflow-hidden">
                    <div className="absolute top-0 right-0 bottom-0 w-1 bg-red-500"></div>
                    <h4 className="font-mono text-xs font-bold text-red-800 mb-2 uppercase">IPC (Mismatched)</h4>
                    
                    <div className="flex items-center justify-between mt-2">
                      <div className="flex flex-col">
                        <span className="text-[10px] text-gray-500 font-mono">CURRENT CRC</span>
                        <span className="font-mono text-sm text-gray-800 line-through">0xFF01</span>
                      </div>
                      <ArrowRight className="w-4 h-4 text-red-400" />
                      <div className="flex flex-col items-end">
                        <span className="text-[10px] text-gray-500 font-mono">TARGET CRC</span>
                        <span className="font-mono text-sm font-bold text-red-700">0x2A4B</span>
                      </div>
                    </div>
                    <div className="mt-3 text-right">
                      <Badge variant="outline" className="bg-white text-gray-600 border-gray-300 rounded-sm font-mono text-[10px]">
                        WILL-RECOMPUTE
                      </Badge>
                    </div>
                  </div>
                )}

                {selectedModules.includes('bcm') && (
                  <div className="border border-gray-200 bg-gray-50 p-3 relative overflow-hidden">
                    <div className="absolute top-0 right-0 bottom-0 w-1 bg-green-500"></div>
                    <h4 className="font-mono text-xs font-bold text-gray-700 mb-2 uppercase">BCM</h4>
                    
                    <div className="flex items-center justify-between mt-2">
                      <div className="flex flex-col">
                        <span className="text-[10px] text-gray-500 font-mono">CURRENT CRC</span>
                        <span className="font-mono text-sm text-gray-800">0xA8F1</span>
                      </div>
                      <ArrowRight className="w-4 h-4 text-gray-400" />
                      <div className="flex flex-col items-end">
                        <span className="text-[10px] text-gray-500 font-mono">TARGET CRC</span>
                        <span className="font-mono text-sm font-bold text-green-700">0xA8F1</span>
                      </div>
                    </div>
                    <div className="mt-3 text-right">
                      <Badge variant="outline" className="bg-white text-gray-600 border-gray-300 rounded-sm font-mono text-[10px]">
                        VERIFIED
                      </Badge>
                    </div>
                  </div>
                )}
                
                {selectedModules.length === 0 && (
                  <div className="text-center py-6 text-sm font-mono text-gray-400">
                    No modules selected for preview.
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
