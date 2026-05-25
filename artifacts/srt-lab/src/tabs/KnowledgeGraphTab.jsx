/**
 * KnowledgeGraphTab — force-directed knowledge graph (Task #695).
 *
 * Nodes: VINs, modules, algorithms, CAN IDs, calibration IDs, security bytes.
 * Edges: seen_together, patched_from, shares_secret_with, uses_algo, has_calibration.
 *
 * Simple physics simulation (no external library): spring attraction along
 * edges + Coulomb repulsion between nodes. Click a node to open the inspector pane.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { C } from "../lib/constants.js";
import { Card } from "../lib/ui.jsx";

const API = "/api";

const NODE_COLORS = {
  VIN:      { bg: "#D32F2F", fg: "#fff", icon: "🔤" },
  MODULE:   { bg: "#1565C0", fg: "#fff", icon: "📦" },
  ALGO:     { bg: "#2E7D32", fg: "#fff", icon: "🔐" },
  CANID:    { bg: "#E65100", fg: "#fff", icon: "🚌" },
  CALIBID:  { bg: "#6A1B9A", fg: "#fff", icon: "📐" },
  SECBYTES: { bg: "#4E342E", fg: "#fff", icon: "🛡️" },
  default:  { bg: "#546E7A", fg: "#fff", icon: "○" },
};

const EDGE_COLORS = {
  seen_together:       "#90A4AE",
  patched_from:        "#D32F2F",
  shares_secret_with:  "#E65100",
  uses_algo:           "#2E7D32",
  has_calibration:     "#6A1B9A",
  default:             "#BDBDBD",
};

const EDGE_LABELS = {
  seen_together:       "seen together",
  patched_from:        "patched from",
  shares_secret_with:  "shares secret",
  uses_algo:           "uses algo",
  has_calibration:     "has calibration",
};

const NODE_R = 18;
const REPULSION = 2800;
const SPRING_K = 0.04;
const SPRING_LEN = 110;
const DAMPING = 0.75;
const DT = 0.55;

function useForceLayout(nodes, edges, width, height) {
  const posRef = useRef(new Map());
  const velRef = useRef(new Map());
  const [tick, setTick] = useState(0);
  const rafRef = useRef(null);
  const stepsRef = useRef(0);

  useEffect(() => {
    const newMap = new Map();
    const velMap = new Map();
    for (const n of nodes) {
      if (posRef.current.has(n.id)) {
        newMap.set(n.id, { ...posRef.current.get(n.id) });
      } else {
        newMap.set(n.id, {
          x: width / 2 + (Math.random() - 0.5) * Math.min(width, height) * 0.6,
          y: height / 2 + (Math.random() - 0.5) * Math.min(width, height) * 0.6,
        });
      }
      velMap.set(n.id, { vx: 0, vy: 0 });
    }
    posRef.current = newMap;
    velRef.current = velMap;
    stepsRef.current = 0;
  }, [nodes.map((n) => n.id).join(","), width, height]);

  useEffect(() => {
    if (nodes.length === 0) return;

    function step() {
      if (stepsRef.current > 300) return;
      stepsRef.current++;

      const pos = posRef.current;
      const vel = velRef.current;
      const nodeArr = nodes;
      const ids = nodeArr.map((n) => n.id);

      const force = new Map(ids.map((id) => [id, { fx: 0, fy: 0 }]));

      for (let i = 0; i < nodeArr.length; i++) {
        for (let j = i + 1; j < nodeArr.length; j++) {
          const a = pos.get(nodeArr[i].id);
          const b = pos.get(nodeArr[j].id);
          if (!a || !b) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const rep = REPULSION / (dist * dist);
          const fx = (dx / dist) * rep;
          const fy = (dy / dist) * rep;
          force.get(nodeArr[i].id).fx -= fx;
          force.get(nodeArr[i].id).fy -= fy;
          force.get(nodeArr[j].id).fx += fx;
          force.get(nodeArr[j].id).fy += fy;
        }
      }

      for (const edge of edges) {
        const a = pos.get(edge.fromNodeId);
        const b = pos.get(edge.toNodeId);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const stretch = dist - SPRING_LEN;
        const fx = (dx / dist) * SPRING_K * stretch;
        const fy = (dy / dist) * SPRING_K * stretch;
        if (force.has(edge.fromNodeId)) {
          force.get(edge.fromNodeId).fx += fx;
          force.get(edge.fromNodeId).fy += fy;
        }
        if (force.has(edge.toNodeId)) {
          force.get(edge.toNodeId).fx -= fx;
          force.get(edge.toNodeId).fy -= fy;
        }
      }

      const margin = NODE_R + 8;
      for (const n of nodeArr) {
        const v = vel.get(n.id);
        const f = force.get(n.id);
        if (!v || !f) continue;
        v.vx = (v.vx + f.fx * DT) * DAMPING;
        v.vy = (v.vy + f.fy * DT) * DAMPING;
        const p = pos.get(n.id);
        p.x = Math.max(margin, Math.min(width - margin, p.x + v.vx * DT));
        p.y = Math.max(margin, Math.min(height - margin, p.y + v.vy * DT));
      }

      setTick((t) => t + 1);
      rafRef.current = requestAnimationFrame(step);
    }

    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [nodes.map((n) => n.id).join(","), edges.length, width, height]);

  return posRef.current;
}

function NodeInspector({ node, edges, nodes, onClose }) {
  if (!node) return null;
  const meta = node.metadata ?? {};
  const outgoing = edges.filter((e) => e.fromNodeId === node.id);
  const incoming = edges.filter((e) => e.toNodeId === node.id);
  const nodeMap = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const nc = NODE_COLORS[node.nodeType] ?? NODE_COLORS.default;

  return (
    <div style={{
      width: 280, flexShrink: 0, borderLeft: `1px solid ${C.bd}`,
      paddingLeft: 14, overflowY: "auto", maxHeight: "70vh",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{
          fontFamily: "'Righteous'", fontSize: 13, color: nc.bg,
        }}>
          {nc.icon} Node Inspector
        </div>
        <button onClick={onClose} style={{
          background: "none", border: "none", cursor: "pointer",
          color: C.ts, fontSize: 16, lineHeight: 1,
        }}>✕</button>
      </div>

      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: C.ts, letterSpacing: 1, marginBottom: 3 }}>TYPE</div>
        <span style={{
          display: "inline-block", padding: "2px 8px", borderRadius: 6,
          background: nc.bg, color: nc.fg, fontSize: 10, fontWeight: 800,
        }}>
          {node.nodeType}
        </span>
      </div>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: C.ts, letterSpacing: 1, marginBottom: 3 }}>LABEL</div>
        <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, wordBreak: "break-all", color: C.tx }}>
          {node.label}
        </div>
      </div>

      {Object.keys(meta).length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: C.ts, letterSpacing: 1, marginBottom: 3 }}>METADATA</div>
          {Object.entries(meta).map(([k, v]) => (
            <div key={k} style={{ fontSize: 10, color: C.ts, marginBottom: 2 }}>
              <strong>{k}:</strong>{" "}
              <span style={{ fontFamily: "'JetBrains Mono'" }}>{String(v)}</span>
            </div>
          ))}
        </div>
      )}

      {outgoing.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: C.ts, letterSpacing: 1, marginBottom: 4 }}>
            OUTGOING EDGES ({outgoing.length})
          </div>
          {outgoing.map((e) => {
            const target = nodeMap[e.toNodeId];
            const ec = EDGE_COLORS[e.edgeType] ?? EDGE_COLORS.default;
            return (
              <div key={e.id} style={{
                padding: "4px 8px", marginBottom: 3, borderRadius: 6,
                background: "#F5F5F5", fontSize: 10, lineHeight: 1.5,
              }}>
                <span style={{ color: ec, fontWeight: 800 }}>
                  {EDGE_LABELS[e.edgeType] ?? e.edgeType}
                </span>
                {" → "}
                <span style={{ fontFamily: "'JetBrains Mono'", wordBreak: "break-all" }}>
                  {target?.label ?? e.toNodeId}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {incoming.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: C.ts, letterSpacing: 1, marginBottom: 4 }}>
            INCOMING EDGES ({incoming.length})
          </div>
          {incoming.map((e) => {
            const source = nodeMap[e.fromNodeId];
            const ec = EDGE_COLORS[e.edgeType] ?? EDGE_COLORS.default;
            return (
              <div key={e.id} style={{
                padding: "4px 8px", marginBottom: 3, borderRadius: 6,
                background: "#F5F5F5", fontSize: 10, lineHeight: 1.5,
              }}>
                <span style={{ fontFamily: "'JetBrains Mono'", wordBreak: "break-all" }}>
                  {source?.label ?? e.fromNodeId}
                </span>
                {" "}
                <span style={{ color: ec, fontWeight: 800 }}>
                  {EDGE_LABELS[e.edgeType] ?? e.edgeType}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ fontSize: 9, color: C.ts, marginTop: 8 }}>
        ID: <code style={{ fontFamily: "'JetBrains Mono'", fontSize: 9 }}>{node.id}</code>
      </div>
    </div>
  );
}

export default function KnowledgeGraphTab() {
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [focus, setFocus] = useState("");
  const [selectedNode, setSelectedNode] = useState(null);
  const svgRef = useRef(null);
  const [svgSize, setSvgSize] = useState({ w: 720, h: 520 });

  useEffect(() => {
    function measure() {
      if (svgRef.current) {
        const rect = svgRef.current.getBoundingClientRect();
        if (rect.width > 50) setSvgSize({ w: rect.width, h: Math.max(420, rect.height) });
      }
    }
    measure();
    const ro = new ResizeObserver(measure);
    if (svgRef.current) ro.observe(svgRef.current);
    return () => ro.disconnect();
  }, []);

  const fetchGraph = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const params = new URLSearchParams();
      if (focus.trim()) params.set("focus", focus.trim());
      const r = await fetch(`${API}/kg?${params}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setNodes(data.nodes ?? []);
      setEdges(data.edges ?? []);
    } catch (ex) {
      setErr(String(ex));
    } finally {
      setLoading(false);
    }
  }, [focus]);

  useEffect(() => {
    fetchGraph();
  }, [fetchGraph]);

  const pos = useForceLayout(nodes, edges, svgSize.w, svgSize.h);

  const nodeMap = useMemo(
    () => Object.fromEntries(nodes.map((n) => [n.id, n])),
    [nodes],
  );

  const typeCounts = useMemo(() => {
    const c = {};
    for (const n of nodes) c[n.nodeType] = (c[n.nodeType] ?? 0) + 1;
    return c;
  }, [nodes]);

  return (
    <div style={{ padding: 16, maxWidth: 1200 }}>
      <Card style={{ marginBottom: 14, background: "#E8F5E9", borderColor: "#2E7D32" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ fontSize: 24 }}>🕸️</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 900, fontSize: 13, color: "#1B5E20", letterSpacing: 0.5 }}>
              KNOWLEDGE GRAPH — MODULE RELATIONSHIP MAP
            </div>
            <div style={{ fontSize: 11, color: "#2E7D32", marginTop: 4, lineHeight: 1.6 }}>
              Nodes: VINs · Modules · Algorithms · CAN IDs · Calibration IDs · Security bytes.
              Edges: seen-together · patched-from · shares-secret-with · uses-algo · has-calibration.
              Click any node to open the inspector panel.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
            <input
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              placeholder="Focus on VIN / module…"
              style={{
                padding: "7px 12px", borderRadius: 8, border: `1.5px solid ${C.bd}`,
                fontFamily: "'Nunito'", fontSize: 11, width: 200, outline: "none",
              }}
              onKeyDown={(e) => e.key === "Enter" && fetchGraph()}
            />
            <button onClick={fetchGraph} style={{
              padding: "7px 14px", borderRadius: 8, border: "none",
              background: "#2E7D32", color: "#fff",
              fontFamily: "'Nunito'", fontWeight: 800, fontSize: 11, cursor: "pointer",
            }}>
              Go
            </button>
          </div>
        </div>
        {nodes.length > 0 && (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
            {Object.entries(typeCounts).map(([type, count]) => {
              const nc = NODE_COLORS[type] ?? NODE_COLORS.default;
              return (
                <span key={type} style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  padding: "3px 10px", borderRadius: 99,
                  background: nc.bg + "22", border: `1px solid ${nc.bg}40`,
                  color: nc.bg, fontSize: 10, fontWeight: 800,
                }}>
                  {nc.icon} {type} <span style={{ fontFamily: "'JetBrains Mono'" }}>{count}</span>
                </span>
              );
            })}
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              padding: "3px 10px", borderRadius: 99,
              background: "#EEEEEE", fontSize: 10, fontWeight: 800, color: C.ts,
            }}>
              ↔ {edges.length} edges
            </span>
          </div>
        )}
      </Card>

      {err && (
        <div style={{ color: C.er, fontSize: 12, padding: 12, background: "#FFEBEE", borderRadius: 8, marginBottom: 10 }}>
          {err}
        </div>
      )}

      {loading && (
        <div style={{ color: C.ts, fontSize: 12, fontStyle: "italic", padding: 20 }}>
          Loading graph…
        </div>
      )}

      {!loading && nodes.length === 0 && (
        <div style={{
          padding: 48, textAlign: "center", color: C.ts,
          fontSize: 12, fontStyle: "italic", background: C.cd,
          borderRadius: 12, border: `1px dashed ${C.bd}`,
        }}>
          No nodes yet. Load and analyze module dumps to auto-populate the graph.
          Patterns are linked automatically after every backup save.
        </div>
      )}

      {!loading && nodes.length > 0 && (
        <div style={{ display: "flex", gap: 14 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              border: `1.5px solid ${C.bd}`, borderRadius: 12, overflow: "hidden",
              background: "#FAFAF8", position: "relative",
            }}>
              <svg
                ref={svgRef}
                width="100%"
                height={svgSize.h}
                style={{ display: "block", cursor: "default" }}
                onClick={() => setSelectedNode(null)}
              >
                <defs>
                  {Object.entries(EDGE_COLORS).map(([type, color]) => (
                    <marker
                      key={type}
                      id={`arrow-${type}`}
                      markerWidth="7" markerHeight="7"
                      refX="6" refY="3.5" orient="auto"
                    >
                      <polygon points="0 0, 7 3.5, 0 7" fill={color} opacity="0.7" />
                    </marker>
                  ))}
                </defs>

                {edges.map((e) => {
                  const a = pos.get(e.fromNodeId);
                  const b = pos.get(e.toNodeId);
                  if (!a || !b) return null;
                  const color = EDGE_COLORS[e.edgeType] ?? EDGE_COLORS.default;
                  const dx = b.x - a.x;
                  const dy = b.y - a.y;
                  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                  const ex = a.x + (dx / dist) * (NODE_R + 2);
                  const ey = a.y + (dy / dist) * (NODE_R + 2);
                  const tx = b.x - (dx / dist) * (NODE_R + 8);
                  const ty = b.y - (dy / dist) * (NODE_R + 8);
                  return (
                    <g key={e.id}>
                      <line
                        x1={ex} y1={ey} x2={tx} y2={ty}
                        stroke={color} strokeWidth={1.5} strokeOpacity={0.55}
                        markerEnd={`url(#arrow-${e.edgeType})`}
                      />
                    </g>
                  );
                })}

                {nodes.map((n) => {
                  const p = pos.get(n.id);
                  if (!p) return null;
                  const nc = NODE_COLORS[n.nodeType] ?? NODE_COLORS.default;
                  const isSelected = selectedNode?.id === n.id;
                  const shortLabel = n.label.length > 12
                    ? n.label.slice(0, 11) + "…"
                    : n.label;
                  return (
                    <g
                      key={n.id}
                      transform={`translate(${p.x},${p.y})`}
                      style={{ cursor: "pointer" }}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        setSelectedNode(n);
                      }}
                    >
                      <circle
                        r={NODE_R}
                        fill={nc.bg}
                        stroke={isSelected ? "#fff" : nc.bg}
                        strokeWidth={isSelected ? 3 : 1.5}
                        strokeOpacity={isSelected ? 1 : 0.4}
                        opacity={0.92}
                      />
                      <text
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fontSize={9}
                        fontFamily="'JetBrains Mono', monospace"
                        fill={nc.fg}
                        fontWeight="bold"
                        y={0}
                      >
                        {shortLabel}
                      </text>
                      <text
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fontSize={8}
                        fontFamily="'Nunito', sans-serif"
                        fill={nc.bg}
                        fontWeight="800"
                        y={NODE_R + 11}
                        opacity={0.8}
                      >
                        {n.nodeType}
                      </text>
                    </g>
                  );
                })}
              </svg>
              {nodes.length > 0 && (
                <div style={{
                  position: "absolute", bottom: 10, right: 10,
                  display: "flex", gap: 6, flexWrap: "wrap",
                  background: "rgba(255,255,255,0.85)", borderRadius: 8,
                  padding: "6px 10px", maxWidth: 300,
                }}>
                  {Object.entries(EDGE_COLORS).filter(([k]) => k !== "default").map(([type, color]) => (
                    <div key={type} style={{ display: "flex", alignItems: "center", gap: 3 }}>
                      <div style={{ width: 16, height: 2, background: color, borderRadius: 1 }} />
                      <span style={{ fontSize: 8, color: C.ts, fontFamily: "'Nunito'", fontWeight: 700 }}>
                        {EDGE_LABELS[type]}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{ fontSize: 10, color: C.ts, marginTop: 6, textAlign: "center" }}>
              Click a node to inspect · Click background to deselect
            </div>
          </div>

          {selectedNode && (
            <NodeInspector
              node={selectedNode}
              edges={edges}
              nodes={nodes}
              onClose={() => setSelectedNode(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}
