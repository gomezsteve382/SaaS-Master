"""
proxi_record.py — PROXI record parser / serializer (decompiled from FCA_PROXI_Tool.exe)

Reconstructed from PyInstaller-extracted + decompiled .pyc for Python 3.12.
Original file: FCA_PROXI_Tool/_internal/proxi/proxi_record.cpython-312.pyc

A PROXI record is a vehicle-specific configuration blob stored in the BCM,
exchanged via UDS 0x22/0x2E at DID 0xFD01 (pre-SGW) or 0xFD20 (SGW).

DO NOT REDISTRIBUTE — internal bench reference only.
"""
from __future__ import annotations

import struct
from dataclasses import dataclass, field
from typing import Dict, List, Optional


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PROXI_DID_PRE_SGW = 0xFD01
PROXI_DID_SGW = 0xFD20

SECTION_NAMES: Dict[int, str] = {
    0x01: "Body",
    0x02: "Powertrain",
    0x03: "Chassis",
    0x04: "Occupant Restraint",
    0x05: "Electrical",
    0x06: "HVAC",
    0x07: "Infotainment",
    0x08: "Telematics",
    0x10: "Market / Region",
    0x20: "Customer Options",
    0x30: "Dealer Options",
}


# ---------------------------------------------------------------------------
# CRC
# ---------------------------------------------------------------------------

def crc16_ccitt_false(data: bytes | bytearray) -> int:
    """CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF)."""
    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class ProxiSection:
    id: int
    payload: bytes

    @property
    def name(self) -> str:
        return SECTION_NAMES.get(self.id, f"Section 0x{self.id:02X}")

    def __len__(self) -> int:
        return 2 + len(self.payload)  # id byte + len byte + payload


@dataclass
class ProxiRecord:
    format_version: int
    sections: List[ProxiSection] = field(default_factory=list)

    # ---------------------------------------------------------------------------
    # Parse
    # ---------------------------------------------------------------------------

    @classmethod
    def parse(cls, data: bytes | bytearray | memoryview) -> "ProxiRecord":
        """
        Parse a PROXI binary blob.

        Header (4 bytes, all LE):
          [0]  section_count  uint8
          [1]  format_version uint8
          [2-3] total_length  uint16 LE  (includes header + CRC)

        Sections follow immediately after the header.
        Last 2 bytes are CRC-16/CCITT-FALSE over [0 .. total_length-3].
        """
        data = bytes(data)
        if len(data) < 6:
            raise ValueError(f"Too short: {len(data)} bytes")

        section_count = data[0]
        format_version = data[1]
        total_length = struct.unpack_from("<H", data, 2)[0]

        if len(data) < total_length:
            raise ValueError(
                f"Buffer ({len(data)} B) shorter than declared total_length ({total_length} B)"
            )

        payload = data[:total_length]
        stored_crc = struct.unpack_from(">H", payload, total_length - 2)[0]
        computed_crc = crc16_ccitt_false(payload[: total_length - 2])
        if stored_crc != computed_crc:
            raise ValueError(
                f"CRC mismatch: stored=0x{stored_crc:04X} computed=0x{computed_crc:04X}"
            )

        sections: List[ProxiSection] = []
        cursor = 4
        for _ in range(section_count):
            if cursor + 2 > total_length - 2:
                break
            sec_id = payload[cursor]
            sec_len = payload[cursor + 1]
            cursor += 2
            if cursor + sec_len > total_length - 2:
                raise ValueError(
                    f"Section 0x{sec_id:02X} claims {sec_len} bytes but only "
                    f"{total_length - 2 - cursor} remain"
                )
            sections.append(ProxiSection(id=sec_id, payload=payload[cursor : cursor + sec_len]))
            cursor += sec_len

        rec = cls(format_version=format_version, sections=sections)
        return rec

    # ---------------------------------------------------------------------------
    # Serialize
    # ---------------------------------------------------------------------------

    def serialize(self) -> bytes:
        """
        Serialize this record to bytes, recomputing the CRC.
        Round-trip: parse(data).serialize() == data for any well-formed record.
        """
        sections_blob = b"".join(
            bytes([s.id, len(s.payload)]) + s.payload for s in self.sections
        )
        total_length = 4 + len(sections_blob) + 2
        header = bytes([len(self.sections), self.format_version]) + struct.pack("<H", total_length)
        body = header + sections_blob
        crc = crc16_ccitt_false(body)
        return body + struct.pack(">H", crc)

    # ---------------------------------------------------------------------------
    # Helpers
    # ---------------------------------------------------------------------------

    def get_section(self, section_id: int) -> Optional[ProxiSection]:
        for s in self.sections:
            if s.id == section_id:
                return s
        return None

    def set_section(self, section_id: int, payload: bytes) -> None:
        for s in self.sections:
            if s.id == section_id:
                s.payload = payload
                return
        self.sections.append(ProxiSection(id=section_id, payload=payload))

    def __repr__(self) -> str:
        names = [f"0x{s.id:02X}({s.name})" for s in self.sections]
        return f"ProxiRecord(v={self.format_version}, sections=[{', '.join(names)}])"
