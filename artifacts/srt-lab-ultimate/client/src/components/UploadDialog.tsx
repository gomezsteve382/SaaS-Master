import { useState, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { UploadCloud, File, AlertCircle, CheckCircle2, PackageOpen, Key } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";

interface UploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type UploadState = "idle" | "uploading" | "success" | "error";

export function UploadDialog({ open, onOpenChange }: UploadDialogProps) {
  const [, navigate] = useLocation();
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [extractArchive, setExtractArchive] = useState(true);
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [progress, setProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setFile(null);
    setPassword("");
    setExtractArchive(true);
    setUploadState("idle");
    setProgress(0);
    setErrorMessage(null);
  };

  const handleClose = (v: boolean) => {
    onOpenChange(v);
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const dropped = e.dataTransfer.files[0];
    if (dropped) setFile(dropped);
  }, []);

  const handleUpload = async () => {
    setUploadState("uploading");
    setProgress(20);
    setErrorMessage(null);

    const formData = new FormData();
    formData.append("file", file as File);
    if (password) formData.append("password", password);
    formData.append("extractArchive", String(extractArchive));

    try {
      const r = await fetch("/api/upload", { method: "POST", body: formData });
      setProgress(80);
      if (!r.ok) {
        const d = await r.json() as { error?: string };
        throw new Error(d.error ?? "Upload failed");
      }
      const data = await r.json() as { analysisId?: string; id?: string };
      const id = data.analysisId ?? data.id;
      setProgress(100);
      setUploadState("success");
      if (id) {
        setTimeout(() => {
          onOpenChange(false);
          navigate(`/analysis/${id}`);
          reset();
        }, 1200);
      }
    } catch (err) {
      setUploadState("error");
      setErrorMessage(err instanceof Error ? err.message : "Upload failed");
      setProgress(0);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md border-primary/20 bg-background/95 backdrop-blur">
        <DialogHeader>
          <DialogTitle className="font-mono text-primary uppercase tracking-wider flex items-center gap-2">
            <UploadCloud className="w-4 h-4" /> Upload Binary
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">
            Upload a binary file for analysis. Supports ELF, PE, Mach-O, firmware, archives, and more.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div
            onDrop={handleDrop}
            onDragOver={e => e.preventDefault()}
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-border rounded-md p-6 flex flex-col items-center gap-3 cursor-pointer hover:border-primary/50 transition-colors"
          >
            {file ? (
              <div className="flex items-center gap-2">
                <File className="w-5 h-5 text-primary" />
                <div className="text-center">
                  <p className="font-mono text-sm text-foreground">{file.name}</p>
                  <p className="font-mono text-xs text-muted-foreground">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                </div>
              </div>
            ) : (
              <>
                <UploadCloud className="w-8 h-8 text-muted-foreground" />
                <p className="font-mono text-xs text-muted-foreground text-center">
                  Drop a file here or click to browse
                </p>
              </>
            )}
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={e => setFile(e.target.files?.[0] ?? null)}
            />
          </div>

          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="font-mono text-xs flex items-center gap-2">
                <Key className="w-3 h-3" /> Password (for encrypted archives)
              </Label>
              <Input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Leave blank if not needed"
                className="font-mono text-xs"
              />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="extract"
                checked={extractArchive}
                onCheckedChange={v => setExtractArchive(Boolean(v))}
              />
              <Label htmlFor="extract" className="font-mono text-xs flex items-center gap-2 cursor-pointer">
                <PackageOpen className="w-3 h-3" /> Auto-extract archives (ZIP, TAR, etc.)
              </Label>
            </div>
          </div>

          {uploadState === "uploading" && (
            <div className="space-y-2">
              <Progress value={progress} className="h-1.5" />
              <p className="font-mono text-xs text-muted-foreground text-center">Uploading and analyzing...</p>
            </div>
          )}
          {uploadState === "success" && (
            <div className="flex items-center gap-2 text-green-400 font-mono text-xs bg-green-500/10 border border-green-500/20 rounded px-3 py-2">
              <CheckCircle2 className="w-4 h-4" /> Upload complete! Redirecting...
            </div>
          )}
          {uploadState === "error" && (
            <div className="flex items-start gap-2 text-destructive font-mono text-xs bg-destructive/10 border border-destructive/20 rounded px-3 py-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{errorMessage ?? "Upload failed"}</span>
            </div>
          )}

          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={() => handleClose(false)} className="font-mono text-xs">
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleUpload}
              className="font-mono text-xs"
            >
              {uploadState === "uploading" ? "Uploading..." : "Upload & Analyze"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
