"""
SRT Lab UDS error decoder.

Maps UDS Negative Response Codes (NRCs), ECU reset types, session types, and
common routine IDs to human-readable strings. Centralises what used to be
scattered across srtlab_ecm_vin_write.py, srtlab_module_scan.py, and
srtlab_orc_clear.py.

Also provides a best-effort DIAGNOSIS layer that interprets common error
patterns and suggests fixes. For example: NRC 0x22 after a VIN write on an
airbag module → "Clear crash data first with srtlab_orc_clear.py".

USAGE (library):
    from srtlab_uds_errors import decode_nrc, diagnose, format_error
    
    decode_nrc(0x22)
    # → "Conditions Not Correct"
    
    format_error(0x7F, 0x2E, 0x22)
    # → "NRC 0x22 (Conditions Not Correct) on service 0x2E (WriteDataByID)"
    
    diagnose(nrc=0x22, service=0x2E, module_key='bosch_orc')
    # → [
    #     "Condition: Module not ready to accept WriteDataByID.",
    #     "For bosch_orc this almost always means stored crash data.",
    #     "Fix: python srtlab_orc_clear.py --module bosch_orc"
    #   ]

USAGE (CLI):
    python srtlab_uds_errors.py --nrc 0x22
    python srtlab_uds_errors.py --decode "7F 27 33"
    python srtlab_uds_errors.py --all-nrcs
"""
import argparse
import sys


# ═══════════════════════════════════════════════════════════════════════
# UDS Service IDs (ISO 14229-1)
# ═══════════════════════════════════════════════════════════════════════
SERVICES = {
    0x10: ('DiagnosticSessionControl',  'Switch diagnostic session'),
    0x11: ('ECUReset',                   'Reset the ECU'),
    0x14: ('ClearDiagnosticInformation', 'Clear DTCs'),
    0x19: ('ReadDTCInformation',         'Read DTCs/status info'),
    0x22: ('ReadDataByIdentifier',       'Read value of a DID'),
    0x23: ('ReadMemoryByAddress',        'Read raw memory'),
    0x24: ('ReadScalingDataByIdentifier','Read DID scaling info'),
    0x27: ('SecurityAccess',             'Seed/key unlock'),
    0x28: ('CommunicationControl',       'Enable/disable module comms'),
    0x2A: ('ReadDataByPeriodicIdentifier','Periodic DID read'),
    0x2C: ('DynamicallyDefineDataIdentifier','Build dynamic DID'),
    0x2E: ('WriteDataByIdentifier',      'Write value to a DID (VIN, configs)'),
    0x2F: ('InputOutputControlByIdentifier','Actuator control'),
    0x31: ('RoutineControl',             'Start/stop/query a routine'),
    0x34: ('RequestDownload',            'Start flash download'),
    0x35: ('RequestUpload',              'Start memory upload'),
    0x36: ('TransferData',               'Flash data block transfer'),
    0x37: ('RequestTransferExit',        'End flash transfer'),
    0x38: ('RequestFileTransfer',        'File-based transfer'),
    0x3D: ('WriteMemoryByAddress',       'Write raw memory'),
    0x3E: ('TesterPresent',              'Keep session alive'),
    0x83: ('AccessTimingParameter',      'Change UDS timing'),
    0x84: ('SecuredDataTransmission',    'Encrypted data exchange'),
    0x85: ('ControlDTCSetting',          'Enable/disable DTC logging'),
    0x86: ('ResponseOnEvent',            'Trigger response on event'),
    0x87: ('LinkControl',                'Bus speed/link config'),
}


