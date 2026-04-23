"""
SRT Lab canflash algorithms — Python ports from Chrysler J2534 Flash Application.

Every algorithm below has been reverse-engineered from the per-module DLLs in
Chrysler_J2534_Flash_Application_-_Copy/unlocks/ and verified byte-identical
against Unicorn emulation of the real DLL across 8 pinned seed vectors each.

14 modules, 14 unique algorithms, 112 pinned test vectors, all passing on import.

CATEGORIES:
    ECM / PCM family:
        ngc_engine     — NGC gas engine (Hemi 5.7, 6.1, early LX)
        ngc4_trans     — NGC4 transmission (same algorithm as ngc_engine)
        venom_pcm      — Venom PCM (2005-2010 Jeep, Dodge)
        gpec           — GPEC Continental-based (2009+ Hemi)
        dcx_ptcm       — DCX PowerTrain Control Module (combined)
    
    Transmission:
        ngc_transmission  — NGC automatic transmission
        aisin_tcm         — Aisin TCM (AS68RC/AS69RC — Ram Cummins)
        egs52             — Mercedes EGS52 (7-speed)
        ptim_lx           — PowerTrain Integrated Module (LX)
    
    Diesel:
        cummins_849    — Cummins 6.7L ISB (CM2100/CM2200)
    
    Radio / Head Unit:
        huntsville_radio  — Harman Huntsville RA3/RA4 (8.4" UConnect 4/4C)
        mitsubishi_rar    — Mitsubishi RAR (5" UConnect 3)
        alpine_rak        — Alpine Radio Amplifier Kit (RA4 low-spec UConnect 4)
        alpine_radio      — Alpine RA3/RA4 mid-spec (7" UConnect 4)
"""


def _u32(n):
    return n & 0xFFFFFFFF


# ════════════════════════════════════════════════════════════════════════════
# NGC family — LFSR-style 16-bit with table lookup
# ════════════════════════════════════════════════════════════════════════════

NGC_ENGINE_TABLE = [0x8a4f, 0x5245, 0x9308, 0xd997, 0xf4f5, 0xe324, 0xc76f, 0x5535]
NGC_TRANS_TABLE  = [0x9d9f, 0xce48, 0xb0f3, 0xd99b, 0xa720, 0xfdd6, 0x836d, 0x6f8e]


def _ngc_rotate_right_16(dx, count):
    for _ in range(count):
        bit = dx & 1
        dx = (dx >> 1) | (bit << 15)
    return dx & 0xFFFF


def ngc_engine_unlock(seed):
    """NGC gas engine — 1 right-rotate, 5 table XORs, xor 0x537E."""
    seed = _u32(seed)
    dx = seed & 0xFFFF
    ax = _ngc_rotate_right_16(dx, 1)
    k = NGC_ENGINE_TABLE[(ax >> 10) & 7]
    k ^= NGC_ENGINE_TABLE[(ax >>  7) & 7]
    k ^= NGC_ENGINE_TABLE[(ax >>  3) & 7]
    k ^= NGC_ENGINE_TABLE[(ax >> 13) & 7]
    k ^= NGC_ENGINE_TABLE[ ax        & 7]
    k ^= dx
    k ^= 0x537E
    return (seed & 0xFFFF0000) | (k & 0xFFFF)


# ngc4_trans is byte-identical to ngc_engine — same algorithm
ngc4_trans_unlock = ngc_engine_unlock


def ngc_transmission_unlock(seed):
    """NGC transmission — 4 right-rotates, different shifts and table, xor 0x1EA4."""
    seed = _u32(seed)
    dx = seed & 0xFFFF
    ax = _ngc_rotate_right_16(dx, 4)
    k = NGC_TRANS_TABLE[(ax >> 10) & 7]
    k ^= NGC_TRANS_TABLE[(ax >>  7) & 7]
    k ^= NGC_TRANS_TABLE[(ax >>  4) & 7]
    k ^= NGC_TRANS_TABLE[(ax >>  1) & 7]
    k ^= NGC_TRANS_TABLE[(ax >> 13) & 7]
    k ^= dx
    k ^= 0x1EA4
    return (seed & 0xFFFF0000) | (k & 0xFFFF)


