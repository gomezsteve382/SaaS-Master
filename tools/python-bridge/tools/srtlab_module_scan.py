"""
SRT Lab universal module scanner.

Read-only pre-flight check for ANY of the 81 FCA modules in the catalog. Run
BEFORE any write operation to:
  1. Verify the module is on the bus at the expected CAN address
  2. Identify the supplier (confirms which unlock algorithm to use)
  3. Discover which DIDs hold the VIN / part numbers / config
  4. Check whether unlock is required
  5. Read current values (useful for before/after comparison)

Never writes anything. Never unlocks (just probes what happens if you tried).
Safe on ANY module, in-car or on-bench.

WORKFLOW:
    1. Connect bench/vehicle, J2534 device plugged in
    2. python srtlab_module_scan.py --module <any module from catalog>
    3. Review output → decide what unlock + DID to use for the write
    4. Run srtlab_ecm_vin_write.py with those parameters

USAGE EXAMPLES:
    python srtlab_module_scan.py --module huntsville_bcm
    python srtlab_module_scan.py --module cummins_849
    python srtlab_module_scan.py --module alpine_radio
    python srtlab_module_scan.py --module alpine_radio --tx 0x7A3 --rx 0x7BB  # override
    python srtlab_module_scan.py --scan-all-bcms       # try every BCM tx/rx pair
    python srtlab_module_scan.py --dry-run

Dependencies: same as ECM writer — ctypes + J2534 DLL on Windows.
"""

import argparse
import ctypes
import sys
import time
from ctypes import c_uint32, c_void_p, POINTER, byref, Structure, c_ubyte

try:
    from srtlab_unlock_catalog import MODULE_INFO, unlock as _catalog_unlock
except ImportError:
    MODULE_INFO = {}
    _catalog_unlock = None

try:
    from srtlab_did_decode import DidDecoder
    _did_decoder = DidDecoder()
except (ImportError, FileNotFoundError):
    _did_decoder = None

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



# ─── J2534 constants ───────────────────────────────────────────────────
PROTOCOL_ISO15765 = 6
ISO15765_FRAME_PAD = 0x00000040
FLOW_CONTROL_FILTER = 3

SID_DIAG_SESSION = 0x10
SID_READ_DATA_BY_ID = 0x22
SID_TESTER_PRESENT = 0x3E
SID_SECURITY_ACCESS = 0x27
SID_ECU_RESET = 0x11
NEG_RESPONSE = 0x7F

NRC_NAMES = {
    0x10: 'General reject',
    0x11: 'Service not supported',
    0x12: 'Subfunction not supported',
    0x13: 'Incorrect length',
    0x22: 'Conditions not correct',
    0x24: 'Sequence error',
    0x31: 'Request out of range',
    0x33: 'Security access denied',
    0x35: 'Invalid key',
    0x36: 'Exceeded attempts',
    0x37: 'Time delay not expired',
    0x78: 'Response pending',
}


class PASSTHRU_MSG(Structure):
    _fields_ = [('ProtocolID', c_uint32), ('RxStatus', c_uint32),
                ('TxFlags', c_uint32), ('Timestamp', c_uint32),
                ('DataSize', c_uint32), ('ExtraDataIndex', c_uint32),
                ('Data', c_ubyte * 4128)]


# ─── DID tables ────────────────────────────────────────────────────────

STANDARD_DIDS = [
    (0xF180, 'Boot software ID'),
    (0xF181, 'Application software ID'),
    (0xF182, 'Application data ID'),
    (0xF186, 'Active diagnostic session'),
    (0xF187, 'Vehicle manufacturer spare part number'),
    (0xF188, 'Vehicle manufacturer ECU software number'),
    (0xF189, 'Vehicle manufacturer ECU software version'),
    (0xF18A, 'System supplier ID'),
    (0xF18B, 'ECU manufacturing date'),
    (0xF18C, 'ECU serial number'),
    (0xF190, 'VIN (primary UDS DID)'),
    (0xF191, 'Vehicle manufacturer ECU hardware number'),
    (0xF192, 'System supplier ECU hardware number'),
    (0xF193, 'System supplier ECU hardware version'),
    (0xF194, 'System supplier ECU software number'),
    (0xF195, 'System supplier ECU software version'),
    (0xF197, 'System name or engine type'),
    (0xF199, 'Programming date'),
    (0xF19D, 'ECU installation date'),
]

