#!/usr/bin/env python3
"""
SRT Lab — J2534 HTTP Bridge Daemon  (Topdon / raw-CAN software ISO-TP)
=====================================================================
Local HTTP server that wraps a vendor J2534 PassThru DLL via ctypes and exposes
it to the SRT Lab web app over plain HTTP. Runs on Windows / macOS / Linux with
nothing but the Python 3.8+ standard library — no pip packages required.

Transport: this build connects a RAW CAN channel and performs ISO-TP framing in
software (SF / FF / CF / FC, 64-frame bulk drain, block-size 0) — the sincro
Topdon core. It deliberately does NOT use the adapter's hardware ISO15765 layer,
which on TOPDON adapters returns stale/zero-filled multi-frame reassembly and
truncates VIN / DTC reads. The HTTP surface is unchanged, so the React client
needs no changes: /sendmsg performs the ISO-TP send, /readmsg the ISO-TP receive.
Started without --dll, the daemon auto-discovers a TOPDON (or any) J2534 DLL.

The hosted SRT Lab UI talks to this bridge from the browser via:
    http://127.0.0.1:8765

Endpoints (all return JSON):
    GET  /status        — bridge state, loaded DLL, vendor, fw/api versions, voltage
    POST /open          — PassThruOpen (loads DLL on first call)
    POST /connect       — open RAW CAN channel (ISO15765 request is mapped to CAN)
    POST /disconnect    — PassThruDisconnect
    POST /close         — PassThruClose
    POST /sendmsg       — software ISO-TP send (data is hex UDS payload)
    POST /readmsg       — software ISO-TP receive (reassembled, hex)
    POST /setfilter     — arm/recycle the raw-CAN PASS filter for rx_id
    POST /voltage       — battery voltage via READ_VBATT ioctl

Permissive CORS (Access-Control-Allow-Origin: *) so the hosted web app can call
the daemon directly from the browser.

Usage:
    python3 j2534_bridge.py --dll "C:\\Program Files (x86)\\Autel\\MaxiPC\\MaxiFlashJ2534.dll"
    python3 j2534_bridge.py --dll /path/to/libj2534.so --port 8765 --verbose
    python3 j2534_bridge.py --dll <path> --no-open      # don't auto-open device

See README_J2534_BRIDGE.md for full setup notes.
"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import threading
import time
from ctypes import (
    POINTER,
    Structure,
    byref,
    c_char,
    c_long,
    c_ulong,
    c_void_p,
    create_string_buffer,
)
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ─── J2534 constants ─────────────────────────────────────────────────────────
PROTOCOL_CAN = 5
PROTOCOL_ISO15765 = 6
ISO15765_FRAME_PAD = 0x00000040
CAN_29BIT_ID = 0x00000100
FLOW_CONTROL_FILTER = 3
PASS_FILTER = 1
BLOCK_FILTER = 2
READ_VBATT = 0x03
CLEAR_TX_BUFFER = 0x07
CLEAR_RX_BUFFER = 0x08
CLEAR_MSG_FILTERS = 0x0A

STATUS_NOERROR = 0x00
ERR_TIMEOUT = 0x09        # no frame yet → keep polling, NOT fatal
ERR_BUFFER_EMPTY = 0x10   # no frame yet → keep polling, NOT fatal

# Software ISO-TP flow-control block size. 0 = "module sends ALL consecutive
# frames, no mid-stream FC". This is the value that lets a big multi-frame
# response (VIN, 600+ B DTC lists) complete on a TOPDON adapter: we drain 64 CAN
# frames per ReadMsgs call (fast enough not to overflow the adapter buffer), so a
# non-zero BS that injects mid-stream FC frames would only confuse the module's
# ISO-TP state. (Bench-verified in sincro: BS=0 → 679/679 B + next request OK;
# BS>0 → 678 B + next request FAIL.)
ISOTP_BLOCK_SIZE = 0x00

# Build marker — logged on connect so a run log alone tells you which transport
# is live. This bridge does software ISO-TP over RAW CAN (sincro Topdon core),
# NOT the adapter's hardware ISO15765 layer.
BRIDGE_BUILD = "sw-isotp-rawcan-v1"

# J2534 error codes (subset — full mapping below)
J2534_ERRORS = {
    0x00: ("STATUS_NOERROR", "No error"),
    0x01: ("ERR_NOT_SUPPORTED", "Function not supported by this DLL"),
    0x02: ("ERR_INVALID_CHANNEL_ID", "Invalid channel ID"),
    0x03: ("ERR_INVALID_PROTOCOL_ID", "Invalid protocol ID"),
    0x04: ("ERR_NULL_PARAMETER", "Null parameter passed"),
    0x05: ("ERR_INVALID_IOCTL_VALUE", "Invalid ioctl value"),
    0x06: ("ERR_INVALID_FLAGS", "Invalid flags"),
    0x07: ("ERR_FAILED", "Operation failed"),
    0x08: ("ERR_DEVICE_NOT_CONNECTED", "Device not connected"),
    0x09: ("ERR_TIMEOUT", "Operation timed out"),
    0x0A: ("ERR_INVALID_MSG", "Invalid message"),
    0x0B: ("ERR_INVALID_TIME_INTERVAL", "Invalid time interval"),
    0x0C: ("ERR_EXCEEDED_LIMIT", "Exceeded limit"),
    0x0D: ("ERR_INVALID_MSG_ID", "Invalid message ID"),
    0x0E: ("ERR_DEVICE_IN_USE", "Device in use"),
    0x0F: ("ERR_INVALID_IOCTL_ID", "Invalid ioctl ID"),
    0x10: ("ERR_BUFFER_EMPTY", "Buffer empty (no msgs available)"),
    0x11: ("ERR_BUFFER_FULL", "Buffer full"),
    0x12: ("ERR_BUFFER_OVERFLOW", "Buffer overflow"),
    0x13: ("ERR_PIN_INVALID", "Invalid pin"),
    0x14: ("ERR_CHANNEL_IN_USE", "Channel in use"),
    0x15: ("ERR_MSG_PROTOCOL_ID", "Message protocol ID mismatch"),
    0x16: ("ERR_INVALID_FILTER_ID", "Invalid filter ID"),
    0x17: ("ERR_NO_FLOW_CONTROL", "No flow control"),
    0x18: ("ERR_NOT_UNIQUE", "Filter not unique"),
    0x19: ("ERR_INVALID_BAUDRATE", "Invalid baud rate"),
    0x1A: ("ERR_INVALID_DEVICE_ID", "Invalid device ID"),
}

# Vendor detection — substrings looked for in the DLL path.
VENDOR_HINTS = [
    ("Topdon",          ("topdon", "artidiag", "rlink", "passthru464", "passthru432")),
    ("Autel MaxiFlash", ("autel", "maxiflash", "maxipc", "maxisys")),
    ("Drew Tech",       ("drewtech", "drew_tech", "cardaq")),
    ("OBDLink",         ("obdlink", "scantool")),
    ("Tactrix",         ("tactrix", "openport")),
    ("Bosch",           ("bosch", "mvci")),
]


def vendor_for(dll_path: str) -> str:
    if not dll_path:
        return "Unknown"
    needle = dll_path.lower()
    for name, hints in VENDOR_HINTS:
        if any(h in needle for h in hints):
            return name
    return "Generic J2534"


# ─── Topdon / J2534 DLL auto-discovery ───────────────────────────────────────
# Started without --dll, the bridge scans the Windows J2534 registry and the
# common TOPDON install paths so a tech can just plug the cable in. Ported from
# sincro/device/j2534_registry.py, trimmed to the discovery essentials.

_PASSTHRU_REG_BASES = (
    r"SOFTWARE\PassThruSupport.04.04",
    r"SOFTWARE\WOW6432Node\PassThruSupport.04.04",
)
COMMON_TOPDON_PATHS_64 = (
    r"C:\Program Files (x86)\TOPDON\ArtiDiagVci\PassThru464.dll",
    r"C:\Program Files\TOPDON\ArtiDiagVci\PassThru464.dll",
    r"C:\Program Files (x86)\TOPDON\RLink\PassThru464.dll",
    r"C:\Program Files\TOPDON\RLink\PassThru464.dll",
)
COMMON_TOPDON_PATHS_32 = (
    r"C:\Program Files (x86)\TOPDON\ArtiDiagVci\PassThru432.dll",
    r"C:\Program Files (x86)\TOPDON\RLink\PassThru432.dll",
)


def _python_bits() -> int:
    import struct as _s
    return 64 if _s.calcsize("P") * 8 == 64 else 32


def _pe_bits(path: str):
    """PE machine field → 32 or 64, else None. A 32-bit DLL cannot load into
    64-bit Python (and vice-versa), so we use this to reject mismatches early."""
    try:
        import struct as _s
        with open(path, "rb") as f:
            dos = f.read(64)
            if len(dos) < 64 or dos[:2] != b"MZ":
                return None
            pe_off = _s.unpack_from("<I", dos, 0x3C)[0]
            f.seek(pe_off)
            if f.read(4) != b"PE\x00\x00":
                return None
            machine = _s.unpack("<H", f.read(2))[0]
            if machine == 0x014C:
                return 32
            if machine == 0x8664:
                return 64
    except Exception:
        return None
    return None


def _reg_read(key, names):
    import winreg
    for n in names:
        try:
            v, _ = winreg.QueryValueEx(key, n)
            if v and str(v).strip():
                return str(v).strip().strip('"')
        except OSError:
            continue
    return ""


def _topdon_dll_fix(text: str, dll: str, bits: int) -> str:
    """For a TOPDON entry, prefer the DLL that matches our Python bitness
    (PassThru464.dll for 64-bit, PassThru432.dll for 32-bit)."""
    if not any(k in text for k in ("topdon", "artidiag", "rlink")) or not dll:
        return dll
    base = os.path.basename(dll).lower()
    if bits == 64 and base == "passthru432.dll":
        cand = os.path.join(os.path.dirname(dll), "PassThru464.dll")
        if os.path.isfile(cand):
            return cand
    if bits == 32 and base == "passthru464.dll":
        cand = os.path.join(os.path.dirname(dll), "PassThru432.dll")
        if os.path.isfile(cand):
            return cand
    return dll


def discover_j2534_dll(prefer_topdon: bool = True):
    """Return (dll_path, friendly_name) for the best J2534 adapter, or (None, None).
    Scans the registry (native + WOW64 views + WOW6432Node) plus the TOPDON
    fallback paths, keeps only DLLs whose PE bitness matches this Python, and
    ranks TOPDON first."""
    if sys.platform != "win32":
        return (None, None)
    import winreg
    bits = _python_bits()
    found = []  # (dll_path, name)

    views = [0]
    for flag in ("KEY_WOW64_64KEY", "KEY_WOW64_32KEY"):
        fv = getattr(winreg, flag, None)
        if fv is not None:
            views.append(int(fv))

    dll_order = (
        ("FunctionLibrary64", "Library64", "FunctionLibrary", "Library", "FunctionLibrary32", "Library32")
        if bits == 64 else
        ("FunctionLibrary32", "Library32", "FunctionLibrary", "Library", "FunctionLibrary64", "Library64")
    )

    for base in _PASSTHRU_REG_BASES:
        for view in views:
            try:
                access = winreg.KEY_READ | view
                with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, base, 0, access) as bk:
                    n, _, _ = winreg.QueryInfoKey(bk)
                    for i in range(n):
                        try:
                            sub = winreg.EnumKey(bk, i)
                            with winreg.OpenKey(bk, sub, 0, access) as dk:
                                name = _reg_read(dk, ("Name", "DeviceName", "ProductName")) or sub
                                vendor = _reg_read(dk, ("Vendor", "VendorName", "Manufacturer"))
                                dll = _reg_read(dk, dll_order)
                                dll = os.path.expandvars(dll) if dll else dll
                                text = f"{name} {vendor} {dll} {base}".lower().replace("\\", "/")
                                dll = _topdon_dll_fix(text, dll, bits)
                                if dll and os.path.isfile(dll):
                                    found.append((dll, name))
                        except OSError:
                            continue
            except OSError:
                continue

    for p in (COMMON_TOPDON_PATHS_64 if bits == 64 else COMMON_TOPDON_PATHS_32):
        if os.path.isfile(p):
            found.append((p, "TOPDON ArtiDiag / RLink"))

    # Keep only bitness-compatible DLLs (unknown PE = keep, let the load decide).
    compat = [(p, nm) for (p, nm) in found if _pe_bits(p) in (None, bits)]
    if not compat:
        return (None, None)

    def is_topdon(item):
        p, nm = item
        t = (p + " " + nm).lower()
        b = os.path.basename(p).lower()
        return ("topdon" in t or "artidiag" in t or "rlink" in t
                or b in ("passthru464.dll", "passthru432.dll"))

    seen, ranked = set(), []
    for item in sorted(compat, key=lambda it: (0 if (prefer_topdon and is_topdon(it)) else 1)):
        key = os.path.normcase(os.path.abspath(item[0]))
        if key in seen:
            continue
        seen.add(key)
        ranked.append(item)
    return ranked[0] if ranked else (None, None)


# ─── PASSTHRU_MSG ────────────────────────────────────────────────────────────
class PASSTHRU_MSG(Structure):
    _fields_ = [
        ("ProtocolID",     c_ulong),
        ("RxStatus",       c_ulong),
        ("TxFlags",        c_ulong),
        ("Timestamp",      c_ulong),
        ("DataSize",       c_ulong),
        ("ExtraDataIndex", c_ulong),
        ("Data",           ctypes.c_ubyte * 4128),
    ]


# ─── J2534 wrapper ───────────────────────────────────────────────────────────
class J2534Bridge:
    def __init__(self, dll_path: str, verbose: bool = False):
        self.dll_path = dll_path
        self.verbose = verbose
        self.dll = None
        self.device_id = c_ulong(0)
        self.channel_id = c_ulong(0)
        self.filters: list[int] = []
        self.opened = False
        self.connected = False
        self.last_error: str | None = None
        self.lock = threading.Lock()
        self._has_version = False
        # Transport: this bridge speaks software ISO-TP over RAW CAN (sincro
        # Topdon core). We open ProtocolID=CAN and do SF/FF/CF/FC framing here,
        # bypassing the adapter's hardware ISO15765 layer (broken on TOPDON).
        self.protocol_id: int | None = None
        # Addressing learned from /setfilter (overridable per /sendmsg).
        self._tx_id: int | None = None
        self._rx_id: int | None = None
        self._active_pass_rx: int | None = None  # one recycled raw-CAN PASS filter
        # Receive-reassembly state — persisted across /readmsg calls so a big
        # multi-frame response survives being sliced over several HTTP polls.
        self._rx_expected: int | None = None
        self._rx_buf = bytearray()
        self._rx_queue: list[tuple[int, bytes]] = []

    # ── helpers ──
    def _log(self, msg: str) -> None:
        if self.verbose:
            ts = time.strftime("%H:%M:%S")
            print(f"{ts} [bridge] {msg}", flush=True)

    @staticmethod
    def err_text(code: int) -> str:
        name, desc = J2534_ERRORS.get(code, (f"ERR_0x{code:02X}", "Unknown error"))
        return f"{name}: {desc}"

    # ── DLL load + signatures ──
    def load(self) -> None:
        if self.dll is not None:
            return
        if not self.dll_path or not os.path.exists(self.dll_path):
            raise FileNotFoundError(f"J2534 DLL not found: {self.dll_path}")
        loader = ctypes.WinDLL if sys.platform == "win32" else ctypes.CDLL
        self.dll = loader(self.dll_path)

        d = self.dll
        d.PassThruOpen.argtypes = [c_void_p, POINTER(c_ulong)]
        d.PassThruOpen.restype = c_long
        d.PassThruClose.argtypes = [c_ulong]
        d.PassThruClose.restype = c_long
        d.PassThruConnect.argtypes = [c_ulong, c_ulong, c_ulong, c_ulong, POINTER(c_ulong)]
        d.PassThruConnect.restype = c_long
        d.PassThruDisconnect.argtypes = [c_ulong]
        d.PassThruDisconnect.restype = c_long
        d.PassThruReadMsgs.argtypes = [c_ulong, POINTER(PASSTHRU_MSG), POINTER(c_ulong), c_ulong]
        d.PassThruReadMsgs.restype = c_long
        d.PassThruWriteMsgs.argtypes = [c_ulong, POINTER(PASSTHRU_MSG), POINTER(c_ulong), c_ulong]
        d.PassThruWriteMsgs.restype = c_long
        d.PassThruStartMsgFilter.argtypes = [
            c_ulong, c_ulong,
            POINTER(PASSTHRU_MSG), POINTER(PASSTHRU_MSG), POINTER(PASSTHRU_MSG),
            POINTER(c_ulong),
        ]
        d.PassThruStartMsgFilter.restype = c_long
        d.PassThruStopMsgFilter.argtypes = [c_ulong, c_ulong]
        d.PassThruStopMsgFilter.restype = c_long
        d.PassThruIoctl.argtypes = [c_ulong, c_ulong, c_void_p, c_void_p]
        d.PassThruIoctl.restype = c_long
        # PassThruReadVersion is optional on some DLLs
        try:
            d.PassThruReadVersion.argtypes = [c_ulong, c_char * 80, c_char * 80, c_char * 80]
            d.PassThruReadVersion.restype = c_long
            self._has_version = True
        except AttributeError:
            self._has_version = False
        self._log(f"DLL loaded: {self.dll_path}")

    # ── J2534 ops ──
    def open(self) -> None:
        with self.lock:
            self.load()
            if self.opened:
                return
            # The TOPDON RLink frequently returns ERR_DEVICE_NOT_CONNECTED (0x08)
            # on the first PassThruOpen and only opens after a few retries — this
            # is exactly what sincro's run log shows (3 failed opens, then OK).
            # Opening once and giving up leaves a half/no-open handle that reports
            # "connected" but never talks. Retry with a short backoff.
            last = 0
            for attempt in range(6):
                self.device_id = c_ulong(0)
                ret = self.dll.PassThruOpen(None, byref(self.device_id))
                if ret == 0:
                    self.opened = True
                    self._log(f"PassThruOpen → device_id={self.device_id.value} (attempt {attempt + 1})")
                    return
                last = ret
                self._log(f"PassThruOpen attempt {attempt + 1}: {self.err_text(ret)} — retrying")
                time.sleep(0.5)
            raise RuntimeError(self.err_text(last))

    def close(self) -> None:
        with self.lock:
            if self.connected:
                self._disconnect_locked()
            if not self.opened:
                return
            ret = self.dll.PassThruClose(self.device_id)
            self.opened = False
            self.device_id = c_ulong(0)
            self._log(f"PassThruClose ret={ret}")
            if ret != 0:
                raise RuntimeError(self.err_text(ret))

    def connect(self, protocol: int = PROTOCOL_CAN, flags: int = 0, baudrate: int = 500000) -> None:
        """Open a RAW CAN channel. The web client still asks for ISO15765 (the old
        hardware-ISO-TP path); we deliberately connect ProtocolID=CAN instead and
        own the ISO-TP framing in software — that is what makes multi-frame reads
        actually complete on a TOPDON adapter."""
        with self.lock:
            if not self.opened:
                raise RuntimeError("Device not open — call /open first")
            if self.connected:
                return
            # ISO15765/CAN both map to raw CAN; pass anything exotic through verbatim.
            proto = protocol if protocol not in (PROTOCOL_CAN, PROTOCOL_ISO15765) else PROTOCOL_CAN
            ret = self.dll.PassThruConnect(
                self.device_id, c_ulong(proto), c_ulong(0),
                c_ulong(baudrate), byref(self.channel_id),
            )
            if ret != 0:
                raise RuntimeError(self.err_text(ret))
            self.connected = True
            self.protocol_id = proto
            self._active_pass_rx = None
            self._reset_rx()
            self._log(f"PassThruConnect RAW CAN baud={baudrate} → ch={self.channel_id.value} ({BRIDGE_BUILD})")

    def disconnect(self) -> None:
        with self.lock:
            self._disconnect_locked()

    def _disconnect_locked(self) -> None:
        for fid in self.filters:
            try:
                self.dll.PassThruStopMsgFilter(self.channel_id, c_ulong(fid))
            except Exception:
                pass
        self.filters = []
        self._active_pass_rx = None
        self._reset_rx()
        if not self.connected:
            return
        ret = self.dll.PassThruDisconnect(self.channel_id)
        self.connected = False
        self.channel_id = c_ulong(0)
        self.protocol_id = None
        self._log(f"PassThruDisconnect ret={ret}")
        if ret != 0:
            raise RuntimeError(self.err_text(ret))

    def set_filter(self, tx_id: int, rx_id: int) -> int:
        """Raw-CAN mode: remember the tx/rx pair and arm ONE recycled PASS filter
        for rx_id so the device actually delivers the module's frames. (A fresh
        filter per address would exhaust the adapter's small filter pool and then
        silence modules that are physically present — the classic 'scan kills the
        bus' bug.)"""
        with self.lock:
            if not self.connected:
                raise RuntimeError("Channel not connected — call /connect first")
            self._tx_id = int(tx_id)
            self._rx_id = int(rx_id)
            self._reset_rx()
            if self._active_pass_rx != rx_id:
                self._stop_filters_locked()
                fid = self._start_can_pass_filter_locked(rx_id)
                self._active_pass_rx = rx_id
                self._log(f"PASS filter rx=0x{rx_id:X} tx=0x{tx_id:X} fid={fid}")
                return fid if fid is not None else 0
            return self.filters[-1] if self.filters else 0

    def send_msg(self, tx_id: int, data: bytes, flags: int = 0, timeout_ms: int = 1000) -> None:
        """Software ISO-TP SEND over raw CAN. `data` is the raw UDS payload (e.g.
        22 F1 90); WE add the SF/FF framing. The matching response is drained by
        read_msg(). The client's `flags` (hardware ISO15765 pad) is ignored — raw
        CAN framing is computed from the addressing here."""
        with self.lock:
            if not self.connected:
                raise RuntimeError("Channel not connected — call /connect first")
            payload = bytes(data)
            if len(payload) > 4095:
                raise ValueError("ISO-TP payload too large (max 4095 bytes)")
            tx_id = int(tx_id)
            rx_id = self._rx_id if self._rx_id is not None else (tx_id + 8)
            id_flags = CAN_29BIT_ID if (self._is29(tx_id) or self._is29(rx_id)) else 0

            if self._active_pass_rx != rx_id:
                self._stop_filters_locked()
                self._start_can_pass_filter_locked(rx_id)
                self._active_pass_rx = rx_id

            self._ioctl_clear_locked()   # flush stale frames BEFORE we transmit
            self._rx_queue = []
            self._reset_rx()

            if len(payload) <= 7:
                frame = (bytes([len(payload)]) + payload).ljust(8, b"\x00")
                self._write_raw_locked(tx_id, frame, id_flags)
            else:
                self._isotp_send_multiframe_locked(tx_id, rx_id, payload, id_flags, timeout_ms)
            self._log(f"TX 0x{tx_id:X}: {payload.hex()}")

            # Receive the reply NOW, in the same call, so our flow-control follows
            # the module's First Frame with no HTTP gap. Splitting send (/sendmsg)
            # and receive (/readmsg) across round-trips made the module N_Bs-timeout
            # on multi-frame replies (VIN/DTC) while single-frame replies (3E 00)
            # always worked — the exact symptom seen on the bench. Buffer for /readmsg.
            msg = self._receive_one_locked(rx_id, tx_id, id_flags, max(timeout_ms, 1200))
            if msg is not None:
                self._rx_queue.append(msg)

    def read_msg(self, timeout_ms: int = 1000) -> dict | None:
        """Return the reply buffered by send_msg (the receive — including our flow
        control — happens there, in the same call as the send, so it follows the
        module's First Frame with no HTTP gap). Falls back to a short live receive
        if nothing is buffered, covering any async / extra frames."""
        with self.lock:
            if not self.connected:
                raise RuntimeError("Channel not connected — call /connect first")
            if self._rx_queue:
                cid, pl = self._rx_queue.pop(0)
                return {"canId": cid, "data": pl.hex(), "rxStatus": 0, "timestamp": 0}
            rx_id = self._rx_id
            if rx_id is None:
                return None
            tx_id = self._tx_id if self._tx_id is not None else (rx_id - 8)
            id_flags = CAN_29BIT_ID if (self._is29(tx_id) or self._is29(rx_id)) else 0
            msg = self._receive_one_locked(rx_id, tx_id, id_flags, timeout_ms)
            if msg is None:
                return None
            cid, pl = msg
            return {"canId": cid, "data": pl.hex(), "rxStatus": 0, "timestamp": 0}

    def _receive_one_locked(self, rx_id, tx_id, id_flags, timeout_ms):
        """Drain raw CAN and reassemble ONE ISO-TP message at rx_id, sending our
        flow control (30 00 00) the instant a First Frame appears. Skips a
        responsePending (7F xx 78) and keeps waiting for the real answer. Returns
        (can_id, bytes) or None on timeout. Bulk-drains 64 frames/call so a big
        multi-frame reply (e.g. a 679 B DTC list) can't overflow the adapter."""
        self._reset_rx()
        deadline = time.monotonic() + (max(1, timeout_ms) / 1000.0)
        while time.monotonic() < deadline:
            for fid, d in self._read_can_batch_locked(64, 20):
                if fid != rx_id or not d:
                    continue
                pci = d[0] & 0xF0
                if pci == 0x00:  # Single Frame
                    length = d[0] & 0x0F
                    out = bytes(d[1:1 + length])
                    if len(out) >= 3 and out[0] == 0x7F and out[2] == 0x78:
                        continue  # responsePending — keep waiting for the real reply
                    self._log(f"RX 0x{fid:X} SF: {out.hex()}")
                    return (fid, out)
                if pci == 0x10:  # First Frame → send our FC immediately
                    self._rx_expected = ((d[0] & 0x0F) << 8) | d[1]
                    self._rx_buf = bytearray(d[2:8])
                    self._send_fc_locked(tx_id, id_flags)
                    if len(self._rx_buf) >= self._rx_expected:
                        out = bytes(self._rx_buf[:self._rx_expected]); self._reset_rx()
                        return (fid, out)
                    continue
                if pci == 0x20:  # Consecutive Frame
                    if self._rx_expected is None:
                        continue
                    take = min(7, self._rx_expected - len(self._rx_buf))
                    self._rx_buf += d[1:1 + take]
                    if len(self._rx_buf) >= self._rx_expected:
                        out = bytes(self._rx_buf[:self._rx_expected]); self._reset_rx()
                        self._log(f"RX 0x{fid:X} reassembled {len(out)}B: {out.hex()}")
                        return (fid, out)
                    continue
        return None

    # ── software ISO-TP helpers (raw CAN) ──────────────────────────────────────
    @staticmethod
    def _is29(can_id) -> bool:
        return int(can_id or 0) > 0x7FF

    def _reset_rx(self) -> None:
        self._rx_expected = None
        self._rx_buf = bytearray()

    def _ioctl_clear_locked(self) -> None:
        for ioctl_id in (CLEAR_RX_BUFFER, CLEAR_TX_BUFFER):
            try:
                self.dll.PassThruIoctl(self.channel_id, c_ulong(ioctl_id), None, None)
            except Exception:
                pass

    def _stop_filters_locked(self) -> None:
        for fid in list(self.filters):
            try:
                self.dll.PassThruStopMsgFilter(self.channel_id, c_ulong(fid))
            except Exception:
                pass
        self.filters = []
        try:
            self.dll.PassThruIoctl(self.channel_id, c_ulong(CLEAR_MSG_FILTERS), None, None)
        except Exception:
            pass

    def _mk_can_msg(self, can_id: int, payload: bytes, tx_flags: int = 0) -> PASSTHRU_MSG:
        msg = PASSTHRU_MSG()
        msg.ProtocolID = self.protocol_id or PROTOCOL_CAN
        msg.TxFlags = tx_flags
        frame = int(can_id).to_bytes(4, "big") + bytes(payload)
        msg.DataSize = len(frame)
        for i, b in enumerate(frame):
            msg.Data[i] = b
        return msg

    def _start_can_pass_filter_locked(self, rx_id: int):
        """Raw-CAN PASS filter: without it most J2534 devices drop every incoming
        frame. mask = full ID width, pattern = the module's response ID."""
        is29 = self._is29(rx_id)
        id_flags = CAN_29BIT_ID if is29 else 0
        id_mask = 0x1FFFFFFF if is29 else 0x7FF
        mask = self._mk_can_msg(id_mask, b"", id_flags)
        patt = self._mk_can_msg(rx_id, b"", id_flags)
        fid = c_ulong(0)
        ret = self.dll.PassThruStartMsgFilter(
            self.channel_id, c_ulong(PASS_FILTER),
            byref(mask), byref(patt), None, byref(fid),
        )
        if ret != 0:
            self._log(f"PASS filter rx=0x{rx_id:X} failed: {self.err_text(ret)}")
            return None
        self.filters.append(fid.value)
        return fid.value

    def _write_raw_locked(self, can_id: int, payload: bytes, tx_flags: int = 0) -> None:
        msg = self._mk_can_msg(can_id, payload, tx_flags)
        num = c_ulong(1)
        ret = self.dll.PassThruWriteMsgs(self.channel_id, byref(msg), byref(num), c_ulong(100))
        if ret != 0:
            raise RuntimeError(f"WriteMsgs raw: {self.err_text(ret)}")

    def _send_fc_locked(self, tx_id: int, id_flags: int) -> None:
        fc = bytes([0x30, ISOTP_BLOCK_SIZE, 0x00]).ljust(8, b"\x00")  # CTS, BS, STmin=0
        self._write_raw_locked(tx_id, fc, id_flags)

    def _read_can_batch_locked(self, max_frames: int = 64, timeout_ms: int = 40):
        """Read up to max_frames raw CAN frames in ONE ReadMsgs call → list of
        (can_id, payload). Bulk draining keeps a multi-frame burst from
        overflowing the adapter RX buffer (the root cause of VIN/DTC truncation)."""
        arr = (PASSTHRU_MSG * max_frames)()
        num = c_ulong(max_frames)
        ret = self.dll.PassThruReadMsgs(self.channel_id, arr, byref(num), c_ulong(timeout_ms))
        if ret not in (STATUS_NOERROR, ERR_TIMEOUT, ERR_BUFFER_EMPTY):
            return []
        out = []
        for i in range(int(num.value)):
            m = arr[i]
            size = int(m.DataSize)
            if size < 4:
                continue
            raw = bytes(m.Data[:size])
            out.append((int.from_bytes(raw[:4], "big"), raw[4:]))
        return out

    def _isotp_send_multiframe_locked(self, tx_id, rx_id, payload, id_flags, timeout_ms) -> None:
        """Send a >7-byte UDS request: First Frame → wait for the module's Flow
        Control → Consecutive-Frame stream (paced by the module's STmin)."""
        total = len(payload)
        ff = (bytes([0x10 | ((total >> 8) & 0x0F), total & 0xFF]) + payload[:6]).ljust(8, b"\x00")
        self._write_raw_locked(tx_id, ff, id_flags)

        deadline = time.monotonic() + (max(1, timeout_ms) / 1000.0)
        st_min = 0
        got_fc = False
        while time.monotonic() < deadline and not got_fc:
            for fid, d in self._read_can_batch_locked(16, 40):
                if fid == rx_id and d and (d[0] & 0xF0) == 0x30:
                    st_min = d[2] if len(d) > 2 else 0
                    got_fc = True
                    break
        if not got_fc:
            raise RuntimeError("SW-ISOTP: module sent no Flow Control for the write")

        idx, seq = 6, 1
        while idx < total:
            cf = (bytes([0x20 | (seq & 0x0F)]) + payload[idx:idx + 7]).ljust(8, b"\x00")
            self._write_raw_locked(tx_id, cf, id_flags)
            idx += 7
            seq = (seq + 1) & 0x0F
            time.sleep((st_min / 1000.0) if 0 < st_min <= 127 else 0.001)

    def read_voltage(self):
        """Vehicle battery voltage (V) via the J2534 READ_VBATT ioctl (returns mV).
        This is the voltage gate before any module write. None if unreadable."""
        if not self.connected:
            return None
        with self.lock:
            mv = c_ulong(0)
            try:
                ret = self.dll.PassThruIoctl(self.channel_id, c_ulong(READ_VBATT), None, byref(mv))
            except Exception:
                return None
        if ret == 0 and mv.value > 0:
            return round(mv.value / 1000.0, 2)
        return None

    def read_versions(self) -> dict:
        with self.lock:
            if not self.opened or not self._has_version:
                return {"firmware": None, "dll": None, "api": None}
            fw = create_string_buffer(80)
            dll = create_string_buffer(80)
            api = create_string_buffer(80)
            ret = self.dll.PassThruReadVersion(self.device_id, fw, dll, api)
            if ret != 0:
                return {"firmware": None, "dll": None, "api": None,
                        "error": self.err_text(ret)}
            return {
                "firmware": fw.value.decode("ascii", "replace"),
                "dll": dll.value.decode("ascii", "replace"),
                "api": api.value.decode("ascii", "replace"),
            }

    def read_serial(self) -> str | None:
        """Best-effort device serial extraction.

        Vendors expose the serial differently — some embed it in the firmware
        version string ("V1.43 SN:ABC123"), others through a vendor-specific
        PassThruIoctl. We try the version-string parse first since it's safe
        on every DLL, then fall back to a couple of common ioctls."""
        if not self.opened:
            return None
        try:
            v = self.read_versions()
            for s in (v.get("firmware") or "", v.get("dll") or ""):
                u = s.upper().replace("-", " ")
                for tag in ("SN:", "S/N:", "SERIAL:", "SN ", "S/N "):
                    i = u.find(tag)
                    if i >= 0:
                        rest = s[i + len(tag):].strip().split()[0].strip(",;")
                        if rest:
                            return rest
        except Exception:
            pass
        # Vendor ioctl fallback (Autel/Drew use 0x10006 for GET_DEVICE_INFO)
        try:
            buf = create_string_buffer(64)
            for ioctl_id in (0x10006, 0x10007):
                try:
                    ret = self.dll.PassThruIoctl(
                        self.device_id, c_ulong(ioctl_id), None,
                        ctypes.cast(buf, c_void_p),
                    )
                    if ret == 0:
                        s = buf.value.decode("ascii", "replace").strip()
                        if s and s.isprintable():
                            return s
                except Exception:
                    continue
        except Exception:
            pass
        return None

    def status(self) -> dict:
        vendor = vendor_for(self.dll_path)
        return {
            "ok": True,
            "bridgeVersion": "1.0.0",
            "build": BRIDGE_BUILD,
            "transport": "raw-can-sw-isotp",
            "voltage": self.read_voltage() if self.connected else None,
            "platform": platform.system(),
            "pythonVersion": platform.python_version(),
            "dllPath": self.dll_path,
            "dllLoaded": self.dll is not None,
            "vendor": vendor,
            # True for VCIs that can carry FCA Secure Gateway authentication
            # (currently only Autel MaxiFlash). The web client uses this so it
            # doesn't have to string-match the vendor name itself.
            "sgwCapable": "maxiflash" in (self.dll_path or "").lower() or vendor.lower() == "autel maxiflash",
            "deviceOpen": self.opened,
            "channelConnected": self.connected,
            "deviceId": self.device_id.value if self.opened else None,
            "deviceSerial": self.read_serial() if self.opened else None,
            "channelId": self.channel_id.value if self.connected else None,
            "filterCount": len(self.filters),
        }