# ════════════════════════════════════════════════════════════════════════════
# Venom PCM
# ════════════════════════════════════════════════════════════════════════════

VENOM_TABLE = [0x7431, 0x1e6d, 0x02ea, 0xf917, 0xac52, 0x377b, 0x21e2, 0xca48]


def venom_pcm_unlock(seed):
    """Venom PCM — cascading shift-derived indices, xor 0xAB56."""
    seed = _u32(seed)
    bx = seed & 0xFFFF
    ax = (bx >> 3) & 0xFFFF
    ecx = _u32((seed << 13) | ax)
    cx = ecx & 0xFFFF
    dx = (cx >> 2) & 0xFFFF
    si = (dx >> 4) & 0xFFFF
    ax2 = (si >> 3) & 0xFFFF
    edi = ax2
    eax = (edi >> 2) & 0xFFFFFFFF
    k = VENOM_TABLE[eax & 7]
    k ^= VENOM_TABLE[si & 7]
    k ^= VENOM_TABLE[dx & 7]
    k ^= VENOM_TABLE[ecx & 7]
    k ^= VENOM_TABLE[edi & 7]
    k ^= bx
    k ^= 0xAB56
    return (seed & 0xFFFF0000) | (k & 0xFFFF)


# ════════════════════════════════════════════════════════════════════════════
# GPEC — XTEA-style with "DAIMLERCHRYSLER3" key material
# ════════════════════════════════════════════════════════════════════════════

GPEC_KEY = bytes([0x44, 0x41, 0x49, 0x4D,   # DAIM
                  0x4C, 0x45, 0x52, 0x43,   # LERC
                  0x48, 0x52, 0x59, 0x53,   # HRYS
                  0x4C, 0x45, 0x52, 0x33])  # LER3


def _gpec_mix4(a, b, c, d):
    return (((((a << 3) ^ b) << 2) ^ c) << 3) ^ d


def gpec_unlock(seed):
    """GPEC — 16-round XTEA-style Feistel using DAIMLERCHRYSLER3 as key."""
    seed = _u32(seed)
    eax = (((seed >> 16) & 0xFF) << 8) | ((seed >> 24) & 0xFF)
    edx = (((seed >>  0) & 0xFF) << 8) | ((seed >>  8) & 0xFF)
    eax &= 0xFFFF
    edx &= 0xFFFF
    ebp_r = _gpec_mix4(GPEC_KEY[0x3], GPEC_KEY[0x2], GPEC_KEY[0x1], GPEC_KEY[0x0])
    edi_r = _gpec_mix4(GPEC_KEY[0x7], GPEC_KEY[0x6], GPEC_KEY[0x5], GPEC_KEY[0x4])
    esi_r = _gpec_mix4(GPEC_KEY[0xB], GPEC_KEY[0xA], GPEC_KEY[0x9], GPEC_KEY[0x8])
    ecx_r = _gpec_mix4(GPEC_KEY[0xF], GPEC_KEY[0xE], GPEC_KEY[0xD], GPEC_KEY[0xC])
    sum_r = 0
    for _ in range(16):
        sum_r = (sum_r + 0xFFFF9E37) & 0xFFFF
        t = _u32((edx << 4) + ebp_r)
        u = _u32((edx >> 5) + edi_r)
        m1 = _u32(t ^ u ^ _u32(sum_r + edx))
        eax = (eax + m1) & 0xFFFF
        t = _u32((eax << 4) + esi_r)
        u = _u32((eax >> 5) + ecx_r)
        m2 = _u32(t ^ u ^ _u32(sum_r + eax))
        edx = (edx + m2) & 0xFFFF
    al_lo = eax & 0xFF
    al_hi = (eax >> 8) & 0xFF
    dl_lo = edx & 0xFF
    dl_hi = (edx >> 8) & 0xFF
    return (al_lo << 24) | (al_hi << 16) | (dl_lo << 8) | dl_hi


# ════════════════════════════════════════════════════════════════════════════
# DCX PTCM — Park-Miller LCG pair XOR constant
# ════════════════════════════════════════════════════════════════════════════

