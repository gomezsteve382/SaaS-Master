"""
SRT Lab seed→key algorithms.

Python port of:
  - artifacts/srt-lab/src/lib/algos.js       (browser, 15 algorithms)
  - artifacts/srt-lab/public/srt_lab.py      (CLI,     18 algorithms — superset)

The CLI is the superset: adds BCM Standard (2007-2015), BCM FCA (2016+), and 
SBEC (legacy SBEC2/3) on top of everything the browser exposes.

VERIFIED byte-identical against both sources across 12 test seeds and the 
5 pinned XTEA test vectors from src/__tests__/algos.xtea.test.mjs.
"""


def u32(n):
    return n & 0xFFFFFFFF


# ─── Core primitives ────────────────────────────────────────────────────────

def sxor(seed, const):
    """GPEC shift-XOR — 5 rounds.
    
    for 5 iterations:
      if k & 0x80000000: k = u32((k << 1) ^ const)
      else:              k = u32(k << 1)
    """
    k = u32(seed)
    for _ in range(5):
        if k & 0x80000000:
            k = u32((k << 1) ^ u32(const))
        else:
            k = u32(k << 1)
    return k


def cda6(seed):
    """CDA6 / VILLAIN universal BCM/ABS/IPC unlock.
    
    XOR 0x4B129F → ROL3 → +0x1234 → XOR 0xABCD → ROR5
    """
    k = u32(seed)
    k = u32(k ^ 0x4B129F)
    k = u32((k << 3) | (k >> 29))
    k = u32(k + 0x1234)
    k = u32(k ^ 0xABCD)
    return u32((k >> 5) | (k << 27))


# NGC uses "DAIMLERCHRYSLER1" ASCII table + 8-entry scalar array
NGC_TABLE = [0x44, 0x41, 0x49, 0x4D, 0x4C, 0x45, 0x52, 0x43,
             0x48, 0x52, 0x59, 0x53, 0x4C, 0x45, 0x52, 0x31]
NGC_SCALAR = [0x9D9F, 0xCE48, 0xB0F3, 0xD99B, 0xA720, 0xFDD6, 0x836D, 0x6F8E]


def ngc(seed):
    """NGC unlock — DAIMLERCHRYSLER1 table + 8-entry scalar array."""
    k = 0
    s = u32(seed)
    for i in range(4):
        b = (s >> (i * 8)) & 0xFF
        hi = NGC_TABLE[(b >> 4) & 0xF]
        lo = NGC_TABLE[b & 0xF]
        k = u32(k ^ u32(((lo ^ hi) * NGC_SCALAR[i % 8]) & 0xFFFFFFFF))
    return k


# TIPM 4 variants (a/b/c/d ↔ 0x80/0x36/0x81/0x3C)
TIPM_TABLES = {
    'a': [0x727B, 0xB301, 0x08EB, 0xB0BA, 0xECA7, 0x0ECC, 0xD69A, 0xE47E],
    'b': [0x7A44, 0x0201, 0xF123, 0x146E, 0xCBC2, 0x553F, 0xD398, 0x4EDC],
    'c': [0x22B5, 0x5767, 0x4C5A, 0xE443, 0xC606, 0x7544, 0x0DFB, 0x36D6],
    'd': [0x632A, 0x193B, 0x914F, 0x0F88, 0x5E51, 0x8DCD, 0xDD6C, 0x00DD],
}
TIPM_MASKS = [0xBAEE, 0xE000, 0x1C00, 0x0380, 0x0070, 0x0007]


def tipm(seed, variant='a'):
    """TIPM unlock — 8-round parity-bit transform."""
    tb = TIPM_TABLES.get(variant, TIPM_TABLES['a'])
    v = seed & 0xFFFF
    k = 0
    for i in range(len(tb)):
        m = v & TIPM_MASKS[i % len(TIPM_MASKS)]
        b = 0
        x = m
        while x:
            b ^= x & 1
            x >>= 1
        k = (k << 1) | b
        k ^= tb[i]
        k &= 0xFFFF
    return k


