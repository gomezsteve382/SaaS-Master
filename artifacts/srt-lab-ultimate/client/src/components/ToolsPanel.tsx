import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Wrench,
  Play,
  Loader2,
  Copy,
  Download,
  ChevronDown,
  AlertTriangle,
  CheckCircle,
  History,
  X,
} from "lucide-react";

// ─── Tool definitions (mirrors TOOL_CATALOG on server) ──────────────────────

interface ToolParam {
  name: string;
  label: string;
  type: "number" | "string" | "hex" | "select";
  placeholder?: string;
  defaultValue?: string;
  options?: { value: string; label: string }[];
  required?: boolean;
  help?: string;
}

interface ToolDef {
  name: string;
  description: string;
  category: "data" | "pe" | "search" | "crypto" | "format";
  params: ToolParam[];
}

const TOOLS: ToolDef[] = [
  {
    name: "struct_unpack",
    description: "Unpack structured binary data at an offset with named field definitions",
    category: "data",
    params: [
      { name: "offset", label: "Offset", type: "hex", placeholder: "0x0", defaultValue: "0" },
      { name: "fields", label: "Fields", type: "string", placeholder: "magic:u16le;version:u8;flags:u32le;name:char:16", required: true, help: "Types: u8, u16le, u16be, u32le, u32be, i8, i16le, i32le, bytes:N, char:N, skip:N" },
      { name: "repeat", label: "Repeat", type: "number", placeholder: "1", defaultValue: "1" },
    ],
  },
  {
    name: "hex_diff",
    description: "Side-by-side hex diff of two regions in the same binary",
    category: "data",
    params: [
      { name: "offset_a", label: "Offset A", type: "hex", placeholder: "0x0", required: true },
      { name: "offset_b", label: "Offset B", type: "hex", placeholder: "0x100", required: true },
      { name: "length", label: "Length", type: "number", placeholder: "256", defaultValue: "256" },
    ],
  },
  {
    name: "binary_slice",
    description: "Carve a byte range to a standalone buffer",
    category: "data",
    params: [
      { name: "offset", label: "Offset", type: "hex", placeholder: "0x0", required: true },
      { name: "length", label: "Length", type: "number", placeholder: "4096", required: true },
    ],
  },
  {
    name: "checksum_brute",
    description: "Try 11 checksum algorithms against a target value",
    category: "crypto",
    params: [
      { name: "start", label: "Start", type: "hex", placeholder: "0x0", required: true },
      { name: "end", label: "End", type: "hex", placeholder: "0x1000", required: true },
      { name: "target", label: "Target value", type: "hex", placeholder: "0xA3F1", required: true },
    ],
  },
  {
    name: "crc_verify",
    description: "Compute CRC-16/CRC-32 over a range, optionally compare to stored value",
    category: "crypto",
    params: [
      { name: "start", label: "Start", type: "hex", placeholder: "0x0", required: true },
      { name: "end", label: "End", type: "hex", placeholder: "0x1000", required: true },
      { name: "stored_offset", label: "Stored checksum offset", type: "hex", placeholder: "(optional)" },
    ],
  },
  {
    name: "rva_resolver",
    description: "Translate between VA, RVA, and file offset for PE files",
    category: "pe",
    params: [
      { name: "address", label: "Address", type: "hex", placeholder: "0x401000", required: true },
      { name: "type", label: "Address type", type: "select", defaultValue: "va", options: [
        { value: "va", label: "Virtual Address (VA)" },
        { value: "rva", label: "Relative VA (RVA)" },
        { value: "file_offset", label: "File Offset" },
      ]},
    ],
  },
  {
    name: "pe_exports_deep",
    description: "Deep PE export table: ordinals, forwarded exports, C++ demangling",
    category: "pe",
    params: [
      { name: "filter", label: "Filter", type: "string", placeholder: "Filter by name (optional)" },
    ],
  },
  {
    name: "section_permissions",
    description: "RWX permission flags per section, injection surface flagging",
    category: "pe",
    params: [],
  },
  {
    name: "import_xref",
    description: "Find where imported APIs get called in code",
    category: "pe",
    params: [
      { name: "filter", label: "Filter", type: "string", placeholder: "e.g. Crypt, Virtual, Socket" },
    ],
  },
  {
    name: "string_xref",
    description: "Find a string and all code locations referencing it",
    category: "search",
    params: [
      { name: "search", label: "String", type: "string", placeholder: "Enter string to find", required: true },
      { name: "max_results", label: "Max refs", type: "number", placeholder: "20", defaultValue: "20" },
    ],
  },
  {
    name: "pe_overlay",
    description: "Detect data appended past PE image end",
    category: "pe",
    params: [],
  },
  {
    name: "find_references",
    description: "Find all locations containing a given value as a pointer",
    category: "search",
    params: [
      { name: "value", label: "Value", type: "hex", placeholder: "0x00401000", required: true },
      { name: "size", label: "Size", type: "select", defaultValue: "4", options: [
        { value: "2", label: "16-bit" },
        { value: "4", label: "32-bit" },
      ]},
      { name: "max_results", label: "Max results", type: "number", placeholder: "100", defaultValue: "100" },
    ],
  },
  {
    name: "srec_ihex_parse",
    description: "Parse Motorola S-Record or Intel HEX into raw binary",
    category: "format",
    params: [],
  },
  {
    name: "dll_dependency_tree",
    description: "List all DLL imports with function counts and suspicious API flags",
    category: "pe",
    params: [],
  },
  {
    name: "resource_extractor",
    description: "Extract PE resource table: icons, manifests, version info",
    category: "pe",
    params: [],
  },
  {
    name: "base64_blob_finder",
    description: "Scan for base64/hex-encoded blobs in data sections",
    category: "search",
    params: [
      { name: "min_length", label: "Min blob length", type: "number", placeholder: "32", defaultValue: "32" },
      { name: "max_blobs", label: "Max blobs", type: "number", placeholder: "50", defaultValue: "50" },
    ],
  },
];