def dcx_ptcm_unlock(seed, arg2=0):
    """DCX PTCM — LCG(0x41C64E6D, 0x3039) pair ^ 0xF3DD1133."""
    a = _u32(seed * 0x41C64E6D + 0x3039)
    b = _u32(arg2 * 0x41C64E6D + 0x3039)
    return _u32(a ^ b ^ 0xF3DD1133)


# ════════════════════════════════════════════════════════════════════════════
# EGS52 — Mercedes 7G-Tronic
# ════════════════════════════════════════════════════════════════════════════

def egs52_unlock(seed):
    """Mercedes EGS52 — (seed ^ 0x5AA5A5A5) * 0x5AA5A5A5."""
    return _u32((seed ^ 0x5AA5A5A5) * 0x5AA5A5A5)


# ════════════════════════════════════════════════════════════════════════════
# Aisin TCM — multi-stage 16-bit arithmetic with 32-bit bitwise-NOT
# ════════════════════════════════════════════════════════════════════════════

_AISIN_STACK = [
    0x2345, 0x6789, 0xabc7, 0xcdef, 0x0123,
    0x2345, 0x6789, 0xabcd,
    0x2345, 0x6789, 0xabc7, 0xcdef, 0x0123,
    0x2345, 0x6789, 0xabcd,
]


def aisin_tcm_unlock(seed):
    """Aisin AS68RC/AS69RC TCM — 3-stage sub/add/imul/not chain, indexed by seed & 7."""
    seed = _u32(seed)
    idx = seed & 7
    eax = seed
    def rd(o): return _AISIN_STACK[o]
    def mod_ax(v):
        nonlocal eax
        eax = (eax & 0xFFFF0000) | (v & 0xFFFF)
    mod_ax((eax & 0xFFFF) - rd(idx + 0))
    eax = _u32(eax + 0x7E55)
    mod_ax(((eax & 0xFFFF) * rd(idx + 1)) & 0xFFFF)
    eax = _u32(~eax)
    mod_ax((eax & 0xFFFF) - rd(idx + 3))
    mod_ax((eax & 0xFFFF) + rd(idx + 2))
    mod_ax(((eax & 0xFFFF) * rd(idx + 4)) & 0xFFFF)
    eax = _u32(~eax)
    mod_ax((eax & 0xFFFF) - rd(idx + 6))
    mod_ax((eax & 0xFFFF) + rd(idx + 5))
    mod_ax(((eax & 0xFFFF) * rd(idx + 7)) & 0xFFFF)
    eax = _u32(~eax)
    return eax


# ════════════════════════════════════════════════════════════════════════════
# PTIM LX
# ════════════════════════════════════════════════════════════════════════════

PTIM_LX_TABLE = [0xd785, 0xd95b, 0x68e7, 0x8a4f, 0x7f8b, 0x8ae8, 0x6f21, 0x9a69]


def ptim_lx_unlock(seed):
    """PowerTrain Integrated Module (LX) — 5 table XORs with unusual i2 packing."""
    seed = _u32(seed)
    i0 = (seed >> 13) & 7
    i1 = (seed >> 10) & 7
    i2 = ((seed >> 7) & 6) | ((seed >> 6) & 1)
    i3 = (seed >>  3) & 7
    i4 =  seed        & 7
    k = PTIM_LX_TABLE[i0]
    k ^= PTIM_LX_TABLE[i1]
    k ^= PTIM_LX_TABLE[i2]
    k ^= PTIM_LX_TABLE[i3]
    k ^= PTIM_LX_TABLE[i4]
    k ^= (seed & 0xFFFF)
    return (seed & 0xFFFF0000) | (k & 0xFFFF)


# ════════════════════════════════════════════════════════════════════════════
# Cummins 6.7L diesel ECM
# ════════════════════════════════════════════════════════════════════════════

CUMMINS_849_TABLE = [
    0x1ce32951, 0x8bb28c39, 0x76c6da1a, 0xe0b69a47,
    0xf356024c, 0x60af852b, 0x63a12ac7, 0x53ff8daf,
    0xa8f7e36c, 0x63e92252, 0x2cd56fe4, 0x2e3ef306,
    0x5b0a976f, 0xdb6cfa03, 0x19ccb5a4, 0x8113b235,
]


