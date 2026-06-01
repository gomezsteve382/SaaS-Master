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
#
# Every algorithm computes its checksum over the half-open byte range
# data[start:end].  Prefix checksums pass start=0; partial-range / per-block
# checksums (see _block_scan) pass the block's start offset.
# ---------------------------------------------------------------------------
def _sum16(d, s, e):
    cnt = (e - s) // 2
    return sum(struct.unpack_from("<%dH" % cnt, d, s)) & 0xFFFF if cnt else 0


def _sum32(d, s, e):
    cnt = (e - s) // 4
    return sum(struct.unpack_from("<%dI" % cnt, d, s)) & 0xFFFFFFFF if cnt else 0


def _xor32(d, s, e):
    cnt = (e - s) // 4
    if not cnt:
        return b"\x00\x00\x00\x00"
    acc = 0
    for w in struct.unpack_from("<%dI" % cnt, d, s):
        acc ^= w
    return struct.pack("<I", acc & 0xFFFFFFFF)


ALGOS = {
    "crc32":   (4, lambda d, s, e: struct.pack("<I", binascii.crc32(d[s:e]) & 0xFFFFFFFF)),
    # crc32be: same CRC, stored big-endian — the byte order used by ZF-8HP
    # per-block CRC32 and many other FCA module images.
    "crc32be": (4, lambda d, s, e: struct.pack(">I", binascii.crc32(d[s:e]) & 0xFFFFFFFF)),
    "crc16":   (2, lambda d, s, e: struct.pack("<H", _crc16_ccitt(d[s:e]))),
    "sum16":   (2, lambda d, s, e: struct.pack("<H", _sum16(d, s, e))),
    "sum32":   (4, lambda d, s, e: struct.pack("<I", _sum32(d, s, e))),
    "sum8":    (1, lambda d, s, e: struct.pack("B", sum(d[s:e]) & 0xFF)),
    "xor32":   (4, lambda d, s, e: _xor32(d, s, e)),
}

# Algorithms used by the prefix / structural (end-of-file) scan.  crc32be is
# intentionally excluded here: big-endian CRCs are detected by the per-block
# pass (_block_scan), which is far less prone to noisy false positives than
# surfacing every structural mismatch for an extra algorithm.
PREFIX_ALGOS = ("crc32", "crc16", "sum16", "sum32", "sum8", "xor32")

# Common ECU block sizes probed by the partial-range / per-block scan.
# 0x10000 (64 KB) is included so ZF-8HP TCU per-block CRC32 schemes are caught.
BLOCK_SIZES = (0x100, 0x1000, 0x4000, 0x10000)

# Only CRC algorithms are probed per-block.  Real per-block ECU integrity
# schemes use CRCs; the sum/xor algorithms trivially "validate" over uniform
# padding regions (e.g. an all-0xFF block makes xor32 == 0xFFFFFFFF == stored),
# which would flood the results with false positives.  CRCs do not match a
# uniform region's stored bytes, so they stay robust.
BLOCK_ALGOS = ("crc32", "crc32be", "crc16")


def _covers(start, pos):
    """Human-readable inclusive coverage range string."""
    return f"{hex(start)} .. {hex(pos - 1)}"


# ---------------------------------------------------------------------------
# checksum — scan for stored checksums that verify their own prefix
# ---------------------------------------------------------------------------

def _structural_probes(n):
    """Last 16 bytes of the file's containing power-of-2 block.

    ECU checksums land overwhelmingly at the very end of the flash/EEPROM
    region so we concentrate the structural probe there rather than at every
    sub-block boundary.  Broken checksums at these positions are surfaced even
    when stored ≠ computed so users who edited a dump can find and repair the
    invalidated field.
    """
    # Smallest power-of-2 >= n
    block = 256
    while block < n:
        block *= 2
    probes = set()
    for off in range(1, 17):
        p = block - off
        if 4 <= p < n:
            probes.add(p)
    return probes