# ═══════════════════════════════════════════════════════════════════════
# Negative Response Codes (ISO 14229-1 table)
# ═══════════════════════════════════════════════════════════════════════
NRCS = {
    0x10: ('GeneralReject',               'ECU rejected the request for an unspecified reason'),
    0x11: ('ServiceNotSupported',         'Service ID not implemented by this ECU'),
    0x12: ('SubFunctionNotSupported',     'Subfunction byte not implemented'),
    0x13: ('IncorrectMessageLengthOrInvalidFormat',
                                           'Wrong number of bytes in the request'),
    0x14: ('ResponseTooLong',             'Response would exceed transport limits'),
    0x21: ('BusyRepeatRequest',           'ECU busy — retry later'),
    0x22: ('ConditionsNotCorrect',        'ECU is not in the correct state to do this'),
    0x24: ('RequestSequenceError',        'Out-of-order request (e.g. key before seed)'),
    0x25: ('NoResponseFromSubnetComponent','Sub-network module not responding'),
    0x26: ('FailurePreventsExecutionOfRequestedAction',
                                           'Internal failure blocks the request'),
    0x31: ('RequestOutOfRange',           'Parameter value outside permitted range'),
    0x33: ('SecurityAccessDenied',        'Unlock required, or wrong session'),
    0x34: ('AuthenticationRequired',      'Module needs authentication first (new in ISO-14229-1:2020)'),
    0x35: ('InvalidKey',                  'Seed-to-key mismatch — one of 3 attempts'),
    0x36: ('ExceededNumberOfAttempts',    'Too many wrong keys — delay or power-cycle needed'),
    0x37: ('RequiredTimeDelayNotExpired', 'Wait period active — try again in a few seconds'),
    0x38: ('SecureDataTransmissionRequired','Must use 0x84 secured transmission'),
    0x39: ('SecureDataTransmissionNotAllowed','Secured transmission rejected'),
    0x3A: ('SecureDataVerificationFailed','MAC or signature check failed'),
    0x50: ('CertificateVerificationFailed','Cert-chain invalid'),
    0x70: ('UploadDownloadNotAccepted',   'Flash transfer rejected'),
    0x71: ('TransferDataSuspended',       'Transfer paused'),
    0x72: ('GeneralProgrammingFailure',   'Flash operation failed'),
    0x73: ('WrongBlockSequenceCounter',   'Transfer block sequence out of order'),
    0x78: ('RequestCorrectlyReceivedResponsePending',
                                           'Keep waiting — ECU is still processing'),
    0x7E: ('SubFunctionNotSupportedInActiveSession',
                                           'Valid subfunction but wrong session'),
    0x7F: ('ServiceNotSupportedInActiveSession',
                                           'Valid service but wrong session — try programming session (0x02)'),
    0x81: ('RpmTooHigh',                  'Engine running too fast for this routine'),
    0x82: ('RpmTooLow',                   'Engine not running or too slow'),
    0x83: ('EngineIsRunning',             'Must be off'),
    0x84: ('EngineIsNotRunning',          'Must be running'),
    0x85: ('EngineRunTimeTooLow',         'Engine hasn\'t been running long enough'),
    0x86: ('TemperatureTooHigh',          'Coolant or component over limit'),
    0x87: ('TemperatureTooLow',           'Coolant or component under limit'),
    0x88: ('VehicleSpeedTooHigh',         'Must be stopped or slower'),
    0x89: ('VehicleSpeedTooLow',          'Must be moving or faster'),
    0x8A: ('ThrottleOrPedalTooHigh',      'Pedal must be released'),
    0x8B: ('ThrottleOrPedalTooLow',       'Pedal must be pressed'),
    0x8C: ('TransmissionRangeNotInNeutral','Shift to neutral'),
    0x8D: ('TransmissionRangeNotInGear',  'Shift to drive/gear'),
    0x8F: ('BrakeSwitchesNotClosed',      'Press brake pedal'),
    0x90: ('ShifterLeverNotInPark',       'Shift to park'),
    0x91: ('TorqueConverterClutchLocked', 'TCC must be unlocked'),
    0x92: ('VoltageTooHigh',              'Battery over ~16V — check alternator'),
    0x93: ('VoltageTooLow',               'Battery under ~10V — connect charger'),
}


# ═══════════════════════════════════════════════════════════════════════
# Session types (subfunction of SID 0x10)
# ═══════════════════════════════════════════════════════════════════════
SESSIONS = {
    0x01: ('DefaultSession',           'Normal driving session (read-only)'),
    0x02: ('ProgrammingSession',       'Flash/VIN write — usually required for destructive ops'),
    0x03: ('ExtendedDiagnosticSession','Expanded diagnostic access'),
    0x04: ('SafetySystemDiagnosticSession','Safety-critical systems'),
    0x40: ('FCA_ProgrammingSession',   'FCA-specific programming mode'),
    0x60: ('FCA_ExtendedSession',      'FCA extended'),
}


