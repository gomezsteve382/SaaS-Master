"""Run every applicable fitter on every DLL, build combined fits.json."""
import sys, os, json, time
sys.path.insert(0, os.path.dirname(__file__))
from emu import emu
import fit_all
import fit_extra

DLL_DIR = os.path.join(os.path.dirname(__file__), '..', 'canflash_unlocks')
DLLS = sorted(d[:-4] for d in os.listdir(DLL_DIR) if d.endswith('.dll'))

# Try fitters in order. First success wins.
ORDER = [
    fit_all.fit_t8_xor,
    fit_all.fit_t16_gf2,
    fit_all.fit_lcg_pair,
    fit_all.fit_cummins,
    fit_all.fit_imul_xor,
    fit_all.fit_simple,
    fit_extra.fit_t_mul_seed,
    fit_extra.fit_t8_bitpack,
    fit_extra.fit_t8_opchain,
    fit_extra.fit_pts_chain,
]

results = {}
for d in DLLS:
    t0 = time.time()
    fit = None
    for f in ORDER:
        try:
            r = f(d)
        except Exception:
            r = None
        if r:
            fit = r
            break
    elapsed = time.time() - t0
    results[d] = fit
    flag = '✓' if fit else '—'
    kind = fit['kind'] if fit else '(unfit)'
    print(f"  {flag}  {d:30s} {kind:18s} ({elapsed:.1f}s)")

n = sum(1 for v in results.values() if v)
print(f"\n  Total: {n}/{len(results)}")
with open(os.path.join(os.path.dirname(__file__), 'all_fits.json'), 'w') as f:
    json.dump(results, f, indent=2, default=str)
