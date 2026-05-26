"""
AlfaOBD Seed-Key Algorithms (reverse-engineered from AlfaOBD.exe)

SOURCE:
    AlfaOBD.exe outer Delphi stub -> EXERESX resource -> inner .NET Framework 4.0
    binary obfuscated with PreEmptive Dotfuscator. Disassembled via ikdasm.
    Target methods: ad::f, ad::ht, ad::ao (all: byte[4] -> byte[4]).

ALGORITHMS:
    ht(seed)  Simple bit-shuffle. No loop. Constants 0x41AA42BB, 0x22BA9A31.
              Triggered by specific ECU name strings.
    f(seed)   XTEA, 64 cycles, delta=0x8F750A1D.
              Key: [0x9B127D51, 0x5BA41903, 0x4FE87269, 0x6BC361D8]
              Triggered when af::ix=true AND af::ge=51 AND af::aj=5.
    ao(seed)  XTEA 64-bit-math variant. Same delta and key values as f,
              but seed is packed big-endian instead of little-endian.
              Triggered for UCONNECT (eEcutype 0x149) or RADIO_FGA (0x14E),
              with af::ge=34 AND af::aj=5 (security access level 5).

VALIDATION:
    No known seed/key test pairs. Algorithms match IL structure and the
    XTEA variants show ideal avalanche (15.97 bits/flip), confirming the
    cipher structure is correct. Byte ordering at output may need tweaking
    if a real test vector reveals a specific endianness convention.
"""

KEY_TABLE = [0x9B127D51, 0x5BA41903, 0x4FE87269, 0x6BC361D8]
DELTA = 0x8F750A1D
ROUNDS = 64


def ht(seed):
    """Simple bit-shuffle seed-key (AlfaOBD ad::ht)."""
    assert len(seed) == 4
    s0, s1, s2, s3 = seed[0], seed[1], seed[2], seed[3]

    v2 = ((s1 << 24) | (s0 << 16) | (s3 << 8) | s2) & 0xFFFFFFFF
    v3 = (((v2 << 11) & 0xFFFFFFFF) | (v2 >> 22)) & 0xFFFFFFFF
    v3 = (v3 ^ 0x41AA42BB) & 0xFFFFFFFF

    v4 = ((s0 << 24) | (s1 << 16) | (s2 << 8) | s3) & 0x22BA9A31
    v4 = (v4 ^ v3) & 0xFFFFFFFF

    return bytes([(v4 >> 24) & 0xFF, (v4 >> 16) & 0xFF, (v4 >> 8) & 0xFF, v4 & 0xFF])


def _xtea(v1, v8):
    """XTEA core: 64 cycles with delta=0x8F750A1D and 4-uint32 key table."""
    sum_ = 0
    for _ in range(ROUNDS):
        inner1 = ((((v8 << 4) & 0xFFFFFFFF) ^ (v8 >> 5)) + v8) & 0xFFFFFFFF
        outer1 = (sum_ + KEY_TABLE[sum_ & 3]) & 0xFFFFFFFF
        v1 = (v1 + (inner1 ^ outer1)) & 0xFFFFFFFF

        sum_ = (sum_ + DELTA) & 0xFFFFFFFF

        inner2 = ((((v1 << 4) & 0xFFFFFFFF) ^ (v1 >> 5)) + v1) & 0xFFFFFFFF
        outer2 = (sum_ + KEY_TABLE[(sum_ >> 11) & 3]) & 0xFFFFFFFF
        v8 = (v8 + (inner2 ^ outer2)) & 0xFFFFFFFF
    return v1, v8


def f(seed):
    """XTEA-based seed-key. Seed packed little-endian.
    Triggered when af::ix=true AND af::ge=51 AND af::aj=5."""
    assert len(seed) == 4
    v1_init = ((seed[3] << 24) | (seed[2] << 16) | (seed[1] << 8) | seed[0]) & 0xFFFFFFFF
    v1, _ = _xtea(v1_init, 0)
    return bytes([(v1 >> 24) & 0xFF, (v1 >> 16) & 0xFF, (v1 >> 8) & 0xFF, v1 & 0xFF])


def ao(seed):
    """XTEA-based seed-key. Seed packed big-endian.
    Triggered for UCONNECT (0x149) or RADIO_FGA (0x14E) at access level 5."""
    assert len(seed) == 4
    v1_init = ((seed[0] << 24) | (seed[1] << 16) | (seed[2] << 8) | seed[3]) & 0xFFFFFFFF
    v1, _ = _xtea(v1_init, 0)
    return bytes([(v1 >> 24) & 0xFF, (v1 >> 16) & 0xFF, (v1 >> 8) & 0xFF, v1 & 0xFF])


if __name__ == "__main__":
    print("=== AlfaOBD Seed-Key Algorithm Reference ===\n")
    print(f"{'Seed':<12s} {'ht()':<12s} {'f()':<12s} {'ao()':<12s}")
    print("-" * 50)
    for seed_hex in ['00000000', '12345678', 'DEADBEEF', 'FFFFFFFF', 'CAFEBABE',
                     'ABCDEF01', '00112233', 'A5A5A5A5']:
        s = bytes.fromhex(seed_hex)
        print(f"{seed_hex:<12s} {ht(s).hex().upper():<12s} {f(s).hex().upper():<12s} {ao(s).hex().upper():<12s}")
