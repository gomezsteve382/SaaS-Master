#!/usr/bin/env python3
"""
SRT Lab — J2534 HTTP Bridge Daemon
===================================
Local HTTP server that wraps a vendor J2534 PassThru DLL via ctypes and exposes
it to the SRT Lab web app over plain HTTP. Runs on Windows / macOS / Linux with
nothing but the Python 3.8+ standard library — no pip packages required.

The hosted SRT Lab UI talks to this bridge from the browser via:
    http://127.0.0.1:8765

Endpoints (all return JSON):
    GET  /status        — bridge state, loaded DLL, vendor, fw/api versions
    POST /open          — PassThruOpen (loads DLL on first call)
    POST /connect       — PassThruConnect (protocol, flags, baudRate)
    POST /disconnect    — PassThruDisconnect
    POST /close         — PassThruClose
    POST /sendmsg       — PassThruWriteMsgs (data is hex string)
    POST /readmsg       — PassThruReadMsgs (data returned as hex string)
    POST /setfilter     — PassThruStartMsgFilter (ISO-TP flow control)

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
import json
import os
import platform
import socket
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
FLOW_CONTROL_FILTER = 3
PASS_FILTER = 1
CLEAR_RX_BUFFER = 0x08

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
            ret = self.dll.PassThruOpen(None, byref(self.device_id))
            if ret != 0:
                raise RuntimeError(self.err_text(ret))
            self.opened = True
            self._log(f"PassThruOpen → device_id={self.device_id.value}")

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

    def connect(self, protocol: int = PROTOCOL_ISO15765, flags: int = 0, baudrate: int = 500000) -> None:
        with self.lock:
            if not self.opened:
                raise RuntimeError("Device not open — call /open first")
            if self.connected:
                return
            ret = self.dll.PassThruConnect(
                self.device_id, c_ulong(protocol), c_ulong(flags),
                c_ulong(baudrate), byref(self.channel_id),
            )
            if ret != 0:
                raise RuntimeError(self.err_text(ret))
            self.connected = True
            self._log(f"PassThruConnect proto={protocol} baud={baudrate} → ch={self.channel_id.value}")

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
        if not self.connected:
            return
        ret = self.dll.PassThruDisconnect(self.channel_id)
        self.connected = False
        self.channel_id = c_ulong(0)
        self._log(f"PassThruDisconnect ret={ret}")
        if ret != 0:
            raise RuntimeError(self.err_text(ret))

    def set_filter(self, tx_id: int, rx_id: int) -> int:
        with self.lock:
            if not self.connected:
                raise RuntimeError("Channel not connected — call /connect first")
            mask = PASSTHRU_MSG()
            mask.ProtocolID = PROTOCOL_ISO15765
            mask.DataSize = 4
            mask.Data[0] = 0xFF; mask.Data[1] = 0xFF; mask.Data[2] = 0xFF; mask.Data[3] = 0xFF

            patt = PASSTHRU_MSG()
            patt.ProtocolID = PROTOCOL_ISO15765
            patt.DataSize = 4
            patt.Data[0] = (rx_id >> 24) & 0xFF
            patt.Data[1] = (rx_id >> 16) & 0xFF
            patt.Data[2] = (rx_id >> 8) & 0xFF
            patt.Data[3] = rx_id & 0xFF

            fc = PASSTHRU_MSG()
            fc.ProtocolID = PROTOCOL_ISO15765
            fc.TxFlags = ISO15765_FRAME_PAD
            fc.DataSize = 4
            fc.Data[0] = (tx_id >> 24) & 0xFF
            fc.Data[1] = (tx_id >> 16) & 0xFF
            fc.Data[2] = (tx_id >> 8) & 0xFF
            fc.Data[3] = tx_id & 0xFF

            fid = c_ulong(0)
            ret = self.dll.PassThruStartMsgFilter(
                self.channel_id, FLOW_CONTROL_FILTER,
                byref(mask), byref(patt), byref(fc), byref(fid),
            )
            if ret != 0:
                raise RuntimeError(self.err_text(ret))
            self.filters.append(fid.value)
            self._log(f"Filter added tx=0x{tx_id:X} rx=0x{rx_id:X} fid={fid.value}")
            return fid.value

    def send_msg(self, tx_id: int, data: bytes, flags: int = ISO15765_FRAME_PAD, timeout_ms: int = 1000) -> None:
        with self.lock:
            if not self.connected:
                raise RuntimeError("Channel not connected — call /connect first")
            if len(data) > 4124:
                raise ValueError("Payload too large for PASSTHRU_MSG (max 4124 bytes)")
            msg = PASSTHRU_MSG()
            msg.ProtocolID = PROTOCOL_ISO15765
            msg.TxFlags = flags
            msg.DataSize = 4 + len(data)
            msg.Data[0] = (tx_id >> 24) & 0xFF
            msg.Data[1] = (tx_id >> 16) & 0xFF
            msg.Data[2] = (tx_id >> 8) & 0xFF
            msg.Data[3] = tx_id & 0xFF
            for i, b in enumerate(data):
                msg.Data[4 + i] = b
            num = c_ulong(1)
            ret = self.dll.PassThruWriteMsgs(self.channel_id, byref(msg), byref(num), c_ulong(timeout_ms))
            if ret != 0:
                raise RuntimeError(self.err_text(ret))
            self._log(f"TX 0x{tx_id:X}: {data.hex()}")

    def read_msg(self, timeout_ms: int = 1000) -> dict | None:
        with self.lock:
            if not self.connected:
                raise RuntimeError("Channel not connected — call /connect first")
            msg = PASSTHRU_MSG()
            num = c_ulong(1)
            ret = self.dll.PassThruReadMsgs(self.channel_id, byref(msg), byref(num), c_ulong(timeout_ms))
            if ret == 0x10:  # ERR_BUFFER_EMPTY
                return None
            if ret != 0:
                raise RuntimeError(self.err_text(ret))
            if num.value == 0 or msg.DataSize < 4:
                return None
            can_id = (msg.Data[0] << 24) | (msg.Data[1] << 16) | (msg.Data[2] << 8) | msg.Data[3]
            payload = bytes(msg.Data[i] for i in range(4, msg.DataSize))
            self._log(f"RX 0x{can_id:X}: {payload.hex()}")
            return {
                "canId": can_id,
                "data": payload.hex(),
                "rxStatus": msg.RxStatus,
                "timestamp": msg.Timestamp,
            }

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
    BRIDGE = J2534Bridge(args.dll, verbose=args.verbose)

    # Auto-fallback to a free port if --port is busy (matches the original spec).
    bind_port = _find_port(args.port, args.host)
    if bind_port != args.port:
        print(f"  [!] Port {args.port} busy on {args.host} — falling back to {bind_port}")
    args.port = bind_port

    print("=" * 64)
    print(" SRT Lab — J2534 HTTP Bridge")
    print("=" * 64)
    print(f"  Listening on   http://{args.host}:{args.port}")
    print(f"  DLL            {args.dll or '(none — pass --dll to use)'}")
    print(f"  Vendor         {vendor_for(args.dll)}")
    print(f"  Platform       {platform.system()} / Python {platform.python_version()}")
    print()

    if args.dll and not args.no_open:
        try:
            BRIDGE.open()
            v = BRIDGE.read_versions()
            print(f"  Device opened. firmware={v.get('firmware')} dll={v.get('dll')} api={v.get('api')}")
        except Exception as e:
            print(f"  [!] Auto-open failed: {e}")
            print(f"      You can still POST /open from the AUTEL SGW tab once the cable is in.")

    print()
    print("  Endpoints:")
    print("    GET  /status   POST /open    POST /connect   POST /disconnect")
    print("    POST /close    POST /sendmsg POST /readmsg   POST /setfilter")
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
