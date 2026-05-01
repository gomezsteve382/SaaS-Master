"""Re-run fitters across all 81 DLLs and cache results to ./fits.json."""
import sys, os, random, itertools, json
sys.path.insert(0, os.path.dirname(__file__))
from emu import emu, has_export
from extract import extract_t8, extract_t16_dword, extract_t16_word

DLL_DIR = os.path.join(os.path.dirname(__file__), '..', 'canflash_unlocks')

def u32(x): return x & 0xFFFFFFFF
def u16(x): return x & 0xFFFF
def ror16(v, n):
    v &= 0xFFFF; n &= 15
    return ((v >> n) | (v << (16 - n))) & 0xFFFF

random.seed(42)
SEEDS_16 = [0, 1, 0xFFFF, 0x8000, 0x1234, 0xDEAD, 0xBEEF, 0xCAFE, 0xABCD] + \
           [random.randint(1, 0xFFFE) for _ in range(15)]
random.seed(42)
SEEDS_32 = [0, 1, 0xFFFFFFFF, 0x80000000, 0x12345678, 0xDEADBEEF, 0xCAFEBABE,
            0x55555555, 0xAAAAAAAA] + \
           [random.randint(0, 0xFFFFFFFF) for _ in range(15)]

def sample(dll, seeds, two_arg=False):
    out = []
    for s in seeds:
        out.append((s, emu(dll, s, 0)) if two_arg else (s, emu(dll, s)))
    return out

# ─── Fitter implementations ────────────────────────────────────────────────

def fit_t8_xor(dll):
    table = extract_t8(dll)
    if table is None: return None
    samples = [(s, k & 0xFFFF) for s, k in sample(dll, SEEDS_16)]
    SHIFT_RANGE = list(range(14))
    for R in range(16):
        for n_lookups in (5, 4, 3, 2):
            for sxm in (1, 2, 0):
                base = (n_lookups % 2) * table[0]
                C = (samples[0][1] ^ base) & 0xFFFF
                for shifts in itertools.combinations(SHIFT_RANGE, n_lookups):
                    ok = True
                    for s, expected in samples:
                        sr = ror16(s, R)
                        v = 0
                        for sh in shifts: v ^= table[(sr >> sh) & 7]
                        if sxm == 1: v ^= s
                        elif sxm == 2: v ^= sr
                        v ^= C
                        if (v & 0xFFFF) != expected:
                            ok = False; break
                    if ok:
                        return {'kind': 't8_xor', 'R': R, 'shifts': list(shifts),
                                'C': C, 'seed_xor_mode': sxm,
                                'n_lookups': n_lookups, 'table': list(table)}
    return None

def fit_lcg_pair(dll):
    if not has_export(dll, 'unlock'): return None
    test_pairs = [(0, 0), (1, 0), (0, 1), (0x12345678, 0xDEADBEEF), (1, 2),
                  (0xFFFFFFFF, 0xFFFFFFFF), (0x55555555, 0xAAAAAAAA)]
    try:
        outputs = [u32(emu(dll, s, t)) for s, t in test_pairs]
    except: return None
    C = outputs[0]
    if u32(outputs[1] ^ outputs[0]) != u32(outputs[2] ^ outputs[0]): return None
    for A in [0x41C64E6D, 0x32A95B7F, 0x52D75F5C, 0x96, 0x13D, 0xDEECE66D,
              0x100AA539, 0x6071B5F6, 0xDEADBEEF, 0x45F49D5B, 0x5851F42D]:
        for B in [0x3039, 0x412B, 0x52D8, 0xB, 0xC, 0x12345, 1, 0]:
            if u32((A + B) ^ B) != u32(outputs[1] ^ C): continue
            ok = True
            for (s, t), expected in zip(test_pairs, outputs):
                if u32(u32(s * A + B) ^ u32(t * A + B) ^ C) != expected:
                    ok = False; break
            if not ok: continue
            random.seed(123)
            for _ in range(20):
                s = random.randint(0, 0xFFFFFFFF); t = random.randint(0, 0xFFFFFFFF)
                if u32(emu(dll, s, t)) != u32(u32(s * A + B) ^ u32(t * A + B) ^ C):
                    ok = False; break
            if ok: return {'kind': 'lcg_pair', 'A': A, 'B': B, 'C': C}
    return None