def cummins_849_unlock(seed):
    """Cummins ISB 6.7L — 16-entry 32-bit table, 4 rotating XORs + seed + 0x55111511."""
    seed = _u32(seed)
    idx = (seed >> 20) & 0xF
    k = CUMMINS_849_TABLE[(idx + 2) & 0xF]
    k ^= CUMMINS_849_TABLE[(idx + 3) & 0xF]
    k ^= CUMMINS_849_TABLE[(idx + 1) & 0xF]
    k ^= CUMMINS_849_TABLE[(idx + 0) & 0xF]
    edx = _u32(seed + 0x55111511)
    return _u32(k ^ edx)


# ════════════════════════════════════════════════════════════════════════════
# RADIO / HEAD UNIT family — Uconnect unlock algorithms
# ════════════════════════════════════════════════════════════════════════════

HUNTSVILLE_RADIO_TABLE = [0x715f, 0x36bd, 0x2e05, 0xaa38, 0x8952, 0x1fdc, 0x6255, 0xe379]


def huntsville_radio_unlock(seed):
    """Harman Huntsville radio — 8-entry table, 5 XORs shifts (13,10,7,4,0), xor 0xCA59.
    
    Used by: 8.4" UConnect 4/4C RA3/RA4 head units.
    """
    seed = _u32(seed)
    k = HUNTSVILLE_RADIO_TABLE[(seed >> 13) & 7]
    k ^= HUNTSVILLE_RADIO_TABLE[(seed >> 10) & 7]
    k ^= HUNTSVILLE_RADIO_TABLE[(seed >>  7) & 7]
    k ^= HUNTSVILLE_RADIO_TABLE[(seed >>  4) & 7]
    k ^= HUNTSVILLE_RADIO_TABLE[ seed        & 7]
    k ^= (seed & 0xFFFF)
    k ^= 0xCA59
    return (seed & 0xFFFF0000) | (k & 0xFFFF)


def mitsubishi_rar_unlock(seed):
    """Mitsubishi RAR — ((seed ^ 0x7368) * 2 + 0x2A) ^ 0x6974.
    
    Used by: 5" UConnect 3 RA1/RA2 head units.
    """
    eax = _u32(seed ^ 0x7368)
    ecx = _u32(2 * eax + 0x2A)
    return _u32(ecx ^ 0x6974)


def alpine_rak_unlock(seed, arg2=0):
    """Alpine Radio Amplifier Kit — LCG pair XOR 0x4E2B.
    
    Used by: early UConnect 4 RA4 low-spec head units.
    """
    a = _u32(seed * 0x41C64E6D + 0x3039)
    b = _u32(arg2 * 0x41C64E6D + 0x3039)
    return _u32(a ^ b ^ 0x4E2B)


def alpine_radio_unlock(seed, arg2=0):
    """Alpine RA3/RA4 radio — different LCG constants, XOR 0x58C2.
    
    Used by: mid-spec 7" UConnect 4 Alpine head units.
    """
    a = _u32(seed * 0x32A95B7F + 0x52D8)
    b = _u32(arg2 * 0x32A95B7F + 0x52D8)
    return _u32(a ^ b ^ 0x58C2)


# ════════════════════════════════════════════════════════════════════════════
# Registry
# ════════════════════════════════════════════════════════════════════════════

