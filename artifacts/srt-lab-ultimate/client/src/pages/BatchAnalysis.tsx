import { useState, useRef, useCallback, useEffect } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

// ─── Types ──────────────────────────────────────────────────────────────────

interface BatchItem {
  id: string;
  filename: string;
  fileSize: number;
  status: "queued" | "running" | "complete" | "failed";
  analysisId?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  orderIndex: number;
}

interface BatchProgressEvent {
  type: "batch_start" | "item_start" | "item_progress" | "item_complete" | "item_failed" | "batch_complete" | "done" | "error";
  batchId?: string;
  itemId?: string;
  filename?: string;
  orderIndex?: number;
  totalFiles?: number;
  completedFiles?: number;
  failedFiles?: number;
  analysisId?: string;
  error?: string;
  message?: string;
  swarmEvent?: {
    type: string;
    codename?: string;
    toolName?: string;
    message?: string;
  };
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function BatchAnalysis() {
  const [, navigate] = useLocation();
  const [files, setFiles] = useState<File[]>([]);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [items, setItems] = useState<BatchItem[]>([]);
  const [events, setEvents] = useState<BatchProgressEvent[]>([]);
  const [currentAgent, setCurrentAgent] = useState<string>("");
  const [completedCount, setCompletedCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [isDone, setIsDone] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const eventLogRef = useRef<HTMLDivElement>(null);
  const [dragOver, setDragOver] = useState(false);

  // Auto-scroll event log
  useEffect(() => {
    if (eventLogRef.current) {
      eventLogRef.current.scrollTop = eventLogRef.current.scrollHeight;
    }
  }, [events]);

  // ─── File Selection ─────────────────────────────────────────────────────

  const handleFileSelect = useCallback((selectedFiles: FileList | null) => {
    if (!selectedFiles) return;
    const newFiles = Array.from(selectedFiles).filter(
      f => f.size > 0 && f.size <= 500 * 1024 * 1024 // Max 500MB per file
    );
    setFiles(prev => [...prev, ...newFiles].slice(0, 20)); // Max 20 files
  }, []);

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    handleFileSelect(e.dataTransfer.files);
  }, [handleFileSelect]);

  // ─── Upload & Start Processing ──────────────────────────────────────────

  const startBatch = async () => {
    if (files.length === 0) return;

    setIsUploading(true);
    setEvents([]);
    setItems([]);
    setCompletedCount(0);
    setFailedCount(0);
    setIsDone(false);

    try {
      // Upload all files
      const formData = new FormData();
      files.forEach(f => formData.append("files", f));

      const uploadRes = await fetch("/api/batch-upload", {
        method: "POST",
        body: formData,
      });

      if (!uploadRes.ok) {
        const err = await uploadRes.json();
        throw new Error(err.error || "Upload failed");
      }

      const { batchId: newBatchId, totalFiles } = await uploadRes.json();
      setBatchId(newBatchId);
      setTotalCount(totalFiles);
      setIsUploading(false);
      setIsProcessing(true);

      // Initialize items
      setItems(files.map((f, i) => ({
        id: `temp-${i}`,
        filename: f.name,
        fileSize: f.size,
        status: "queued",
        orderIndex: i,
      })));

      // Start SSE stream for progress
      const eventSource = new EventSource(`/api/batch/${newBatchId}/stream`);

      eventSource.onmessage = (event) => {
        const data: BatchProgressEvent = JSON.parse(event.data);

        if (data.type === "done" || data.type === "error") {
          eventSource.close();
          setIsProcessing(false);
          setIsDone(true);
          if (data.type === "error") {
            toast.error(`Batch failed: ${data.message}`);
          } else {
            toast.success("Batch analysis complete!");
          }
          return;
        }

        // Update events log
        if (data.message && data.type !== "item_progress") {
          setEvents(prev => [...prev.slice(-100), data]);
        }

        // Update item statuses
        if (data.type === "item_start" && data.orderIndex !== undefined) {
          setItems(prev => prev.map((item, i) =>
            i === data.orderIndex ? { ...item, status: "running" } : item
          ));
          setCurrentAgent("");
        }

        if (data.type === "item_progress" && data.swarmEvent?.codename) {
          setCurrentAgent(data.swarmEvent.codename);
        }

        if (data.type === "item_complete" && data.orderIndex !== undefined) {
          setItems(prev => prev.map((item, i) =>
            i === data.orderIndex
              ? { ...item, status: "complete", analysisId: data.analysisId }
              : item
          ));
          setCompletedCount(data.completedFiles || 0);
        }

        if (data.type === "item_failed" && data.orderIndex !== undefined) {
          setItems(prev => prev.map((item, i) =>
            i === data.orderIndex
              ? { ...item, status: "failed", error: data.error }
              : item
          ));
          setFailedCount(data.failedFiles || 0);
        }

        if (data.type === "batch_complete") {
          setCompletedCount(data.completedFiles || 0);
          setFailedCount(data.failedFiles || 0);
        }
      };

      eventSource.onerror = () => {
        eventSource.close();
        setIsProcessing(false);
        setIsDone(true);
      };

    } catch (err: any) {
      toast.error(err.message);
      setIsUploading(false);
      setIsProcessing(false);
    }
  };

