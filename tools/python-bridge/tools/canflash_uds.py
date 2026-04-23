"""
Chrysler KWP2000 / UDS frame builder.

Protocol: KWP2000 over ISO 15765-2 (CAN Transport Protocol)
Wire format extracted from canflash_j2534.exe disassembly.
Single-byte DIDs (Data Identifiers) per Chrysler convention.

This is what VILLAIN, CDA 6, and the Chrysler J2534 Flash Application use to
write VINs and other data to pre-SGW (2017 and earlier) FCA/Stellantis modules
WITHOUT needing to contact any manufacturing server.

Usage: this module BUILDS frames only. The caller is responsible for ISO-TP
framing (single-frame <= 7 bytes, or multi-frame via FirstFrame + Consecutive).
Transport-layer handling lives in the J2534 bridge.
"""

# UDS / KWP2000 service IDs (from canflash disassembly)
class UDS:
    DIAG_SESSION          = 0x10
    ECU_RESET             = 0x11
    READ_DTC              = 0x18
    READ_ECU_ID           = 0x1A
    READ_DATA_BY_LOCAL    = 0x21
    READ_DATA_BY_COMMON   = 0x22  # UDS-style two-byte DID
    SECURITY_ACCESS       = 0x27
    COMMUNICATION_CONTROL = 0x28
    ROUTINE_CONTROL       = 0x31
    TRANSFER_DATA         = 0x36
    REQUEST_TRANSFER_EXIT = 0x37
    WRITE_DATA_LOCAL      = 0x3B  # KWP2000 — what canflash uses
    WRITE_DATA_COMMON     = 0x2E  # UDS — modern vehicles
    TESTER_PRESENT        = 0x3E
    
    POS_RESP_OFFSET       = 0x40  # positive response = service + 0x40
    NEG_RESP              = 0x7F
    
    # Negative response codes
    NRC_DESCRIPTIONS = {
        0x10: 'General reject',
        0x11: 'Service not supported',
        0x12: 'Sub-function not supported',
        0x13: 'Incorrect message length',
        0x22: 'Conditions not correct',
        0x24: 'Request sequence error',
        0x31: 'Request out of range',
        0x33: 'Security access denied',
        0x35: 'Invalid key',
        0x36: 'Exceed number of attempts',
        0x37: 'Required time delay not expired',
        0x70: 'Upload download not accepted',
        0x71: 'Transfer data suspended',
        0x72: 'General programming failure',
        0x78: 'Request correctly received, response pending',
        0x7E: 'Sub-function not supported in active session',
        0x7F: 'Service not supported in active session',
    }


class Session:
    DEFAULT     = 0x81
    PROGRAMMING = 0x02
    EXTENDED    = 0x03
    CHRYSLER    = 0x85
    SAFETY      = 0x04


class Reset:
    HARD       = 0x01
    KEY_OFF_ON = 0x02
    SOFT       = 0x03


# Frame builders — each returns bytes ready for ISO-TP framing
def start_diag_session(session_type):
    return bytes([UDS.DIAG_SESSION, session_type & 0xFF])


def ecu_reset(reset_type=Reset.HARD):
    return bytes([UDS.ECU_RESET, reset_type & 0xFF])


def tester_present(suppress_response=False):
    return bytes([UDS.TESTER_PRESENT, 0x80 if suppress_response else 0x00])


def request_seed(security_level):
    """Request security access seed.
    
    KWP2000 convention: level 1 = subfunction 0x01 for seed, 0x02 for key
                        level 3 = subfunction 0x05 for seed, 0x06 for key
                        level 5 = subfunction 0x09 for seed, 0x0A for key
    """
    subfunc = (security_level * 2) - 1
    return bytes([UDS.SECURITY_ACCESS, subfunc & 0xFF])


def send_key(security_level, key_bytes):
    subfunc = security_level * 2
    return bytes([UDS.SECURITY_ACCESS, subfunc & 0xFF]) + bytes(key_bytes)