# FCA-specific DIDs commonly seen across BCM / radio / cluster
FCA_DIDS = [
    (0x7B90, 'VIN (alternate)'),
    (0x7B88, 'Original VIN'),
    (0xF1A0, 'Vehicle config data'),
    (0xF1A1, 'Variant ID / part number'),
    (0xF1A4, 'Flash / calibration ID'),
    (0xF1B4, 'Current session ID'),
    (0xF1C0, 'Build / production VIN'),
    (0xDE00, 'Module variant config'),
    (0xDE01, 'Module secondary config'),
    (0xDE10, 'Feature config A'),
    (0xDE11, 'Feature config B'),
]

# Category-specific DIDs
CATEGORY_DIDS = {
    'powertrain.engine': [
        (0xF40D, 'Vehicle speed'),
        (0xF411, 'Engine coolant temp'),
        (0xF40C, 'Engine RPM'),
    ],
    'powertrain.trans': [
        (0xF40E, 'Transmission temp'),
        (0xF40F, 'Gear position'),
    ],
    'body.bcm': [
        (0xF1B0, 'Odometer'),
        (0xF1B1, 'Country code'),
    ],
    'radio.head': [
        (0xF18F, 'Radio presets'),
        (0xDE20, 'Uconnect build variant'),
    ],
}


# ─── Supplier identification patterns ──────────────────────────────────
# Match strings found in DID responses to the right unlock algorithm

SUPPLIER_PATTERNS = {
    # radios
    'ALPINE':      'alpine_radio',
    'HARMAN':      'huntsville_radio',
    'HUNTSVILLE':  'huntsville_radio',
    'MITSUBISHI':  'mitsubishi_rar',
    'RAK':         'alpine_rak',
    # BCMs
    'LEAR':        'lear_wcm',
    'YAZAKI':      'yazaki_fcm',
    # amps
    'KICKER':      'kicker_amp',
    'VISTEON':     'visteon_amp',
    # brakes / safety
    'BOSCH':       None,  # ambiguous — many Bosch variants
    'TEVES':       'teves_abs',
    'TRW':         None,  # ambiguous — TRW makes many things
    'TEMIC':       None,
    # powertrain
    'CUMMINS':     'cummins_849',
    'EDC16':       None,  # ambiguous between c2/cp31/u31
    # hvac / doors
    'DELPHI':      'delphi_hvac',
    'VALEO':       'valeo_scm',
    'HELLA':       'hella_acc',
    'PEIKER':      'peiker_hfm',
    'NIPPON':      'nippon_ccn',
}


# ─── J2534 wrapper ─────────────────────────────────────────────────────

