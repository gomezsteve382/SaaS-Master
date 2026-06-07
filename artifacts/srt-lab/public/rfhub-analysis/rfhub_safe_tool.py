#!/usr/bin/env python3
"""
rfhub_safe_tool.py — RFHUB 24C32 EEPROM inspection utility.

This tool is intentionally scoped for authorized diagnostic/research use. It reports VIN
layout, checksum/trailer evidence, structural markers, and redacted summaries of sensitive
security/key material. It does not dump SEC16 secrets, transponder identifiers, or PINs.

Supported operations:
  inspect FILE.bin [--json]
  scan-dir DIR [--csv OUT.csv]
  set-gen2-vin FILE.bin VIN --out OUT.bin [--magic auto|87|db]

The set-gen2-vin command is limited to the supplemental reversed-VIN Gen2 layout
(0x0EA5/0x0EB9/0x0ECD/0x0EE1, 17 reversed bytes + XOR checksum byte). It will not modify
low-offset ASCII VIN layouts because the two-byte trailer algorithm was not proven from
these samples.
"""
from __future__ import annotations
import argparse, csv, hashlib, json, re, sys
from pathlib import Path
from typing import Dict, List, Tuple, Any

VIN_RE = re.compile(rb'[A-HJ-NPR-Z0-9]{17}')
SUPP_GEN2_VIN_OFFSETS = [0x0EA5, 0x0EB9, 0x0ECD, 0x0EE1]
SUPP_SEC_HEADER = 0x0500
SUPP_SEC_SLOTS = [(0x050E, 0x051E), (0x0522, 0x0532)]
SUPP_KEY_MARKERS = [0x0880, 0x0882, 0x0884, 0x0886]
SUPP_KEY_IDS = [0x0888 + 8*i for i in range(4)]
LOW_PIN_CANDIDATE = 0x01E3
LOW_ASCII_KNOWN_VIN_OFFSETS = [0x0040, 0x0053, 0x0092, 0x00A5, 0x016A, 0x01EA, 0x01FD]

def is_vin_bytes(b: bytes) -> bool:
    if len(b) != 17 or not VIN_RE.fullmatch(b):
        return False
    # Reject obvious EEPROM placeholders such as DDDDDDDDDDDDDDDDD or 000... .
    if len(set(b)) <= 2:
        return False
    # For North American VINs the ninth character is a check digit, 0-9 or X;
    # this filters shifted overlaps and calibration strings that otherwise match
    # the broad VIN alphabet.
    if b[8:9] not in b'0123456789X':
        return False
    return True

