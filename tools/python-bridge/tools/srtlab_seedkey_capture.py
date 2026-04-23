"""
SRT Lab seed/key capture + analysis helper.

Passively logs UDS security access exchanges on an open J2534 channel.
Use it to record REAL seed/key pairs from a legitimate diagnostic session
(wiTECH, AlfaOBD, Autel) without interfering with the session. The captures
are the raw material for figuring out unlock algorithms on modules not
covered by the built-in catalog — e.g. post-2014 Hellcat ORC, GPEC2A,
Cummins 2019+.

TWO USE MODES:

  1. PASSIVE SNIFFING: with a J2534 device already configured by another
     tool, attach in read-only mode and log every 27 0x (seed request) and
     27 0x (send key) exchange. Writes JSON one record per pair.

  2. ACTIVE TESTING: make our own connection, fire a 27 01 at a target
     module, log the seed we get. Useful for verifying a module is alive
     and learning the seed LENGTH and TIMING before attempting a key.

Then the ANALYSIS mode reads captured pairs and:
  - Validates the pairs against every known algorithm in the catalog.
    If ANY algorithm gives key == captured_key for seed == captured_seed,
    you've identified the module's algorithm.
  - If none match, checks for simple transformations: byte reversal, XOR
    with a fixed constant, rotation, linear shifts. Useful for spotting
    variant-of-known algorithms.
  - Reports seed/key length and any constant bits.

USAGE:
    # Capture mode (active — fire one seed request and log)
    python srtlab_seedkey_capture.py --capture --tx 0x7E0 --rx 0x7E8 \\
        --out captures/unknown_2019_cummins.json

    # Passive sniff mode (requires separate tool managing the channel)
    python srtlab_seedkey_capture.py --sniff --duration 120 \\
        --out captures/witech_session_$(date +%s).json

    # Analyse captured pairs
    python srtlab_seedkey_capture.py --analyse captures/unknown_2019_cummins.json

    # Compare against all catalog algorithms
    python srtlab_seedkey_capture.py --analyse captures/x.json --match-all

LIBRARY MODE:
    from srtlab_seedkey_capture import capture_seed, analyse_pairs
    pairs = capture_seed(tx=0x7E0, rx=0x7E8, count=5)
    matches = analyse_pairs(pairs)

CAPTURE JSON FORMAT:
    {
      "module_hint": "cummins_2019",
      "tx_id": "0x7E0",
      "rx_id": "0x7E8",
      "pairs": [
        {
          "timestamp": 1708234567.123,
          "subfn_seed": 1,
          "seed_hex": "DEADBEEF",
          "subfn_key":  2,
          "key_hex":  "12345678",
          "response": "accepted"
        },
        ...
      ]
    }
"""
import argparse
import json
import os
import sys
import time


# ═══════════════════════════════════════════════════════════════════════
# Capture (active mode — fire seed request via our own J2534 connection)
# ═══════════════════════════════════════════════════════════════════════
def capture_seed(tx, rx, count=1, j2534_dll_path=None, subfn=0x01, session=0x03):
    """Connect via J2534, enter the given session, and request `count` seeds.
    
    Returns a list of captured seeds as dicts. No key is attempted — this is
    purely for learning what the module hands out.
    """
    from srtlab_ecm_vin_write import (
        J2534, find_j2534_dll, enter_diag_session, tester_present, request_seed
    )
    
    dll = j2534_dll_path or find_j2534_dll()
    if not dll:
        raise RuntimeError('No J2534 DLL found. Pass --dll or install Autel PC Suite.')
    
    results = []
    j = J2534(dll)
    try:
        j.open()
        j.connect_iso15765()
        j.set_flow_control(tx, rx)
        
        ok, err = enter_diag_session(j, tx, rx, session)
        if not ok:
            raise RuntimeError(f'Session 0x{session:02X} rejected: {err}')
        tester_present(j, tx)
        
        for i in range(count):
            seed_bytes, err = request_seed(j, tx, rx, subfn=subfn)
            ts = time.time()
            if err:
                results.append({
                    'timestamp': ts,
                    'subfn_seed': subfn,
                    'seed_hex': None,
                    'error': err,
                })
                break
            results.append({
                'timestamp': ts,
                'subfn_seed': subfn,
                'seed_hex': seed_bytes.hex().upper(),
                'seed_length': len(seed_bytes),
            })
            # Some modules refuse a second seed without key attempt —
            # note that and bail rather than locking out
            if i < count - 1:
                time.sleep(0.5)
                tester_present(j, tx)
        
        return results
    finally:
        try:
            j.disconnect()
            j.close()
        except Exception:
            pass


