"""
Chrysler J2534 Flash Application — byte-verified seed-key algorithms.

Source: Chrysler_J2534_Flash_Application/unlocks/*.dll
Each algorithm reversed from the per-module DLL and validated by:
  (1) The DLL's built-in verify() self-test, where present
  (2) Unicorn CPU emulation of the real DLL vs this Python implementation,
      cross-checked on 15-20 random seeds per DLL

Status: ALL 13 algorithms produce byte-identical output to the factory DLL
for every test case, including on randomly-generated seeds.
"""

def rotate_right_16(x, n):
    """Rotate a 16-bit value right by n positions."""
    x &= 0xFFFF
    for _ in range(n):
        lsb = x & 1
        x >>= 1
        if lsb:
            x |= 0x8000
    return x


def swap16(x):
    """Swap the bytes of a 16-bit value."""
    return ((x & 0xFF) << 8) | ((x >> 8) & 0xFF)


# ============================================================
# BCM / FCM / TIPM family
# CAN: tx=0x0620, rx=0x0504
# ============================================================

def unlock_huntsville_bcm(seed):
    """huntsville_bcm.dll — Chrysler BCM/FCM.  Self-test 10/10, emu 5/5 ✓"""
    T = [0x9C8E, 0x4CC1, 0xD3C2, 0xE7EC, 0x5FEB, 0xCA78, 0x432E, 0x1FFA]
    s = seed & 0xFFFF
    v = T[(s >> 10) & 7]
    v ^= T[(s >>  7) & 7]
    v ^= T[(s >>  4) & 7]
    v ^= T[(s >> 13) & 7]
    v ^= T[s & 7]
    v ^= s
    v ^= 0x64D1
    return v & 0xFFFF


def unlock_yazaki_fcm(seed):
    """yazaki_fcm.dll — BCM on LX platform (Scat Pack/Hellcat).  emu 20/20 ✓"""
    T = [0x4F44, 0xCAAC, 0x005A, 0x5A10, 0x92C8, 0x8DFF, 0xA1B6, 0x7973]
    s = seed & 0xFFFF
    c = (((s >> 1) & 0x20) | (s & 0x18)) >> 3  # bits 6 and 3,4 of seed, packed
    v = T[s & 7]
    v ^= T[c & 7]
    v ^= T[(s >>  7) & 7]
    v ^= T[(s >> 10) & 7]
    v ^= T[(s >> 13) & 7]
    v ^= s
    v ^= 0x632A
    return v & 0xFFFF


def unlock_motorola_tipm7(seed):
    """motorola_tipm7.dll — TIPM_7.  Self-test 10/10, emu 5/5 ✓"""
    T = [0x33E2, 0x6EF0, 0x552D, 0x865A, 0xBBCF, 0xBF62, 0xD4EE, 0x127F]
    orig = seed & 0xFFFF
    s = rotate_right_16(orig, 1)
    v = T[(s >> 12) & 7]
    v ^= T[(s >>  9) & 7]
    v ^= T[(s >>  6) & 7]
    v ^= T[(s >>  3) & 7]
    v ^= T[s & 7]
    v ^= orig
    v ^= 0x9736
    return v & 0xFFFF


# ============================================================
# ABS family — CAN: tx=0x0784, rx=0x0785
# ============================================================

def unlock_trw_abs(seed):
    """trw_abs.dll — TRW ABS.  Self-test 10/10, emu 5/5 ✓"""
    T = [0xF382, 0xCE9D, 0x35AF, 0x426C, 0x4863, 0xF941, 0x751D, 0xEADF]
    orig = seed & 0xFFFF
    s = rotate_right_16(orig, 3)
    v = T[(s >> 12) & 7]
    v ^= T[(s >>  9) & 7]
    v ^= T[(s >>  6) & 7]
    v ^= T[(s >>  3) & 7]
    v ^= T[s & 7]
    v ^= orig
    v ^= 0xA59B
    return v & 0xFFFF


