#!/usr/bin/env python3
"""
Decrypt AlfaOBD's .db file using the recovered 1024-byte XOR key.
Usage: python3 decrypt_alfaobd.py <encrypted.db> <output.db>
"""
import sys

if len(sys.argv) != 3:
    print("Usage: python3 decrypt_alfaobd.py <encrypted.db> <output.db>")
    sys.exit(1)

with open('alfao_bd_xor_key.bin', 'rb') as f:
    key = f.read()
assert len(key) == 1024, f"Expected 1024-byte key, got {len(key)}"

with open(sys.argv[1], 'rb') as f:
    data = f.read()

# XOR decrypt with the 1024-byte repeating key
decrypted = bytearray(len(data))
for i in range(len(data)):
    decrypted[i] = data[i] ^ key[i % 1024]

with open(sys.argv[2], 'wb') as f:
    f.write(bytes(decrypted))

print(f"Decrypted {len(data):,} bytes -> {sys.argv[2]}")
print("Note: Key is recovered via frequency analysis, so ~5-10% of bytes")
print("may be incorrect at offsets where plaintext varies heavily across pages.")
print("The first 100 bytes are guaranteed correct (SQLite header).")
print("Most text and schema data is readable.")
