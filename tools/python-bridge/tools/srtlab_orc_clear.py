"""
SRT Lab — ORC (Occupant Restraint Controller) crash-data clear utility.

Clears stored crash/deployment data from an airbag control module so a donor
ORC can accept a new VIN and operate in the target vehicle. Without this step,
a deployed-then-cleared ORC will throw DTCs, refuse to arm, and in some cases
reject VIN write with NRC 0x22 (Conditions Not Correct).

BACKGROUND:

FCA ORCs (Bosch, TRW, Continental, Autoliv) store crash event records in
internal EEPROM. There are two storage categories:

  1. Crash Data Block (CDB) — the full event snapshot (accelerometer trace,
     deployment decisions, restraint status, impact severity). Multiple blocks
     may exist; FCA modules typically store 1-3 most recent events.
  
  2. Event Flag Register — a small set of bits/counters that indicate "this
     module has seen a deployment". Even after CDB is cleared, the flag may
     persist and cause DTC B1D04/B2105 or similar.

The standard UDS mechanism for clearing is Routine Control (SID 0x31):
    31 01 <rid_hi> <rid_lo>   — start routine
    31 03 <rid_hi> <rid_lo>   — request routine result

Common routine IDs used for crash clear across FCA suppliers:
    0xDF01 — Bosch ORC "Clear Crash Data" (pre-2015 mainstream)
    0xDF02 — Bosch ORC "Clear Event Flags" 
    0x0203 — TRW ORC "Delete Crash Record"
    0xFF01 — Some Continental variants
    0x0201 — Generic FCA post-2014 "Clear Deployment Flag"

Not all suppliers accept all routine IDs. The tool tries the module's known
primary routine, then falls back through the alternatives with clear logging.

ADDITIONAL CONSIDERATIONS:

  - ORC must be in PROGRAMMING session (0x02), NOT extended (0x03). Extended
    session usually allows seed/key but refuses destructive operations.
  - Requires security unlock BEFORE routine control.
  - After clear, ECU reset (11 01) is required for the module to reinitialize.
  - If the routine returns 0x72 positive response with a status byte, that
    byte indicates remaining deployment count (0x00 = cleared, non-zero =
    retry needed).
  - Some modules require TWO runs: first clear CDB, reset, then clear flags.

USAGE (CLI):
    python srtlab_orc_clear.py --module bosch_orc --dry-run
    python srtlab_orc_clear.py --module trw_orc --verify
    python srtlab_orc_clear.py --tx 0x78C --rx 0x794 --algo bosch_orc

USAGE (library):
    from srtlab_orc_clear import clear_crash_data
    clear_crash_data('bosch_orc')

SAFETY WARNINGS:

  THIS TOOL CANNOT TELL THE DIFFERENCE BETWEEN A DONOR MODULE THAT WAS CLEARED
  PROPERLY AT RECYCLING AND ONE WITH STRUCTURAL/ELECTRICAL DAMAGE. If the
  module has internal hardware damage from the deployment (blown FETs, cracked
  traces, charred squib drivers), no software clear will make it safe. Always:
  
    1. Visually inspect the module case for impact/burn marks.
    2. Check with a scope that all squib outputs show correct open-circuit
       resistance when disarmed.
    3. After clear, confirm NO DTCs B1D00-B1DFF are stored.
    4. Only then clear DTCs (14 FF FF FF) and continue.

  A misdeployed module in a live vehicle is a liability exposure — for you,
  not just the driver. Treat this tool as a working-order REFURBISHMENT aid,
  not a "make-bad-module-good" button.
"""
import argparse
import re
import sys
import time

from srtlab_ecm_vin_write import (
    J2534, find_j2534_dll, log,
    enter_diag_session, tester_present, request_seed, send_key, ecu_reset,
    SID_ROUTINE_CONTROL, NEG_RESPONSE, NEG_RESPONSE_NAMES,
)
from srtlab_canflash_algos import CANFLASH_ALGOS

try:
    from srtlab_uds_errors import decode_nrc
except ImportError:
    decode_nrc = lambda n: NEG_RESPONSE_NAMES.get(n, '?')

try:
    from srtlab_unlock_catalog import MODULE_INFO, unlock as _catalog_unlock
    _HAVE_CATALOG = True
except ImportError:
    _HAVE_CATALOG = False


# ═══════════════════════════════════════════════════════════════════════
# ORC module CAN addresses and supplier mapping
# ═══════════════════════════════════════════════════════════════════════
# Values cross-checked against canflash DLL metadata and AlfaOBD database.
# Each entry: the canflash algorithm key + tx/rx + supplier family.

