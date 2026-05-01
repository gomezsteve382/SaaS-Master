"""Draft ports for the 10 hardest FCA unlock DLLs."""


# ---------------------------------------------------------------------------
# sas.dll
# ---------------------------------------------------------------------------
def unlock_sas(seed):
    T = (0x80, 0xCC, 0x7C, 0x7A)
    b3 = (seed >> 24) & 0xFF
    b2 = (seed >> 16) & 0xFF
    b1 = (seed >>  8) & 0xFF
    b0 = (seed      ) & 0xFF
    M = ((7, 5, 3, 2),                  # shift=0 → byte_a (top, <<24)
         (0x13, 0x11, 0xD, 0xB),        # shift=2 → byte_b (<<16)
         (0xB, 0xD, 0x11, 0x13),        # shift=4 → byte_c (<<8)
         (2, 3, 5, 7))                  # shift=6 → byte_d (lo)
    out = 0
    for grp, shift in enumerate((0, 2, 4, 6)):
        a = T[(b0 >> shift) & 3]
        b = T[(b1 >> shift) & 3]
        c = T[(b2 >> shift) & 3]
        d = T[(b3 >> shift) & 3]
        m = M[grp]
        byte = (a * m[0]) ^ (b * m[1]) ^ (c * m[2]) ^ (d * m[3])
        out |= (byte & 0xFF) << ((3 - grp) * 8)
    return out & 0xFFFFFFFF


# ---------------------------------------------------------------------------
# hidt.dll
# ---------------------------------------------------------------------------
def unlock_hidt(seed):
    T = (0x2be9, 0x8519, 0x23ec, 0x9ba7, 0x73b9, 0x001e, 0x93cd, 0x5e7a,
         0x971a, 0x9476, 0x1b63, 0x73f3, 0x7f3b, 0x816a, 0xc983, 0x3800,
         0x3726, 0x0ae1, 0x38be, 0x9356, 0x1b43, 0xbe74, 0xedae, 0x3273,
         0x6538, 0x8461, 0xbebc, 0x0101, 0x1827, 0x9378, 0x192a, 0xcbe2)
    seed &= 0xFFFFFFFF
    b0 = seed & 0xFF
    b1 = (seed >> 8) & 0xFF
    idx_a = (b1 >> 4) & 0x1F
    idx_b = b1 & 0x1F
    idx_c = (b0 >> 4) & 0x1F
    idx_d = b0 & 0x1F
    eax = (T[idx_a] + b0) & 0xFFFF
    eax = (eax | seed) & 0xFFFFFFFF
    eax = (eax - ((T[idx_b] ^ b1) & 0xFFFF)) & 0xFFFFFFFF
    eax = (eax & 0xFFFF0000) | ((eax + T[idx_d]) & 0xFFFF)
    eax = (eax + b1) & 0xFFFFFFFF
    eax = (eax ^ ((T[idx_c] * b0) & 0xFFFF)) & 0xFFFFFFFF
    return eax


# ---------------------------------------------------------------------------
# cvt.dll
# ---------------------------------------------------------------------------
def _rol16(x, n):
    x &= 0xFFFF
    n &= 15
    return ((x << n) | (x >> (16 - n))) & 0xFFFF if n else x


def unlock_cvt(seed):
    seed &= 0xFFFFFFFF
    lo = seed & 0xFFFF
    hi = (seed >> 16) & 0xFFFF
    n0 = (seed) & 0xF
    n1 = (seed >> 4) & 0xF
    n2 = (seed >> 8) & 0xF
    v1 = (lo - 0x3E8D) & 0xFFFF
    r1 = _rol16(v1, n0)
    s1 = ((v1 + r1 - 1) & 0xFFFF) ^ hi
    v2 = (s1 + 0x4DA1) & 0xFFFF
    r2 = _rol16(v2, n1)
    s2 = (v2 + r2 - 1) & 0xFFFF
    r3 = _rol16(s2, n2)
    out_hi = (r3 ^ lo ^ s2) & 0xFFFF
    return ((out_hi << 16) | s1) & 0xFFFFFFFF


