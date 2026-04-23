"""
SRT Lab cross-module validator — Python port of crossValidate.js.

Security-byte sync rules that run across a set of parsed modules. Used to 
confirm BCM ↔ RFHUB ↔ GPEC ↔ 95640 consistency before committing any patched 
dump back to a vehicle.

Every rule in this file is pinned from artifacts/srt-lab/src/lib/crossValidate.js.
"""

from srtlab_parsemodule import _arr_eq, parse_module


def _fmt_hex(bs):
    return ' '.join(f'{b:02X}' for b in bs)


def compare_gpec_bcm_key(gpec_key, bcm_key):
    """Rule: first 8 bytes of reverse(BCM.vehicleSecret[16B LE]) == GPEC.secretKey[8B]."""
    bcm_rev = bytes(reversed(bcm_key))
    bcm_cmp = bcm_rev[:8]
    gpec_cmp = bytes(gpec_key[:8])
    return {
        'match': _arr_eq(gpec_cmp, bcm_cmp),
        'gpecBytes': gpec_cmp,
        'bcmBytes': bcm_cmp,
        'bcmFull': bcm_rev,
        'rule': 'BCM[16B LE] reversed → first 8B vs GPEC[8B]',
    }


def cross_validate(modules):
    """Run all sync rules across a list of parsed modules.
    
    modules: list of dicts as returned by parse_module()
    Returns: {'issues': [...], 'warnings': [...], 'passed': [...]}
    """
    issues = []
    warnings = []
    passed = []
    
    # ─── VIN consistency ─────────────────────────────────────────────
    all_vins = set()
    for m in modules:
        for v in m.get('vins', []) or []:
            all_vins.add(v['vin'])
    if len(all_vins) == 0:
        warnings.append('No VINs found.')
    elif len(all_vins) == 1:
        passed.append(f'VIN consistent: {next(iter(all_vins))}')
    else:
        issues.append(f'VIN MISMATCH: {", ".join(sorted(all_vins))}')
    
    rfhub = next((m for m in modules if m['type'] == 'RFHUB'), None)
    bcm = next((m for m in modules if m['type'] == 'BCM'), None)
    gpec = next((m for m in modules if m['type'] == 'GPEC2A'), None)
    e95 = next((m for m in modules if m['type'] == '95640'), None)
    
    # ─── RFHUB ↔ BCM vehicle secret ──────────────────────────────────
    # Rule: RFHUB.secret (BE) == reverse(BCM.secret (LE))
    if rfhub and rfhub.get('vehicleSecret') and bcm and bcm.get('vehicleSecret'):
        bcm_rev = bytes(reversed(bcm['vehicleSecret']['bytes']))
        if _arr_eq(rfhub['vehicleSecret']['bytes'], bcm_rev):
            passed.append('RFHUB ↔ BCM vehicle secret: MATCH (byte-reversed)')
        else:
            issues.append('RFHUB ↔ BCM vehicle secret: MISMATCH!')
    
    # ─── RFHUB SEC16 sanity ──────────────────────────────────────────
    if rfhub and rfhub.get('sec16s'):
        if rfhub.get('sec16valid'):
            passed.append('RFHUB SEC16: VALID — slots 1&2 match, non-blank')
        elif rfhub['sec16s'] and rfhub['sec16s'][0].get('blank'):
            warnings.append('RFHUB SEC16: BLANK (all FF/00) — virgin module')
        else:
            warnings.append('RFHUB SEC16: Slot 1/2 MISMATCH or unreadable')
    
    # ─── GPEC2A PCM SEC6 state ───────────────────────────────────────
    if gpec and gpec.get('pcmSec6'):
        if gpec['pcmSec6']['damaged']:
            issues.append('PCM SEC6 @ 0x3C8: IMMO_DAMAGED (FF FF FF FF FF FF) — needs RFH import')
        else:
            passed.append(f"PCM SEC6 @ 0x3C8: {gpec['pcmSec6']['hex']} ({gpec['pcmSec6']['immoState']})")
    
    # ─── RFHUB SEC16[0:6] ↔ PCM SEC6 ─────────────────────────────────
    # Rule: first 6 bytes of RFHUB SEC16 slot 1 == GPEC PCM SEC6
    if (rfhub and gpec and rfhub.get('sec16valid')
            and gpec.get('pcmSec6') and not gpec['pcmSec6']['damaged']):
        s16 = rfhub['sec16s'][0]['raw']
        s6 = gpec['pcmSec6']['raw']
        if _arr_eq(s6, s16[:6]):
            passed.append('RFHUB SEC16[0:6] ↔ PCM SEC6: MATCH ✓')
        else:
            warnings.append('RFHUB SEC16[0:6] ↔ PCM SEC6: MISMATCH — use RFH→PCM Import tool')
    
    # ─── GPEC ↔ BCM secret key ───────────────────────────────────────
    if gpec and gpec.get('secretKey') and bcm and bcm.get('vehicleSecret'):
        cmp = compare_gpec_bcm_key(gpec['secretKey']['bytes'], bcm['vehicleSecret']['bytes'])
        if cmp['match']:
            passed.append('GPEC↔BCM key: MATCH ✓ (BCM LE reversed, first 8B = GPEC 8B)')
        else:
            issues.append(f"GPEC↔BCM key: MISMATCH! GPEC={_fmt_hex(cmp['gpecBytes'])} "
                          f"BCM(rev)[0:8]={_fmt_hex(cmp['bcmBytes'])}")
    elif gpec and gpec.get('secretKey') and bcm:
        warnings.append('GPEC↔BCM key: BCM vehicle secret not found for comparison')
    
    # ─── GPEC2A SKIM state ───────────────────────────────────────────
    if gpec:
        if gpec.get('skimByte') == 0x80:
            passed.append('GPEC2A SKIM: ENABLED (0x80)')
        elif gpec.get('skimByte') == 0x00:
            warnings.append('GPEC2A SKIM: DISABLED (0x00) — bypassed')
        if not gpec.get('keyConsistent', True):
            issues.append('GPEC2A secret key INCONSISTENT (0x0203 vs 0x0361)!')
        else:
            passed.append('GPEC2A secret key consistent (0x0203 = 0x0361)')
        zz = gpec.get('zzzzTamper')
        if zz and not zz.get('intact'):
            warnings.append('GPEC2A ZZZZ tamper: CLEARED')
        elif zz and zz.get('intact'):
            passed.append('GPEC2A ZZZZ tamper: INTACT')
    
    # ─── BCM security lock ───────────────────────────────────────────
    if bcm and bcm.get('securityLock'):
        if bcm['securityLock']['locked']:
            passed.append('BCM lock: 0x5A LOCKED')
        else:
            warnings.append('BCM lock: UNLOCKED')
    
    # ─── FOBIK slot counts ───────────────────────────────────────────
    if rfhub:
        passed.append(f"RFHUB FOBIK: {rfhub.get('fobikSlots', 0)} slots")
        passed.append(f"RFHUB CC66AA55: {rfhub.get('securityMarkers', 0)}")
    if bcm:
        passed.append(f"BCM FOBIK: {bcm.get('fobikCount', 0)} keys")
        if rfhub and rfhub.get('fobikSlots') != bcm.get('fobikCount'):
            warnings.append(f"Key count mismatch: RFHUB={rfhub.get('fobikSlots')} "
                            f"BCM={bcm.get('fobikCount')}")
    
    # ─── 95640 secret key state ──────────────────────────────────────
    if e95:
        if not e95.get('skb', True):
            passed.append('95640 secret key: SET')
        else:
            warnings.append('95640 secret key: ERASED')
    
    # ─── 95640 ↔ RFHUB secret key ────────────────────────────────────
    if e95 and rfhub and not e95.get('skb', True) and not rfhub.get('skb', True):
        if _arr_eq(e95['skey'], rfhub['skey']):
            passed.append('95640 ↔ RFHUB secret key: MATCH')
        else:
            issues.append('95640 ↔ RFHUB secret key: MISMATCH!')
    
    # ─── 95640 BCM-SEC16 ─────────────────────────────────────────────
    if e95 and e95.get('bcmSec16'):
        bs = e95['bcmSec16']
        if bs['blank']:
            warnings.append('95640 BCM-SEC16 @ 0x838: BLANK (virgin EEPROM)')
        elif bs['csOk']:
            passed.append(f"95640 BCM-SEC16 @ 0x838: SET, CRC16 ✓ (→RFH: {bs['reversedHex'][:16]}…)")
        else:
            warnings.append(f"95640 BCM-SEC16 @ 0x838: CRC16 BAD "
                            f"(stored=0x{bs['storedCs']:04X} calc=0x{bs['calcCs']:04X})")
    
    # ─── RFHUB SEC16 ↔ 95640 BCM-SEC16 (reversed) ────────────────────
    if (rfhub and e95 and rfhub.get('sec16valid')
            and e95.get('bcmSec16') and not e95['bcmSec16']['blank']):
        rfh_hex = rfhub['sec16s'][0]['hex']
        if rfh_hex == e95['bcmSec16']['reversedHex']:
            passed.append('RFHUB SEC16 ↔ 95640 BCM-SEC16 (reversed): MATCH ✓')
        else:
            warnings.append('RFHUB SEC16 ↔ 95640 BCM-SEC16 (reversed): MISMATCH — use RFH→BCM Import tool')
    
    return {'issues': issues, 'warnings': warnings, 'passed': passed}


