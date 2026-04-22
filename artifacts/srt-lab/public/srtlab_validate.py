#!/usr/bin/env python3
"""
SRT Lab — Dump Validator
Validates BCM and RFHUB dump integrity before flashing.
Catches the kinds of issues that show up as "password couldn't be read" 
after flashing incorrectly-edited bins.
"""

import sys
import re
import argparse
from pathlib import Path


def crc16_ccitt(data, init=0xFFFF, poly=0x1021):
    c = init
    for b in data:
        c ^= b << 8
        for _ in range(8):
            c = (c << 1) ^ poly if c & 0x8000 else c << 1
            c &= 0xFFFF
    return c


VIN_RE = re.compile(rb'^[12345][A-HJ-NPR-Z0-9][A-HJ-NPR-Z0-9][A-HJ-NPR-Z0-9]{14}$')
BCM_SLOT_TYPES = [0x46, 0x52, 0x53, 0x56, 0x57]
BCM_SLOT_LEN = 32  # 8b header + 17b VIN + 2b CRC + 5b footer
RFH_VIN_OFFSETS = [0x0EA5, 0x0EB9, 0x0ECD, 0x0EE1]
RFH_SEC16_OFFSETS = [0x0226, 0x023A]
RFH_SEC16_LEN = 18


class Issue:
    def __init__(self, severity, msg, offset=None):
        self.severity = severity   # 'error', 'warn', 'info'
        self.msg = msg
        self.offset = offset

    def __str__(self):
        sev_tag = {'error': '✗', 'warn': '⚠', 'info': '·'}[self.severity]
        loc = f' @0x{self.offset:04X}' if self.offset is not None else ''
        return f'  {sev_tag} {self.msg}{loc}'


def validate_bcm(data):
    """Validate a Huntsville BCM dump. Returns (summary_dict, [Issue, ...])."""
    issues = []
    summary = {
        'kind': 'BCM',
        'size': len(data),
        'vins': [],
        'parts': [],
        'magic_offsets': [],
        'bank_seqs': [],
        'vin_crcs_ok': True,
    }

    # Magic FEE1000 scan
    magic = b'FEE1000'
    for i in range(len(data) - len(magic)):
        if data[i:i+len(magic)] == magic:
            summary['magic_offsets'].append(i)
            if i >= 2:
                summary['bank_seqs'].append((i-2, (data[i-2] << 8) | data[i-1]))

    if not summary['magic_offsets']:
        issues.append(Issue('error', 'No FEE1000 magic found — not a Huntsville BCM dump?'))

    # VIN slot scan
    slots = []
    for i in range(len(data) - 32):
        if data[i] != 0x00 or data[i+1] != 0x46: continue
        if data[i+2] not in BCM_SLOT_TYPES: continue
        if data[i+3] != 0x00: continue
        vs = i + 4
        if vs + 17 > len(data): continue
        vin_bytes = data[vs:vs+17]
        if not VIN_RE.match(vin_bytes): continue
        # Check CRC at vs+17..vs+18
        if vs + 19 > len(data): continue
        stored_crc = (data[vs+17] << 8) | data[vs+18]
        computed_crc = crc16_ccitt(vin_bytes)
        ok = stored_crc == computed_crc
        slots.append({
            'offset': vs,
            'slot_type': data[i+2],
            'vin': vin_bytes.decode(),
            'stored_crc': stored_crc,
            'computed_crc': computed_crc,
            'crc_ok': ok,
        })
        if not ok:
            summary['vin_crcs_ok'] = False

    summary['vins'] = slots
    if not slots:
        issues.append(Issue('error', 'No VIN slots detected in BCM'))
    else:
        unique_vins = set(s['vin'] for s in slots)
        if len(unique_vins) > 1:
            issues.append(Issue('error', f'VIN slots inconsistent: {unique_vins}'))
        for s in slots:
            if not s['crc_ok']:
                issues.append(Issue('error',
                    f'VIN CRC mismatch: stored 0x{s["stored_crc"]:04X}, '
                    f'computed 0x{s["computed_crc"]:04X} for VIN {s["vin"]}',
                    offset=s['offset']))

    # Part numbers
    text = data.decode('ascii', errors='replace')
    pns = set(re.findall(r'68\d{6}', text))
    summary['parts'] = sorted(pns)

    return summary, issues