class J2534:
    def __init__(self, dll_path, dry_run=False):
        self.dry_run = dry_run or not sys.platform.startswith('win')
        self.dll = None
        self.device_id = c_uint32(0)
        self.channel_id = c_uint32(0)
        if self.dry_run:
            return
        self.dll = ctypes.WinDLL(dll_path)
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
        self.dll.PassThruStartMsgFilter.argtypes = [c_uint32, c_uint32, POINTER(PASSTHRU_MSG),
                                                     POINTER(PASSTHRU_MSG), POINTER(PASSTHRU_MSG),
                                                     POINTER(c_uint32)]
        self.dll.PassThruStartMsgFilter.restype  = c_long
        self.dll.PassThruIoctl.argtypes = [c_uint32, c_uint32, c_void_p, c_void_p]
        self.dll.PassThruIoctl.restype  = c_long
    
    def open(self):
        if self.dry_run: return
        r = self.dll.PassThruOpen(None, byref(self.device_id))
        if r != 0: raise RuntimeError(f'PassThruOpen: 0x{r:08X}')
    
    def close(self):
        if self.dry_run: return
        if self.channel_id.value: self.dll.PassThruDisconnect(self.channel_id)
        if self.device_id.value: self.dll.PassThruClose(self.device_id)
    
    def connect(self, baud=500000):
        if self.dry_run: return
        r = self.dll.PassThruConnect(self.device_id, PROTOCOL_ISO15765, 0, c_uint32(baud), byref(self.channel_id))
        if r != 0: raise RuntimeError(f'PassThruConnect: 0x{r:08X}')
    
    def set_flow(self, tx, rx):
        if self.dry_run: return
        def _msg(payload):
            m = PASSTHRU_MSG()
            m.ProtocolID = PROTOCOL_ISO15765
            m.TxFlags = ISO15765_FRAME_PAD
            m.DataSize = 4
            for i, b in enumerate(payload): m.Data[i] = b
            return m
        mask = _msg([0xFF, 0xFF, 0xFF, 0xFF])
        pattern = _msg([(rx >> 24) & 0xFF, (rx >> 16) & 0xFF, (rx >> 8) & 0xFF, rx & 0xFF])
        flow = _msg([(tx >> 24) & 0xFF, (tx >> 16) & 0xFF, (tx >> 8) & 0xFF, tx & 0xFF])
        fid = c_uint32(0)
        r = self.dll.PassThruStartMsgFilter(self.channel_id, FLOW_CONTROL_FILTER,
                                            byref(mask), byref(pattern), byref(flow), byref(fid))
        if r != 0: raise RuntimeError(f'StartMsgFilter: 0x{r:08X}')
    
    def send(self, tx, payload):
        if self.dry_run:
            print(f'    [DRY] TX {tx:03X}: {" ".join(f"{b:02X}" for b in payload)}')
            return
        msg = PASSTHRU_MSG(); msg.ProtocolID = PROTOCOL_ISO15765; msg.TxFlags = ISO15765_FRAME_PAD
        full = bytes([(tx >> 24) & 0xFF, (tx >> 16) & 0xFF, (tx >> 8) & 0xFF, tx & 0xFF]) + bytes(payload)
        msg.DataSize = len(full)
        for i, b in enumerate(full): msg.Data[i] = b
        n = c_uint32(1)
        r = self.dll.PassThruWriteMsgs(self.channel_id, byref(msg), byref(n), c_uint32(1000))
        if r != 0:
            raise RuntimeError(f"PassThruWriteMsgs failed: 0x{r:08X}")
    
    def recv(self, expected_rx=None, timeout_ms=2000):
        if self.dry_run: return None
        deadline = time.time() + timeout_ms / 1000.0
        while time.time() < deadline:
            msg = PASSTHRU_MSG(); msg.ProtocolID = PROTOCOL_ISO15765
            n = c_uint32(1)
            remaining = max(10, int((deadline - time.time()) * 1000))
            r = self.dll.PassThruReadMsgs(self.channel_id, byref(msg), byref(n), c_uint32(remaining))
            if r != 0:
                if r == 0x10:
                    time.sleep(0.005)
                    continue
                return None
            if n.value == 0: continue
            # J2534 RxStatus flags — skip TX echoes and partial-frame indications.
            TX_MSG_TYPE       = 0x00000001
            START_OF_MESSAGE  = 0x00000002
            if msg.RxStatus & TX_MSG_TYPE:
                continue  # our own transmit echoing back
            if msg.RxStatus & START_OF_MESSAGE:
                continue  # first-frame indicator; wait for full assembled frame
            data = bytes(msg.Data[:msg.DataSize])
            if len(data) < 5: continue
            arb = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]
            payload = data[4:]
            if expected_rx is not None and arb != expected_rx: continue
            if len(payload) >= 3 and payload[0] == NEG_RESPONSE and payload[2] == 0x78:
                continue  # response pending
            return payload
        return None


# ─── Scan helpers ──────────────────────────────────────────────────────

def session(j, tx, rx, subfn):
    j.send(tx, [SID_DIAG_SESSION, subfn])
    return j.recv(expected_rx=rx, timeout_ms=1500)


def read_did(j, tx, rx, did):
    j.send(tx, [SID_READ_DATA_BY_ID, (did >> 8) & 0xFF, did & 0xFF])
    return j.recv(expected_rx=rx, timeout_ms=2000)


def probe_seed(j, tx, rx, subfn=0x01):
    j.send(tx, [SID_SECURITY_ACCESS, subfn])
    return j.recv(expected_rx=rx, timeout_ms=2000)


def fmt_response(resp):
    """Return (status_str, human_value_if_any)."""
    if resp is None:
        return 'no response', None
    if resp[0] == NEG_RESPONSE:
        nrc = resp[2] if len(resp) > 2 else 0
        return f'NRC 0x{nrc:02X} ({NRC_NAMES.get(nrc, "?")})', None
    if resp[0] == 0x62 and len(resp) >= 3:
        data = resp[3:]
        # Try ASCII
        try:
            s = data.decode('ascii')
            if all(32 <= b < 127 or b in (0x00, 0x0A) for b in data) and len(data) >= 3:
                return f'+ve ({len(data)}B ascii)', s.rstrip('\x00').strip()
        except UnicodeDecodeError:
            pass
        return f'+ve ({len(data)}B hex)', data.hex().upper()
    return f'response 0x{resp[0]:02X}', None