# ─── Vendored-tool launcher ──────────────────────────────────────────────────

# Resolve the vendor directory relative to this script so it works both when
# run from within artifacts/srt-lab/public/ and from any other cwd.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_VENDOR_ROOT = os.path.normpath(os.path.join(_SCRIPT_DIR, "..", "vendor"))

TOOL_DEFS: dict[str, dict] = {
    "fca-proxi": {
        "name": "FCA PROXI Tool",
        "exe": "FCA_PROXI_Tool.exe",
        "vendor_dir": os.path.join(_VENDOR_ROOT, "fca-proxi"),
        "required_files": [
            "FCA_PROXI_Tool.exe",
            "shfolder.dll",
            "chichitoworkshop.key",
            "license.json",
        ],
    },
    "gpec-unlocker": {
        "name": "GPEC Unlocker",
        "exe": "GPEC_Unlocker.exe",
        "vendor_dir": os.path.join(_VENDOR_ROOT, "gpec-unlocker"),
        "required_files": ["GPEC_Unlocker.exe"],
    },
}


def _load_manifest(vendor_dir: str) -> dict | None:
    path = os.path.join(vendor_dir, "manifest.json")
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _live_hwid() -> str | None:
    """
    Compute the live machine HWID (Windows only) using the same 4-segment
    algorithm documented in tools/fca-proxi-extract/src/hwid.py.
    Returns None on non-Windows platforms or on any error.
    """
    if sys.platform != "win32":
        return None
    import binascii
    import struct
    import uuid

    def _segment(raw: bytes) -> str:
        crc = binascii.crc32(raw) & 0x0FFFFFFF
        return format(crc, "07X")

    try:
        import ctypes as _ct
        import wmi  # type: ignore
        segs: list[str] = []

        # Seg 1: CPU ProcessorId
        cpu_id = b""
        for cpu in wmi.WMI().Win32_Processor():
            cpu_id = (cpu.ProcessorId or "").strip().encode("ascii", "replace")
            break
        segs.append(_segment(cpu_id))

        # Seg 2: Motherboard SerialNumber
        mb = b""
        for board in wmi.WMI().Win32_BaseBoard():
            s = (board.SerialNumber or "").strip()
            if s.lower() not in ("to be filled by o.e.m.", "none", ""):
                mb = s.encode("ascii", "replace")
            break
        segs.append(_segment(mb))

        # Seg 3: Primary MAC (lowest-numbered NIC)
        mac_int = uuid.getnode()
        segs.append(_segment(struct.pack(">Q", mac_int)[2:]))

        # Seg 4: Volume serial of C:\
        vol_serial = _ct.c_ulong(0)
        _ct.windll.kernel32.GetVolumeInformationW(
            "C:\\", None, 0, _ct.byref(vol_serial), None, None, None, 0
        )
        segs.append(_segment(struct.pack(">I", vol_serial.value)))

        return "-".join(segs)
    except Exception:
        return None


