"""
SRT Lab ECM/PCM/TCM VIN writer — single-module CLI over J2534.

Wraps the 10 verified canflash unlock algorithms (srtlab_canflash_algos.py) in
a complete UDS flow:
    1. UDS 10 03  — enter extended diagnostic session
    2. UDS 3E 00  — tester present
    3. UDS 27 01  — request security seed
    4. Local unlock algo  → compute 4-byte key
    5. UDS 27 02  — send key, receive 'unlocked' positive response
    6. UDS 2E F190 <17-byte VIN>  — write VIN by DID
    7. UDS 11 01  — ECU reset to commit

Designed for ONE module at a time. No cross-module orchestration. No proxi 
sync. You point it at an ECM, TCM, PTCM, or whatever, and it does that ONE 
module. Use for donor module VIN matching during salvage rebuild work.

TRANSPORT LAYER: Uses J2534 PassThru via ctypes on Windows. Tested targets:
Autel MaxiFlash Elite, Autel MaxiFlash JVCI, DrewLinQ/OpenPort. Any J2534 DLL.

USAGE (as a library):
    from srtlab_ecm_vin_write import write_vin_to_module, scan, MODULES
    
    write_vin_to_module('cummins_849', '3C7WRTCL5KG564882', j2534_dll_path=...)

USAGE (CLI):
    python srtlab_ecm_vin_write.py --scan
    python srtlab_ecm_vin_write.py --module cummins_849 --vin 3C7WRTCL5KG564882
    python srtlab_ecm_vin_write.py --tx 0x7E0 --rx 0x7E8 --algo gpec --vin 1C4RJFN92JC337221

REQUIREMENTS:
    Windows (J2534 is Windows-only for now)
    Python 3.8+
    J2534 pass-thru device with installed DLL

SAFETY:
    - Module MUST have valid key attempts remaining (usually 3 wrong keys = lockout)
    - Ignition must be RUN, not just ACC
    - On 2018+ vehicles behind SGW at 0x74F, use the SGW bridge first — this
      tool doesn't route through SGW automatically, so you'll get 7F 27 33
      "security access denied" until you're past the gateway
    - Some modules (Cummins 2014+, EDC17) may accept VIN write but refuse to 
      boot normally next key cycle — verify before committing to a used donor
"""

import argparse
import ctypes
import re
import sys
import time
from ctypes import c_uint32, c_long, c_void_p, POINTER, byref, sizeof, Structure, c_ubyte

from srtlab_canflash_algos import CANFLASH_ALGOS

# Optional: richer NRC decoding + context-aware diagnosis
try:
    from srtlab_uds_errors import decode_nrc, diagnose
    _HAVE_ERRORS = True
except ImportError:
    _HAVE_ERRORS = False
    decode_nrc = lambda n: NEG_RESPONSE_NAMES.get(n, '?')
    def diagnose(**kwargs): return []

# Try to pull in the full 81-module catalog for broader coverage
try:
    from srtlab_unlock_catalog import MODULE_INFO, unlock as _catalog_unlock
    _HAVE_CATALOG = True
except ImportError:
    _HAVE_CATALOG = False

# Common locations for Autel MFBT432.dll (MaxiFlash Elite J2534)
AUTEL_DLL_SEARCH_PATHS = [
    r'C:\Program Files (x86)\Autel\MaxiSys\Maxi PC Suit\MFBT432.dll',
    r'C:\Program Files (x86)\Autel\MaxiIM\Maxi PC Suit\MFBT432.dll',
    r'C:\Program Files (x86)\Autel\MaxiFlash\Maxi PC Suit\MFBT432.dll',
    r'C:\Program Files (x86)\Autel\MaxiPro\Maxi PC Suit\MFBT432.dll',
    r'C:\Program Files\Autel\MaxiSys\Maxi PC Suit\MFBT432.dll',
    r'C:\Autel\Maxi PC Suit\MFBT432.dll',
    # Alternate Autel J2534 DLLs (for other hardware in their lineup)
    r'C:\Program Files (x86)\Autel\Maxi PC Suit\JVCI432.dll',
    r'C:\Program Files (x86)\Autel\Maxi PC Suit\JVCIPLUS432.dll',
    r'C:\Program Files (x86)\Autel\Maxi PC Suit\LVCI432.dll',
    # Other common J2534 DLLs
    r'C:\Windows\SysWOW64\op20pt32.dll',  # OpenPort / Drew Tech
    r'C:\Program Files (x86)\Drew Technologies, Inc\J2534\DrewTech MongoosePro JLR\mongoose.dll',
]


