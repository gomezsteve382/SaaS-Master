"""
SRT Lab module parser — Python port of parseModule.js.

Field-by-field port of artifacts/srt-lab/src/lib/parseModule.js, using the 
verified CRC primitives from srtlab_crc.py. Every offset, every constant, 
every sync rule comes from the Replit source.

Parses: BCM (64K/128K), RFHUB Gen1/Gen2 (2K/4K), GPEC2A (4K), 95640 (8K/16K),
plus signature-based TCM and TIPM detection.

Cross-module rules are in srtlab_crossvalidate (separate file, not here).
"""

import re
from srtlab_crc import (crc16, crc8rf, rfh_gen2_vin_cs, rfh_gen2_detect_magic,
                        rfh_sec16_cs)


# ─── Constants (from constants.js) ──────────────────────────────────────────

IMMO_REC = 24        # bytes per SKIM record
IMMO_KC = 8          # SKIM records per block
IMMO_BLOCK = IMMO_REC * IMMO_KC  # 192 bytes

SKIM_VALUES = {0x80: 'ENABLED', 0x00: 'DISABLED', 0x02: 'DISABLED (alt)'}


# ─── Helpers ────────────────────────────────────────────────────────────────

def _extract_vin(data, offset, length=17):
    """Extract ASCII VIN. Returns None if any byte is outside 0x30-0x5A."""
    if offset + length > len(data):
        return None
    b = data[offset:offset + length]
    for x in b:
        if x < 0x30 or x > 0x5A:
            return None
    return b.decode('ascii')


def _extract_hex(data, offset, length):
    """Space-separated uppercase hex dump."""
    return ' '.join(f'{data[offset + i]:02X}' for i in range(length))


def _arr_eq(a, b):
    if len(a) != len(b):
        return False
    return all(a[i] == b[i] for i in range(len(a)))


def _rd32(data, o):
    """Big-endian uint32 read."""
    return (data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3]


def _count_aa50(d, start, n):
    """Count AA50 marker pairs in n 2-byte slots starting at start."""
    c = 0
    for i in range(n):
        if d[start + i * 2] == 0xAA and d[start + i * 2 + 1] == 0x50:
            c += 1
    return c


def _count_pat(d, a, b, c2, d2):
    """Count 4-byte patterns in d."""
    c = 0
    for i in range(len(d) - 3):
        if d[i] == a and d[i + 1] == b and d[i + 2] == c2 and d[i + 3] == d2:
            c += 1
    return c


# ─── Public API ─────────────────────────────────────────────────────────────

def count_skim_recs(d, base):
    """Count non-empty 24-byte SKIM records (up to IMMO_KC=8)."""
    c = 0
    for i in range(IMMO_KC):
        o = base + i * IMMO_REC
        if o + IMMO_REC > len(d):
            break
        r = d[o:o + IMMO_REC]
        if not all(b == 0xFF or b == 0x00 for b in r):
            c += 1
    return c


def sync_immo_backup(data):
    """Copy 192-byte IMMO primary (0x40C0) → backup (0x2000).
    Returns new bytes or None if the dump is too small."""
    if len(data) < 0x40C0 + IMMO_BLOCK or len(data) < 0x2000 + IMMO_BLOCK:
        return None
    out = bytearray(data)
    for i in range(IMMO_BLOCK):
        out[0x2000 + i] = out[0x40C0 + i]
    return bytes(out)


def detect_by_signature(data):
    """TCM / TIPM heuristic detection for ambiguous 4K/8K dumps."""
    sz = len(data)
    if 4096 <= sz <= 20480:
        b0, b1 = data[0], data[1]
        class_marker = data[0x10]
        has_tcm_marker = (b0 == 0x00 and b1 == 0x00) or (b0 == 0xFF and b1 == 0xFF)
        tcm_class = 0x01 <= class_marker <= 0x08
        has_55aa = False
        for i in range(min(32, sz - 1)):
            if data[i] == 0x55 and data[i + 1] == 0xAA:
                has_55aa = True
                break
        has_a5 = data[2] == 0xA5 or data[3] == 0xA5 or data[4] == 0xA5
        if (has_tcm_marker and tcm_class) or (has_55aa and tcm_class) or (has_a5 and tcm_class):
            return 'TCM'
    if 1024 <= sz <= 10240:
        tipm_variant = data[0x04] in (0x36, 0x80, 0x81, 0x3C)
        aa_count = sum(1 for i in range(min(16, sz)) if data[i] == 0xAA)
        has_aa_pattern = aa_count >= 4
        tipm_header = (data[0] == 0x00 and data[1] == 0x00) or (data[0] == 0xFF and data[1] == 0xFF)
        if tipm_variant and (has_aa_pattern or tipm_header):
            return 'TIPM'
    return 'UNKNOWN'