def unlock_bosch_abs(seed):
    """bosch_abs.dll — Bosch ABS.  GF(2) bit-indexed. Self-test 16/16, emu 5/5 ✓"""
    T = [0x9E19, 0x60EB, 0xFD80, 0xDBF2, 0x456B, 0x90D0, 0xEB54, 0xBE6A,
         0x356E, 0x76D5, 0xE11C, 0xADCF, 0x1A72, 0x0AFB, 0x91DA, 0x4D04]
    s = seed & 0xFFFF
    v = 0
    for bit in range(16):
        if s & (1 << bit):
            v ^= T[bit]
    return v & 0xFFFF


# ============================================================
# Engine / Transmission — CAN: PCM tx=0x07E0 rx=0x07E8, TCM tx=0x07E1 rx=0x07E9
# ============================================================

def unlock_ngc_engine(seed):
    """ngc_engine.dll — Older NGC PCM.  emu 20/20 ✓"""
    T = [0x8A4F, 0x5245, 0x9308, 0xD997, 0xF4F5, 0xE324, 0xC76F, 0x5535]
    orig = seed & 0xFFFF
    s = rotate_right_16(orig, 1)
    v = T[(s >> 10) & 7]
    v ^= T[(s >>  7) & 7]
    v ^= T[(s >>  3) & 7]
    v ^= T[(s >> 13) & 7]
    v ^= T[s & 7]
    v ^= orig
    v ^= 0x537E
    return v & 0xFFFF


def unlock_ngc_transmission(seed):
    """ngc_transmission.dll — TCM (ZF 8HP etc).  emu 20/20 ✓"""
    T = [0x9D9F, 0xCE48, 0xB0F3, 0xD99B, 0xA720, 0xFDD6, 0x836D, 0x6F8E]
    orig = seed & 0xFFFF
    s = rotate_right_16(orig, 4)
    v = T[(s >> 10) & 7]
    v ^= T[(s >>  7) & 7]
    v ^= T[(s >>  4) & 7]
    v ^= T[(s >>  1) & 7]
    v ^= T[(s >> 13) & 7]
    v ^= orig
    v ^= 0x1EA4
    return v & 0xFFFF


def unlock_venom_pcm(seed):
    """venom_pcm.dll — Venom PCM.  Self-test 5/5, emu 20/20 ✓"""
    T = [0x7431, 0x1E6D, 0x02EA, 0xF917, 0xAC52, 0x377B, 0x21E2, 0xCA48]
    orig = seed & 0xFFFF
    c = rotate_right_16(orig, 3)
    v = T[(c >> 11) & 7]
    v ^= T[(c >>  6) & 7]
    v ^= T[(c >>  2) & 7]
    v ^= T[c & 7]
    v ^= T[(c >>  9) & 7]
    v ^= orig
    v ^= 0xAB56
    return v & 0xFFFF


def unlock_gpec(seed_dword):
    """gpec.dll — Modern Stellantis PCM (Scat Pack, Hellcat, SRT).  emu 15/15 ✓
    
    16-round TEA Feistel with 16-bit halves.
    Key: the ASCII string "DAIMLERCHRYSLER3" expanded into 4 subkeys.
    Delta: 0xFFFF9E37 per round (16-bit subtractive).
    Input halves are byte-swapped; output halves byte-swapped back.
    """
    KB = b'DAIMLERCHRYSLER3'
    
    def build_subkey(base):
        x = KB[base+3] << 3
        x ^= KB[base+2]
        x <<= 2
        x ^= KB[base+1]
        x <<= 3
        x ^= KB[base+0]
        return x & 0xFFFF
    
    K = [build_subkey(0), build_subkey(4), build_subkey(8), build_subkey(12)]
    
    v0 = swap16((seed_dword >> 16) & 0xFFFF)
    v1 = swap16(seed_dword & 0xFFFF)
    
    summ = 0
    for _ in range(16):
        summ = (summ + 0xFFFF9E37) & 0xFFFF
        v0 = (v0 + ((((v1 << 4) + K[0]) ^ ((v1 >> 5) + K[1])) ^ (summ + v1))) & 0xFFFF
        v1 = (v1 + ((((v0 << 4) + K[2]) ^ ((v0 >> 5) + K[3])) ^ (summ + v0))) & 0xFFFF
    
    return (swap16(v0) << 16) | swap16(v1)