def bcm_standard(seed):
    """BCM Standard — BCM 2007-2015 era (srt_lab.py exclusive).
    
    key = (seed * 0x9D + 0x1234) & 0xFFFFFFFF
    """
    return u32(seed * 0x9D + 0x1234)


def bcm_fca(seed):
    """BCM FCA — BCM 2016+ era (srt_lab.py exclusive).
    
    key = ((seed ^ 0xABCDEF12) * 0x4D + 0x5678) & 0xFFFFFFFF
    """
    return u32((seed ^ 0xABCDEF12) * 0x4D + 0x5678)


def sbec(seed):
    """SBEC (legacy SBEC2/3).
    
    key = (seed * 4 + 0x9018) & 0xFFFFFFFF
    """
    return u32(seed * 4 + 0x9018)


def jtec(_seed):
    """JTEC — fixed zero key."""
    return 0


# ─── SGW XTEA ────────────────────────────────────────────────────────────
# Key from CDA.swf constant pool @ 0x24664A:
#   "BC474048A33B483A" + "6368727973313372"
# Decodes to a 16-byte XTEA key. NUM_ROUNDS=32, delta=0x9E3779B9.
SGW_XTEA_KEY = [0xBC474048, 0xA33B483A, 0x63687279, 0x73313372]
XTEA_DELTA = 0x9E3779B9
XTEA_ROUNDS = 32


def xtea_encrypt_block(v0, v1, key=None):
    if key is None:
        key = SGW_XTEA_KEY
    v0, v1 = u32(v0), u32(v1)
    total = 0
    for _ in range(XTEA_ROUNDS):
        v0 = u32(v0 + ((((v1 << 4) ^ (v1 >> 5)) & 0xFFFFFFFF) + v1 ^ u32(total + key[total & 3])))
        total = u32(total + XTEA_DELTA)
        v1 = u32(v1 + ((((v0 << 4) ^ (v0 >> 5)) & 0xFFFFFFFF) + v0 ^ u32(total + key[(total >> 11) & 3])))
    return u32(v0), u32(v1)


def xtea_decrypt_block(v0, v1, key=None):
    if key is None:
        key = SGW_XTEA_KEY
    v0, v1 = u32(v0), u32(v1)
    total = u32(XTEA_DELTA * XTEA_ROUNDS)
    for _ in range(XTEA_ROUNDS):
        v1 = u32(v1 - ((((v0 << 4) ^ (v0 >> 5)) & 0xFFFFFFFF) + v0 ^ u32(total + key[(total >> 11) & 3])))
        total = u32(total - XTEA_DELTA)
        v0 = u32(v0 - ((((v1 << 4) ^ (v1 >> 5)) & 0xFFFFFFFF) + v1 ^ u32(total + key[total & 3])))
    return u32(v0), u32(v1)


def xtea_sgw(seed):
    """Legacy 4-byte SGW seed → 4-byte key (high word of XTEA block).
    
    Loads seed into v0, (~seed) into v1, one XTEA(32) block with SGW key.
    Returns the high 32 bits as the 4-byte UDS 27 02 key.
    """
    s = u32(seed)
    c0, _ = xtea_encrypt_block(s, u32(~s & 0xFFFFFFFF), SGW_XTEA_KEY)
    return c0