def sha8(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()[:8]

def crc8_65(data: bytes) -> int:
    c = 0xBF
    for x in data:
        c ^= x
        for _ in range(8):
            if c & 0x80:
                c = ((c << 1) ^ 0x65) & 0xFF
            else:
                c = (c << 1) & 0xFF
    return c

def gen2_vin_cs(raw17_reversed: bytes, magic: int) -> int:
    x = 0
    for b in raw17_reversed:
        x ^= b
    return x ^ magic

def bcd_le_4digits(two: bytes) -> str | None:
    if len(two) != 2: return None
    nibbles = [two[0] & 0x0F, two[0] >> 4, two[1] & 0x0F, two[1] >> 4]
    if all(0 <= n <= 9 for n in nibbles):
        return ''.join(str(n) for n in nibbles)
    return None

def detect_low_ascii_vins(d: bytes) -> List[Dict[str, Any]]:
    out=[]
    seen=set()
    for off in LOW_ASCII_KNOWN_VIN_OFFSETS:
        rec=d[off:off+19]
        if len(rec) >= 19 and is_vin_bytes(rec[:17]):
            trailer=rec[17:19]
            out.append({'offset':off,'vin':rec[:17].decode('ascii'),'trailer_be':trailer.hex().upper(), 'known_offset':True})
            seen.add(off)
    for m in VIN_RE.finditer(d):
        off=m.start()
        if off not in seen and is_vin_bytes(m.group()):
            trailer=d[off+17:off+19]
            out.append({'offset':off,'vin':m.group().decode('ascii'),'trailer_be':trailer.hex().upper() if len(trailer)==2 else '', 'known_offset':False})
    out.sort(key=lambda r:r['offset'])
    return out

def detect_supplemental_gen2(d: bytes) -> List[Dict[str, Any]]:
    out=[]
    for off in SUPP_GEN2_VIN_OFFSETS:
        raw=d[off:off+17]
        cs=d[off+17] if off+17 < len(d) else None
        vin=raw[::-1]
        if is_vin_bytes(vin):
            xor_raw=0
            for b in raw: xor_raw ^= b
            magic = cs ^ xor_raw if cs is not None else None
            out.append({'offset':off,'vin':vin.decode('ascii'), 'stored_checksum':f'{cs:02X}', 'derived_magic':f'{magic:02X}', 'valid_with_87':cs==gen2_vin_cs(raw,0x87), 'valid_with_db':cs==gen2_vin_cs(raw,0xDB)})
    return out

def inspect(path: Path) -> Dict[str, Any]:
    d=path.read_bytes()
    if len(d)!=4096:
        raise ValueError(f'{path} is {len(d)} bytes, expected 4096 for 24C32')
    low=detect_low_ascii_vins(d)
    supp=detect_supplemental_gen2(d)
    hdr=d[SUPP_SEC_HEADER:SUPP_SEC_HEADER+4]
    sec=[]
    for data_off,chk_off in SUPP_SEC_SLOTS:
        secdata=d[data_off:data_off+16]
        stored=d[chk_off:chk_off+2]
        calc=crc8_65(secdata)
        sec.append({'slot_offset':data_off,'sha256_8':sha8(secdata),'stored_check_redacted':stored.hex().upper(), 'supp_crc8_65_matches': stored == bytes([calc,0x00])})
    aa50=[off for off in SUPP_KEY_MARKERS if d[off:off+2]==b'\xAA\x50']
    aa50_any=[]; s=0
    while True:
        i=d.find(b'\xAA\x50',s)
        if i<0: break
        aa50_any.append(i); s=i+1
    pin_bytes=d[LOW_PIN_CANDIDATE:LOW_PIN_CANDIDATE+2]
    pin_bcd=bcd_le_4digits(pin_bytes)
    return {
        'file': str(path),
        'size': len(d),
        'sha256': hashlib.sha256(d).hexdigest(),
        'layout_class': 'supplemental_reversed_gen2' if supp else ('low_offset_ascii' if low else 'unclassified_or_blank'),
        'low_ascii_vin_records': low,
        'supplemental_gen2_vin_records': supp,
        'supplemental_sec_header_0500': hdr.hex().upper(),
        'supplemental_sec_header_matches': hdr in (b'\xAA\x55\x31\x01', b'\xFF\xFF\x00\x00'),
        'supplemental_sec_slots_redacted': sec,
        'supplemental_key_aa50_offsets': [f'0x{x:04X}' for x in aa50],
        'aa50_offsets_anywhere': [f'0x{x:04X}' for x in aa50_any],
        'pin_candidate_01e3': {'bytes_redacted_hash8': sha8(pin_bytes), 'bcd_le_plausible': pin_bcd is not None, 'digits_redacted': '****' if pin_bcd else None},
    }

def print_human(r: Dict[str,Any]) -> None:
    print(f"File: {Path(r['file']).name}")
    print(f"Size/SHA256: {r['size']} / {r['sha256']}")
    print(f"Layout class: {r['layout_class']}")
    if r['low_ascii_vin_records']:
        print('Low-offset ASCII VIN records:')
        for v in r['low_ascii_vin_records']:
            print(f"  0x{v['offset']:04X}: {v['vin']} trailer={v['trailer_be']} known_offset={v['known_offset']}")
    if r['supplemental_gen2_vin_records']:
        print('Supplemental reversed Gen2 VIN records:')
        for v in r['supplemental_gen2_vin_records']:
            print(f"  0x{v['offset']:04X}: {v['vin']} cs={v['stored_checksum']} magic={v['derived_magic']} valid87={v['valid_with_87']} validDB={v['valid_with_db']}")
    print(f"Supplemental SEC header @0x0500: {r['supplemental_sec_header_0500']} match={r['supplemental_sec_header_matches']}")
    for s in r['supplemental_sec_slots_redacted']:
        print(f"  SEC slot candidate 0x{s['slot_offset']:04X}: sha8={s['sha256_8']} crc8_65_match={s['supp_crc8_65_matches']}")
    print(f"Supplemental AA50 key markers: {', '.join(r['supplemental_key_aa50_offsets']) or 'none'}")
    print(f"Any AA50 marker anywhere: {', '.join(r['aa50_offsets_anywhere']) or 'none'}")
    pc=r['pin_candidate_01e3']
    print(f"PIN candidate @0x01E3: bcd_le_plausible={pc['bcd_le_plausible']} value={pc['digits_redacted'] or 'n/a'} hash8={pc['bytes_redacted_hash8']}")

def scan_dir(dirp: Path, csvout: Path|None) -> None:
    files=sorted([p for p in dirp.iterdir() if p.is_file() and p.stat().st_size==4096], key=lambda p:p.name.lower())
    rows=[]
    for p in files:
        r=inspect(p)
        vins=';'.join(f"0x{v['offset']:04X}:{v['vin']}:{v['trailer_be']}" for v in r['low_ascii_vin_records'])
        svins=';'.join(f"0x{v['offset']:04X}:{v['vin']}:magic{v['derived_magic']}" for v in r['supplemental_gen2_vin_records'])
        rows.append({'file':p.name,'layout_class':r['layout_class'],'sha256':r['sha256'],'low_ascii_vins':vins,'supplemental_gen2_vins':svins,'sec_header_0500':r['supplemental_sec_header_0500'],'sec_header_match':r['supplemental_sec_header_matches'],'aa50_anywhere':';'.join(r['aa50_offsets_anywhere']),'pin_01e3_bcd_plausible':r['pin_candidate_01e3']['bcd_le_plausible']})
    if csvout:
        with csvout.open('w',newline='',encoding='utf-8') as f:
            w=csv.DictWriter(f,fieldnames=list(rows[0].keys()) if rows else ['file'])
            w.writeheader(); w.writerows(rows)
    else:
        print(json.dumps(rows,indent=2))

def set_gen2_vin(filep: Path, vin: str, outp: Path, magic_s: str) -> None:
    if not re.fullmatch(r'[A-HJ-NPR-Z0-9]{17}', vin):
        raise SystemExit('VIN must be 17 characters and exclude I/O/Q.')
    d=bytearray(filep.read_bytes())
    supp=detect_supplemental_gen2(d)
    if not supp:
        raise SystemExit('Refusing to modify: supplemental reversed Gen2 VIN layout was not detected. Low-offset ASCII trailers are unresolved.')
    if magic_s == 'auto':
        # keep existing slot-specific magic when available; default DB only if no valid source.
        magic_by_off={x['offset']:int(x['derived_magic'],16) for x in supp}
    else:
        magic=int(magic_s,16)
        magic_by_off={off:magic for off in SUPP_GEN2_VIN_OFFSETS}
    raw=vin.encode('ascii')[::-1]
    for off in SUPP_GEN2_VIN_OFFSETS:
        if off in magic_by_off:
            m=magic_by_off[off]
            d[off:off+17]=raw
            d[off+17]=gen2_vin_cs(raw,m)
    outp.write_bytes(d)
    print(f'Wrote {outp}; updated supplemental reversed Gen2 VIN slots only.')

def main():
    ap=argparse.ArgumentParser(description='Safe RFHUB 24C32 EEPROM inspection utility')
    sp=ap.add_subparsers(dest='cmd',required=True)
    p=sp.add_parser('inspect'); p.add_argument('file'); p.add_argument('--json',action='store_true')
    p=sp.add_parser('scan-dir'); p.add_argument('dir'); p.add_argument('--csv')
    p=sp.add_parser('set-gen2-vin'); p.add_argument('file'); p.add_argument('vin'); p.add_argument('--out',required=True); p.add_argument('--magic',default='auto',choices=['auto','87','db','DB'])
    a=ap.parse_args()
    if a.cmd=='inspect':
        r=inspect(Path(a.file)); print(json.dumps(r,indent=2) if a.json else (print_human(r) or ''))
    elif a.cmd=='scan-dir':
        scan_dir(Path(a.dir), Path(a.csv) if a.csv else None)
    elif a.cmd=='set-gen2-vin':
        set_gen2_vin(Path(a.file), a.vin.upper(), Path(a.out), a.magic.lower())
if __name__=='__main__': main()
