import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export type FindingType =
  | "algorithms"
  | "seedKeys"
  | "canAddresses"
  | "checksums"
  | "securityBytes"
  | "strings"
  | "yaraMatches"
  | "binwalkEntries";

export interface FindingRow {
  name?: string;
  offset?: number;
  size?: number;
  type?: string;
  keyType?: string;
  address?: string;
  module?: string;
  description?: string;
  algorithm?: string;
  value?: string;
  purpose?: string;
  confidence?: number;
  rule?: string;
  severity?: string;
}

type AnyFinding = FindingRow | string;

const COLUMNS: Record<FindingType, { key: string; label: string; render: (f: FindingRow) => React.ReactNode }[]> = {
  algorithms: [
    { key: "offset", label: "OFFSET", render: (f) => fmtOffset(f.offset) },
    { key: "name", label: "ALGORITHM", render: (f) => f.name ?? "—" },
    { key: "type", label: "TYPE", render: (f) => f.type ?? "—" },
    { key: "confidence", label: "CONFIDENCE", render: (f) => fmtConf(f.confidence) },
  ],
  seedKeys: [
    { key: "offset", label: "OFFSET", render: (f) => fmtOffset(f.offset) },
    { key: "name", label: "CANDIDATE", render: (f) => f.name ?? "—" },
    { key: "keyType", label: "KIND", render: (f) => f.keyType ?? "—" },
    { key: "confidence", label: "CONFIDENCE", render: (f) => fmtConf(f.confidence) },
  ],
  canAddresses: [
    { key: "address", label: "CAN ID", render: (f) => f.address ?? "—" },
    { key: "module", label: "MODULE", render: (f) => f.module ?? "—" },
    { key: "description", label: "DESCRIPTION", render: (f) => f.description ?? "—" },
    { key: "confidence", label: "CONFIDENCE", render: (f) => fmtConf(f.confidence) },
  ],
  checksums: [
    { key: "offset", label: "OFFSET", render: (f) => fmtOffset(f.offset) },
    { key: "name", label: "MARKER", render: (f) => f.name ?? "—" },
    { key: "algorithm", label: "ALGORITHM", render: (f) => f.algorithm ?? "—" },
    { key: "confidence", label: "CONFIDENCE", render: (f) => fmtConf(f.confidence) },
  ],
  securityBytes: [
    { key: "offset", label: "OFFSET", render: (f) => fmtOffset(f.offset) },
    { key: "name", label: "NAME", render: (f) => f.name ?? "—" },
    { key: "value", label: "VALUE", render: (f) => <span className="break-all">{f.value ?? "—"}</span> },
    { key: "purpose", label: "PURPOSE", render: (f) => f.purpose ?? "—" },
  ],
  strings: [
    { key: "value", label: "STRING", render: (f) => <span className="break-all">{f.value ?? "—"}</span> },
  ],
  yaraMatches: [
    { key: "rule", label: "RULE", render: (f) => f.rule ?? "—" },
    { key: "severity", label: "SEVERITY", render: (f) => f.severity ?? "—" },
    { key: "description", label: "DESCRIPTION", render: (f) => <span className="break-all">{f.description ?? "—"}</span> },
    { key: "confidence", label: "CONFIDENCE", render: (f) => fmtConf(f.confidence) },
  ],
  binwalkEntries: [
    { key: "offset", label: "OFFSET", render: (f) => fmtOffset(f.offset) },
    { key: "description", label: "DESCRIPTION", render: (f) => <span className="break-all">{f.description ?? "—"}</span> },
    { key: "confidence", label: "CONFIDENCE", render: (f) => fmtConf(f.confidence) },
  ],
};

function fmtOffset(o?: number) {
  if (typeof o !== "number") return "—";
  return `0x${o.toString(16).padStart(8, "0").toUpperCase()}`;
}
function fmtConf(c?: number) {
  if (typeof c !== "number") return "—";
  return `${Math.round(c * 100)}%`;
}

function normalize(findings: AnyFinding[], type: FindingType): FindingRow[] {
  if (type === "strings") {
    return findings.map((f) => (typeof f === "string" ? { value: f } : f));
  }
  return findings.filter((f): f is FindingRow => typeof f !== "string");
}

export function FindingsTable({ findings, type }: { findings: AnyFinding[]; type: FindingType }) {
  if (!findings || findings.length === 0) return null;
  const rows = normalize(findings, type);
  const cols = COLUMNS[type];

  return (
    <div className="border border-border rounded-md overflow-hidden bg-card">
      <Table>
        <TableHeader className="bg-muted">
          <TableRow>
            {cols.map((c) => (
              <TableHead key={c.key} className="font-mono text-xs">
                {c.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((f, i) => (
            <TableRow key={i} className="hover:bg-muted/50 border-border">
              {cols.map((c) => (
                <TableCell key={c.key} className="font-mono text-xs text-primary">
                  {c.render(f)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