def read_ecu_id(did_byte):
    return bytes([UDS.READ_ECU_ID, did_byte & 0xFF])


def read_data_by_local(did_byte):
    return bytes([UDS.READ_DATA_BY_LOCAL, did_byte & 0xFF])


def read_data_by_common(did_word):
    return bytes([UDS.READ_DATA_BY_COMMON, (did_word >> 8) & 0xFF, did_word & 0xFF])


def write_data_by_local(did_byte, data_bytes):
    """Canflash KWP2000 format: [0x3B][DID_byte][data...]"""
    return bytes([UDS.WRITE_DATA_LOCAL, did_byte & 0xFF]) + bytes(data_bytes)


def write_data_by_common(did_word, data_bytes):
    """Modern UDS format: [0x2E][DID_hi][DID_lo][data...]"""
    return bytes([UDS.WRITE_DATA_COMMON, (did_word >> 8) & 0xFF, did_word & 0xFF]) + bytes(data_bytes)


def routine_control(subfunc, routine_id, params=b''):
    """subfunc: 0x01=start, 0x02=stop, 0x03=request results."""
    if routine_id < 0x100:
        return bytes([UDS.ROUTINE_CONTROL, subfunc, routine_id]) + bytes(params)
    return bytes([UDS.ROUTINE_CONTROL, subfunc, (routine_id >> 8) & 0xFF, routine_id & 0xFF]) + bytes(params)


# VIN helpers
_TRANSLITERATE = {
    'A':1,'B':2,'C':3,'D':4,'E':5,'F':6,'G':7,'H':8,
    'J':1,'K':2,'L':3,'M':4,'N':5,           'P':7,   'R':9,
    'S':2,'T':3,'U':4,'V':5,'W':6,'X':7,'Y':8,'Z':9,
    '0':0,'1':1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,
}
_WEIGHTS = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2]


def validate_vin(vin):
    """Validate a 17-char VIN. Returns (valid, expected_check_digit, error_or_none)."""
    if len(vin) != 17:
        return False, None, 'VIN must be 17 characters'
    if any(c in 'IOQ' for c in vin.upper()):
        return False, None, 'VIN cannot contain I, O, or Q'
    
    s = 0
    for i, c in enumerate(vin.upper()):
        v = _TRANSLITERATE.get(c)
        if v is None:
            return False, None, f'Invalid char at position {i+1}: {c!r}'
        s += v * _WEIGHTS[i]
    
    c = s % 11
    expected = 'X' if c == 10 else str(c)
    actual = vin[8].upper()
    return actual == expected, expected, None if actual == expected else f'Check digit should be {expected}, got {actual}'


def compute_check_digit(vin_16_chars):
    """Given 16 VIN chars (positions 1-8 + 10-17, skipping check-digit position), compute the check digit."""
    if len(vin_16_chars) != 16:
        raise ValueError('Expected 16 chars')
    # Insert placeholder '0' at position 9
    test = vin_16_chars[:8] + '0' + vin_16_chars[8:]
    s = 0
    for i, c in enumerate(test.upper()):
        s += _TRANSLITERATE.get(c, 0) * _WEIGHTS[i]
    c = s % 11
    return 'X' if c == 10 else str(c)


def vin_to_bytes(vin):
    """17-char VIN → 17 ASCII bytes."""
    if len(vin) != 17:
        raise ValueError(f'VIN must be 17 chars, got {len(vin)}')
    return vin.upper().encode('ascii')


def parse_response(frame):
    """Parse a UDS response frame. Returns a dict."""
    if not frame:
        return {'success': False, 'error': 'Empty response'}
    
    service = frame[0]
    
    if service == UDS.NEG_RESP:
        if len(frame) < 3:
            return {'success': False, 'error': 'Malformed negative response'}
        rejected = frame[1]
        nrc = frame[2]
        desc = UDS.NRC_DESCRIPTIONS.get(nrc, f'Unknown NRC 0x{nrc:02x}')
        return {
            'success': False,
            'negative': True,
            'rejected_service': rejected,
            'nrc': nrc,
            'error': f'Rejected service 0x{rejected:02x}: {desc}',
        }
    
    original_service = service - UDS.POS_RESP_OFFSET
    return {
        'success': True,
        'service': original_service,
        'payload': bytes(frame[1:]),
    }