def fit_t16_gf2(dll):
    samples = [(s, k & 0xFFFF) for s, k in sample(dll, SEEDS_16)]
    f0 = samples[0][1]
    T = [u16(emu(dll, 1 << b) ^ f0) for b in range(16)]
    for s, expected in samples:
        v = f0
        for b in range(16):
            if s & (1 << b): v ^= T[b]
        if (v & 0xFFFF) != expected: return None
    return {'kind': 't16_gf2', 'C': f0, 'T': T}

def fit_cummins(dll):
    table = extract_t16_dword(dll)
    if not table: return None
    samples = sample(dll, SEEDS_32)
    for shift in [16, 17, 18, 19, 20, 21, 22, 23, 24, 12, 8, 4, 0]:
        for offsets in itertools.permutations(range(4)):
            base_xor = 0
            for o in offsets: base_xor ^= table[o]
            K = u32(samples[0][1] ^ base_xor)
            ok = True
            for s, expected in samples:
                idx = (s >> shift) & 15
                v = 0
                for o in offsets: v ^= table[(idx + o) & 15]
                v ^= u32(s + K)
                if u32(v) != u32(expected):
                    ok = False; break
            if ok:
                return {'kind': 'cummins_t16', 'shift': shift,
                        'offsets': list(offsets), 'K': K, 'T': table}
    return None

def fit_simple(dll):
    samples = sample(dll, SEEDS_32)
    for X in [0, 0x7368, 0x4375, 0x6E74, 0x6974]:
        for A in [1, 2, 0x32A95B7F, 0x41C64E6D, 0x52D75F5C, 0x5AA5A5A5,
                  0x52D9, 0xCAFE, 0x13D]:
            for B in [0, 1, 0x2A, 0x3039, 0x412B, 0x52D8, 0xCAFE,
                      0x9396, 0x52D3, 0x14E7, 0x35B3, 0x7E55]:
                for C in [0, 0x6974, 0x6E74, 0x4E2B, 0x58C2, 0x12345678,
                          0xF3DD1133, 0x6473, 0x80831279, 0xCAFE, 0x9396, 0xF000]:
                    ok = True
                    for s, expected in samples:
                        v = u32(((s ^ X) * A + B) ^ C)
                        if v != u32(expected):
                            ok = False; break
                    if ok:
                        return {'kind': 'simple', 'X': X, 'A': A, 'B': B, 'C': C}
    return None

def fit_imul_xor(dll):
    samples = sample(dll, SEEDS_32)
    for C in [0x5AA5A5A5, 0xA5A5A55A]:
        for A in [0x5AA5A5A5, 0xA5A5A55A]:
            ok = True
            for s, expected in samples:
                v = u32((s ^ C) * A)
                if v != u32(expected):
                    ok = False; break
            if ok: return {'kind': 'imul_xor', 'C': C, 'A': A}
    return None

FITTERS = [fit_t8_xor, fit_t16_gf2, fit_lcg_pair, fit_cummins, fit_imul_xor, fit_simple]

if __name__ == '__main__':
    dlls = sorted(d[:-4] for d in os.listdir(DLL_DIR) if d.endswith('.dll'))
    out = {}
    for d in dlls:
        try:
            res = None
            for f in FITTERS:
                try:
                    res = f(d)
                    if res: break
                except Exception:
                    continue
            out[d] = (res['kind'], res) if res else None
            print(f'  {"✓" if res else "—"}  {d:30s} {res["kind"] if res else "(unfit)"}')
        except Exception as e:
            out[d] = None
            print(f'  X  {d}: {e}')
    with open(os.path.join(os.path.dirname(__file__), 'fits.json'), 'w') as f:
        json.dump(out, f, indent=2, default=str)
    n_fit = sum(1 for v in out.values() if v)
    print(f'\nFit {n_fit}/{len(out)} DLLs')
