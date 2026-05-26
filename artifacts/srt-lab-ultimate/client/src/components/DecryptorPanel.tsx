import { useState, useRef, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
// Helper to build download URL for extracted files
function getDownloadExtractedFileUrl(analysisId: string, params: { path: string }): string {
  return `/api/analyses/${analysisId}/extracted-files/download?path=${encodeURIComponent(params.path)}`;
}
import {
  Lock,
  Play,
  Upload,
  Download,
  History,
  AlertTriangle,
  CheckCircle,
  Loader2,
  X,
  ChevronDown,
  RotateCcw,
} from "lucide-react";

type Scheme = "xor" | "aes-cbc" | "aes-ecb" | "aes-ctr" | "rc4" | "script";

interface HexRow {
  offset: number;
  hex: string;
  ascii: string;
}

interface RunResult {
  id: string;
  status: "success" | "failed";
  errorMessage: string | null;
  scheme: Scheme;
  offsetStart: number;
  offsetEnd: number;
  resultSize: number;
  resultStorageKey: string | null;
  detectedStrings: string[];
  hexRows: HexRow[];
  truncated: boolean;
  createdAt: string;
}

interface HistoryEntry {
  id: string;
  analysisId: string;
  scheme: string;
  keyFingerprint: string | null;
  ivHex: string | null;
  offsetStart: number;
  offsetEnd: number;
  scriptName: string | null;
  status: "success" | "failed";
  errorMessage: string | null;
  resultStorageKey: string | null;
  resultSize: number | null;
  detectedStrings: string[] | null;
  createdAt: string;
}

export interface DecryptorPrefill {
  offsetStart: number;
  offsetEnd: number;
  scheme?: Scheme;
  ivHex?: string;
  /** Increment to force re-apply even when offsets haven't changed. */
  seq?: number;
}

interface Props {
  analysisId: string;
  fileSize: number;
  /** When set, prefills the form fields and clears any previous result. */
  prefill?: DecryptorPrefill;
}

const SCHEME_LABELS: Record<Scheme, string> = {
  "xor":     "XOR with key",
  "aes-cbc": "AES-CBC",
  "aes-ecb": "AES-ECB",
  "aes-ctr": "AES-CTR",
  "rc4":     "RC4",
  "script":  "Custom Python script",
};

function fmtOffset(n: number) {
  return `0x${n.toString(16).toUpperCase().padStart(8, "0")}`;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function DecryptorPanel({ analysisId, fileSize, prefill }: Props) {
  const [scheme, setScheme] = useState<Scheme>("xor");
  const [keyHex, setKeyHex] = useState("");
  const [ivHex, setIvHex] = useState("");
  const [offsetStart, setOffsetStart] = useState("");
  const [offsetEnd, setOffsetEnd] = useState("");
  const [scriptFile, setScriptFile] = useState<File | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Sync form when parent prefills from a region or crypto panel.
  // `seq` (or changing offsets) is used as the trigger so clicking the same
  // region twice still re-applies the values.
  useEffect(() => {
    if (!prefill) return;
    setOffsetStart(String(prefill.offsetStart));
    setOffsetEnd(String(prefill.offsetEnd));
    if (prefill.scheme) setScheme(prefill.scheme);
    setIvHex(prefill.ivHex ?? "");
    setKeyHex("");
    setResult(null);
    setValidationError(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.seq, prefill?.offsetStart, prefill?.offsetEnd, prefill?.scheme]);

  // Re-populate form from a history entry. Key is intentionally not restored
  // (only fingerprint is stored); user must re-enter it.
  const handleRerun = useCallback((h: HistoryEntry) => {
    setScheme(h.scheme as Scheme);
    setOffsetStart(String(h.offsetStart));
    setOffsetEnd(String(h.offsetEnd));
    setIvHex(h.ivHex ?? "");
    setKeyHex("");
    setScriptFile(null);
    setResult(null);
    setValidationError(null);
  }, []);

  const needsKey = scheme !== "script";
  const needsIv = scheme === "aes-cbc" || scheme === "aes-ctr";

  function parseOffsetInput(val: string): number | null {
    const trimmed = val.trim();
    if (/^0x[0-9a-f]+$/i.test(trimmed)) return parseInt(trimmed, 16);
    if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
    return null;
  }

  function validate(): string | null {
    const start = parseOffsetInput(offsetStart);
    const end = parseOffsetInput(offsetEnd);
    if (start === null || start < 0) return "Start offset must be a valid number or hex (e.g. 0x1000)";
    if (end === null || end <= start) return "End offset must be greater than start offset";
    if (end > fileSize) return `End offset ${end} exceeds file size ${fileSize}`;
    if (needsKey && !keyHex.trim()) return "Key (hex) is required";
    if (needsKey && !/^[0-9a-f]+$/i.test(keyHex.replace(/\s/g, ""))) return "Key must be a valid hex string";
    if (needsIv && ivHex.trim() && !/^[0-9a-f]+$/i.test(ivHex.replace(/\s/g, ""))) return "IV must be a valid hex string";
    if (scheme === "script" && !scriptFile) return "Please upload a Python script";
    return null;
  }

  const runDecryptor = useCallback(async () => {
    const err = validate();
    if (err) { setValidationError(err); return; }
    setValidationError(null);
    setIsRunning(true);
    setResult(null);

    const start = parseOffsetInput(offsetStart)!;
    const end = parseOffsetInput(offsetEnd)!;

    const formData = new FormData();
    formData.append("scheme", scheme);
    formData.append("offsetStart", String(start));
    formData.append("offsetEnd", String(end));
    if (needsKey) formData.append("keyHex", keyHex.replace(/\s/g, ""));
    if (needsIv && ivHex.trim()) formData.append("ivHex", ivHex.replace(/\s/g, ""));
    if (scheme === "script" && scriptFile) formData.append("script", scriptFile);

    try {
      const resp = await fetch(`/api/analyses/${analysisId}/decrypt`, {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      const data = await resp.json() as RunResult & { error?: string };
      if (!resp.ok && !data.status) {
        setValidationError(data.error ?? "Request failed");
        return;
      }
      setResult(data);
      setHistory(null);
    } catch (e: unknown) {
      setValidationError(e instanceof Error ? e.message : "Network error");
    } finally {
      setIsRunning(false);
    }
  }, [analysisId, scheme, keyHex, ivHex, offsetStart, offsetEnd, scriptFile, needsKey, needsIv, fileSize]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const resp = await fetch(`/api/analyses/${analysisId}/decrypt`, { credentials: "include" });
      const data = await resp.json() as HistoryEntry[];
      setHistory(data);
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [analysisId]);

  return (
    <div className="border border-violet-500/30 bg-violet-500/5 rounded-md overflow-hidden">
      <div className="flex items-center gap-2 px-6 py-4 border-b border-violet-500/20">
        <Lock className="w-4 h-4 text-violet-400" />
        <h2 className="font-mono text-violet-400 font-bold text-sm uppercase tracking-wider flex-1">
          Run Decryptor
        </h2>
      </div>

      <div className="p-6 space-y-5">
        {/* Region Selector */}
        <div>
          <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground mb-3">
            Region Selection
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="font-mono text-xs text-muted-foreground">Start Offset</Label>
              <Input
                value={offsetStart}
                onChange={(e) => setOffsetStart(e.target.value)}
                placeholder="0x0000 or decimal"
                className="font-mono text-xs bg-background border-border"
                data-testid="input-decrypt-offset-start"
              />
            </div>
            <div className="space-y-1">
              <Label className="font-mono text-xs text-muted-foreground">End Offset</Label>
              <Input
                value={offsetEnd}
                onChange={(e) => setOffsetEnd(e.target.value)}
                placeholder={`0x${fileSize.toString(16).toUpperCase()} or decimal`}
                className="font-mono text-xs bg-background border-border"
                data-testid="input-decrypt-offset-end"
              />
            </div>
          </div>
          <p className="mt-1.5 font-mono text-[10px] text-muted-foreground/60">
            File size: {fmtSize(fileSize)} ({fmtOffset(fileSize)}). Accept hex (0x…) or decimal.
          </p>
        </div>

        {/* Scheme Selector */}
        <div className="space-y-1">
          <Label className="font-mono text-xs text-muted-foreground">Cipher / Method</Label>
          <Select value={scheme} onValueChange={(v) => setScheme(v as Scheme)}>
            <SelectTrigger className="font-mono text-xs bg-background border-border" data-testid="select-decrypt-scheme">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="font-mono text-xs">
              {(Object.entries(SCHEME_LABELS) as [Scheme, string][]).map(([k, v]) => (
                <SelectItem key={k} value={k}>{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Key / IV inputs */}
        {needsKey && (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="font-mono text-xs text-muted-foreground">
                Key (hex){scheme === "xor" ? " — any length, cycles" : scheme === "rc4" ? " — 1-256 bytes" : " — 16, 24, or 32 bytes"}
              </Label>
              <Input
                value={keyHex}
                onChange={(e) => setKeyHex(e.target.value)}
                placeholder={scheme === "xor" ? "e.g. deadbeef" : scheme === "rc4" ? "e.g. 0102030405060708" : "e.g. 000102030405060708090a0b0c0d0e0f"}
                className="font-mono text-xs bg-background border-border"
                data-testid="input-decrypt-key"
              />
            </div>
            {needsIv && (
              <div className="space-y-1">
                <Label className="font-mono text-xs text-muted-foreground">IV (hex, optional — defaults to all-zeros)</Label>
                <Input
                  value={ivHex}
                  onChange={(e) => setIvHex(e.target.value)}
                  placeholder="e.g. 00000000000000000000000000000000"
                  className="font-mono text-xs bg-background border-border"
                  data-testid="input-decrypt-iv"
                />
              </div>
            )}
          </div>
        )}

        {/* Script Upload */}
        {scheme === "script" && (
          <div className="space-y-2">
            <Label className="font-mono text-xs text-muted-foreground">Python Script</Label>
            <p className="font-mono text-[10px] text-muted-foreground/70 leading-relaxed">
              Upload a <code className="text-violet-300">.py</code> file that exposes{" "}
              <code className="text-violet-300">def decrypt(data: bytes) → bytes</code>. Runs in a restricted sandbox with no network or filesystem access. CPU/memory limits apply.
            </p>
            <div
              className="border border-dashed border-violet-500/40 rounded-md p-4 flex flex-col items-center gap-2 cursor-pointer hover:border-violet-500/70 transition-colors"
              onClick={() => fileInputRef.current?.click()}
              data-testid="drop-zone-script"
            >
              <Upload className="w-5 h-5 text-violet-400/60" />
              {scriptFile ? (
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-violet-300">{scriptFile.name}</span>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setScriptFile(null); }}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <span className="font-mono text-xs text-muted-foreground">Click to select .py file</span>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".py,text/x-python,text/plain"
                className="hidden"
                onChange={(e) => setScriptFile(e.target.files?.[0] ?? null)}
                data-testid="input-script-file"
              />
            </div>
          </div>
        )}

        {/* Validation error */}
        {validationError && (
          <div className="flex items-start gap-2 text-xs font-mono text-destructive bg-destructive/10 border border-destructive/20 rounded px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            {validationError}
          </div>
        )}

        {/* Run button */}
        <Button
          onClick={runDecryptor}
          disabled={isRunning}
          className="font-mono text-xs bg-violet-600 hover:bg-violet-700 text-white border-0 w-full"
          data-testid="button-run-decryptor"
        >
          {isRunning ? (
            <><Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />Running...</>
          ) : (
            <><Play className="w-3.5 h-3.5 mr-2" />Run Decryptor</>
          )}
        </Button>

        {/* Result */}
        {result && (
          <div className="space-y-3 border border-border rounded-md overflow-hidden" data-testid="decryptor-result">
            {/* Status bar */}
            <div className={`flex items-center gap-2 px-4 py-2 font-mono text-xs ${result.status === "success" ? "bg-green-500/10 border-b border-green-500/20" : "bg-destructive/10 border-b border-destructive/20"}`}>
              {result.status === "success" ? (
                <><CheckCircle className="w-3.5 h-3.5 text-green-400" /><span className="text-green-400 font-bold">SUCCESS</span></>
              ) : (
                <><AlertTriangle className="w-3.5 h-3.5 text-destructive" /><span className="text-destructive font-bold">FAILED</span></>
              )}
              <span className="text-muted-foreground ml-2">
                {fmtOffset(result.offsetStart)} – {fmtOffset(result.offsetEnd)}
                {result.status === "success" && ` · ${fmtSize(result.resultSize)} output`}
              </span>
              {result.resultStorageKey && (
                <a
                  href={getDownloadExtractedFileUrl(analysisId, { path: result.resultStorageKey })}
                  className="ml-auto flex items-center gap-1 text-violet-400 hover:text-violet-300 shrink-0"
                  title="Download decrypted output"
                  data-testid="link-download-decrypted"
                >
                  <Download className="w-3.5 h-3.5" />
                  Save as artifact
                </a>
              )}
            </div>

            {result.status === "failed" && result.errorMessage && (
              <div className="px-4 pb-3 font-mono text-xs text-destructive/80">{result.errorMessage}</div>
            )}

            {result.status === "success" && (
              <>
                {/* Detected strings */}
                {result.detectedStrings.length > 0 && (
                  <div className="px-4 pb-2">
                    <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
                      Detected Strings ({result.detectedStrings.length})
                    </p>
                    <div className="max-h-28 overflow-y-auto space-y-0.5 custom-scrollbar">
                      {result.detectedStrings.map((s, i) => (
                        <div key={i} className="font-mono text-[11px] text-foreground bg-muted/20 px-2 py-0.5 rounded truncate" title={s}>
                          {s}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Hex view */}
                {result.hexRows.length > 0 && (
                  <div className="border-t border-border">
                    <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground px-4 py-2">
                      Hex Output {result.truncated ? `(first 4 KB of ${fmtSize(result.resultSize)})` : ""}
                    </p>
                    <div className="max-h-64 overflow-y-auto custom-scrollbar px-4 pb-3">
                      <table className="w-full text-[10px] font-mono border-collapse">
                        <tbody>
                          {result.hexRows.map((row, i) => (
                            <tr key={i} className="hover:bg-muted/30">
                              <td className="pr-4 py-0.5 text-muted-foreground select-none whitespace-nowrap">
                                {fmtOffset(row.offset)}
                              </td>
                              <td className="pr-6 py-0.5 text-primary whitespace-pre">{row.hex}</td>
                              <td className="py-0.5 text-foreground/60 whitespace-pre">{row.ascii}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Run History */}
        <Accordion type="single" collapsible>
          <AccordionItem value="history" className="border-0">
            <AccordionTrigger
              className="py-2 font-mono text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground hover:no-underline"
              onClick={() => { if (!history && !historyLoading) loadHistory(); }}
              data-testid="accordion-decrypt-history"
            >
              <span className="flex items-center gap-2">
                <History className="w-3.5 h-3.5" />
                Run History
                <ChevronDown className="w-3.5 h-3.5 ml-auto transition-transform duration-200" />
              </span>
            </AccordionTrigger>
            <AccordionContent>
              {historyLoading ? (
                <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground py-3">
                  <Loader2 className="w-3 h-3 animate-spin" />Loading history...
                </div>
              ) : !history || history.length === 0 ? (
                <p className="text-xs font-mono text-muted-foreground py-2">No decryptor runs yet.</p>
              ) : (
                <div className="space-y-1 max-h-64 overflow-y-auto custom-scrollbar">
                  {history.map((h) => (
                    <div
                      key={h.id}
                      className="border border-border/50 rounded px-3 py-2 font-mono text-[10px] space-y-1 hover:bg-muted/20"
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge
                          variant="outline"
                          className={`text-[9px] px-1.5 py-0 border ${h.status === "success" ? "border-green-500/40 text-green-400" : "border-destructive/40 text-destructive"}`}
                        >
                          {h.status}
                        </Badge>
                        <span className="text-foreground font-bold">{SCHEME_LABELS[h.scheme as Scheme] ?? h.scheme}</span>
                        {h.keyFingerprint && (
                          <span className="text-muted-foreground">key:{h.keyFingerprint.slice(0, 8)}…</span>
                        )}
                        {h.scriptName && (
                          <span className="text-violet-300">{h.scriptName}</span>
                        )}
                        <span className="text-muted-foreground/60">{new Date(h.createdAt).toLocaleString()}</span>
                        <button
                          type="button"
                          title="Re-run: populates form with these settings (re-enter key)"
                          onClick={() => handleRerun(h)}
                          className="ml-auto flex items-center gap-1 text-violet-400 hover:text-violet-300 shrink-0"
                          data-testid={`btn-rerun-${h.id}`}
                        >
                          <RotateCcw className="w-3 h-3" />
                          Re-run
                        </button>
                      </div>
                      <div className="text-muted-foreground">
                        Region: {fmtOffset(h.offsetStart)} – {fmtOffset(h.offsetEnd)}
                        {h.resultSize != null && h.status === "success" && (
                          <> · output {fmtSize(h.resultSize)}</>
                        )}
                      </div>
                      {h.status === "failed" && h.errorMessage && (
                        <div className="text-destructive/80">{h.errorMessage}</div>
                      )}
                      {h.detectedStrings && h.detectedStrings.length > 0 && (
                        <div className="text-foreground/60 truncate">
                          Strings: {h.detectedStrings.slice(0, 3).join(", ")}{h.detectedStrings.length > 3 ? `… +${h.detectedStrings.length - 3}` : ""}
                        </div>
                      )}
                      {h.resultStorageKey && h.status === "success" && (
                        <a
                          href={getDownloadExtractedFileUrl(analysisId, { path: h.resultStorageKey })}
                          className="flex items-center gap-1 text-violet-400 hover:text-violet-300 w-fit"
                        >
                          <Download className="w-3 h-3" />
                          Download artifact
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </div>
  );
}
