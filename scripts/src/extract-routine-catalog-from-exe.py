#!/usr/bin/env python3
"""Scan EVERY method for the routine_id catalog pattern. Find which method(s)
hold the catalog for routines 1126, 1520, 1750, 1751, 2504-2508, 1367."""
import dnfile
import struct
import json
from collections import defaultdict

EXE = "/tmp/exe/AlfaOBD.exe"
OUT = "/tmp/exe/all_method_routine_catalog.json"

DOTFUSCATOR_BASE_KEY = 0x6DDC67B5
TIER1 = {1126, 1520, 1750, 1751, 2504, 2505, 2507, 2508, 1367}

LDC_I4_M1 = 0x15
LDC_I4_0 = 0x16
LDC_I4_8 = 0x1E
LDC_I4_S = 0x1F
LDC_I4 = 0x20
LDSTR = 0x72
CALL = 0x28


def parse_method_il(pe, body_rva):
    off = pe.get_offset_from_rva(body_rva)
    raw = pe.__data__
    b0 = raw[off]
    if (b0 & 0x03) == 0x02:
        return bytes(raw[off + 1: off + 1 + (b0 >> 2)])
    return bytes(raw[off + 12: off + 12 + struct.unpack_from("<I", raw, off + 4)[0]])


def read_cuint(data, off):
    if off >= len(data): return None
    b0 = data[off]
    if (b0 & 0x80) == 0: return b0, 1
    if (b0 & 0xC0) == 0x80 and off + 1 < len(data):
        return ((b0 & 0x3F) << 8) | data[off + 1], 2
    if (b0 & 0xE0) == 0xC0 and off + 3 < len(data):
        return ((b0 & 0x1F) << 24) | (data[off+1] << 16) | (data[off+2] << 8) | data[off+3], 4
    return None


def decrypt(raw, salt):
    key = (DOTFUSCATOR_BASE_KEY + salt) & 0xFFFFFFFF
    out = bytearray(len(raw))
    for i, b in enumerate(raw):
        out[i] = b ^ (key & 0xFF)
        key = (key + 1) & 0xFFFFFFFF
    swapped = bytearray(len(out))
    for i in range(0, len(out) - 1, 2):
        swapped[i] = out[i + 1]; swapped[i + 1] = out[i]
    if len(out) % 2: swapped[-1] = out[-1]
    try:
        return swapped.decode("utf-16-le", errors="replace").rstrip("\x00")
    except Exception:
        return None


def decode_ldc_i4(code, ip):
    if ip >= len(code): return None
    op = code[ip]
    if op == LDC_I4_M1: return -1, ip + 1
    if LDC_I4_0 <= op <= LDC_I4_8: return op - LDC_I4_0, ip + 1
    if op == LDC_I4_S and ip + 1 < len(code):
        return struct.unpack_from("<b", code, ip + 1)[0], ip + 2
    if op == LDC_I4 and ip + 4 < len(code):
        return struct.unpack_from("<i", code, ip + 1)[0], ip + 5
    return None