# ---------------------------------------------------------------------------
# peiker_hfm.dll
# ---------------------------------------------------------------------------
_T_PEIKER = (0xa62e, 0x579a, 0xce23, 0x6ba5, 0xd173, 0x5d13, 0x1347, 0xb8f1)


def unlock_peiker_hfm(seed):
    seed &= 0xFFFFFFFF
    b0 = seed & 0xFF
    b1 = (seed >> 8) & 0xFF
    idx_a = ((b0 >> 3) & 1) | ((b0 >> 1) & 2) | ((b0 << 1) & 4)
    idx_b = ((b1 >> 3) & 1) | ((b0 >> 6) & 2) | ((b0 >> 4) & 4)
    idx_d = ((b1 >> 1) & 1) | ((b1 >> 1) & 2) | ((b1 >> 2) & 4)
    idx_e = (b0 >> 3) & 7
    idx_c = (b1 >> 5) & 7
    return (seed ^ 0xc521 ^ _T_PEIKER[idx_a] ^ _T_PEIKER[idx_b]
            ^ _T_PEIKER[idx_d] ^ _T_PEIKER[idx_e] ^ _T_PEIKER[idx_c]) & 0xFFFFFFFF


# ---------------------------------------------------------------------------
# visteon_amp.dll
# ---------------------------------------------------------------------------
_T_VISTEON = (0x374f, 0xd329, 0xb213, 0x7fea, 0x1152, 0x6c63, 0x2545, 0x583d)
_POS_VISTEON = (9, 6, 0xe, 8, 0xf, 0xc, 1, 0xb, 0, 2, 5, 3, 0xa, 4, 0xd, 7)


def unlock_visteon_amp(seed):
    seed &= 0xFFFFFFFF
    ax = _T_VISTEON[seed & 7]
    for i in range(16):
        bit = (seed >> i) & 1
        if (i % 2 == 0 and bit == 0) or (i % 2 == 1 and bit == 1):
            ax = (ax + (1 << _POS_VISTEON[i])) & 0xFFFF
    return ax


# ---------------------------------------------------------------------------
# kicker_amp.dll
# ---------------------------------------------------------------------------
_KICKER_TAB1 = (0x2, 0x4, 0x3, 0x9, 0x1, 0xb, 0xa, 0xd,
                0x5, 0x7, 0xe, 0xc, 0x0, 0x8, 0x6, 0xf)
_KICKER_TAB2 = (0x3, 0x5, 0xb, 0xa, 0xf, 0xd, 0x9, 0xc,
                0x6, 0x1, 0x8, 0x0, 0x4, 0xe, 0x7, 0x2)


def _kicker_crc_step(edx, n):
    for _ in range(n):
        if edx & 0x80000000:
            edx = ((edx << 1) ^ 0x4c11db7) & 0xFFFFFFFF
        else:
            edx = (edx << 1) & 0xFFFFFFFF
    return edx


def unlock_kicker_amp(seed):
    seed &= 0xFFFFFFFF
    al = seed & 0xFF              # low byte of seed (used as `al` initial state)
    bl = (seed >> 8) & 0xFF       # high byte of seed (used as `bl` initial state)
    edx = _kicker_crc_step(0xfe0714b6, 37)
    cl_prev = bl                  # cl carry across iterations starts as initial bl
    cl_last = bl
    for _ in range(8):
        edx = _kicker_crc_step(edx, 8)
        s_in = (al ^ (edx & 0xFF)) & 0xFF
        hi = (s_in >> 4) & 0xF
        lo = s_in & 0xF
        sbox = ((_KICKER_TAB1[hi] << 4) | _KICKER_TAB2[lo]) & 0xFF
        rotated = ((sbox >> 1) | ((sbox & 1) << 7)) & 0xFF   # ROR8(sbox, 1)
        cl_prev = cl_last
        cl_last = rotated
        al = (rotated ^ bl) & 0xFF
        bl = rotated
    # Final ax = (cl_8 << 8) | (cl_8 ^ cl_7)
    return ((cl_last << 8) | (cl_last ^ cl_prev)) & 0xFFFF


