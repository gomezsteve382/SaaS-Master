#!/usr/bin/env python3
"""emulate.py — general-purpose firmware snippet emulator.

Reads one JSON object from stdin, writes one JSON object to stdout.

Input fields
------------
fileB64   : str   base64-encoded firmware bytes
arch      : str   "arm" | "thumb" | "arm64" | "x86" | "ppc" | "mips"
bits      : int   32 or 64
base      : int   load address (VA) of fileB64
offset    : int   byte offset into fileB64 (default 0)
size      : int   bytes to map (null → rest of file from offset)
start     : int   emulation start VA
stop      : int   emulation stop VA
regs      : obj   {name: value} initial register state (optional)
dump      : obj   {"<hex_addr>": <byte_count>} memory regions to dump (optional)
timeout   : int   emulation timeout in microseconds (default 10_000_000)

Output fields
-------------
ok      : bool
regs    : {name: hex_value}   full register state after emulation
dumps   : {"<hex_addr>": "<hex_bytes>"}  requested memory regions
steps   : int                            approximate instruction count
error   : str   (only when ok=false)
"""

from __future__ import annotations

import base64
import json
import sys
import traceback

PAGE = 0x1000
STACK_BASE = 0xBEEF_0000
STACK_SIZE = 0x4000
DEFAULT_TIMEOUT_US = 10_000_000


# ---------------------------------------------------------------------------
# Re-use helpers from makekeyfn.py (same package — flat import).
# ---------------------------------------------------------------------------

def _page_align_up(v: int) -> int:
    return (v + PAGE - 1) & ~(PAGE - 1)


def _parse_arch(arch_str: str, bits: int):
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
    """Return {name: unicorn_const} for all named registers in the given arch."""
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


def _sp_name(arch_str: str, bits: int) -> str:
    for cand in ("sp", "r13", "esp", "rsp", "r1"):
        if cand in _reg_map(arch_str, bits):
            return cand
    raise RuntimeError(f"cannot find SP for {arch_str}/{bits}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    inp = json.load(sys.stdin)

    arch_str = str(inp.get("arch", "arm"))
    bits     = int(inp.get("bits", 32))
    base     = int(inp.get("base", 0))
    offset   = int(inp.get("offset", 0))
    size     = inp.get("size")
    start    = int(inp.get("start", base))
    stop     = int(inp.get("stop", base))
    timeout  = int(inp.get("timeout", DEFAULT_TIMEOUT_US))
    init_regs: dict = inp.get("regs") or {}
    dump_req: dict  = inp.get("dump") or {}

    from unicorn import Uc, UcError

    raw_bytes = base64.b64decode(inp["fileB64"])
    if size is not None:
        snippet = raw_bytes[offset: offset + int(size)]
    else:
        snippet = raw_bytes[offset:]

    uc_arch, uc_mode = _parse_arch(arch_str, bits)
    reg_map = _reg_map(arch_str, bits)

    mu = Uc(uc_arch, uc_mode)

    # Map firmware.
    map_base = base & ~(PAGE - 1)
    map_size = _page_align_up(base + len(snippet)) - map_base
    map_size = max(map_size, PAGE)
    mu.mem_map(map_base, map_size)
    mu.mem_write(base, snippet)

    # Map stack (collision-safe).
    stack_base = STACK_BASE
    if map_base <= stack_base < map_base + map_size:
        stack_base = _page_align_up(map_base + map_size)
    mu.mem_map(stack_base, STACK_SIZE)

    # Map any extra regions required by the dump request.
    dump_regions: list[tuple[int, int]] = []
    for addr_str, byte_count in dump_req.items():
        addr = int(addr_str, 16) if addr_str.startswith("0x") else int(addr_str, 16)
        count = int(byte_count)
        r_base = addr & ~(PAGE - 1)
        r_size = _page_align_up(addr + count) - r_base
        r_size = max(r_size, PAGE)
        # Only map if not already covered.
        try:
            mu.mem_map(r_base, r_size)
        except UcError:
            pass
        dump_regions.append((addr, count))

    # Set SP.
    sp_name = _sp_name(arch_str, bits)
    sp_val = stack_base + STACK_SIZE - 8
    mu.reg_write(reg_map[sp_name], sp_val)

    # Apply caller-supplied register initial state.
    for name, value in init_regs.items():
        name_l = name.lower()
        if name_l not in reg_map:
            raise ValueError(f"unknown register {name!r} for {arch_str}/{bits}")
        mu.reg_write(reg_map[name_l], int(value) & 0xFFFF_FFFF_FFFF_FFFF)

    # Instruction counter hook.
    insn_count = [0]
    def hook_code(_mu, _addr, _size, _user):
        insn_count[0] += 1

    mu.hook_add(4, hook_code)  # UC_HOOK_CODE = 4

    try:
        mu.emu_start(start, stop, timeout=timeout)
    except UcError:
        pass

    # Read all named registers.
    out_regs: dict[str, str] = {}
    for name, const in reg_map.items():
        try:
            val = mu.reg_read(const)
            out_regs[name] = f"0x{val:016x}"
        except UcError:
            out_regs[name] = "error"

    # Read requested memory dumps.
    out_dumps: dict[str, str] = {}
    for addr, count in dump_regions:
        try:
            data = bytes(mu.mem_read(addr, count))
            out_dumps[hex(addr)] = data.hex()
        except UcError:
            out_dumps[hex(addr)] = "error"

    json.dump({
        "ok":    True,
        "regs":  out_regs,
        "dumps": out_dumps,
        "steps": insn_count[0],
    }, sys.stdout)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        json.dump({"ok": False, "error": str(exc),
                   "trace": traceback.format_exc()}, sys.stdout)
        sys.exit(1)