def validate_rfh(data):
    """Validate a Yazaki FCM RFHUB EEPROM dump. Returns (summary, [Issue, ...])."""
    issues = []
    summary = {
        'kind': 'RFHUB',
        'size': len(data),
        'vins': [],
        'sec16_slot1': None,
        'sec16_slot2': None,
        'sec16_match': False,
        'sec16_virgin': False,
        'parts': [],
        'vin_checksums_ok': True,
    }

    if len(data) < 0x1000:
        issues.append(Issue('error', f'File too small ({len(data)}b) for RFHUB dump'))
        return summary, issues

    # VIN slots (4 × byte-reversed)
    slots = []
    for off in RFH_VIN_OFFSETS:
        if off + 18 > len(data): continue
        raw = data[off:off+17]
        reversed_vin = raw[::-1]
        if not VIN_RE.match(reversed_vin):
            issues.append(Issue('warn', f'VIN slot at 0x{off:04X} does not decode to valid VIN'))
            continue
        stored_chk = data[off+17]
        vin_sum = sum(raw) & 0xFF
        # Formula: chk = (0xF9 - sum) & 0xFF  (for 2015-2017 LX, varies for older)
        expected = (0xF9 - vin_sum) & 0xFF
        ok = stored_chk == expected
        slots.append({
            'offset': off,
            'vin': reversed_vin.decode(),
            'stored_chk': stored_chk,
            'computed_chk': expected,
            'chk_ok': ok,
            'vin_sum': vin_sum,
        })
        if not ok:
            summary['vin_checksums_ok'] = False

    summary['vins'] = slots
    if not slots:
        issues.append(Issue('error', 'No VIN slots detected in RFHUB'))
    else:
        unique_vins = set(s['vin'] for s in slots)
        if len(unique_vins) > 1:
            issues.append(Issue('error', f'RFHUB VIN slots inconsistent: {unique_vins}'))
        for s in slots:
            if not s['chk_ok']:
                issues.append(Issue('warn',
                    f'VIN checksum mismatch: stored 0x{s["stored_chk"]:02X}, '
                    f'expected 0x{s["computed_chk"]:02X} for VIN {s["vin"]} '
                    f'(sum=0x{s["vin_sum"]:02X}); some older variants use different formula',
                    offset=s['offset']))

    # SEC16
    if len(data) >= RFH_SEC16_OFFSETS[0] + RFH_SEC16_LEN:
        summary['sec16_slot1'] = data[RFH_SEC16_OFFSETS[0]:RFH_SEC16_OFFSETS[0]+RFH_SEC16_LEN]
    if len(data) >= RFH_SEC16_OFFSETS[1] + RFH_SEC16_LEN:
        summary['sec16_slot2'] = data[RFH_SEC16_OFFSETS[1]:RFH_SEC16_OFFSETS[1]+RFH_SEC16_LEN]
    if summary['sec16_slot1'] and summary['sec16_slot2']:
        summary['sec16_match'] = summary['sec16_slot1'] == summary['sec16_slot2']
        summary['sec16_virgin'] = (all(b == 0xFF for b in summary['sec16_slot1']) and
                                     all(b == 0xFF for b in summary['sec16_slot2']))
        if summary['sec16_virgin']:
            issues.append(Issue('info',
                'SEC16 VIRGIN — both slots are FF. Module will re-negotiate pairing on power-up.'))
        elif not summary['sec16_match']:
            issues.append(Issue('warn',
                'SEC16 slot1 != slot2. Unexpected — usually indicates partial write or corruption.'))

    # Part numbers
    text = data.decode('ascii', errors='replace')
    pns = set(re.findall(r'(?:AA|BA)\d{8}', text))
    summary['parts'] = sorted(pns)

    return summary, issues