def parse_module(data, filename=''):
    """Auto-detect module type and extract every documented field.
    
    Mirrors parseModule() in parseModule.js. Returns a dict with all the 
    same keys as the JS info object.
    """
    if isinstance(data, (bytes, bytearray)):
        data = bytes(data)
    else:
        data = bytes(data)
    sz = len(data)
    
    # Detection
    type_ = 'UNKNOWN'
    if sz in (65536, 131072):
        type_ = 'BCM'
    elif sz in (8192, 16384):
        sig = detect_by_signature(data)
        type_ = sig if sig != 'UNKNOWN' else '95640'
    elif sz == 4096:
        sig4 = detect_by_signature(data)
        if sig4 != 'UNKNOWN':
            type_ = sig4
        else:
            # GPEC2A if valid VIN char range at offset 0
            va = True
            for i in range(min(17, sz)):
                b = data[i]
                if not ((0x30 <= b <= 0x39) or (0x41 <= b <= 0x5A)):
                    va = False
                    break
            type_ = 'GPEC2A' if va else 'RFHUB'
    elif sz > 131072:
        type_ = 'FW'
    
    if type_ == 'UNKNOWN':
        canonical = [65536, 131072, 8192, 16384, 4096]
        near = any(abs(sz - s) <= 4096 and sz != s for s in canonical)
        if near or sz >= 512:
            sig = detect_by_signature(data)
            if sig != 'UNKNOWN':
                type_ = sig
    
    info = {'type': type_, 'filename': filename, 'data': data, 'size': sz}
    if type_ == 'UNKNOWN':
        info['hexOnly'] = True
    
    # ─── GPEC2A parsing ──────────────────────────────────────────────────
    if type_ == 'GPEC2A':
        vins = []
        for off in (0x0000, 0x01F0, 0x0224):
            v = _extract_vin(data, off)
            if v:
                vins.append({'offset': off, 'vin': v})
        info['vins'] = vins
        info['skimByte'] = data[0x0011]
        info['skimStatus'] = SKIM_VALUES.get(data[0x0011], f'UNKNOWN (0x{data[0x0011]:02X})')
        info['secretKey'] = {'offset': 0x0203, 'bytes': data[0x0203:0x020B],
                             'hex': _extract_hex(data, 0x0203, 8)}
        info['secretKeyMirror'] = {'offset': 0x0361, 'bytes': data[0x0361:0x0369],
                                   'hex': _extract_hex(data, 0x0361, 8)}
        info['keyConsistent'] = _arr_eq(data[0x0203:0x020B], data[0x0361:0x0369])
        info['skey'] = data[0x0203:0x020B]
        info['skoff'] = 0x0203
        info['skmoff'] = 0x0361
        info['skb'] = all(b == 0xFF for b in info['skey'])
        info['transponderKeys'] = []
        for i in range(4):
            o = 0x0888 + i * 4
            info['transponderKeys'].append({'offset': o, 'hex': _extract_hex(data, o, 4)})
        info['zzzzTamper'] = {'offset': 0x0C8C, 'hex': _extract_hex(data, 0x0C8C, 8),
                              'intact': data[0x0C8C] == 0x5A}
        info['partNumberStr'] = _extract_vin(data, 0x0FA1, 13) or _extract_hex(data, 0x0FA1, 13)
        info['runtimeCounters'] = {
            'counterA':  {'offset': 0x0E61, 'value': _rd32(data, 0x0E61), 'hex': _extract_hex(data, 0x0E61, 4)},
            'counterB':  {'offset': 0x0E69, 'value': _rd32(data, 0x0E69), 'hex': _extract_hex(data, 0x0E69, 4)},
            'distance':  {'offset': 0x0E6D, 'value': _rd32(data, 0x0E6D), 'hex': _extract_hex(data, 0x0E6D, 4)},
            'keyCycles': {'offset': 0x0E75, 'value': _rd32(data, 0x0E75), 'hex': _extract_hex(data, 0x0E75, 4)},
        }
        if sz > 0x3CE:
            s6 = data[0x3C8:0x3CE]
            s6blank = all(b == 0xFF or b == 0x00 for b in s6)
            s6damaged = all(b == 0xFF for b in s6)
            info['pcmSec6'] = {
                'offset': 0x3C8, 'raw': s6, 'hex': _extract_hex(data, 0x3C8, 6),
                'blank': s6blank, 'damaged': s6damaged,
                'immoState': 'IMMO_DAMAGED' if s6damaged else 'SET',
            }
    
    # ─── RFHUB parsing ───────────────────────────────────────────────────
    elif type_ == 'RFHUB':
        known_offsets = [0x0EA5, 0x0EB9, 0x0ECD, 0x0EE1]
        rfh_is_gen2 = (sz == 4096)
        info['vins'] = []
        
        if rfh_is_gen2:
            # Auto-detect VIN CS magic (0xDB 2020+ Redeye, 0x87 earlier Gen2)
            rfh_magic = 0xDB
            for _o in known_offsets:
                _st = data[_o:_o + 17]
                _sc = data[_o + 17] if _o + 17 < sz else 0
                if not all(b == 0xFF or b == 0 for b in _st) and _sc not in (0x00, 0xFF):
                    rfh_magic = rfh_gen2_detect_magic(_st, _sc)
                    break
            
            for o in known_offsets:
                if o + 17 > sz:
                    continue
                st = data[o:o + 17]
                if all(b == 0xFF or b == 0 for b in st):
                    continue
                rev = bytes(st[16 - j] for j in range(17))
                s = rev.decode('ascii', errors='replace')
                if not re.match(r'^[1-9A-HJ-NPR-Z]', s):
                    continue
                sc = data[o + 17] if o + 17 < sz else 0
                cc = rfh_gen2_vin_cs(st, rfh_magic)
                info['vins'].append({'offset': o, 'vin': s, 'mirrored': True,
                                     'sc': sc, 'cc': cc, 'crcOk': sc == cc})
            info['rfhMagic'] = rfh_magic
        else:
            # Gen1: plain VIN with crc8rf
            known_vins = []
            for o in known_offsets:
                v = _extract_vin(data, o)
                if v:
                    sc = data[o + 17] if o + 17 < sz else 0
                    cc = crc8rf(data[o:o + 17])
                    known_vins.append({'offset': o, 'vin': v, 'mirrored': False,
                                       'sc': sc, 'cc': cc, 'crcOk': sc == cc})
            if known_vins:
                info['vins'] = known_vins
            else:
                # Fallback: try byte-reversed Gen1
                for o in known_offsets:
                    if o + 17 > sz:
                        continue
                    st = data[o:o + 17]
                    if all(b == 0xFF or b == 0 for b in st):
                        continue
                    rev = bytes(st[16 - j] for j in range(17))
                    s = rev.decode('ascii', errors='replace')
                    if re.match(r'^[1-9A-HJ-NPR-Z]', s):
                        sc = data[o + 17] if o + 17 < sz else 0
                        cc = crc8rf(st)
                        info['vins'].append({'offset': o, 'vin': s, 'mirrored': True,
                                             'sc': sc, 'cc': cc, 'crcOk': sc == cc})
        
        if len(data) >= 0x051E:
            info['vehicleSecret'] = {'offset': 0x050E, 'bytes': data[0x050E:0x051E],
                                     'hex': _extract_hex(data, 0x050E, 16), 'endian': 'big'}
        info['fobikSlots'] = _count_aa50(data, 0x0880, 10)
        info['securityMarkers'] = _count_pat(data, 0xCC, 0x66, 0xAA, 0x55)
        info['zzzzBlocks'] = _count_pat(data, 0x5A, 0x5A, 0x5A, 0x5A)
        info['partNumbers'] = {}
        hw = _extract_vin(data, 0x0808, 10)
        sw = _extract_vin(data, 0x0812, 10)
        cal = _extract_vin(data, 0x082C, 14)
        if hw: info['partNumbers']['hw'] = hw
        elif len(data) >= 0x0812: info['partNumbers']['hw'] = _extract_hex(data, 0x0808, 10)
        if sw: info['partNumbers']['sw'] = sw
        elif len(data) >= 0x081C: info['partNumbers']['sw'] = _extract_hex(data, 0x0812, 10)
        if cal: info['partNumbers']['cal'] = cal
        elif len(data) >= 0x083A: info['partNumbers']['cal'] = _extract_hex(data, 0x082C, 14)
        
        info['skey'] = data[0x40:0x50]
        info['skoff'] = 0x40
        info['skb'] = all(b == 0xFF for b in info['skey'])
        
        # rfhVin92 — 17 VIN bytes + 2-byte CRC16 at 0x92
        if sz >= 0x92 + 19:
            raw17 = data[0x92:0x92 + 17]
            not_blank = not all(b == 0xFF or b == 0 for b in raw17)
            if not_blank:
                s = raw17.decode('ascii', errors='replace')
                sc = (data[0x92 + 17] << 8) | data[0x92 + 18]
                cc = crc16(raw17)
                if re.match(r'^[1-9A-HJ-NPR-Z][A-HJ-NPR-Z0-9]{16}$', s):
                    info['rfhVin92'] = {'offset': 0x92, 'vin': s, 'storedCs': sc,
                                        'calcCs': cc, 'csOk': sc == cc}
        
        # SEC16 — Gen2 at 0x050E/0x0522, Gen1 at 0xAE/0xC0
        info['sec16s'] = []
        sec16_is_gen2 = sz in (4096, 8192)
        sec16_offsets = [(1, 0x050E), (2, 0x0522)] if sec16_is_gen2 else [(1, 0xAE), (2, 0xC0)]
        for slot, off in sec16_offsets:
            if off + 18 > sz:
                continue
            raw = data[off:off + 16]
            cs = (data[off + 16] << 8) | data[off + 17]
            blank = all(b == 0xFF or b == 0 for b in raw)
            hex_str = ''.join(f'{b:02X}' for b in raw)
            cs_calc = rfh_sec16_cs(raw) if sec16_is_gen2 else None
            cs_ok = (cs == cs_calc) if sec16_is_gen2 else None
            bcm_hex = ''.join(f'{b:02X}' for b in reversed(raw))
            info['sec16s'].append({'slot': slot, 'offset': off, 'raw': raw,
                                   'hex': hex_str, 'cs': cs, 'csCalc': cs_calc,
                                   'csOk': cs_ok, 'bcmHex': bcm_hex, 'blank': blank})
        if len(info['sec16s']) == 2:
            info['sec16match'] = _arr_eq(info['sec16s'][0]['raw'], info['sec16s'][1]['raw'])
            info['sec16valid'] = (not info['sec16s'][0]['blank']
                                  and info['sec16match']
                                  and (not sec16_is_gen2 or bool(info['sec16s'][0]['csOk'])))
        info['sec16SourceSlot'] = 1
        info['rfhGen'] = {4096: 'Gen2 (24C32)', 8192: 'Gen2-x2 (8192B, unusual)',
                          2048: 'Gen1 (24C16)'}.get(sz, 'Unknown')
    
    # ─── BCM parsing ─────────────────────────────────────────────────────
    elif type_ == 'BCM':
        # Primary VIN slots — 4 copies at stride 32
        vins = []
        for o in (0x5320, 0x5340, 0x5360, 0x5380):
            v = _extract_vin(data, o)
            if v:
                vins.append({'offset': o, 'vin': v})
        info['vins'] = vins
        
        # Partial VINs at 0x4098 and 0x40B0 — 8-char tail + 2-byte CRC16
        info['partialVins'] = []
        for po in (0x4098, 0x40B0):
            if po + 10 > sz:
                continue
            tail_bytes = data[po:po + 8]
            ok = all(0x20 <= b <= 0x7E for b in tail_bytes)
            if ok:
                tail_s = tail_bytes.decode('ascii')
                sc = (data[po + 8] << 8) | data[po + 9]
                cc = crc16(tail_bytes)
                info['partialVins'].append({'offset': po, 'tail': tail_s,
                                            'storedCrc': sc, 'calcCrc': cc,
                                            'crcOk': sc == cc})
        
        info['vehicleSecret'] = {'offset': 0x40C9, 'bytes': data[0x40C9:0x40D9],
                                 'hex': _extract_hex(data, 0x40C9, 16), 'endian': 'little'}
        info['securityLock'] = {'offset': 0x8028, 'value': data[0x8028],
                                'locked': data[0x8028] == 0x5A}
        info['fobikCount'] = data[0x5862]
        info['immoKeys'] = [{'offset': o, 'hex': _extract_hex(data, o, 16)}
                            for o in (0x81A4, 0x81C4, 0x81E4)]
        info['fobikParts'] = _extract_vin(data, 0x5818, 10) or _extract_hex(data, 0x5818, 10)
        info['skey'] = data[0x40C9:0x40D9]
        info['skoff'] = 0x40C9
        info['skb'] = all(b == 0xFF for b in info['skey'])
        info['skEndian'] = 'little'
        info['immoRecs'] = count_skim_recs(data, 0x40C0)
        info['immoBlank'] = info['immoRecs'] == 0
        info['bakRecs'] = count_skim_recs(data, 0x2000)
        info['bakBlank'] = info['bakRecs'] == 0
        info['immoSynced'] = (info['immoRecs'] > 0 and info['bakRecs'] > 0
                              and _arr_eq(data[0x40C0:0x40C0 + IMMO_BLOCK],
                                          data[0x2000:0x2000 + IMMO_BLOCK]))
    
    # ─── 95640 EEPROM parsing ────────────────────────────────────────────
    elif type_ == '95640':
        info['vins'] = []
        for off in (0x275, 0x288):
            v = _extract_vin(data, off)
            if v:
                info['vins'].append({'offset': off, 'vin': v})
        if sz >= 0x1B95:
            v = _extract_vin(data, 0x1B82)
            if v:
                info['vins'].append({'offset': 0x1B82, 'vin': v})
        info['skey'] = data[0x40:0x50]
        info['skoff'] = 0x40
        info['skb'] = all(b == 0xFF for b in info['skey'])
        info['fobBlank'] = all(b == 0xFF for b in data[0x200:0x240])
        
        # BCM-SEC16 at 0x838 (16 bytes + CRC16 BE at 0x848)
        if sz >= 0x84A:
            raw16 = data[0x838:0x848]
            stored_cs = (data[0x848] << 8) | data[0x849]
            calc_cs = crc16(raw16)
            cs_ok = stored_cs == calc_cs
            blank = all(b == 0xFF or b == 0 for b in raw16)
            hex_str = ''.join(f'{b:02X}' for b in raw16)
            reversed_bytes = bytes(reversed(raw16))
            reversed_hex = ''.join(f'{b:02X}' for b in reversed_bytes)
            info['bcmSec16'] = {'offset': 0x838, 'raw': raw16, 'hex': hex_str,
                                'reversed': reversed_bytes, 'reversedHex': reversed_hex,
                                'storedCs': stored_cs, 'calcCs': calc_cs,
                                'csOk': cs_ok, 'blank': blank}
    
    return info


