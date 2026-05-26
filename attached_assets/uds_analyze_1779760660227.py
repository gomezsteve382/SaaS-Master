"""
UDS session analyzer — turns a parsed trace into a verdict.

Pairs each request with its response, classifies every failure with the decoded
NRC + a plain-English cause, detects the response-pending timeout pattern, and
produces a session-level diagnosis of where a procedure breaks.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any

from parsers.uds_parser import (
    UdsMsg, UDS_SERVICES, NRC, parse_log,
)


@dataclass
class Exchange:
    req: UdsMsg | None
    resp: UdsMsg | None
    verdict: str
    detail: str
    severity: str  # ok | warn | fail


def _svc(sid: int) -> str:
    return UDS_SERVICES.get(sid, f"0x{sid:02X}")


def pair_and_judge(msgs: list[UdsMsg]) -> list[Exchange]:
    out: list[Exchange] = []
    pending_req: UdsMsg | None = None
    pending_78_count = 0

    for m in msgs:
        if not m.is_response:
            # new request; if a prior request had no response, flag the silence
            if pending_req is not None:
                out.append(Exchange(
                    req=pending_req, resp=None, severity="fail",
                    verdict="NO RESPONSE (timeout)",
                    detail=f"{_svc(pending_req.service)} sent, ECU never answered before next request. "
                           f"{'Saw '+str(pending_78_count)+'x ResponsePending(0x78) then silence — tool P2* timeout too short, or ECU stalled mid-operation.' if pending_78_count else 'Total silence — wrong CAN ID, ECU not on bus, or no session.'}",
                ))
            pending_req = m
            pending_78_count = 0
            continue

        # a response
        if m.is_negative:
            name, cause = NRC.get(m.nrc or 0, (f"NRC 0x{(m.nrc or 0):02X}", "Unknown negative response code."))
            if m.nrc == 0x78:
                pending_78_count += 1
                # 0x78 is not terminal; keep waiting for the real answer
                continue
            out.append(Exchange(
                req=pending_req, resp=m, severity="fail",
                verdict=f"NEGATIVE: {name} (0x{m.nrc:02X})",
                detail=f"{_svc(m.service)} rejected — {cause}",
            ))
            pending_req = None
            pending_78_count = 0
        else:
            out.append(Exchange(
                req=pending_req, resp=m, severity="ok",
                verdict=f"OK: {_svc(m.service)} positive",
                detail=f"{_svc(m.service)} responded positively"
                       + (f" after {pending_78_count}x ResponsePending" if pending_78_count else ""),
            ))
            pending_req = None
            pending_78_count = 0

    if pending_req is not None:
        out.append(Exchange(
            req=pending_req, resp=None, severity="fail",
            verdict="NO RESPONSE (end of log)",
            detail=f"{_svc(pending_req.service)} was the last thing sent and got no answer. "
                   f"{'Saw '+str(pending_78_count)+'x ResponsePending then the log ends — this is your timeout: ECU was still working when the tool gave up.' if pending_78_count else 'No response captured.'}",
        ))
    return out


def diagnose_session(exchanges: list[Exchange]) -> dict[str, Any]:
    """Session-level reasoning: where did the procedure break, and why."""
    findings: list[str] = []
    next_steps: list[str] = []

    # Track security access state
    saw_security_request = any(e.req and e.req.service == 0x27 for e in exchanges)
    security_unlocked = any(
        e.resp and not e.resp.is_negative and e.resp.service == 0x27 and (e.req and e.req.sub and e.req.sub % 2 == 0)
        for e in exchanges
    )
    # Look for the operative failure
    first_fail = next((e for e in exchanges if e.severity == "fail"), None)

    # Sequence check: routine/write before security unlock
    for e in exchanges:
        if e.req and e.req.service in (0x31, 0x2E, 0x34) and not security_unlocked:
            if saw_security_request:
                findings.append(f"{_svc(e.req.service)} attempted but SecurityAccess never completed an unlock first.")
            else:
                findings.append(f"{_svc(e.req.service)} attempted with no SecurityAccess at all — secured op will be denied.")
            break

    if first_fail and first_fail.resp and first_fail.resp.is_negative:
        nrc = first_fail.resp.nrc
        sid = first_fail.resp.service
        if nrc == 0x78:
            pass  # handled as timeout, not here
        elif nrc == 0x33:
            findings.append("SecurityAccess denied at the operative step — session not unlocked or unlocked at wrong level.")
            next_steps.append("Confirm SecurityAccess completed (seed -> key -> positive 0x67) at the level this routine needs, in the SAME session.")
        elif nrc == 0x35:
            findings.append("Invalid key — the seed->key calculation is wrong for this ECU/algorithm.")
            next_steps.append("Verify the key algorithm/secret used to answer the seed matches this module variant.")
        elif nrc == 0x36:
            findings.append("Locked out — too many invalid key attempts.")
            next_steps.append("Power-cycle / wait out the lockout, then retry with the correct key.")
        elif nrc == 0x37:
            findings.append("Required time delay not expired — lockout timer active.")
            next_steps.append("Wait the delay (often 10 min) before the next SecurityAccess attempt.")
        elif nrc == 0x22:
            findings.append("Conditions not correct — a precondition for the operation isn't satisfied.")
            next_steps.append("Check session type, ignition/RUN state, voltage, and whether other required modules are present/answering.")
        elif nrc == 0x24:
            findings.append("Request sequence error — a step was done out of order.")
            next_steps.append("Re-run the procedure in order: session -> SecurityAccess -> routine. Don't skip the unlock.")
        elif nrc == 0x31:
            findings.append("Request out of range — the DID/RID/parameter isn't valid for this module.")
            next_steps.append("Confirm the routine/DID identifier matches this exact module variant.")
        elif nrc == 0x72:
            findings.append("General programming failure — the write to the module failed.")
            next_steps.append("Check voltage stability and that the module isn't in a protected/secure state blocking writes.")

    # Timeout pattern
    timeouts = [e for e in exchanges if "NO RESPONSE" in e.verdict]
    if timeouts:
        t = timeouts[0]
        if "ResponsePending" in t.detail:
            findings.append("Timeout AFTER ResponsePending(0x78): the ECU was actively working and the tool gave up too early.")
            next_steps.append("Increase the tool's P2*/extended timeout; the operation may complete if allowed more time. If on a bench, the routine may also be waiting on a network state the bench can't provide.")
        else:
            findings.append("Timeout with NO response at all: link/addressing problem, not a logic problem.")
            next_steps.append("Verify CAN IDs (tester/ECU), bus wiring/termination, that a diagnostic session was opened (0x10), and TesterPresent (0x3E) is keeping it alive.")

    if not findings:
        findings.append("No negative responses or timeouts detected in the parsed exchanges.")

    return {
        "security_access_seen": saw_security_request,
        "security_unlocked": security_unlocked,
        "first_failure": (first_fail.verdict if first_fail else None),
        "findings": findings,
        "recommended_next_steps": list(dict.fromkeys(next_steps)),  # dedupe, keep order
    }


def analyze_text(text: str) -> dict[str, Any]:
    msgs = parse_log(text)
    exchanges = pair_and_judge(msgs)
    diag = diagnose_session(exchanges)
    return {
        "messages_parsed": len(msgs),
        "exchanges": [
            {"verdict": e.verdict, "detail": e.detail, "severity": e.severity,
             "req": (f"{_svc(e.req.service)}" + (f" sub=0x{e.req.sub:02X}" if e.req and e.req.sub is not None else "")) if e.req else None}
            for e in exchanges
        ],
        "diagnosis": diag,
    }
