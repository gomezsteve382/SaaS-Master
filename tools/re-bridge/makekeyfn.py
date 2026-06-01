#!/usr/bin/env python3
"""makekeyfn.py — emulate a firmware SecurityAccess snippet and extract a seed→key function.

Reads one JSON object from stdin, writes one JSON object to stdout.

Input fields
------------
fileB64   : str   base64-encoded firmware bytes (full bin or slice)
arch      : str   "arm" | "thumb" | "arm64" | "x86" | "ppc" | "mips"
bits      : int   32 or 64
base      : int   load address of the firmware (VA where fileB64 maps)
offset    : int   byte offset into fileB64 where the snippet starts (default 0)
size      : int   bytes of snippet to map (null → rest of file from offset)
start     : int   emulation start VA (entry point of the SA handler)
stop      : int   emulation stop VA  (address just past the last instruction)
seedReg   : str   register name that receives the seed   (e.g. "r0", "eax")
keyReg    : str   register name from which the key is read (e.g. "r1", "eax")
keylen    : int   key width in bytes (1–8, default 4)
endian    : str   "little" | "big" (default "little", used for keyfn struct pack)

Output fields
-------------
ok           : bool
keyfnCode    : str   self-contained Python keyfn(seed)->int function source
verifiedVector : {seed, key}  one emulation result used to sanity-check
error        : str   (only when ok=false)
"""

from __future__ import annotations

import base64
import json
import struct
import sys
import traceback

PAGE = 0x1000
STACK_BASE = 0xBEEF_0000
STACK_SIZE = 0x4000
TIMEOUT_US = 10_000_000


# ---------------------------------------------------------------------------
# Architecture helpers
# ---------------------------------------------------------------------------

def _parse_arch(arch_str: str, bits: int):
    """Return (UC_ARCH, UC_MODE) tuple for the given arch/bits combination."""
    from unicorn import (
        UC_ARCH_ARM, UC_ARCH_ARM64, UC_ARCH_X86, UC_ARCH_PPC, UC_ARCH_MIPS,
        UC_MODE_ARM, UC_MODE_THUMB, UC_MODE_32, UC_MODE_64,
        UC_MODE_MIPS32, UC_MODE_BIG_ENDIAN,
    )
    key = (arch_str.lower(), int(bits))
    table = {
        ("arm",   32): (UC_ARCH_ARM,   UC_MODE_ARM),
        ("thumb", 16): (UC_ARCH_ARM,   UC_MODE_THUMB),
        ("thumb", 32): (UC_ARCH_ARM,   UC_MODE_THUMB),
        ("arm64", 64): (UC_ARCH_ARM64, UC_MODE_ARM),
        ("x86",   32): (UC_ARCH_X86,   UC_MODE_32),
        ("x86",   64): (UC_ARCH_X86,   UC_MODE_64),
        ("ppc",   32): (UC_ARCH_PPC,   UC_MODE_32 | UC_MODE_BIG_ENDIAN),
        ("mips",  32): (UC_ARCH_MIPS,  UC_MODE_MIPS32),
    }
    if key not in table:
        raise ValueError(f"unsupported arch/bits combination: {arch_str!r}/{bits}")
    return table[key]