def _decrypt_keyfile(keyfile_path: str, candidate_hwid: str) -> bool | None:
    """Attempt to decrypt a chichitoworkshop.key blob using a candidate HWID.

    Mirrors `tools/fca-proxi-extract/src/license_check.load_key_file`:
      0x00  4   Magic: b'KEYF'
      0x04  4   Format version (LE uint32, must be 1)
      0x08  16  AES-CBC IV
      0x18  N   PKCS7-padded ciphertext
    The AES key is PBKDF2-HMAC-SHA256(hwid, salt=b'FCAProxiToolSalt',
    iterations=100_000, length=32).

    Returns:
      True   — header + version OK and the ciphertext decrypts with valid
               PKCS7 padding, i.e. the candidate HWID matches the binding.
      False  — header / version OK but PKCS7 unpad failed, i.e. the candidate
               HWID does NOT match the binding.
      None   — could not perform the check (file unreadable, malformed
               header, or `cryptography` package not installed). Caller
               should fall back to a manifest string compare.
    """
    try:
        with open(keyfile_path, "rb") as f:
            data = f.read()
    except Exception:
        return None
    if len(data) < 0x18 + 16 or data[:4] != b"KEYF":
        return None
    import struct as _struct
    if _struct.unpack_from("<I", data, 4)[0] != 1:
        return None
    try:
        from cryptography.hazmat.primitives import hashes as _h, padding as _pad
        from cryptography.hazmat.primitives.ciphers import (
            Cipher as _Cipher, algorithms as _alg, modes as _modes,
        )
        from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC as _PBKDF2
    except Exception:
        return None
    iv = data[8:24]
    ciphertext = data[24:]
    try:
        aes_key = _PBKDF2(
            algorithm=_h.SHA256(), length=32,
            salt=b"FCAProxiToolSalt", iterations=100_000,
        ).derive(candidate_hwid.encode("ascii"))
        dec = _Cipher(_alg.AES(aes_key), _modes.CBC(iv)).decryptor()
        padded = dec.update(ciphertext) + dec.finalize()
        unp = _pad.PKCS7(128).unpadder()
        unp.update(padded) + unp.finalize()
        return True
    except Exception:
        return False