  // ─── Render ─────────────────────────────────────────────────────────────

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Header */}
      <div className="border-b border-zinc-800 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => navigate("/")}
              className="text-zinc-400 hover:text-white transition-colors"
            >
              &larr; Back
            </button>
            <h1 className="text-xl font-bold tracking-tight">
              <span className="text-cyan-400">BATCH</span> Analysis Queue
            </h1>
          </div>
          {isDone && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-emerald-400">{completedCount} completed</span>
              {failedCount > 0 && <span className="text-red-400">{failedCount} failed</span>}
            </div>
          )}
        </div>
      </div>

      <div className="p-6 max-w-6xl mx-auto">
        {/* Upload Zone (only show when not processing) */}
        {!isProcessing && !isDone && (
          <div className="mb-8">
            <div
              className={`border-2 border-dashed rounded-xl p-12 text-center transition-all cursor-pointer ${
                dragOver
                  ? "border-cyan-400 bg-cyan-400/5"
                  : "border-zinc-700 hover:border-zinc-500"
              }`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => handleFileSelect(e.target.files)}
                accept=".exe,.bin,.eep,.hex,.s19,.srec,.elf,.dll,.so,.fw,.rom"
              />
              <div className="text-4xl mb-4">📦</div>
              <p className="text-lg text-zinc-300 mb-2">
                Drop up to 20 binary files here
              </p>
              <p className="text-sm text-zinc-500">
                .exe, .bin, .eep, .hex, .s19, .elf, .dll, .fw, .rom (max 500MB each)
              </p>
            </div>

            {/* File List */}
            {files.length > 0 && (
              <div className="mt-6">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-medium text-zinc-400">
                    {files.length} file{files.length > 1 ? "s" : ""} selected
                  </h3>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setFiles([])}
                      className="text-zinc-400 border-zinc-700"
                    >
                      Clear All
                    </Button>
                    <Button
                      size="sm"
                      onClick={startBatch}
                      disabled={isUploading}
                      className="bg-cyan-600 hover:bg-cyan-500 text-white"
                    >
                      {isUploading ? "Uploading..." : `Analyze ${files.length} Files`}
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {files.map((f, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="text-xs text-zinc-500 font-mono w-5">
                          {i + 1}
                        </span>
                        <span className="text-sm text-zinc-200 truncate">
                          {f.name}
                        </span>
                        <span className="text-xs text-zinc-500">
                          {formatSize(f.size)}
                        </span>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); removeFile(i); }}
                        className="text-zinc-600 hover:text-red-400 transition-colors ml-2"
                      >
                        &times;
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Processing Dashboard */}
        {(isProcessing || isDone) && (
          <div className="space-y-6">
            {/* Progress Bar */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-medium text-zinc-400">
                  {isProcessing ? "Processing..." : "Complete"}
                </h3>
                <span className="text-sm text-zinc-500">
                  {completedCount + failedCount} / {totalCount}
                </span>
              </div>
              <div className="w-full h-3 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full transition-all duration-500 ease-out rounded-full"
                  style={{
                    width: `${((completedCount + failedCount) / Math.max(totalCount, 1)) * 100}%`,
                    background: failedCount > 0
                      ? "linear-gradient(90deg, #10b981, #ef4444)"
                      : "#10b981",
                  }}
                />
              </div>
              {currentAgent && isProcessing && (
                <p className="text-xs text-cyan-400 mt-2 font-mono animate-pulse">
                  Active Agent: {currentAgent}
                </p>
              )}
            </div>

            {/* Items Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {items.map((item, i) => (
                <div
                  key={i}
                  className={`border rounded-lg p-4 transition-all ${
                    item.status === "running"
                      ? "border-cyan-500/50 bg-cyan-500/5 shadow-lg shadow-cyan-500/10"
                      : item.status === "complete"
                      ? "border-emerald-500/30 bg-emerald-500/5"
                      : item.status === "failed"
                      ? "border-red-500/30 bg-red-500/5"
                      : "border-zinc-800 bg-zinc-900/50"
                  }`}
                >
                  <div className="flex items-start justify-between mb-2">
                    <span className="text-xs font-mono text-zinc-500">
                      #{i + 1}
                    </span>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                      item.status === "running"
                        ? "bg-cyan-500/20 text-cyan-400"
                        : item.status === "complete"
                        ? "bg-emerald-500/20 text-emerald-400"
                        : item.status === "failed"
                        ? "bg-red-500/20 text-red-400"
                        : "bg-zinc-700/50 text-zinc-500"
                    }`}>
                      {item.status === "running" ? "ANALYZING" : item.status.toUpperCase()}
                    </span>
                  </div>
                  <p className="text-sm text-zinc-200 truncate mb-1">
                    {item.filename}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {formatSize(item.fileSize)}
                  </p>
                  {item.status === "complete" && item.analysisId && (
                    <button
                      onClick={() => navigate(`/analysis/${item.analysisId}`)}
                      className="mt-2 text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
                    >
                      View Analysis &rarr;
                    </button>
                  )}
                  {item.status === "failed" && item.error && (
                    <p className="mt-2 text-xs text-red-400 truncate">
                      {item.error}
                    </p>
                  )}
                  {item.status === "running" && (
                    <div className="mt-2 h-1 bg-zinc-800 rounded-full overflow-hidden">
                      <div className="h-full bg-cyan-400 rounded-full animate-pulse w-2/3" />
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Event Log */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
                <h3 className="text-sm font-medium text-zinc-400">Event Log</h3>
                <span className="text-xs text-zinc-600">{events.length} events</span>
              </div>
              <div
                ref={eventLogRef}
                className="h-48 overflow-y-auto p-4 font-mono text-xs space-y-1"
              >
                {events.length === 0 && (
                  <p className="text-zinc-600">Waiting for events...</p>
                )}
                {events.map((event, i) => (
                  <div
                    key={i}
                    className={`${
                      event.type === "item_complete"
                        ? "text-emerald-400"
                        : event.type === "item_failed"
                        ? "text-red-400"
                        : event.type === "batch_complete"
                        ? "text-cyan-400 font-bold"
                        : "text-zinc-400"
                    }`}
                  >
                    <span className="text-zinc-600 mr-2">
                      [{new Date().toLocaleTimeString()}]
                    </span>
                    {event.message}
                  </div>
                ))}
              </div>
            </div>

            {/* Actions */}
            {isDone && (
              <div className="flex gap-3">
                <Button
                  onClick={() => {
                    setFiles([]);
                    setBatchId(null);
                    setItems([]);
                    setEvents([]);
                    setIsDone(false);
                    setCompletedCount(0);
                    setFailedCount(0);
                    setTotalCount(0);
                  }}
                  className="bg-cyan-600 hover:bg-cyan-500"
                >
                  New Batch
                </Button>
                <Button
                  variant="outline"
                  onClick={() => navigate("/history")}
                  className="border-zinc-700 text-zinc-300"
                >
                  View All Analyses
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