ORC_MODULES = {
    'bosch_orc': {
        'label': 'Bosch ORC (2007-2014 mainstream FCA)',
        'algo':  'bosch_orc',
        'tx':    0x7A0,
        'rx':    0x7A8,
        'supplier': 'bosch',
        'session_for_clear': 0x02,  # programming session
        'clear_routines': [0xDF01, 0xDF02],
        'verify_routine': 0xDF03,  # "get crash data status" (if present)
    },
    'trw_orc': {
        'label': 'TRW ORC (2008-2014 Ram/Grand Cherokee)',
        'algo':  'trw_orc',
        'tx':    0x7A0,
        'rx':    0x7A8,
        'supplier': 'trw',
        'session_for_clear': 0x02,
        'clear_routines': [0x0203, 0x0201],
        'verify_routine': 0x0204,
    },
    # The "generic OCM" entries in the catalog are Occupant Classification
    # Modules — they live under the passenger seat and classify occupant
    # presence but can still contain deployment flags.
    'ocm': {
        'label': 'OCM (passenger seat occupant classification)',
        'algo':  'ocm',
        'tx':    0x7A1,
        'rx':    0x7A9,
        'supplier': 'generic',
        'session_for_clear': 0x02,
        'clear_routines': [0x0201],
        'verify_routine': None,
    },
    'trw_ocm': {
        'label': 'TRW OCM',
        'algo':  'trw_ocm',
        'tx':    0x7A1,
        'rx':    0x7A9,
        'supplier': 'trw',
        'session_for_clear': 0x02,
        'clear_routines': [0x0203],
        'verify_routine': None,
    },
    # Post-2014 variants — algorithm may not match, but address + routine
    # layout often stays stable within a supplier family.
    'bosch_orc_2015': {
        'label': 'Bosch ORC 2015+ (Hellcat/Scat Pack) — experimental',
        'algo':  'bosch_orc',  # may not unlock; test first
        'tx':    0x7A0,
        'rx':    0x7A8,
        'supplier': 'bosch',
        'session_for_clear': 0x02,
        'clear_routines': [0xDF01, 0xDF02, 0xFF01],
        'verify_routine': 0xDF03,
        'warning': 'Algorithm not confirmed for 2015+. Unlock may fail.',
    },
    'dart_orc': {
        'label': 'Dodge Dart / Compass ORC (seen in AlfaOBD as DART_ORC)',
        'algo':  'bosch_orc',  # Dart uses Bosch internals
        'tx':    0x7A0,
        'rx':    0x7A8,
        'supplier': 'bosch',
        'session_for_clear': 0x02,
        'clear_routines': [0xDF01, 0xDF02],
        'verify_routine': 0xDF03,
        'warning': 'Uses same address space as other Bosch ORC — confirm by scan first.',
    },
}

# Routine-specific positive-response decoders. Key = routine ID, value = function
# that takes the raw status bytes and returns a human-readable string.
ROUTINE_STATUS_DECODERS = {
    0xDF01: lambda d: (
        f"status=0x{d[0]:02X} "
        f"({'cleared OK' if d[0] == 0x00 else f'remaining count {d[0]}'})"
        if d else "no status byte"
    ),
    0xDF02: lambda d: (
        f"flag status=0x{d[0]:02X} "
        f"({'flags cleared' if d[0] == 0x00 else 'flags still set'})"
        if d else "no status byte"
    ),
    0x0203: lambda d: f"TRW clear response: {d.hex() if d else '(empty)'}",
    0x0201: lambda d: f"Generic clear response: {d.hex() if d else '(empty)'}",
}


# ═══════════════════════════════════════════════════════════════════════
# Routine control UDS primitives (extends the base set in srtlab_ecm_vin_write)
# ═══════════════════════════════════════════════════════════════════════
ROUTINE_START  = 0x01
ROUTINE_STOP   = 0x02
ROUTINE_RESULT = 0x03