def find_method_salt(code):
    H_TOKEN = bytes([0x28, 0x1A, 0x00, 0x00, 0x06])
    n = len(code)
    salt_local_byte = None
    for i in range(n - 5):
        if bytes(code[i:i+5]) == H_TOKEN:
            if i >= 4 and code[i - 4] == 0xFE and code[i - 3] == 0x0C:
                salt_local_byte = ("long", struct.unpack_from("<H", code, i - 2)[0]); break
            elif i >= 2 and code[i - 2] == 0x11:
                salt_local_byte = ("short", code[i - 1]); break
            elif i >= 1 and 0x06 <= code[i - 1] <= 0x09:
                salt_local_byte = ("tiny", code[i - 1] - 0x06); break
    if salt_local_byte is None:
        return None
    kind, idx = salt_local_byte
    if kind == "long":
        target = b"\xFE\x0E" + struct.pack("<H", idx)
        for i in range(n - 4):
            if bytes(code[i:i+4]) == target:
                if i >= 5 and code[i - 5] == LDC_I4:
                    return struct.unpack_from("<i", code, i - 4)[0]
                if i >= 2 and code[i - 2] == LDC_I4_S:
                    return struct.unpack_from("<b", code, i - 1)[0]
                if i >= 1 and LDC_I4_0 <= code[i - 1] <= LDC_I4_8:
                    return code[i - 1] - LDC_I4_0
    elif kind == "tiny":
        target = 0x0A + idx
        for i in range(n):
            if code[i] == target:
                if i >= 5 and code[i - 5] == LDC_I4:
                    return struct.unpack_from("<i", code, i - 4)[0]
                if i >= 2 and code[i - 2] == LDC_I4_S:
                    return struct.unpack_from("<b", code, i - 1)[0]
                if i >= 1 and LDC_I4_0 <= code[i - 1] <= LDC_I4_8:
                    return code[i - 1] - LDC_I4_0
    return None


def find_tier1_in_method(code):
    """Just search for ldc.i4 N where N in TIER1, return list of (ip, rid)."""
    hits = []
    n = len(code)
    ip = 0
    while ip < n - 4:
        if code[ip] == LDC_I4 and ip + 4 < n:
            v = struct.unpack_from("<i", code, ip + 1)[0]
            if v in TIER1:
                hits.append((ip, v))
            ip += 5
            continue
        ip += 1
    return hits


def scan_for_routine_id_table(code, us_data, salt):
    """Generic catalog scan with flexible pattern. The pattern we expect:
       ldc.i4 <routine_id> ; ldc.i4 <field_idx> ; ldstr <tok> ; <salt-load> ; call h
       But also allow intervening dup/ldarg/ldfld between routine_id and field_idx."""
    n = len(code)
    catalog = defaultdict(dict)
    text_cache = {}

    def gt(us_off):
        if us_off in text_cache: return text_cache[us_off]
        if us_off >= len(us_data): return None
        li = read_cuint(us_data, us_off)
        if li is None: return None
        bl, lb = li
        if bl == 0 or bl > 10000: return None
        rb = us_data[us_off + lb: us_off + lb + bl - 1]
        t = decrypt(rb, salt) if rb else None
        text_cache[us_off] = t
        return t

    ip = 0
    while ip < n - 16:
        # Outer: try to find an ldc.i4 N (1..4000) candidate routine_id
        if code[ip] != LDC_I4:
            ip += 1
            continue
        rid = struct.unpack_from("<i", code, ip + 1)[0]
        if not (1 <= rid <= 4000):
            ip += 5
            continue
        # Try the strict pattern: routine_id + field_idx + ldstr + salt + call
        # within the next ~30 bytes
        for inner_offset in range(5, 30):
            ip2 = ip + inner_offset
            if ip2 >= n - 12: break
            # Look for ldstr at ip2
            if code[ip2] != LDSTR: continue
            tok = struct.unpack_from("<I", code, ip2 + 1)[0]
            us_off = tok & 0x00FFFFFF
            # The field_idx is between rid and ldstr — try to decode it
            # Look for ldc.i4 in (ip+5..ip2)
            field_idx = None
            for inner_ip in range(ip + 5, ip2):
                dec = decode_ldc_i4(code, inner_ip)
                if dec is not None:
                    val, _ = dec
                    if 0 <= val <= 30:
                        field_idx = val
                        break
            if field_idx is None: continue
            # Then after ldstr we expect salt-load + call h
            ip_after_ldstr = ip2 + 5
            ip_after_salt = None
            if ip_after_ldstr < n and 0x06 <= code[ip_after_ldstr] <= 0x09:
                ip_after_salt = ip_after_ldstr + 1
            elif ip_after_ldstr + 1 < n and code[ip_after_ldstr] == 0x11:
                ip_after_salt = ip_after_ldstr + 2
            elif ip_after_ldstr + 3 < n and code[ip_after_ldstr] == 0xFE and code[ip_after_ldstr + 1] == 0x0C:
                ip_after_salt = ip_after_ldstr + 4
            elif ip_after_ldstr < n and (LDC_I4_0 <= code[ip_after_ldstr] <= LDC_I4_8 or code[ip_after_ldstr] in (LDC_I4_M1, LDC_I4_S, LDC_I4)):
                d = decode_ldc_i4(code, ip_after_ldstr)
                if d: ip_after_salt = d[1]
            if ip_after_salt is None: continue
            if ip_after_salt + 4 >= n or code[ip_after_salt] != CALL: continue
            # Match
            text = gt(us_off)
            if text is not None:
                if field_idx not in catalog[rid]:
                    catalog[rid][field_idx] = text
            break
        ip += 5

    return catalog


