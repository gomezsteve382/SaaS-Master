/* WorkflowTab — Vehicle Job + Module Swap orchestrator (Task #501).
 *
 * Doesn't reimplement any of the existing tabs. Instead it gives the tech a
 * single screen that chains them together:
 *
 *   1.  Pick / create a Vehicle Job (persisted via /api/vehicle-jobs).
 *   2.  Build a Module Census (expected slots vs loaded dumps).
 *   3.  Auto-build a Fix Plan (ordered Fix Steps with security-access reqs).
 *   4.  Workflow Runner — mark each step ok/fail, log NRC outcomes,
 *       open the relevant existing tab when manual work is needed.
 *   5.  Sign-Off summary, persisted to vehicleJobs.signOff.
 *
 * CHANGE (auto-plan): The fix plan and census are always live — they compute
 * directly from loadedDumps + vin in context. No job creation is required to
 * see or run the plan. Job creation is now optional and only needed for
 * persisting sign-off / audit history.
 *
 * The runner uses a SecurityAccessSource so the same UI can be wired to a
 * future bench HSM by swapping the source. Today only LocalAlgoOverJ2534 is
 * available; the source is stored on the job so a sign-off captures which
 * impl actually ran the seeds.
 */
import React, { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { C } from "../lib/constants.js";
import { Card, Btn } from "../lib/ui.jsx";
import { MasterVinContext } from "../lib/masterVinContext.jsx";
import { buildCensus } from "../lib/moduleCensus.js";
import { buildFixPlan, buildSignOff } from "../lib/fixPlanBuilder.js";
import {
  listJobs,
  createJob,
  getJob,
  patchJob,
  deleteJob,
  appendEvent,
  newJobId,
} from "../lib/vehicleJobs.js";
import { buildJobReportData } from "../lib/reportData.js";
import { buildJobPDF } from "../lib/buildAnalysisPDF.js";
import Sec16SyncHistoryCard from "../components/Sec16SyncHistoryCard.jsx";
import ChipBurnAuditCard from "../components/ChipBurnAuditCard.jsx";

const VIN_RX = /^[A-HJ-NPR-Z0-9]{17}$/;

const DEFAULT_EXPECTED = [
  { code: "BCM", name: "Body Control Module" },
  { code: "RFHUB", name: "RF Hub" },
  { code: "ECM", name: "Engine Control Module" },
];

const STATUS_COLORS = {
  ok: C.gn,
  fail: C.er,
  pending: C.tm,
  running: C.a3,
  skipped: C.wn,
};

function fmtTs(ts) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function CensusRow({ row }) {
  const palette = {
    ok: C.gn,
    mismatch: C.wn,
    missing: C.er,
    extra: C.a3,
    unknown: C.tm,
    corrupt: C.er,
  };
  const color = palette[row.kind] || C.tm;
  return (
    <div
      data-testid={`census-row-${row.code}`}
      data-census-kind={row.kind}
      style={{
        display: "flex",
        gap: 12,
        alignItems: "center",
        padding: "10px 12px",
        borderRadius: 10,
        border: `1px solid ${color}33`,
        background: color + "0A",
        marginBottom: 6,
      }}
    >
      <div
        style={{
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: color,
        }}
      />
      <div style={{ minWidth: 110, fontWeight: 800, color: C.tx }}>{row.code}</div>
      <div style={{ flex: 1, fontSize: 12, color: C.ts }}>
        {row.reason || row.name || ""}
      </div>
      <div
        style={{
          fontSize: 10,
          letterSpacing: 1.2,
          fontWeight: 800,
          color,
          textTransform: "uppercase",
        }}
      >
        {row.kind}
      </div>
    </div>
  );
}

function StepRow({ step, result, onMark, onOpenTab }) {
  const status = result?.status || "pending";
  const color = STATUS_COLORS[status] || C.tm;
  return (
    <div
      data-testid={`fix-step-${step.id}`}
      style={{
        padding: 12,
        border: `1px solid ${color}33`,
        background: color + "0A",
        borderRadius: 12,
        marginBottom: 8,
      }}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <div
          style={{
            fontSize: 10,
            letterSpacing: 1.2,
            color,
            fontWeight: 800,
          }}
        >
          {status.toUpperCase()}
        </div>
        <div style={{ flex: 1, fontWeight: 700 }}>{step.label}</div>
        <span
          style={{
            fontSize: 9,
            letterSpacing: 1,
            color: C.tm,
            border: `1px solid ${C.bd}`,
            borderRadius: 6,
            padding: "2px 6px",
            textTransform: "uppercase",
          }}
        >
          {step.action}
        </span>
      </div>
      {step.notes && (
        <div style={{ marginTop: 6, fontSize: 11, color: C.ts }}>{step.notes}</div>
      )}
      {Array.isArray(step.expectedTraffic) && step.expectedTraffic.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 10, color: C.tm, fontFamily: "JetBrains Mono" }}>
          {step.expectedTraffic.join("  ·  ")}
        </div>
      )}
      {result?.note && (
        <div style={{ marginTop: 6, fontSize: 11, color: C.tx }}>↳ {result.note}</div>
      )}
      <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
        <Btn
          color={C.gn}
          outline
          onClick={() => onMark(step, "ok")}
          data-testid={`mark-ok-${step.id}`}
        >
          MARK OK
        </Btn>
        <Btn
          color={C.er}
          outline
          onClick={() => {
            const note = window.prompt("Reason this step failed?") || "";
            onMark(step, "fail", note);
          }}
          data-testid={`mark-fail-${step.id}`}
        >
          MARK FAIL
        </Btn>
        <Btn color={C.tm} outline onClick={() => onMark(step, "skipped")}>
          SKIP
        </Btn>
        {step.action === "vinWrite" && (
          <Btn color={C.a3} outline onClick={() => onOpenTab("vinprog")}>
            OPEN VIN + CHECKSUM →
          </Btn>
        )}
        {step.action === "sec16Patch" && (
          <Btn color={C.a3} outline onClick={() => onOpenTab("bcm")}>
            OPEN BCM TAB →
          </Btn>
        )}
        {step.action === "pairing" && (
          <Btn color={C.a3} outline onClick={() => onOpenTab("keyprog")}>
            OPEN KEY PROG →
          </Btn>
        )}
        {step.action === "verify" && (
          <Btn color={C.a3} outline onClick={() => onOpenTab("obd")}>
            OPEN LIVE OBD →
          </Btn>
        )}
      </div>
    </div>
  );
}