def find_j2534_dll():
    """Scan common install locations for a J2534 DLL. Returns first found or None."""
    import os
    for path in AUTEL_DLL_SEARCH_PATHS:
        if os.path.isfile(path):
            return path
    return None



# ═══════════════════════════════════════════════════════════════════════
# J2534 constants
# ═══════════════════════════════════════════════════════════════════════
PROTOCOL_ISO15765 = 6
ISO15765_FRAME_PAD = 0x00000040
FLOW_CONTROL_FILTER = 3
CAN_29BIT_ID = 0x00000100  # if needed for some commercial platforms

STMIN_TX = 0
BS_RX = 0

CLEAR_RX_BUFFER = 0x00000008

# UDS services
SID_DIAG_SESSION       = 0x10
SID_ECU_RESET          = 0x11
SID_SECURITY_ACCESS    = 0x27
SID_READ_DATA_BY_ID    = 0x22
SID_WRITE_DATA_BY_ID   = 0x2E
SID_ROUTINE_CONTROL    = 0x31
SID_TESTER_PRESENT     = 0x3E
NEG_RESPONSE           = 0x7F

DID_VIN_F190 = 0xF190

NEG_RESPONSE_NAMES = {
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


# ═══════════════════════════════════════════════════════════════════════
# PASSTHRU_MSG structure
# ═══════════════════════════════════════════════════════════════════════
class PASSTHRU_MSG(Structure):
    _fields_ = [
        ("ProtocolID",     c_uint32),
        ("RxStatus",       c_uint32),
        ("TxFlags",        c_uint32),
        ("Timestamp",      c_uint32),
        ("DataSize",       c_uint32),
        ("ExtraDataIndex", c_uint32),
        ("Data",           c_ubyte * 4128),
    ]


class SCONFIG(Structure):
    _fields_ = [("Parameter", c_uint32), ("Value", c_uint32)]


class SCONFIG_LIST(Structure):
    _fields_ = [("NumOfParams", c_uint32), ("ConfigPtr", POINTER(SCONFIG))]


# ═══════════════════════════════════════════════════════════════════════
# Module metadata  
# ═══════════════════════════════════════════════════════════════════════
# Build MODULES from the full unlock catalog (all 81 modules).
# Each entry references the catalog's unlock() which dispatches to native Python
# when available, otherwise emulates the original DLL via Unicorn.
MODULES = {}

if _HAVE_CATALOG:
    for key, info in MODULE_INFO.items():
        MODULES[key] = {
            'label':    info['label'],
            'tx':       info['tx'],
            'rx':       info['rx'],
            'category': info['category'],
            'unlock':   (lambda k: lambda s, a=0: _catalog_unlock(k, s, a))(key),
            'vin_did':  DID_VIN_F190,
            'session':  0x03,
        }
else:
    for key, cfg in CANFLASH_ALGOS.items():
        MODULES[key] = {
            'label':    cfg['label'],
            'tx':       cfg['tx'],
            'rx':       cfg['rx'],
            'category': 'unknown',
            'unlock':   cfg['fn'],
            'vin_did':  DID_VIN_F190,
            'session':  0x03,
        }

# Per-module overrides
if 'cummins_849' in MODULES:
    MODULES['cummins_849']['session'] = 0x02  # programming session for VIN write


# ═══════════════════════════════════════════════════════════════════════
# J2534 wrapper — minimal surface, opens device + channel, send/recv
# ═══════════════════════════════════════════════════════════════════════
class J2534:
    def __init__(self, dll_path):
        if not sys.platform.startswith('win'):
            print("WARNING: J2534 is Windows-only. Running in dry-run mode.", file=sys.stderr)
            self.dll = None
            self.dry_run = True
            return
        self.dry_run = False
        self.dll = ctypes.WinDLL(dll_path)
        # J2534-04.04 function signatures. `long` in the spec is a signed 32-bit
        # return code; on Windows (where J2534 DLLs live) `long` == 32 bits, so
        # c_long (= c_int32 on Windows) is correct. We also use c_uint32 for
        # DWORD args rather than c_ulong to avoid the c_ulong=8 bytes trap on
        # 64-bit POSIX hosts during offline development.
        self.dll.PassThruOpen.argtypes    = [c_void_p, POINTER(c_uint32)]
        self.dll.PassThruOpen.restype     = c_long
        self.dll.PassThruClose.argtypes   = [c_uint32]
        self.dll.PassThruClose.restype    = c_long
        self.dll.PassThruConnect.argtypes = [c_uint32, c_uint32, c_uint32, c_uint32, POINTER(c_uint32)]
        self.dll.PassThruConnect.restype  = c_long
        self.dll.PassThruDisconnect.argtypes = [c_uint32]
        self.dll.PassThruDisconnect.restype  = c_long
        self.dll.PassThruReadMsgs.argtypes   = [c_uint32, POINTER(PASSTHRU_MSG), POINTER(c_uint32), c_uint32]
        self.dll.PassThruReadMsgs.restype    = c_long
        self.dll.PassThruWriteMsgs.argtypes  = [c_uint32, POINTER(PASSTHRU_MSG), POINTER(c_uint32), c_uint32]
        self.dll.PassThruWriteMsgs.restype   = c_long
        self.dll.PassThruStartMsgFilter.argtypes = [c_uint32, c_uint32, POINTER(PASSTHRU_MSG), POINTER(PASSTHRU_MSG), POINTER(PASSTHRU_MSG), POINTER(c_uint32)]
        self.dll.PassThruStartMsgFilter.restype  = c_long
        self.dll.PassThruIoctl.argtypes = [c_uint32, c_uint32, c_void_p, c_void_p]
        self.dll.PassThruIoctl.restype  = c_long
        
        self.device_id = c_uint32(0)
        self.channel_id = c_uint32(0)
    
    def open(self):
        if self.dry_run: return
        r = self.dll.PassThruOpen(None, byref(self.device_id))
        if r != 0: raise RuntimeError(f"PassThruOpen failed: 0x{r:08X}")
    
    def close(self):
        if self.dry_run: return
        if self.channel_id.value:
            self.dll.PassThruDisconnect(self.channel_id)
        if self.device_id.value:
            self.dll.PassThruClose(self.device_id)
    
    def connect_iso15765(self, baud=500000):
        if self.dry_run: return
        r = self.dll.PassThruConnect(self.device_id, PROTOCOL_ISO15765, 0, c_uint32(baud), byref(self.channel_id))
        if r != 0: raise RuntimeError(f"PassThruConnect failed: 0x{r:08X}")
    
    def set_flow_control(self, tx_id, rx_id):
        """Install a flow-control filter so the J2534 layer handles ISO-15765 multi-frame."""
        if self.dry_run: return
        mask = PASSTHRU_MSG()
        mask.ProtocolID = PROTOCOL_ISO15765
        mask.TxFlags = ISO15765_FRAME_PAD
        mask.DataSize = 4
        for i, b in enumerate([0xFF, 0xFF, 0xFF, 0xFF]): mask.Data[i] = b
        
        pattern = PASSTHRU_MSG()
        pattern.ProtocolID = PROTOCOL_ISO15765
        pattern.TxFlags = ISO15765_FRAME_PAD
        pattern.DataSize = 4
        for i, b in enumerate([(rx_id >> 24) & 0xFF, (rx_id >> 16) & 0xFF,
                               (rx_id >> 8) & 0xFF, rx_id & 0xFF]): pattern.Data[i] = b
        
        flow = PASSTHRU_MSG()
        flow.ProtocolID = PROTOCOL_ISO15765
        flow.TxFlags = ISO15765_FRAME_PAD
        flow.DataSize = 4
        for i, b in enumerate([(tx_id >> 24) & 0xFF, (tx_id >> 16) & 0xFF,
                               (tx_id >> 8) & 0xFF, tx_id & 0xFF]): flow.Data[i] = b
        
        fid = c_uint32(0)
        r = self.dll.PassThruStartMsgFilter(self.channel_id, FLOW_CONTROL_FILTER,
                                             byref(mask), byref(pattern), byref(flow), byref(fid))
        if r != 0: raise RuntimeError(f"StartMsgFilter failed: 0x{r:08X}")
    
    def write_uds(self, tx_id, uds_bytes):
        """Send one UDS request. J2534 handles ISO-15765 framing."""
        if self.dry_run:
            print(f"    [DRY-RUN] TX {tx_id:03X}: {' '.join(f'{b:02X}' for b in uds_bytes)}")
            return
        msg = PASSTHRU_MSG()
        msg.ProtocolID = PROTOCOL_ISO15765
        msg.TxFlags = ISO15765_FRAME_PAD
        payload = bytes([(tx_id >> 24) & 0xFF, (tx_id >> 16) & 0xFF,
                         (tx_id >>  8) & 0xFF,  tx_id        & 0xFF]) + bytes(uds_bytes)
        msg.DataSize = len(payload)
        for i, b in enumerate(payload): msg.Data[i] = b
        n = c_uint32(1)
        r = self.dll.PassThruWriteMsgs(self.channel_id, byref(msg), byref(n), c_uint32(1000))
        if r != 0: raise RuntimeError(f"PassThruWriteMsgs failed: 0x{r:08X}")
    
    def read_uds(self, timeout_ms=4000, expected_rx=None):
        """Read a UDS response, handling 7F 78 response-pending loops."""
        if self.dry_run:
            print(f"    [DRY-RUN] RX timeout (no device)")
            return None
        deadline = time.time() + timeout_ms / 1000.0
        while time.time() < deadline:
            msg = PASSTHRU_MSG()
            msg.ProtocolID = PROTOCOL_ISO15765
            n = c_uint32(1)
            remaining = max(10, int((deadline - time.time()) * 1000))
            r = self.dll.PassThruReadMsgs(self.channel_id, byref(msg), byref(n), c_uint32(remaining))
            if r != 0:
                if r == 0x10:  # ERR_BUFFER_EMPTY
                    time.sleep(0.005)
                    continue
                raise RuntimeError(f"PassThruReadMsgs failed: 0x{r:08X}")
            if n.value == 0: continue
            # J2534 echoes TX messages back with RxStatus bit 0 (TX_MSG_TYPE) set.
            # Also skip any "start of indication" (bit 9) and "load" flags. We only
            # want real incoming diagnostic frames.
            TX_MSG_TYPE = 0x00000001
            START_OF_MESSAGE = 0x00000002  # first frame of multi-frame
            if msg.RxStatus & TX_MSG_TYPE:
                continue  # our own transmit echoing back
            if msg.RxStatus & START_OF_MESSAGE:
                continue  # wait for the full assembled frame
            data = bytes(msg.Data[:msg.DataSize])
            if len(data) < 5: continue
            arb_id = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]
            payload = data[4:]
            if expected_rx is not None and arb_id != expected_rx:
                continue  # stray frame
            # Handle response-pending
            if len(payload) >= 3 and payload[0] == NEG_RESPONSE and payload[2] == 0x78:
                continue  # keep waiting
            return payload
        return None