def main():
    pe = dnfile.dnPE(EXE)
    md = pe.net.mdtables
    us_data = bytes(pe.net.user_strings.__data__)

    # First, find which methods contain ANY of the Tier-1 routine_ids as ldc.i4 constants
    print(f"Scanning {len(md.MethodDef.rows):,} methods for any Tier-1 routine_id literal…", flush=True)
    methods_with_tier1 = []
    for i, m in enumerate(md.MethodDef.rows):
        if m.Rva == 0: continue
        try:
            code = parse_method_il(pe, m.Rva)
        except Exception:
            continue
        hits = find_tier1_in_method(code)
        if hits:
            methods_with_tier1.append((i + 1, str(m.Name), len(code), hits))

    print(f"Methods containing Tier-1 routine_id literals: {len(methods_with_tier1)}")
    for mi, mn, sz, hits in sorted(methods_with_tier1, key=lambda x: -len(x[3]))[:20]:
        rids = sorted(set(rid for _, rid in hits))
        print(f"  Method[{mi:5d}] {mn:<35s}  IL={sz:>8,}B  TIER1 found: {rids}  (total occurrences: {len(hits)})")

    # For the top method(s) with Tier-1 IDs, scan the full catalog
    print(f"\nExtracting catalog from top methods…")
    full_catalog = defaultdict(dict)  # rid -> {field_idx: text}

    for mi, mn, sz, hits in sorted(methods_with_tier1, key=lambda x: -len(x[3]))[:5]:
        m = md.MethodDef.rows[mi - 1]
        code = parse_method_il(pe, m.Rva)
        salt = find_method_salt(code)
        if salt is None:
            print(f"  Method[{mi}] {mn!r}: no salt — skipping")
            continue
        print(f"  Method[{mi}] {mn!r} salt={salt} — scanning…")
        cat = scan_for_routine_id_table(code, us_data, salt)
        print(f"    found {len(cat)} routines with fields")
        # Verify Tier-1
        for rid in TIER1:
            if rid in cat:
                fields = cat[rid]
                print(f"    ✓ rid={rid}: {len(fields)} fields  sample: idx[1]={fields.get(1, '?')!r}")
        # Merge into full catalog
        for rid, fields in cat.items():
            for fidx, text in fields.items():
                if fidx not in full_catalog[rid]:
                    full_catalog[rid][fidx] = text

    print(f"\nFull catalog: {len(full_catalog):,} routines")
    # Tier-1 verification
    for rid in sorted(TIER1):
        if rid in full_catalog:
            f = full_catalog[rid]
            print(f"\nRoutine {rid} ({len(f)} fields):")
            for fidx in sorted(f.keys()):
                t = f[fidx]
                print(f"  idx[{fidx:2d}]: {t[:80]!r}")
        else:
            print(f"\nRoutine {rid}: NOT FOUND")

    # Save
    save = {
        "total_routines": len(full_catalog),
        "routines": {str(rid): {str(idx): text for idx, text in fields.items()}
                     for rid, fields in full_catalog.items()},
    }
    json.dump(save, open(OUT, "w"), indent=1)
    print(f"\nWrote {OUT}")


if __name__ == "__main__":
    main()