if __name__ == '__main__':
    print("SRT Lab cross-validator — Python port")
    print("=" * 60)
    
    # Synthetic test: 3 modules in sync (valid)
    from srtlab_crc import crc16
    
    # Build synthetic BCM
    bcm_buf = bytearray(65536)
    vin = b'2C3CDZFJXKH741460'
    vin_crc = crc16(vin).to_bytes(2, 'big')
    for o in (0x5320, 0x5340, 0x5360, 0x5380):
        bcm_buf[o:o + 17] = vin
        bcm_buf[o + 17:o + 19] = vin_crc
    tail = vin[9:17]; tail_crc = crc16(tail).to_bytes(2, 'big')
    for po in (0x4098, 0x40B0):
        bcm_buf[po:po + 8] = tail
        bcm_buf[po + 8:po + 10] = tail_crc
    # BCM vehicle secret (LE) — 16 bytes
    bcm_secret_le = bytes.fromhex('0011223344556677 8899AABBCCDDEEFF'.replace(' ',''))
    bcm_buf[0x40C9:0x40D9] = bcm_secret_le
    bcm_buf[0x8028] = 0x5A
    bcm_buf[0x5862] = 0x02
    
    # Build synthetic RFHUB (Gen2, 4096) — use reverse of BCM secret as RFHUB secret (BE)
    rfh_buf = bytearray(4096)
    # Set up VINs at 0xEA5/EB9/ECD/EE1 (byte-reversed for Gen2)
    vin_rev = vin[::-1]
    from srtlab_crc import rfh_gen2_vin_cs
    magic = 0xDB
    for o in (0x0EA5, 0x0EB9, 0x0ECD, 0x0EE1):
        rfh_buf[o:o + 17] = vin_rev
        rfh_buf[o + 17] = rfh_gen2_vin_cs(vin_rev, magic)
    # RFHUB vehicle secret (BE) == reverse(BCM_LE)
    rfh_buf[0x050E:0x051E] = bytes(reversed(bcm_secret_le))
    # FOBIK slots AA50 — 2 slots
    rfh_buf[0x0880:0x0884] = b'\xAA\x50\xAA\x50'
    
    # Build synthetic GPEC2A
    gpec_buf = bytearray(4096)
    for off in (0x0000, 0x01F0, 0x0224):
        gpec_buf[off:off + 17] = vin
    gpec_buf[0x0011] = 0x80
    # GPEC secret key 8B == first 8 of reverse(BCM_LE)
    gpec_secret = bytes(reversed(bcm_secret_le))[:8]
    gpec_buf[0x0203:0x020B] = gpec_secret
    gpec_buf[0x0361:0x0369] = gpec_secret  # mirror matches
    gpec_buf[0x0C8C] = 0x5A  # ZZZZ intact
    # PCM SEC6 @ 0x3C8 — set to first 6 bytes of RFHUB SEC16 (we haven't set SEC16,
    # so leave it as 0x00 which will be "SET" not "IMMO_DAMAGED")
    
    bcm = parse_module(bytes(bcm_buf), 'bcm.bin')
    rfh = parse_module(bytes(rfh_buf), 'rfh.bin')
    gpec = parse_module(bytes(gpec_buf), 'gpec.bin')
    
    print(f"\nParsed: BCM={bcm['type']}, RFHUB={rfh['type']}, GPEC={gpec['type']}")
    
    result = cross_validate([bcm, rfh, gpec])
    print(f"\n  PASSED ({len(result['passed'])}):")
    for p in result['passed']:
        print(f"    ✓ {p}")
    print(f"\n  WARNINGS ({len(result['warnings'])}):")
    for w in result['warnings']:
        print(f"    ⚠ {w}")
    print(f"\n  ISSUES ({len(result['issues'])}):")
    for i in result['issues']:
        print(f"    ✗ {i}")