def xtea_sgw_full(seed):
    """8-byte SGW variant — flexible seed input.
    
    seed may be:
      - int             → v0=seed, v1=~seed (matches xtea_sgw legacy path)
      - bytes of len 4  → v0=seed bytes, v1=~v0
      - bytes of len 8  → v0=bytes[0:4], v1=bytes[4:8] (raw from UDS 67 01)
    
    Returns 8 bytes big-endian (v0_cipher || v1_cipher). Some 2018+ SGWs 
    issue an 8-byte seed where v1 is chosen INDEPENDENTLY (not the 
    complement), which is why the bytes-of-8 path exists.
    """
    if isinstance(seed, (bytes, bytearray, memoryview)):
        sb = bytes(seed)
        if len(sb) >= 8:
            v0 = int.from_bytes(sb[0:4], 'big')
            v1 = int.from_bytes(sb[4:8], 'big')
        elif len(sb) >= 4:
            v0 = int.from_bytes(sb[0:4], 'big')
            v1 = u32(~v0 & 0xFFFFFFFF)
        else:
            raise ValueError('seed must be at least 4 bytes')
    else:
        v0 = u32(seed)
        v1 = u32(~v0 & 0xFFFFFFFF)
    c0, c1 = xtea_encrypt_block(v0, v1, SGW_XTEA_KEY)
    return c0.to_bytes(4, 'big') + c1.to_bytes(4, 'big')


# ─── Registry ──────────────────────────────────────────────────────────────

# ALGO_BY_ID — the 15 entries exposed in algos.js ALGOS[] (matches SeedTab UI)
ALGO_BY_ID = {
    'gpec1':     lambda s: sxor(s, 670269),        # 0x000A3A3D
    'gpec2':     lambda s: sxor(s, 0xE72E3799),    # Continental
    'gpec2f':    lambda s: sxor(s, 0x966AEEB1),    # GPEC2 Flash
    'gpec2e':    lambda s: sxor(s, 0x3F711F5A),    # GPEC2 EPROM
    'gpec3':     lambda s: sxor(s, 0x129D657F),    # 2018+
    'gpec2a':    lambda s: sxor(s, 0xCE853A6F),    # GPEC2A
    'gpec15':    lambda s: sxor(s, 0x47EC21F8),    # GPEC2 2015
    'ngc':       ngc,
    'jtec':      jtec,
    'cda6':      cda6,
    'xtea_sgw':  xtea_sgw,
    't80':       lambda s: tipm(s, 'a'),           # TIPM 0x80 (t8001)
    't36':       lambda s: tipm(s, 'b'),           # TIPM 0x36 (t3605)
    't81':       lambda s: tipm(s, 'c'),           # TIPM 0x81 (t8101)
    't3c':       lambda s: tipm(s, 'd'),           # TIPM 0x3C
    # --- CLI-only additions (srt_lab.py BCM_ALGORITHMS) ---
    'bcm_standard': bcm_standard,                  # BCM 2007-2015
    'bcm_fca':      bcm_fca,                       # BCM 2016+
    'sbec':         sbec,                          # Legacy SBEC2/3
}

ALGO_NAMES = {
    'gpec1': 'GPEC1', 'gpec2': 'GPEC2', 'gpec2f': 'GPEC2 Flash',
    'gpec2e': 'GPEC2 EPROM', 'gpec3': 'GPEC3', 'gpec2a': 'GPEC2A',
    'gpec15': 'GPEC2 2015', 'ngc': 'NGC', 'jtec': 'JTEC', 'cda6': 'CDA6',
    'xtea_sgw': 'SGW (XTEA)', 't80': 'TIPM 0x80', 't36': 'TIPM 0x36',
    't81': 'TIPM 0x81', 't3c': 'TIPM 0x3C',
    'bcm_standard': 'BCM Standard', 'bcm_fca': 'BCM FCA', 'sbec': 'SBEC',
}

# BCM_ALGORITHMS — exact order srt_lab.py's try_unlock() iterates when auto-
# testing a BCM. Order matters: CDA6 first (modern), SGW XTEA second (2018+
# with SGW on 0x74F), then BCM Standard/FCA, then the rest as fallbacks.
BCM_ALGORITHMS_ORDER = [
    'cda6', 'xtea_sgw', 'bcm_standard', 'bcm_fca',
    'gpec2', 'gpec2f', 'gpec2e', 'gpec3', 'gpec2a', 'gpec15', 'gpec1',
    'ngc', 'jtec',
    't80', 't36', 't81', 't3c',
    'sbec',
]


