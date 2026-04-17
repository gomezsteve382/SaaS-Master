#!/usr/bin/env python3
"""
SRT LAB v2 - Direct J2534 BCM VIN Programmer (and more)

Pure Python. No browser. No WebSocket. No ELM327.
Talks directly to Autel IM608 / MaxiFlash J2534 DLL on Windows.

Built from: AlfaOBD CDA6 analysis, Villain extraction, and the toolkit.

PRIMARY USE CASE: BCM VIN change - one command, fully automated.

USAGE:
  python srt_lab.py devices
  python srt_lab.py scan                                 # Scan all FCA modules
  python srt_lab.py scan -v                              # Scan with full TX/RX log
  python srt_lab.py read ECM                             # Read VIN from named module
  python srt_lab.py read --tx 0x750 --rx 0x758           # Read by address
  python srt_lab.py probe --tx 0x750 --rx 0x758          # Probe one address
  python srt_lab.py monitor --duration 10                # Passive CAN monitor
  python srt_lab.py unlock-test BCM                      # Try all algorithms on BCM
  python srt_lab.py bcm-write --vin <VIN17>              # FULL BCM VIN CHANGE
  python srt_lab.py bcm-write --vin <VIN17> --tx 0x750   # BCM write at specific address

REQUIREMENTS:
  - Windows 10/11
  - Python 3.8+
  - Autel MaxiFlash / MaxiPro J2534 drivers installed
  - Autel IM608 (or any J2534 PassThru device) connected via USB
  - Bench/vehicle powered, ignition RUN

SECURITY ALGORITHMS INCLUDED:
  CDA6, GPEC1, GPEC2 (+Flash/EPROM/2015/A), GPEC3, NGC, JTEC,
  TIPM (t8001/t3605/t8101/t3c), BCM Standard, BCM FCA, SBEC2/3
"""

import sys
import os
import time
import argparse
import ctypes
import threading
from ctypes import c_ulong, c_long, c_void_p, POINTER, byref

# ═══════════════════════════════════════════════════════════════
# J2534 CONSTANTS
# ═══════════════════════════════════════════════════════════════

PROTOCOL_CAN = 5
PROTOCOL_ISO15765 = 6
ISO15765_FRAME_PAD = 0x00000040
FLOW_CONTROL_FILTER = 3
PASS_FILTER = 1
CLEAR_RX_BUFFER = 0x08

# UDS Services
SID_DIAG_SESSION = 0x10
SID_ECU_RESET = 0x11
SID_SECURITY_ACCESS = 0x27
SID_READ_DATA_BY_ID = 0x22
SID_WRITE_DATA_BY_ID = 0x2E
SID_ROUTINE_CONTROL = 0x31
SID_TESTER_PRESENT = 0x3E
NEG_RESPONSE = 0x7F

# VIN DIDs
DID_VIN_F190 = 0xF190
DID_VIN_7B90 = 0x7B90
DID_VIN_7B88 = 0x7B88
DID_BUS_VIN = 0x6E2025
DID_WCM_VIN = 0x6E2027
DID_SKIM_STATE = 0x6E9EB0

BCM_VIN_DIDS = [DID_VIN_F190, DID_VIN_7B90, DID_VIN_7B88]

NEG_RESPONSE_CODES = {
    0x10: "General reject",
    0x11: "Service not supported",
    0x12: "Subfunction not supported",
    0x13: "Incorrect length",
    0x22: "Conditions not correct",
    0x24: "Sequence error",
    0x31: "Request out of range",
    0x33: "Security access denied",
    0x35: "Invalid key",
    0x36: "Exceeded attempts",
    0x37: "Time delay not expired",
    0x78: "Response pending",
}

# ═══════════════════════════════════════════════════════════════
# MODULE DATABASE
# ═══════════════════════════════════════════════════════════════

MODULES = {
    'ECM':       (0x7E0, 0x7E8, "Engine Control Module"),
    'TCM':       (0x7E1, 0x7E9, "Transmission Control Module"),
    'DTCM':      (0x7E2, 0x7EA, "Drive Train Control Module"),
    'BPCM':      (0x7E4, 0x7EC, "Battery Pack Control Module"),
    'BCM':       (0x750, 0x758, "Body Control Module"),
    'RFHUB':     (0x75F, 0x767, "RF Hub Module"),
    'ABS':       (0x760, 0x768, "Anti-lock Brake System"),
    'IPC':       (0x740, 0x748, "Instrument Panel Cluster"),
    'ORC':       (0x758, 0x760, "Occupant Restraint Controller"),
    'ADCM':      (0x7A8, 0x7B0, "Active Damping Control Module"),
    'AMP':       (0x7A0, 0x7A8, "Audio Amplifier"),
    'BSM':       (0x770, 0x778, "Blind Spot Monitor"),
    'RADIO':     (0x772, 0x77A, "Uconnect Radio"),
    'HVAC':      (0x751, 0x759, "HVAC Climate"),
    'TPMS':      (0x752, 0x75A, "Tire Pressure Monitoring"),
    'EPS':       (0x761, 0x769, "Electric Power Steering"),
    'SGW':       (0x74F, 0x76F, "Security Gateway"),
    'CGW':       (0x7C0, 0x7C8, "Central Gateway"),
    'BCM_ALT':   (0x742, 0x762, "BCM (alternate)"),
    'IPC_ALT':   (0x745, 0x765, "IPC / SDM (alternate)"),
    'RADIO_ALT': (0x754, 0x75C, "Radio (alternate)"),
    'EPS_ALT':   (0x74A, 0x76A, "EPS (alternate)"),
    'CCM':       (0x743, 0x763, "Climate Control Module"),
    'ADM':       (0x744, 0x764, "Active Dampening Module"),
    'SDM':       (0x745, 0x765, "Suspension Dampening Module"),
    'IPCM':      (0x746, 0x766, "IPC Module"),
    'DDM':       (0x748, 0x768, "Driver Door Module"),
    'PDM':       (0x749, 0x769, "Passenger Door Module"),
    'SCCM':      (0x74D, 0x76D, "Steering Column Control"),
    'TIPM':      (0x74C, 0x76C, "Integrated Power Module"),
    'SKREEM':    (0x75A, 0x77A, "SKIM/SKREEM"),
}

