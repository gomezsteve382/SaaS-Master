#!/usr/bin/env python3
"""Extract table names and data from the partially-decrypted AlfaOBD database."""
import re
import sys

db_path = "/home/ubuntu/alfaobd-extracted/attached_assets/alfao_bd.decrypted_1776573163349.db"

with open(db_path, 'rb') as f:
    data = f.read()

print(f"Database size: {len(data):,} bytes ({len(data)/1024/1024:.1f} MB)")
print(f"SQLite header: {data[:16]}")
print()

# Extract CREATE TABLE statements
create_pattern = rb'CREATE\s+TABLE\s+(\w+)\s*\('
tables = re.findall(create_pattern, data, re.IGNORECASE)
unique_tables = sorted(set(t.decode('utf-8', errors='replace') for t in tables))

print(f"Found {len(unique_tables)} unique tables:")
for t in unique_tables:
    print(f"  - {t}")

print(f"\n{'='*80}")
print("FULL CREATE TABLE STATEMENTS:")
print(f"{'='*80}\n")

# Extract full CREATE TABLE statements
full_creates = re.findall(rb'(CREATE\s+TABLE\s+\w+\s*\([^)]+\))', data, re.IGNORECASE)
seen = set()
for stmt in full_creates:
    decoded = stmt.decode('utf-8', errors='replace')
    # Get table name
    match = re.search(r'CREATE\s+TABLE\s+(\w+)', decoded, re.IGNORECASE)
    if match:
        name = match.group(1)
        if name not in seen:
            seen.add(name)
            print(f"\n--- {name} ---")
            print(decoded[:500])

print(f"\n\n{'='*80}")
print("SEARCHING FOR ROUTINE IDs (2504, 1520, 1126, 1750, 1751, 2505, 2507, 1367)")
print(f"{'='*80}\n")

# Search for the specific routine IDs as strings
target_ids = ['2504', '1520', '1126', '1750', '1751', '2505', '2507', '1367']
for rid in target_ids:
    # Search as ASCII string
    positions = [m.start() for m in re.finditer(rid.encode(), data)]
    if positions:
        print(f"\n  ID {rid} found at {len(positions)} positions:")
        for pos in positions[:5]:
            context = data[max(0, pos-30):pos+50]
            # Clean up for display
            printable = ''.join(chr(b) if 32 <= b < 127 else '.' for b in context)
            print(f"    @{pos}: ...{printable}...")

print(f"\n\n{'='*80}")
print("SEARCHING FOR 'routine' keyword")
print(f"{'='*80}\n")

routine_positions = [m.start() for m in re.finditer(rb'[Rr]outine', data)]
print(f"Found 'routine' at {len(routine_positions)} positions")
for pos in routine_positions[:20]:
    context = data[max(0, pos-10):pos+60]
    printable = ''.join(chr(b) if 32 <= b < 127 else '.' for b in context)
    print(f"  @{pos}: {printable}")

print(f"\n\n{'='*80}")
print("SEARCHING FOR 'security' keyword")
print(f"{'='*80}\n")

sec_positions = [m.start() for m in re.finditer(rb'[Ss]ecurity', data)]
print(f"Found 'security' at {len(sec_positions)} positions")
for pos in sec_positions[:20]:
    context = data[max(0, pos-10):pos+80]
    printable = ''.join(chr(b) if 32 <= b < 127 else '.' for b in context)
    print(f"  @{pos}: {printable}")