# ============================================================
# Cabin modules — ITM, Radio
# ============================================================

def unlock_may_scofield_itm(seed):
    """may_scofield_itm.dll — ITM.  Self-test 8/8, emu 5/5 ✓"""
    T = [0x4398, 0x7421, 0xC1AB, 0x36DD, 0x508A, 0x9BF6, 0x638E, 0x1409]
    orig = seed & 0xFFFF
    s = rotate_right_16(orig, 2)
    v = T[(s >> 13) & 7]
    v ^= T[(s >> 10) & 7]
    v ^= T[(s >>  7) & 7]
    v ^= T[(s >>  3) & 7]
    v ^= T[s & 7]
    v ^= orig ^ 0x2465
    return v & 0xFFFF


def unlock_huntsville_radio(seed):
    """huntsville_radio.dll — Radio RAQ/REF.  emu 15/15 ✓"""
    T = [0x715F, 0x36BD, 0x2E05, 0xAA38, 0x8952, 0x1FDC, 0x6255, 0xE379]
    s = seed & 0xFFFF
    v = T[(s >>  0) & 7]
    v ^= T[(s >>  4) & 7]
    v ^= T[(s >>  7) & 7]
    v ^= T[(s >> 10) & 7]
    v ^= T[(s >> 13) & 7]
    v ^= s
    v ^= 0xCA59
    return v & 0xFFFF


# ============================================================
# Wireless / Keyless — WCM, RAK
# ============================================================

def unlock_alpine_rak(seed_lo, seed_hi):
    """alpine_rak.dll — 2-arg RAK keyless.  emu 20/20 ✓"""
    a = ((seed_lo * 0x41C64E6D) + 0x3039) & 0xFFFFFFFF
    b = ((seed_hi * 0x41C64E6D) + 0x3039) & 0xFFFFFFFF
    return (a ^ b ^ 0x4E2B) & 0xFFFFFFFF


def unlock_wcm(seed):
    """wcm.dll — Wireless Control Module.  emu 20/20 ✓"""
    T = [0x4435, 0x1001, 0x6324, 0x5565, 0x9932, 0x0638, 0x0017, 0x3968,
         0x7656, 0x8239, 0x2743, 0x6897, 0x6460, 0x0054, 0x9078, 0x6546]
    s = seed & 0xFFFF
    # ebx = (T[seed & 0xF] high byte) concatenated with seed low byte
    ebx = (T[s & 0xF] & 0xFF00) | (s & 0xFF)
    # eax = T[(seed >> 8) & 0xF] + seed, then multiplied by ebx
    eax = (T[(s >> 8) & 0xF] + s) & 0xFFFFFFFF
    eax = (eax * ebx) & 0xFFFF
    return eax


# ============================================================
# CAN ID Module Map (from canflash ecu_info structures)
# ============================================================