BCM_CANDIDATES = [
    (0x750, 0x758, "BCM (CDA6 primary)"),
    (0x742, 0x762, "BCM (CLAUDE.md/DarkVIN)"),
    (0x7E0, 0x7E8, "BCM (legacy, pre-2016)"),
    (0x6B0, 0x6B8, "BCM (DarkVIN alt)"),
    (0x7B0, 0x7B8, "BCM (swarm scanner)"),
    (0x620, 0x628, "BCM (PowerNet)"),
]

# ═══════════════════════════════════════════════════════════════
# SECURITY ALGORITHMS
# ═══════════════════════════════════════════════════════════════

def u32(n):
    return n & 0xFFFFFFFF

def algo_sxor(seed, const):
    """GPEC shift-XOR - 5 rounds"""
    k = u32(seed)
    for _ in range(5):
        if k & 0x80000000:
            k = u32((k << 1) ^ u32(const))
        else:
            k = u32(k << 1)
    return k

def algo_cda6(seed):
    """CDA6 - BCM/ABS/IPC primary"""
    k = u32(seed)
    k = u32(k ^ 0x4B129F)
    k = u32((k << 3) | (k >> 29))
    k = u32(k + 0x1234)
    k = u32(k ^ 0xABCD)
    return u32((k >> 5) | (k << 27))

_NGC_TABLE = [0x44, 0x41, 0x49, 0x4D, 0x4C, 0x45, 0x52, 0x43,
              0x48, 0x52, 0x59, 0x53, 0x4C, 0x45, 0x52, 0x31]
_NGC_SEEDS = [0x9D9F, 0xCE48, 0xB0F3, 0xD99B, 0xA720, 0xFDD6, 0x836D, 0x6F8E]

def algo_ngc(seed):
    k = 0
    for i in range(4):
        b = (u32(seed) >> (i * 8)) & 0xFF
        k = u32(k ^ u32(((_NGC_TABLE[b & 0xF] ^ _NGC_TABLE[(b >> 4) & 0xF]) * _NGC_SEEDS[i % 8]) & 0xFFFFFFFF))
    return k

_TIPM_A = [0x727B, 0xB301, 0x08EB, 0xB0BA, 0xECA7, 0x0ECC, 0xD69A, 0xE47E]
_TIPM_B = [0x7A44, 0x0201, 0xF123, 0x146E, 0xCBC2, 0x553F, 0xD398, 0x4EDC]
_TIPM_C = [0x22B5, 0x5767, 0x4C5A, 0xE443, 0xC606, 0x7544, 0x0DFB, 0x36D6]
_TIPM_D = [0x632A, 0x193B, 0x914F, 0x0F88, 0x5E51, 0x8DCD, 0xDD6C, 0x00DD]
_TIPM_MASKS = [0xBAEE, 0xE000, 0x1C00, 0x0380, 0x0070, 0x0007]

def algo_tipm(seed, variant='a'):
    tb = {'a': _TIPM_A, 'b': _TIPM_B, 'c': _TIPM_C, 'd': _TIPM_D}.get(variant, _TIPM_A)
    v = seed & 0xFFFF
    k = 0
    for i in range(len(tb)):
        m = v & _TIPM_MASKS[i % len(_TIPM_MASKS)]
        b = 0
        x = m
        while x:
            b ^= x & 1
            x >>= 1
        k = (k << 1) | b
        k ^= tb[i]
        k &= 0xFFFF
    return k

def algo_bcm_standard(seed):
    return (seed * 0x9D + 0x1234) & 0xFFFFFFFF

def algo_bcm_fca(seed):
    return ((seed ^ 0xABCDEF12) * 0x4D + 0x5678) & 0xFFFFFFFF

def algo_sbec(seed):
    return (seed * 4 + 0x9018) & 0xFFFFFFFF

