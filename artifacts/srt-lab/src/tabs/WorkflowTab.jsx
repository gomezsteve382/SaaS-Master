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
  };
  const color = palette[row.kind] || C.tm;
  return (
    <div
      data-testid={`census-row-${row.code}`}
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

export default function WorkflowTab({ onOpenTab } = {}) {
  const ctx = useContext(MasterVinContext);
  const { vin, setVin, loadedDumps, setPg, jobId, setJobId, hydrateFromJob } = ctx;
  // onOpenTab (passed by VehicleWorkspace) takes priority over the legacy
  // setPg slot on the master context — App.jsx wires VehicleWorkspace's
  // setTab through the prop so the navigation actually changes tabs.
  const goTab = typeof onOpenTab === "function" ? onOpenTab : setPg;
  const [jobs, setJobs] = useState([]);
  const [job, setJob] = useState(null);
  const [results, setResults] = useState({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [signOff, setSignOff] = useState(null);

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
          // The runner UI keeps local state even if the audit log fails;
          // surface the error but don't roll back.
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

  return (
    <div data-testid="workflow-tab" style={{ display: "grid", gap: 16 }}>
      <Card>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div
              style={{
                fontSize: 11,
                letterSpacing: 2,
                color: C.tm,
                fontWeight: 800,
              }}
            >
              VEHICLE JOB
            </div>
            <div style={{ fontSize: 18, fontWeight: 900 }}>
              {job ? job.title || job.id : "No job selected"}
            </div>
            <div style={{ fontSize: 11, color: C.tm, marginTop: 4 }}>
              Security source:{" "}
              <strong style={{ color: C.tx }}>LocalAlgoOverJ2534</strong> · Status:{" "}
              <strong style={{ color: C.tx }}>{job?.status || "—"}</strong> · Updated{" "}
              {fmtTs(job?.updatedAt)}
            </div>
          </div>
          <input
            data-testid="workflow-vin-input"
            value={vin}
            onChange={(e) => setVin(e.target.value)}
            placeholder="VIN (17 chars)"
            style={{
              padding: "8px 12px",
              border: `1.5px solid ${C.bd}`,
              borderRadius: 10,
              fontFamily: "JetBrains Mono",
              fontSize: 14,
              width: 220,
              letterSpacing: 1,
            }}
          />
          <Btn
            color={C.sr}
            onClick={handleCreateJob}
            disabled={!!busy || !VIN_RX.test(vin)}
            data-testid="workflow-create-job"
          >
            {busy === "creating" ? "…" : "+ NEW JOB"}
          </Btn>
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
        {jobs.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div
              style={{
                fontSize: 10,
                letterSpacing: 1.5,
                color: C.tm,
                fontWeight: 800,
                marginBottom: 6,
              }}
            >
              RECENT JOBS
            </div>
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
          </div>
        )}
      </Card>

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
          </span>
        </div>
        {census.rows.length === 0 ? (
          <div style={{ fontSize: 12, color: C.tm }}>
            Load module dumps in the DUMPS tab; they'll appear here.
          </div>
        ) : (
          census.rows.map((r) => <CensusRow key={r.code + (r.dump?.hash || "")} row={r} />)
        )}
      </Card>

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
          <div style={{ fontSize: 12, color: C.tm }}>
            Plan is empty — once the census shows mismatches the runner will populate it.
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
            Run the plan, then click "Generate Sign-Off" to persist a summary to the job.
          </div>
        )}
      </Card>
    </div>
  );
}
