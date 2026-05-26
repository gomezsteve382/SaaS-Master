"""
UDS session analyzer — parses a J2534 / CAN trace, reconstructs UDS
request/response pairs, decodes negative responses, and flags exactly where a
procedure (e.g. RF Hub Replacement) breaks.

This is the live-session counterpart to the dump swarm. Input is a TEXT log of
CAN frames or a tool's UDS trace; output is a per-request verdict and a
session-level diagnosis.

Supported input shapes (auto-detected per line):
  1. Raw CAN hex:   "18DA40F1 03 22 F1 90"        (id then bytes)
  2. Timestamped:   "12.345  TX  18DA40F1  03 22 F1 90"
  3. Tool style:    "[Req] 22 F1 90"  / "[Resp] 62 F1 90 ..."
  4. ISO-TP already-assembled service lines.

If your tool's format differs, the per-line regexes in `parse_line` are the
only thing to adjust.
"""
from __future__ import annotations
import re
from dataclasses import dataclass, field
from typing import Any


# ---- UDS reference ---------------------------------------------------------
UDS_SERVICES = {
    0x10: "DiagnosticSessionControl",
    0x11: "ECUReset",
    0x14: "ClearDTC",
    0x19: "ReadDTCInformation",
    0x22: "ReadDataByIdentifier",
    0x23: "ReadMemoryByAddress",
    0x27: "SecurityAccess",
    0x28: "CommunicationControl",
    0x2E: "WriteDataByIdentifier",
    0x2F: "InputOutputControl",
    0x31: "RoutineControl",
    0x34: "RequestDownload",
    0x36: "TransferData",
    0x37: "RequestTransferExit",
    0x3E: "TesterPresent",
    0x85: "ControlDTCSetting",
}

# Negative Response Codes — the heart of "command not working"
NRC = {
    0x10: ("generalReject", "ECU rejected the request outright; usually wrong state/sequence."),
    0x11: ("serviceNotSupported", "ECU does not support this service in the current mode."),
    0x12: ("subFunctionNotSupported", "Sub-function byte is wrong for this service."),
    0x13: ("incorrectMessageLengthOrInvalidFormat", "Request length/format is malformed."),
    0x21: ("busyRepeatRequest", "ECU busy; retry. Often transient on a loaded bus."),
    0x22: ("conditionsNotCorrect", "Preconditions not met (session, ignition/RUN, voltage, other modules)."),
    0x24: ("requestSequenceError", "Step out of order — e.g. routine before SecurityAccess unlock."),
    0x31: ("requestOutOfRange", "DID/RID/parameter not valid for this ECU."),
    0x33: ("securityAccessDenied", "Not unlocked, or unlocked at the wrong level for this op."),
    0x35: ("invalidKey", "SecurityAccess key calculation is wrong."),
    0x36: ("exceededNumberOfAttempts", "Too many bad keys — ECU is now locked out."),
    0x37: ("requiredTimeDelayNotExpired", "Lockout/delay timer active; must wait before retry."),
    0x70: ("uploadDownloadNotAccepted", "ECU refused the download/transfer setup."),
    0x72: ("generalProgrammingFailure", "Write/erase to ECU memory failed."),
    0x73: ("wrongBlockSequenceCounter", "TransferData block counter mismatch."),
    0x78: ("requestCorrectlyReceived-ResponsePending", "ECU is working; will answer shortly. Repeated 0x78s then silence = tool timeout."),
    0x7E: ("subFunctionNotSupportedInActiveSession", "Need a different diagnostic session for this sub-function."),
    0x7F: ("serviceNotSupportedInActiveSession", "Need a different diagnostic session for this service."),
}


@dataclass
class Frame:
    line_no: int
    ts: float | None
    direction: str | None   # TX/RX/Req/Resp/None
    can_id: str | None
    payload: bytes
    raw: str


@dataclass
class UdsMsg:
    """An assembled UDS message (service-level)."""
    is_response: bool
    is_negative: bool
    service: int            # requested SID (for neg resp, the echoed SID)
    sub: int | None
    nrc: int | None
    frame: Frame


# ---- Parsing ---------------------------------------------------------------
_HEXBYTE = r"[0-9A-Fa-f]{2}"

def _bytes_from(s: str) -> bytes:
    toks = re.findall(_HEXBYTE, s)
    try:
        return bytes(int(t, 16) for t in toks)
    except ValueError:
        return b""


def parse_line(line_no: int, line: str) -> Frame | None:
    raw = line.rstrip("\n")
    if not raw.strip() or raw.lstrip().startswith(("#", "//", ";")):
        return None

    ts = None
    direction = None
    can_id = None

    m_ts = re.match(r"\s*(\d+\.\d+)\s+", raw)
    if m_ts:
        ts = float(m_ts.group(1))
    m_dir = re.search(r"\b(TX|RX|Tx|Rx|Req|Resp|REQUEST|RESPONSE)\b", raw)
    if m_dir:
        d = m_dir.group(1).upper()
        direction = "TX" if d in ("TX", "REQ", "REQUEST") else "RX"
    m_id = re.search(r"\b(1[8]?[0-9A-Fa-f]{6,7})\b", raw)  # 29-bit diag IDs like 18DA40F1
    if m_id:
        can_id = m_id.group(1).upper()

    # bytes = everything after any id; if no id, all hex tokens on the line
    body = raw
    if can_id:
        body = raw[raw.find(can_id) + len(can_id):]
    payload = _bytes_from(body)
    if not payload:
        return None
    return Frame(line_no=line_no, ts=ts, direction=direction, can_id=can_id, payload=payload, raw=raw)


def isotp_service_bytes(payload: bytes) -> bytes:
    """Strip a single-frame ISO-TP PCI if present.
    SF: first nibble 0x0, low nibble = length. Multi-frame reassembly is
    out of scope for this first pass (most diag requests are single-frame)."""
    if not payload:
        return payload
    pci = payload[0]
    if (pci & 0xF0) == 0x00:  # single frame
        length = pci & 0x0F
        return payload[1:1 + length] if length else payload[1:]
    return payload  # already service-level, or FF/CF — handled by caller


def to_uds(frame: Frame) -> UdsMsg | None:
    sd = isotp_service_bytes(frame.payload)
    if not sd:
        return None
    b0 = sd[0]
    if b0 == 0x7F:  # negative response: 7F <sid> <nrc>
        sid = sd[1] if len(sd) > 1 else 0
        nrc = sd[2] if len(sd) > 2 else 0
        return UdsMsg(is_response=True, is_negative=True, service=sid, sub=None, nrc=nrc, frame=frame)
    if b0 >= 0x40 and (b0 - 0x40) in UDS_SERVICES:  # positive response
        return UdsMsg(is_response=True, is_negative=False, service=b0 - 0x40,
                      sub=sd[1] if len(sd) > 1 else None, nrc=None, frame=frame)
    if b0 in UDS_SERVICES:  # request
        return UdsMsg(is_response=False, is_negative=False, service=b0,
                      sub=sd[1] if len(sd) > 1 else None, nrc=None, frame=frame)
    return None


def parse_log(text: str) -> list[UdsMsg]:
    msgs: list[UdsMsg] = []
    for i, line in enumerate(text.splitlines(), 1):
        fr = parse_line(i, line)
        if fr:
            m = to_uds(fr)
            if m:
                msgs.append(m)
    return msgs