BCM_ALGORITHMS = [
    ('CDA6',         algo_cda6,                          "Modern Chrysler BCM/ABS/IPC"),
    ('BCM Standard', algo_bcm_standard,                  "BCM 2007-2015"),
    ('BCM FCA',      algo_bcm_fca,                       "BCM 2016+"),
    ('GPEC2',        lambda s: algo_sxor(s, 0xE72E3799), "Continental GPEC2"),
    ('GPEC2 Flash',  lambda s: algo_sxor(s, 0x966AEEB1), "GPEC2 Flash mode"),
    ('GPEC2 EPROM',  lambda s: algo_sxor(s, 0x3F711F5A), "GPEC2 EPROM mode"),
    ('GPEC3',        lambda s: algo_sxor(s, 0x129D657F), "GPEC3 2018+"),
    ('GPEC2A',       lambda s: algo_sxor(s, 0xCE853A6F), "GPEC2A variant"),
    ('GPEC2 2015',   lambda s: algo_sxor(s, 0x47EC21F8), "GPEC2 2015-18"),
    ('GPEC1',        lambda s: algo_sxor(s, 670269),     "GPEC1 KEY=670269"),
    ('NGC',          algo_ngc,                           "NGC DAIMLERCHRYSLER"),
    ('JTEC',         lambda s: 0x00000000,               "JTEC fixed 0000"),
    ('TIPM t8001',   lambda s: algo_tipm(s, 'a'),        "TIPM 0x80"),
    ('TIPM t3605',   lambda s: algo_tipm(s, 'b'),        "TIPM 0x36"),
    ('TIPM t8101',   lambda s: algo_tipm(s, 'c'),        "TIPM 0x81"),
    ('TIPM t3c',     lambda s: algo_tipm(s, 'd'),        "TIPM 0x3C"),
    ('SBEC',         algo_sbec,                          "Legacy SBEC2/3"),
]

# ═══════════════════════════════════════════════════════════════
# J2534 STRUCTURES
# ═══════════════════════════════════════════════════════════════

class PASSTHRU_MSG(ctypes.Structure):
    _fields_ = [
        ("ProtocolID", c_ulong),
        ("RxStatus", c_ulong),
        ("TxFlags", c_ulong),
        ("Timestamp", c_ulong),
        ("DataSize", c_ulong),
        ("ExtraDataIndex", c_ulong),
        ("Data", ctypes.c_ubyte * 4128),
    ]

# ═══════════════════════════════════════════════════════════════
# LOGGING
# ═══════════════════════════════════════════════════════════════

VERBOSE = False

def _color(level):
    return {
        "OK": "\033[1;32m", "ERROR": "\033[1;31m", "WARN": "\033[33m",
        "FOUND": "\033[1;33m", "TX": "\033[36m", "RX": "\033[35m",
        "STEP": "\033[1;36m", "HEAD": "\033[1;37m",
    }.get(level, "")

def log(msg, level="INFO"):
    prefix = {
        "INFO": "[*]", "OK": "[+]", "ERROR": "[!]", "WARN": "[?]",
        "TX": "[->]", "RX": "[<-]", "FOUND": "[*]", "STEP": "[>]", "HEAD": "",
    }.get(level, "[*]")
    color = _color(level)
    reset = "\033[0m" if color else ""
    ts = time.strftime("%H:%M:%S")
    print(f"{ts} {color}{prefix} {msg}{reset}")

def vlog(msg, level="INFO"):
    if VERBOSE:
        log(msg, level)

def head(msg):
    c = _color("HEAD")
    bar = "=" * 70
    print(f"\n{c}{bar}\n  {msg}\n{bar}\033[0m")

# ═══════════════════════════════════════════════════════════════
# J2534 CLIENT
# ═══════════════════════════════════════════════════════════════