def start_routine(j, tx, rx, routine_id, params=None):
    """UDS 31 01 <rid_hi> <rid_lo> [params...] — start routine."""
    params = params or []
    msg = [SID_ROUTINE_CONTROL, ROUTINE_START,
           (routine_id >> 8) & 0xFF, routine_id & 0xFF] + list(params)
    j.write_uds(tx, msg)
    resp = j.read_uds(expected_rx=rx, timeout_ms=10000)  # clears can be slow
    if resp is None:
        return None, "no response"
    if resp[0] == NEG_RESPONSE:
        nrc = resp[2] if len(resp) > 2 else 0
        return None, f"NRC 0x{nrc:02X} {decode_nrc(nrc)}"
    # Positive response: 71 01 <rid_hi> <rid_lo> [status...]
    if resp[0] != 0x71 or resp[1] != ROUTINE_START:
        return None, f"unexpected response {resp[:2].hex()}"
    status_data = bytes(resp[4:])  # strip 71 01 RIDhi RIDlo
    return status_data, None


def routine_result(j, tx, rx, routine_id):
    """UDS 31 03 <rid_hi> <rid_lo> — request routine final result."""
    msg = [SID_ROUTINE_CONTROL, ROUTINE_RESULT,
           (routine_id >> 8) & 0xFF, routine_id & 0xFF]
    j.write_uds(tx, msg)
    resp = j.read_uds(expected_rx=rx, timeout_ms=5000)
    if resp is None:
        return None, "no response"
    if resp[0] == NEG_RESPONSE:
        nrc = resp[2] if len(resp) > 2 else 0
        return None, f"NRC 0x{nrc:02X} {decode_nrc(nrc)}"
    if resp[0] != 0x71 or resp[1] != ROUTINE_RESULT:
        return None, f"unexpected response {resp[:2].hex()}"
    return bytes(resp[4:]), None


def _unlock(j, tx, rx, algo_key):
    """Run seed/key for the given algorithm. Returns (ok, error_msg)."""
    seed_bytes, err = request_seed(j, tx, rx, subfn=0x01)
    if err:
        return False, f"seed request failed: {err}"
    log(f"Got seed: {seed_bytes.hex()}", 'SEED')
    
    # Resolve algorithm: first try the full catalog, then fall back to the
    # 14-algorithm canflash set.
    key_int = None
    if _HAVE_CATALOG:
        try:
            seed_int = int.from_bytes(seed_bytes[:4], 'big')
            key_int = _catalog_unlock(algo_key, seed_int)
        except (KeyError, ValueError):
            pass
    if key_int is None:
        algo_fn = CANFLASH_ALGOS.get(algo_key)
        if algo_fn is None:
            return False, f"no unlock algorithm '{algo_key}' in catalog or canflash set"
        seed_int = int.from_bytes(seed_bytes[:4], 'big')
        key_int = algo_fn(seed_int)
    
    key_bytes = key_int.to_bytes(4, 'big')
    log(f"Computed key: {key_bytes.hex()}", 'KEY')
    
    ok, err = send_key(j, tx, rx, key_bytes, subfn=0x02)
    if err:
        return False, f"send_key failed: {err}"
    if not ok:
        return False, "send_key: module did not return 67 02 positive response"
    return True, None


