#!/usr/bin/env python3
"""Decrypt strings for every method that has UDS frames, using each method's
own salt (found via stloc at method entry).

Then cross-reference each UDS frame with the nearest decrypted strings to
build the final dispatch table.
"""
import dnfile
import struct
import json
from collections import defaultdict

EXE = "/tmp/exe/AlfaOBD.exe"
FRAMES_IN = "/tmp/exe/uds_frames_v3.json"
OUT = "/tmp/exe/full_dispatch_table.json"

DOTFUSCATOR_BASE_KEY = 0x6DDC67B5

LDC_I4_M1 = 0x15
LDC_I4_0 = 0x16
LDC_I4_8 = 0x1E
LDC_I4_S = 0x1F
LDC_I4 = 0x20
STLOC_0 = 0x0A
STLOC_3 = 0x0D
STLOC_S = 0x13


def parse_method_il(pe, body_rva):
    off = pe.get_offset_from_rva(body_rva)
    raw = pe.__data__
    b0 = raw[off]
    if (b0 & 0x03) == 0x02:
        code_size = b0 >> 2
        return bytes(raw[off + 1: off + 1 + code_size]), 1
    code_size = struct.unpack_from("<I", raw, off + 4)[0]
    # Parse local var count from local sig token in fat header
    flags_and_size = struct.unpack_from("<H", raw, off)[0]
    max_stack = struct.unpack_from("<H", raw, off + 2)[0]
    return bytes(raw[off + 12: off + 12 + code_size]), 12


def read_cuint(data, off):
    if off >= len(data): return None
    b0 = data[off]
    if (b0 & 0x80) == 0: return b0, 1
    if (b0 & 0xC0) == 0x80 and off + 1 < len(data):
        return ((b0 & 0x3F) << 8) | data[off + 1], 2
    if (b0 & 0xE0) == 0xC0 and off + 3 < len(data):
        return ((b0 & 0x1F) << 24) | (data[off+1] << 16) | (data[off+2] << 8) | data[off+3], 4
    return None


def decrypt_one(raw, salt):
    key = (DOTFUSCATOR_BASE_KEY + salt) & 0xFFFFFFFF
    out = bytearray(len(raw))
    for i, b in enumerate(raw):
        out[i] = b ^ (key & 0xFF)
        key = (key + 1) & 0xFFFFFFFF
    swapped = bytearray(len(out))
    for i in range(0, len(out) - 1, 2):
        swapped[i] = out[i + 1]
        swapped[i + 1] = out[i]
    if len(out) % 2:
        swapped[-1] = out[-1]
    try:
        return swapped.decode("utf-16-le", errors="replace").rstrip("\x00")
    except Exception:
        return None


def score(s):
    if not s: return 0
    p = sum(1 for c in s if 0x20 <= ord(c) < 0x7F or c in "\n\t\r")
    return p / len(s)


