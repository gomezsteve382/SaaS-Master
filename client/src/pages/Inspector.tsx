import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { CheckCircle, XCircle, AlertTriangle, Loader2, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocation, useParams } from "wouter";

export default function Inspector() {
  const params = useParams<{ uploadId: string }>();
  const uploadId = parseInt(params.uploadId || "0", 10);
  const [, navigate] = useLocation();

  const { data: upload, isLoading } = trpc.uploads.get.useQuery({ id: uploadId });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!upload) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Upload not found.</p>
        <Button variant="ghost" className="mt-4" onClick={() => navigate("/")}>
          <ArrowLeft className="w-4 h-4 mr-2" /> Back to Dashboard
        </Button>
      </div>
    );
  }

  const parseResult = upload.parseResult as any;

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => navigate("/")}>
          <ArrowLeft className="w-4 h-4 mr-1" /> Back
        </Button>
        <div>
          <h1 className="text-xl font-bold tracking-tight">Module Inspector</h1>
          <p className="text-sm text-muted-foreground">{upload.filename}</p>
        </div>
      </div>

      {/* Module Overview */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            Module Overview
            <Badge variant="outline">{upload.detectedType || parseResult?.type}</Badge>
            <Badge variant={upload.checksumsValid ? "default" : "destructive"} className="ml-auto">
              {upload.checksumsValid ? "All Checksums OK" : "Checksum Errors"}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <span className="text-muted-foreground">Filename:</span>
              <span className="ml-2 font-mono">{upload.filename}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Size:</span>
              <span className="ml-2 font-mono">{upload.fileSize} bytes</span>
            </div>
            <div>
              <span className="text-muted-foreground">SHA-256:</span>
              <span className="ml-2 font-mono text-xs">{upload.sha256}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Slot Type:</span>
              <span className="ml-2">{upload.slotType}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* VIN Slots */}
      {parseResult?.vinSlots && parseResult.vinSlots.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">VIN Slots</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {parseResult.vinSlots.map((slot: any, i: number) => (
                <div key={i} className="flex items-center gap-3 p-2 rounded bg-muted/50">
                  <span className="text-xs text-muted-foreground w-16">Slot {i + 1}</span>
                  <span className="font-mono text-sm flex-1">{slot.vin || "—"}</span>
                  <span className="text-xs text-muted-foreground font-mono">0x{slot.offset?.toString(16).toUpperCase().padStart(4, "0")}</span>
                  {slot.checksumOk ? (
                    <CheckCircle className="w-4 h-4 text-green-500" />
                  ) : (
                    <XCircle className="w-4 h-4 text-red-500" />
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* SEC16 Slots */}
      {parseResult?.sec16Slots && parseResult.sec16Slots.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">SEC16 Slots</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {parseResult.sec16Slots.map((slot: any, i: number) => (
                <div key={i} className="flex items-center gap-3 p-2 rounded bg-muted/50">
                  <span className="text-xs text-muted-foreground w-16">Slot {i + 1}</span>
                  <span className="font-mono text-xs flex-1 truncate">{slot.hex || "—"}</span>
                  <span className="text-xs text-muted-foreground font-mono">0x{slot.offset?.toString(16).toUpperCase().padStart(4, "0")}</span>
                  {slot.checksumOk ? (
                    <CheckCircle className="w-4 h-4 text-green-500" />
                  ) : (
                    <XCircle className="w-4 h-4 text-red-500" />
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Magic Constant */}
      {parseResult?.gen2Magic != null && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Gen2 Magic Constant</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="font-mono text-sm">0x{parseResult.gen2Magic.toString(16).toUpperCase().padStart(2, "0")}</span>
            <span className="text-xs text-muted-foreground ml-2">(XOR-magic used for VIN checksum)</span>
          </CardContent>
        </Card>
      )}

      {/* Key Table */}
      {parseResult?.keySlots && parseResult.keySlots.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Key Table Entries</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {parseResult.keySlots.map((entry: any, i: number) => (
                <div key={i} className="flex items-center gap-3 p-2 rounded bg-muted/50 text-xs">
                  <span className="text-muted-foreground w-12">Slot {entry.slotIndex}</span>
                  <span className="font-mono flex-1 truncate">{entry.idBytes || "—"}</span>
                  <Badge variant={entry.occupied ? "default" : "secondary"} className="text-xs">
                    {entry.occupied ? "Occupied" : "Empty"}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Warnings */}
      {parseResult?.warnings && parseResult.warnings.length > 0 && (
        <Card className="border-yellow-500/50">
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-yellow-500" />
              Warnings
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {parseResult.warnings.map((w: string, i: number) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="text-yellow-500">•</span>
                  {w}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
