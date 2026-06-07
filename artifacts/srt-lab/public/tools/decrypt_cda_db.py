#!/usr/bin/env python3
"""
Decrypt databases created by the custom Windows sqlite3_drv.dll codec.

Recovered codec summary:
  * Default bare password selects AES-128, not the hardcoded enable token.
  * The driver sample uses the password b"2Simple2Gu3ss".
  * AES key material is the post-prefix password repeated/cycled to the AES key
    length. For b"2Simple2Gu3ss", the AES-128 key is:
        b"2Simple2Gu3ss2Si"  (hex 3253696d706c65324775337373325369)
  * Per-page encryption is AES in OFB-like mode using AES-ECB encryption as the
    keystream primitive:
        S0 = AES_encrypt(key, IV)
        S1 = AES_encrypt(key, S0)
        ...
        ciphertext = plaintext XOR S
  * IV = little-endian 32-bit page number || first reserve bytes from the page
    trailer, padded with zeros to 16 bytes. With this sample's 12-byte reserve,
    IV = pgno_le32 || 12 reserve bytes.
  * Page 1 bytes 16..23 are intentionally stored plaintext and are excluded by
    XOR-cancelling after the normal page XOR.

Dependency:
    python3 -m pip install pycryptodome

Example:
    python3 decrypt_sqlite_see_custom.py encrypted.db decrypted.db
    python3 decrypt_sqlite_see_custom.py encrypted.db decrypted.db --password 2Simple2Gu3ss
"""

from __future__ import annotations

import argparse
import sqlite3
import struct
import sys
from pathlib import Path
from typing import Tuple

try:
    from Crypto.Cipher import AES
except ImportError as exc:  # pragma: no cover - user environment guard
    raise SystemExit(
        "Missing dependency: pycryptodome. Install it with: "
        "python3 -m pip install pycryptodome"
    ) from exc


DEFAULT_PASSWORD = "2Simple2Gu3ss"
SQLITE_MAGIC = b"SQLite format 3\x00"


class CodecError(ValueError):
    """Raised when input parameters or file layout do not match the codec."""


def parse_password(password: bytes) -> Tuple[str, bytes]:
    """Implement fcn.1006bf70 password parsing and key-byte expansion.

    The DLL recognizes three password syntaxes:
      * rc4:<secret>     -> cipher type 0, 256-byte repeated key stream seed
      * aes128:<secret>  -> cipher type 1, 16-byte AES key
      * aes256:<secret>  -> cipher type 2, 32-byte AES key
      * <secret>         -> default cipher type 1, 16-byte AES key

    Only AES-128/AES-256 are implemented here because the supplied database and
    the driver's own hardcoded sample password use the default AES-128 path.
    """

    cipher = "aes128"
    prefix_len = 0
    key_len = 16

    if len(password) > 4 and password.startswith(b"rc4:"):
        cipher = "rc4"
        prefix_len = 4
        key_len = 256
    elif len(password) > 7 and password.startswith(b"aes128:"):
        cipher = "aes128"
        prefix_len = 7
        key_len = 16
    elif len(password) > 7 and password.startswith(b"aes256:"):
        cipher = "aes256"
        prefix_len = 7
        key_len = 32

    material = password[prefix_len:]
    if not material:
        raise CodecError("Password has no key material after the optional codec prefix")

    # The DLL truncates material longer than the selected key length, then cycles
    # it until exactly key_len bytes have been written into ctx+0x114+prefix_len.
    material = material[:key_len]
    expanded = bytes(material[i % len(material)] for i in range(key_len))
    return cipher, expanded


def detect_page_layout(data: bytes, page_size: int | None, reserve: int | None) -> Tuple[int, int]:
    """Detect page size and reserve size from plaintext bytes in page 1.

    In this codec, page-1 bytes 16..23 remain plaintext. Therefore the normal
    SQLite page-size field at bytes 16..17 and reserved-space field at byte 20
    can be read before decryption.
    """

    if len(data) < 24:
        raise CodecError("Input is too small to contain a SQLite database page")

    if page_size is None:
        detected = struct.unpack(">H", data[16:18])[0]
        if detected == 1:
            detected = 65536
        page_size = detected

    if reserve is None:
        reserve = data[20]

    if page_size < 512 or page_size > 65536 or page_size & (page_size - 1):
        raise CodecError(f"Invalid or unsupported page size detected: {page_size}")
    if reserve < 0 or reserve >= page_size:
        raise CodecError(f"Invalid reserve byte count: {reserve}")
    if len(data) % page_size != 0:
        raise CodecError(
            f"Input size {len(data)} is not an exact multiple of page size {page_size}"
        )

    return page_size, reserve