def _verify_manifest_files(vendor_dir: str, manifest: dict, required_files: list[str]) -> list[str]:
    """
    Verify each required file against the manifest: check presence, byte size,
    AND SHA-256 hash. Returns a list of failure strings (empty = all good).
    """
    failures: list[str] = []
    file_infos = manifest.get("files", {})
    for fname in required_files:
        fpath = os.path.join(vendor_dir, fname)
        if not os.path.exists(fpath):
            failures.append(f"{fname}: not found")
            continue
        info = file_infos.get(fname, {})
        # Size check
        actual_size = os.path.getsize(fpath)
        expected_size = info.get("size")
        if expected_size is not None and actual_size != expected_size:
            failures.append(f"{fname}: size mismatch (expected {expected_size} B, got {actual_size} B)")
            continue  # don't bother hashing if size is wrong
        # SHA-256 check
        expected_sha256 = info.get("sha256")
        if expected_sha256:
            actual_sha256 = _sha256_file(fpath)
            if actual_sha256.lower() != expected_sha256.lower():
                failures.append(
                    f"{fname}: SHA-256 mismatch (expected {expected_sha256[:12]}…, got {actual_sha256[:12]}…)"
                )
    return failures


def _check_tool_status(tool_id: str) -> dict:
    """Return status dict for a vendored tool.

    Possible values of result["status"]:
      "present"    — all required files present, sizes + SHA-256 match manifest
      "missing"    — one or more files absent or corrupt
      "wrong-hwid" — files OK, but the tool's activation HWID doesn't match
                     the live machine HWID (Windows only, fca-proxi only)
    """
    if tool_id not in TOOL_DEFS:
        return {"status": "missing", "error": f"Unknown tool id: {tool_id}"}
    td = TOOL_DEFS[tool_id]
    vendor_dir = td["vendor_dir"]
    manifest = _load_manifest(vendor_dir)
    if manifest is None:
        return {"status": "missing", "error": "manifest.json not found"}

    failures = _verify_manifest_files(vendor_dir, manifest, td["required_files"])
    if failures:
        return {"status": "missing", "failures": failures}

    result: dict = {
        "status": "present",
        "name": manifest.get("tool", td["name"]),
        "version": manifest.get("version"),
    }

    # HWID check — only meaningful for fca-proxi which embeds a HWID binding
    # in its chichitoworkshop.key file. We:
    #   1. Compute the live machine HWID via the same 4-segment algorithm
    #      that hwid.get_hwid() uses inside the tool itself.
    #   2. Try AES-CBC decrypting the .key blob with a key derived from the
    #      live HWID. Valid PKCS7 padding => the live HWID matches the
    #      binding embedded in the .key file. (See _decrypt_keyfile.)
    #   3. Report expectedHwid (from manifest) and liveHwid alongside the
    #      status so the UI can render a tooltip.
    manifest_hwid = manifest.get("hwid")
    if manifest_hwid:
        live_hwid = _live_hwid()
        if live_hwid is None:
            # Non-Windows or WMI unavailable — cannot verify HWID; report present
            result["hwidCheckSkipped"] = True
            result["expectedHwid"] = manifest_hwid
        else:
            result["liveHwid"] = live_hwid
            result["expectedHwid"] = manifest_hwid
            keyfile_path = os.path.join(vendor_dir, "chichitoworkshop.key")
            keyfile_match = _decrypt_keyfile(keyfile_path, live_hwid)
            if keyfile_match is True:
                result["hwidMatch"] = True
                result["hwidSource"] = "keyfile-decrypt"
            elif keyfile_match is False:
                # AES decrypt produced invalid PKCS7 padding → HWID definitely
                # does not match the binding stored in the .key file.
                result["status"] = "wrong-hwid"
                result["hwidSource"] = "keyfile-decrypt"
            else:
                # cryptography unavailable or .key unreadable — fall back to
                # comparing the manifest's documented HWID against the live one.
                if live_hwid.upper() != manifest_hwid.upper():
                    result["status"] = "wrong-hwid"
                else:
                    result["hwidMatch"] = True
                result["hwidSource"] = "manifest-compare"

    return result