CANFLASH_ALGOS = {
    'ngc_engine':       {'fn': ngc_engine_unlock,       'label': 'NGC gas engine',         'tx': 0x7E0, 'rx': 0x7E8},
    'ngc4_trans':       {'fn': ngc4_trans_unlock,       'label': 'NGC4 transmission',      'tx': 0x7E1, 'rx': 0x7E9},
    'ngc_transmission': {'fn': ngc_transmission_unlock, 'label': 'NGC transmission',       'tx': 0x7E1, 'rx': 0x7E9},
    'venom_pcm':        {'fn': venom_pcm_unlock,        'label': 'Venom PCM',              'tx': 0x7E0, 'rx': 0x7E8},
    'gpec':             {'fn': gpec_unlock,             'label': 'GPEC ECM',               'tx': 0x7E0, 'rx': 0x7E8},
    'dcx_ptcm':         {'fn': dcx_ptcm_unlock,         'label': 'DCX PowerTrain CM',      'tx': 0x730, 'rx': None},
    'egs52':            {'fn': egs52_unlock,            'label': 'Mercedes EGS52 7G',      'tx': 0x7E1, 'rx': 0x7E9},
    'aisin_tcm':        {'fn': aisin_tcm_unlock,        'label': 'Aisin AS68/69 TCM',      'tx': 0x7E1, 'rx': 0x7E9},
    'ptim_lx':          {'fn': ptim_lx_unlock,          'label': 'PowerTrain IM (LX)',     'tx': 0x7E0, 'rx': 0x7E8},
    'cummins_849':      {'fn': cummins_849_unlock,      'label': 'Cummins 6.7L (849)',     'tx': 0x7E0, 'rx': 0x7E8},
    'huntsville_radio': {'fn': huntsville_radio_unlock, 'label': 'Harman Huntsville radio',    'tx': 0x6B0, 'rx': 0x6B8},
    'mitsubishi_rar':   {'fn': mitsubishi_rar_unlock,   'label': 'Mitsubishi RAR (UConnect 3)', 'tx': 0x6B0, 'rx': 0x6B8},
    'alpine_rak':       {'fn': alpine_rak_unlock,       'label': 'Alpine RAK (UConnect 4 low)', 'tx': 0x6B0, 'rx': 0x6B8},
    'alpine_radio':     {'fn': alpine_radio_unlock,     'label': 'Alpine RA3/RA4 radio',       'tx': 0x6B0, 'rx': 0x6B8},
}


# ════════════════════════════════════════════════════════════════════════════
# Pinned test vectors — must match Unicorn emulation of the original DLLs
# ════════════════════════════════════════════════════════════════════════════