# Full VIN-write sequence builder
def build_vin_write_sequence(module_spec, new_vin, computed_key):
    """Build the full list of UDS frames to write a VIN to a module.
    
    module_spec is a dict with keys:
        security_level (int), session_type (int), vin_did_kwp (int),
        optionally vin_did_original_kwp (int) for modules with dual VIN slots.
    
    Returns a list of (description, frame_bytes, expected_response_service) tuples.
    The caller handles sending each frame, waiting for response, and (for the seed
    request step) extracting the seed to compute the key before the next step.
    """
    valid, expected_cd, err = validate_vin(new_vin)
    if not valid:
        raise ValueError(f'VIN validation failed: {err}')
    
    vin_bytes = vin_to_bytes(new_vin)
    session_type = module_spec.get('session_type', Session.EXTENDED)
    sec_level = module_spec.get('security_level', 1)
    vin_did = module_spec.get('vin_did_kwp', 0x90)
    
    sequence = [
        ('Enter extended diagnostic session',
         start_diag_session(session_type),
         UDS.DIAG_SESSION + UDS.POS_RESP_OFFSET),
        
        ('Keep-alive: tester present',
         tester_present(False),
         UDS.TESTER_PRESENT + UDS.POS_RESP_OFFSET),
        
        (f'Request seed (security level {sec_level})',
         request_seed(sec_level),
         UDS.SECURITY_ACCESS + UDS.POS_RESP_OFFSET),
        
        ('Send computed security key',
         send_key(sec_level, computed_key),
         UDS.SECURITY_ACCESS + UDS.POS_RESP_OFFSET),
        
        (f'Write VIN (DID 0x{vin_did:02X})',
         write_data_by_local(vin_did, vin_bytes),
         UDS.WRITE_DATA_LOCAL + UDS.POS_RESP_OFFSET),
    ]
    
    orig_did = module_spec.get('vin_did_original_kwp')
    if orig_did is not None:
        sequence.append((
            f'Write original VIN (DID 0x{orig_did:02X})',
            write_data_by_local(orig_did, vin_bytes),
            UDS.WRITE_DATA_LOCAL + UDS.POS_RESP_OFFSET,
        ))
    
    sequence.append((
        'ECU hard reset',
        ecu_reset(Reset.HARD),
        UDS.ECU_RESET + UDS.POS_RESP_OFFSET,
    ))
    
    return sequence


