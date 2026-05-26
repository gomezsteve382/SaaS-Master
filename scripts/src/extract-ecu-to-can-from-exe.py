#!/usr/bin/env python3
"""Cleaner ECU→CAN extraction: tighter window, look for specific patterns
where a string is the dictionary key and a CAN ID is the value.

The classic dictionary-add pattern in .NET IL is:
   ldloc <dict>
   ldstr <ecu_name>
   ldc.i4 <can_id>
   callvirt Dictionary::Add(string, int)

So we look for the SEQUENCE: ldstr <encrypted>, salt-load, call h(), then
ldc.i4 <can_id>, then callvirt — within a tight window.
"""
import dnfile
import struct
import json
from collections import defaultdict

EXE = "/tmp/exe/AlfaOBD.exe"
OUT = "/tmp/exe/ecu_to_can_clean.json"
DOTFUSCATOR_BASE_KEY = 0x6DDC67B5

INTERESTING_CAN_IDS = {
    0x149, 0x14E, 0x500, 0x504, 0x514, 0x600, 0x620, 0x6A0,
    0x744, 0x74C, 0x74F, 0x750, 0x75F, 0x760, 0x768, 0x76C, 0x76F,
    0x7C0, 0x7DA, 0x7DB, 0x7E0, 0x7E2, 0x7E8, 0x7EA,
}

LDC_I4 = 0x20
LDC_I4_S = 0x1F
LDSTR = 0x72
CALL = 0x28
CALLVIRT = 0x6F
LDC_I4_0 = 0x16
LDC_I4_8 = 0x1E
LDC_I4_M1 = 0x15

# Specific routine ECU families we want to map (from Tier-1 + routine catalog)
TIER1_ECU_FAMILIES = {
    "MARELLI6F3_CAN", "TBM2", "CCN", "BCM_CHRYSLER",
    "MARELLI_DASH", "MARELLI8GV", "BOSCH_GPEC2", "BOSCH_GPEC2A",
    "ZF8HP", "ZF9HP", "AISIN", "HEMI6F", "PENTASTAR6F", "AVANTI",
    "ABS_CHRYSLER", "ABS_CONTINENTAL", "ABS_TEVES", "ABS_TRW",
    "AIRBAG_AUTOLIV", "RFHUB", "BCM",
}


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
        out[i] = b ^ (key & 0xFF); key = (key + 1) & 0xFFFFFFFF
    swapped = bytearray(len(out))
    for i in range(0, len(out) - 1, 2):
        swapped[i] = out[i + 1]; swapped[i + 1] = out[i]
    if len(out) % 2: swapped[-1] = out[-1]
    try:
        return swapped.decode("utf-16-le", errors="replace").rstrip("\x00")
    except Exception:
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
    if salt_local_byte is None: return None
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


def decrypt_us(us_data, us_off, salt):
    if us_off >= len(us_data): return None
    li = read_cuint(us_data, us_off)
    if li is None: return None
    bl, lb = li
    if bl == 0 or bl > 10000: return None
    rb = us_data[us_off + lb: us_off + lb + bl - 1]
    if not rb: return None
    t = decrypt(rb, salt)
    if t and sum(1 for c in t if 0x20 <= ord(c) < 0x7F) / max(len(t), 1) >= 0.7:
        return t.rstrip()
    return None