def find_salt(code):
    """Find the salt by looking for the first 'ldc.i4 N; stloc.<L>' or 'ldc.i4 N; FE 0E <local16>' near the start.
    For SendActiveDiagnostic3, salt = 13 is loaded as `ldc.i4 13; stloc 257`.

    Strategy:
      1. Search for the FIRST occurrence of any ldc.i4 N followed by stloc to a local
         that's later read via FE 0C (ldloc.long).
      2. Identify the local that's used as salt for h() calls.
    """
    n = len(code)
    # First, find what local is used in ldstr; ldloc; call h pattern
    H_TOKEN_LE = bytes([0x28, 0x1A, 0x00, 0x00, 0x06])  # call Method[26]:h
    salt_local = None
    for i in range(n - 5):
        if bytes(code[i:i+5]) == H_TOKEN_LE:
            # Look back at the ldloc — typically i-4..i is the local load
            if i >= 4:
                if code[i - 4] == 0xFE and code[i - 3] == 0x0C:
                    # ldloc.long <uint16>
                    local_idx = struct.unpack_from("<H", code, i - 2)[0]
                    salt_local = ("ldloc_long", local_idx)
                    break
                elif code[i - 2] == 0x11:  # ldloc.s
                    local_idx = code[i - 1]
                    salt_local = ("ldloc_s", local_idx)
                    break
                elif 0x06 <= code[i - 1] <= 0x09:  # ldloc.0..3
                    salt_local = ("ldloc_small", code[i - 1] - 0x06)
                    break

    if salt_local is None:
        return None

    kind, idx = salt_local
    # Now find where this local is initialized
    if kind == "ldloc_long":
        # Search for `FE 0E <uint16>` matching local idx
        target = b"\xFE\x0E" + struct.pack("<H", idx)
        for i in range(n - 4):
            if bytes(code[i:i+4]) == target:
                # Look at the constant before
                # ldc.i4 N is 5 bytes (0x20 + 4)
                if i >= 5 and code[i - 5] == LDC_I4:
                    salt = struct.unpack_from("<i", code, i - 4)[0]
                    return salt
                # ldc.i4.s
                if i >= 2 and code[i - 2] == LDC_I4_S:
                    return struct.unpack_from("<b", code, i - 1)[0]
                # ldc.i4.<0..8>
                if i >= 1 and LDC_I4_0 <= code[i - 1] <= LDC_I4_8:
                    return code[i - 1] - LDC_I4_0
                # ldc.i4.m1
                if i >= 1 and code[i - 1] == LDC_I4_M1:
                    return -1
    elif kind == "ldloc_small":
        # Look for stloc.<idx> (0x0A..0x0D)
        target_byte = 0x0A + idx
        for i in range(n - 1):
            if code[i] == target_byte:
                # Look back for constant
                if i >= 5 and code[i - 5] == LDC_I4:
                    return struct.unpack_from("<i", code, i - 4)[0]
                if i >= 2 and code[i - 2] == LDC_I4_S:
                    return struct.unpack_from("<b", code, i - 1)[0]
                if i >= 1 and LDC_I4_0 <= code[i - 1] <= LDC_I4_8:
                    return code[i - 1] - LDC_I4_0
    elif kind == "ldloc_s":
        target = b"\x13" + bytes([idx])
        for i in range(n - 1):
            if bytes(code[i:i+2]) == target:
                if i >= 5 and code[i - 5] == LDC_I4:
                    return struct.unpack_from("<i", code, i - 4)[0]
                if i >= 2 and code[i - 2] == LDC_I4_S:
                    return struct.unpack_from("<b", code, i - 1)[0]
                if i >= 1 and LDC_I4_0 <= code[i - 1] <= LDC_I4_8:
                    return code[i - 1] - LDC_I4_0

    return None


def decrypt_method_strings(pe, code, us_data, salt):
    """Find every ldstr in IL, decrypt with the given salt, return {us_offset: text}."""
    n = len(code)
    unique_offsets = set()
    ldstr_sites = []
    ip = 0
    while ip < n:
        if code[ip] == 0x72 and ip + 4 < n:
            tok = struct.unpack_from("<I", code, ip + 1)[0]
            us_off = tok & 0x00FFFFFF
            unique_offsets.add(us_off)
            ldstr_sites.append((ip, us_off))
            ip += 5
            continue
        ip += 1

    decrypted = {}
    for us_off in unique_offsets:
        if us_off >= len(us_data):
            continue
        li = read_cuint(us_data, us_off)
        if li is None: continue
        blob_len, lb = li
        if blob_len == 0 or blob_len > 10000: continue
        raw_data_bytes = us_data[us_off + lb: us_off + lb + blob_len - 1]
        if not raw_data_bytes: continue
        text = decrypt_one(raw_data_bytes, salt)
        if text is None: continue
        if score(text) >= 0.7:
            decrypted[us_off] = text

    return ldstr_sites, decrypted


