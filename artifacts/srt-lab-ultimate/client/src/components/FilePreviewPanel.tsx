import { useState, useEffect } from "react";
import { X, Download, AlertTriangle, Loader2, Maximize2 } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import type { FilePreview } from "@/lib/workbench-types";

function getDownloadExtractedFileUrl(analysisId: string, params: { path: string }): string {
  return `/api/analyses/${analysisId}/extracted-files/download?path=${encodeURIComponent(params.path)}`;
}

interface FilePreviewPanelProps {
  analysisId: string;
  filePath: string;
  fileSize: number;
  onClose: () => void;
}

export function FilePreviewPanel({ analysisId, filePath, fileSize, onClose }: FilePreviewPanelProps) {
  const [data, setData] = useState<FilePreview | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    setIsLoading(true);
    setIsError(false);
    setData(null);
    fetch(`/api/analyses/${analysisId}/extracted-files/peek?path=${encodeURIComponent(filePath)}&limit=4096`)
      .then((r) => {
        if (!r.ok) throw new Error("Failed");
        return r.json() as Promise<FilePreview>;
      })
      .then((d) => { setData(d); setIsLoading(false); })
      .catch(() => { setIsError(true); setIsLoading(false); });
  }, [analysisId, filePath]);

  const filename = filePath.split("/").pop() ?? filePath;

  return (
    <div className="mt-2 border border-primary/30 rounded-md bg-black/40 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/50 bg-muted/20">
        <span className="font-mono text-xs text-primary truncate max-w-[60%]" title={filePath}>
          {filename}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          {data?.truncated && (
            <span className="font-mono text-[10px] text-yellow-500/80 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />
              preview capped at 4 KB
            </span>
          )}
          <Link
            href={`/hex/${analysisId}?path=${encodeURIComponent(filePath)}`}
            className="inline-flex items-center gap-1 font-mono text-[10px] text-primary hover:underline"
          >
            <Maximize2 className="w-3 h-3" />
            Open full view
          </Link>
          <a
            href={getDownloadExtractedFileUrl(analysisId, { path: filePath })}
            className="inline-flex items-center gap-1 font-mono text-[10px] text-primary hover:underline"
          >
            <Download className="w-3 h-3" />
            Download
          </a>
          <Button
            variant="ghost"
            size="icon"
            className="w-5 h-5 text-muted-foreground hover:text-foreground"
            onClick={onClose}
          >
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>
      <div className="max-h-72 overflow-auto custom-scrollbar">
        {isLoading && (
          <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground font-mono text-xs">
            <Loader2 className="w-4 h-4 animate-spin" />
            loading preview…
          </div>
        )}
        {isError && (
          <div className="flex items-center justify-center gap-2 py-6 text-destructive font-mono text-xs">
            <AlertTriangle className="w-4 h-4" />
            failed to load preview
          </div>
        )}
        {data && data.isPrintable && data.text != null ? (
          <pre className="p-3 font-mono text-[11px] text-foreground whitespace-pre-wrap break-all leading-relaxed">
            {data.text}
          </pre>
        ) : data && !data.isPrintable ? (
          <HexDump rows={data.hex} fileSize={fileSize} />
        ) : null}
      </div>
    </div>
  );
}

interface HexRow {
  offset: number;
  hex: string;
  ascii: string;
}

function HexDump({ rows, fileSize }: { rows: HexRow[]; fileSize: number }) {
  if (rows.length === 0) {
    return (
      <p className="p-3 font-mono text-xs text-muted-foreground italic">
        empty file
      </p>
    );
  }
  const offsetWidth = fileSize.toString(16).length;
  return (
    <table className="w-full font-mono text-[11px] leading-5 border-collapse">
      <thead>
        <tr className="text-muted-foreground border-b border-border/30">
          <th className="text-left px-3 py-1 font-normal select-none">offset</th>
          <th className="text-left px-3 py-1 font-normal select-none">hex</th>
          <th className="text-left px-3 py-1 font-normal select-none">ascii</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.offset} className="hover:bg-primary/5 transition-colors">
            <td className="px-3 py-0.5 text-muted-foreground select-none whitespace-nowrap">
              {row.offset.toString(16).padStart(Math.max(offsetWidth, 6), "0")}
            </td>
            <td className="px-3 py-0.5 text-primary whitespace-nowrap tracking-wider">
              {row.hex}
            </td>
            <td className="px-3 py-0.5 text-foreground/70 whitespace-pre">
              {row.ascii}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