const CATEGORIES: { key: string; label: string; icon: string }[] = [
  { key: "pe", label: "PE Analysis", icon: "🔬" },
  { key: "data", label: "Data Inspection", icon: "🔧" },
  { key: "search", label: "Search & XRef", icon: "🔍" },
  { key: "crypto", label: "Checksum & CRC", icon: "🔐" },
  { key: "format", label: "Format Parsing", icon: "📄" },
];

// ─── Result history ─────────────────────────────────────────────────────────

interface ToolRun {
  id: string;
  tool: string;
  args: Record<string, string>;
  result: unknown;
  error?: string;
  timestamp: number;
}

// ─── Component ──────────────────────────────────────────────────────────────

interface ToolsPanelProps {
  analysisId: string;
}

export function ToolsPanel({ analysisId }: ToolsPanelProps) {
  const [selectedTool, setSelectedTool] = useState<string>("");
  const [args, setArgs] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<ToolRun[]>([]);
  const [error, setError] = useState<string | null>(null);

  const tool = TOOLS.find((t) => t.name === selectedTool);

  // Reset args when tool changes
  useEffect(() => {
    if (!tool) return;
    const defaults: Record<string, string> = {};
    for (const p of tool.params) {
      if (p.defaultValue) defaults[p.name] = p.defaultValue;
    }
    setArgs(defaults);
    setError(null);
  }, [selectedTool]);

  const setArg = useCallback((name: string, value: string) => {
    setArgs((prev) => ({ ...prev, [name]: value }));
  }, []);

  const run = useCallback(async () => {
    if (!tool) return;
    setRunning(true);
    setError(null);

    // Build payload — convert hex strings to numbers where needed
    const payload: Record<string, unknown> = {};
    for (const p of tool.params) {
      const val = args[p.name];
      if (!val && !p.required) continue;
      if (!val && p.required) {
        setError(`${p.label} is required`);
        setRunning(false);
        return;
      }
      if (p.type === "hex") {
        payload[p.name] = val;
      } else if (p.type === "number") {
        payload[p.name] = Number(val);
      } else {
        payload[p.name] = val;
      }
    }

    try {
      const base = (import.meta.env.BASE_URL as string).replace(/\/$/, "");
      const resp = await fetch(`${base}/api/analyses/${analysisId}/tools/${tool.name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        const body = await resp.json().catch(() => ({ error: resp.statusText }));
        throw new Error(body.error || `HTTP ${resp.status}`);
      }

      const result = await resp.json();
      const run: ToolRun = {
        id: crypto.randomUUID(),
        tool: tool.name,
        args: { ...args },
        result,
        timestamp: Date.now(),
      };
      setHistory((prev) => [run, ...prev]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setHistory((prev) => [
        {
          id: crypto.randomUUID(),
          tool: tool.name,
          args: { ...args },
          result: null,
          error: msg,
          timestamp: Date.now(),
        },
        ...prev,
      ]);
    } finally {
      setRunning(false);
    }
  }, [tool, args, analysisId]);

  const copyResult = useCallback((run: ToolRun) => {
    const text = typeof run.result === "string" ? run.result : JSON.stringify(run.result, null, 2);
    navigator.clipboard.writeText(text).catch(() => {});
  }, []);

  return (
    <div className="bg-card border border-border rounded-md space-y-0 overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border/40 bg-muted/20">
        <h2 className="font-mono text-sm uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Wrench className="w-4 h-4 text-primary" />
          Interactive Tools
          <Badge variant="secondary" className="ml-auto font-mono text-[10px]">
            {TOOLS.length} tools
          </Badge>
        </h2>
        <p className="text-xs text-muted-foreground mt-1">
          Pure static analysis — no LLM, no network. Runs directly on the binary bytes.
        </p>
      </div>

      {/* Tool selector */}
      <div className="px-6 py-4 border-b border-border/40 space-y-3">
        <Label className="text-xs font-mono text-muted-foreground">Select Tool</Label>
        <Select value={selectedTool} onValueChange={setSelectedTool}>
          <SelectTrigger className="font-mono text-xs">
            <SelectValue placeholder="Choose a tool..." />
          </SelectTrigger>
          <SelectContent>
            {CATEGORIES.map((cat) => {
              const catTools = TOOLS.filter((t) => t.category === cat.key);
              if (catTools.length === 0) return null;
              return (
                <div key={cat.key}>
                  <div className="px-2 py-1.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground bg-muted/30">
                    {cat.icon} {cat.label}
                  </div>
                  {catTools.map((t) => (
                    <SelectItem key={t.name} value={t.name} className="font-mono text-xs">
                      {t.name}
                    </SelectItem>
                  ))}
                </div>
              );
            })}
          </SelectContent>
        </Select>

        {tool && (
          <p className="text-xs text-muted-foreground">{tool.description}</p>
        )}
      </div>

      {/* Tool params */}
      {tool && tool.params.length > 0 && (
        <div className="px-6 py-4 border-b border-border/40 space-y-3">
          {tool.params.map((p) => (
            <div key={p.name} className="space-y-1">
              <Label className="text-xs font-mono text-muted-foreground">
                {p.label}
                {p.required && <span className="text-red-400 ml-0.5">*</span>}
              </Label>
              {p.type === "select" ? (
                <Select value={args[p.name] || p.defaultValue || ""} onValueChange={(v) => setArg(p.name, v)}>
                  <SelectTrigger className="font-mono text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {p.options?.map((o) => (
                      <SelectItem key={o.value} value={o.value} className="font-mono text-xs">
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  className="font-mono text-xs h-8"
                  placeholder={p.placeholder}
                  value={args[p.name] || ""}
                  onChange={(e) => setArg(p.name, e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") run(); }}
                />
              )}
              {p.help && (
                <p className="text-[10px] text-muted-foreground/70">{p.help}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Run button + error */}
      {tool && (
        <div className="px-6 py-3 border-b border-border/40 flex items-center gap-3">
          <Button
            size="sm"
            className="font-mono text-xs gap-1.5"
            onClick={run}
            disabled={running}
          >
            {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
            {running ? "Running..." : "Run"}
          </Button>
          {error && (
            <div className="flex items-center gap-1.5 text-xs text-red-400 font-mono">
              <AlertTriangle className="w-3 h-3" />
              {error}
            </div>
          )}
        </div>
      )}

      {/* Results history */}
      {history.length > 0 && (
        <div className="divide-y divide-border/30">
          <div className="px-6 py-2 bg-muted/10 flex items-center gap-2">
            <History className="w-3 h-3 text-muted-foreground" />
            <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
              Results ({history.length})
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-5 px-1.5 text-[10px] text-muted-foreground"
              onClick={() => setHistory([])}
            >
              <X className="w-3 h-3 mr-0.5" /> Clear
            </Button>
          </div>
          {history.map((run) => (
            <div key={run.id} className="px-6 py-3 space-y-2">
              <div className="flex items-center gap-2">
                {run.error ? (
                  <AlertTriangle className="w-3 h-3 text-red-400 shrink-0" />
                ) : (
                  <CheckCircle className="w-3 h-3 text-green-400 shrink-0" />
                )}
                <Badge variant="outline" className="font-mono text-[10px]">
                  {run.tool}
                </Badge>
                <span className="text-[10px] text-muted-foreground font-mono">
                  {new Date(run.timestamp).toLocaleTimeString()}
                </span>
                {!run.error && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-5 px-1.5 text-[10px]"
                    onClick={() => copyResult(run)}
                    title="Copy result as JSON"
                  >
                    <Copy className="w-3 h-3" />
                  </Button>
                )}
              </div>

              {/* Args summary */}
              {Object.keys(run.args).filter((k) => run.args[k]).length > 0 && (
                <div className="text-[10px] font-mono text-muted-foreground/70 flex flex-wrap gap-x-3">
                  {Object.entries(run.args)
                    .filter(([, v]) => v)
                    .map(([k, v]) => (
                      <span key={k}>
                        {k}=<span className="text-foreground/80">{v}</span>
                      </span>
                    ))}
                </div>
              )}

              {/* Result display */}
              {run.error ? (
                <pre className="text-xs font-mono text-red-400 whitespace-pre-wrap bg-red-500/5 rounded p-2">
                  {run.error}
                </pre>
              ) : (
                <ToolResult result={run.result} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Smart result renderer ──────────────────────────────────────────────────

function ToolResult({ result }: { result: unknown }) {
  if (result == null) return null;

  // If it's a string, render as monospace block
  if (typeof result === "string") {
    return (
      <pre className="text-xs font-mono whitespace-pre-wrap bg-muted/30 rounded p-3 max-h-[400px] overflow-auto border border-border/30">
        {result}
      </pre>
    );
  }

  // If it's an array, render as a table or list
  if (Array.isArray(result)) {
    if (result.length === 0) {
      return <p className="text-xs text-muted-foreground italic">No results.</p>;
    }

    // If items are objects with consistent keys, render as a table
    if (typeof result[0] === "object" && result[0] !== null) {
      const keys = Object.keys(result[0]);
      return (
        <div className="overflow-auto max-h-[400px] border border-border/30 rounded">
          <table className="w-full text-[11px] font-mono">
            <thead className="bg-muted/30 sticky top-0">
              <tr>
                {keys.map((k) => (
                  <th key={k} className="px-2 py-1 text-left text-muted-foreground font-medium whitespace-nowrap">
                    {k}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/20">
              {result.slice(0, 200).map((row: Record<string, unknown>, i: number) => (
                <tr key={i} className="hover:bg-muted/10">
                  {keys.map((k) => (
                    <td key={k} className="px-2 py-1 whitespace-nowrap">
                      {renderCellValue(row[k])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {result.length > 200 && (
            <div className="px-2 py-1 text-[10px] text-muted-foreground bg-muted/20">
              Showing 200 of {result.length} results
            </div>
          )}
        </div>
      );
    }

    // Simple array — render as list
    return (
      <pre className="text-xs font-mono whitespace-pre-wrap bg-muted/30 rounded p-3 max-h-[400px] overflow-auto border border-border/30">
        {result.map((item, i) => `${i}: ${JSON.stringify(item)}`).join("\n")}
      </pre>
    );
  }

  // Object — render as key-value pairs
  if (typeof result === "object") {
    const obj = result as Record<string, unknown>;
    const keys = Object.keys(obj);

    // Check if any value is an array or nested object — use accordion
    const hasNested = keys.some((k) => Array.isArray(obj[k]) || (typeof obj[k] === "object" && obj[k] !== null));

    if (hasNested) {
      return (
        <div className="space-y-2">
          {keys.map((k) => {
            const val = obj[k];
            if (Array.isArray(val) || (typeof val === "object" && val !== null)) {
              return (
                <Accordion key={k} type="single" collapsible>
                  <AccordionItem value={k} className="border border-border/30 rounded">
                    <AccordionTrigger className="px-3 py-1.5 text-xs font-mono hover:no-underline">
                      {k}
                      {Array.isArray(val) && (
                        <Badge variant="secondary" className="ml-2 text-[10px]">{val.length}</Badge>
                      )}
                    </AccordionTrigger>
                    <AccordionContent className="px-3 pb-2">
                      <ToolResult result={val} />
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              );
            }
            return (
              <div key={k} className="flex gap-2 text-xs font-mono">
                <span className="text-muted-foreground shrink-0">{k}:</span>
                <span className="text-foreground">{renderCellValue(val)}</span>
              </div>
            );
          })}
        </div>
      );
    }

    // Flat object — simple key-value
    return (
      <div className="bg-muted/30 rounded p-3 border border-border/30 space-y-1">
        {keys.map((k) => (
          <div key={k} className="flex gap-2 text-xs font-mono">
            <span className="text-muted-foreground shrink-0 min-w-[120px]">{k}:</span>
            <span className="text-foreground break-all">{renderCellValue(obj[k])}</span>
          </div>
        ))}
      </div>
    );
  }

  // Fallback
  return (
    <pre className="text-xs font-mono whitespace-pre-wrap bg-muted/30 rounded p-3 border border-border/30">
      {JSON.stringify(result, null, 2)}
    </pre>
  );
}

function renderCellValue(val: unknown): string {
  if (val == null) return "—";
  if (typeof val === "boolean") return val ? "✓" : "—";
  if (typeof val === "number") return val.toString();
  if (typeof val === "string") return val;
  if (Array.isArray(val)) return `[${val.length} items]`;
  return JSON.stringify(val);
}
