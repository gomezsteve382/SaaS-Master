#!/usr/bin/env python3
"""
emulate — CPU emulation bridge (Unicorn Engine).

Loads a slice of a binary into emulated memory, sets registers, runs a routine,
and reports the resulting register/memory state.

    emulate.py --file F --arch x86 --bits 64 --base 0x400000 \
        --offset 0 --size 0x1000 --start 0x400500 [--stop 0x400560] \
        [--steps 200000] [--reg rdi=0x11223344] [--dump 0x401000:64]

Supported arch/bits: x86/16|32|64, arm/32, arm64/64, mips/32.
"""

import argparse
import json
import sys

PAGE = 0x1000
STACK_BASE = 0x7F000000
STACK_SIZE = 0x100000


def out(o):
    json.dump(o, sys.stdout, default=str)
    sys.stdout.write("\n")


def err(m):
    out({"ok": False, "error": str(m)})
    sys.exit(0)


def align_down(x):
    return x & ~(PAGE - 1)


def reg_const(consts, arch, name):
    name = name.upper()
    prefix = {
        "x86": "UC_X86_REG_",
        "arm": "UC_ARM_REG_",
        "arm64": "UC_ARM64_REG_",
        "mips": "UC_MIPS_REG_",
    }[arch]
    return getattr(consts, prefix + name, None)


def main():
    try:
        from unicorn import (
            Uc, UC_ARCH_X86, UC_ARCH_ARM, UC_ARCH_ARM64, UC_ARCH_MIPS,
            UC_MODE_16, UC_MODE_32, UC_MODE_64, UC_MODE_ARM, UC_MODE_LITTLE_ENDIAN,
            UcError, UC_HOOK_CODE,
        )
        from unicorn import x86_const, arm_const, arm64_const, mips_const
    except ImportError:
        err("unicorn not installed. Run: pip install unicorn")
        return

    REGS = {
        ("x86", 64): (UC_ARCH_X86, UC_MODE_64, x86_const, x86_const.UC_X86_REG_RSP,
                      ["rax","rbx","rcx","rdx","rsi","rdi","rbp","rsp",
                       "r8","r9","r10","r11","r12","r13","r14","r15","rip"]),
        ("x86", 32): (UC_ARCH_X86, UC_MODE_32, x86_const, x86_const.UC_X86_REG_ESP,
                      ["eax","ebx","ecx","edx","esi","edi","ebp","esp","eip"]),
        ("x86", 16): (UC_ARCH_X86, UC_MODE_16, x86_const, x86_const.UC_X86_REG_SP,
                      ["ax","bx","cx","dx","si","di","bp","sp","ip"]),
        ("arm", 32): (UC_ARCH_ARM, UC_MODE_ARM, arm_const, arm_const.UC_ARM_REG_SP,
                      ["r0","r1","r2","r3","r4","r5","r6","r7",
                       "r8","r9","r10","r11","r12","sp","lr","pc"]),
        ("arm64", 64): (UC_ARCH_ARM64, UC_MODE_ARM, arm64_const, arm64_const.UC_ARM64_REG_SP,
                        ["x0","x1","x2","x3","x4","x5","x6","x7",
                         "x8","x9","x10","x11","x12","x13","x14","x15","sp","lr","pc"]),
        ("mips", 32): (UC_ARCH_MIPS, UC_MODE_32, mips_const, mips_const.UC_MIPS_REG_SP,
                       ["zero","at","v0","v1","a0","a1","a2","a3",
                        "t0","t1","sp","ra","pc"]),
    }

    ap = argparse.ArgumentParser(prog="emulate")
    ap.add_argument("--file", required=True)
    ap.add_argument("--arch", default="x86", choices=["x86", "arm", "arm64", "mips"])
    ap.add_argument("--bits", type=int, default=64)
    ap.add_argument("--base", type=lambda x: int(x, 0), default=0x400000)
    ap.add_argument("--offset", type=lambda x: int(x, 0), default=0)
    ap.add_argument("--size", type=lambda x: int(x, 0), default=0x4000)
    ap.add_argument("--start", type=lambda x: int(x, 0), default=None)
    ap.add_argument("--stop", type=lambda x: int(x, 0), default=0)
    ap.add_argument("--steps", type=int, default=200000)
    ap.add_argument("--reg", action="append", default=[], help="name=hexvalue")
    ap.add_argument("--dump", default=None, help="addr:len (hex)")
    ap.add_argument("--trace", action="store_true")
    a = ap.parse_args()

    key = (a.arch, a.bits)
    if key not in REGS:
        err(f"unsupported arch/bits {a.arch}/{a.bits}; supported: {list(REGS.keys())}")
        return

    arch_id, mode, consts, sp_reg, reglist = REGS[key]
    if a.arch == "mips":
        mode |= UC_MODE_LITTLE_ENDIAN

    try:
        with open(a.file, "rb") as f:
            f.seek(a.offset)
            code = f.read(a.size)
    except FileNotFoundError:
        err(f"file not found: {a.file}")
        return

    if not code:
        err("no bytes to load — check --offset/--size")
        return

    uc = Uc(arch_id, mode)
    load_at = align_down(a.base)
    map_size = ((len(code) + (a.base - load_at) + PAGE - 1) // PAGE + 1) * PAGE
    uc.mem_map(load_at, map_size)
    uc.mem_write(a.base, code)
    uc.mem_map(STACK_BASE, STACK_SIZE)
    uc.reg_write(sp_reg, STACK_BASE + STACK_SIZE - 0x1000)

    for spec in a.reg:
        if "=" not in spec:
            continue
        name, val = spec.split("=", 1)
        rc = reg_const(consts, a.arch, name.strip())
        if rc is None:
            err(f"unknown register '{name.strip()}' for {a.arch}")
            return
        uc.reg_write(rc, int(val.strip(), 0))

    trace = []
    if a.trace:
        def hook(uc_, addr, size, _):
            if len(trace) < 256:
                trace.append(hex(addr))
        uc.hook_add(UC_HOOK_CODE, hook)

    start = a.start if a.start is not None else a.base
    error = None
    try:
        uc.emu_start(start, a.stop if a.stop else (load_at + map_size), count=a.steps)
    except UcError as e:
        error = (
            f"emulation stopped: {e} "
            "(a RET to an unmapped return address is normal — registers below are still valid)"
        )

    final = {}
    for r in reglist:
        rc = reg_const(consts, a.arch, r)
        if rc is not None:
            final[r] = hex(uc.reg_read(rc))

    dump = None
    if a.dump:
        try:
            da, dl = a.dump.split(":")
            da, dl = int(da, 0), int(dl, 0)
            dump = {"addr": hex(da), "hex": uc.mem_read(da, dl).hex()}
        except Exception as ex:
            dump = {"error": str(ex)}

    out({
        "ok": True,
        "arch": a.arch, "bits": a.bits,
        "start": hex(start), "stop": hex(a.stop) if a.stop else None,
        "steps_max": a.steps,
        "note": error,
        "registers": final,
        "memory_dump": dump,
        "trace": trace if a.trace else None,
    })


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        sys.exit(0)
    except Exception as e:
        out({"ok": False, "error": f"{type(e).__name__}: {e}"})
