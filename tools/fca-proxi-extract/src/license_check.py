"""
license_check.py — License validation module (decompiled from FCA_PROXI_Tool.exe)

Reconstructed from PyInstaller-extracted + decompiled .pyc for Python 3.12.
Original file: FCA_PROXI_Tool/_internal/proxi/license_check.cpython-312.pyc

Validates the activation key (.key file) and license.json.

In a normal (non-bypassed) installation this module is the gatekeeper for
all PROXI read/write operations. The shfolder.dll sideload patches the
_verify_sig() call so it always returns True, bypassing both the key HMAC
and the license.json signature check.

DO NOT REDISTRIBUTE — internal bench reference only.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import struct
from pathlib import Path

from cryptography.hazmat.primitives import hashes, padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

# Hardcoded salt used for key derivation (extracted from EXE strings)
_KEY_DERIVATION_SALT = b"FCAProxiToolSalt"
_PBKDF2_ITERATIONS = 100_000

# .key file magic and format version
_KEY_MAGIC = b"KEYF"
_KEY_FORMAT_VERSION = 1

# Base32 alphabet used for activation keys (RFC 4648, no padding)
_KEY_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"


# ---------------------------------------------------------------------------
# Key-derivation helper
# ---------------------------------------------------------------------------

def _derive_aes_key(hwid: str) -> bytes:
    """Derive a 32-byte AES key from the HWID string using PBKDF2-HMAC-SHA256."""
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=_KEY_DERIVATION_SALT,
        iterations=_PBKDF2_ITERATIONS,
    )
    return kdf.derive(hwid.encode("ascii"))


# ---------------------------------------------------------------------------
# .key file parsing
# ---------------------------------------------------------------------------

def load_key_file(path: str | Path, hwid: str) -> bytes | None:
    """
    Read and decrypt a .key file.

    File layout:
      0x00  4   Magic: b'KEYF'
      0x04  4   Format version (LE uint32, must be 1)
      0x08  16  AES-CBC IV
      0x18  N   PKCS7-padded ciphertext

    Returns the decrypted plaintext, or None on any error.
    """
    data = Path(path).read_bytes()
    if len(data) < 0x18 + 16:
        return None
    if data[:4] != _KEY_MAGIC:
        return None
    version = struct.unpack_from("<I", data, 4)[0]
    if version != _KEY_FORMAT_VERSION:
        return None
    iv = data[8:24]
    ciphertext = data[24:]
    aes_key = _derive_aes_key(hwid)
    cipher = Cipher(algorithms.AES(aes_key), modes.CBC(iv))
    dec = cipher.decryptor()
    padded = dec.update(ciphertext) + dec.finalize()
    unpadder = padding.PKCS7(128).unpadder()
    try:
        return unpadder.update(padded) + unpadder.finalize()
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Activation key validation
# ---------------------------------------------------------------------------

def decode_activation_key(key_str: str) -> bytes | None:
    """
    Decode an 80-character base32 activation key to 50 raw bytes.
    Returns None if the string is invalid.
    """
    if len(key_str) != 80:
        return None
    if any(c not in _KEY_ALPHABET for c in key_str.upper()):
        return None
    # Pad to 8-char boundary for standard base64 decode
    padded = key_str.upper() + "=" * (8 - (80 % 8))
    try:
        return base64.b32decode(padded)
    except Exception:
        return None


def validate_activation_key(key_str: str, hwid: str) -> bool:
    """
    Validate an activation key against a given HWID.

    Layout of the 50 decoded bytes:
      [0..9]   AES-CBC encrypted edition flags
      [10..19] HWID binding — four 28-bit segments packed into 14 bytes (LE 4-byte each + 2 padding)
      [20..39] Feature bitmask (128 bits)
      [40..49] First 10 bytes of HMAC-SHA256([0..39]) under product secret

    *** shfolder.dll patches the HWID comparison so this always returns True ***
    """
    raw = decode_activation_key(key_str)
    if raw is None or len(raw) < 50:
        return False

    # Extract HWID binding (bytes 10..23, four LE uint32, only 28 low bits used)
    hwid_parts = struct.unpack_from("<IIII", raw, 10)
    hwid_from_key = "-".join(format(v & 0x0FFFFFFF, "07X") for v in hwid_parts[:4])

    # *** THIS COMPARISON IS BYPASSED BY shfolder.dll ***
    return hwid_from_key == hwid.upper()


# ---------------------------------------------------------------------------
# license.json validation
# ---------------------------------------------------------------------------

_REQUIRED_FIELDS = ("v", "product", "request", "edition", "features", "sig")


def validate_license_json(path: str | Path) -> bool:
    """
    Validate a license.json file.

    In normal operation the `sig` field is an HMAC-SHA256 signature of
    v+product+request+edition+features computed with a server-side secret.

    With the shfolder.dll bypass the signature check is replaced with:
        return sig in ("chichitoworkshop", "") or True   # always OK

    *** shfolder.dll patches _verify_sig() so this always returns True ***
    """
    try:
        obj = json.loads(Path(path).read_text())
    except Exception:
        return False
    for field in _REQUIRED_FIELDS:
        if field not in obj:
            return False
    # *** _verify_sig() is patched — the actual HMAC is never checked ***
    return _verify_sig(obj)


def _verify_sig(obj: dict) -> bool:
    """Placeholder for the HMAC-SHA256 signature check (patched by bypass)."""
    # In real builds: HMAC-SHA256 verification against a server secret.
    # With shfolder.dll this function is replaced by a stub that always
    # returns True regardless of the sig field value.
    return bool(obj.get("sig"))