class J2534:
    def __init__(self):
        self.dll = None
        self.device_id = c_ulong(0)
        self.channel_id = c_ulong(0)
        self.filters = []
        self.connected = False

    @staticmethod
    def find_devices():
        if sys.platform != 'win32':
            return []
        import winreg
        devices = []
        for base in [r"SOFTWARE\PassThruSupport.04.04",
                     r"SOFTWARE\WOW6432Node\PassThruSupport.04.04"]:
            try:
                key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, base)
                i = 0
                while True:
                    try:
                        sub = winreg.OpenKey(key, winreg.EnumKey(key, i))
                        try:
                            dll = winreg.QueryValueEx(sub, "FunctionLibrary")[0]
                            name = winreg.QueryValueEx(sub, "Name")[0]
                            if os.path.exists(dll):
                                devices.append((name, dll))
                        except Exception:
                            pass
                        winreg.CloseKey(sub)
                        i += 1
                    except OSError:
                        break
                winreg.CloseKey(key)
            except Exception:
                pass
        seen = set()
        unique = []
        for n, d in devices:
            if d.lower() not in seen:
                seen.add(d.lower())
                unique.append((n, d))
        return unique

    def load(self, dll_path):
        self.dll = ctypes.WinDLL(dll_path)
        self.dll.PassThruOpen.argtypes = [c_void_p, POINTER(c_ulong)]
        self.dll.PassThruOpen.restype = c_long
        self.dll.PassThruClose.argtypes = [c_ulong]
        self.dll.PassThruClose.restype = c_long
        self.dll.PassThruConnect.argtypes = [c_ulong, c_ulong, c_ulong, c_ulong, POINTER(c_ulong)]
        self.dll.PassThruConnect.restype = c_long
        self.dll.PassThruDisconnect.argtypes = [c_ulong]
        self.dll.PassThruDisconnect.restype = c_long
        self.dll.PassThruReadMsgs.argtypes = [c_ulong, POINTER(PASSTHRU_MSG), POINTER(c_ulong), c_ulong]
        self.dll.PassThruReadMsgs.restype = c_long
        self.dll.PassThruWriteMsgs.argtypes = [c_ulong, POINTER(PASSTHRU_MSG), POINTER(c_ulong), c_ulong]
        self.dll.PassThruWriteMsgs.restype = c_long
        self.dll.PassThruStartMsgFilter.argtypes = [c_ulong, c_ulong, POINTER(PASSTHRU_MSG),
                                                    POINTER(PASSTHRU_MSG), POINTER(PASSTHRU_MSG),
                                                    POINTER(c_ulong)]
        self.dll.PassThruStartMsgFilter.restype = c_long
        self.dll.PassThruStopMsgFilter.argtypes = [c_ulong, c_ulong]
        self.dll.PassThruStopMsgFilter.restype = c_long
        self.dll.PassThruIoctl.argtypes = [c_ulong, c_ulong, c_void_p, c_void_p]
        self.dll.PassThruIoctl.restype = c_long

    def open(self):
        return self.dll.PassThruOpen(None, byref(self.device_id)) == 0

    def close(self):
        if self.connected:
            self.disconnect()
        if self.device_id.value:
            self.dll.PassThruClose(self.device_id)
            self.device_id = c_ulong(0)

    def connect(self, baud=500000):
        r = self.dll.PassThruConnect(self.device_id, PROTOCOL_ISO15765, 0, baud, byref(self.channel_id))
        if r == 0:
            self.connected = True
            return True
        return False

    def disconnect(self):
        self.clear_filters()
        if self.channel_id.value:
            self.dll.PassThruDisconnect(self.channel_id)
            self.channel_id = c_ulong(0)
        self.connected = False

    def clear_filters(self):
        for fid in self.filters:
            try:
                self.dll.PassThruStopMsgFilter(self.channel_id, fid)
            except Exception:
                pass
        self.filters = []

    def clear_rx(self):
        self.dll.PassThruIoctl(self.channel_id, CLEAR_RX_BUFFER, None, None)

    def setup_iso15765(self, tx_id, rx_id):
        mask = PASSTHRU_MSG()
        mask.ProtocolID = PROTOCOL_ISO15765
        mask.DataSize = 4
        mask.Data[0] = 0xFF; mask.Data[1] = 0xFF; mask.Data[2] = 0xFF; mask.Data[3] = 0xFF
        pattern = PASSTHRU_MSG()
        pattern.ProtocolID = PROTOCOL_ISO15765
        pattern.DataSize = 4
        pattern.Data[0] = (rx_id >> 24) & 0xFF
        pattern.Data[1] = (rx_id >> 16) & 0xFF
        pattern.Data[2] = (rx_id >> 8) & 0xFF
        pattern.Data[3] = rx_id & 0xFF
        fc = PASSTHRU_MSG()
        fc.ProtocolID = PROTOCOL_ISO15765
        fc.TxFlags = ISO15765_FRAME_PAD
        fc.DataSize = 4
        fc.Data[0] = (tx_id >> 24) & 0xFF
        fc.Data[1] = (tx_id >> 16) & 0xFF
        fc.Data[2] = (tx_id >> 8) & 0xFF
        fc.Data[3] = tx_id & 0xFF
        fid = c_ulong(0)
        r = self.dll.PassThruStartMsgFilter(self.channel_id, FLOW_CONTROL_FILTER,
                                            byref(mask), byref(pattern), byref(fc), byref(fid))
        if r == 0:
            self.filters.append(fid.value)
            return True
        return False

    def send(self, tx_id, data, timeout=2000):
        msg = PASSTHRU_MSG()
        msg.ProtocolID = PROTOCOL_ISO15765
        msg.TxFlags = ISO15765_FRAME_PAD
        msg.DataSize = 4 + len(data)
        msg.Data[0] = (tx_id >> 24) & 0xFF
        msg.Data[1] = (tx_id >> 16) & 0xFF
        msg.Data[2] = (tx_id >> 8) & 0xFF
        msg.Data[3] = tx_id & 0xFF
        for i, b in enumerate(data):
            msg.Data[4 + i] = b
        num = c_ulong(1)
        vlog(f"TX 0x{tx_id:03X}: {' '.join(f'{b:02X}' for b in data)}", "TX")
        return self.dll.PassThruWriteMsgs(self.channel_id, byref(msg), byref(num), timeout) == 0

    def recv(self, timeout=2000):
        msg = PASSTHRU_MSG()
        num = c_ulong(1)
        r = self.dll.PassThruReadMsgs(self.channel_id, byref(msg), byref(num), timeout)
        if r == 0 and num.value > 0 and msg.DataSize > 4:
            can_id = (msg.Data[0] << 24) | (msg.Data[1] << 16) | (msg.Data[2] << 8) | msg.Data[3]
            data = [msg.Data[i] for i in range(4, msg.DataSize)]
            vlog(f"RX 0x{can_id:03X}: {' '.join(f'{b:02X}' for b in data)}", "RX")
            return can_id, data
        return None, None

    def request(self, tx_id, rx_id, data, timeout=2000, setup=True):
        if setup:
            self.clear_filters()
            self.clear_rx()
            if not self.setup_iso15765(tx_id, rx_id):
                return None
        if not self.send(tx_id, data, timeout):
            return None
        deadline = time.time() + (timeout / 1000.0) + 2
        while time.time() < deadline:
            can_id, resp = self.recv(timeout)
            if resp is None:
                return None
            if can_id != rx_id:
                continue
            if len(resp) >= 3 and resp[0] == NEG_RESPONSE and resp[2] == 0x78:
                vlog("Response pending, waiting...", "WARN")
                continue
            return resp
        return None