# ═══════════════════════════════════════════════════════════════════════
# Crash-data clear workflow
# ═══════════════════════════════════════════════════════════════════════
def clear_crash_data(module_key, j2534_dll_path=None, tx=None, rx=None, algo=None,
                     dry_run=False, verify=True, session=None, reset_after=True,
                     skip_unlock=False):
    """Complete crash-data clear sequence for a single ORC.
    
    Args:
        module_key: One of ORC_MODULES keys, or None if using explicit tx/rx/algo.
        j2534_dll_path: J2534 DLL (autodetected from Autel install if None).
        tx, rx: Explicit CAN IDs (overrides the module entry).
        algo: Explicit algorithm key (overrides the module entry).
        dry_run: Print what would be done, don't contact hardware.
        verify: After clear, re-read status to confirm.
        session: Override session byte (default 0x02 = programming).
        reset_after: Run 11 01 (ECU reset) after successful clear.
        skip_unlock: Skip security access (useful if already unlocked upstream).
    
    Returns:
        dict: {
            'success': bool,
            'module': module_key,
            'routines_tried': [...],
            'routine_succeeded': int or None,
            'status_bytes': bytes or None,
            'message': str,
        }
    """
    # ── Resolve module/address/algorithm parameters ────────────────────
    if module_key:
        if module_key not in ORC_MODULES:
            raise ValueError(
                f"unknown ORC '{module_key}'. Available: {list(ORC_MODULES)}"
            )
        mod = ORC_MODULES[module_key]
        effective_tx    = tx if tx is not None else mod['tx']
        effective_rx    = rx if rx is not None else mod['rx']
        effective_algo  = algo if algo is not None else mod['algo']
        clear_routines  = mod['clear_routines']
        verify_routine  = mod.get('verify_routine')
        effective_sess  = session if session is not None else mod['session_for_clear']
        if 'warning' in mod:
            log(f"⚠️  {mod['warning']}", 'WARN')
    else:
        if None in (tx, rx, algo):
            raise ValueError("must provide either module_key, or all of tx/rx/algo")
        effective_tx = tx
        effective_rx = rx
        effective_algo = algo
        clear_routines = [0xDF01, 0xDF02, 0x0203, 0x0201]  # try them all
        verify_routine = None
        effective_sess = session if session is not None else 0x02
    
    result = {
        'success': False,
        'module': module_key,
        'tx': effective_tx,
        'rx': effective_rx,
        'algo': effective_algo,
        'routines_tried': [],
        'routine_succeeded': None,
        'status_bytes': None,
        'message': '',
    }
    
    log(f"Target: {module_key or 'custom'} @ tx=0x{effective_tx:03X} rx=0x{effective_rx:03X}", 'TARGET')
    log(f"Unlock algorithm: {effective_algo}", 'ALGO')
    log(f"Session: 0x{effective_sess:02X} ({'programming' if effective_sess==0x02 else 'extended' if effective_sess==0x03 else 'other'})", 'SESSION')
    log(f"Clear routines to try (in order): {[f'0x{r:04X}' for r in clear_routines]}", 'PLAN')
    
    if dry_run:
        log("DRY RUN — would now connect J2534 and run the above sequence", 'DRYRUN')
        log("Bailing before any hardware contact.", 'DRYRUN')
        result['success'] = True
        result['message'] = 'dry run — no hardware contact'
        return result
    
    # ── Connect J2534 device ────────────────────────────────────────────
    dll = j2534_dll_path or find_j2534_dll()
    if not dll:
        result['message'] = 'no J2534 DLL found — pass --dll or install Autel PC Suite'
        return result
    log(f"J2534 DLL: {dll}", 'J2534')
    
    j = J2534(dll)
    try:
        j.open()
        j.connect()
        log("J2534 open + connected", 'J2534')
        
        # ── 1. Programming session ──────────────────────────────────────
        ok, err = enter_diag_session(j, effective_tx, effective_rx, effective_sess)
        if not ok:
            result['message'] = f'session 0x{effective_sess:02X} rejected: {err}'
            log(result['message'], 'ERR')
            return result
        log(f"Entered session 0x{effective_sess:02X}", 'OK')
        tester_present(j, effective_tx)
        
        # ── 2. Security unlock ──────────────────────────────────────────
        if skip_unlock:
            log("Skipping unlock (--skip-unlock)", 'SKIP')
        else:
            ok, err = _unlock(j, effective_tx, effective_rx, effective_algo)
            if not ok:
                result['message'] = f'unlock failed: {err}'
                log(result['message'], 'ERR')
                # If unlock with algorithm fails, the routine might not need it
                # on some older modules. We still try but warn loudly.
                log("⚠️  Proceeding WITHOUT unlock — routine may be rejected", 'WARN')
            else:
                log("Security access granted", 'OK')
        
        tester_present(j, effective_tx)
        
        # ── 3. Try each clear routine in order ──────────────────────────
        for rid in clear_routines:
            log(f"Trying routine 0x{rid:04X} (start)...", 'CLEAR')
            status, err = start_routine(j, effective_tx, effective_rx, rid)
            result['routines_tried'].append({
                'rid': rid,
                'result': err if err else 'OK',
                'status': status.hex() if status else None,
            })
            
            if err:
                log(f"  0x{rid:04X} rejected: {err}", 'TRY')
                continue
            
            # Decode status
            if rid in ROUTINE_STATUS_DECODERS and status:
                decoded = ROUTINE_STATUS_DECODERS[rid](status)
                log(f"  0x{rid:04X} returned: {decoded}", 'OK')
            else:
                log(f"  0x{rid:04X} returned {len(status) if status else 0} status bytes: {status.hex() if status else '(empty)'}", 'OK')
            
            # Check for "still has data" signal. Most modules return 0x00 on
            # clean clear; non-zero first byte means retry.
            if status and len(status) >= 1 and status[0] != 0x00:
                log(f"  status byte non-zero (0x{status[0]:02X}) — may need second pass", 'WARN')
            
            result['routine_succeeded'] = rid
            result['status_bytes'] = status
            result['success'] = True
            break  # first successful routine is enough
        
        if not result['success']:
            result['message'] = 'all clear routines rejected'
            log(result['message'], 'ERR')
            return result
        
        tester_present(j, effective_tx)
        
        # ── 4. Verify (optional) ────────────────────────────────────────
        if verify and verify_routine:
            log(f"Verification: requesting result of routine 0x{verify_routine:04X}", 'VERIFY')
            vstatus, err = routine_result(j, effective_tx, effective_rx, verify_routine)
            if err:
                log(f"  verify routine rejected: {err}", 'WARN')
                result['message'] += ' (verify inconclusive)'
            else:
                log(f"  verify status: {vstatus.hex() if vstatus else '(empty)'}", 'VERIFY')
                if vstatus and all(b == 0 for b in vstatus):
                    log("  ✓ ORC reports NO crash data remaining", 'VERIFY')
                    result['message'] = 'cleared and verified'
                else:
                    log("  ⚠️  status non-zero — crash data may still be present", 'WARN')
                    result['message'] = 'cleared but verification not clean'
        elif verify:
            log("No verify-routine defined for this module — skipping confirmation", 'VERIFY')
            result['message'] = 'cleared (no verify routine available)'
        else:
            result['message'] = 'cleared (verify skipped)'
        
        # ── 5. ECU reset ────────────────────────────────────────────────
        if reset_after:
            log("Sending ECU reset (11 01) to commit changes", 'RESET')
            ok, err = ecu_reset(j, effective_tx, effective_rx)
            if err:
                log(f"  reset responded with error: {err}", 'WARN')
            else:
                log("  reset acknowledged (or silence — module rebooting)", 'OK')
            time.sleep(1.5)  # let the module reinitialize
        
        return result
    
    finally:
        try:
            j.disconnect()
            j.close()
        except Exception:
            pass