def scan_method_for_pairings(code, us_data, salt):
    """Walk IL looking for the canonical dictionary-add pattern:
         ldstr <encrypted>  ; salt-load ; call h  ; ldc.i4 <can_id>  ; callvirt
    or:
         ldstr <encrypted>  ; salt-load ; call h  ; ldc.i4 <can_id>  ; <conv> ; call
    Returns list of (ecu_name, can_id, ip).
    """
    pairings = []
    n = len(code)
    ip = 0
    while ip < n - 25:
        # Match ldstr (5 bytes)
        if code[ip] != LDSTR:
            ip += 1
            continue
        tok = struct.unpack_from("<I", code, ip + 1)[0]
        us_off = tok & 0x00FFFFFF
        ip2 = ip + 5
        # Match salt-load (1-4 bytes)
        ip_after_salt = None
        if ip2 < n and 0x06 <= code[ip2] <= 0x09:
            ip_after_salt = ip2 + 1
        elif ip2 + 1 < n and code[ip2] == 0x11:
            ip_after_salt = ip2 + 2
        elif ip2 + 3 < n and code[ip2] == 0xFE and code[ip2 + 1] == 0x0C:
            ip_after_salt = ip2 + 4
        if ip_after_salt is None:
            ip += 1
            continue
        # Match call h
        if ip_after_salt + 4 >= n or code[ip_after_salt] != CALL:
            ip += 1
            continue
        tok_h = struct.unpack_from("<I", code, ip_after_salt + 1)[0]
        if tok_h != 0x0600001A:
            ip += 1
            continue
        # We have a decryption call. Now look for ldc.i4 <can_id> within next 16 bytes
        ip3 = ip_after_salt + 5
        for offset in range(16):
            if ip3 + offset + 5 > n: break
            cip = ip3 + offset
            if code[cip] == LDC_I4 and cip + 4 < n:
                v = struct.unpack_from("<i", code, cip + 1)[0]
                if v in INTERESTING_CAN_IDS:
                    # Found! Get the decrypted ECU name
                    ecu_name = decrypt_us(us_data, us_off, salt)
                    if ecu_name and 2 <= len(ecu_name) <= 60:
                        pairings.append((ecu_name, v, ip))
                    break
            if code[cip] == LDC_I4_S and cip + 1 < n:
                v = struct.unpack_from("<b", code, cip + 1)[0]
                # ldc.i4.s can't reach > 127 so won't match CAN IDs >= 0x149
                break
        ip += 1
    return pairings


def main():
    pe = dnfile.dnPE(EXE)
    md = pe.net.mdtables
    us_data = bytes(pe.net.user_strings.__data__)

    print(f"Scanning {len(md.MethodDef.rows):,} methods for ECU-name → CAN-ID pattern…", flush=True)
    all_pairings = defaultdict(set)
    scanned = 0
    for i, m in enumerate(md.MethodDef.rows):
        if m.Rva == 0: continue
        try:
            code = parse_method_il(pe, m.Rva)
        except Exception:
            continue
        if len(code) < 20: continue
        salt = find_method_salt(code)
        if salt is None: continue
        scanned += 1
        pairings = scan_method_for_pairings(code, us_data, salt)
        for name, can_id, ip_ in pairings:
            all_pairings[name].add(can_id)

    print(f"Methods scanned: {scanned}")
    print(f"Unique ECU-name → CAN-ID(s): {len(all_pairings)}")

    # Filter to "looks like an ECU name" entries: all-caps with letters/digits/underscore,
    # short (<= 30 chars), or vehicle-platform abbreviations
    def is_ecu_name(s):
        if not s or len(s) < 2 or len(s) > 30:
            return False
        # Exclude UI strings
        if " " in s and not (s.startswith("(") or s.endswith(")")):
            # Allow strings like "(WD) DURANGO" or "X2 platform"
            if s.count(" ") > 3:
                return False
        # Allow strings starting with paren or containing _PN/_CAN/uppercase
        return (s.isupper() or "_" in s or s[0] in "(0123456789"
                or any(c.isupper() for c in s) and len(s) < 25)

    clean_pairings = {k: sorted(v) for k, v in all_pairings.items() if is_ecu_name(k)}
    print(f"After filtering to ECU-name-shape: {len(clean_pairings)}")
    print()
    # Sort by ECU name
    print("All clean ECU→CAN pairings:")
    for k in sorted(clean_pairings.keys()):
        cans = clean_pairings[k]
        cans_str = " ".join(f"0x{c:03X}" for c in cans)
        in_tier1 = "★" if k in TIER1_ECU_FAMILIES else " "
        print(f"  {in_tier1} {k:<40s} → {cans_str}")

    json.dump({
        "meta": {
            "methods_scanned": scanned,
            "unique_pairings": len(clean_pairings),
        },
        "ecu_to_can": clean_pairings,
    }, open(OUT, "w"), indent=1)
    print(f"\nWrote {OUT}")


if __name__ == "__main__":
    main()