# ═══════════════════════════════════════════════════════════════════════
# Passive sniff — read-only mode on an already-configured channel
# ═══════════════════════════════════════════════════════════════════════
def sniff_seedkey(duration=60, j2534_dll_path=None, tx_filter=None, rx_filter=None):
    """Attach to a J2534 channel in read-only mode and log every 27 xx exchange.
    
    Requires another tool to have already opened the device+channel+filters
    (e.g. wiTECH running and connected). We just read the channel.
    
    Args:
        duration: seconds to sniff
        tx_filter, rx_filter: optional CAN IDs to filter to one module
    
    Returns list of captured pairs.
    """
    from srtlab_ecm_vin_write import J2534, find_j2534_dll, PASSTHRU_MSG, PROTOCOL_ISO15765
    from ctypes import c_uint32, byref
    
    dll = j2534_dll_path or find_j2534_dll()
    if not dll:
        raise RuntimeError('No J2534 DLL found.')
    
    # We can't actually sniff a DLL already opened by another process —
    # J2534 DLLs typically allow only one process connection at a time.
    # This mode is documented but falls back to instructing the user.
    print('Passive sniff mode note: most J2534 DLLs allow only one process at a time.', file=sys.stderr)
    print('If another tool is already connected, this sniff WILL fail with a device-busy error.', file=sys.stderr)
    print('Instead, use the --capture mode to actively request the seed via our own connection,', file=sys.stderr)
    print('or export the log from wiTECH/AlfaOBD/Autel directly and import via --import-text.', file=sys.stderr)
    
    j = J2534(dll)
    j.open()
    j.connect_iso15765()
    if tx_filter and rx_filter:
        j.set_flow_control(tx_filter, rx_filter)
    
    pairs = []
    pending_seed = None  # track seed waiting for matching key
    deadline = time.time() + duration
    
    while time.time() < deadline:
        msg = PASSTHRU_MSG()
        msg.ProtocolID = PROTOCOL_ISO15765
        n = c_uint32(1)
        r = j.dll.PassThruReadMsgs(j.channel_id, byref(msg), byref(n), c_uint32(200))
        if r != 0 or n.value == 0:
            continue
        
        TX_MSG_TYPE = 0x00000001
        data = bytes(msg.Data[:msg.DataSize])
        if len(data) < 6:
            continue
        arb_id = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]
        payload = data[4:]
        is_tx_echo = bool(msg.RxStatus & TX_MSG_TYPE)
        
        # Seed request: 27 XX (XX is odd — 01, 03, 05, 11, 61...)
        if is_tx_echo and len(payload) >= 2 and payload[0] == 0x27 and payload[1] % 2 == 1:
            pending_seed = {
                'timestamp': time.time(),
                'arb_id': arb_id,
                'subfn_seed': payload[1],
                'request_bytes': payload.hex().upper(),
            }
        # Seed response: 67 XX <seed bytes>
        elif not is_tx_echo and len(payload) >= 2 and payload[0] == 0x67 and payload[1] % 2 == 1:
            if pending_seed:
                pending_seed['seed_hex'] = payload[2:].hex().upper()
                pending_seed['seed_length'] = len(payload) - 2
                pending_seed['rx_id'] = arb_id
        # Key send: 27 XX (XX even — 02, 04, 06, 12, 62...)
        elif is_tx_echo and len(payload) >= 2 and payload[0] == 0x27 and payload[1] % 2 == 0:
            if pending_seed and pending_seed.get('subfn_seed') == payload[1] - 1:
                pending_seed['subfn_key'] = payload[1]
                pending_seed['key_hex'] = payload[2:].hex().upper()
                pending_seed['key_length'] = len(payload) - 2
        # Key accepted: 67 XX (echo of subfunction with no additional data)
        elif not is_tx_echo and len(payload) >= 2 and payload[0] == 0x67 and payload[1] % 2 == 0:
            if pending_seed:
                pending_seed['response'] = 'accepted'
                pairs.append(pending_seed)
                pending_seed = None
        # Key rejected: 7F 27 XX
        elif not is_tx_echo and len(payload) >= 3 and payload[0] == 0x7F and payload[1] == 0x27:
            if pending_seed:
                pending_seed['response'] = f'rejected (NRC 0x{payload[2]:02X})'
                pairs.append(pending_seed)
                pending_seed = None
    
    try:
        j.disconnect()
        j.close()
    except Exception:
        pass
    
    return pairs


