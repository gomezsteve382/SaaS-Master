"""Unicorn-based emulator for the canflash_unlocks/*.dll PE32 modules.

Maps the .text section, plus a writable stack and TLS/global page (so that
TLS-style accesses such as `mov eax, dword ptr [0x1000803c]` succeed). Pushes
arguments and calls `unlock`, returning EAX.
"""
import os, pefile
from unicorn import Uc, UC_ARCH_X86, UC_MODE_32
from unicorn.x86_const import UC_X86_REG_ESP, UC_X86_REG_EAX, UC_X86_REG_EIP

DLL_DIR = os.path.join(os.path.dirname(__file__), '..', 'canflash_unlocks')

_pe_cache = {}

def _load(name):
    if name in _pe_cache: return _pe_cache[name]
    path = os.path.join(DLL_DIR, name + '.dll')
    pe = pefile.PE(path)
    base = pe.OPTIONAL_HEADER.ImageBase
    syms = {(s.name.decode() if s.name else ''): s.address for s in pe.DIRECTORY_ENTRY_EXPORT.symbols}
    text = next(s for s in pe.sections if s.Name.startswith(b'.text'))
    code = bytes(text.get_data())
    code_va = base + text.VirtualAddress
    _pe_cache[name] = (code, code_va, syms, base)
    return _pe_cache[name]

def has_export(name, sym):
    try:
        _, _, syms, _ = _load(name)
        return sym in syms
    except Exception:
        return False

def emu(name, *args):
    code, code_va, syms, image_base = _load(name)
    if 'unlock' not in syms:
        raise RuntimeError(f'no unlock export in {name}')
    rva = syms['unlock']
    entry = image_base + rva

    mu = Uc(UC_ARCH_X86, UC_MODE_32)
    code_base = code_va & ~0xFFF
    code_size = ((len(code) + (code_va - code_base) + 0xFFF) & ~0xFFF)
    mu.mem_map(code_base, code_size)
    mu.mem_write(code_va, code)

    # Writable globals + TLS page (covers the typical canary at 0x1000803C).
    glob_base = (image_base + 0x8000) & ~0xFFF
    if glob_base != code_base:
        mu.mem_map(glob_base, 0x2000)
        mu.mem_write(glob_base, b'\xCD' * 0x2000)

    # Stack
    stack_base = 0x70000000
    mu.mem_map(stack_base, 0x10000)
    esp = stack_base + 0x8000
    # Caller frame: return address (we'll halt there) + args
    halt = 0x1000
    mu.mem_map(halt & ~0xFFF, 0x1000, perms=5)  # exec
    mu.mem_write(halt, b'\xF4')  # hlt — will trap if reached
    # Push args, then return address
    frame = b''
    for a in args:
        frame += int(a & 0xFFFFFFFF).to_bytes(4, 'little')
    esp -= (len(frame) + 4)
    mu.mem_write(esp, halt.to_bytes(4, 'little') + frame)
    mu.reg_write(UC_X86_REG_ESP, esp)
    try:
        # Run until we hit the return-to-halt or get an instruction count cap
        mu.emu_start(entry, halt, count=20000)
    except Exception:
        pass
    return mu.reg_read(UC_X86_REG_EAX) & 0xFFFFFFFF