# ═══════════════════════════════════════════════════════════════════════
# Reset types (subfunction of SID 0x11)
# ═══════════════════════════════════════════════════════════════════════
RESET_TYPES = {
    0x01: ('HardReset',                'Full reboot, briefly loses power state'),
    0x02: ('KeyOffOnReset',            'Simulate key cycle'),
    0x03: ('SoftReset',                'Warm restart, faster than hard'),
    0x04: ('EnableRapidPowerShutDown', 'Arm rapid shutdown'),
    0x05: ('DisableRapidPowerShutDown','Disarm rapid shutdown'),
}


# ═══════════════════════════════════════════════════════════════════════
# Security access subfunctions
# ═══════════════════════════════════════════════════════════════════════
SECURITY_SUBFN = {
    0x01: 'RequestSeed (level 1)',
    0x02: 'SendKey (level 1)',
    0x03: 'RequestSeed (level 2)',
    0x04: 'SendKey (level 2)',
    0x05: 'RequestSeed (level 3)',
    0x06: 'SendKey (level 3)',
    0x11: 'RequestSeed (FCA level 0x11)',
    0x12: 'SendKey (FCA level 0x11)',
    0x61: 'RequestSeed (FCA level 0x61)',
    0x62: 'SendKey (FCA level 0x61)',
}


# ═══════════════════════════════════════════════════════════════════════
# Decoders
# ═══════════════════════════════════════════════════════════════════════
def decode_service(sid):
    """Look up a UDS service ID. Returns (name, description) or (None, None)."""
    # Response SIDs are request + 0x40
    if sid >= 0x40 and (sid - 0x40) in SERVICES:
        name, desc = SERVICES[sid - 0x40]
        return f'{name} (positive response)', desc
    return SERVICES.get(sid, (None, None))


def decode_nrc(nrc):
    """Look up an NRC. Returns a short human-readable name."""
    if nrc in NRCS:
        name, _desc = NRCS[nrc]
        return name
    # Vendor-specific range
    if 0xF0 <= nrc <= 0xFE:
        return f'VendorSpecific(0x{nrc:02X})'
    if 0x94 <= nrc <= 0xFE:
        return f'ConditionsNotCorrectFor_0x{nrc:02X}'
    return f'Unknown(0x{nrc:02X})'


def decode_nrc_full(nrc):
    """Return (short_name, long_description) for an NRC."""
    if nrc in NRCS:
        return NRCS[nrc]
    return (f'Unknown(0x{nrc:02X})', 'Not in ISO 14229-1 table — consult manufacturer docs')


def format_error(*resp_bytes):
    """Format a negative response. Accepts either:
        format_error(0x7F, 0x2E, 0x22)
        format_error(b'\\x7F\\x2E\\x22')
        format_error([0x7F, 0x2E, 0x22])
    """
    if len(resp_bytes) == 1:
        b = resp_bytes[0]
        if hasattr(b, '__iter__'):
            resp_bytes = list(b)
        else:
            resp_bytes = [b]
    if len(resp_bytes) < 3:
        return f'Malformed response: {" ".join(f"{b:02X}" for b in resp_bytes)}'
    if resp_bytes[0] != 0x7F:
        return f'Not a negative response: first byte is 0x{resp_bytes[0]:02X}, expected 0x7F'
    
    service_id = resp_bytes[1]
    nrc = resp_bytes[2]
    svc_name, _svc_desc = decode_service(service_id)
    nrc_name, nrc_desc = decode_nrc_full(nrc)
    
    svc_str = svc_name or f'Unknown(0x{service_id:02X})'
    return f'NRC 0x{nrc:02X} ({nrc_name}) on service 0x{service_id:02X} ({svc_str}): {nrc_desc}'


# ═══════════════════════════════════════════════════════════════════════
# Diagnostic layer — interpret errors in context
# ═══════════════════════════════════════════════════════════════════════
_AIRBAG_MODULES = {'bosch_orc', 'trw_orc', 'ocm', 'trw_ocm',
                   'bosch_orc_2015', 'dart_orc'}