def main():
    pe = dnfile.dnPE(EXE)
    md = pe.net.mdtables
    us_data = bytes(pe.net.user_strings.__data__)

    frames_data = json.load(open(FRAMES_IN))

    # Process every method that has UDS frames
    all_method_data = {}
    print(f"Processing {len(frames_data)} methods with UDS frames…")
    for method_idx_str, info in frames_data.items():
        method_idx = int(method_idx_str)
        m = md.MethodDef.rows[method_idx - 1]
        if m.Rva == 0: continue
        try:
            code, hdr_size = parse_method_il(pe, m.Rva)
        except Exception as e:
            print(f"  Method[{method_idx}] parse failed: {e}")
            continue
        salt = find_salt(code)
        if salt is None:
            print(f"  Method[{method_idx}] {info['name']!r} — no salt found (maybe no h() calls)")
            continue
        ldstr_sites, decrypted = decrypt_method_strings(pe, code, us_data, salt)
        all_method_data[method_idx_str] = {
            "name": info["name"],
            "il_size": len(code),
            "salt": salt,
            "ldstr_site_count": len(ldstr_sites),
            "decrypted_count": len(decrypted),
            "ldstr_sites": ldstr_sites,
            "decrypted": decrypted,
            "frames": info["frames"],
        }
        print(f"  Method[{method_idx:5d}] {info['name']:<35} salt={salt:3d} sites={len(ldstr_sites):4d} decrypted={len(decrypted):4d} frames={len(info['frames']):4d}")

    # Now build the final dispatch table — for each frame, find nearby strings
    print()
    final_dispatch = []
    for method_idx_str, data in all_method_data.items():
        for f in data["frames"]:
            if any(b is None for b in f["bytes_hex"]): continue
            if f["sid"] not in (0x31, 0x27, 0x22, 0x2E, 0x10, 0x11): continue
            frame_ip = f["start_ip"]
            nearby = [(ip, off, data["decrypted"].get(off))
                      for ip, off in data["ldstr_sites"]
                      if ip < frame_ip and frame_ip - ip <= 384]
            nearby = [(ip, off, t) for ip, off, t in nearby if t]
            nearby.sort(key=lambda x: -x[0])
            final_dispatch.append({
                "method": data["name"],
                "method_idx": method_idx_str,
                "method_salt": data["salt"],
                "frame_ip": frame_ip,
                "frame_hex": " ".join(b[2:] for b in f["bytes_hex"]),
                "sid": f["sid"],
                "sid_name": f["sid_name"],
                "context": [{"distance": frame_ip - ip, "us_off": f"0x{off:X}", "text": t}
                            for ip, off, t in nearby[:5]],
            })

    print(f"\nFinal dispatch records: {len(final_dispatch):,}")
    rich = [r for r in final_dispatch if len(r["context"]) >= 2]
    print(f"With >=2 context strings: {len(rich):,}")

    # Distribution
    by_method = defaultdict(int)
    for r in final_dispatch:
        by_method[r["method"]] += 1
    print(f"\nBy source method:")
    for mn, c in sorted(by_method.items(), key=lambda x: -x[1]):
        print(f"  {mn:<35} {c:5d} records")

    # Save
    json.dump({
        "meta": {
            "source": "AlfaOBD.exe IL extraction",
            "method_count_processed": len(all_method_data),
            "total_dispatch_records": len(final_dispatch),
            "rich_dispatch_records": len(rich),
        },
        "methods": {mi: {"name": d["name"], "il_size": d["il_size"], "salt": d["salt"],
                         "ldstr_site_count": d["ldstr_site_count"],
                         "decrypted_count": d["decrypted_count"],
                         "decrypted": {f"0x{k:X}": v for k, v in d["decrypted"].items()}}
                    for mi, d in all_method_data.items()},
        "dispatch": final_dispatch,
    }, open(OUT, "w"), indent=1)
    print(f"\nWrote {OUT}")


if __name__ == "__main__":
    main()
