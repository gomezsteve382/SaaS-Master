import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  GitBranch,
  ArrowLeft,
  RefreshCw,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Info,
} from "lucide-react";


// ─── Types ────────────────────────────────────────────────────────────────────

interface KgNode {
  id: string;
  nodeType: string;
  label: string;
  properties: Record<string, unknown> | null;
  sourceAnalysisId: string | null;
  createdAt: number;
  // layout
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}

interface KgEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  edgeType: string;
  weight: number;
  properties: Record<string, unknown> | null;
}

// ─── Node color/shape by type ─────────────────────────────────────────────────

const NODE_COLORS: Record<string, string> = {
  binary: "#ef4444",
  algorithm: "#22c55e",
  seed_key: "#eab308",
  can_id: "#3b82f6",
  module_type: "#a855f7",
  string: "#ec4899",
  function: "#06b6d4",
  protocol: "#f97316",
  checksum: "#f59e0b",
  pattern: "#8b5cf6",
};

const EDGE_COLORS: Record<string, string> = {
  contains: "#6b7280",
  uses: "#22c55e",
  implements: "#a855f7",
  matches: "#3b82f6",
  derived_from: "#f59e0b",
  similar_to: "#ec4899",
  communicates_with: "#06b6d4",
  depends_on: "#ef4444",
};

// ─── Simple force-directed layout (no D3 dependency) ─────────────────────────

function runForceLayout(nodes: KgNode[], edges: KgEdge[], iterations = 200) {
  const W = 900, H = 600;
  // Initialize positions
  nodes.forEach((n, i) => {
    if (n.x === undefined) {
      n.x = W / 2 + (Math.random() - 0.5) * 400;
      n.y = H / 2 + (Math.random() - 0.5) * 400;
      n.vx = 0;
      n.vy = 0;
    }
  });

  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  for (let iter = 0; iter < iterations; iter++) {
    const alpha = 1 - iter / iterations;

    // Repulsion between all pairs
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const dx = (b.x ?? 0) - (a.x ?? 0);
        const dy = (b.y ?? 0) - (a.y ?? 0);
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = (3000 / (dist * dist)) * alpha;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx = (a.vx ?? 0) - fx;
        a.vy = (a.vy ?? 0) - fy;
        b.vx = (b.vx ?? 0) + fx;
        b.vy = (b.vy ?? 0) + fy;
      }
    }

    // Attraction along edges
    for (const edge of edges) {
      const a = nodeMap.get(edge.fromNodeId);
      const b = nodeMap.get(edge.toNodeId);
      if (!a || !b) continue;
      const dx = (b.x ?? 0) - (a.x ?? 0);
      const dy = (b.y ?? 0) - (a.y ?? 0);
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const target = 120;
      const force = ((dist - target) / dist) * 0.05 * alpha;
      const fx = dx * force;
      const fy = dy * force;
      a.vx = (a.vx ?? 0) + fx;
      a.vy = (a.vy ?? 0) + fy;
      b.vx = (b.vx ?? 0) - fx;
      b.vy = (b.vy ?? 0) - fy;
    }

    // Center gravity
    for (const n of nodes) {
      n.vx = (n.vx ?? 0) + (W / 2 - (n.x ?? 0)) * 0.003 * alpha;
      n.vy = (n.vy ?? 0) + (H / 2 - (n.y ?? 0)) * 0.003 * alpha;
      n.x = (n.x ?? 0) + (n.vx ?? 0);
      n.y = (n.y ?? 0) + (n.vy ?? 0);
      n.vx = (n.vx ?? 0) * 0.85;
      n.vy = (n.vy ?? 0) * 0.85;
      // Clamp
      n.x = Math.max(40, Math.min(W - 40, n.x ?? 0));
      n.y = Math.max(40, Math.min(H - 40, n.y ?? 0));
    }
  }
}

// ─── SVG Graph Component ──────────────────────────────────────────────────────