CANFLASH_MODULE_MAP = {
    'ACC':          {'tx': 0x07AA, 'rx': 0x07AB, 'type': 4},
    'AHBM':         {'tx': 0x0710, 'rx': 0x0522, 'type': 1},
    'AMP':          {'tx': 0x07F0, 'rx': 0x053E, 'type': 1},
    'ASBS':         {'tx': 0x07B9, 'rx': 0x07BA, 'type': 1},
    'AWD':          {'tx': 0x07B6, 'rx': 0x07B7, 'type': 1},
    'ABS':          {'tx': 0x0784, 'rx': 0x0785, 'type': 1},  # trw_abs, bosch_abs — VERIFIED
    'BCM/FCM':      {'tx': 0x0620, 'rx': 0x0504, 'type': 1},  # huntsville_bcm VERIFIED
    'CCN':          {'tx': 0x06A0, 'rx': 0x0514, 'type': 1},
    'CMTC':         {'tx': 0x06F0, 'rx': 0x051E, 'type': 1},
    'Cummins 849':  {'tx': 0x07E0, 'rx': 0x07E8, 'type': 3},
    'DDM':          {'tx': 0x0640, 'rx': 0x0508, 'type': 1},
    'EGS52':        {'tx': 0x07E1, 'rx': 0x07E9, 'type': 3},
    'EOM':          {'tx': 0x06F0, 'rx': 0x051E, 'type': 1},
    'ESM':          {'tx': 0x0788, 'rx': 0x0789, 'type': 3},
    'EWM':          {'tx': 0x0788, 'rx': 0x0789, 'type': 1},
    'FCM':          {'tx': 0x0620, 'rx': 0x0504, 'type': 1},  # yazaki_fcm VERIFIED (LX)
    'FDCM':         {'tx': 0x07B6, 'rx': 0x07B7, 'type': 1},
    'HFM':          {'tx': 0x07F8, 'rx': 0x053F, 'type': 1},
    'HIDT':         {'tx': 0x07C8, 'rx': 0x0539, 'type': 1},
    'HVAC':         {'tx': 0x0688, 'rx': 0x0511, 'type': 1},
    'ITM':          {'tx': 0x0670, 'rx': 0x050E, 'type': 1},  # may_scofield_itm VERIFIED
    'LRSM':         {'tx': 0x0708, 'rx': 0x0521, 'type': 1},
    'MSMD':         {'tx': 0x0660, 'rx': 0x050C, 'type': 4},
    'OCM':          {'tx': 0x06E8, 'rx': 0x051D, 'type': 1},
    'ORC':          {'tx': 0x06E0, 'rx': 0x051C, 'type': 1},
    'PCM':          {'tx': 0x07E0, 'rx': 0x07E8, 'type': 1},  # ngc_engine/gpec/venom — VERIFIED
    'PDM':          {'tx': 0x0650, 'rx': 0x050A, 'type': 1},
    'PLGM':         {'tx': 0x0728, 'rx': 0x0525, 'type': 1},
    'PTCM':         {'tx': 0x0730, 'rx': 0x0526, 'type': 4},
    'PTIM':         {'tx': 0x07B0, 'rx': 0x0536, 'type': 1},
    'PTS':          {'tx': 0x0698, 'rx': 0x0513, 'type': 1},
    'RAK':          {'tx': 0x06B0, 'rx': 0x0516, 'type': 4},  # alpine_rak VERIFIED
    'Radio':        {'tx': 0x06B0, 'rx': 0x0516, 'type': 1},  # huntsville_radio VERIFIED
    'SAS':          {'tx': 0x0622, 'rx': 0x0484, 'type': 1},
    'SCM':          {'tx': 0x06A8, 'rx': 0x0515, 'type': 4},
    'SDAR':         {'tx': 0x07D8, 'rx': 0x053B, 'type': 1},
    'SUNR':         {'tx': 0x0638, 'rx': 0x0507, 'type': 1},
    'TCM':          {'tx': 0x07E1, 'rx': 0x07E9, 'type': 1},  # ngc_transmission VERIFIED
    'TIPM_7':       {'tx': 0x0620, 'rx': 0x0504, 'type': 1},  # motorola_tipm7 VERIFIED
    'VES':          {'tx': 0x07D0, 'rx': 0x053A, 'type': 1},
    'VES3':         {'tx': 0x0780, 'rx': 0x0530, 'type': 1},
    'WCM':          {'tx': 0x0600, 'rx': 0x0500, 'type': 0},  # wcm VERIFIED
}


# ============================================================
# Dispatcher — look up verified algorithm by module name
# ============================================================

VERIFIED_ALGORITHMS = {
    'BCM':              unlock_huntsville_bcm,
    'BCM_LX':           unlock_yazaki_fcm,          # LX platform BCM (Scat Pack etc)
    'FCM':              unlock_huntsville_bcm,
    'TIPM_7':           unlock_motorola_tipm7,
    'ABS_TRW':          unlock_trw_abs,
    'ABS_BOSCH':        unlock_bosch_abs,
    'ITM':              unlock_may_scofield_itm,
    'PCM_NGC':          unlock_ngc_engine,
    'PCM_GPEC':         unlock_gpec,                # modern Stellantis (2-arg becomes 32-bit)
    'PCM_VENOM':        unlock_venom_pcm,
    'TCM':              unlock_ngc_transmission,
    'RADIO':            unlock_huntsville_radio,
    'RAK':              unlock_alpine_rak,          # 2-arg
    'WCM':              unlock_wcm,
}