def identify_supplier(responses):
    """Return a list of (algo_name, reason) hints based on DID response strings."""
    hints = []
    for did, _label, _status, value in responses:
        if not isinstance(value, str):
            continue
        vu = value.upper()
        for pattern, algo in SUPPLIER_PATTERNS.items():
            if pattern in vu:
                if algo:
                    hints.append((algo, f'DID 0x{did:04X} contains "{pattern}" → {algo}'))
                else:
                    hints.append((None, f'DID 0x{did:04X} contains "{pattern}" (supplier known, variant ambiguous)'))
    # Deduplicate
    seen = set()
    unique = []
    for h in hints:
        if h not in seen:
            seen.add(h)
            unique.append(h)
    return unique


def find_vin(responses):
    """Look through responses for anything that looks like a 17-char VIN."""
    vin_re = r'^[A-HJ-NPR-Z0-9]{17}$'
    import re as _re
    found = []
    for did, label, _status, value in responses:
        if isinstance(value, str):
            cleaned = value.strip().upper()
            if _re.match(vin_re, cleaned):
                found.append((did, label, cleaned))
    return found


# ─── Main scan ─────────────────────────────────────────────────────────

def scan_module(dll_path, module_key=None, tx=None, rx=None, dry_run=False, test_unlock=False):
    if module_key:
        if module_key not in MODULE_INFO:
            print(f'Unknown module: {module_key}', file=sys.stderr)
            return None
        info = MODULE_INFO[module_key]
        tx = tx or info['tx']
        rx = rx or info['rx']
        category = info['category']
        label = info['label']
    else:
        if not (tx and rx):
            raise ValueError('Must provide module_key OR (tx, rx)')
        category = 'unknown'
        label = f'custom @ 0x{tx:03X}/0x{rx:03X}'
    
    if not tx or not rx:
        print(f'Missing tx/rx for {module_key}', file=sys.stderr)
        return None
    
    print(f'SRT Lab module scan — {label}')
    print(f'  CAN tx=0x{tx:03X} rx=0x{rx:03X}  category={category}')
    if module_key:
        print(f'  Expected unlock algorithm: {module_key}')
    print('=' * 72)
    
    j = J2534(dll_path, dry_run=dry_run)
    responses = []
    reachable = False
    needs_unlock = None  # None=unknown, True=required, False=open
    
    try:
        j.open()
        j.connect()
        j.set_flow(tx, rx)
        print('[ok] J2534 channel open\n')
        
        # 1. Session discovery
        print('--- Session discovery ---')
        best_session = None
        for subfn, name in [(0x01, 'default'), (0x03, 'extended'), (0x02, 'programming')]:
            resp = session(j, tx, rx, subfn)
            status, _ = fmt_response(resp)
            marker = ''
            if resp and resp[0] == 0x50:
                reachable = True
                best_session = subfn
                marker = '  ←  accepted'
            print(f'  Session 0x{subfn:02X} ({name:<12s}): {status}{marker}')
            if dry_run: break
        
        if not reachable and not dry_run:
            print('\n  ⚠ Module did not respond to any session. Possible causes:')
            print('    - Module not powered (check 12V + ground)')
            print('    - Wrong CAN address (try --scan-all-bcms or override --tx --rx)')
            print('    - Wrong CAN baud (try 250000 with --baud)')
            print('    - Module on CAN-IHS instead of CAN-C (different physical bus)')
            return {'reachable': False}
        
        # Stay in extended if we got it, else try 0x03 anyway
        if not dry_run and best_session != 0x03:
            session(j, tx, rx, 0x03)
        
        # 2. DID probing
        print('\n--- DID probe ---')
        print(f'{"DID":<8s} {"Label":<42s} {"Status":<28s} Value')
        print('-' * 120)
        
        all_dids = STANDARD_DIDS + FCA_DIDS
        if category in CATEGORY_DIDS:
            all_dids = all_dids + CATEGORY_DIDS[category]
        
        for i, (did, did_label) in enumerate(all_dids):
            # Tester present every few DIDs
            if not dry_run and i > 0 and i % 6 == 0:
                j.send(tx, [SID_TESTER_PRESENT, 0x00])
                j.recv(expected_rx=rx, timeout_ms=300)
            resp = read_did(j, tx, rx, did)
            status, value = fmt_response(resp)
            display = value[:48] if value else ''
            print(f'  0x{did:04X}  {did_label:<42s}  {status:<28s} {display}')
            
            # AlfaOBD cross-reference: check if this DID number maps to known config DIDs
            if _did_decoder and value and len(value) > 0:
                # AlfaOBD DID IDs look like 01225 — 5 digits. UDS DIDs are 16-bit hex.
                # These aren't directly comparable, but the byte-level meanings inside
                # a config DID response often match AlfaOBD's bit-position definitions.
                # For now, show any matching AlfaOBD entries by description-keyword if 
                # the DID label itself mentions something searchable.
                hints = _did_decoder.search(did_label.split()[0]) if did_label else []
                if hints and len(hints) <= 3:
                    for h in hints[:2]:
                        print(f'         AlfaOBD match: {h["description"]}')
            
            responses.append((did, did_label, status, value))
            if dry_run:
                break
        
        # 3. Security access probe
        print('\n--- Security access probe ---')
        if not dry_run:
            resp = probe_seed(j, tx, rx, 0x01)
            status, _ = fmt_response(resp)
            print(f'  27 01 (request seed): {status}')
            if resp and resp[0] == 0x67:
                seed_bytes = resp[2:]
                needs_unlock = True
                print(f'  Seed: {seed_bytes.hex().upper()} — module REQUIRES unlock before write')
                
                # If we have a catalog unlock for this module, SHOW the key
                # (don't send it — just preview so you know what it would compute)
                if module_key and _catalog_unlock:
                    try:
                        seed_int = int.from_bytes(seed_bytes[:4], 'big')
                        key_int = _catalog_unlock(module_key, seed_int)
                        print(f'  Key would be: 0x{key_int:08X}  (via {module_key})  ← NOT sent')
                    except Exception as e:
                        print(f'  Key computation failed: {e}')
            elif resp and resp[0] == NEG_RESPONSE:
                nrc = resp[2] if len(resp) > 2 else 0
                if nrc == 0x11 or nrc == 0x12:
                    needs_unlock = False
                    print(f'  Module does not support security access — probably writes are open')
                elif nrc == 0x37:
                    print(f'  Time delay — module is rate-limiting. Wait 10 seconds and retry.')
                elif nrc == 0x36:
                    print(f'  ⚠ Exceeded attempts — module locked. Key cycle required.')
        else:
            print('  [DRY] Would send 27 01 to probe seed')
        
        # ─── OPTIONAL: actually verify the unlock algorithm works ──────
        if test_unlock and not dry_run and needs_unlock and module_key and _catalog_unlock:
            print('\n--- Test unlock (verifying algorithm) ---')
            print('  ⚠ This uses ONE key attempt. If key is wrong, module may lock after 3 attempts.')
            # Fresh seed
            resp = probe_seed(j, tx, rx, 0x01)
            if resp and resp[0] == 0x67:
                seed_bytes = resp[2:]
                seed_int = int.from_bytes(seed_bytes[:4], 'big')
                try:
                    key_int = _catalog_unlock(module_key, seed_int)
                except Exception as e:
                    print(f'  Key computation failed: {e}')
                else:
                    key_bytes = key_int.to_bytes(4, 'big')
                    print(f'  Seed: {seed_bytes.hex().upper()}')
                    print(f'  Key:  {key_bytes.hex().upper()}  ← sending now')
                    # Send 27 02 with the computed key
                    j.send(tx, [SID_SECURITY_ACCESS, 0x02] + list(key_bytes))
                    unlock_resp = j.recv(expected_rx=rx, timeout_ms=3000)
                    if unlock_resp is None:
                        print(f'  ✗ No response to key — timeout')
                    elif unlock_resp[0] == 0x67 and len(unlock_resp) >= 2 and unlock_resp[1] == 0x02:
                        print(f'  ✓ UNLOCK ACCEPTED — algorithm {module_key} is CORRECT for this module')
                        print(f'  ✓ You can safely run srtlab_ecm_vin_write.py --module {module_key}')
                    elif unlock_resp[0] == NEG_RESPONSE:
                        nrc = unlock_resp[2] if len(unlock_resp) > 2 else 0
                        if nrc == 0x35:
                            print(f'  ✗ Invalid key (NRC 0x35) — algorithm {module_key} does NOT match this module')
                            print(f'    Try a different supplier variant, or capture a real seed/key pair from wiTECH')
                        elif nrc == 0x36:
                            print(f'  ✗ Exceeded attempts (NRC 0x36) — module now locked, key-cycle car')
                        elif nrc == 0x37:
                            print(f'  ✗ Time delay (NRC 0x37) — too many recent attempts')
                        else:
                            print(f'  ✗ Key rejected: NRC 0x{nrc:02X} ({NRC_NAMES.get(nrc, "?")})')
                    else:
                        print(f'  ✗ Unexpected response: {unlock_resp.hex().upper()}')
            else:
                print('  Could not get fresh seed for test')
        elif test_unlock and not module_key:
            print('\n--- Test unlock ---')
            print('  Cannot test unlock without --module (need to know which algorithm to try)')
        
        # 4. Summary + recommendations
        # Config byte decode section
        if _did_decoder and responses:
            print('\n--- Config byte decode (AlfaOBD lookup) ---')
            decoded_count = 0
            for did, lbl, status, value in responses:
                if not value or not isinstance(value, str): continue
                if len(value) < 2: continue
                # Try parsing as hex bytes
                hex_val = value.replace(' ', '')
                if not re.match(r'^[0-9A-Fa-f]+$', hex_val): continue
                try:
                    data_bytes = bytes.fromhex(hex_val)
                except ValueError: continue
                
                # For each byte, enumerate possible bit-meanings
                if 'Config' in lbl or 'config' in lbl:
                    # This is a config DID; decode each byte's bits
                    print(f'  DID 0x{did:04X} ({lbl}): {hex_val}')
                    for byte_idx, byte_val in enumerate(data_bytes[:8]):
                        # Show bits that are set
                        for bit in range(8):
                            if byte_val & (1 << bit):
                                print(f'    byte[{byte_idx}] bit {bit} = 1')
                        decoded_count += 1
            if decoded_count == 0:
                print('  (no config-DID responses to decode)')
        
        print('\n--- Supplier identification ---')
        hints = identify_supplier(responses)
        if hints:
            for algo, reason in hints:
                if algo:
                    marker = ' ✓' if algo == module_key else '  '
                    print(f'  {marker} {reason}')
                else:
                    print(f'     {reason}')
        else:
            print('  (no supplier keywords found in DID strings)')
        
        print('\n--- VIN discovery ---')
        vins = find_vin(responses)
        if vins:
            for did, lbl, v in vins:
                print(f'  VIN found at DID 0x{did:04X}: {v}')
            write_did = vins[0][0]
            print(f'\n  → Write new VIN via: --vin-did 0x{write_did:04X}')
        else:
            print('  No readable VIN found in probed DIDs.')
            print('  Possible causes:')
            print('    - VIN read requires security unlock (run unlock first, re-scan)')
            print('    - Module is virgin (no VIN yet) — default F190 write should still work')
            print('    - VIN stored in a DID outside our probe set')
        
        # 5. Write recommendation
        print('\n--- Write recommendation ---')
        if not reachable:
            print('  SKIP — module not reachable')
        else:
            if module_key:
                cmd = f'python srtlab_ecm_vin_write.py --module {module_key} --vin <VIN17>'
                if vins:
                    cmd += f' --vin-did 0x{vins[0][0]:04X}'
                print(f'  {cmd}')
            else:
                print(f'  python srtlab_ecm_vin_write.py --tx 0x{tx:03X} --rx 0x{rx:03X} '
                      f'--algo <algo> --vin <VIN17>')
                if hints and hints[0][0]:
                    print(f'  Try --algo {hints[0][0]} based on supplier ID')
    
    finally:
        try: j.close()
        except Exception: pass
    
    return {
        'reachable': reachable,
        'needs_unlock': needs_unlock,
        'responses': responses,
        'vins': find_vin(responses),
        'supplier_hints': identify_supplier(responses),
    }