# ═══════════════════════════════════════════════════════════════
# UDS HELPERS
# ═══════════════════════════════════════════════════════════════

def parse_vin(data):
    if not data or len(data) < 3:
        return None
    payload = data[3:] if data[0] == 0x62 else data
    ascii_bytes = [b for b in payload if 0x20 <= b <= 0x7E]
    s = ''.join(chr(b) for b in ascii_bytes)
    return s[-17:] if len(s) >= 10 else None

def neg_decode(resp):
    if not resp or resp[0] != NEG_RESPONSE or len(resp) < 3:
        return None
    return NEG_RESPONSE_CODES.get(resp[2], f"0x{resp[2]:02X} (unknown)")

def is_positive(resp, service):
    return bool(resp) and resp[0] == (service + 0x40)

# ═══════════════════════════════════════════════════════════════
# TESTER PRESENT THREAD
# ═══════════════════════════════════════════════════════════════

class TesterPresent:
    def __init__(self, j2534_client, tx_id, rx_id):
        self.j = j2534_client
        self.tx_id = tx_id
        self.rx_id = rx_id
        self.running = False
        self.thread = None

    def start(self):
        self.running = True
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()
        vlog("TesterPresent thread started", "INFO")

    def stop(self):
        self.running = False
        if self.thread:
            self.thread.join(timeout=3)
        vlog("TesterPresent thread stopped", "INFO")

    def _loop(self):
        while self.running:
            time.sleep(2.0)
            if not self.running:
                break
            try:
                self.j.send(self.tx_id, [SID_TESTER_PRESENT, 0x80], timeout=500)
            except Exception:
                pass

# ═══════════════════════════════════════════════════════════════
# CORE OPERATIONS
# ═══════════════════════════════════════════════════════════════

def probe_module(j, tx, rx):
    resp = j.request(tx, rx, [SID_READ_DATA_BY_ID, 0xF1, 0x90], timeout=1500)
    if resp:
        if resp[0] == 0x62:
            return {"found": True, "vin": parse_vin(resp), "method": "VIN"}
        if resp[0] == NEG_RESPONSE and len(resp) > 2 and resp[2] != 0x11:
            return {"found": True, "vin": None, "method": "VIN-NEG"}
    resp = j.request(tx, rx, [SID_TESTER_PRESENT, 0x00], timeout=1000)
    if resp:
        if resp[0] == 0x7E or (resp[0] == NEG_RESPONSE and len(resp) > 2 and resp[2] != 0x11):
            return {"found": True, "vin": None, "method": "TP"}
    return {"found": False}

def scan_all(j):
    log(f"Scanning {len(MODULES)} FCA module addresses...", "INFO")
    print()
    found = []
    seen = set()
    for code, (tx, rx, desc) in MODULES.items():
        if (tx, rx) in seen:
            continue
        seen.add((tx, rx))
        r = probe_module(j, tx, rx)
        if r["found"]:
            vin = r.get("vin") or "(present)"
            log(f"{code:<10} TX:0x{tx:03X} RX:0x{rx:03X}  {desc:<38} {vin}", "FOUND")
            found.append({"code": code, "tx": tx, "rx": rx, "name": desc,
                          "vin": vin, "method": r["method"]})
        else:
            vlog(f"{code:<10} TX:0x{tx:03X} RX:0x{rx:03X}  no response", "INFO")
    print()
    log(f"Scan complete: {len(found)} of {len(seen)} addresses responded", "OK")
    return found

def find_bcm(j):
    head("Finding BCM")
    for tx, rx, desc in BCM_CANDIDATES:
        log(f"Probing {desc} at TX:0x{tx:03X} RX:0x{rx:03X}...", "STEP")
        r = probe_module(j, tx, rx)
        if r["found"]:
            log(f"BCM found at TX:0x{tx:03X} RX:0x{rx:03X} ({desc})", "FOUND")
            if r.get("vin"):
                log(f"Current VIN: {r['vin']}", "OK")
            return tx, rx, desc
    log("No BCM address responded", "ERROR")
    return None