# ═══════════════════════════════════════════════════════════════════════
# UDS transactions (service-level)
# ═══════════════════════════════════════════════════════════════════════

def log(msg, tag='INFO'):
    print(f"[{tag}] {msg}")


def enter_diag_session(j, tx, rx, subfn):
    j.write_uds(tx, [SID_DIAG_SESSION, subfn])
    resp = j.read_uds(expected_rx=rx)
    if resp is None:
        return False, "no response"
    if resp[0] == NEG_RESPONSE:
        nrc = resp[2] if len(resp) > 2 else 0
        return False, f"NRC 0x{nrc:02X} {decode_nrc(nrc)}"
    return True, None


def tester_present(j, tx):
    j.write_uds(tx, [SID_TESTER_PRESENT, 0x00])


def request_seed(j, tx, rx, subfn=0x01):
    j.write_uds(tx, [SID_SECURITY_ACCESS, subfn])
    resp = j.read_uds(expected_rx=rx)
    if resp is None: return None, "no response"
    if resp[0] == NEG_RESPONSE:
        nrc = resp[2] if len(resp) > 2 else 0
        return None, f"NRC 0x{nrc:02X} {decode_nrc(nrc)}"
    if resp[0] != 0x67 or resp[1] != subfn:
        return None, f"unexpected response {resp[:2].hex()}"
    seed_bytes = resp[2:]
    if len(seed_bytes) < 4:
        return None, f"seed too short ({len(seed_bytes)} bytes)"
    return seed_bytes, None