# ─── Bulk scan: try many addresses to find a module ────────────────────

COMMON_ADDRESSES = {
    'bcm': [(0x750, 0x758), (0x742, 0x762), (0x7E0, 0x7E8), (0x6B0, 0x6B8), (0x620, 0x628)],
    'tcm': [(0x7E1, 0x7E9), (0x7E2, 0x7EA)],
    'radio': [(0x6B0, 0x6B8), (0x7A3, 0x7BB), (0x7A5, 0x7BD)],
    'all': [
        (0x750, 0x758), (0x742, 0x762), (0x7E0, 0x7E8), (0x7E1, 0x7E9),
        (0x6B0, 0x6B8), (0x620, 0x628), (0x730, 0x738), (0x747, 0x74F),
        (0x7A0, 0x7A8), (0x7A3, 0x7BB), (0x7A4, 0x7AC), (0x760, 0x768),
    ],
}


def scan_all_addresses(dll_path, category='all', dry_run=False):
    print(f'SRT Lab bulk scan — probing {category} addresses')
    print('=' * 72)
    found = []
    addresses = COMMON_ADDRESSES.get(category, COMMON_ADDRESSES['all'])
    for tx, rx in addresses:
        print(f'\nProbing tx=0x{tx:03X} rx=0x{rx:03X} ...')
        j = J2534(dll_path, dry_run=dry_run)
        try:
            j.open()
            j.connect()
            j.set_flow(tx, rx)
            resp = session(j, tx, rx, 0x03)
            if resp and resp[0] == 0x50:
                print(f'  ✓ Module responds on 0x{tx:03X}')
                # Grab supplier ID to identify
                sup_resp = read_did(j, tx, rx, 0xF18A)
                status, value = fmt_response(sup_resp)
                if value:
                    print(f'    Supplier ID (0xF18A): {value}')
                found.append((tx, rx, value))
            elif resp:
                status, _ = fmt_response(resp)
                print(f'  - {status}')
            else:
                print(f'  - no response')
            if dry_run:
                break
        except Exception as e:
            print(f'  error: {e}')
        finally:
            try: j.close()
            except Exception: pass
    
    print('\n--- Summary ---')
    if found:
        print(f'Found {len(found)} responsive module(s):')
        for tx, rx, sup in found:
            print(f'  tx=0x{tx:03X} rx=0x{rx:03X}  supplier={sup}')
    else:
        print('No modules found on common addresses.')
    return found