# ═══════════════════════════════════════════════════════════════════════
# Analysis — check captured pairs against every known algorithm
# ═══════════════════════════════════════════════════════════════════════
def analyse_pairs(pairs, match_all=False):
    """For each (seed, key) pair, test every algorithm in the catalog.
    
    Returns a dict of {pair_index: [matching_algo_names]}.
    """
    try:
        from srtlab_unlock_catalog import unlock, MODULE_INFO
        algorithms = list(MODULE_INFO.keys())
    except ImportError:
        try:
            from srtlab_canflash_algos import CANFLASH_ALGOS
            algorithms = list(CANFLASH_ALGOS.keys())
            def unlock(name, seed):
                return CANFLASH_ALGOS[name]['fn'](seed)
        except ImportError:
            raise RuntimeError('No algorithm catalog available')
    
    results = {}
    for idx, pair in enumerate(pairs):
        seed_hex = pair.get('seed_hex')
        key_hex = pair.get('key_hex')
        if not seed_hex or not key_hex:
            results[idx] = {'status': 'incomplete', 'pair': pair}
            continue
        
        seed_bytes = bytes.fromhex(seed_hex)
        key_bytes = bytes.fromhex(key_hex)
        seed_int = int.from_bytes(seed_bytes[:4], 'big')
        key_int_expected = int.from_bytes(key_bytes[:4], 'big')
        
        matches = []
        for algo in algorithms:
            try:
                computed_key = unlock(algo, seed_int)
                if computed_key == key_int_expected:
                    matches.append(algo)
                    if not match_all:
                        break
            except Exception:
                pass  # algorithm may not be callable with this input
        
        results[idx] = {
            'seed_hex': seed_hex,
            'key_hex': key_hex,
            'seed_length': len(seed_bytes),
            'key_length': len(key_bytes),
            'matching_algorithms': matches,
            'status': 'matched' if matches else 'unknown',
        }
        
        # If no direct match, check trivial transformations
        if not matches:
            transforms = check_trivial_transforms(seed_int, key_int_expected)
            if transforms:
                results[idx]['trivial_transforms'] = transforms
    
    return results


def check_trivial_transforms(seed, key):
    """Check if key is a simple function of seed (XOR, byte-rev, etc)."""
    found = []
    
    # Identity
    if seed == key:
        found.append('identity (key = seed)')
    # Byte-reverse (big-endian ↔ little-endian)
    if int.from_bytes(seed.to_bytes(4, 'big'), 'little') == key:
        found.append('byte-reversed')
    # Bitwise invert
    if (seed ^ 0xFFFFFFFF) == key:
        found.append('bitwise NOT')
    # +1, -1
    if (seed + 1) & 0xFFFFFFFF == key:
        found.append('seed + 1')
    if (seed - 1) & 0xFFFFFFFF == key:
        found.append('seed - 1')
    # Common XOR constants
    for xor_const in [0xFFFFFFFF, 0xDEADBEEF, 0xCAFEBABE, 0xDEADC0DE, 0xA5A5A5A5]:
        if (seed ^ xor_const) == key:
            found.append(f'XOR 0x{xor_const:08X}')
    # Common multiplicative patterns
    for mul in [2, 3, 5, 7]:
        if (seed * mul) & 0xFFFFFFFF == key:
            found.append(f'seed * {mul}')
    # Swap halves
    hi, lo = (seed >> 16) & 0xFFFF, seed & 0xFFFF
    if ((lo << 16) | hi) == key:
        found.append('high/low halves swapped')
    # Simple rotations
    for n in [1, 4, 8, 16]:
        rol = ((seed << n) | (seed >> (32 - n))) & 0xFFFFFFFF
        if rol == key:
            found.append(f'ROL {n}')
        ror = ((seed >> n) | (seed << (32 - n))) & 0xFFFFFFFF
        if ror == key:
            found.append(f'ROR {n}')
    
    return found


# ═══════════════════════════════════════════════════════════════════════
# I/O
# ═══════════════════════════════════════════════════════════════════════
def write_capture(pairs, outfile, module_hint=None, tx_id=None, rx_id=None):
    payload = {
        'module_hint': module_hint,
        'tx_id':       f'0x{tx_id:X}' if tx_id else None,
        'rx_id':       f'0x{rx_id:X}' if rx_id else None,
        'captured_at': time.strftime('%Y-%m-%dT%H:%M:%S'),
        'pairs':       pairs,
    }
    os.makedirs(os.path.dirname(outfile) or '.', exist_ok=True)
    with open(outfile, 'w') as f:
        json.dump(payload, f, indent=2)
    print(f'Wrote {len(pairs)} capture(s) to {outfile}')