# ---------------------------------------------------------------------------
# edc16 family
# ---------------------------------------------------------------------------
def _edc16(seed, T):
    seed &= 0xFFFFFFFF
    b0 = seed & 0xFF
    b1 = (seed >> 8) & 0xFF
    b2 = (seed >> 16) & 0xFF
    b3 = (seed >> 24) & 0xFF
    x23 = b2 ^ b3
    idx0 = ((b1 >> 6) & 1) | (((x23 >> 2) & 1) << 1) | (((x23 >> 5) & 1) << 2)
    dl_inter = (T[4 * idx0 + 2] ^ b1) & 0xFF
    idx1 = ((b1 >> 1) & 1) | (((dl_inter >> 5) & 1) << 1) | (((x23 >> 7) & 1) << 2)
    byte3 = (T[4 * idx0    ] ^ b3 ^ T[4 * idx1 + 3]) & 0xFF
    byte2 = (T[4 * idx0 + 1] ^ b2 ^ T[4 * idx1    ]) & 0xFF
    byte1 = (T[4 * idx0 + 2] ^ b1 ^ T[4 * idx1 + 1]) & 0xFF
    byte0 = (T[4 * idx0 + 3] ^ b0 ^ T[4 * idx1 + 2]) & 0xFF
    return (byte3 << 24) | (byte2 << 16) | (byte1 << 8) | byte0


_T_C2 = (0x9b, 0x38, 0x11, 0x76, 0x77, 0xe4, 0x4d, 0x02,
         0x13, 0x50, 0x49, 0x4e, 0x6f, 0x7c, 0x05, 0x5a,
         0x8b, 0x68, 0x81, 0x26, 0x67, 0x14, 0xbd, 0xb2,
         0x03, 0x80, 0xb9, 0xfe, 0x5f, 0xac, 0x75, 0x0a)
_T_CP31 = (0x05, 0x09, 0x07, 0xd3, 0xa3, 0x4a, 0xd1, 0x21,
           0x01, 0x07, 0x07, 0xba, 0x3b, 0xca, 0xe0, 0x72,
           0x3e, 0x10, 0xaa, 0x89, 0xd8, 0x2f, 0x9a, 0x62,
           0x54, 0x9e, 0xa2, 0xda, 0x6b, 0xc4, 0x90, 0x52)
_T_U31 = (0xcc, 0x15, 0x2a, 0x1b, 0xb8, 0x91, 0xf6, 0xf7,
          0x64, 0xcd, 0x82, 0x93, 0xd0, 0xc9, 0xce, 0xef,
          0xfc, 0x85, 0xda, 0x0b, 0xe8, 0x01, 0xa6, 0xe7,
          0x94, 0x3d, 0x32, 0x83, 0x00, 0x39, 0x7e, 0xdf)


def unlock_edc16c2(seed):    return _edc16(seed, _T_C2)
def unlock_edc16cp31(seed):  return _edc16(seed, _T_CP31)
def unlock_edc16u31(seed):   return _edc16(seed, _T_U31)


# ---------------------------------------------------------------------------
# lear_wcm.dll  (2-arg, Hitag2-style 48-bit LFSR cipher)
# ---------------------------------------------------------------------------
_LEAR_SBOX_A = (1, 0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0)   # @0x712c
_LEAR_SBOX_B = (1, 0, 0, 1, 1, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 0)   # @0x711c
_LEAR_SBOX_F = (1, 1, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0,
                1, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 1, 1, 1, 0)   # @0x713c (32-byte)
_LEAR_FB_T = (0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0)     # @0x715c
_LEAR_KEY = (0x42, 0xf7, 0x8e, 0x11)