# ─── CLI ───────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description='SRT Lab universal module scanner (read-only)')
    ap.add_argument('--module', help='Module key from catalog (see srtlab_unlock_catalog --list)')
    ap.add_argument('--tx', help='CAN tx (hex) override')
    ap.add_argument('--rx', help='CAN rx (hex) override')
    default_dll = find_j2534_dll() or r'C:\Windows\SysWOW64\op20pt32.dll'
    ap.add_argument('--dll', default=default_dll,
                    help=f'J2534 DLL path. Auto-detected: {default_dll}')
    ap.add_argument('--scan-all-bcms', action='store_true', help='Try common BCM addresses')
    ap.add_argument('--scan-all-radios', action='store_true', help='Try common radio addresses')
    ap.add_argument('--scan-all', action='store_true', help='Try all common module addresses')
    ap.add_argument('--test-unlock', action='store_true',
                    help='After scanning, actually send the computed key to verify the unlock algorithm. '
                         'Uses one key attempt — most modules lock out after 3 wrong keys, so only use '
                         'this when you need to confirm a new/untested algorithm.')
    ap.add_argument('--dry-run', action='store_true', help='Print without touching hardware')
    args = ap.parse_args()
    
    if args.scan_all or args.scan_all_bcms or args.scan_all_radios:
        cat = 'bcm' if args.scan_all_bcms else 'radio' if args.scan_all_radios else 'all'
        scan_all_addresses(args.dll, category=cat, dry_run=args.dry_run)
        return 0
    
    if not args.module and not (args.tx and args.rx):
        ap.error('--module OR (--tx and --rx) required')
    
    scan_module(
        dll_path=args.dll,
        module_key=args.module,
        tx=int(args.tx, 0) if args.tx else None,
        rx=int(args.rx, 0) if args.rx else None,
        dry_run=args.dry_run,
        test_unlock=args.test_unlock,
    )
    return 0


if __name__ == '__main__':
    if len(sys.argv) == 1:
        print('SRT Lab module scanner — dry-run demo\n')
        scan_module(dll_path='', module_key='huntsville_bcm', dry_run=True)
    else:
        sys.exit(main())