def _reg_map(arch_str: str, bits: int) -> dict[str, int]:
    """Return {name: unicorn_const} for all registers in the given arch."""
    arch = arch_str.lower()

    if arch in ("arm", "thumb"):
        from unicorn.arm_const import (
            UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3,
            UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7,
            UC_ARM_REG_R8, UC_ARM_REG_R9, UC_ARM_REG_R10, UC_ARM_REG_R11,
            UC_ARM_REG_R12, UC_ARM_REG_R13, UC_ARM_REG_R14, UC_ARM_REG_R15,
            UC_ARM_REG_PC, UC_ARM_REG_SP, UC_ARM_REG_LR, UC_ARM_REG_CPSR,
        )
        regs = [
            UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3,
            UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7,
            UC_ARM_REG_R8, UC_ARM_REG_R9, UC_ARM_REG_R10, UC_ARM_REG_R11,
            UC_ARM_REG_R12, UC_ARM_REG_R13, UC_ARM_REG_R14, UC_ARM_REG_R15,
        ]
        m = {f"r{i}": regs[i] for i in range(16)}
        m.update({"pc": UC_ARM_REG_PC, "sp": UC_ARM_REG_SP,
                   "lr": UC_ARM_REG_LR, "cpsr": UC_ARM_REG_CPSR})
        return m

    if arch == "arm64":
        from unicorn.arm64_const import (
            UC_ARM64_REG_X0, UC_ARM64_REG_X1, UC_ARM64_REG_X2, UC_ARM64_REG_X3,
            UC_ARM64_REG_X4, UC_ARM64_REG_X5, UC_ARM64_REG_X6, UC_ARM64_REG_X7,
            UC_ARM64_REG_X8, UC_ARM64_REG_X9, UC_ARM64_REG_X10, UC_ARM64_REG_X11,
            UC_ARM64_REG_X12, UC_ARM64_REG_X13, UC_ARM64_REG_X14, UC_ARM64_REG_X15,
            UC_ARM64_REG_X16, UC_ARM64_REG_X17, UC_ARM64_REG_X18, UC_ARM64_REG_X19,
            UC_ARM64_REG_X20, UC_ARM64_REG_X21, UC_ARM64_REG_X22, UC_ARM64_REG_X23,
            UC_ARM64_REG_X24, UC_ARM64_REG_X25, UC_ARM64_REG_X26, UC_ARM64_REG_X27,
            UC_ARM64_REG_X28, UC_ARM64_REG_X29, UC_ARM64_REG_X30,
            UC_ARM64_REG_SP, UC_ARM64_REG_PC,
        )
        xregs = [
            UC_ARM64_REG_X0, UC_ARM64_REG_X1, UC_ARM64_REG_X2, UC_ARM64_REG_X3,
            UC_ARM64_REG_X4, UC_ARM64_REG_X5, UC_ARM64_REG_X6, UC_ARM64_REG_X7,
            UC_ARM64_REG_X8, UC_ARM64_REG_X9, UC_ARM64_REG_X10, UC_ARM64_REG_X11,
            UC_ARM64_REG_X12, UC_ARM64_REG_X13, UC_ARM64_REG_X14, UC_ARM64_REG_X15,
            UC_ARM64_REG_X16, UC_ARM64_REG_X17, UC_ARM64_REG_X18, UC_ARM64_REG_X19,
            UC_ARM64_REG_X20, UC_ARM64_REG_X21, UC_ARM64_REG_X22, UC_ARM64_REG_X23,
            UC_ARM64_REG_X24, UC_ARM64_REG_X25, UC_ARM64_REG_X26, UC_ARM64_REG_X27,
            UC_ARM64_REG_X28, UC_ARM64_REG_X29, UC_ARM64_REG_X30,
        ]
        m = {f"x{i}": xregs[i] for i in range(31)}
        m.update({"sp": UC_ARM64_REG_SP, "pc": UC_ARM64_REG_PC})
        return m

    if arch == "x86":
        from unicorn.x86_const import (
            UC_X86_REG_EAX, UC_X86_REG_EBX, UC_X86_REG_ECX, UC_X86_REG_EDX,
            UC_X86_REG_ESI, UC_X86_REG_EDI, UC_X86_REG_ESP, UC_X86_REG_EBP, UC_X86_REG_EIP,
            UC_X86_REG_RAX, UC_X86_REG_RBX, UC_X86_REG_RCX, UC_X86_REG_RDX,
            UC_X86_REG_RSI, UC_X86_REG_RDI, UC_X86_REG_RSP, UC_X86_REG_RBP, UC_X86_REG_RIP,
            UC_X86_REG_R8, UC_X86_REG_R9, UC_X86_REG_R10, UC_X86_REG_R11,
            UC_X86_REG_R12, UC_X86_REG_R13, UC_X86_REG_R14, UC_X86_REG_R15,
        )
        if bits == 32:
            return {
                "eax": UC_X86_REG_EAX, "ebx": UC_X86_REG_EBX,
                "ecx": UC_X86_REG_ECX, "edx": UC_X86_REG_EDX,
                "esi": UC_X86_REG_ESI, "edi": UC_X86_REG_EDI,
                "esp": UC_X86_REG_ESP, "ebp": UC_X86_REG_EBP,
                "eip": UC_X86_REG_EIP,
            }
        else:
            extra = [
                UC_X86_REG_R8, UC_X86_REG_R9, UC_X86_REG_R10, UC_X86_REG_R11,
                UC_X86_REG_R12, UC_X86_REG_R13, UC_X86_REG_R14, UC_X86_REG_R15,
            ]
            m = {
                "rax": UC_X86_REG_RAX, "rbx": UC_X86_REG_RBX,
                "rcx": UC_X86_REG_RCX, "rdx": UC_X86_REG_RDX,
                "rsi": UC_X86_REG_RSI, "rdi": UC_X86_REG_RDI,
                "rsp": UC_X86_REG_RSP, "rbp": UC_X86_REG_RBP,
                "rip": UC_X86_REG_RIP,
            }
            m.update({f"r{8 + i}": extra[i] for i in range(8)})
            return m

    if arch == "ppc":
        from unicorn.ppc_const import (
            UC_PPC_REG_0, UC_PPC_REG_1, UC_PPC_REG_2, UC_PPC_REG_3,
            UC_PPC_REG_4, UC_PPC_REG_5, UC_PPC_REG_6, UC_PPC_REG_7,
            UC_PPC_REG_8, UC_PPC_REG_9, UC_PPC_REG_10, UC_PPC_REG_11,
            UC_PPC_REG_12, UC_PPC_REG_13, UC_PPC_REG_14, UC_PPC_REG_15,
            UC_PPC_REG_16, UC_PPC_REG_17, UC_PPC_REG_18, UC_PPC_REG_19,
            UC_PPC_REG_20, UC_PPC_REG_21, UC_PPC_REG_22, UC_PPC_REG_23,
            UC_PPC_REG_24, UC_PPC_REG_25, UC_PPC_REG_26, UC_PPC_REG_27,
            UC_PPC_REG_28, UC_PPC_REG_29, UC_PPC_REG_30, UC_PPC_REG_31,
        )
        ppc_regs = [
            UC_PPC_REG_0, UC_PPC_REG_1, UC_PPC_REG_2, UC_PPC_REG_3,
            UC_PPC_REG_4, UC_PPC_REG_5, UC_PPC_REG_6, UC_PPC_REG_7,
            UC_PPC_REG_8, UC_PPC_REG_9, UC_PPC_REG_10, UC_PPC_REG_11,
            UC_PPC_REG_12, UC_PPC_REG_13, UC_PPC_REG_14, UC_PPC_REG_15,
            UC_PPC_REG_16, UC_PPC_REG_17, UC_PPC_REG_18, UC_PPC_REG_19,
            UC_PPC_REG_20, UC_PPC_REG_21, UC_PPC_REG_22, UC_PPC_REG_23,
            UC_PPC_REG_24, UC_PPC_REG_25, UC_PPC_REG_26, UC_PPC_REG_27,
            UC_PPC_REG_28, UC_PPC_REG_29, UC_PPC_REG_30, UC_PPC_REG_31,
        ]
        return {f"r{i}": ppc_regs[i] for i in range(32)}

    if arch == "mips":
        from unicorn.mips_const import (
            UC_MIPS_REG_0, UC_MIPS_REG_1, UC_MIPS_REG_2, UC_MIPS_REG_3,
            UC_MIPS_REG_4, UC_MIPS_REG_5, UC_MIPS_REG_6, UC_MIPS_REG_7,
            UC_MIPS_REG_8, UC_MIPS_REG_9, UC_MIPS_REG_10, UC_MIPS_REG_11,
            UC_MIPS_REG_12, UC_MIPS_REG_13, UC_MIPS_REG_14, UC_MIPS_REG_15,
            UC_MIPS_REG_16, UC_MIPS_REG_17, UC_MIPS_REG_18, UC_MIPS_REG_19,
            UC_MIPS_REG_20, UC_MIPS_REG_21, UC_MIPS_REG_22, UC_MIPS_REG_23,
            UC_MIPS_REG_24, UC_MIPS_REG_25, UC_MIPS_REG_26, UC_MIPS_REG_27,
            UC_MIPS_REG_28, UC_MIPS_REG_29, UC_MIPS_REG_30, UC_MIPS_REG_31,
        )
        mips_regs = [
            UC_MIPS_REG_0, UC_MIPS_REG_1, UC_MIPS_REG_2, UC_MIPS_REG_3,
            UC_MIPS_REG_4, UC_MIPS_REG_5, UC_MIPS_REG_6, UC_MIPS_REG_7,
            UC_MIPS_REG_8, UC_MIPS_REG_9, UC_MIPS_REG_10, UC_MIPS_REG_11,
            UC_MIPS_REG_12, UC_MIPS_REG_13, UC_MIPS_REG_14, UC_MIPS_REG_15,
            UC_MIPS_REG_16, UC_MIPS_REG_17, UC_MIPS_REG_18, UC_MIPS_REG_19,
            UC_MIPS_REG_20, UC_MIPS_REG_21, UC_MIPS_REG_22, UC_MIPS_REG_23,
            UC_MIPS_REG_24, UC_MIPS_REG_25, UC_MIPS_REG_26, UC_MIPS_REG_27,
            UC_MIPS_REG_28, UC_MIPS_REG_29, UC_MIPS_REG_30, UC_MIPS_REG_31,
        ]
        aliases = {
            "zero": UC_MIPS_REG_0, "at": UC_MIPS_REG_1,
            "v0": UC_MIPS_REG_2, "v1": UC_MIPS_REG_3,
            "a0": UC_MIPS_REG_4, "a1": UC_MIPS_REG_5,
            "a2": UC_MIPS_REG_6, "a3": UC_MIPS_REG_7,
            **{f"t{i}": mips_regs[8 + i] for i in range(8)},
            **{f"s{i}": mips_regs[16 + i] for i in range(8)},
            "t8": UC_MIPS_REG_24, "t9": UC_MIPS_REG_25,
            "k0": UC_MIPS_REG_26, "k1": UC_MIPS_REG_27,
            "gp": UC_MIPS_REG_28, "sp": UC_MIPS_REG_29,
            "fp": UC_MIPS_REG_30, "ra": UC_MIPS_REG_31,
        }
        m = {f"r{i}": mips_regs[i] for i in range(32)}
        m.update(aliases)
        return m

    raise ValueError(f"unsupported arch: {arch_str!r}")