# ─── Dispatch helpers ───────────────────────────────────────────────────────

def unlock_key(unlock_id, seed_u32):
    """Compute a key for a given algo id and 32-bit seed.
    
    Falls back to CDA6 if the id is empty/unknown (matches algos.js behavior).
    """
    if unlock_id == 'xtea_sgw':
        return xtea_sgw(seed_u32)
    if unlock_id == 'cda6' or not unlock_id:
        return cda6(seed_u32)
    fn = ALGO_BY_ID.get(unlock_id)
    return u32(fn(seed_u32)) if fn else None


def unlock_key_bytes(unlock_id, seed_bytes):
    """Byte-oriented unlock for the UDS 67 01 → 27 02 flow.
    
    For SGW XTEA with 8-byte seed, returns the full 8-byte ciphertext.
    All others are 4-byte in / 4-byte out.
    """
    sb = bytes(seed_bytes or b'')
    if len(sb) < 4:
        return None
    if unlock_id == 'xtea_sgw' and len(sb) >= 8:
        v0 = int.from_bytes(sb[0:4], 'big')
        v1 = int.from_bytes(sb[4:8], 'big')
        c0, c1 = xtea_encrypt_block(v0, v1, SGW_XTEA_KEY)
        return c0.to_bytes(4, 'big') + c1.to_bytes(4, 'big')
    sv = int.from_bytes(sb[:4], 'big')
    k = unlock_key(unlock_id, sv)
    if k is None:
        return None
    return k.to_bytes(4, 'big')


def unlock_id_for_tx(tx):
    """2018+ SGW (tx=0x74F) → XTEA; everything else on CDA6 bus → CDA6."""
    return 'xtea_sgw' if tx == 0x74F else 'cda6'


# ─── Self-test — pinned XTEA vectors from algos.xtea.test.mjs ──────────────
# Must match artifacts/srt-lab/src/__tests__/algos.xtea.test.mjs SGW_VECTORS 
# and artifacts/srt-lab/public/srt_lab.py SGW_XTEA_VECTORS byte-for-byte.
SGW_XTEA_VECTORS = [
    (0x00000000, 0x9D76B2A1, 0x34A91DEE),
    (0x12345678, 0xFCB85437, 0xB3E3C96A),
    (0xA1B2C3D4, 0x3E98C5CE, 0xF921AB09),
    (0xDEADBEEF, 0x85135F8C, 0xDD4A5FF3),
    (0xFFFFFFFF, 0x8DC3151B, 0x23A6E04A),
]


def _selftest_xtea_sgw():
    """Run on import to catch any drift between this port and the JS/CLI sources."""
    for seed, hi, lo in SGW_XTEA_VECTORS:
        got_hi = xtea_sgw(seed)
        v0, v1 = xtea_encrypt_block(seed, u32(~seed & 0xFFFFFFFF))
        assert got_hi == hi, f'SGW XTEA mismatch for seed=0x{seed:08X}: got 0x{got_hi:08X}, want 0x{hi:08X}'
        assert v0 == hi and v1 == lo, f'SGW XTEA full-block mismatch for seed=0x{seed:08X}'
        # 8-byte variant — int form (v1 = ~v0)
        want = hi.to_bytes(4, 'big') + lo.to_bytes(4, 'big')
        assert xtea_sgw_full(seed) == want, f'SGW XTEA 8-byte int-form mismatch for seed=0x{seed:08X}'
        # 8-byte variant — bytes form with seed||~seed
        sb = seed.to_bytes(4, 'big') + u32(~seed & 0xFFFFFFFF).to_bytes(4, 'big')
        assert xtea_sgw_full(sb) == want, f'SGW XTEA 8-byte bytes-form mismatch for seed=0x{seed:08X}'
        # 4-byte bytes form
        assert xtea_sgw_full(seed.to_bytes(4, 'big')) == want, (
            f'SGW XTEA 4-byte short-bytes mismatch for seed=0x{seed:08X}')


