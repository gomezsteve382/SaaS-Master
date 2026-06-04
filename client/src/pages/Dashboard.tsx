import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useState, useCallback, useEffect, useMemo } from "react";
import { Upload, Shield, Cpu, HardDrive, CheckCircle, XCircle, AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { getLoginUrl } from "@/const";

type SlotType = "RFHUB" | "BCM" | "PCM";

interface UploadSlotProps {
  slotType: SlotType;
  label: string;
  description: string;
  icon: React.ReactNode;
  sessionId: number | null;
  onUploadComplete: (uploadId: number, parseResult: any) => void;
}

function UploadSlot({ slotType, label, description, icon, sessionId, onUploadComplete }: UploadSlotProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<any>(null);

  const uploadMutation = trpc.uploads.upload.useMutation();

  const handleFile = useCallback(async (file: File) => {
    if (!sessionId) {
      toast.error("No active session. Please wait...");
      return;
    }
    setIsUploading(true);
    try {
      const buffer = await file.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...Array.from(new Uint8Array(buffer))));
      const result = await uploadMutation.mutateAsync({
        sessionId,
        slotType,
        filename: file.name,
        fileBase64: base64,
        purpose: "source",
      });
      setUploadResult(result);
      onUploadComplete(result.uploadId, result.parseResult);
      toast.success(`${label} uploaded successfully`);
    } catch (err: any) {
      toast.error(`Upload failed: ${err.message}`);
    } finally {
      setIsUploading(false);
    }
  }, [sessionId, slotType, label, uploadMutation, onUploadComplete]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => setIsDragging(false), []);

  const handleClick = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".bin,.eprom,.dump";
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) handleFile(file);
    };
    input.click();
  }, [handleFile]);

  return (
    <Card
      className={`cursor-pointer transition-all duration-200 ${
        isDragging ? "border-primary bg-primary/5 scale-[1.02]" : "hover:border-primary/50"
      } ${uploadResult ? "border-green-500/50" : ""}`}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onClick={handleClick}
    >
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          {icon}
          {label}
          {uploadResult && (
            <Badge variant="outline" className="ml-auto text-xs">
              {uploadResult.parseResult?.allChecksumsValid ? (
                <><CheckCircle className="w-3 h-3 mr-1 text-green-500" />Valid</>
              ) : (
                <><AlertTriangle className="w-3 h-3 mr-1 text-yellow-500" />Warnings</>
              )}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isUploading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
            <span className="ml-2 text-sm text-muted-foreground">Parsing...</span>
          </div>
        ) : uploadResult ? (
          <div className="space-y-1 text-xs">
            <p className="text-muted-foreground truncate">{uploadResult.parseResult?.sha256?.substring(0, 16)}...</p>
            {uploadResult.parseResult?.primaryVin && (
              <p className="font-mono font-semibold">{uploadResult.parseResult.primaryVin}</p>
            )}
            {uploadResult.parseResult?.primarySec16 && (
              <p className="font-mono text-muted-foreground truncate">SEC16: {uploadResult.parseResult.primarySec16.substring(0, 16)}...</p>
            )}
            <p className="text-muted-foreground">{uploadResult.parseResult?.fileSize} bytes • {uploadResult.parseResult?.type}</p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
            <Upload className="w-8 h-8 mb-2 opacity-50" />
            <p className="text-xs text-center">{description}</p>
            <p className="text-xs mt-1 opacity-50">Drop .bin or click to browse</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const { user, loading, isAuthenticated } = useAuth();
  const [, navigate] = useLocation();
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [uploadedModules, setUploadedModules] = useState<Record<SlotType, { uploadId: number; parseResult: any } | null>>({
    RFHUB: null,
    BCM: null,
    PCM: null,
  });

  const createSessionMutation = trpc.sessions.create.useMutation();

  // Auto-create session on mount
  useEffect(() => {
    if (isAuthenticated && !sessionId) {
      createSessionMutation.mutateAsync({ title: `Session ${new Date().toLocaleString()}` })
        .then(s => setSessionId(s.id))
        .catch(() => {});
    }
  }, [isAuthenticated]);

  const handleUploadComplete = useCallback((slotType: SlotType) => (uploadId: number, parseResult: any) => {
    setUploadedModules(prev => ({ ...prev, [slotType]: { uploadId, parseResult } }));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <Shield className="w-12 h-12 text-primary" />
        <h2 className="text-xl font-semibold">SRT Lab — Module Programming Tool</h2>
        <p className="text-muted-foreground text-center max-w-md">
          Safe, auditable RFHUB/BCM/PCM binary operations with variant-aware checksums and controlled exports.
        </p>
        <Button onClick={() => window.location.href = getLoginUrl()}>
          Sign In to Continue
        </Button>
      </div>
    );
  }

  const rfhub = uploadedModules.RFHUB;
  const bcm = uploadedModules.BCM;
  const canGenerate = rfhub && bcm && rfhub.parseResult?.primaryVin && bcm.parseResult?.primarySec16;

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Module Upload</h1>
        <p className="text-sm text-muted-foreground">
          Upload binary dumps for inspection, synchronization, and candidate generation.
        </p>
      </div>

      {/* Upload Slots */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <UploadSlot
          slotType="RFHUB"
          label="RFHUB (MC9S12X Gen2)"
          description="4 KB Gen2 EEPROM dump with VIN and SEC16 slots"
          icon={<Cpu className="w-4 h-4 text-blue-500" />}
          sessionId={sessionId}
          onUploadComplete={handleUploadComplete("RFHUB")}
        />
        <UploadSlot
          slotType="BCM"
          label="BCM (MPC5606B)"
          description="64 KB D-Flash dump with VIN and SEC16 mirrors"
          icon={<HardDrive className="w-4 h-4 text-orange-500" />}
          sessionId={sessionId}
          onUploadComplete={handleUploadComplete("BCM")}
        />
        <UploadSlot
          slotType="PCM"
          label="PCM (GPEC2A)"
          description="4/8 KB Continental EXT EEPROM with VIN slots"
          icon={<HardDrive className="w-4 h-4 text-teal-500" />}
          sessionId={sessionId}
          onUploadComplete={handleUploadComplete("PCM")}
        />
      </div>

      {/* Quick Actions */}
      {(rfhub || bcm) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Actions</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {rfhub && (
              <Button size="sm" variant="outline" onClick={() => navigate(`/inspector/${rfhub.uploadId}`)}>
                Inspect RFHUB
              </Button>
            )}
            {bcm && (
              <Button size="sm" variant="outline" onClick={() => navigate(`/inspector/${bcm.uploadId}`)}>
                Inspect BCM
              </Button>
            )}
            {canGenerate && (
              <Button size="sm" onClick={() => navigate("/diff")}>
                Generate Candidate
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Session Info */}
      {sessionId && (
        <div className="text-xs text-muted-foreground">
          Session ID: {sessionId} • Logged in as {user?.name || user?.email || "User"}
        </div>
      )}
    </div>
  );
}