def diagnose(nrc, service=None, module_key=None, session=None, subfunction=None):
    """Return a list of human-readable diagnosis + suggested fix lines.
    
    Args:
        nrc: The NRC byte (e.g. 0x22).
        service: UDS service that was rejected (e.g. 0x2E for WriteDataByID).
        module_key: Module name string (e.g. 'bosch_orc').
        session: Current session byte (e.g. 0x03).
        subfunction: Service subfunction if applicable.
    
    Returns:
        list of string lines, roughly: [condition, context, fix].
    """
    lines = []
    
    # NRC 0x22 — Conditions Not Correct
    if nrc == 0x22:
        if service == 0x2E and module_key in _AIRBAG_MODULES:
            lines.append('Condition: Module not ready to accept WriteDataByIdentifier.')
            lines.append(f'For {module_key} this almost always means stored crash data blocks a write.')
            lines.append(f'Fix: python srtlab_orc_clear.py --module {module_key}')
            lines.append('After the clear succeeds and module resets, retry the VIN write.')
        elif service == 0x2E:
            lines.append('Condition: Module rejected WriteDataByIdentifier.')
            lines.append('Common causes: stale DTCs, wrong session, module in learning mode, low voltage.')
            lines.append('Try: clear DTCs (14 FF FF FF), check battery ≥12.5V, try programming session (0x02).')
        elif service == 0x31:
            lines.append('Condition: RoutineControl precondition failed.')
            lines.append('Routines often need engine off, brake pressed, or a specific gear.')
            lines.append('Check the routine\'s vehicle-state requirements.')
        else:
            lines.append('Condition: ECU not in the correct state for this request.')
            lines.append('Check: ignition ON (not just ACC), engine state matches routine needs, voltage 12-16V.')
    
    # NRC 0x33 — Security Access Denied
    elif nrc == 0x33:
        lines.append('Condition: Security unlock required.')
        if service == 0x27 and subfunction in (0x02, 0x04, 0x06):
            lines.append('You sent a key but the seed had expired or came from the wrong session.')
            lines.append('Fix: re-request seed (27 01) immediately before sending key (27 02).')
        elif session == 0x01:
            lines.append('Default session does not allow seed/key on most modules.')
            lines.append('Fix: enter extended (0x03) or programming (0x02) session first.')
        else:
            lines.append('Fix: run 10 03 (or 10 02 for airbags/flash), then 27 01 to get a seed, compute the key, send 27 02.')
    
    # NRC 0x35 — Invalid Key
    elif nrc == 0x35:
        lines.append('Condition: Seed-to-key mismatch. Algorithm is probably wrong.')
        lines.append('Common causes: module is from a newer MY with a different algorithm;')
        lines.append('byte order wrong; using 4-byte seed when module wants 8; SGW not unlocked first.')
        lines.append('Fix: verify algorithm with srtlab_seedkey_capture.py to log real pairs,')
        lines.append('then compare against what our algorithm would compute.')
        lines.append('⚠ Most modules lock after 3 invalid keys — stop and power-cycle.')
    
    # NRC 0x36 — Exceeded Attempts
    elif nrc == 0x36:
        lines.append('Condition: Module is locked out after too many wrong keys.')
        lines.append('Fix: power-cycle the module (remove power for 10s, or full key-off for 60s).')
        lines.append('Some modules require a longer lockout (5-10 min) before accepting another seed.')
    
    # NRC 0x37 — Required Time Delay Not Expired
    elif nrc == 0x37:
        lines.append('Condition: Module is in a cooldown period after previous failed attempts.')
        lines.append('Fix: wait 10-30 seconds and retry. If persistent, power-cycle the module.')
    
    # NRC 0x7F — Service Not Supported In Active Session
    elif nrc == 0x7F:
        lines.append('Condition: Valid service, wrong session.')
        lines.append(f'Fix: enter programming session (10 02) before trying service 0x{service:02X}.' if service else
                     'Fix: try programming session (10 02) or extended (10 03).')
    
    # NRC 0x11 — Service Not Supported
    elif nrc == 0x11:
        lines.append('Condition: Module does not implement this service at all.')
        if service == 0x2E:
            lines.append('This module does not accept WriteDataByIdentifier — the DID may need a different service.')
            lines.append('Older FCA modules used KWP2000 service 0x3B (WriteDataByLocalIdentifier) instead.')
    
    # NRC 0x12 — Subfunction Not Supported
    elif nrc == 0x12:
        lines.append('Condition: Subfunction byte not recognised.')
        if service == 0x10:
            lines.append(f'Fix: session 0x{subfunction:02X} not available on this module. Try 0x01, 0x02, 0x03.' if subfunction else
                         'Fix: try session 0x01, 0x02, or 0x03.')
        elif service == 0x11:
            lines.append('Fix: try reset type 0x01 (hard) instead of 0x03 (soft), or vice versa.')
    
    # NRC 0x13 — Incorrect length
    elif nrc == 0x13:
        lines.append('Condition: Request is missing bytes or has extra bytes.')
        if service == 0x2E:
            lines.append('For VIN write (2E F1 90), payload must be exactly 17 ASCII bytes after the DID.')
    
    # NRC 0x78 — Response Pending (should be handled transparently)
    elif nrc == 0x78:
        lines.append('Condition: Module is still processing. This should be handled automatically.')
        lines.append('If you see this, the read loop may be timing out too early.')
    
    # NRC 0x31 — Request Out of Range
    elif nrc == 0x31:
        lines.append('Condition: A parameter is outside the module\'s permitted range.')
        if service == 0x22 or service == 0x2E:
            lines.append('The DID you\'re trying to read/write does not exist on this module.')
            lines.append('Use srtlab_module_scan.py to probe which DIDs this module responds to.')
    
    else:
        # Generic fallback
        name, desc = decode_nrc_full(nrc)
        lines.append(f'Condition: {name} — {desc}')
    
    return lines


