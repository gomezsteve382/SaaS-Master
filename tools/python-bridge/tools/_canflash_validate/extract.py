"""Pull T8/T16 tables and constants from each unlock DLL by lightweight disasm."""
import os, re, pefile, capstone

md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32)
DLL_DIR = os.path.join(os.path.dirname(__file__), '..', 'canflash_unlocks')

def disasm(name, max_bytes=0x500):
    pe = pefile.PE(os.path.join(DLL_DIR, name + '.dll'))
    base = pe.OPTIONAL_HEADER.ImageBase
    syms = {(s.name.decode() if s.name else ''): s.address
            for s in pe.DIRECTORY_ENTRY_EXPORT.symbols}
    rva = syms['unlock']
    text = next(s for s in pe.sections if s.Name.startswith(b'.text'))
    code = text.get_data()[rva - text.VirtualAddress:rva - text.VirtualAddress + max_bytes]
    out = []
    for ins in md.disasm(code, base + rva):
        out.append(ins)
        if ins.mnemonic == 'ret':
            break
    return out

def extract_t8(name):
    """Return 8 contiguous mov word ptr [esp+N], imm16 — the T8 table."""
    entries = {}
    for ins in disasm(name):
        if ins.mnemonic == 'mov' and 'word ptr' in ins.op_str and '[esp' in ins.op_str:
            m = re.match(r'word ptr \[esp(?: \+ (0x[0-9a-f]+|\d+))?\], (0x[0-9a-f]+|\d+)', ins.op_str)
            if m:
                off = int(m.group(1), 0) if m.group(1) else 0
                val = int(m.group(2), 0)
                if val <= 0xFFFF:
                    entries[off] = val
    offsets = sorted(entries)
    for i in range(len(offsets) - 7):
        if all(offsets[i+k+1] - offsets[i+k] == 2 for k in range(7)):
            return [entries[offsets[i+k]] for k in range(8)]
    return None

def extract_t16_word(name):
    entries = {}
    for ins in disasm(name):
        if ins.mnemonic == 'mov' and 'word ptr' in ins.op_str and '[esp' in ins.op_str:
            m = re.match(r'word ptr \[esp(?: \+ (0x[0-9a-f]+|\d+))?\], (0x[0-9a-f]+|\d+)', ins.op_str)
            if m:
                off = int(m.group(1), 0) if m.group(1) else 0
                val = int(m.group(2), 0)
                if val <= 0xFFFF:
                    entries[off] = val
    offsets = sorted(entries)
    for i in range(len(offsets) - 15):
        if all(offsets[i+k+1] - offsets[i+k] == 2 for k in range(15)):
            return [entries[offsets[i+k]] for k in range(16)]
    return None

def extract_t16_dword(name):
    entries = {}
    for ins in disasm(name):
        if ins.mnemonic == 'mov' and 'dword ptr' in ins.op_str and '[esp' in ins.op_str:
            m = re.match(r'dword ptr \[esp(?: \+ (0x[0-9a-f]+|\d+))?\], (0x[0-9a-f]+|\d+)', ins.op_str)
            if m:
                off = int(m.group(1), 0) if m.group(1) else 0
                val = int(m.group(2), 0)
                if val > 0xFF:
                    entries[off] = val
    offsets = sorted(entries)
    for i in range(len(offsets) - 15):
        if all(offsets[i+k+1] - offsets[i+k] == 4 for k in range(15)):
            return [entries[offsets[i+k]] for k in range(16)]
    return None