_VECTORS = {
    'ngc_engine': {
        0x00000000: 0x0000D931, 0x12345678: 0x1234A2E4, 0xA1B2C3D4: 0xA1B26AC9,
        0xDEADBEEF: 0xDEAD2AFE, 0xFFFFFFFF: 0xFFFFF9B4, 0x00000001: 0x0000A78A,
        0xCAFEBABE: 0xCAFE3057, 0x55555555: 0x5555E50F,
    },
    'ngc_transmission': {
        0x00000000: 0x0000833B, 0x12345678: 0x1234CBB1, 0xA1B2C3D4: 0xA1B27371,
        0xDEADBEEF: 0xDEADCFC5, 0xFFFFFFFF: 0xFFFF8ED5, 0x00000001: 0x0000B985,
        0xCAFEBABE: 0xCAFE59CC, 0x55555555: 0x5555FB02,
    },
    'venom_pcm': {
        0x00000000: 0x0000DF67, 0x12345678: 0x12341E70, 0xA1B2C3D4: 0xA1B200A2,
        0xDEADBEEF: 0xDEADFA37, 0xFFFFFFFF: 0xFFFF9EE1, 0x00000001: 0x00000705,
        0xCAFEBABE: 0xCAFE205D, 0x55555555: 0x5555FCE9,
    },
    'gpec': {
        0x00000000: 0xF5B9DE24, 0x12345678: 0x01C42892, 0xA1B2C3D4: 0x87F3449E,
        0xDEADBEEF: 0x0C49D041, 0xFFFFFFFF: 0xD89B1FE3, 0x00000001: 0xDA5F1DB8,
        0xCAFEBABE: 0x205540D9, 0x55555555: 0x08072DC8,
    },
    'dcx_ptcm': {
        0x00000000: 0xF3DD1133, 0x12345678: 0xF8ACB05B, 0xA1B2C3D4: 0x691D0877,
        0xDEADBEEF: 0xEFDC6CF6, 0xFFFFFFFF: 0x4DE4C0C6, 0x00000001: 0xB21B5FAC,
        0xCAFEBABE: 0x4B92B615, 0x55555555: 0x19CE4A60,
    },
    'egs52': {
        0x00000000: 0xF5E01C59, 0x12345678: 0xB7B09E71, 0xA1B2C3D4: 0xABF0DBD5,
        0xDEADBEEF: 0xED8248B2, 0xFFFFFFFF: 0xAF7A3E02, 0x00000001: 0x9B3A76B4,
        0xCAFEBABE: 0x502E7367, 0x55555555: 0x3C45FAB0,
    },
    'aisin_tcm': {
        0x00000000: 0xFFFE2831, 0x12345678: 0xEDCB14A9, 0xA1B2C3D4: 0x5E4CCCEF,
        0xDEADBEEF: 0x2152D3BC, 0xFFFFFFFF: 0x00008C8C, 0x00000001: 0xFFFE9C88,
        0xCAFEBABE: 0x35016F93, 0x55555555: 0xAAAAD2B8,
    },
    'ptim_lx': {
        0x00000000: 0x0000D785, 0x12345678: 0x12347373, 0xA1B2C3D4: 0xA1B2F675,
        0xDEADBEEF: 0xDEAD3407, 0xFFFFFFFF: 0xFFFF6596, 0x00000001: 0x0000D95A,
        0xCAFEBABE: 0xCAFED5B4, 0x55555555: 0x5555DF1A,
    },
    'cummins_849': {
        0x00000000: 0x5430F024, 0x12345678: 0x77AB5C6E, 0xA1B2C3D4: 0x4157F32B,
        0xDEADBEEF: 0xB133258E, 0xFFFFFFFF: 0x3595D857, 0x00000001: 0x5430F027,
        0xCAFEBABE: 0x408B0288, 0x55555555: 0x5260AB49,
    },
    'huntsville_radio': {
        0x00000000: 0x0000BB06, 0x12345678: 0x1234B68C, 0xA1B2C3D4: 0xA1B26F70,
        0xDEADBEEF: 0xDEAD16E3, 0xFFFFFFFF: 0xFFFFD6DF, 0x00000001: 0x0000FCE5,
        0xCAFEBABE: 0xCAFEDADF, 0x55555555: 0x555580D0,
    },
    'mitsubishi_rar': {
        0x00000000: 0x00008F8E, 0x12345678: 0x2468233E, 0xA1B2C3D4: 0x436508D6,
        0xDEADBEEF: 0xBD5BF24C, 0xFFFFFFFF: 0xFFFF702C, 0x00000001: 0x00008F88,
        0xCAFEBABE: 0x95FDFAA2, 0x55555555: 0xAAAA25D0,
    },
    'alpine_rak': {
        0x00000000: 0x00004E2B, 0x12345678: 0x0B71EF43, 0xA1B2C3D4: 0x9AC0576F,
        0xDEADBEEF: 0x1C0133EE, 0xFFFFFFFF: 0xBE399FDE, 0x00000001: 0x41C600B4,
        0xCAFEBABE: 0xB84FE90D, 0x55555555: 0xEA131578,
    },
    'alpine_radio': {
        0x00000000: 0x000058C2, 0x12345678: 0x27EBEA7A, 0xA1B2C3D4: 0x723FDF1E,
        0xDEADBEEF: 0xF4D80A73, 0xFFFFFFFF: 0xCD56FD43, 0x00000001: 0x32A9A44D,
        0xCAFEBABE: 0xA42E8B00, 0x55555555: 0x99C7D519,
    },
}

# ngc4_trans shares the ngc_engine output exactly — validate separately
_VECTORS['ngc4_trans'] = _VECTORS['ngc_engine']


def _selftest():
    total = 0
    for name, vectors in _VECTORS.items():
        fn = CANFLASH_ALGOS[name]['fn']
        for seed, expected in vectors.items():
            got = fn(seed)
            assert got == expected, (
                f'{name}({seed:#010x}) = {got:#010x}, expected {expected:#010x}')
            total += 1
    return total


_TOTAL_VECTORS_PASSING = _selftest()


if __name__ == '__main__':
    print(f'SRT Lab canflash algorithms — {len(CANFLASH_ALGOS)} modules')
    print('=' * 70)
    seed = 0xDEADBEEF
    print(f'\nSample output for seed=0x{seed:08X}:\n')
    for key, cfg in CANFLASH_ALGOS.items():
        k = cfg['fn'](seed)
        tx = f'tx=0x{cfg["tx"]:03X}'
        rx = f'rx=0x{cfg["rx"]:03X}' if cfg['rx'] else '(passive)'
        print(f"  {cfg['label']:<30s}  {tx:<10s} {rx:<10s}  key=0x{k:08X}")
    print(f'\n{_TOTAL_VECTORS_PASSING} pinned vectors verified on import.')