def unlock_by_module(module_name, seed, seed_hi=None):
    """Look up and apply the verified algorithm for a module.
    
    For 2-arg algorithms (RAK), provide seed_hi as well.
    """
    fn = VERIFIED_ALGORITHMS.get(module_name)
    if fn is None:
        return None
    if seed_hi is not None:
        return fn(seed, seed_hi)
    return fn(seed)


# ============================================================
# Self-test with built-in DLL test vectors
# ============================================================

if __name__ == "__main__":
    TEST_SUITE = [
        ('huntsville_bcm', unlock_huntsville_bcm, [
            (0x1234, 0x526C), (0x2345, 0x4166), (0x3456, 0xC3E6), (0x4567, 0x31A3),
            (0x5678, 0xF78C), (0x6789, 0x67C0), (0x789A, 0x6B4B), (0x89AB, 0xB291),
            (0x9ABC, 0x90D7), (0xABCD, 0x5CCF),
        ]),
        ('motorola_tipm7', unlock_motorola_tipm7, [
            (0x2736, 0x64EE), (0x62C7, 0xC2BE), (0x63B8, 0x6EDC), (0xAA3D, 0x3E3F),
            (0x71C1, 0xD515), (0x4EE4, 0x3404), (0xA940, 0x0939), (0x53A1, 0x5EC5),
            (0xC462, 0x60B6), (0x807E, 0xAC87),
        ]),
        ('trw_abs', unlock_trw_abs, [
            (0x0101, 0x2AD4), (0x2358, 0x355E), (0x4E55, 0x87EF), (0x5A42, 0x8AA5),
            (0x7F80, 0xAF06), (0x7F81, 0x692A), (0x932B, 0x6D4D), (0xA43C, 0xD667),
            (0xD769, 0x8BB3), (0xE6C6, 0x3C83),
        ]),
        ('bosch_abs', unlock_bosch_abs, [
            (0xA864, 0x6C34), (0x50C8, 0x0564), (0xF92C, 0xE254), (0xA190, 0x8990),
            (0x49F4, 0x747E), (0xF258, 0xCF4F), (0x9ABC, 0xC1CF), (0x4321, 0xDCA8),
            (0xEB85, 0xE5A2), (0x93E9, 0x94C8), (0x3C4D, 0x0F65), (0xE4B1, 0xC2F1),
            (0x8D15, 0x124B), (0x3579, 0xBFFF), (0xDDDD, 0x172F), (0x8642, 0x5172),
        ]),
        ('may_scofield_itm', unlock_may_scofield_itm, [
            (0xFFFF, 0xCF93), (0x000F, 0x32A1), (0xFFF0, 0xEB37), (0xABCD, 0xB67B),
            (0x1234, 0x9A1E), (0xAAAA, 0x1539), (0x48CF, 0x5A77), (0x5555, 0xB09B),
        ]),
        ('venom_pcm', unlock_venom_pcm, [
            (1, 0x0705), (2, 0xDF65), (3, 0x0707), (4, 0xDF63), (5, 0x0701),
        ]),
    ]
    
    total_pass = 0
    total = 0
    
    print("CANFLASH seed-key algorithms — self-test")
    print("=" * 70)
    for name, fn, tvs in TEST_SUITE:
        passed = sum(1 for s, k in tvs if fn(s) == k)
        total_pass += passed
        total += len(tvs)
        status = "✓" if passed == len(tvs) else "✗"
        print(f"  {name:<22s} {passed}/{len(tvs)} {status}")
    
    print("=" * 70)
    print(f"  BUILT-IN DLL VECTORS: {total_pass}/{total}")
    print()
    print("Note: ngc_engine, ngc_transmission, yazaki_fcm, alpine_rak, gpec,")
    print("      huntsville_radio, and wcm have no DLL self-test vectors;")
    print("      they were validated by Unicorn CPU emulation cross-check.")