def aes_ofb_keystream(key: bytes, iv: bytes, length: int) -> bytes:
    """Generate the DLL's AES-OFB-like keystream.

    The AES block transform is always encryption; the same function is used for
    encryption and decryption because the page data is XORed with the keystream.
    """

    cipher = AES.new(key, AES.MODE_ECB)
    out = bytearray()
    block = cipher.encrypt(iv)
    while len(out) < length:
        out.extend(block)
        block = cipher.encrypt(block)
    return bytes(out[:length])


def crypt_page(page: bytes, pgno: int, key: bytes, page_size: int, reserve: int) -> bytes:
    """Encrypt or decrypt one page. The operation is symmetric."""

    usable = page_size - reserve
    iv_tail = page[usable : usable + min(reserve, 12)]
    iv = struct.pack("<I", pgno) + iv_tail
    iv = iv.ljust(16, b"\x00")[:16]

    stream = aes_ofb_keystream(key, iv, usable)
    body = bytearray(a ^ b for a, b in zip(page[:usable], stream))

    # Page 1 special case at 0x1006bf18..0x1006bf53: after the normal XOR,
    # bytes 16..23 are XORed with the same keystream again, leaving them as they
    # appeared in the file. This preserves the visible SQLite header fields.
    if pgno == 1 and usable >= 24:
        body[16:24] = page[16:24]

    return bytes(body) + page[usable:page_size]


def decrypt_database(
    input_path: Path,
    output_path: Path,
    password: bytes,
    page_size: int | None = None,
    reserve: int | None = None,
    validate: bool = True,
) -> None:
    data = input_path.read_bytes()
    page_size, reserve = detect_page_layout(data, page_size, reserve)
    cipher_name, key = parse_password(password)

    if cipher_name == "rc4":
        raise CodecError(
            "This script implements the recovered AES page codec. The rc4: legacy path "
            "was identified in the DLL but is not needed for the supplied database."
        )
    if cipher_name not in {"aes128", "aes256"}:
        raise CodecError(f"Unsupported cipher: {cipher_name}")

    out = bytearray()
    for offset in range(0, len(data), page_size):
        pgno = offset // page_size + 1
        out.extend(crypt_page(data[offset : offset + page_size], pgno, key, page_size, reserve))

    output_path.write_bytes(out)

    if validate:
        if not bytes(out).startswith(SQLITE_MAGIC):
            raise CodecError(
                "Output does not start with a SQLite header. The password, page size, "
                "or reserve byte count is probably wrong."
            )
        con = sqlite3.connect(str(output_path))
        try:
            result = con.execute("PRAGMA integrity_check").fetchone()[0]
            if result.lower() != "ok":
                raise CodecError(f"SQLite integrity_check failed: {result}")
        finally:
            con.close()

    print(f"Wrote {output_path}")
    print(f"cipher={cipher_name} key={key.hex()} page_size={page_size} reserve={reserve}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Decrypt databases from the recovered sqlite3_drv.dll AES codec."
    )
    parser.add_argument("input", type=Path, help="Encrypted .db file")
    parser.add_argument("output", type=Path, help="Output decrypted .db file")
    parser.add_argument(
        "--password",
        default=DEFAULT_PASSWORD,
        help=f"Codec password; default: {DEFAULT_PASSWORD!r}",
    )
    parser.add_argument("--page-size", type=int, default=None, help="Override page size")
    parser.add_argument("--reserve", type=int, default=None, help="Override reserve bytes")
    parser.add_argument(
        "--no-validate",
        action="store_true",
        help="Skip SQLite header and PRAGMA integrity_check validation",
    )
    args = parser.parse_args(argv)

    try:
        decrypt_database(
            args.input,
            args.output,
            args.password.encode("utf-8"),
            page_size=args.page_size,
            reserve=args.reserve,
            validate=not args.no_validate,
        )
        return 0
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