def enter_session(j, tx, rx, session=0x03):
    log(f"Entering diagnostic session 0x{session:02X}...", "STEP")
    resp = j.request(tx, rx, [SID_DIAG_SESSION, session], timeout=3000)
    if is_positive(resp, SID_DIAG_SESSION):
        log(f"Session 0x{session:02X} active", "OK")
        return True
    if resp:
        log(f"Session failed: {neg_decode(resp) or 'bad response'}", "ERROR")
    else:
        log("Session failed: no response", "ERROR")
    return False

def request_seed(j, tx, rx, level=0x01):
    log(f"Requesting security seed (level 0x{level:02X})...", "STEP")
    resp = j.request(tx, rx, [SID_SECURITY_ACCESS, level], timeout=3000)
    if not resp:
        log("No response to seed request", "ERROR")
        return None
    if resp[0] == NEG_RESPONSE:
        log(f"Seed request denied: {neg_decode(resp)}", "ERROR")
        return None
    if resp[0] != (SID_SECURITY_ACCESS + 0x40):
        log(f"Unexpected response: 0x{resp[0]:02X}", "ERROR")
        return None
    seed_bytes = resp[2:]
    if not seed_bytes:
        log("Seed response empty - module may already be unlocked", "WARN")
        return b''
    seed_hex = ''.join(f'{b:02X}' for b in seed_bytes)
    log(f"Seed: {seed_hex} ({len(seed_bytes)} bytes)", "OK")
    return bytes(seed_bytes)

def send_key(j, tx, rx, key_bytes, level=0x02):
    vlog(f"Key: {''.join(f'{b:02X}' for b in key_bytes)}", "TX")
    resp = j.request(tx, rx, [SID_SECURITY_ACCESS, level] + list(key_bytes), timeout=3000)
    if not resp:
        return False, "no response"
    if resp[0] == NEG_RESPONSE:
        return False, neg_decode(resp)
    if resp[0] == (SID_SECURITY_ACCESS + 0x40) and len(resp) > 1 and resp[1] == level:
        return True, "accepted"
    return False, f"unexpected 0x{resp[0]:02X}"

def try_unlock(j, tx, rx):
    head("Security Unlock - trying all algorithms")
    seed_bytes = request_seed(j, tx, rx, level=0x01)
    if seed_bytes is None:
        return None
    if not seed_bytes:
        log("Already unlocked", "OK")
        return "already-unlocked"

    if len(seed_bytes) >= 4:
        seed_int = int.from_bytes(seed_bytes[-4:], 'big')
        key_size = 4
    elif len(seed_bytes) >= 2:
        seed_int = int.from_bytes(seed_bytes[-2:], 'big')
        key_size = 2
    else:
        seed_int = seed_bytes[0]
        key_size = 1

    log(f"Seed int: 0x{seed_int:0{key_size*2}X}", "INFO")
    print()

    for name, fn, desc in BCM_ALGORITHMS:
        try:
            key_int = fn(seed_int)
            key_bytes = key_int.to_bytes(max(key_size, 4), 'big')[-key_size:]
            log(f"Try {name:<14} ({desc:<26}) key=0x{int.from_bytes(key_bytes,'big'):0{len(key_bytes)*2}X}", "STEP")
            ok, msg = send_key(j, tx, rx, key_bytes, level=0x02)
            if ok:
                log(f"UNLOCKED with {name}!", "FOUND")
                return name
            vlog(f"  {name}: {msg}", "WARN")
            time.sleep(0.5)
            s = request_seed(j, tx, rx, level=0x01)
            if s is None:
                log("Seed re-request failed - module may be locked out", "ERROR")
                return None
            if s:
                seed_int = int.from_bytes(s[-min(4, len(s)):], 'big')
        except Exception as e:
            vlog(f"  {name}: exception {e}", "ERROR")
    log("All algorithms failed", "ERROR")
    return None

def write_vin_to_did(j, tx, rx, did, vin):
    did_hi = (did >> 8) & 0xFF
    did_lo = did & 0xFF
    vin_bytes = list(vin.encode('ascii'))
    cmd = [SID_WRITE_DATA_BY_ID, did_hi, did_lo] + vin_bytes
    resp = j.request(tx, rx, cmd, timeout=3000)
    if not resp:
        log(f"  DID 0x{did:04X}: no response", "ERROR")
        return False
    if resp[0] == NEG_RESPONSE:
        log(f"  DID 0x{did:04X}: denied - {neg_decode(resp)}", "ERROR")
        return False
    if resp[0] == (SID_WRITE_DATA_BY_ID + 0x40):
        log(f"  DID 0x{did:04X}: written OK", "OK")
        return True
    log(f"  DID 0x{did:04X}: unexpected 0x{resp[0]:02X}", "WARN")
    return False

def read_vin_from_did(j, tx, rx, did):
    did_hi = (did >> 8) & 0xFF
    did_lo = did & 0xFF
    resp = j.request(tx, rx, [SID_READ_DATA_BY_ID, did_hi, did_lo], timeout=2000)
    if not resp or resp[0] == NEG_RESPONSE:
        return None
    if resp[0] == 0x62:
        return parse_vin(resp)
    return None