def _sp_reg(arch_str: str, bits: int) -> int:
    """Return the unicorn constant for the stack pointer register."""
    m = _reg_map(arch_str, bits)
    for name in ("sp", "r13", "esp", "rsp", "r1"):
        if name in m:
            return m[name]
    raise RuntimeError(f"cannot find SP register for {arch_str}/{bits}")


# ---------------------------------------------------------------------------
# Emulator setup + run
# ---------------------------------------------------------------------------

def _page_align_up(v: int) -> int:
    return (v + PAGE - 1) & ~(PAGE - 1)


def _run_emulation(
    code: bytes,
    arch_str: str,
    bits: int,
    base: int,
    start: int,
    stop: int,
    seed_reg_id: int,
    seed_value: int,
) -> tuple[object, int]:
    """Set up Unicorn, run from start→stop, return (mu, sp_value)."""
    from unicorn import Uc, UcError

    uc_arch, uc_mode = _parse_arch(arch_str, bits)
    mu = Uc(uc_arch, uc_mode)

    # Map firmware region (page-aligned around base).
    map_base = base & ~(PAGE - 1)
    map_end = _page_align_up(base + len(code))
    map_size = max(map_end - map_base, PAGE)
    mu.mem_map(map_base, map_size)
    mu.mem_write(base, code)

    # Map stack region (avoid collision with firmware).
    stack_base = STACK_BASE
    if map_base <= stack_base < map_base + map_size:
        stack_base = map_base + map_size
        stack_base = _page_align_up(stack_base)
    mu.mem_map(stack_base, STACK_SIZE)
    sp_val = stack_base + STACK_SIZE - 8
    sp_id = _sp_reg(arch_str, bits)
    mu.reg_write(sp_id, sp_val)

    # Seed register.
    mu.reg_write(seed_reg_id, seed_value & 0xFFFF_FFFF_FFFF_FFFF)

    try:
        mu.emu_start(start, stop, timeout=TIMEOUT_US)
    except UcError:
        # UcError is raised if execution hits an unmapped region or the
        # stop address hook fires; the key register may still be valid.
        pass

    return mu, sp_val