def send_key(j, tx, rx, key_bytes, subfn=0x02):
    j.write_uds(tx, [SID_SECURITY_ACCESS, subfn] + list(key_bytes))
    resp = j.read_uds(expected_rx=rx)
    if resp is None: return False, "no response"
    if resp[0] == NEG_RESPONSE:
        nrc = resp[2] if len(resp) > 2 else 0
        return False, f"NRC 0x{nrc:02X} {decode_nrc(nrc)}"
    return (resp[0] == 0x67 and resp[1] == subfn), None


def write_vin(j, tx, rx, vin17, did=DID_VIN_F190):
    assert len(vin17) == 17
    msg = [SID_WRITE_DATA_BY_ID, (did >> 8) & 0xFF, did & 0xFF] + list(vin17.encode('ascii'))
    j.write_uds(tx, msg)
    resp = j.read_uds(expected_rx=rx, timeout_ms=6000)
    if resp is None: return False, "no response"
    if resp[0] == NEG_RESPONSE:
        nrc = resp[2] if len(resp) > 2 else 0
        return False, f"NRC 0x{nrc:02X} {decode_nrc(nrc)}"
    return (resp[0] == 0x6E), None


def ecu_reset(j, tx, rx, subfn=0x01):
    j.write_uds(tx, [SID_ECU_RESET, subfn])
    resp = j.read_uds(expected_rx=rx, timeout_ms=3000)
    # Some modules don't respond — they just reset. Return success if no neg.
    if resp is None: return True, None  # treat silence as reset-in-progress
    if resp[0] == NEG_RESPONSE:
        nrc = resp[2] if len(resp) > 2 else 0
        return False, f"NRC 0x{nrc:02X} {decode_nrc(nrc)}"
    return True, None