def ecu_reset(j, tx, rx):
    log("Sending ECU reset...", "STEP")
    resp = j.request(tx, rx, [SID_ECU_RESET, 0x01], timeout=3000)
    if is_positive(resp, SID_ECU_RESET):
        log("ECU reset accepted", "OK")
        return True
    log(f"ECU reset: {neg_decode(resp) or 'no response'}", "WARN")
    return False

# ═══════════════════════════════════════════════════════════════
# BCM WRITE - MAIN FLOW
# ═══════════════════════════════════════════════════════════════

def bcm_write_vin(j, new_vin, force_tx=None, force_rx=None):
    if len(new_vin) != 17:
        log(f"VIN must be 17 characters (got {len(new_vin)})", "ERROR")
        return False
    if not new_vin.isalnum():
        log("VIN must be alphanumeric", "ERROR")
        return False

    new_vin = new_vin.upper()
    head(f"BCM VIN PROGRAMMING - Target: {new_vin}")

    if force_tx and force_rx:
        tx, rx = force_tx, force_rx
        desc = "user-specified"
        log(f"Using forced address TX:0x{tx:03X} RX:0x{rx:03X}", "INFO")
    else:
        result = find_bcm(j)
        if not result:
            return False
        tx, rx, desc = result

    head("Current VIN values")
    for did in BCM_VIN_DIDS:
        cur = read_vin_from_did(j, tx, rx, did)
        log(f"  DID 0x{did:04X}: {cur or '(not readable)'}", "INFO")

    head("Diagnostic Session")
    if not enter_session(j, tx, rx, 0x03):
        log("Cannot enter extended session", "ERROR")
        return False

    tp = TesterPresent(j, tx, rx)
    tp.start()

    try:
        algo_used = try_unlock(j, tx, rx)
        if not algo_used:
            log("Security unlock failed", "ERROR")
            return False

        head(f"Writing VIN: {new_vin}")
        results = {}
        for did in BCM_VIN_DIDS:
            log(f"Writing DID 0x{did:04X}...", "STEP")
            results[did] = write_vin_to_did(j, tx, rx, did, new_vin)
            time.sleep(0.3)

        head("Verification")
        verified = {}
        for did in BCM_VIN_DIDS:
            readback = read_vin_from_did(j, tx, rx, did)
            verified[did] = readback == new_vin
            status = "MATCH" if verified[did] else f"!= {readback or 'no response'}"
            level = "OK" if verified[did] else "WARN"
            log(f"  DID 0x{did:04X}: {status}", level)

        ecu_reset(j, tx, rx)

        head("Summary")
        log(f"BCM at TX:0x{tx:03X} RX:0x{rx:03X} ({desc})", "INFO")
        log(f"Algorithm used: {algo_used}", "INFO")
        log(f"Target VIN: {new_vin}", "INFO")
        log(f"Writes: {sum(results.values())}/{len(results)} succeeded", "INFO")
        log(f"Verified: {sum(verified.values())}/{len(verified)} match", "INFO")
        success = sum(verified.values()) >= 1
        log(f"{'SUCCESS' if success else 'FAILED'}", "OK" if success else "ERROR")
        return success
    finally:
        tp.stop()

# ═══════════════════════════════════════════════════════════════
# CONNECTION
# ═══════════════════════════════════════════════════════════════

def connect_device():
    devs = J2534.find_devices()
    if not devs:
        log("No J2534 devices in Windows registry.", "ERROR")
        log("Install Autel MaxiFlash / MaxiPro J2534 drivers.", "ERROR")
        return None
    device = next(((n, p) for n, p in devs if 'autel' in n.lower()), devs[0])
    log(f"Using J2534: {device[0]}", "INFO")
    j = J2534()
    try:
        j.load(device[1])
    except Exception as e:
        log(f"Failed to load DLL: {e}", "ERROR")
        return None
    if not j.open():
        log("PassThruOpen failed - device connected via USB?", "ERROR")
        return None
    log("Device opened", "OK")
    if not j.connect(baud=500000):
        log("PassThruConnect failed", "ERROR")
        j.close()
        return None
    log("Connected @ 500kbps ISO15765", "OK")
    return j

# ═══════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════

def cmd_devices(args):
    devs = J2534.find_devices()
    if not devs:
        log("No J2534 devices found. Install Autel drivers.", "ERROR")
        return 1
    log(f"Found {len(devs)} J2534 device(s):", "OK")
    for i, (name, path) in enumerate(devs, 1):
        print(f"  {i}. {name}\n     {path}")
    return 0

def cmd_scan(args):
    j = connect_device()
    if not j:
        return 1
    try:
        scan_all(j)
    finally:
        j.close()
    return 0

def cmd_read(args):
    if args.module:
        m = args.module.upper()
        if m not in MODULES:
            log(f"Unknown module '{m}'. Known: {', '.join(sorted(MODULES.keys()))}", "ERROR")
            return 1
        tx, rx, _ = MODULES[m]
        name = m
    else:
        if not (args.tx and args.rx):
            log("Need either <module> or --tx/--rx", "ERROR")
            return 1
        tx = int(args.tx, 0)
        rx = int(args.rx, 0)
        name = f"0x{tx:03X}"
    j = connect_device()
    if not j:
        return 1
    try:
        head(f"Reading VIN from {name}")
        enter_session(j, tx, rx, 0x03)
        for did in [DID_VIN_F190, DID_VIN_7B90, DID_VIN_7B88]:
            vin = read_vin_from_did(j, tx, rx, did)
            log(f"DID 0x{did:04X}: {vin or '(no response)'}", "FOUND" if vin else "WARN")
    finally:
        j.close()
    return 0