def _prefix_states(data, positions):
    """Compute every prefix-checksum value at each probe position in ONE pass.

    Recomputing each algorithm from offset 0 at every probe is O(probes × size)
    and becomes pathological on large images (e.g. a 512 KB ZF-8HP dump takes
    ~80 s).  Because the probe positions are walked in ascending order, the
    accumulators only ever need to be extended forward, making the whole scan
    O(size).  The per-algorithm results are byte-for-byte identical to calling
    the ALGOS lambdas with (data, 0, pos).
    """
    positions = sorted({p for p in positions if 0 < p <= len(data)})
    states = {}
    crc16 = 0xFFFF
    crc32_run = 0
    s8 = 0
    even = odd = 0                 # sum16 byte lanes (even/odd index)
    l0 = l1 = l2 = l3 = 0          # sum32 byte lanes (index % 4)
    x0 = x1 = x2 = x3 = 0          # xor32 byte lanes (index % 4)
    prev = 0
    for cur in positions:
        # crc32 extends over [prev, cur) at C speed.
        crc32_run = binascii.crc32(data[prev:cur], crc32_run)
        for j in range(prev, cur):
            b = data[j]
            s8 += b
            crc16 ^= b << 8
            for _ in range(8):
                crc16 = (crc16 << 1) ^ 0x1021 if crc16 & 0x8000 else crc16 << 1
            crc16 &= 0xFFFF
            if j & 1:
                odd += b
            else:
                even += b
            m = j & 3
            if m == 0:
                l0 += b; x0 ^= b
            elif m == 1:
                l1 += b; x1 ^= b
            elif m == 2:
                l2 += b; x2 ^= b
            else:
                l3 += b; x3 ^= b
        prev = cur

        # sum16 over complete 2-byte words only.
        lo16 = even - (data[cur - 1] if cur & 1 else 0)
        sum16 = (lo16 + 256 * odd) & 0xFFFF
        # sum32 / xor32 over complete 4-byte words only — drop the trailing
        # incomplete word's bytes from each lane.
        rem4 = cur & 3
        base = cur - rem4
        a0, a1, a2, a3 = l0, l1, l2, l3
        b0, b1, b2, b3 = x0, x1, x2, x3
        if rem4 > 0:
            a0 -= data[base]; b0 ^= data[base]
        if rem4 > 1:
            a1 -= data[base + 1]; b1 ^= data[base + 1]
        if rem4 > 2:
            a2 -= data[base + 2]; b2 ^= data[base + 2]
        sum32 = (a0 + 256 * a1 + 65536 * a2 + 16777216 * a3) & 0xFFFFFFFF

        states[cur] = {
            "crc32":   struct.pack("<I", crc32_run & 0xFFFFFFFF),
            "crc32be": struct.pack(">I", crc32_run & 0xFFFFFFFF),
            "crc16":   struct.pack("<H", crc16),
            "sum16":   struct.pack("<H", sum16),
            "sum32":   struct.pack("<I", sum32),
            "sum8":    struct.pack("B", s8 & 0xFF),
            "xor32":   bytes([b0 & 0xFF, b1 & 0xFF, b2 & 0xFF, b3 & 0xFF]),
        }
    return states