# ---------------------------------------------------------------------------
# keyfn.py code generation
# ---------------------------------------------------------------------------

_KEYFN_TEMPLATE = """\
# AUTO-GENERATED by SRT Lab makekeyfn.py — do not edit by hand.
# Arch : {arch} {bits}-bit   endian : {endian}
# Base : 0x{base:08X}        offset : 0x{offset:X}
# Range: 0x{start:08X} → 0x{stop:08X}
# Seed : {seedReg}            Key : {keyReg} ({keylen} byte(s))
# Verified: seed=0x{vseed:08X} → key=0x{vkey:08X}
#
# Drop this file alongside algos.js and add an entry:
#   {{ id:'emu_{arch}{bits}', n:'Emulated SA (0x{start:X})', fn: ... }}
# calling the Python function via pyodide or a bridge.

import base64, struct
try:
    from unicorn import Uc, UcError
    from unicorn import {UC_ARCH}, {UC_MODE}
except ImportError as _e:
    raise RuntimeError(f"unicorn not installed: {{_e}}") from _e

_CODE_B64 = (
{code_b64_wrapped}
)
_CODE      = base64.b64decode("".join(_CODE_B64.split()))
_BASE      = {base:#010x}
_MAP_BASE  = _BASE & ~0xFFF
_MAP_SIZE  = {map_size:#010x}
_START     = {start:#010x}
_STOP      = {stop:#010x}
_SEED_REG  = {seed_reg_const}   # {seedReg}
_KEY_REG   = {key_reg_const}    # {keyReg}
_KEY_MASK  = {key_mask:#010x}
_STACK_BASE = {stack_base:#010x}
_STACK_SIZE = {stack_size:#010x}
_ENDIAN     = "{endian}"
_KEYLEN     = {keylen}

def keyfn(seed: int) -> int:
    \"\"\"Emulated SecurityAccess 0x27 key derivation.
    
    Verified: seed=0x{vseed:08X} → key=0x{vkey:08X}
    \"\"\"
    mu = Uc({UC_ARCH}, {UC_MODE})
    mu.mem_map(_MAP_BASE, _MAP_SIZE)
    mu.mem_write(_BASE, _CODE)
    mu.mem_map(_STACK_BASE, _STACK_SIZE)
    mu.reg_write({sp_reg_const}, _STACK_BASE + _STACK_SIZE - 8)
    mu.reg_write(_SEED_REG, seed & 0xFFFFFFFF)
    try:
        mu.emu_start(_START, _STOP, timeout=10_000_000)
    except UcError:
        pass
    raw = mu.reg_read(_KEY_REG)
    return raw & _KEY_MASK
"""