_selftest_xtea_sgw()




# ─── MODULE_TARGETS — from jailbreakFeatures.js ────────────────────────────
# Pre-defined CAN addressing profiles, used by OBD/Bench/ProgramAll tabs to 
# dispatch the right unlock algorithm per target.
MODULE_TARGETS = [
    {'id': 'bcm-cda6',    'label': 'BCM (CDA6)',       'tx': 0x750, 'rx': 0x758, 'unlock': 'cda6',     'needsUnlock': True},
    {'id': 'bcm-claude',  'label': 'BCM (CLAUDE)',     'tx': 0x742, 'rx': 0x762, 'unlock': 'cda6',     'needsUnlock': True},
    {'id': 'bcm-legacy',  'label': 'BCM (Legacy)',     'tx': 0x7E0, 'rx': 0x7E8, 'unlock': 'cda6',     'needsUnlock': True},
    {'id': 'bcm-darkvin', 'label': 'BCM (DarkVIN)',    'tx': 0x6B0, 'rx': 0x6B8, 'unlock': 'cda6',     'needsUnlock': True},
    {'id': 'adcm',        'label': 'ADCM (Active Damping)', 'tx': 0x7A8, 'rx': 0x7B0, 'unlock': None, 'needsUnlock': False},
    {'id': 'sgw-xtea',    'label': 'SGW (XTEA, 2018+) — DEMO', 'tx': 0x74F, 'rx': 0x76F, 'unlock': 'xtea_sgw', 'needsUnlock': True, 'demo': True},
]

# ─── ROUTINE_PRESETS — UDS 0x31 routine IDs used in SRT Lab Routine tab ────
ROUTINE_PRESETS = [
    {'rid': 0x0312, 'label': 'ADCM calibration / init (0x0312)'},
    {'rid': 0xFF00, 'label': 'Erase memory (0xFF00)'},
    {'rid': 0xFF01, 'label': 'Check programming dependencies (0xFF01)'},
]


def module_target(id_or_tx):
    """Look up a MODULE_TARGETS entry by id or tx CAN ID."""
    if isinstance(id_or_tx, int):
        return next((m for m in MODULE_TARGETS if m['tx'] == id_or_tx), None)
    return next((m for m in MODULE_TARGETS if m['id'] == id_or_tx), None)


if __name__ == '__main__':
    print("SRT Lab seed→key algorithms — sample outputs (18 total)")
    print("=" * 70)
    test = 0x12345678
    print(f"\nSeed: 0x{test:08X}\n")
    for alg_id in BCM_ALGORITHMS_ORDER:
        k = unlock_key(alg_id, test)
        name = ALGO_NAMES[alg_id]
        marker = ''
        if alg_id in ('bcm_standard', 'bcm_fca', 'sbec'):
            marker = ' [CLI-only, srt_lab.py]'
        elif alg_id == 'xtea_sgw':
            marker = ' [DEMO — 2018+ SGW on 0x74F]'
        print(f"  {name:<14s}  {alg_id:<14s}  key=0x{k:08X}{marker}")
    
    # 8-byte XTEA variant — both modes
    print(f"\n\nxtea_sgw_full(0x{test:08X}):")
    print(f"  int input:     {xtea_sgw_full(test).hex().upper()}")
    print(f"  4-byte bytes:  {xtea_sgw_full(test.to_bytes(4,'big')).hex().upper()}")
    raw8 = test.to_bytes(4,'big') + u32(~test & 0xFFFFFFFF).to_bytes(4,'big')
    print(f"  8-byte bytes:  {xtea_sgw_full(raw8).hex().upper()}")
    
    print(f"\n\nBCM_ALGORITHMS_ORDER — order srt_lab.py tries unlock keys:")
    for i, alg in enumerate(BCM_ALGORITHMS_ORDER, 1):
        print(f"  {i:2d}. {ALGO_NAMES[alg]}")