function GraphCanvas({
  nodes,
  edges,
  selectedNode,
  onSelectNode,
}: {
  nodes: KgNode[];
  edges: KgEdge[];
  selectedNode: KgNode | null;
  onSelectNode: (n: KgNode | null) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as SVGElement).tagName === "svg" || (e.target as SVGElement).tagName === "rect") {
      setDragging({ startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y });
    }
  };
  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragging) return;
    setPan({ x: dragging.panX + (e.clientX - dragging.startX), y: dragging.panY + (e.clientY - dragging.startY) });
  };
  const handleMouseUp = () => setDragging(null);

  return (
    <div className="relative w-full h-full">
      {/* Zoom controls */}
      <div className="absolute top-3 right-3 flex flex-col gap-1 z-10">
        <Button size="icon" variant="outline" className="w-7 h-7" onClick={() => setZoom(z => Math.min(z * 1.2, 4))}>
          <ZoomIn className="w-3 h-3" />
        </Button>
        <Button size="icon" variant="outline" className="w-7 h-7" onClick={() => setZoom(z => Math.max(z / 1.2, 0.2))}>
          <ZoomOut className="w-3 h-3" />
        </Button>
        <Button size="icon" variant="outline" className="w-7 h-7" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>
          <Maximize2 className="w-3 h-3" />
        </Button>
      </div>

      <svg
        ref={svgRef}
        className="w-full h-full cursor-grab active:cursor-grabbing select-none"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <defs>
          <marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M0,0 L0,6 L6,3 z" fill="#4b5563" />
          </marker>
        </defs>
        <rect width="100%" height="100%" fill="transparent" />
        <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
          {/* Edges */}
          {edges.map(edge => {
            const from = nodeMap.get(edge.fromNodeId);
            const to = nodeMap.get(edge.toNodeId);
            if (!from || !to) return null;
            const color = EDGE_COLORS[edge.edgeType] || "#6b7280";
            const mx = ((from.x ?? 0) + (to.x ?? 0)) / 2;
            const my = ((from.y ?? 0) + (to.y ?? 0)) / 2;
            return (
              <g key={edge.id}>
                <line
                  x1={from.x} y1={from.y}
                  x2={to.x} y2={to.y}
                  stroke={color}
                  strokeWidth={0.8}
                  strokeOpacity={0.5}
                  markerEnd="url(#arrow)"
                />
                <text x={mx} y={my} fill={color} fontSize={8} textAnchor="middle" opacity={0.7} dy={-3}>
                  {edge.edgeType.replace(/_/g, " ")}
                </text>
              </g>
            );
          })}

          {/* Nodes */}
          {nodes.map(node => {
            const color = NODE_COLORS[node.nodeType] || "#9ca3af";
            const isSelected = selectedNode?.id === node.id;
            const r = node.nodeType === "binary" ? 14 : 10;
            return (
              <g
                key={node.id}
                transform={`translate(${node.x ?? 0},${node.y ?? 0})`}
                className="cursor-pointer"
                onClick={(e) => { e.stopPropagation(); onSelectNode(isSelected ? null : node); }}
              >
                <circle
                  r={r + (isSelected ? 3 : 0)}
                  fill={color}
                  fillOpacity={isSelected ? 0.9 : 0.7}
                  stroke={isSelected ? "#fff" : color}
                  strokeWidth={isSelected ? 2 : 1}
                />
                <text
                  y={r + 12}
                  fill="#e5e7eb"
                  fontSize={9}
                  textAnchor="middle"
                  className="pointer-events-none"
                >
                  {node.label.length > 18 ? node.label.slice(0, 16) + "…" : node.label}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function KnowledgeGraph() {
  const [user, setUser] = useState<{ name?: string } | null>({ name: "Public User" });
  const [authLoading, setAuthLoading] = useState(true);
  const [, navigate] = useLocation();
  const [nodes, setNodes] = useState<KgNode[]>([]);
  const [edges, setEdges] = useState<KgEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedNode, setSelectedNode] = useState<KgNode | null>(null);

  // No authentication required - public access
  useEffect(() => {
    setAuthLoading(false);
    setUser({ name: "Public User" });
  }, []);

  const fetchGraph = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/kg");
      if (res.ok) {
        const data = await res.json();
        const ns: KgNode[] = data.nodes || [];
        const es: KgEdge[] = data.edges || [];
        runForceLayout(ns, es, 300);
        setNodes([...ns]);
        setEdges(es);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user) fetchGraph();
  }, [user, fetchGraph]);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground text-sm">Loading...</div>
      </div>
    );
  }

  // Legend
  const nodeTypes = Array.from(new Set(nodes.map(n => n.nodeType)));
  const edgeTypes = Array.from(new Set(edges.map(e => e.edgeType)));

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="border-b border-border/40 bg-card/30 backdrop-blur-sm sticky top-0 z-10 shrink-0">
        <div className="max-w-full px-4 py-3 flex items-center gap-4">
          <button onClick={() => navigate("/")} className="text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <GitBranch className="w-5 h-5 text-primary" />
          <div>
            <h1 className="text-sm font-bold">Knowledge Graph</h1>
            <p className="text-[10px] text-muted-foreground">
              {nodes.length} nodes · {edges.length} edges
            </p>
          </div>
          <div className="ml-auto">
            <Button size="sm" variant="outline" className="gap-2" onClick={fetchGraph} disabled={loading}>
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Graph canvas */}
        <div className="flex-1 relative bg-[#0a0a0a]" style={{ minHeight: 500 }}>
          {loading ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-muted-foreground text-sm animate-pulse">Building graph...</div>
            </div>
          ) : nodes.length === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center space-y-3">
                <GitBranch className="w-12 h-12 mx-auto text-muted-foreground opacity-30" />
                <p className="text-sm text-muted-foreground">No graph data yet.</p>
                <p className="text-xs text-muted-foreground opacity-70">
                  Run analyses and extract patterns to build the knowledge graph.
                </p>
              </div>
            </div>
          ) : (
            <GraphCanvas
              nodes={nodes}
              edges={edges}
              selectedNode={selectedNode}
              onSelectNode={setSelectedNode}
            />
          )}
        </div>

        {/* Sidebar */}
        <div className="w-72 border-l border-border/40 bg-card/20 flex flex-col overflow-y-auto shrink-0">
          {/* Selected node info */}
          {selectedNode ? (
            <div className="p-4 border-b border-border/40">
              <div className="flex items-center gap-2 mb-2">
                <div
                  className="w-3 h-3 rounded-full"
                  style={{ background: NODE_COLORS[selectedNode.nodeType] || "#9ca3af" }}
                />
                <span className="text-xs font-semibold text-foreground">{selectedNode.label}</span>
              </div>
              <Badge variant="outline" className="text-[10px] mb-2">
                {selectedNode.nodeType.replace(/_/g, " ")}
              </Badge>
              {selectedNode.properties && Object.keys(selectedNode.properties).length > 0 && (
                <pre className="text-[10px] font-mono bg-muted/30 rounded p-2 overflow-x-auto whitespace-pre-wrap mt-2">
                  {JSON.stringify(selectedNode.properties, null, 2)}
                </pre>
              )}
              <p className="text-[10px] text-muted-foreground mt-2">
                Added {new Date(selectedNode.createdAt).toLocaleDateString()}
              </p>
              {/* Connections */}
              <div className="mt-3">
                <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider mb-1">Connections</p>
                {edges
                  .filter(e => e.fromNodeId === selectedNode.id || e.toNodeId === selectedNode.id)
                  .map(e => {
                    const other = e.fromNodeId === selectedNode.id
                      ? nodes.find(n => n.id === e.toNodeId)
                      : nodes.find(n => n.id === e.fromNodeId);
                    if (!other) return null;
                    const direction = e.fromNodeId === selectedNode.id ? "→" : "←";
                    return (
                      <div key={e.id} className="flex items-center gap-1.5 text-[10px] py-0.5">
                        <span className="text-muted-foreground">{direction}</span>
                        <span
                          className="font-mono truncate"
                          style={{ color: NODE_COLORS[other.nodeType] || "#9ca3af" }}
                        >
                          {other.label}
                        </span>
                        <span className="text-muted-foreground shrink-0">({e.edgeType.replace(/_/g, " ")})</span>
                      </div>
                    );
                  })}
              </div>
            </div>
          ) : (
            <div className="p-4 border-b border-border/40">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Info className="w-4 h-4" />
                <p className="text-xs">Click a node to inspect it</p>
              </div>
            </div>
          )}

          {/* Legend */}
          <div className="p-4 space-y-4">
            {nodeTypes.length > 0 && (
              <div>
                <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider mb-2">Node Types</p>
                <div className="space-y-1">
                  {nodeTypes.map(t => (
                    <div key={t} className="flex items-center gap-2">
                      <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: NODE_COLORS[t] || "#9ca3af" }} />
                      <span className="text-xs text-muted-foreground">{t.replace(/_/g, " ")}</span>
                      <span className="text-xs text-muted-foreground ml-auto">
                        {nodes.filter(n => n.nodeType === t).length}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {edgeTypes.length > 0 && (
              <div>
                <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider mb-2">Edge Types</p>
                <div className="space-y-1">
                  {edgeTypes.map(t => (
                    <div key={t} className="flex items-center gap-2">
                      <div className="w-4 h-0.5 shrink-0" style={{ background: EDGE_COLORS[t] || "#6b7280" }} />
                      <span className="text-xs text-muted-foreground">{t.replace(/_/g, " ")}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