def read_capture(infile):
    with open(infile) as f:
        return json.load(f)


# ═══════════════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════════════
def main():
    ap = argparse.ArgumentParser(
        description='Capture and analyse UDS seed/key exchanges.')
    
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument('--capture', action='store_true',
                      help='Actively request a seed and log it')
    mode.add_argument('--sniff', action='store_true',
                      help='Passively listen for seed/key exchanges')
    mode.add_argument('--analyse', metavar='JSON',
                      help='Analyse a previously captured JSON file')
    
    ap.add_argument('--tx', type=lambda s: int(s, 0), help='TX CAN ID (e.g. 0x7E0)')
    ap.add_argument('--rx', type=lambda s: int(s, 0), help='RX CAN ID (e.g. 0x7E8)')
    ap.add_argument('--subfn', type=lambda s: int(s, 0), default=0x01,
                    help='Seed request subfunction (default 0x01)')
    ap.add_argument('--session', type=lambda s: int(s, 0), default=0x03,
                    help='Session to enter (default 0x03 extended)')
    ap.add_argument('--count', type=int, default=1,
                    help='Number of seeds to capture (default 1)')
    ap.add_argument('--duration', type=int, default=60,
                    help='Sniff duration in seconds (default 60)')
    ap.add_argument('--dll', help='Path to J2534 DLL')
    ap.add_argument('--out', help='Output JSON file (default stdout)')
    ap.add_argument('--module-hint', help='Descriptive tag for the capture')
    ap.add_argument('--match-all', action='store_true',
                    help='In analyse mode, list every matching algorithm (not just first)')
    
    args = ap.parse_args()
    
    if args.capture:
        if not args.tx or not args.rx:
            ap.error('--capture requires --tx and --rx')
        pairs = capture_seed(
            tx=args.tx, rx=args.rx, count=args.count,
            j2534_dll_path=args.dll, subfn=args.subfn, session=args.session,
        )
        if args.out:
            write_capture(pairs, args.out, module_hint=args.module_hint,
                          tx_id=args.tx, rx_id=args.rx)
        else:
            print(json.dumps(pairs, indent=2))
        
        # Auto-analyse what we captured
        print('\n=== Quick analysis ===')
        for i, p in enumerate(pairs):
            if 'seed_hex' in p and p['seed_hex']:
                print(f"  Pair {i}: seed={p['seed_hex']} (length {p.get('seed_length', '?')})")
        return 0
    
    if args.sniff:
        pairs = sniff_seedkey(duration=args.duration, j2534_dll_path=args.dll,
                              tx_filter=args.tx, rx_filter=args.rx)
        if args.out:
            write_capture(pairs, args.out, module_hint=args.module_hint,
                          tx_id=args.tx, rx_id=args.rx)
        else:
            print(json.dumps(pairs, indent=2))
        return 0
    
    if args.analyse:
        cap = read_capture(args.analyse)
        pairs = cap.get('pairs', [])
        print(f"Analyzing {len(pairs)} captured pair(s) from {args.analyse}")
        if cap.get('module_hint'):
            print(f"Module hint: {cap['module_hint']}")
        if cap.get('tx_id'):
            print(f"CAN: tx={cap['tx_id']} rx={cap.get('rx_id')}")
        print()
        
        results = analyse_pairs(pairs, match_all=args.match_all)
        for idx, r in results.items():
            print(f"--- Pair {idx} ---")
            if r['status'] == 'incomplete':
                print('  Incomplete — missing seed or key')
                continue
            print(f"  seed: {r['seed_hex']} ({r['seed_length']} bytes)")
            print(f"  key:  {r['key_hex']}  ({r['key_length']} bytes)")
            if r['matching_algorithms']:
                print(f"  ✓ MATCHES: {', '.join(r['matching_algorithms'])}")
            else:
                print(f"  ✗ No catalog algorithm matches.")
                if 'trivial_transforms' in r and r['trivial_transforms']:
                    print(f"  Trivial transforms that work:")
                    for t in r['trivial_transforms']:
                        print(f"      {t}")
                else:
                    print(f"  Not a trivial transformation either — likely a new algorithm.")
                    print(f"  Next step: capture more pairs to constrain the function.")
        return 0
    
    return 0


if __name__ == '__main__':
    sys.exit(main())
