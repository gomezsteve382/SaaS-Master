#!/usr/bin/env python3
"""
makekeyfn — generate a self-contained seed->key harness (keyfn.py) from a
firmware routine, by emulating it with Unicorn.

Given the firmware file + the location of the SecurityAccess key routine (offset/
addresses/registers, found via ghidra_decompile / disassemble / find_crypto), it
writes a standalone keyfn.py exposing `def key(seed: bytes) -> bytes` that runs
the REAL routine under Unicorn for whatever seed it's given.

    makekeyfn.py --file fw.bin --arch x86 --bits 64 --base 0x400000 \
        --offset 0 --size 0x100 --start 0x400000 --stop 0x40000a \
        --seed-reg edi --key-reg eax --keylen 4 --out keyfn.py
"""

import argparse
import json
import sys

TEMPLATE = r'''# Auto-generated seed->key harness (Unicorn). def key(seed: bytes) -> bytes
# Re-runs the firmware's real key routine for any seed.
from unicorn import (
    Uc, UcError,
    UC_ARCH_X86, UC_ARCH_ARM, UC_ARCH_ARM64, UC_ARCH_MIPS,
    UC_MODE_16, UC_MODE_32, UC_MODE_64, UC_MODE_ARM, UC_MODE_LITTLE_ENDIAN,
)
from unicorn import x86_const, arm_const, arm64_const, mips_const

CODE = bytes.fromhex("__CODEHEX__")
ARCH = "__ARCH__"
BITS = __BITS__
BASE = __BASE__
START = __START__
STOP = __STOP__
SEED_REG = "__SEEDREG__"
KEY_REG = "__KEYREG__"
KEYLEN = __KEYLEN__
ENDIAN = "__ENDIAN__"
STEPS = __STEPS__

PAGE = 0x1000
STACK_BASE = 0x7F000000
STACK_SIZE = 0x100000
_ARCH = {
    "x86": (UC_ARCH_X86, {16: UC_MODE_16, 32: UC_MODE_32, 64: UC_MODE_64}),
    "arm": (UC_ARCH_ARM, {32: UC_MODE_ARM}),
    "arm64": (UC_ARCH_ARM64, {64: UC_MODE_ARM}),
    "mips": (UC_ARCH_MIPS, {32: UC_MODE_32}),
}
_CONSTS = {"x86": x86_const, "arm": arm_const, "arm64": arm64_const, "mips": mips_const}
_PREFIX = {"x86": "UC_X86_REG_", "arm": "UC_ARM_REG_", "arm64": "UC_ARM64_REG_", "mips": "UC_MIPS_REG_"}
_SP = {"x86": {16: "SP", 32: "ESP", 64: "RSP"}, "arm": {32: "SP"}, "arm64": {64: "SP"}, "mips": {32: "SP"}}


def _reg(name):
    return getattr(_CONSTS[ARCH], _PREFIX[ARCH] + name.upper())


def key(seed: bytes) -> bytes:
    arch_id, modes = _ARCH[ARCH]
    mode = modes[BITS]
    if ARCH == "mips":
        mode |= UC_MODE_LITTLE_ENDIAN
    uc = Uc(arch_id, mode)
    load = BASE & ~(PAGE - 1)
    size = ((len(CODE) + (BASE - load) + PAGE - 1) // PAGE + 1) * PAGE
    uc.mem_map(load, size)
    uc.mem_write(BASE, CODE)
    uc.mem_map(STACK_BASE, STACK_SIZE)
    uc.reg_write(_reg(_SP[ARCH][BITS]), STACK_BASE + STACK_SIZE - 0x1000)
    uc.reg_write(_reg(SEED_REG), int.from_bytes(seed, ENDIAN))
    try:
        uc.emu_start(START, STOP, count=STEPS)
    except UcError:
        pass
    val = int(uc.reg_read(_reg(KEY_REG)))
    raw = val.to_bytes(8, ENDIAN)
    return raw[:KEYLEN] if ENDIAN == "little" else raw[-KEYLEN:]
'''


def out(o):
    sys.stdout.write(json.dumps(o) + "\n")


def main():
    ap = argparse.ArgumentParser(prog="makekeyfn")
    ap.add_argument("--file", required=True)
    ap.add_argument("--arch", default="x86", choices=["x86", "arm", "arm64", "mips"])
    ap.add_argument("--bits", type=int, default=64)
    ap.add_argument("--base", type=lambda x: int(x, 0), default=0x400000)
    ap.add_argument("--offset", type=lambda x: int(x, 0), default=0)
    ap.add_argument("--size", type=lambda x: int(x, 0), default=0x200)
    ap.add_argument("--start", type=lambda x: int(x, 0), required=True)
    ap.add_argument("--stop", type=lambda x: int(x, 0), required=True)
    ap.add_argument("--seed-reg", required=True, dest="seed_reg")
    ap.add_argument("--key-reg", required=True, dest="key_reg")
    ap.add_argument("--keylen", type=int, default=4)
    ap.add_argument("--endian", default="little", choices=["little", "big"])
    ap.add_argument("--steps", type=int, default=200000)
    ap.add_argument("--out", default="keyfn.py")
    a = ap.parse_args()

    try:
        import unicorn  # noqa: F401
    except ImportError:
        out({"ok": False, "error": "unicorn not installed. Run: pip install unicorn"})
        return

    try:
        with open(a.file, "rb") as f:
            f.seek(a.offset)
            code = f.read(a.size)
    except FileNotFoundError:
        out({"ok": False, "error": f"file not found: {a.file}"})
        return

    if not code:
        out({"ok": False, "error": "no code at that offset/size — check --offset and --size"})
        return

    src = TEMPLATE
    repl = {
        "__CODEHEX__": code.hex(), "__ARCH__": a.arch, "__BITS__": str(a.bits),
        "__BASE__": hex(a.base), "__START__": hex(a.start), "__STOP__": hex(a.stop),
        "__SEEDREG__": a.seed_reg, "__KEYREG__": a.key_reg, "__KEYLEN__": str(a.keylen),
        "__ENDIAN__": a.endian, "__STEPS__": str(a.steps),
    }
    for k, v in repl.items():
        src = src.replace(k, v)

    with open(a.out, "w") as f:
        f.write(src)

    sample = b"\x11\x22\x33\x44"[:a.keylen].ljust(a.keylen, b"\x00")
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("keyfn_gen", a.out)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        k = mod.key(sample)
        out({
            "ok": True, "out": a.out, "code_bytes": len(code),
            "arch": a.arch, "bits": a.bits,
            "sample_seed": sample.hex(), "sample_key": k.hex(),
            "note": (
                "Generated keyfn.py runs the real routine under Unicorn for any seed. "
                "Verify sample_key against a known-good bench pair before trusting it. "
                "Load via --keyfn to make a UDS sim validate the real algorithm."
            ),
        })
    except Exception as e:
        out({
            "ok": True, "out": a.out, "code_bytes": len(code),
            "verify_error": f"{type(e).__name__}: {e}",
            "note": "File written but the sample run failed — check arch/bits/start/stop/registers from disassembly.",
        })


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        out({"ok": False, "error": f"{type(e).__name__}: {e}"})