# ═══════════════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════════════
def main():
    ap = argparse.ArgumentParser(
        description='Clear crash/deployment data from an FCA airbag controller.',
        epilog='Read the safety warnings at the top of this file before using.'
    )
    ap.add_argument('--module', help='Module key from ORC_MODULES (bosch_orc, trw_orc, ocm, etc.)')
    ap.add_argument('--list', action='store_true', help='List known ORC modules and exit')
    ap.add_argument('--tx', type=lambda s: int(s, 0), help='Override TX CAN ID (e.g. 0x78C)')
    ap.add_argument('--rx', type=lambda s: int(s, 0), help='Override RX CAN ID (e.g. 0x794)')
    ap.add_argument('--algo', help='Override unlock algorithm key')
    ap.add_argument('--session', type=lambda s: int(s, 0),
                    help='Override session byte (default 0x02 programming)')
    ap.add_argument('--dll', help='Path to J2534 DLL (autodetected if omitted)')
    ap.add_argument('--dry-run', action='store_true',
                    help="Print the plan, don't talk to hardware")
    ap.add_argument('--no-verify', action='store_true', help='Skip post-clear verification')
    ap.add_argument('--no-reset', action='store_true', help="Skip ECU reset after clear")
    ap.add_argument('--skip-unlock', action='store_true',
                    help='Skip security access (useful if unlocked upstream)')
    args = ap.parse_args()
    
    if args.list:
        print(f"\n{'KEY':<20s} {'TX':<6s} {'RX':<6s} {'SUPPLIER':<10s} LABEL")
        print('─' * 90)
        for k, m in ORC_MODULES.items():
            print(f"{k:<20s} 0x{m['tx']:03X}  0x{m['rx']:03X}  {m['supplier']:<10s} {m['label']}")
        return 0
    
    if not args.module and not (args.tx and args.rx and args.algo):
        ap.error('must specify --module or all of --tx, --rx, --algo')
    
    result = clear_crash_data(
        module_key=args.module,
        j2534_dll_path=args.dll,
        tx=args.tx,
        rx=args.rx,
        algo=args.algo,
        session=args.session,
        dry_run=args.dry_run,
        verify=not args.no_verify,
        reset_after=not args.no_reset,
        skip_unlock=args.skip_unlock,
    )
    
    print()
    print('─' * 60)
    print(f"Result: {'SUCCESS' if result['success'] else 'FAILED'}")
    print(f"Module:    {result['module']}")
    print(f"Routines:  {len(result['routines_tried'])} tried")
    if result['routine_succeeded']:
        print(f"Cleared via: routine 0x{result['routine_succeeded']:04X}")
    if result['status_bytes']:
        print(f"Status:    {result['status_bytes'].hex()}")
    print(f"Message:   {result['message']}")
    
    return 0 if result['success'] else 1


if __name__ == '__main__':
    sys.exit(main())