# Per-module specs (from canflash ecu_info + VIN Programming Guide + extracted dumps)
MODULE_SPECS = {
    'BCM_LX':       {'security_level': 3, 'session_type': 0x03, 'vin_did_kwp': 0x90, 'vin_did_original_kwp': 0x88,
                     'can_tx': 0x0620, 'can_rx': 0x0504, 'unlock_algo': 'cfYazakiFCM'},
    'BCM_STANDARD': {'security_level': 3, 'session_type': 0x03, 'vin_did_kwp': 0x90, 'vin_did_original_kwp': 0x88,
                     'can_tx': 0x0620, 'can_rx': 0x0504, 'unlock_algo': 'cfBCM'},
    'TIPM_7':       {'security_level': 3, 'session_type': 0x03, 'vin_did_kwp': 0x90, 'vin_did_original_kwp': 0x88,
                     'can_tx': 0x0620, 'can_rx': 0x0504, 'unlock_algo': 'cfTIPM'},
    'ABS_TRW':      {'security_level': 1, 'session_type': 0x03, 'vin_did_kwp': 0x90,
                     'can_tx': 0x0784, 'can_rx': 0x0785, 'unlock_algo': 'cfTrwABS'},
    'ABS_BOSCH':    {'security_level': 1, 'session_type': 0x03, 'vin_did_kwp': 0x90,
                     'can_tx': 0x0784, 'can_rx': 0x0785, 'unlock_algo': 'cfBoschABS'},
    'ITM':          {'security_level': 3, 'session_type': 0x03, 'vin_did_kwp': 0x90,
                     'can_tx': 0x0670, 'can_rx': 0x050E, 'unlock_algo': 'cfITM'},
    'PCM_NGC':      {'security_level': 3, 'session_type': 0x03, 'vin_did_kwp': 0xE1,
                     'can_tx': 0x07E0, 'can_rx': 0x07E8, 'unlock_algo': 'cfNGCEngine'},
    'PCM_GPEC':     {'security_level': 3, 'session_type': 0x03, 'vin_did_kwp': 0xE1, 'vin_did_uds': 0xF190,
                     'can_tx': 0x07E0, 'can_rx': 0x07E8, 'unlock_algo': 'cfGPEC'},
    'PCM_VENOM':    {'security_level': 3, 'session_type': 0x03, 'vin_did_kwp': 0xE1,
                     'can_tx': 0x07E0, 'can_rx': 0x07E8, 'unlock_algo': 'cfVenomPCM'},
    'TCM':          {'security_level': 3, 'session_type': 0x03, 'vin_did_kwp': 0x90,
                     'can_tx': 0x07E1, 'can_rx': 0x07E9, 'unlock_algo': 'cfNGCTrans'},
    'RADIO':        {'security_level': 1, 'session_type': 0x03, 'vin_did_kwp': 0x90,
                     'can_tx': 0x06B0, 'can_rx': 0x0516, 'unlock_algo': 'cfHuntsvilleRadio'},
    'RAK':          {'security_level': 5, 'session_type': 0x03,
                     'can_tx': 0x06B0, 'can_rx': 0x0516, 'unlock_algo': 'cfAlpineRAK', 'unlock_args': 2},
    'WCM':          {'security_level': 5, 'session_type': 0x03, 'vin_did_kwp': 0x90,
                     'can_tx': 0x0600, 'can_rx': 0x0500, 'unlock_algo': 'cfWCM',
                     'eeprom_vin_offsets': [0x0EA5, 0x0EB9, 0x0ECD, 0x0EE1]},
}


if __name__ == '__main__':
    # Demo: build a VIN write sequence for the BCM on a Scat Pack
    print("=" * 70)
    print("DEMO: Write VIN to Scat Pack BCM")
    print("=" * 70)
    
    test_vin = '2C3CDZFJXKH000001'
    valid, cd, err = validate_vin(test_vin)
    print(f"VIN {test_vin}: valid={valid}, check_digit={cd}")
    
    # Pretend the seed was 0x1234 and we computed key via cfYazakiFCM
    fake_key = bytes([0xAB, 0xCD])
    
    spec = MODULE_SPECS['BCM_LX']
    seq = build_vin_write_sequence(spec, test_vin, fake_key)
    
    print(f"\nFull sequence ({len(seq)} steps):")
    for i, (desc, frame, expected) in enumerate(seq, 1):
        hex_str = ' '.join(f'{b:02x}' for b in frame)
        print(f"\n  Step {i}: {desc}")
        print(f"    Frame ({len(frame)} bytes): {hex_str}")
        print(f"    Expect response: 0x{expected:02X}")
    
    # Show per-module CAN IDs
    print(f"\n{'='*70}")
    print("ALL MODULES:")
    print(f"{'='*70}")
    for name, spec in MODULE_SPECS.items():
        tx = spec['can_tx']
        rx = spec['can_rx']
        lvl = spec.get('security_level', '?')
        algo = spec['unlock_algo']
        print(f"  {name:<14s} tx=0x{tx:04X} rx=0x{rx:04X} L{lvl} {algo}")