def _wrap_b64(data: bytes, width: int = 72) -> str:
    s = base64.b64encode(data).decode()
    lines = [s[i:i + width] for i in range(0, len(s), width)]
    return "\n".join(f"    {line!r}" for line in lines)


def _arch_uc_names(arch_str: str, bits: int) -> tuple[str, str]:
    """Return (UC_ARCH_XXX_name, UC_MODE_XXX_name) strings for generated code."""
    from unicorn import (
        UC_ARCH_ARM, UC_ARCH_ARM64, UC_ARCH_X86, UC_ARCH_PPC, UC_ARCH_MIPS,
        UC_MODE_ARM, UC_MODE_THUMB, UC_MODE_32, UC_MODE_64,
        UC_MODE_MIPS32, UC_MODE_BIG_ENDIAN,
    )
    arch_names = {
        UC_ARCH_ARM:   "UC_ARCH_ARM",
        UC_ARCH_ARM64: "UC_ARCH_ARM64",
        UC_ARCH_X86:   "UC_ARCH_X86",
        UC_ARCH_PPC:   "UC_ARCH_PPC",
        UC_ARCH_MIPS:  "UC_ARCH_MIPS",
    }
    mode_names = {
        UC_MODE_ARM:                           "UC_MODE_ARM",
        UC_MODE_THUMB:                         "UC_MODE_THUMB",
        UC_MODE_32:                            "UC_MODE_32",
        UC_MODE_64:                            "UC_MODE_64",
        UC_MODE_MIPS32:                        "UC_MODE_MIPS32",
        UC_MODE_32 | UC_MODE_BIG_ENDIAN:       "UC_MODE_32 | UC_MODE_BIG_ENDIAN",
    }
    uc_arch, uc_mode = _parse_arch(arch_str, bits)
    return arch_names[uc_arch], mode_names[uc_mode]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    inp = json.load(sys.stdin)

    arch_str  = str(inp.get("arch", "arm"))
    bits      = int(inp.get("bits", 32))
    base      = int(inp.get("base", 0))
    offset    = int(inp.get("offset", 0))
    size      = inp.get("size")
    start     = int(inp.get("start", base))
    stop      = int(inp.get("stop", base))
    seed_reg  = str(inp.get("seedReg", "r0"))
    key_reg   = str(inp.get("keyReg", "r1"))
    keylen    = int(inp.get("keylen", 4))
    endian    = str(inp.get("endian", "little"))

    raw_bytes = base64.b64decode(inp["fileB64"])
    if size is not None:
        snippet = raw_bytes[offset: offset + int(size)]
    else:
        snippet = raw_bytes[offset:]

    reg_map = _reg_map(arch_str, bits)
    if seed_reg not in reg_map:
        raise ValueError(f"unknown seedReg {seed_reg!r} for {arch_str}/{bits}")
    if key_reg not in reg_map:
        raise ValueError(f"unknown keyReg {key_reg!r} for {arch_str}/{bits}")

    seed_reg_id = reg_map[seed_reg]
    key_reg_id  = reg_map[key_reg]
    sp_reg_id   = _sp_reg(arch_str, bits)

    key_mask = (1 << (keylen * 8)) - 1

    # Verify with a sample seed.
    verify_seed = 0x1234_5678 & key_mask
    mu, _sp = _run_emulation(snippet, arch_str, bits, base, start, stop,
                              seed_reg_id, verify_seed)
    verify_key = mu.reg_read(key_reg_id) & key_mask

    # Compute mapped size for generated code.
    map_base = base & ~(PAGE - 1)
    map_size = _page_align_up(base + len(snippet)) - map_base
    map_size = max(map_size, PAGE)
    stack_base = STACK_BASE
    if map_base <= stack_base < map_base + map_size:
        stack_base = _page_align_up(map_base + map_size)

    uc_arch_name, uc_mode_name = _arch_uc_names(arch_str, bits)

    keyfn_code = _KEYFN_TEMPLATE.format(
        arch=arch_str,
        bits=bits,
        endian=endian,
        base=base,
        offset=offset,
        start=start,
        stop=stop,
        seedReg=seed_reg,
        keyReg=key_reg,
        keylen=keylen,
        vseed=verify_seed,
        vkey=verify_key,
        UC_ARCH=uc_arch_name,
        UC_MODE=uc_mode_name,
        code_b64_wrapped=_wrap_b64(snippet),
        map_size=map_size,
        seed_reg_const=seed_reg_id,
        key_reg_const=key_reg_id,
        sp_reg_const=sp_reg_id,
        key_mask=key_mask,
        stack_base=stack_base,
        stack_size=STACK_SIZE,
    )

    json.dump({
        "ok": True,
        "keyfnCode": keyfn_code,
        "verifiedVector": {"seed": verify_seed, "key": verify_key},
    }, sys.stdout)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        json.dump({"ok": False, "error": str(exc),
                   "trace": traceback.format_exc()}, sys.stdout)
        sys.exit(1)