def _block_scan(data, n, file_has_content, seen):
    """Detect partial-range / per-block checksums.

    The prefix scan only catches checksums covering bytes 0..offset-1.  Many
    ECU images instead store a checksum at the END of each fixed-size block,
    covering only that block's bytes (a non-prefix range).  The canonical case
    is the ZF-8HP TCU, which stores a big-endian CRC32 in the trailing 4 bytes
    of every 64 KB block over the preceding (BLOCK_SIZE - 4) bytes.

    For every block size in BLOCK_SIZES and every algorithm we treat the last
    `width` bytes of each aligned block as a candidate checksum field and
    recompute over that block's window [block_start .. cs_pos).  A scheme is
    only reported when at least half of a file's blocks (and ≥2) validate —
    this distinguishes a real per-block scheme from chance single-block matches
    of weak algorithms (e.g. sum8).  Once a scheme is confirmed, non-matching
    blocks are surfaced as `broken` so an edited block can be found and repaired.
    Block 0's window starts at 0, so its entry is reported as a normal prefix.
    """
    for block_size in BLOCK_SIZES:
        if block_size > n:
            continue
        total_blocks = n // block_size
        if total_blocks < 2:
            continue
        for algo_name in BLOCK_ALGOS:
            width, fn = ALGOS[algo_name]
            if width >= block_size:
                continue
            results = []  # (cs_pos, start, stored, computed, match)
            for k in range(1, total_blocks + 1):
                block_end = k * block_size
                start = block_end - block_size
                cs_pos = block_end - width
                if cs_pos <= start:
                    continue
                try:
                    computed = fn(data, start, cs_pos)
                except Exception:
                    continue
                stored = data[cs_pos : cs_pos + width]
                match = stored == computed and any(b != 0 for b in stored)
                results.append((cs_pos, start, bytes(stored), computed, match))

            valid_count = sum(1 for r in results if r[4])
            # Require a real scheme: ≥2 blocks AND at least half of them validate.
            if valid_count < 2 or valid_count * 2 < len(results):
                continue

            for cs_pos, start, stored, computed, match in results:
                key = (start, cs_pos, algo_name)
                if match:
                    seen[key] = {
                        "offset":      hex(cs_pos),
                        "algorithm":   algo_name,
                        "width":       width,
                        "stored":      stored.hex(),
                        "computed":    computed.hex(),
                        "status":      "valid",
                        "covers":      _covers(start, cs_pos),
                        "coversStart": hex(start),
                    }
                elif file_has_content and any(b != 0 for b in computed) and key not in seen:
                    seen[key] = {
                        "offset":      hex(cs_pos),
                        "algorithm":   algo_name,
                        "width":       width,
                        "stored":      stored.hex(),
                        "computed":    computed.hex(),
                        "status":      "broken",
                        "covers":      _covers(start, cs_pos),
                        "coversStart": hex(start),
                    }


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

    # Sample at ~512 positions across the file for speed; always include
    # common ECU checksum landing spots (end of header blocks) and structural
    # high-probability positions.
    step = max(2, n // 400)
    regular_probes = set(range(4, n - 4, step))
    for pct in [0.25, 0.5, 0.75, 1.0]:
        regular_probes.add(max(4, int(n * pct) & ~1))

    structural = _structural_probes(n)
    all_probes = regular_probes | structural

    # Only surface broken candidates when the file actually has content.
    # All-zero / all-FF images produce non-trivial CRC values at every probe
    # position, which would generate misleading noise with no repair value.
    file_has_content = any(b != 0 for b in data)

    # seen: (start, pos, algo) → entry  (prefer "valid" over "broken" if both match).
    # `start` is the coverage window start (0 for prefix checksums) so that a
    # prefix and a partial-range checksum landing at the same offset don't clash.
    seen = {}

    # Precompute every prefix-checksum value at all probe positions in a single
    # forward pass (O(size) instead of O(probes × size)).
    prefix_states = _prefix_states(data, all_probes)

    for pos in sorted(all_probes):
        is_structural = pos in structural
        state = prefix_states.get(pos, {})
        for algo_name in PREFIX_ALGOS:
            width, fn = ALGOS[algo_name]
            if pos + width > n:
                continue
            computed = state.get(algo_name)
            if computed is None:
                continue
            stored = data[pos : pos + width]
            key = (0, pos, algo_name)

            if stored == computed and any(b != 0 for b in stored):
                # Valid checksum — always record; overwrites any prior broken entry
                seen[key] = {
                    "offset":      hex(pos),
                    "algorithm":   algo_name,
                    "width":       width,
                    "stored":      stored.hex(),
                    "computed":    computed.hex(),
                    "status":      "valid",
                    "covers":      _covers(0, pos),
                    "coversStart": "0x0",
                }
            elif is_structural and file_has_content and any(b != 0 for b in computed) and key not in seen:
                # Broken candidate: structural end-of-file position, file has data,
                # computed is non-trivial — surface so users can find and repair.
                seen[key] = {
                    "offset":      hex(pos),
                    "algorithm":   algo_name,
                    "width":       width,
                    "stored":      stored.hex(),
                    "computed":    computed.hex(),
                    "status":      "broken",
                    "covers":      _covers(0, pos),
                    "coversStart": "0x0",
                }

    # Partial-range / per-block checksums (e.g. ZF-8HP TCU per-block CRC32).
    _block_scan(data, n, file_has_content, seen)

    valid_entries  = sorted(
        (e for e in seen.values() if e["status"] == "valid"),
        key=lambda x: int(x["offset"], 16),
    )
    # Broken: sort DESC by offset so end-of-file (most likely ECU checksum) is first
    broken_entries = sorted(
        (e for e in seen.values() if e["status"] == "broken"),
        key=lambda x: -int(x["offset"], 16),
    )
    # Valid entries first, then broken (highest offset first).
    # Combined cap of 30 so that with 0 valid entries the broken pool gets 30 slots.
    entries = (valid_entries + broken_entries)[:30]

    out({
        "ok": True,
        "file": a.file,
        "whole_file": whole,
        "found": len(entries),
        "checksums": entries[:30],
        "note": (
            "Valid entries (✓): stored checksum matches the computed value over "
            "its 'covers' range (prefix 0x0.. for whole-image checksums, or a "
            "partial/per-block range for schemes like the ZF-8HP per-block CRC32). "
            "Broken entries (✗): a structural or per-block position where stored ≠ "
            "computed — likely a checksum invalidated by an edit. "
            "Use fixck with --start=coversStart to recompute and repair."
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
    start = a.start or 0
    width, fn = ALGOS[a.algorithm]
    if pos + width > len(data):
        err(f"checksum offset {hex(pos)} + {width} bytes out of range (file size {len(data)})")
        return
    if start < 0 or start >= pos:
        err(f"coverage start {hex(start)} must be >= 0 and < offset {hex(pos)}")
        return

    old = bytes(data[pos : pos + width]).hex()
    # Recompute over the covered window [start .. pos).  start defaults to 0
    # (prefix); pass the scan's coversStart to repair a partial/per-block range.
    new_bytes = fn(data, start, pos)
    data[pos : pos + width] = new_bytes

    out_path = a.out or a.file
    open(out_path, "wb").write(bytes(data))
    out({
        "ok": True,
        "file": a.file,
        "out": out_path,
        "offset": hex(pos),
        "coversStart": hex(start),
        "algorithm": a.algorithm,
        "old": old,
        "new": new_bytes.hex(),
        "changed": old != new_bytes.hex(),
        "note": (
            f"Checksum recalculated over {hex(start)}..{hex(pos - 1)} and written to {hex(pos)}. "
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
    sp.add_argument("--start", type=lambda x: int(x, 0), default=0,
                    help="coverage window start (use the scan's coversStart for "
                         "partial/per-block checksums; default 0 = prefix)")
    sp.add_argument("--algorithm", required=True,
                    help=f"algorithm name: {list(ALGOS.keys())}")
    sp.add_argument("--out", default=None,
                    help="output path (defaults to overwriting input)")

    sp = sub.add_parser("patch", help="alias for fixck — recompute and write back one checksum")
    sp.add_argument("file")
    sp.add_argument("--offset", type=lambda x: int(x, 0), required=True,
                    help="byte offset of the stored checksum (from checksum scan)")
    sp.add_argument("--start", type=lambda x: int(x, 0), default=0,
                    help="coverage window start (use the scan's coversStart for "
                         "partial/per-block checksums; default 0 = prefix)")
    sp.add_argument("--algorithm", required=True,
                    help=f"algorithm name: {list(ALGOS.keys())}")
    sp.add_argument("--out", default=None,
                    help="output path (defaults to overwriting input)")

    sp = sub.add_parser("eepmap", help="extract VIN candidates, strings, mirrors")
    sp.add_argument("file")

    a = p.parse_args()
    try:
        {"checksum": cmd_checksum, "fixck": cmd_fixck, "patch": cmd_fixck, "eepmap": cmd_eepmap}[a.cmd](a)
    except FileNotFoundError:
        err(f"file not found: {getattr(a, 'file', '?')}")
    except Exception as e:
        err(f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        sys.exit(0)