def pair_check(bcm_summary, rfh_summary):
    """Cross-check BCM and RFHUB for pairing."""
    issues = []
    if not bcm_summary['vins'] or not rfh_summary['vins']:
        return issues
    bcm_vin = bcm_summary['vins'][0]['vin']
    rfh_vin = rfh_summary['vins'][0]['vin']
    if bcm_vin != rfh_vin:
        issues.append(Issue('error',
            f'VIN MISMATCH between modules: BCM={bcm_vin}, RFHUB={rfh_vin}. '
            'Programming tools will refuse to continue.'))
    else:
        issues.append(Issue('info', f'BCM and RFHUB both carry VIN {bcm_vin}'))

    if rfh_summary['sec16_virgin']:
        issues.append(Issue('info',
            'RFHUB SEC16 is virgin — after flashing, power-cycle 30s for fresh pairing. '
            'Then retry key programming with dealer PIN.'))
    elif rfh_summary['sec16_match']:
        issues.append(Issue('info',
            'RFHUB SEC16 slots match each other (paired state). If this is a salvage '
            'rebuild and keys won\'t program, virginize SEC16 to force re-pair.'))

    return issues


def summary_print(s):
    print(f'  Size: {s["size"]} bytes (0x{s["size"]:X})')
    if s['kind'] == 'BCM':
        print(f'  FEE1000 magic: {len(s["magic_offsets"])} occurrences at {[hex(o) for o in s["magic_offsets"]]}')
        if s['bank_seqs']:
            seqs = [f'bank @0x{o:04X} seq=0x{sq:04X}' for o, sq in s['bank_seqs']]
            print(f'  Bank sequences: {", ".join(seqs)}')
        print(f'  Part numbers: {", ".join(s["parts"]) or "none found"}')
        print(f'  VIN slots:')
        for v in s['vins']:
            tag = 'F' if v['slot_type'] == 0x46 else chr(v['slot_type'])
            status = '✓' if v['crc_ok'] else '✗'
            print(f'    @0x{v["offset"]:04X} [{tag}]: {v["vin"]} CRC-16 stored=0x{v["stored_crc"]:04X} '
                  f'computed=0x{v["computed_crc"]:04X} {status}')
    else:  # RFHUB
        print(f'  Part numbers: {", ".join(s["parts"]) or "none found"}')
        print(f'  VIN slots:')
        for v in s['vins']:
            status = '✓' if v['chk_ok'] else '✗'
            print(f'    @0x{v["offset"]:04X}: {v["vin"]} sum=0x{v["vin_sum"]:02X} '
                  f'chk stored=0x{v["stored_chk"]:02X} expected=0x{v["computed_chk"]:02X} {status}')
        if s['sec16_slot1']:
            print(f'  SEC16 slot 1 @0x0226: {s["sec16_slot1"].hex()}')
            print(f'  SEC16 slot 2 @0x023A: {s["sec16_slot2"].hex()}')
            if s['sec16_virgin']:
                print(f'  SEC16: VIRGIN (both slots all FF)')
            elif s['sec16_match']:
                print(f'  SEC16: PAIRED (slots identical)')
            else:
                print(f'  SEC16: MISMATCH (slots differ)')


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--bcm', type=Path, help='BCM .bin file')
    ap.add_argument('--rfh', type=Path, help='RFHUB .bin file')
    args = ap.parse_args()

    exit_code = 0

    if args.bcm:
        print(f'\n=== BCM: {args.bcm} ===')
        bcm_summary, bcm_issues = validate_bcm(args.bcm.read_bytes())
        summary_print(bcm_summary)
        for iss in bcm_issues:
            print(iss)
            if iss.severity == 'error': exit_code = 1
    else:
        bcm_summary, bcm_issues = None, []

    if args.rfh:
        print(f'\n=== RFHUB: {args.rfh} ===')
        rfh_summary, rfh_issues = validate_rfh(args.rfh.read_bytes())
        summary_print(rfh_summary)
        for iss in rfh_issues:
            print(iss)
            if iss.severity == 'error': exit_code = 1
    else:
        rfh_summary, rfh_issues = None, []

    if bcm_summary and rfh_summary:
        print(f'\n=== Pairing check ===')
        for iss in pair_check(bcm_summary, rfh_summary):
            print(iss)
            if iss.severity == 'error': exit_code = 1

    print()
    sys.exit(exit_code)


if __name__ == '__main__':
    main()