def _lear_filter(s):
    idx1 = ((s[1] >> 7) & 1) | (((s[1] >> 3) & 1) << 1) | (((s[1] >> 1) & 1) << 2) | (((s[1] >> 0) & 1) << 3)
    idx2 = ((s[2] >> 6) & 1) | (((s[2] >> 2) & 1) << 1) | (((s[2] >> 0) & 1) << 2) | (((s[3] >> 5) & 1) << 3)
    idx3 = ((s[4] >> 5) & 1) | (((s[5] >> 4) & 1) << 1) | (((s[5] >> 3) & 1) << 2) | (((s[5] >> 1) & 1) << 3)
    idx4 = ((s[0] >> 5) & 1) | (((s[0] >> 4) & 1) << 1) | (((s[0] >> 2) & 1) << 2) | (((s[0] >> 1) & 1) << 3)
    idx5 = ((s[3] >> 3) & 1) | (((s[3] >> 2) & 1) << 1) | (((s[3] >> 0) & 1) << 2) | (((s[4] >> 6) & 1) << 3)
    o1 = _LEAR_SBOX_A[idx1]
    o2 = _LEAR_SBOX_A[idx2]
    o3 = _LEAR_SBOX_B[idx3]
    o4 = _LEAR_SBOX_B[idx4]
    o5 = _LEAR_SBOX_A[idx5]
    return _LEAR_SBOX_F[o4 | (o1 << 1) | (o2 << 2) | (o5 << 3) | (o3 << 4)]


def _lear_shift(state, new_bit):
    for i in range(5):
        state[i] = ((state[i] << 1) & 0xFF) | (state[i + 1] >> 7)
    state[5] = ((state[5] << 1) & 0xFF) | (new_bit & 1)


def unlock_lear_wcm(seed1, seed2=0):
    # seed1 → big-endian bytes[0..3]; seed2 → big-endian bytes[4..7]
    bytes_in = bytearray((
        (seed1 >> 24) & 0xFF, (seed1 >> 16) & 0xFF,
        (seed1 >> 8) & 0xFF,  seed1 & 0xFF,
        (seed2 >> 24) & 0xFF, (seed2 >> 16) & 0xFF,
        (seed2 >> 8) & 0xFF,  seed2 & 0xFF,
    ))
    state = bytearray((0x42, 0xf7, 0x8e, 0x11, 0x6a, 0x05))
    # KSA: 4 outer × 8 inner, mixing key + IV (first 4 bytes)
    for outer in range(4):
        bm = 0x80
        while bm:
            al = _lear_filter(state)
            al ^= 1 if (_LEAR_KEY[outer] & bm) else 0
            al ^= 1 if (bytes_in[outer] & bm) else 0
            _lear_shift(state, al)
            bm >>= 1
    # PRGA: encrypt remaining 4 bytes (0x20 bit iterations) in place
    buf = bytearray(bytes_in[4:8])
    byte_idx = 0
    bit_mask = 0x80
    for _ in range(0x20):
        if byte_idx >= 4:
            break
        b = buf[byte_idx]
        ks = _lear_filter(state)
        input_bit = 1 if (b & bit_mask) else 0
        if (ks ^ input_bit) == 1:
            buf[byte_idx] = b | bit_mask
        else:
            buf[byte_idx] = b & ((~bit_mask) & 0xFF)
        # LFSR feedback bit
        al = (state[1] & 0xfc) ^ state[2]
        al = (al & 0xcf) ^ (state[3] & 0x22)
        al ^= state[0]
        al = (al & 0xb3) ^ (state[5] & 0x73)
        fb = _LEAR_FB_T[(al >> 4) & 0xF] ^ _LEAR_FB_T[al & 0xF]
        _lear_shift(state, fb)
        bit_mask >>= 1
        if bit_mask == 0:
            byte_idx += 1
            bit_mask = 0x80
    return (buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]