def cmd_probe(args):
    tx = int(args.tx, 0)
    rx = int(args.rx, 0)
    j = connect_device()
    if not j:
        return 1
    try:
        r = probe_module(j, tx, rx)
        if r["found"]:
            log(f"Module responded at 0x{tx:03X}/0x{rx:03X} ({r['method']})", "FOUND")
            if r.get("vin"):
                log(f"VIN: {r['vin']}", "FOUND")
        else:
            log(f"No response from 0x{tx:03X}/0x{rx:03X}", "WARN")
    finally:
        j.close()
    return 0

def cmd_monitor(args):
    j = connect_device()
    if not j:
        return 1
    try:
        log(f"Monitoring CAN for {args.duration}s...", "INFO")
        mask = PASSTHRU_MSG()
        mask.ProtocolID = PROTOCOL_CAN
        mask.DataSize = 4
        pattern = PASSTHRU_MSG()
        pattern.ProtocolID = PROTOCOL_CAN
        pattern.DataSize = 4
        fid = c_ulong(0)
        j.dll.PassThruStartMsgFilter(j.channel_id, PASS_FILTER, byref(mask), byref(pattern), None, byref(fid))
        if fid.value:
            j.filters.append(fid.value)
        seen = {}
        deadline = time.time() + args.duration
        while time.time() < deadline:
            can_id, data = j.recv(500)
            if can_id is not None:
                seen[can_id] = seen.get(can_id, 0) + 1
        print()
        log(f"Seen {len(seen)} unique CAN IDs:", "OK")
        for cid in sorted(seen):
            print(f"    0x{cid:03X}  ({seen[cid]} frames)")
    finally:
        j.close()
    return 0

def cmd_unlock_test(args):
    m = args.module.upper()
    if m not in MODULES:
        log(f"Unknown module '{m}'", "ERROR")
        return 1
    tx, rx, _ = MODULES[m]
    j = connect_device()
    if not j:
        return 1
    try:
        head(f"Unlock test - {m} at TX:0x{tx:03X} RX:0x{rx:03X}")
        if not enter_session(j, tx, rx, 0x03):
            return 1
        algo = try_unlock(j, tx, rx)
        if algo:
            log(f"SUCCESS: {m} unlocks with {algo}", "FOUND")
        else:
            log(f"FAILED: no algorithm worked on {m}", "ERROR")
    finally:
        j.close()
    return 0

def cmd_bcm_write(args):
    j = connect_device()
    if not j:
        return 1
    try:
        force_tx = int(args.tx, 0) if args.tx else None
        force_rx = int(args.rx, 0) if args.rx else None
        ok = bcm_write_vin(j, args.vin, force_tx, force_rx)
        return 0 if ok else 2
    finally:
        j.close()

# ═══════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════

def main():
    global VERBOSE
    p = argparse.ArgumentParser(
        description="SRT LAB v2 - J2534 BCM VIN Programmer",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""Examples:
  python srt_lab.py devices
  python srt_lab.py scan
  python srt_lab.py scan -v
  python srt_lab.py read ECM
  python srt_lab.py read --tx 0x750 --rx 0x758
  python srt_lab.py monitor --duration 10
  python srt_lab.py unlock-test BCM
  python srt_lab.py bcm-write --vin 2C3CCAGG0GH167935
""")
    p.add_argument('-v', '--verbose', action='store_true', help='Show every TX/RX byte')
    sub = p.add_subparsers(dest='command', required=True)

    sub.add_parser('devices', help='List J2534 devices')
    sub.add_parser('scan', help='Scan all FCA modules')

    rd = sub.add_parser('read', help='Read VIN from module')
    rd.add_argument('module', nargs='?')
    rd.add_argument('--tx')
    rd.add_argument('--rx')

    pr = sub.add_parser('probe', help='Probe one address')
    pr.add_argument('--tx', required=True)
    pr.add_argument('--rx', required=True)

    mo = sub.add_parser('monitor', help='Passive CAN monitor')
    mo.add_argument('--duration', type=int, default=5)

    ut = sub.add_parser('unlock-test', help='Test security unlock')
    ut.add_argument('module')

    bw = sub.add_parser('bcm-write', help='Write VIN to BCM (full sequence)')
    bw.add_argument('--vin', required=True)
    bw.add_argument('--tx')
    bw.add_argument('--rx')

    args = p.parse_args()
    VERBOSE = args.verbose

    dispatch = {
        'devices': cmd_devices,
        'scan': cmd_scan,
        'read': cmd_read,
        'probe': cmd_probe,
        'monitor': cmd_monitor,
        'unlock-test': cmd_unlock_test,
        'bcm-write': cmd_bcm_write,
    }
    return dispatch[args.command](args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n[!] Interrupted")
        sys.exit(130)