def read_vin(j, tx, rx, did=DID_VIN_F190):
    j.write_uds(tx, [SID_READ_DATA_BY_ID, (did >> 8) & 0xFF, did & 0xFF])
    resp = j.read_uds(expected_rx=rx)
    if resp is None: return None, "no response"
    if resp[0] == NEG_RESPONSE:
        nrc = resp[2] if len(resp) > 2 else 0
        return None, f"NRC 0x{nrc:02X} {decode_nrc(nrc)}"
    if resp[0] != 0x62: return None, f"unexpected response {resp[:1].hex()}"
    data = resp[3:]  # skip 0x62 + DID high + DID low
    try:
        return data[:17].decode('ascii'), None
    except UnicodeDecodeError:
        return None, f"VIN bytes not ASCII: {data[:17].hex()}"


# ═══════════════════════════════════════════════════════════════════════
# Complete VIN-write workflow for ONE module
# ═══════════════════════════════════════════════════════════════════════

def _validate_vin(vin):
    v = vin.upper().strip()
    if len(v) != 17:
        raise ValueError(f'VIN must be 17 chars, got {len(v)}')
    allowed = set('ABCDEFGHJKLMNPRSTUVWXYZ0123456789')
    bad = [c for c in v if c not in allowed]
    if bad:
        raise ValueError(f'VIN contains invalid chars: {bad}')
    return v


