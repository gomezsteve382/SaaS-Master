"""Extended fitters: T8 with bit-packed first lookup; T8 with arbitrary
'add'/'sub'/'xor' op-chain (for the bosch_*ddm/pdm family + pts + delphi);
T*seed for hvac/trw_hvac.
"""
import sys, os, random, itertools, json
sys.path.insert(0, os.path.dirname(__file__))
from emu import emu
from extract import extract_t8

def u16(x): return x & 0xFFFF
def ror16(v, n):
    v &= 0xFFFF; n &= 15
    return ((v >> n) | (v << (16 - n))) & 0xFFFF

random.seed(42)
SEEDS = [0, 1, 0xFFFF, 0x8000, 0x1234, 0xDEAD, 0xBEEF, 0xCAFE, 0xABCD] + \
        [random.randint(1, 0xFFFE) for _ in range(15)]

def sample(dll):
    return [(s, emu(dll, s) & 0xFFFF) for s in SEEDS]

# ─── T8 with bit-pack first index ─────────────────────────────────────────
def fit_t8_bitpack(dll):
    """First lookup uses an arbitrary 3-bit selection from seed, then up to 4
    more lookups with simple shifts."""
    table = extract_t8(dll)
    if table is None: return None
    samples = sample(dll)
    quick = samples[:6]
    SHIFT_RANGE = list(range(14))
    PERMS = list(itertools.permutations(range(3)))

    for n_extra in (4, 3, 2):
        n_lk = n_extra + 1
        base = (n_lk % 2) * table[0]
        C = (samples[0][1] ^ base) & 0xFFFF
        for shifts in itertools.combinations(SHIFT_RANGE, n_extra):
            for sxm in (1, 0):
                for bits in itertools.combinations(range(16), 3):
                    for perm in PERMS:
                        ok = True
                        for s, expected in quick:
                            idx0 = 0
                            for b, p in zip(bits, perm):
                                idx0 |= ((s >> b) & 1) << p
                            v = table[idx0]
                            for sh in shifts:
                                v ^= table[(s >> sh) & 7]
                            if sxm == 1: v ^= s
                            v ^= C
                            if (v & 0xFFFF) != expected:
                                ok = False; break
                        if not ok: continue
                        # full verify
                        ok = True
                        for s, expected in samples:
                            idx0 = 0
                            for b, p in zip(bits, perm):
                                idx0 |= ((s >> b) & 1) << p
                            v = table[idx0]
                            for sh in shifts:
                                v ^= table[(s >> sh) & 7]
                            if sxm == 1: v ^= s
                            v ^= C
                            if (v & 0xFFFF) != expected:
                                ok = False; break
                        if ok:
                            return {'kind': 't8_bitpack', 'bits': list(bits),
                                    'perm': list(perm), 'shifts': list(shifts),
                                    'C': C, 'seed_xor_mode': sxm,
                                    'table': list(table)}
    return None


# ─── T*seed: T[(s>>shift)&7] * s, returned as eax ──────────────────────────
def fit_t_mul_seed(dll):
    """`hvac`/`trw_hvac`/`trw_hvac_2`/`pts`(?) — multiply T[idx]*seed (16-bit)."""
    table = extract_t8(dll)
    if table is None: return None
    samples = sample(dll)
    for shift in range(0, 14):
        ok = True
        for s, expected in samples:
            v = (table[(s >> shift) & 7] * s) & 0xFFFF
            if v != expected:
                ok = False; break
        if ok: return {'kind': 't_mul_seed', 'shift': shift, 'table': list(table)}
    return None