def _launch_tool(tool_id: str) -> dict:
    """
    Verify manifest (size + SHA-256) and spawn the tool EXE with CWD set to
    the vendor folder so the DLL sideload and .key lookup resolve correctly.

    stdout/stderr are captured via pipe. We wait up to 600 ms for any
    immediate output or early crash, then return whatever was collected.
    The process continues running in the background (detached) if it does
    not exit in that window.
    """
    if tool_id not in TOOL_DEFS:
        return {"ok": False, "error": f"Unknown tool id: {tool_id}"}
    td = TOOL_DEFS[tool_id]
    vendor_dir = td["vendor_dir"]
    status = _check_tool_status(tool_id)
    if status["status"] not in ("present", "wrong-hwid"):
        return {"ok": False, "error": "Tool files missing or corrupt", "details": status}
    exe_path = os.path.join(vendor_dir, td["exe"])
    if not os.path.exists(exe_path):
        return {"ok": False, "error": f"EXE not found: {exe_path}"}
    try:
        proc = subprocess.Popen(
            [exe_path],
            cwd=vendor_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            close_fds=True,
        )
        # Collect any immediate output / detect fast crash within 600 ms
        try:
            stdout_bytes, stderr_bytes = proc.communicate(timeout=0.6)
            # Process exited within the window — report it
            return {
                "ok": proc.returncode == 0,
                "pid": proc.pid,
                "exe": exe_path,
                "exitCode": proc.returncode,
                "stdout": stdout_bytes.decode("utf-8", "replace").strip(),
                "stderr": stderr_bytes.decode("utf-8", "replace").strip(),
            }
        except subprocess.TimeoutExpired:
            # Still running (normal for a GUI app) — detach and return
            # Read whatever is buffered without blocking
            stdout_preview = b""
            stderr_preview = b""
            try:
                import selectors
                sel = selectors.DefaultSelector()
                sel.register(proc.stdout, selectors.EVENT_READ)  # type: ignore
                sel.register(proc.stderr, selectors.EVENT_READ)  # type: ignore
                for key, _ in sel.select(timeout=0):
                    data = key.fileobj.read(4096)  # type: ignore
                    if key.fileobj is proc.stdout:
                        stdout_preview = data
                    else:
                        stderr_preview = data
                sel.close()
            except Exception:
                pass
            return {
                "ok": True,
                "pid": proc.pid,
                "exe": exe_path,
                "running": True,
                "stdout": stdout_preview.decode("utf-8", "replace").strip(),
                "stderr": stderr_preview.decode("utf-8", "replace").strip(),
            }
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _reveal_tool(tool_id: str) -> dict:
    """Open an Explorer / Finder window at the vendor folder."""
    if tool_id not in TOOL_DEFS:
        return {"ok": False, "error": f"Unknown tool id: {tool_id}"}
    vendor_dir = TOOL_DEFS[tool_id]["vendor_dir"]
    if not os.path.isdir(vendor_dir):
        return {"ok": False, "error": f"Vendor dir not found: {vendor_dir}"}
    try:
        if sys.platform == "win32":
            exe = TOOL_DEFS[tool_id]["exe"]
            exe_path = os.path.join(vendor_dir, exe)
            if os.path.exists(exe_path):
                subprocess.Popen(["explorer", "/select,", exe_path])
            else:
                subprocess.Popen(["explorer", vendor_dir])
        elif sys.platform == "darwin":
            subprocess.Popen(["open", vendor_dir])
        else:
            subprocess.Popen(["xdg-open", vendor_dir])
        return {"ok": True, "path": vendor_dir}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ─── HTTP handler ────────────────────────────────────────────────────────────
