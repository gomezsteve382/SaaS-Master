"""
hwid.py — HWID derivation module (decompiled from FCA_PROXI_Tool.exe)

Reconstructed from PyInstaller-extracted + decompiled .pyc for Python 3.12.
Original file: FCA_PROXI_Tool/_internal/proxi/hwid.cpython-312.pyc

This module computes the 4-segment HWID used for license binding:
  e.g. "2899614-B9E65D4-73F1D98-D6D5DCB"

Each segment is a 7-character uppercase hex string derived from a hardware
source via CRC-32 masked to 28 bits.

DO NOT REDISTRIBUTE — internal bench reference only.
"""
from __future__ import annotations

import binascii
import ctypes
import platform
import re
import struct
import subprocess
import sys
import uuid


# ---------------------------------------------------------------------------
# Anti-analysis guards (present in original)
# ---------------------------------------------------------------------------

def _check_debugger() -> bool:
    """Return True if a debugger is detected (Windows only)."""
    if sys.platform != "win32":
        return False
    try:
        return bool(ctypes.windll.kernel32.IsDebuggerPresent())
    except Exception:
        return False


def _check_vm() -> bool:
    """Return True if running inside a known hypervisor."""
    try:
        import cpuinfo  # type: ignore  # optional — not always present
        brand = cpuinfo.get_cpu_info().get("brand_raw", "").lower()
        if any(x in brand for x in ("vmware", "virtualbox", "kvm", "qemu", "hyper-v")):
            return True
    except Exception:
        pass
    # CPUID leaf 0x40000000 trick
    if sys.platform == "win32":
        try:
            import wmi  # type: ignore
            for item in wmi.WMI().Win32_ComputerSystem():
                model = (item.Model or "").lower()
                if any(x in model for x in ("vmware", "virtualbox", "kvm", "virtual")):
                    return True
        except Exception:
            pass
    return False


# ---------------------------------------------------------------------------
# Hardware ID source readers
# ---------------------------------------------------------------------------

def _cpu_id() -> bytes:
    """CPU identifier string → bytes."""
    if sys.platform == "win32":
        try:
            import wmi  # type: ignore
            for cpu in wmi.WMI().Win32_Processor():
                return (cpu.ProcessorId or "").strip().encode("ascii", "replace")
        except Exception:
            pass
    # Linux fallback
    try:
        with open("/proc/cpuinfo") as f:
            for line in f:
                if line.startswith("model name"):
                    return line.split(":", 1)[1].strip().encode("ascii", "replace")
    except Exception:
        pass
    return b"UNKNOWN_CPU"


def _mb_serial() -> bytes:
    """Motherboard serial number → bytes."""
    if sys.platform == "win32":
        try:
            import wmi  # type: ignore
            for mb in wmi.WMI().Win32_BaseBoard():
                serial = (mb.SerialNumber or "").strip()
                if serial and serial.lower() not in ("to be filled by o.e.m.", "none"):
                    return serial.encode("ascii", "replace")
        except Exception:
            pass
    # Linux fallback
    try:
        result = subprocess.check_output(
            ["sudo", "dmidecode", "-s", "baseboard-serial-number"],
            timeout=3, stderr=subprocess.DEVNULL,
        )
        serial = result.strip().decode("ascii", "replace")
        if serial:
            return serial.encode("ascii", "replace")
    except Exception:
        pass
    return b"UNKNOWN_MB"


def _mac_address() -> bytes:
    """Lowest-numbered active NIC MAC address → 6 bytes."""
    mac_int = uuid.getnode()
    return struct.pack(">Q", mac_int)[2:]  # 6 bytes, big-endian


def _volume_serial() -> bytes:
    """System drive volume serial number → bytes (Windows only)."""
    if sys.platform == "win32":
        try:
            serial = ctypes.c_ulong(0)
            ctypes.windll.kernel32.GetVolumeInformationW(
                "C:\\", None, 0, ctypes.byref(serial), None, None, None, 0
            )
            return struct.pack(">I", serial.value)
        except Exception:
            pass
    # Fallback — use machine-id on Linux
    try:
        with open("/etc/machine-id") as f:
            return f.read().strip().encode("ascii")
    except Exception:
        pass
    return b"\x00\x00\x00\x00"


# ---------------------------------------------------------------------------
# Segment builder
# ---------------------------------------------------------------------------

def _make_segment(raw: bytes) -> str:
    """CRC-32 of raw bytes, masked to 28 bits, formatted as 7 uppercase hex chars."""
    crc = binascii.crc32(raw) & 0x0FFFFFFF
    return format(crc, "07X")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def get_hwid() -> str:
    """
    Compute and return the HWID string for this machine.

    Returns a scrambled placeholder if a debugger or VM is detected.
    """
    if _check_debugger() or _check_vm():
        return "0000000-0000000-0000000-0000000"

    seg1 = _make_segment(_cpu_id())
    seg2 = _make_segment(_mb_serial())
    seg3 = _make_segment(_mac_address())
    seg4 = _make_segment(_volume_serial())
    return f"{seg1}-{seg2}-{seg3}-{seg4}"


def parse_hwid(hwid: str) -> tuple[int, int, int, int] | None:
    """
    Parse a HWID string into its four 28-bit integer segments.
    Returns None if the string is malformed.
    """
    parts = hwid.strip().split("-")
    if len(parts) != 4:
        return None
    try:
        return tuple(int(p, 16) for p in parts)  # type: ignore
    except ValueError:
        return None
