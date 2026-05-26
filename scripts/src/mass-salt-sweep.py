#!/usr/bin/env python3
"""Mass salt-sweep: recover the salt for every method that calls h() and decrypt
every ldstr it references. Produces a complete cross-binary string vocabulary."""
import dnfile
import struct
import json
from collections import defaultdict

EXE = "/tmp/exe/AlfaOBD.exe"
OUT = "/tmp/exe/full_binary_strings.json"

DOTFUSCATOR_BASE_KEY = 0x6DDC67B5

LDC_I4_M1 = 0x15
LDC_I4_0 = 0x16
LDC_I4_8 = 0x1E
LDC_I4_S = 0x1F
LDC_I4 = 0x20
LDSTR = 0x72


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
    elif kind == "short":
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


def main():
    pe = dnfile.dnPE(EXE)
    md = pe.net.mdtables
    us_data = bytes(pe.net.user_strings.__data__)

    # Cache decryption results keyed by (us_offset, salt) to avoid redoing
    decrypt_cache = {}

    def get_decrypted(us_off, salt):
        key = (us_off, salt)
        if key in decrypt_cache:
            return decrypt_cache[key]
        result = None
        if us_off < len(us_data):
            li = read_cuint(us_data, us_off)
            if li:
                bl, lb = li
                if 0 < bl < 10000:
                    rb = us_data[us_off + lb: us_off + lb + bl - 1]
                    if rb:
                        t = decrypt(rb, salt)
                        if t:
                            p = sum(1 for c in t if 0x20 <= ord(c) < 0x7F or c in "\n\r\t") / max(len(t), 1)
                            if p >= 0.7:
                                result = t.rstrip()
        decrypt_cache[key] = result
        return result

    print(f"Mass sweep of {len(md.MethodDef.rows):,} methods…", flush=True)
    all_method_data = {}
    total_strings = 0
    for i, m in enumerate(md.MethodDef.rows):
        if m.Rva == 0: continue
        try:
            code = parse_method_il(pe, m.Rva)
        except Exception:
            continue
        if len(code) < 8: continue
        salt = find_method_salt(code)
        if salt is None: continue
        # Find every ldstr and decrypt with this salt
        n = len(code)
        ip = 0
        method_strs = {}
        while ip < n - 4:
            if code[ip] == LDSTR and ip + 4 < n:
                tok = struct.unpack_from("<I", code, ip + 1)[0]
                us_off = tok & 0x00FFFFFF
                t = get_decrypted(us_off, salt)
                if t is not None and us_off not in method_strs:
                    method_strs[us_off] = t
                ip += 5
                continue
            ip += 1
        if method_strs:
            method_name = str(m.Name) if hasattr(m, "Name") else "?"
            all_method_data[i + 1] = {
                "name": method_name,
                "salt": salt,
                "il_size": len(code),
                "string_count": len(method_strs),
                "strings": {f"0x{k:X}": v for k, v in method_strs.items()},
            }
            total_strings += len(method_strs)

    print(f"\nMethods with decoded strings: {len(all_method_data):,}")
    print(f"Total decoded strings: {total_strings:,}")

    # Build a global "all unique strings" set
    all_unique = set()
    for info in all_method_data.values():
        for s in info["strings"].values():
            all_unique.add(s)
    print(f"Unique strings across binary: {len(all_unique):,}")

    # Cache stats
    print(f"Decrypt cache size: {len(decrypt_cache):,}")
    successful_cache = sum(1 for v in decrypt_cache.values() if v is not None)
    print(f"  Successful: {successful_cache:,}")

    # Salt distribution
    from collections import Counter
    salt_counts = Counter(info["salt"] for info in all_method_data.values())
    print(f"\nSalt distribution (top 20):")
    for salt, cnt in salt_counts.most_common(20):
        print(f"  salt={salt:4d}: {cnt} methods")

    # Save full result
    json.dump({
        "meta": {
            "methods_with_strings": len(all_method_data),
            "total_string_instances": total_strings,
            "unique_strings": len(all_unique),
            "salt_distribution": dict(salt_counts),
        },
        "methods": all_method_data,
    }, open(OUT, "w"), indent=1)
    print(f"\nWrote {OUT}")


if __name__ == "__main__":
    main()
