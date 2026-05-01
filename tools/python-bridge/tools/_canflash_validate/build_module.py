"""Build the consolidated canflash_seedkey.py from `fits.json` + hand-ports."""
import sys, os, json
sys.path.insert(0, os.path.dirname(__file__))

with open(os.path.join(os.path.dirname(__file__), 'fits.json')) as f:
    FITS = json.load(f)

# ─── Emitters ──────────────────────────────────────────────────────────────

def E_t8_xor(name, p):
    R, shifts, C, sxm, table = p['R'], p['shifts'], p['C'], p['seed_xor_mode'], p['table']
    out = [f'def unlock_{name}(seed):',
           f'    """T8-XOR; reversed from {name}.dll, validated against Unicorn."""',
           f'    T = {[hex(v) for v in table]}'.replace("'", ""),
           f'    s = seed & 0xFFFF']
    rotated = 's'
    if R != 0:
        out.append(f'    sr = ror16(s, {R})')
        rotated = 'sr'
    first = False
    for sh in shifts:
        idx = f'{rotated} & 7' if sh == 0 else f'({rotated} >> {sh}) & 7'
        op = '    v = ' if not first else '    v ^= '
        out.append(f'{op}T[{idx}]')
        first = True
    if sxm == 1: out.append('    v ^= s')
    elif sxm == 2: out.append(f'    v ^= {rotated}')
    if C: out.append(f'    v ^= 0x{C:04X}')
    out.append('    return v & 0xFFFF')
    return '\n'.join(out)

def E_lcg_pair(name, p):
    A, B, C = p['A'], p['B'], p['C']
    return (f'def unlock_{name}(seed_lo, seed_hi=0):\n'
            f'    """LCG-pair (32-bit, 2-arg); reversed from {name}.dll, validated against Unicorn."""\n'
            f'    A, B, C = 0x{A:X}, 0x{B:X}, 0x{C:X}\n'
            f'    return ((seed_lo * A + B) ^ (seed_hi * A + B) ^ C) & 0xFFFFFFFF')

def E_t16_gf2(name, p):
    T, C = p['T'], p['C']
    return (f'def unlock_{name}(seed):\n'
            f'    """T16 GF(2); reversed from {name}.dll, validated against Unicorn."""\n'
            f'    T = {[hex(v) for v in T]}'.replace("'", "") + '\n'
            f'    v = 0x{C:04X}\n'
            f'    s = seed & 0xFFFF\n'
            f'    for bit in range(16):\n'
            f'        if s & (1 << bit): v ^= T[bit]\n'
            f'    return v & 0xFFFF')

def E_cummins(name, p):
    shift, offsets, K, T = p['shift'], p['offsets'], p['K'], p['T']
    return (f'def unlock_{name}(seed):\n'
            f'    """Cummins T16 nibble; reversed from {name}.dll, validated against Unicorn."""\n'
            f'    T = {[hex(v) for v in T]}'.replace("'", "") + '\n'
            f'    OFFSETS = {offsets}\n'
            f'    s = seed & 0xFFFFFFFF\n'
            f'    idx = (s >> {shift}) & 0xF\n'
            f'    v = 0\n'
            f'    for o in OFFSETS: v ^= T[(idx + o) & 0xF]\n'
            f'    v ^= (s + 0x{K:08X}) & 0xFFFFFFFF\n'
            f'    return v & 0xFFFFFFFF')

def E_imul_xor(name, p):
    A, C = p['A'], p['C']
    return (f'def unlock_{name}(seed):\n'
            f'    """imul-xor; reversed from {name}.dll, validated against Unicorn."""\n'
            f'    return ((seed ^ 0x{C:08X}) * 0x{A:08X}) & 0xFFFFFFFF')

def E_simple(name, p):
    X, A, B, C = p['X'], p['A'], p['B'], p['C']
    return (f'def unlock_{name}(seed):\n'
            f'    """((s^X)*A+B)^C; reversed from {name}.dll, validated against Unicorn."""\n'
            f'    return ((((seed ^ 0x{X:X}) * 0x{A:X}) + 0x{B:X}) ^ 0x{C:X}) & 0xFFFFFFFF')

EMITTERS = {
    't8_xor': E_t8_xor, 'lcg_pair': E_lcg_pair, 't16_gf2': E_t16_gf2,
    'cummins_t16': E_cummins, 'imul_xor': E_imul_xor, 'simple': E_simple,
}

# DLLs already implemented manually inside canflash_seedkey.py — skip auto-emit.
EXISTING = {
    'huntsville_bcm', 'yazaki_fcm', 'motorola_tipm7', 'trw_abs', 'bosch_abs',
    'ngc_engine', 'ngc_transmission', 'venom_pcm', 'gpec', 'may_scofield_itm',
    'huntsville_radio', 'alpine_rak', 'wcm',
}

def build_auto():
    out = []
    for name in sorted(FITS):
        if name in EXISTING: continue
        fit = FITS[name]
        if not fit: continue
        kind, params = fit[0], fit[1]
        emit = EMITTERS.get(kind)
        if emit is None:
            out.append(f'# {name}: kind={kind} not emittable')
            continue
        out.append(emit(name, params))
    return out

if __name__ == '__main__':
    parts = build_auto()
    print('\n\n'.join(parts))