# Modules that carry crash/deployment data. Writing VIN to these without
# first clearing EDR data commonly results in NRC 0x22 (Conditions Not Correct).
_AIRBAG_MODULES = {'bosch_orc', 'trw_orc', 'ocm', 'trw_ocm',
                   'bosch_orc_2015', 'dart_orc'}


def write_vin_to_module(module_key, vin, j2534_dll_path=None, tx=None, rx=None, algo=None,
                        dry_run=False, verify=True, vin_did=None, session=None):
    """Complete VIN write to a single module.
    
    Args:
        module_key: key from MODULES (e.g. 'cummins_849', 'gpec', 'ngc_engine').
                    If None, must provide tx/rx/algo explicitly.
        vin: 17-char VIN string
        j2534_dll_path: path to J2534 DLL (e.g. C:/Windows/SysWOW64/op20pt32.dll)
        tx, rx: override CAN addresses (optional)
        algo: override algorithm name (optional)
        dry_run: print what would be done without touching hardware
        verify: read VIN back after write and compare
        vin_did: override the UDS DID for VIN write (default: 0xF190 standard).
                 Use srtlab_uconnect_scan.py to find the right DID for a module.
    
    Returns:
        dict with 'success', 'log', 'vin_before', 'vin_after', 'algo_used'
    """
    vin = _validate_vin(vin)
    
    if module_key:
        if module_key not in MODULES:
            raise KeyError(f'Unknown module {module_key}. Known: {sorted(MODULES)}')
        mod = MODULES[module_key]
        tx = tx or mod['tx']
        rx = rx or mod['rx']
        algo_fn = mod['unlock']
        algo_name = module_key
        session_sub = session if session is not None else mod['session']
        effective_did = vin_did if vin_did is not None else mod.get('vin_did', DID_VIN_F190)
    else:
        if not (tx and rx and algo):
            raise ValueError("Must provide module_key OR (tx, rx, algo)")
        if algo not in CANFLASH_ALGOS:
            raise KeyError(f'Unknown algo {algo}')
        algo_fn = CANFLASH_ALGOS[algo]['fn']
        algo_name = algo
        session_sub = session if session is not None else 0x03
        effective_did = vin_did if vin_did is not None else DID_VIN_F190
    
    report = {'success': False, 'log': [], 'vin_before': None, 'vin_after': None,
              'algo_used': algo_name, 'tx': tx, 'rx': rx}
    
    def l(m, tag='INFO'):
        report['log'].append(f'[{tag}] {m}')
        log(m, tag)
    
    l(f'Module: {algo_name} — tx=0x{tx:03X} rx=0x{rx:03X}, VIN DID=0x{effective_did:04X}')
    l(f'Target VIN: {vin}')
    
    # Airbag module pre-flight: warn if this is an ORC/OCM that may have stored
    # crash data. Without clearing first, VIN write typically returns NRC 0x22.
    if module_key in _AIRBAG_MODULES:
        l('⚠️  This is an airbag/OCM module. If it has stored crash data, VIN write', 'WARN')
        l('    will likely be rejected with NRC 0x22 (Conditions Not Correct).', 'WARN')
        l('    Run srtlab_orc_clear.py first to clear the event data:', 'WARN')
        l(f'        python srtlab_orc_clear.py --module {module_key}', 'WARN')
    
    j = J2534(j2534_dll_path) if not dry_run else None
    if dry_run:
        class Dry: 
            dry_run = True
            def open(self): pass
            def close(self): pass
            def connect_iso15765(self, **k): pass
            def set_flow_control(self, *a): pass
            def write_uds(self, tx, b): print(f"    [DRY] TX {tx:03X}: {' '.join(f'{x:02X}' for x in b)}")
            def read_uds(self, **k): return None
        j = Dry()
    
    try:
        j.open()
        j.connect_iso15765()
        j.set_flow_control(tx, rx)
        l('J2534 channel open')
        
        # Step 0: read current VIN (optional, non-blocking)
        if not dry_run:
            cur, err = read_vin(j, tx, rx)
            if cur:
                report['vin_before'] = cur
                l(f'Current VIN: {cur}')
            else:
                l(f'Current VIN read failed: {err}', 'WARN')
        
        # Step 1: diag session
        ok, err = enter_diag_session(j, tx, rx, session_sub) if not dry_run else (True, None)
        if not ok:
            l(f'Diag session failed: {err}', 'ERROR')
            return report
        l(f'Diag session 0x{session_sub:02X} accepted')
        
        # Step 2: tester present
        if not dry_run: tester_present(j, tx)
        
        # Step 3: seed request
        if dry_run:
            seed_bytes = b'\xDE\xAD\xBE\xEF'
            l(f'Seed (dry-run placeholder): {seed_bytes.hex().upper()}')
        else:
            seed_bytes, err = request_seed(j, tx, rx)
            if seed_bytes is None:
                l(f'Seed request failed: {err}', 'ERROR')
                return report
            l(f'Seed: {seed_bytes.hex().upper()}')
        
        # Step 4: compute key
        seed_int = int.from_bytes(seed_bytes[:4], 'big')
        key_int = algo_fn(seed_int)
        key_bytes = key_int.to_bytes(4, 'big')
        l(f'Key:  {key_bytes.hex().upper()} (via {algo_name})')
        
        # Step 5: send key
        if not dry_run:
            ok, err = send_key(j, tx, rx, key_bytes)
            if not ok:
                l(f'Key rejected: {err}', 'ERROR')
                return report
        l('Security access GRANTED')
        
        # Step 6: write VIN
        if not dry_run:
            ok, err = write_vin(j, tx, rx, vin, did=effective_did)
            if not ok:
                l(f'VIN write failed: {err}', 'ERROR')
                return report
        l(f'VIN write accepted')
        
        # Step 7: reset
        if not dry_run:
            ok, err = ecu_reset(j, tx, rx)
            if not ok:
                l(f'ECU reset failed: {err}', 'WARN')
            else:
                l('ECU reset requested')
        
        # Step 8: verify
        if verify and not dry_run:
            time.sleep(2.0)  # allow reset
            j.set_flow_control(tx, rx)  # re-establish filter
            new_vin, err = read_vin(j, tx, rx, did=effective_did)
            report['vin_after'] = new_vin
            if new_vin == vin:
                l(f'Verified new VIN: {new_vin}')
                report['success'] = True
            else:
                l(f'Verification failed (got {new_vin}, expected {vin})', 'ERROR')
        else:
            report['success'] = True  # dry-run or no-verify
    finally:
        try: j.close()
        except Exception: pass
    
    return report