BRIDGE: J2534Bridge | None = None


def _coerce_int(v) -> int:
    """Accept ints or hex/decimal strings (e.g. '0x7E0' or '2016')."""
    if isinstance(v, int):
        return v
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return 0
        return int(s, 16) if s.lower().startswith("0x") else int(s, 0)
    return int(v)


def _find_port(preferred: int, host: str) -> int:
    """Bind to `preferred` if free, otherwise pick any free port and return it.
    Restores the auto-fallback behaviour from the original spec so a busy
    8765 doesn't kill the daemon on a tech's laptop."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind((host, preferred))
        s.close()
        return preferred
    except OSError:
        s.close()
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind((host, 0))
        return s.getsockname()[1]
    finally:
        s.close()


def _hex_to_bytes(s: str) -> bytes:
    if not s:
        return b""
    s = s.replace(" ", "").replace(":", "").replace("\n", "")
    if len(s) % 2 != 0:
        raise ValueError("hex string must have even length")
    return bytes.fromhex(s)


class Handler(BaseHTTPRequestHandler):
    server_version = "SrtLabJ2534Bridge/1.0"

    # silence default access log unless verbose
    def log_message(self, fmt: str, *args) -> None:
        if BRIDGE and BRIDGE.verbose:
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Max-Age", "86400")

    def _json(self, obj: dict, code: int = 200) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        if not raw.strip():
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception as e:
            raise ValueError(f"invalid JSON body: {e}")

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:
        if self.path.split("?")[0] != "/status":
            self._json({"ok": False, "error": "not found"}, 404)
            return
        try:
            st = BRIDGE.status() if BRIDGE else {"ok": False, "error": "bridge not initialised"}
            if BRIDGE and BRIDGE.opened:
                st["versions"] = BRIDGE.read_versions()
            self._json(st)
        except Exception as e:
            self._json({"ok": False, "error": str(e)}, 500)

    def do_POST(self) -> None:
        path = self.path.split("?")[0]
        try:
            body = self._read_json()
        except ValueError as e:
            self._json({"ok": False, "error": str(e)}, 400)
            return

        if BRIDGE is None:
            self._json({"ok": False, "error": "bridge not initialised"}, 500)
            return

        try:
            if path == "/open":
                BRIDGE.open()
                self._json({"ok": True, **BRIDGE.status(), "versions": BRIDGE.read_versions()})
            elif path == "/connect":
                proto = int(body.get("protocol", PROTOCOL_ISO15765))
                flags = int(body.get("flags", 0))
                baud = int(body.get("baudrate", body.get("baudRate", 500000)))
                BRIDGE.connect(protocol=proto, flags=flags, baudrate=baud)
                self._json({"ok": True, **BRIDGE.status()})
            elif path == "/disconnect":
                BRIDGE.disconnect()
                self._json({"ok": True, **BRIDGE.status()})
            elif path == "/close":
                BRIDGE.close()
                self._json({"ok": True, **BRIDGE.status()})
            elif path == "/setfilter":
                tx = _coerce_int(body.get("txId", body.get("tx_id", 0)))
                rx = _coerce_int(body.get("rxId", body.get("rx_id", 0)))
                fid = BRIDGE.set_filter(tx, rx)
                self._json({"ok": True, "filterId": fid, "filter_id": fid})
            elif path == "/sendmsg":
                tx = _coerce_int(body.get("txId", body.get("tx_id", 0)))
                raw_data = body.get("data", "")
                if isinstance(raw_data, list):
                    data = bytes(int(b) & 0xFF for b in raw_data)
                else:
                    data = _hex_to_bytes(str(raw_data))
                flags = int(body.get("flags", ISO15765_FRAME_PAD))
                timeout = int(body.get("timeoutMs", body.get("timeout_ms", 1000)))
                BRIDGE.send_msg(tx, data, flags=flags, timeout_ms=timeout)
                self._json({"ok": True})
            elif path == "/readmsg":
                timeout = int(body.get("timeoutMs", body.get("timeout_ms", 1000)))
                max_msgs = int(body.get("max_msgs", body.get("maxMsgs", 1)))
                msgs = []
                for _ in range(max(1, max_msgs)):
                    m = BRIDGE.read_msg(timeout_ms=timeout)
                    if m is None:
                        break
                    msgs.append(m)
                # Return both shapes so callers written to either spec keep working:
                # legacy spec wants `messages: [...]`; shipped client wants `msg: {...}`.
                self._json({"ok": True, "msg": msgs[0] if msgs else None, "messages": msgs})
            elif path == "/voltage":
                self._json({"ok": True, "voltage": BRIDGE.read_voltage()})
            elif path == "/tools/status":
                tool_id = body.get("toolId", body.get("tool_id", ""))
                result = _check_tool_status(tool_id)
                self._json({"ok": True, **result})
            elif path == "/tools/launch":
                tool_id = body.get("toolId", body.get("tool_id", ""))
                result = _launch_tool(tool_id)
                self._json(result, 200 if result.get("ok") else 500)
            elif path == "/tools/reveal":
                tool_id = body.get("toolId", body.get("tool_id", ""))
                result = _reveal_tool(tool_id)
                self._json(result, 200 if result.get("ok") else 500)
            else:
                self._json({"ok": False, "error": f"unknown endpoint {path}"}, 404)
        except FileNotFoundError as e:
            self._json({"ok": False, "error": str(e)}, 500)
        except RuntimeError as e:
            self._json({"ok": False, "error": str(e)}, 500)
        except Exception as e:
            self._json({"ok": False, "error": f"{type(e).__name__}: {e}"}, 500)


# ─── main ────────────────────────────────────────────────────────────────────
def main() -> int:
    # Make stdout/stderr encoding-proof. Log messages contain Unicode (→, ✓) and
    # a Windows console / redirected file defaults to cp1252, which raises
    # UnicodeEncodeError mid-request and can crash a handler (e.g. /open). Force
    # UTF-8 with a safe fallback so a print can never take down a request.
    for _s in (sys.stdout, sys.stderr):
        try:
            _s.reconfigure(encoding="utf-8", errors="backslashreplace")
        except Exception:
            pass
    ap = argparse.ArgumentParser(description="SRT Lab J2534 HTTP bridge daemon")
    ap.add_argument("--dll", required=False, default="",
                    help="Path to vendor J2534 DLL (e.g. MaxiFlashJ2534.dll). "
                         "Required before /open will succeed.")
    ap.add_argument("--port", type=int, default=8765, help="HTTP port (default 8765)")
    ap.add_argument("--host", default="127.0.0.1", help="Bind host (default 127.0.0.1)")
    ap.add_argument("--verbose", "-v", action="store_true", help="Verbose request log")
    ap.add_argument("--no-open", action="store_true",
                    help="Don't auto-open the device on start (web app will trigger it)")
    args = ap.parse_args()

    global BRIDGE
    if not args.dll:
        found, found_name = discover_j2534_dll(prefer_topdon=True)
        if found:
            args.dll = found
            print(f"  [auto] Discovered J2534 DLL: {found}  ({found_name or vendor_for(found)})")
        else:
            print("  [auto] No J2534 DLL found in registry / TOPDON paths — pass --dll to set one.")
    BRIDGE = J2534Bridge(args.dll, verbose=args.verbose)

    # Auto-fallback to a free port if --port is busy (matches the original spec).
    bind_port = _find_port(args.port, args.host)
    if bind_port != args.port:
        print(f"  [!] Port {args.port} busy on {args.host} — falling back to {bind_port}")
    args.port = bind_port

    print("=" * 64)
    print(" SRT Lab — J2534 HTTP Bridge (Topdon / raw-CAN software ISO-TP)")
    print("=" * 64)
    print(f"  Listening on   http://{args.host}:{args.port}")
    print(f"  DLL            {args.dll or '(none — pass --dll to use)'}")
    print(f"  Vendor         {vendor_for(args.dll)}")
    print(f"  Transport      raw CAN + software ISO-TP  [{BRIDGE_BUILD}]")
    print(f"  Platform       {platform.system()} / Python {platform.python_version()}")
    print()

    if args.dll:
        # Load the vendor DLL now so /status reports dllLoaded=true and the web
        # UI will proceed. Loading the DLL does NOT touch the adapter; the device
        # is opened (PassThruOpen) on the first /open — at startup only when the
        # operator did not pass --no-open.
        try:
            BRIDGE.load()
            print("  DLL loaded OK — ready for /open from the UI.")
        except Exception as e:
            print(f"  [!] Could not load DLL: {e}")
        if not args.no_open:
            try:
                BRIDGE.open()
                v = BRIDGE.read_versions()
                print(f"  Device opened. firmware={v.get('firmware')} dll={v.get('dll')} api={v.get('api')}")
            except Exception as e:
                print(f"  [!] Auto-open failed (the UI can open it on Connect): {e}")

    print()
    print("  Endpoints:")
    print("    GET  /status   POST /open    POST /connect   POST /disconnect")
    print("    POST /close    POST /sendmsg POST /readmsg   POST /setfilter")
    print("    POST /voltage  POST /tools/status  /tools/launch  /tools/reveal")
    print()
    print("  Press Ctrl+C to stop.")
    print()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down…")
    finally:
        try:
            BRIDGE.close()
        except Exception:
            pass
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
