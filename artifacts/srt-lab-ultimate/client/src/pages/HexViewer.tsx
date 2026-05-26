import React, { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Search, ChevronLeft, ChevronRight, Binary } from "lucide-react";

const BYTES_PER_ROW = 16;
const ROWS_PER_PAGE = 32; // 512 bytes per page
const PAGE_SIZE = BYTES_PER_ROW * ROWS_PER_PAGE;

interface HexPage {
  offset: number;
  length: number;
  totalSize: number;
  hex: string;
  ascii: string;
}

export default function HexViewer() {
  const params = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const [page, setPage] = useState<HexPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentOffset, setCurrentOffset] = useState(0);
  const [jumpInput, setJumpInput] = useState("");
  const [highlightOffset, setHighlightOffset] = useState<number | null>(null);
  const [filename, setFilename] = useState<string>("");
  const containerRef = useRef<HTMLDivElement>(null);

  // Read jumpTo from URL hash on mount
  useEffect(() => {
    const hash = window.location.hash;
    if (hash.startsWith("#offset=")) {
      const offset = parseInt(hash.slice(8), 16);
      if (!isNaN(offset)) {
        const pageOffset = Math.floor(offset / PAGE_SIZE) * PAGE_SIZE;
        setCurrentOffset(pageOffset);
        setHighlightOffset(offset);
        setJumpInput(offset.toString(16).toUpperCase().padStart(8, "0"));
      }
    }
  }, []);

  // Load filename from analysis
  useEffect(() => {
    if (!params.id) return;
    fetch(`/api/analysis/${params.id}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.filename) setFilename(d.filename);
      })
      .catch(() => {});
  }, [params.id]);

  const fetchPage = useCallback(
    async (offset: number) => {
      if (!params.id) return;
      setLoading(true);
      setError(null);
      try {
        const r = await fetch(
          `/api/analysis/${params.id}/binary/peek?offset=${offset}&length=${PAGE_SIZE}`
        );
        if (!r.ok) {
          const err = await r.json();
          throw new Error(err.error || "Failed to load binary data");
        }
        const data: HexPage = await r.json();
        setPage(data);
        setCurrentOffset(offset);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    },
    [params.id]
  );

  useEffect(() => {
    fetchPage(currentOffset);
  }, [fetchPage, currentOffset]);

  const totalPages = page ? Math.ceil(page.totalSize / PAGE_SIZE) : 0;
  const currentPage = Math.floor(currentOffset / PAGE_SIZE);

  const handleJump = () => {
    const offset = parseInt(jumpInput, 16);
    if (isNaN(offset)) return;
    const pageOffset = Math.floor(offset / PAGE_SIZE) * PAGE_SIZE;
    setHighlightOffset(offset);
    fetchPage(pageOffset);
    // Update URL hash
    window.history.replaceState(null, "", `#offset=${jumpInput.toUpperCase()}`);
  };

  const renderHexRows = () => {
    if (!page) return null;
    const bytes = page.hex.match(/.{2}/g) || [];
    const rows: React.JSX.Element[] = [];

    for (let row = 0; row < ROWS_PER_PAGE; row++) {
      const rowOffset = page.offset + row * BYTES_PER_ROW;
      if (rowOffset >= (page.offset + page.length)) break;

      const rowBytes = bytes.slice(row * BYTES_PER_ROW, (row + 1) * BYTES_PER_ROW);
      const rowAscii = page.ascii.slice(row * BYTES_PER_ROW, (row + 1) * BYTES_PER_ROW);

      const hexCells = rowBytes.map((byte, i) => {
        const byteOffset = rowOffset + i;
        const isHighlighted = highlightOffset !== null && byteOffset === highlightOffset;
        return (
          <span
            key={i}
            className={`inline-block w-7 text-center font-mono text-xs cursor-pointer transition-colors ${
              isHighlighted
                ? "bg-amber-400 text-black rounded"
                : "text-emerald-400 hover:text-amber-300"
            }`}
            onClick={() => {
              setHighlightOffset(byteOffset);
              setJumpInput(byteOffset.toString(16).toUpperCase().padStart(8, "0"));
            }}
          >
            {byte.toUpperCase()}
          </span>
        );
      });

      // Pad to 16 bytes
      while (hexCells.length < BYTES_PER_ROW) {
        hexCells.push(<span key={`pad-${hexCells.length}`} className="inline-block w-7" />);
      }

      rows.push(
        <div key={row} className="flex items-center gap-2 hover:bg-white/5 px-2 py-0.5 rounded">
          {/* Offset */}
          <span className="w-24 font-mono text-xs text-zinc-500 shrink-0 select-none">
            {rowOffset.toString(16).toUpperCase().padStart(8, "0")}
          </span>
          {/* Hex bytes — split into two groups of 8 */}
          <div className="flex gap-0.5">
            {hexCells.slice(0, 8)}
          </div>
          <div className="w-px h-4 bg-zinc-700 mx-1 shrink-0" />
          <div className="flex gap-0.5">
            {hexCells.slice(8)}
          </div>
          {/* ASCII */}
          <div className="w-px h-4 bg-zinc-700 mx-1 shrink-0" />
          <span className="font-mono text-xs text-zinc-400 tracking-widest select-none">
            {rowAscii}
          </span>
        </div>
      );
    }
    return rows;
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      {/* Header */}
      <div className="border-b border-zinc-800 bg-zinc-900 px-4 py-3 flex items-center gap-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate(`/analysis/${params.id}`)}
          className="text-zinc-400 hover:text-zinc-100"
        >
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back to Analysis
        </Button>
        <div className="flex items-center gap-2">
          <Binary className="w-4 h-4 text-emerald-400" />
          <span className="font-mono text-sm text-zinc-300 truncate max-w-xs">
            {filename || params.id}
          </span>
        </div>
        {page && (
          <Badge variant="outline" className="font-mono text-xs text-zinc-400 border-zinc-700 ml-auto">
            {page.totalSize.toLocaleString()} bytes
          </Badge>
        )}
      </div>

      {/* Toolbar */}
      <div className="border-b border-zinc-800 bg-zinc-900/50 px-4 py-2 flex items-center gap-3">
        {/* Jump to offset */}
        <div className="flex items-center gap-2">
          <Search className="w-3.5 h-3.5 text-zinc-500" />
          <span className="text-xs text-zinc-500">Jump to offset (hex):</span>
          <Input
            value={jumpInput}
            onChange={(e) => setJumpInput(e.target.value.replace(/[^0-9a-fA-F]/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && handleJump()}
            placeholder="00000000"
            className="w-28 h-7 font-mono text-xs bg-zinc-800 border-zinc-700 text-amber-300 placeholder:text-zinc-600"
          />
          <Button size="sm" variant="outline" onClick={handleJump} className="h-7 text-xs border-zinc-700 bg-zinc-800 hover:bg-zinc-700">
            Go
          </Button>
        </div>

        {/* Pagination */}
        <div className="flex items-center gap-2 ml-auto">
          <Button
            size="sm"
            variant="ghost"
            disabled={currentOffset === 0 || loading}
            onClick={() => fetchPage(Math.max(0, currentOffset - PAGE_SIZE))}
            className="h-7 w-7 p-0 text-zinc-400"
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <span className="text-xs text-zinc-500 font-mono">
            Page {currentPage + 1} / {totalPages || "?"}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={!page || currentOffset + PAGE_SIZE >= page.totalSize || loading}
            onClick={() => fetchPage(currentOffset + PAGE_SIZE)}
            className="h-7 w-7 p-0 text-zinc-400"
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Hex Content */}
      <div ref={containerRef} className="flex-1 overflow-auto p-4">
        {loading && (
          <div className="flex items-center justify-center h-48 text-zinc-500">
            <div className="animate-pulse font-mono text-sm">Loading binary data...</div>
          </div>
        )}
        {error && (
          <div className="flex items-center justify-center h-48 text-red-400">
            <span className="font-mono text-sm">{error}</span>
          </div>
        )}
        {!loading && !error && page && (
          <div className="space-y-0">
            {/* Column headers */}
            <div className="flex items-center gap-2 px-2 pb-2 border-b border-zinc-800 mb-2">
              <span className="w-24 font-mono text-xs text-zinc-600 shrink-0">Offset</span>
              <div className="flex gap-0.5">
                {Array.from({ length: 8 }, (_, i) => (
                  <span key={i} className="inline-block w-7 text-center font-mono text-xs text-zinc-600">
                    {i.toString(16).toUpperCase().padStart(2, "0")}
                  </span>
                ))}
              </div>
              <div className="w-px h-4 bg-zinc-800 mx-1 shrink-0" />
              <div className="flex gap-0.5">
                {Array.from({ length: 8 }, (_, i) => (
                  <span key={i} className="inline-block w-7 text-center font-mono text-xs text-zinc-600">
                    {(i + 8).toString(16).toUpperCase().padStart(2, "0")}
                  </span>
                ))}
              </div>
              <div className="w-px h-4 bg-zinc-800 mx-1 shrink-0" />
              <span className="font-mono text-xs text-zinc-600">ASCII</span>
            </div>
            {renderHexRows()}
          </div>
        )}
      </div>

      {/* Status bar */}
      {highlightOffset !== null && (
        <div className="border-t border-zinc-800 bg-zinc-900 px-4 py-1.5 flex items-center gap-4 text-xs font-mono">
          <span className="text-zinc-500">Selected offset:</span>
          <span className="text-amber-300">
            0x{highlightOffset.toString(16).toUpperCase().padStart(8, "0")}
          </span>
          <span className="text-zinc-500">({highlightOffset.toLocaleString()} decimal)</span>
        </div>
      )}
    </div>
  );
}