# ─── T8 op-chain (sub/add/xor mixed, for bosch family etc.) ───────────────
def fit_t8_opchain(dll, n_ops=5):
    """unlock = ((((seed OP1 T[(s>>sh1)&7]) OP2 const) OP3 T[(s>>sh2)&7]) ...)
    Specifically the bosch_*ddm pattern:
        v = s
        v = (v - T[(s>>3)&7]) ; v = (v +/- K) ; v ^= T[(s>>12)&7]
        v -= T[s&7] ; v += T[(s>>8)&7]
    Try fixed pattern: shifts (3, 12, 0, 8) ops (sub, K_op, xor, sub, add).
    """
    table = extract_t8(dll)
    if table is None: return None
    samples = sample(dll)
    SHIFTS = (3, 12, 0, 8)
    OPS = ('sub', 'xor', 'sub', 'add')  # ops applied between K-step and end
    # K is added/subtracted between first sub and the xor: v ± K
    for K_op in ('+', '-'):
        # Solve K from one sample (s=0 → all T[0])
        s0_v = samples[0][1]
        # for s=0: v starts at 0, all idx are 0, so:
        # v = 0 - T[0]            (sub)
        # v = v ±K                (K_op)
        # v ^= T[0]               (xor)
        # v -= T[0]               (sub)
        # v += T[0]               (add)
        # → final = ((((-T[0]) ±K) ^ T[0]) - T[0]) + T[0] = ((-T[0]) ±K) ^ T[0]
        T0 = table[0]
        # final(s=0) = ((-T0) ±K) ^ T0  →  K = ±((target ^ T0) - (-T0))
        target = s0_v
        # ((-T0) + K) ^ T0 = target  → K = (target ^ T0) - (-T0) = (target ^ T0) + T0
        # ((-T0) - K) ^ T0 = target  → K = -T0 - (target ^ T0) = -((target ^ T0) + T0)
        if K_op == '+': K = ((target ^ T0) + T0) & 0xFFFF
        else:           K = (-((target ^ T0) + T0)) & 0xFFFF
        ok = True
        for s, expected in samples:
            v = s & 0xFFFF
            v = (v - table[(s >> 3) & 7]) & 0xFFFF
            v = (v + K if K_op == '+' else v - K) & 0xFFFF
            v ^= table[(s >> 12) & 7]
            v = (v - table[s & 7]) & 0xFFFF
            v = (v + table[(s >> 8) & 7]) & 0xFFFF
            if (v & 0xFFFF) != expected:
                ok = False; break
        if ok:
            return {'kind': 't8_bosch_chain', 'K': K, 'K_op': K_op, 'table': list(table)}
    return None


# ─── pts: similar to bosch but with ROTATED seed and signed K ───
def fit_pts_chain(dll):
    """pts.dll: rotates seed first, then does add/xor/sub chain.
    Pattern (from disasm): rotate seed >> 1, ... — try a few variations.
    """
    table = extract_t8(dll)
    if table is None: return None
    samples = sample(dll)
    SHIFTS_OPTIONS = [(3, 12, 0, 8), (0, 12, 3, 8), (12, 3, 8, 0)]
    # Closed-form K solving like the bosch chain.
    for R in range(16):
        for sh in SHIFTS_OPTIONS:
            for K_op in ('+', '-'):
                T0 = table[0]
                target = samples[0][1]
                if K_op == '+': K = ((target ^ T0) + T0) & 0xFFFF
                else:           K = (-((target ^ T0) + T0)) & 0xFFFF
                ok = True
                for s, expected in samples:
                    sr = ror16(s, R)
                    v = sr
                    v = (v - table[(sr >> sh[0]) & 7]) & 0xFFFF
                    v = (v + K if K_op == '+' else v - K) & 0xFFFF
                    v ^= table[(sr >> sh[1]) & 7]
                    v = (v - table[(sr >> sh[2]) & 7]) & 0xFFFF
                    v = (v + table[(sr >> sh[3]) & 7]) & 0xFFFF
                    if (v & 0xFFFF) != expected:
                        ok = False; break
                if ok:
                    return {'kind': 't8_pts_chain', 'R': R, 'shifts': list(sh),
                            'K': K, 'K_op': K_op, 'table': list(table)}
    return None

EXTRA = [fit_t_mul_seed, fit_t8_bitpack, fit_t8_opchain]

if __name__ == '__main__':
    DLLs = [
        'hvac', 'trw_hvac', 'trw_hvac_2', 'pts', 'pdm', 'ddm', 'fdcm', 'plgm',
        'yazaki_fcm', 'huntsville_fdcm', 'bosch_ddm', 'bosch_pdm', 'bosch_mddm',
        'bosch_mpdm', 'bosch_mwddm', 'bosch_mwpdm', 'bosch_cdm_win_ddm',
        'bosch_cdm_win_pdm', 'eom', 'cmtc',
    ]
    results = {}
    for d in DLLs:
        for f in EXTRA:
            try:
                r = f(d)
            except Exception as e:
                r = None
            if r:
                results[d] = r
                print(f'  ✓  {d:25s} → {r["kind"]}')
                break
        else:
            print(f'  —  {d:25s}')
    with open(os.path.join(os.path.dirname(__file__), 'extra_fits.json'), 'w') as f:
        json.dump(results, f, indent=2, default=str)
    print(f'\n  Extra: {len(results)}/{len(DLLs)}')