# ═══════════════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════════════
def main():
    ap = argparse.ArgumentParser(
        description='Decode UDS negative responses and diagnose them.',
    )
    ap.add_argument('--nrc', type=lambda s: int(s, 0),
                    help='Decode a single NRC byte (e.g. 0x22 or 34)')
    ap.add_argument('--service', type=lambda s: int(s, 0),
                    help='Service ID context for diagnosis (e.g. 0x2E)')
    ap.add_argument('--module', help='Module key context (e.g. bosch_orc)')
    ap.add_argument('--session', type=lambda s: int(s, 0),
                    help='Session byte context (e.g. 0x03)')
    ap.add_argument('--decode', metavar='HEX',
                    help='Decode a raw negative response, e.g. "7F 2E 22" or "7f2e22"')
    ap.add_argument('--all-nrcs', action='store_true', help='Print the full NRC table')
    ap.add_argument('--all-services', action='store_true', help='Print the full service table')
    args = ap.parse_args()
    
    if args.all_nrcs:
        print(f"{'NRC':<6s} {'NAME':<45s} DESCRIPTION")
        print('─' * 120)
        for code in sorted(NRCS):
            name, desc = NRCS[code]
            print(f"0x{code:02X}  {name:<45s} {desc}")
        return 0
    
    if args.all_services:
        print(f"{'SID':<6s} {'NAME':<40s} DESCRIPTION")
        print('─' * 100)
        for code in sorted(SERVICES):
            name, desc = SERVICES[code]
            print(f"0x{code:02X}  {name:<40s} {desc}")
        return 0
    
    if args.decode:
        hex_str = args.decode.replace(' ', '').replace('0x', '').replace(',', '')
        try:
            raw = bytes.fromhex(hex_str)
        except ValueError as e:
            print(f'Could not parse as hex: {e}', file=sys.stderr)
            return 1
        print(format_error(raw))
        if len(raw) >= 3 and raw[0] == 0x7F:
            print()
            for line in diagnose(nrc=raw[2], service=raw[1],
                                 module_key=args.module, session=args.session):
                print(f'  {line}')
        return 0
    
    if args.nrc is not None:
        name, desc = decode_nrc_full(args.nrc)
        print(f'NRC 0x{args.nrc:02X}: {name}')
        print(f'  {desc}')
        if args.service or args.module or args.session:
            print()
            print('Diagnosis:')
            for line in diagnose(nrc=args.nrc, service=args.service,
                                 module_key=args.module, session=args.session):
                print(f'  {line}')
        return 0
    
    ap.print_help()
    return 0


if __name__ == '__main__':
    sys.exit(main())
