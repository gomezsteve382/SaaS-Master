"""Compare candidate Python ports of unlock_* against Unicorn DLL emulation."""
import os, sys, random, importlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import srtlab_unlock_catalog as suc


def verify(dll_name, py_fn, n_seeds=64, seeds=None, two_arg=False):
    if seeds is None:
        rng = random.Random(0xC0FFEE ^ hash(dll_name))
        seeds = [rng.getrandbits(32) for _ in range(n_seeds)]
        seeds += [0, 1, 0xFFFFFFFF, 0xDEADBEEF, 0x12345678, 0x80000000]
    fails = []
    for s in seeds:
        if two_arg:
            s2 = s
            s1 = (s >> 32) & 0xFFFFFFFF if s > 0xFFFFFFFF else 0
            ref = suc.unlock(dll_name, s2, s1, prefer_native=False)
            got = py_fn(s2, s1)
        else:
            ref = suc.unlock(dll_name, s, prefer_native=False)
            got = py_fn(s)
        if ref != got:
            fails.append((s, ref, got))
    return fails


def report(dll_name, py_fn, **kw):
    fails = verify(dll_name, py_fn, **kw)
    if not fails:
        print(f'OK  {dll_name}: all seeds match')
        return True
    print(f'FAIL {dll_name}: {len(fails)} mismatches')
    for s, r, g in fails[:5]:
        if isinstance(s, tuple):
            print(f'  seed=({s[0]:08X},{s[1]:08X}) ref=0x{r:08X} got=0x{g:08X} xor=0x{r ^ g:08X}')
        else:
            print(f'  seed=0x{s:08X} ref=0x{r:08X} got=0x{g:08X} xor=0x{r ^ g:08X}')
    return False