/* ─── Severity badge ─────────────────────────────────────────────────────── */
function SeverityBadge({ count, label, color }) {
  if (!count) return null;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "3px 10px",
        borderRadius: 999,
        background: color + "18",
        border: `1px solid ${color}55`,
        color,
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: 0.5,
      }}
    >
      {count} {label}
    </span>
  );
}

export default function WorkflowTab({ onOpenTab } = {}) {
  const ctx = useContext(MasterVinContext);
  const { vin, setVin, loadedDumps, setPg, jobId, setJobId, hydrateFromJob } = ctx;
  const goTab = typeof onOpenTab === "function" ? onOpenTab : setPg;
  const [jobs, setJobs] = useState([]);
  const [job, setJob] = useState(null);
  const [results, setResults] = useState({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [signOff, setSignOff] = useState(null);
  // Controls whether the "Save Job" panel is expanded
  const [showJobPanel, setShowJobPanel] = useState(false);

  const refreshJobs = useCallback(async () => {
    try {
      const list = await listJobs();
      setJobs(list);
    } catch (e) {
      setError(String(e.message || e));
    }
  }, []);

  useEffect(() => {
    refreshJobs();
  }, [refreshJobs]);

  // When a jobId is set on the master context (from an external link or a
  // previous session), pull the persisted record so the runner shows the
  // saved fixPlan/signOff.
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!jobId) {
        setJob(null);
        return;
      }
      try {
        const j = await getJob(jobId);
        if (!alive) return;
        setJob(j);
        if (j?.signOff) setSignOff(j.signOff);
      } catch (e) {
        if (!alive) return;
        setError(String(e.message || e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [jobId]);

  // ── Live census and fix plan — always computed from context, no job needed ──
  const census = useMemo(
    () =>
      buildCensus({
        expected: DEFAULT_EXPECTED,
        loaded: loadedDumps,
        targetVin: vin,
      }),
    [loadedDumps, vin],
  );

  const plan = useMemo(
    () => buildFixPlan({ census, targetVin: vin }),
    [census, vin],
  );

  // Derive a quick severity summary for the banner
  const criticalCount = useMemo(
    () => census.rows.filter((r) => r.kind === "mismatch" || r.kind === "corrupt").length,
    [census],
  );
  const missingCount = useMemo(
    () => census.rows.filter((r) => r.kind === "missing").length,
    [census],
  );
  const hasIssues = criticalCount > 0 || missingCount > 0 || plan.blockers.length > 0;
  const allOk = census.rows.length > 0 && census.rows.every((r) => r.kind === "ok");

  const handleCreateJob = useCallback(async () => {
    setError("");
    if (!VIN_RX.test(vin)) {
      setError("Enter a valid 17-character VIN before starting a job.");
      return;
    }
    setBusy("creating");
    try {
      const id = newJobId();
      const created = await createJob({
        id,
        vin,
        title: `Job for ${vin}`,
        vehicle: { source: "workflow-tab" },
        status: "in-progress",
      });
      setJob(created);
      setJobId(created.id);
      hydrateFromJob(created);
      await appendEvent(created.id, {
        kind: "job.created",
        payload: { vin, securitySource: "LocalAlgoOverJ2534" },
      });
      await refreshJobs();
      setShowJobPanel(false);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy("");
    }
  }, [vin, hydrateFromJob, refreshJobs, setJobId]);

  const handleSelectJob = useCallback(
    async (id) => {
      setBusy("loading");
      try {
        const j = await getJob(id);
        setJob(j);
        setJobId(id);
        hydrateFromJob(j);
        if (j?.signOff) setSignOff(j.signOff);
        else setSignOff(null);
        setResults({});
        setShowJobPanel(false);
      } catch (e) {
        setError(String(e.message || e));
      } finally {
        setBusy("");
      }
    },
    [hydrateFromJob, setJobId],
  );

  const handleDeleteJob = useCallback(
    async (id) => {
      if (!window.confirm("Delete this vehicle job?")) return;
      try {
        await deleteJob(id);
        if (job?.id === id) {
          setJob(null);
          setJobId(null);
          setSignOff(null);
        }
        await refreshJobs();
      } catch (e) {
        setError(String(e.message || e));
      }
    },
    [job, refreshJobs, setJobId],
  );

  const handleMarkStep = useCallback(
    async (step, status, note = "") => {
      const finishedAt = new Date().toISOString();
      setResults((prev) => ({
        ...prev,
        [step.id]: { status, note, finishedAt },
      }));
      if (job?.id) {
        try {
          await appendEvent(job.id, {
            kind: `step.${status}`,
            module: step.module,
            payload: {
              stepId: step.id,
              action: step.action,
              label: step.label,
              note,
            },
          });
        } catch (e) {
          setError(`event-log: ${e.message || e}`);
        }
      }
    },
    [job],
  );

  const handleSavePlan = useCallback(async () => {
    if (!job?.id) return;
    setBusy("saving");
    try {
      const updated = await patchJob(job.id, {
        census,
        fixPlan: { steps: plan.steps, blockers: plan.blockers },
      });
      setJob(updated);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy("");
    }
  }, [job, census, plan]);

  const handleSignOff = useCallback(async () => {
    if (!job?.id) return;
    setBusy("signing");
    try {
      const summary = buildSignOff({ census, plan, results, targetVin: vin });
      const updated = await patchJob(job.id, {
        signOff: summary,
        status: summary.ready ? "complete" : "blocked",
      });
      setJob(updated);
      setSignOff(summary);
      await appendEvent(job.id, { kind: "job.signOff", payload: summary });
      await refreshJobs();
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy("");
    }
  }, [job, census, plan, results, vin, refreshJobs]);

  const handleOpenTab = useCallback(
    (id) => {
      if (typeof goTab === "function") goTab(id);
    },
    [goTab],
  );

  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfToast, setPdfToast] = useState("");

  const handleExportPDF = useCallback(async () => {
    if (!job) return;
    setPdfBusy(true);
    setPdfToast("");
    try {
      const reportData = buildJobReportData(job, { results });
      await buildJobPDF(reportData);
      setPdfToast("PDF downloaded.");
    } catch (e) {
      setPdfToast("PDF export failed: " + (e.message || String(e)));
    } finally {
      setPdfBusy(false);
    }
  }, [job, results]);

  const hasFiles = loadedDumps.length > 0;
  const vinReady = VIN_RX.test(vin);

  return (
    <div data-testid="workflow-tab" style={{ display: "grid", gap: 16 }}>

      {/* ── Top status bar: VIN input + live severity banner ── */}
      <Card>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 11, letterSpacing: 2, color: C.tm, fontWeight: 800 }}>
              WORKFLOW
            </div>
            <div style={{ fontSize: 16, fontWeight: 900, marginTop: 2 }}>
              {hasFiles
                ? allOk
                  ? "✓ Module set looks good"
                  : hasIssues
                  ? `⚠ ${plan.steps.length} fix step${plan.steps.length !== 1 ? "s" : ""} needed`
                  : `${plan.steps.length} step${plan.steps.length !== 1 ? "s" : ""} in plan`
                : "Load dumps to auto-generate fix plan"}
            </div>
            {hasFiles && (
              <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                <SeverityBadge count={criticalCount} label="critical" color={C.er} />
                <SeverityBadge count={missingCount} label="missing" color={C.wn} />
                <SeverityBadge count={plan.blockers.length} label="blocker" color={C.a3} />
                {allOk && (
                  <span style={{ fontSize: 11, color: C.gn, fontWeight: 800 }}>
                    ✓ All modules paired
                  </span>
                )}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              data-testid="workflow-vin-input"
              value={vin}
              onChange={(e) => setVin(e.target.value)}
              placeholder="VIN (17 chars)"
              style={{
                padding: "8px 12px",
                border: `1.5px solid ${vinReady ? C.gn : C.bd}`,
                borderRadius: 10,
                fontFamily: "JetBrains Mono",
                fontSize: 14,
                width: 220,
                letterSpacing: 1,
                outline: "none",
              }}
            />
            <Btn
              color={C.tm}
              outline
              onClick={() => setShowJobPanel((v) => !v)}
              data-testid="workflow-toggle-job-panel"
            >
              {showJobPanel ? "▲ HIDE JOBS" : "▼ SAVE / HISTORY"}
            </Btn>
          </div>
        </div>

        {error && (
          <div
            data-testid="workflow-error"
            style={{
              marginTop: 10,
              padding: "8px 12px",
              background: C.er + "12",
              border: `1px solid ${C.er}33`,
              borderRadius: 8,
              color: C.er,
              fontSize: 12,
            }}
          >
            {error}
          </div>
        )}

        {/* ── Collapsible job panel ── */}
        {showJobPanel && (
          <div
            style={{
              marginTop: 14,
              paddingTop: 14,
              borderTop: `1px solid ${C.bd}`,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <div style={{ fontSize: 11, letterSpacing: 1.5, color: C.tm, fontWeight: 800, flex: 1 }}>
                VEHICLE JOB — optional, for sign-off &amp; audit history
              </div>
              {job && (
                <span style={{ fontSize: 11, color: C.ts }}>
                  Active: <strong style={{ color: C.tx }}>{job.title || job.id}</strong> · {job.status}
                </span>
              )}
              <Btn
                color={C.sr}
                onClick={handleCreateJob}
                disabled={!!busy || !vinReady}
                data-testid="workflow-create-job"
              >
                {busy === "creating" ? "…" : "+ NEW JOB"}
              </Btn>
            </div>
            {jobs.length > 0 && (
              <div style={{ display: "grid", gap: 6 }}>
                {jobs.slice(0, 8).map((j) => (
                  <div
                    key={j.id}
                    data-testid={`job-row-${j.id}`}
                    style={{
                      display: "flex",
                      gap: 10,
                      alignItems: "center",
                      border: `1px solid ${j.id === jobId ? C.sr : C.bd}`,
                      borderRadius: 10,
                      padding: "8px 12px",
                      background: j.id === jobId ? C.sr + "08" : C.cd,
                    }}
                  >
                    <div style={{ fontFamily: "JetBrains Mono", fontSize: 12, minWidth: 200 }}>
                      {j.vin}
                    </div>
                    <div style={{ flex: 1, fontSize: 11, color: C.ts }}>
                      {j.title || j.id} · {j.status}
                    </div>
                    <div style={{ fontSize: 10, color: C.tm }}>{fmtTs(j.updatedAt)}</div>
                    <Btn color={C.a3} outline onClick={() => handleSelectJob(j.id)}>
                      OPEN
                    </Btn>
                    <Btn color={C.er} outline onClick={() => handleDeleteJob(j.id)}>
                      DELETE
                    </Btn>
                  </div>
                ))}
              </div>
            )}
            {jobs.length === 0 && (
              <div style={{ fontSize: 12, color: C.tm }}>No saved jobs yet.</div>
            )}
          </div>
        )}
      </Card>

      {/* ── VIN + SECURITY READINESS CARD ── */}
      {hasFiles && (() => {
        const bcmDump = loadedDumps.find(d => d.type === 'BCM');
        const rfhDump = loadedDumps.find(d => d.type === 'RFHUB' || d.type === 'XC2268_RFHUB');
        const pcmDump = loadedDumps.find(d => d.type === 'GPEC2A');
        const bcmMod = bcmDump?.mod;
        const rfhMod = rfhDump?.mod;
        const pcmMod = pcmDump?.mod;
        const bcmVin = bcmMod?.vin || null;
        const rfhVin = rfhMod?.vin || null;
        const pcmVin = pcmMod?.vin || null;
        const loadedVins = [bcmVin, rfhVin, pcmVin].filter(Boolean);
        const vinConsensus = loadedVins.length > 0 && loadedVins.every(v => v === loadedVins[0]) ? loadedVins[0] : null;
        const vinHasMismatch = loadedVins.length >= 2 && !loadedVins.every(v => v === loadedVins[0]);
        const vinMatchesTarget = vinReady && vinConsensus && vinConsensus === vin;
        const vinBorderColor = vinHasMismatch ? C.er : vinMatchesTarget ? C.gn : C.wn;
        const modules = [
          {label: 'BCM', mod: bcmMod, vin: bcmVin, accent: C.sr},
          {label: 'RFHUB', mod: rfhMod, vin: rfhVin, accent: C.a2},
          {label: 'PCM', mod: pcmMod, vin: pcmVin, accent: C.a4 || C.wn},
        ];
        return (
          <Card data-testid="workflow-vin-security-card" style={{borderLeft: `5px solid ${vinBorderColor}`}}>
            <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 10}}>
              <div style={{fontFamily: "'Righteous'", fontSize: 14, color: vinBorderColor, letterSpacing: 1}}>
                {vinHasMismatch ? '⛔ VIN MISMATCH ACROSS MODULES' : vinMatchesTarget ? '✅ VIN MATCH — ALL MODULES' : '⚠ VIN STATUS'}
              </div>
              {vinConsensus && (
                <span style={{fontFamily: "'JetBrains Mono'", fontSize: 12, color: '#fff', fontWeight: 800}}>{vinConsensus}</span>
              )}
              {vinReady && !vinMatchesTarget && vinConsensus && (
                <span style={{fontSize: 10, color: C.wn, fontWeight: 700}}>Target: {vin}</span>
              )}
            </div>
            <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 8}}>
              {modules.map(({label, mod, vin: mVin, accent}) => {
                const loaded = !!mod;
                const vinMatch = mVin && vinConsensus ? mVin === vinConsensus : null;
                const col = mVin ? (vinMatch === false ? C.er : vinMatch === true ? C.gn : C.ts) : C.tm;
                return (
                  <div key={label} style={{padding: '7px 9px', borderRadius: 7, background: '#1a1a1a', border: `1px solid ${accent}33`}}>
                    <div style={{fontSize: 9, fontWeight: 800, color: accent, letterSpacing: 1, marginBottom: 3}}>{label}</div>
                    <div style={{fontFamily: "'JetBrains Mono'", fontSize: 10, color: col, fontWeight: 700, wordBreak: 'break-all'}}>
                      {mVin || <span style={{color: C.tm, fontStyle: 'italic'}}>{loaded ? 'no VIN' : 'not loaded'}</span>}
                    </div>
                    {mVin && vinConsensus && (
                      <div style={{fontSize: 8, marginTop: 2, color: col, fontWeight: 800}}>
                        {mVin === vinConsensus ? '✓ MATCH' : '✗ MISMATCH'}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {vinHasMismatch && (
              <div style={{marginTop: 8, fontSize: 10, color: C.er, fontWeight: 700}}>
                ⚠ VINs do not match — open <strong>SECURITY SYNC</strong> tab to write VIN + fix security bytes in one click.
              </div>
            )}
            {!vinHasMismatch && !vinMatchesTarget && vinReady && loadedVins.length > 0 && (
              <div style={{marginTop: 8, fontSize: 10, color: C.wn, fontWeight: 700}}>
                ⚠ Loaded module VINs differ from target VIN ({vin}) — open <strong>VIN PROGRAMMER</strong> to write the target VIN.
              </div>
            )}
          </Card>
        );
      })()}

      {/* ── MODULE CENSUS — always live ── */}
      <Card>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 10,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 900, letterSpacing: 1 }}>MODULE CENSUS</div>
          <span
            style={{
              fontSize: 10,
              color: C.tm,
              border: `1px solid ${C.bd}`,
              borderRadius: 6,
              padding: "2px 8px",
            }}
          >
            {census.summary.ok} ok · {census.summary.mismatch} mismatch ·{" "}
            {census.summary.missing} missing · {census.summary.extra} extra
            {census.summary.corrupt ? ` · ${census.summary.corrupt} corrupt` : ""}
          </span>
        </div>
        {census.rows.length === 0 ? (
          <div
            style={{
              padding: "14px 16px",
              borderRadius: 10,
              background: C.tm + "0A",
              border: `1px dashed ${C.bd}`,
              fontSize: 12,
              color: C.tm,
              textAlign: "center",
            }}
          >
            Drop module dumps in the <strong>DUMPS</strong> tab — the census and fix plan
            will populate automatically here.
          </div>
        ) : (
          census.rows.map((r) => <CensusRow key={r.code + (r.dump?.hash || "")} row={r} />)
        )}
      </Card>

      {/* ── FIX PLAN — always live, no job required ── */}
      <Card>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 10,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 900, letterSpacing: 1 }}>FIX PLAN</div>
          <span
            style={{
              fontSize: 10,
              color: C.tm,
              border: `1px solid ${C.bd}`,
              borderRadius: 6,
              padding: "2px 8px",
            }}
          >
            {plan.steps.length} steps · {plan.blockers.length} blockers
          </span>
          <div style={{ flex: 1 }} />
          {job?.id && (
            <Btn color={C.a3} outline onClick={handleSavePlan} disabled={!!busy}>
              {busy === "saving" ? "…" : "💾 SAVE PLAN"}
            </Btn>
          )}
        </div>
        {plan.blockers.length > 0 && (
          <div
            data-testid="fix-plan-blockers"
            style={{
              marginBottom: 10,
              padding: "8px 12px",
              background: C.wn + "12",
              border: `1px solid ${C.wn}33`,
              borderRadius: 8,
              fontSize: 12,
              color: C.tx,
            }}
          >
            <strong>Blockers:</strong> {plan.blockers.join(" · ")}
          </div>
        )}
        {plan.steps.length === 0 ? (
          <div
            style={{
              padding: "14px 16px",
              borderRadius: 10,
              background: census.rows.length === 0 ? C.tm + "0A" : C.gn + "0A",
              border: `1px dashed ${census.rows.length === 0 ? C.bd : C.gn + "44"}`,
              fontSize: 12,
              color: census.rows.length === 0 ? C.tm : C.gn,
              textAlign: "center",
              fontWeight: census.rows.length === 0 ? 400 : 700,
            }}
          >
            {census.rows.length === 0
              ? "Plan is empty — load module dumps and the runner will populate it automatically."
              : "✓ No fixes needed — module set is consistent."}
          </div>
        ) : (
          plan.steps.map((s) => (
            <StepRow
              key={s.id}
              step={s}
              result={results[s.id]}
              onMark={handleMarkStep}
              onOpenTab={handleOpenTab}
            />
          ))
        )}
      </Card>

      <Sec16SyncHistoryCard />

      <ChipBurnAuditCard />

      {/* ── SIGN-OFF — requires a saved job ── */}
      <Card>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 10,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 900, letterSpacing: 1 }}>SIGN-OFF</div>
          <div style={{ flex: 1 }} />
          {job?.id && (
            <Btn
              color={C.sr}
              outline
              onClick={handleExportPDF}
              disabled={pdfBusy}
              data-testid="workflow-export-pdf"
            >
              {pdfBusy ? "⏳ Generating…" : "⬇ EXPORT PDF REPORT"}
            </Btn>
          )}
          {job?.id && (
            <Btn
              color={C.gn}
              onClick={handleSignOff}
              disabled={!!busy}
              data-testid="workflow-signoff"
            >
              {busy === "signing" ? "…" : "📝 GENERATE SIGN-OFF"}
            </Btn>
          )}
          {!job?.id && (
            <Btn
              color={C.tm}
              outline
              onClick={() => setShowJobPanel(true)}
              data-testid="workflow-signoff-prompt"
            >
              Save a job first to sign off →
            </Btn>
          )}
        </div>
        {pdfToast && (
          <div
            style={{
              marginBottom: 8,
              padding: "6px 12px",
              background: pdfToast.startsWith("PDF export failed")
                ? C.er + "12"
                : C.gn + "12",
              border: `1px solid ${pdfToast.startsWith("PDF export failed") ? C.er : C.gn}33`,
              borderRadius: 8,
              color: pdfToast.startsWith("PDF export failed") ? C.er : C.gn,
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            {pdfToast}
          </div>
        )}
        {signOff ? (
          <div data-testid="workflow-signoff-summary">
            <div style={{ fontSize: 12, color: C.ts, marginBottom: 8 }}>
              {signOff.ready ? (
                <span style={{ color: C.gn, fontWeight: 800 }}>✓ READY</span>
              ) : (
                <span style={{ color: C.er, fontWeight: 800 }}>⚠ BLOCKED</span>
              )}{" "}
              · {signOff.totals.completed}/{signOff.totals.total} steps complete ·{" "}
              {signOff.totals.failed} failed · {signOff.totals.skipped} skipped
            </div>
            <pre
              style={{
                background: C.bg,
                padding: 12,
                borderRadius: 10,
                fontSize: 11,
                overflowX: "auto",
                color: C.tx,
                fontFamily: "JetBrains Mono",
              }}
            >
              {JSON.stringify(signOff, null, 2)}
            </pre>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: C.tm }}>
            {job?.id
              ? 'Run the plan, then click "Generate Sign-Off" to persist a summary to the job.'
              : "Create a job (▼ SAVE / HISTORY) to enable sign-off and PDF export."}
          </div>
        )}
      </Card>
    </div>
  );
}