if __name__ == '__main__':
    # Quick self-test using synthetic buffers
    print("SRT Lab parseModule — Python port")
    print("=" * 60)
    
    # Synthesize a GPEC2A: VIN at 0x0000, SKIM enabled, secret key consistent
    buf = bytearray(4096)
    vin = b'2C3CDZFJXKH741460'
    for off in (0x0000, 0x01F0, 0x0224):
        buf[off:off + 17] = vin
    buf[0x0011] = 0x80  # SKIM ENABLED
    buf[0x0203:0x020B] = b'\xDE\xAD\xBE\xEF\x01\x02\x03\x04'
    buf[0x0361:0x0369] = b'\xDE\xAD\xBE\xEF\x01\x02\x03\x04'  # mirror match
    buf[0x0C8C] = 0x5A  # ZZZZ intact
    
    m = parse_module(bytes(buf), 'synth_gpec.bin')
    print(f"\nGPEC2A (synth):")
    print(f"  type:           {m['type']}")
    print(f"  VINs:           {len(m['vins'])} copies")
    print(f"  skimByte:       0x{m['skimByte']:02X} ({m['skimStatus']})")
    print(f"  secretKey hex:  {m['secretKey']['hex']}")
    print(f"  mirror match:   {m['keyConsistent']}")
    print(f"  ZZZZ tamper:    intact={m['zzzzTamper']['intact']}")
    
    # Synthesize a BCM: VIN at 0x5320 × 4, correct CRCs, 16-byte secret LE
    from srtlab_crc import crc16 as _crc16
    buf = bytearray(65536)
    vin = b'2C3CDZFJXKH741460'
    crc = _crc16(vin).to_bytes(2, 'big')
    for o in (0x5320, 0x5340, 0x5360, 0x5380):
        buf[o:o + 17] = vin
        buf[o + 17:o + 19] = crc
    # Partial backups
    tail = vin[9:17]
    tail_crc = _crc16(tail).to_bytes(2, 'big')
    for po in (0x4098, 0x40B0):
        buf[po:po + 8] = tail
        buf[po + 8:po + 10] = tail_crc
    buf[0x40C9:0x40D9] = bytes.fromhex('0123456789ABCDEF0011223344556677')  # 16B LE
    buf[0x8028] = 0x5A  # locked
    buf[0x5862] = 0x02  # fobik count = 2
    
    m = parse_module(bytes(buf), 'synth_bcm.bin')
    print(f"\nBCM (synth):")
    print(f"  type:           {m['type']}")
    print(f"  VINs:           {len(m['vins'])} primary slots @ 0x5320/40/60/80")
    print(f"  partialVins:    {len(m['partialVins'])} ({'crc OK' if all(p['crcOk'] for p in m['partialVins']) else 'CRC BAD'})")
    print(f"  secretKey hex:  {m['vehicleSecret']['hex']} (LE)")
    print(f"  securityLock:   0x{m['securityLock']['value']:02X} ({'LOCKED' if m['securityLock']['locked'] else 'UNLOCKED'})")
    print(f"  fobikCount:     {m['fobikCount']}")