# ═══════════════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════════════

def main():
    ap = argparse.ArgumentParser(description='SRT Lab ECM/PCM/TCM VIN writer (single module)')
    ap.add_argument('--module', help='Module key (see --list). Sets tx/rx/algo automatically.')
    ap.add_argument('--tx', help='CAN tx ID (hex), e.g. 0x7E0')
    ap.add_argument('--rx', help='CAN rx ID (hex), e.g. 0x7E8')
    ap.add_argument('--algo', help='Unlock algorithm name (see --list)')
    ap.add_argument('--vin', help='17-char VIN to write')
    default_dll = find_j2534_dll() or r'C:\Windows\SysWOW64\op20pt32.dll'
    ap.add_argument('--dll', default=default_dll,
                    help=f'J2534 DLL path. Auto-detected: {default_dll}')
    ap.add_argument('--list', action='store_true', help='List supported modules')
    ap.add_argument('--dry-run', action='store_true', help='Print without touching hardware')
    ap.add_argument('--no-verify', action='store_true', help='Skip VIN read-back after write')
    ap.add_argument('--vin-did', help='Override VIN DID (hex, e.g. 0xF190). Use srtlab_module_scan.py to discover it for a specific module.')
    ap.add_argument('--session', help='Override diagnostic session (hex). Defaults: 0x03 extended, Cummins uses 0x02 programming. Some airbag/safety modules need 0x02.')
    ap.add_argument('--scan-first', action='store_true', help='Run a read-only scan of the module before writing, and auto-detect the VIN DID')
    ap.add_argument('--scan-only', action='store_true', help='Scan only, do not write (equivalent to srtlab_module_scan.py)')
    args = ap.parse_args()
    
    if args.list:
        print(f"\n{'module_key':<20s} {'tx':<6s} {'rx':<6s} session  description")
        print('-' * 70)
        for k, m in MODULES.items():
            rx = f'0x{m["rx"]:03X}' if m['rx'] else '(passive)'
            print(f"  {k:<18s} 0x{m['tx']:03X}  {rx:<6s} 0x{m['session']:02X}     {m['label']}")
        return 0
    
    if not args.vin:
        ap.error('--vin required (or use --list)')
    
    kwargs = dict(
        module_key=args.module,
        vin=args.vin,
        j2534_dll_path=args.dll,
        dry_run=args.dry_run,
        verify=not args.no_verify,
    )
    if args.vin_did: kwargs['vin_did'] = int(args.vin_did, 0)
    if args.session: kwargs['session'] = int(args.session, 0)
    if args.tx: kwargs['tx'] = int(args.tx, 0)
    if args.rx: kwargs['rx'] = int(args.rx, 0)
    if args.algo: kwargs['algo'] = args.algo
    
    # Optional pre-flight scan
    if args.scan_first or args.scan_only:
        try:
            from srtlab_module_scan import scan_module
            scan_result = scan_module(
                dll_path=args.dll,
                module_key=args.module,
                tx=int(args.tx, 0) if args.tx else None,
                rx=int(args.rx, 0) if args.rx else None,
                dry_run=args.dry_run,
            )
            if args.scan_only:
                return 0
            # Auto-fill vin_did if scan found a VIN and user didn't set one
            if scan_result and scan_result.get('vins') and 'vin_did' not in kwargs:
                discovered_did = scan_result['vins'][0][0]
                print(f'\n→ Auto-using --vin-did 0x{discovered_did:04X} from scan\n')
                kwargs['vin_did'] = discovered_did
        except ImportError:
            print('srtlab_module_scan.py not found — continuing without scan')
    
    report = write_vin_to_module(**kwargs)
    print()
    if report['success']:
        print(f"✓ SUCCESS  — {report['algo_used']} module VIN written to {args.vin}")
        return 0
    else:
        print(f"✗ FAILED   — see log above")
        return 1


if __name__ == '__main__':
    if len(sys.argv) == 1:
        # Self-test — dry-run every module
        print("SRT Lab ECM VIN writer — dry-run self-test\n" + '='*60)
        test_vin = '3C7WRTCL5KG564882'
        for k in ['cummins_849', 'ngc_engine', 'gpec', 'aisin_tcm']:
            print(f"\n--- {k} ---")
            r = write_vin_to_module(k, test_vin, dry_run=True, verify=False)
            print(f"  algo={r['algo_used']}  tx=0x{r['tx']:03X}  success={r['success']}")
    else:
        sys.exit(main())
