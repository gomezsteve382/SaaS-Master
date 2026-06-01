#!/usr/bin/env python3
"""
autokit_checksum — firmware checksum scanner + repair bridge for SRT Lab.

Subcommands (each prints one JSON object to stdout):

    checksum  <file>                          scan for stored checksums
    fixck     <file> --offset 0x... --algorithm crc32  [--out patched.bin]
    eepmap    <file>                          VIN candidates, strings, mirrors

No external dependencies — stdlib only (binascii, struct, re).
"""

import argparse
import binascii
import json
import re
import struct
import sys


def out(o):
    json.dump(o, sys.stdout, default=str)
    sys.stdout.write("\n")


def err(m):
    out({"ok": False, "error": str(m)})
    sys.exit(0)


# ---------------------------------------------------------------------------
# CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, no-reflect, no-XorOut)
# Matches crc16ccitt in SRT Lab's crc.js
# ---------------------------------------------------------------------------
def _crc16_ccitt(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = (crc << 1) ^ 0x1021 if crc & 0x8000 else crc << 1
        crc &= 0xFFFF
    return crc


# ---------------------------------------------------------------------------
# Recompute helpers
# ---------------------------------------------------------------------------
ALGOS = {
    "crc32":  (4, lambda d, n: struct.pack("<I", binascii.crc32(d[:n]) & 0xFFFFFFFF)),
    "crc16":  (2, lambda d, n: struct.pack("<H", _crc16_ccitt(d[:n]))),
    "sum16":  (2, lambda d, n: struct.pack(
        "<H", sum(struct.unpack_from("<%dH" % ((n // 2)), d, 0)) & 0xFFFF if n >= 2 else 0
    )),
    "sum32":  (4, lambda d, n: struct.pack(
        "<I", sum(struct.unpack_from("<%dI" % ((n // 4)), d, 0)) & 0xFFFFFFFF if n >= 4 else 0
    )),
    "sum8":   (1, lambda d, n: struct.pack("B", sum(d[:n]) & 0xFF)),
    "xor32":  (4, lambda d, n: struct.pack(
        "<I",
        (lambda ws: ws[0] if not ws else __import__("functools").reduce(lambda a, b: a ^ b, ws))(
            list(struct.unpack_from("<%dI" % (n // 4), d, 0))
        ) if n >= 4 else 0
    )),
}


# ---------------------------------------------------------------------------
# checksum — scan for stored checksums that verify their own prefix
# ---------------------------------------------------------------------------
def cmd_checksum(a):
    try:
        data = open(a.file, "rb").read()
    except FileNotFoundError:
        err(f"file not found: {a.file}")
        return

    n = len(data)

    # Whole-file stats for reference
    whole = {
        "size": n,
        "crc32": hex(binascii.crc32(data) & 0xFFFFFFFF),
        "sum16": hex(sum(struct.unpack_from("<%dH" % (n // 2), data, 0)) & 0xFFFF) if n >= 2 else "0x0",
        "sum8":  hex(sum(data) & 0xFF),
    }

    verified = []
    # Sample at ~512 positions across the file for speed; always include
    # common ECU checksum landing spots (end of header blocks)
    step = max(2, n // 400)
    probes = set(range(4, n - 4, step))
    for pct in [0.25, 0.5, 0.75, 1.0]:
        probes.add(max(4, int(n * pct) & ~1))

    for pos in sorted(probes):
        for algo_name, (width, fn) in ALGOS.items():
            if pos + width > n:
                continue
            try:
                computed = fn(data, pos)
            except Exception:
                continue
            stored = data[pos : pos + width]
            if stored == computed and any(b != 0 for b in stored):
                verified.append({
                    "offset":    hex(pos),
                    "algorithm": algo_name,
                    "width":     width,
                    "stored":    stored.hex(),
                    "computed":  computed.hex(),
                    "status":    "valid",
                    "covers":    f"0x0 .. {hex(pos - 1)}",
                })

    out({
        "ok": True,
        "file": a.file,
        "whole_file": whole,
        "found": len(verified),
        "checksums": verified[:30],
        "note": (
            "Stored checksums that validate their own prefix — these are the fields to fix "
            "after editing the dump. If none found, try a different region or the checksum "
            "may cover only part of the file. Use fixck to repair."
        ),
    })


# ---------------------------------------------------------------------------
# fixck — recompute one checksum and write it back
# ---------------------------------------------------------------------------
def cmd_fixck(a):
    if a.algorithm not in ALGOS:
        err(f"unknown algorithm '{a.algorithm}'. Supported: {list(ALGOS.keys())}")
        return
    try:
        data = bytearray(open(a.file, "rb").read())
    except FileNotFoundError:
        err(f"file not found: {a.file}")
        return

    pos = a.offset
    width, fn = ALGOS[a.algorithm]
    if pos + width > len(data):
        err(f"checksum offset {hex(pos)} + {width} bytes out of range (file size {len(data)})")
        return

    old = bytes(data[pos : pos + width]).hex()
    new_bytes = fn(data, pos)
    data[pos : pos + width] = new_bytes

    out_path = a.out or a.file
    open(out_path, "wb").write(bytes(data))
    out({
        "ok": True,
        "file": a.file,
        "out": out_path,
        "offset": hex(pos),
        "algorithm": a.algorithm,
        "old": old,
        "new": new_bytes.hex(),
        "changed": old != new_bytes.hex(),
        "note": (
            f"Checksum recalculated over 0x0..{hex(pos - 1)} and written to {hex(pos)}. "
            "Re-run checksum scan to confirm it now verifies."
        ),
    })


# ---------------------------------------------------------------------------
# eepmap — VIN candidates, ASCII strings, mirrored 16-byte blocks
# ---------------------------------------------------------------------------
_VIN_RE = re.compile(rb"[A-HJ-NPR-Z0-9]{17}")

def cmd_eepmap(a):
    try:
        data = open(a.file, "rb").read()
    except FileNotFoundError:
        err(f"file not found: {a.file}")
        return

    n = len(data)

    # VIN candidates (printable 17-char WMI-legal strings)
    vin_candidates = []
    for m in _VIN_RE.finditer(data):
        vin_candidates.append({"offset": hex(m.start()), "vin": m.group().decode("latin1")})
    vin_candidates = vin_candidates[:20]

    # Readable ASCII strings (len >= 6)
    strings = []
    run_start = None
    run_buf = []
    for i, b in enumerate(data):
        if 0x20 <= b < 0x7F:
            if run_start is None:
                run_start = i
            run_buf.append(chr(b))
        else:
            if run_start is not None and len(run_buf) >= 6:
                s = "".join(run_buf)
                strings.append({"offset": hex(run_start), "length": len(s), "text": s[:80]})
            run_start = None
            run_buf = []
    strings.sort(key=lambda x: -x["length"])
    strings = strings[:40]

    # Mirrored 16-byte blocks (identical copies at different offsets — BCM SEC16 redundancy)
    mirrors = []
    block_map = {}
    for i in range(0, n - 16, 4):
        blk = data[i : i + 16]
        if all(b == 0xFF for b in blk) or all(b == 0 for b in blk):
            continue
        key_h = blk.hex()
        if key_h in block_map:
            first = block_map[key_h]
            mirrors.append({
                "first_offset": hex(first),
                "mirror_offset": hex(i),
                "gap": hex(i - first),
                "hex": key_h,
            })
            if len(mirrors) >= 30:
                break
        else:
            block_map[key_h] = i

    out({
        "ok": True,
        "file": a.file,
        "size": n,
        "vin_candidates": vin_candidates,
        "strings": strings,
        "mirrored_blocks": mirrors,
        "note": (
            "VIN candidates: 17-char WMI-legal runs. "
            "Mirrored blocks: identical 16-byte regions at different offsets — "
            "these are typically redundant SEC16 / odometer / config copies. "
            "Verify offsets before interpreting as security bytes."
        ),
    })


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def main():
    p = argparse.ArgumentParser(prog="autokit_checksum",
                                description="SRT Lab firmware checksum bridge")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("checksum", help="scan file for stored checksums")
    sp.add_argument("file")

    sp = sub.add_parser("fixck", help="recompute and write back one checksum")
    sp.add_argument("file")
    sp.add_argument("--offset", type=lambda x: int(x, 0), required=True,
                    help="byte offset of the stored checksum (from checksum scan)")
    sp.add_argument("--algorithm", required=True,
                    help=f"algorithm name: {list(ALGOS.keys())}")
    sp.add_argument("--out", default=None,
                    help="output path (defaults to overwriting input)")

    sp = sub.add_parser("eepmap", help="extract VIN candidates, strings, mirrors")
    sp.add_argument("file")

    a = p.parse_args()
    try:
        {"checksum": cmd_checksum, "fixck": cmd_fixck, "eepmap": cmd_eepmap}[a.cmd](a)
    except FileNotFoundError:
        err(f"file not found: {getattr(a, 'file', '?')}")
    except Exception as e:
        err(f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        sys.exit(0)
