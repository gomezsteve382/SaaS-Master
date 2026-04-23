"""
SRT Lab CRC algorithms.

Port of artifacts/srt-lab/src/lib/crc.js from the Replit monorepo (2026-04-18).
These are the verified CRC primitives the SRT Lab parser/patcher uses to 
validate and compute module checksums.

From replit.md "Verified CRC Algorithms":
  BCM D-FLASH:   CRC-16 CCITT-FALSE (poly 0x1021, init 0xFFFF)
  95640 EEPROM:  CRC-8 Forward      (poly 0x42,   init 0x2E)
  RFHUB Gen1:    CRC-8 reflected    (poly 0xA0,   init 0x54)
  RFHUB Gen2 VIN: XOR-17 ^ MAGIC (MAGIC ∈ {0xDB (2020+ Redeye), 0x87 (earlier Gen2)})
  RFHUB Gen2 SEC16: CRC-8 (poly 0x65, init 0xBF) over 16 data bytes
  GPEC2A:         No CRC (plain ASCII VIN storage)
"""


def crc16(data, init=0xFFFF):
    """CRC-16/CCITT-FALSE (a.k.a. CRC-16/AUTOSAR).
    
    BCM D-FLASH primary + partial VIN slots use this with init=0xFFFF.
    95640 BCM-SEC16 mirror region also uses this. Generic poly=0x1021.
    """
    crc = init
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) if (crc & 0x8000) else (crc << 1)
            crc &= 0xFFFF
    return crc


def crc8_42(data):
    """CRC-8 forward (poly 0x42, init 0x2E). 95640 EEPROM algorithm."""
    crc = 0x2E
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = ((crc << 1) ^ 0x42) & 0xFF if (crc & 0x80) else (crc << 1) & 0xFF
    return crc


def crc8rf(data):
    """CRC-8 reflected (poly 0xA0, init 0x54). RFHUB Gen1 VIN checksum."""
    crc = 0x54
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = ((crc >> 1) ^ 0xA0) if (crc & 1) else (crc >> 1)
    return crc & 0xFF


def crc8_65(data):
    """CRC-8 (poly 0x65, init 0xBF). RFHUB Gen2 SEC16 (16 data bytes) algorithm."""
    crc = 0xBF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = ((crc << 1) ^ 0x65) & 0xFF if (crc & 0x80) else (crc << 1) & 0xFF
    return crc


# ----------- RFHUB Gen2 VIN checksum -----------
# Gen2 RFHUB stores VIN byte-reversed, then a 1-byte checksum.
# CS = XOR of all 17 raw stored bytes, XORed with a per-variant magic.
# Known magics:
#   0xDB — 2020+ Redeye
#   0x87 — earlier Gen2
RFH_GEN2_VIN_CS_KNOWN_MAGICS = [0xDB, 0x87]


def rfh_gen2_vin_cs(raw17, magic=0xDB):
    """Compute RFHUB Gen2 VIN checksum.
    
    raw17: the 17 raw (byte-reversed) VIN bytes as stored in EEPROM.
    magic: 0xDB (2020+ Redeye) or 0x87 (earlier Gen2).
    """
    x = 0
    for b in raw17:
        x ^= b
    return x ^ magic


def rfh_gen2_detect_magic(raw17, stored_cs):
    """Derive the magic constant from a known-valid slot.
    
    Given the raw stored 17 bytes and the stored checksum byte, returns the 
    magic that produces that checksum. Usually 0xDB or 0x87 — anything else 
    indicates a corrupt slot or unknown variant.
    """
    x = 0
    for b in raw17:
        x ^= b
    return stored_cs ^ x


def rfh_sec16_cs(raw16):
    """Gen2 RFHUB SEC16 checksum.
    
    Layout: byte[0] (off+16) = CRC8 result, byte[1] (off+17) = 0x00 always.
    Returns the 2-byte big-endian CS as a single 16-bit integer matching 
    (data[off+16] << 8) | data[off+17].
    """
    return (crc8_65(raw16) << 8) | 0x00


# ----------- RFHUB VIN-specific poly/init table -----------
# Per-RFHUB-variant CRC-16 configurations observed on real dumps.
# Keyed by the VIN of a representative dump (NOT a per-VIN algorithm — the VIN
# string happens to be the dictionary key in the Replit source). Apply
# crc16_generic with the poly/init values below when working with these
# specific RFHUB hardware variants.
RFHUB_KNOWN_ALGOS = {
    '2C3CDXKT3FH796320': {'poly': 0x589B, 'init': 0xFFFF},
    '2B3CJ4DV6AH300549': {'poly': 0x8C5B, 'init': 0xFFFF},
    '2B3CJ5DT2BH590794': {'poly': 0x535D, 'init': 0x0000},
    '2C3CDZFK3HH506737': {'poly': 0x71DE, 'init': 0x4625},
    '2C3CDZC99HH514330': {'poly': 0x1189, 'init': 0x0C99},
    '2C3CDXGJ1MH539855': {'poly': 0x5F08, 'init': 0x0C99},
}


def crc16_generic(data, poly, init):
    """CRC-16 with arbitrary poly and init — for RFHUB_KNOWN_ALGOS lookups."""
    crc = init
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ poly) if (crc & 0x8000) else (crc << 1)
            crc &= 0xFFFF
    return crc


if __name__ == '__main__':
    print("SRT Lab CRC algorithms — sample outputs")
    print("=" * 60)
    
    vin = b'2C3CDZFJXKH741460'
    print(f"\nTest VIN: {vin.decode()}")
    print(f"  crc16 (CCITT-FALSE):     0x{crc16(vin):04X}")
    print(f"  crc8_42:                 0x{crc8_42(vin):02X}")
    print(f"  crc8rf (reflected):      0x{crc8rf(vin):02X}")
    print(f"  crc8_65:                 0x{crc8_65(vin):02X}")
    
    # Partial VIN for BCM backup slots
    tail = b'KH741460'
    print(f"\nPartial VIN tail (8 chars): {tail.decode()}")
    print(f"  crc16 (CCITT-FALSE):     0x{crc16(tail):04X}")
    
    # Sample 16-byte SEC16 block for Gen2 RFHUB
    test16 = bytes([0x11,0x22,0x33,0x44,0x55,0x66,0x77,0x88,
                    0x99,0xAA,0xBB,0xCC,0xDD,0xEE,0xFF,0x00])
    print(f"\nRFHUB Gen2 SEC16 test (16B):")
    print(f"  crc8_65 byte:            0x{crc8_65(test16):02X}")
    print(f"  rfh_sec16_cs (16-bit):   0x{rfh_sec16_cs(test16):04X}")
    
    # Sample Gen2 VIN CS (byte-reversed 17 bytes)
    vin_rev = vin[::-1]
    print(f"\nRFHUB Gen2 VIN CS test (byte-reversed 17B):")
    print(f"  magic=0xDB (2020+ Redeye):   0x{rfh_gen2_vin_cs(vin_rev, 0xDB):02X}")
    print(f"  magic=0x87 (earlier Gen2):   0x{rfh_gen2_vin_cs(vin_rev, 0x87):02X}")
    
    # RFHUB variant table lookup
    print(f"\nRFHUB_KNOWN_ALGOS entries (per-variant CRC-16 config):")
    for k, cfg in RFHUB_KNOWN_ALGOS.items():
        c = crc16_generic(vin, cfg['poly'], cfg['init'])
        print(f"  {k}: poly=0x{cfg['poly']:04X} init=0x{cfg['init']:04X} → test CRC=0x{c:04X}")
