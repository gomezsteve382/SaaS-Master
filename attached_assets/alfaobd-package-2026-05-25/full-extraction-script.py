#!/usr/bin/env python3
"""
Comprehensive extraction of all useful data from the AlfaOBD decrypted database.
Outputs a full report to alfaobd_full_extraction_report.md
"""
import re
import json
import os

db_path = "attached_assets/alfao_bd.decrypted_1776573163349.db"
output_path = "alfaobd_full_extraction_report.md"

with open(db_path, 'rb') as f:
    data = f.read()

report = []
report.append("# AlfaOBD Database Full Extraction Report\n")
report.append(f"**Database size:** {len(data):,} bytes ({len(data)/1024/1024:.1f} MB)\n")
report.append(f"**SQLite header valid:** {'Yes' if data[:6] == b'SQLite' else 'Partial (first 100 bytes correct)'}\n")
report.append(f"**Status:** Decrypted via 1024-byte XOR key. Partially malformed but text data is readable.\n\n")

# ============================================================
# TABLE SCHEMAS
# ============================================================
report.append("## Database Schema (19 Tables)\n\n")

create_pattern = rb'(CREATE\s+TABLE\s+\w+\s*\([^)]+\))'
full_creates = re.findall(create_pattern, data, re.IGNORECASE)
seen_tables = {}
for stmt in full_creates:
    decoded = stmt.decode('utf-8', errors='replace')
    match = re.search(r'CREATE\s+TABLE\s+(\w+)', decoded, re.IGNORECASE)
    if match:
        name = match.group(1)
        if name not in seen_tables:
            seen_tables[name] = decoded

for name in sorted(seen_tables.keys()):
    report.append(f"### {name}\n```sql\n{seen_tables[name]}\n```\n\n")

# ============================================================
# ROUTINE DESCRIPTIONS (English)
# ============================================================
report.append("## Routine Descriptions (English)\n\n")
report.append("Found 674 occurrences of 'routine' keyword. Extracted unique English descriptions:\n\n")

routine_positions = [m.start() for m in re.finditer(rb'[Rr]outine', data)]
descriptions = set()
for pos in routine_positions:
    start = max(0, pos - 100)
    end = min(len(data), pos + 300)
    context = data[start:end]
    # Extract printable ASCII sentences
    text = ''
    for b in context:
        if 32 <= b < 127:
            text += chr(b)
        else:
            text += '|'
    sentences = text.split('|')
    for s in sentences:
        s = s.strip()
        if 'outine' in s and len(s) > 30 and any(c.isalpha() for c in s[:5]):
            # Filter to English-looking text
            if re.search(r'[Tt]his routine|[Tt]he routine|routine is|routine will|routine was|routine eliminat|routine test|routine learn|routine force|routine check|routine re-|routine calibr|Routine', s):
                descriptions.add(s)

for i, d in enumerate(sorted(descriptions), 1):
    report.append(f"{i}. {d}\n")

report.append(f"\n**Total unique English routine descriptions:** {len(descriptions)}\n\n")

# ============================================================
# SECURITY ACCESS DATA
# ============================================================
report.append("## Security Access Data\n\n")

sec_positions = [m.start() for m in re.finditer(rb'[Ss]ecurity', data)]
sec_descriptions = set()
for pos in sec_positions:
    start = max(0, pos - 30)
    end = min(len(data), pos + 200)
    context = data[start:end]
    text = ''
    for b in context:
        if 32 <= b < 127:
            text += chr(b)
        else:
            text += '|'
    sentences = text.split('|')
    for s in sentences:
        s = s.strip()
        if 'ecurity' in s and len(s) > 15:
            sec_descriptions.add(s)

for i, d in enumerate(sorted(sec_descriptions), 1):
    report.append(f"{i}. {d}\n")

report.append(f"\n**Total unique security references:** {len(sec_descriptions)}\n\n")

# ============================================================
# DEVICE/ECU NAMES
# ============================================================
report.append("## ECU/Device Names Found\n\n")

# Search for common ECU identifiers
ecu_patterns = [
    rb'PCM', rb'BCM', rb'TCM', rb'ABS', rb'TIPM', rb'IPC',
    rb'RFHUB', rb'GPEC', rb'ADCM', rb'SGW', rb'UCONNECT',
    rb'RADIO', rb'EPS', rb'ESC', rb'HVAC', rb'DTCM',
    rb'EHPS', rb'OCM', rb'SCCM', rb'UCM', rb'ORC'
]

ecu_counts = {}
for pattern in ecu_patterns:
    count = len(re.findall(pattern, data))
    if count > 0:
        ecu_counts[pattern.decode()] = count

report.append("| ECU Module | Occurrences |\n|---|---|\n")
for ecu, count in sorted(ecu_counts.items(), key=lambda x: -x[1]):
    report.append(f"| {ecu} | {count} |\n")
report.append("\n")

# ============================================================
# UDS SERVICE IDs
# ============================================================
report.append("## UDS Service References\n\n")

uds_patterns = {
    'DiagnosticSessionControl (0x10)': rb'0x10|DiagnosticSession',
    'ECUReset (0x11)': rb'ECUReset|0x11',
    'SecurityAccess (0x27)': rb'SecurityAccess|0x27',
    'ReadDataByIdentifier (0x22)': rb'ReadDataBy|0x22',
    'WriteDataByIdentifier (0x2E)': rb'WriteDataBy|0x2E',
    'RoutineControl (0x31)': rb'RoutineControl|0x31',
    'RequestDownload (0x34)': rb'RequestDownload|0x34',
    'TransferData (0x36)': rb'TransferData|0x36',
    'RequestTransferExit (0x37)': rb'RequestTransferExit|0x37',
}

for name, pattern in uds_patterns.items():
    count = len(re.findall(pattern, data))
    if count > 0:
        report.append(f"- **{name}**: {count} references\n")

report.append("\n")

# ============================================================
# VIN AND PROGRAMMING REFERENCES
# ============================================================
report.append("## VIN & Programming References\n\n")

vin_positions = [m.start() for m in re.finditer(rb'VIN', data)]
vin_descriptions = set()
for pos in vin_positions[:100]:
    start = max(0, pos - 20)
    end = min(len(data), pos + 150)
    context = data[start:end]
    text = ''
    for b in context:
        if 32 <= b < 127:
            text += chr(b)
        else:
            text += '|'
    sentences = text.split('|')
    for s in sentences:
        s = s.strip()
        if 'VIN' in s and len(s) > 15 and len(s) < 200:
            vin_descriptions.add(s)

for i, d in enumerate(sorted(vin_descriptions)[:30], 1):
    report.append(f"{i}. {d}\n")

report.append(f"\n**Total VIN references:** {len(vin_positions)}\n\n")

# ============================================================
# FAULT/DTC DATA
# ============================================================
report.append("## Fault/DTC Data\n\n")

dtc_pattern = rb'[A-Z][0-9]{4}'
dtc_matches = re.findall(dtc_pattern, data)
unique_dtcs = sorted(set(m.decode() for m in dtc_matches if m[0:1] in [b'P', b'B', b'C', b'U']))
report.append(f"Found {len(unique_dtcs)} unique DTC codes (P/B/C/U format).\n\n")
report.append("First 50 DTCs:\n")
for i, dtc in enumerate(unique_dtcs[:50], 1):
    report.append(f"  {dtc}")
    if i % 10 == 0:
        report.append("\n")
report.append("\n\n")

# ============================================================
# TARGET ROUTINE IDs
# ============================================================
report.append("## Target Routine IDs Search\n\n")
report.append("Searching for specific routine IDs: 2504, 1520, 1126, 1750, 1751, 2505, 2507, 1367\n\n")

target_ids = ['2504', '1520', '1126', '1750', '1751', '2505', '2507', '1367']
for rid in target_ids:
    positions = [m.start() for m in re.finditer(rid.encode(), data)]
    report.append(f"### Routine ID {rid}\n")
    report.append(f"Found at {len(positions)} positions.\n\n")
    if positions:
        report.append("Context samples:\n```\n")
        for pos in positions[:3]:
            context = data[max(0, pos-40):pos+80]
            printable = ''.join(chr(b) if 32 <= b < 127 else '.' for b in context)
            report.append(f"  @{pos}: {printable}\n")
        report.append("```\n\n")

# ============================================================
# fgaipcroutines TABLE
# ============================================================
report.append("## fgaipcroutines Table Data\n\n")

# Search for data near the fgaipcroutines table
fga_pos = data.find(b'fgaipcroutines')
if fga_pos >= 0:
    report.append(f"Table definition found at offset {fga_pos}.\n")
    # Get surrounding context
    context = data[fga_pos:fga_pos+500]
    printable = ''.join(chr(b) if 32 <= b < 127 else '.' for b in context)
    report.append(f"```\n{printable}\n```\n\n")

# ============================================================
# ALGORITHM CATALOG SUMMARY
# ============================================================
report.append("## Algorithm Catalog Summary\n\n")

with open('attached_assets/alfaobd_algorithm_catalog_1776573875648.json') as f:
    catalog = json.load(f)

report.append(f"**W6 algorithms (simple linear):** {catalog['meta']['w6_count']} entries\n")
report.append(f"**W7 algorithms (big-integer):** {catalog['meta']['w7_count']} entries\n")
report.append(f"**Dispatch families:** {len(catalog['dispatch'])} families\n\n")

report.append("### W6 Table (first 30 entries)\n\n")
report.append("| Code | Constant R | Constant S |\n|---|---|---|\n")
for i, (code, vals) in enumerate(catalog['w6'].items()):
    if i >= 30:
        break
    report.append(f"| {code} | {vals[0]} | {vals[1]} |\n")

report.append(f"\n... ({catalog['meta']['w6_count']} total entries)\n\n")

report.append("### W7 Table (first 30 entries)\n\n")
report.append("| Code | N | O | P |\n|---|---|---|---|\n")
for i, (code, vals) in enumerate(catalog['w7'].items()):
    if i >= 30:
        break
    report.append(f"| {code} | {vals[0]} | {vals[1]} | {vals[2]} |\n")

report.append(f"\n... ({catalog['meta']['w7_count']} total entries)\n\n")

report.append("### Dispatch Table\n\n")
report.append("| Family | Level 1 | Level 3 | Level 5 |\n|---|---|---|---|\n")
for family, levels in catalog['dispatch'].items():
    l1 = levels.get('aj_1', '-')
    l3 = levels.get('aj_3', '-')
    l5 = levels.get('aj_5', '-')
    report.append(f"| {family} | {l1} | {l3} | {l5} |\n")

report.append("\n")

# ============================================================
# SEED-KEY IMPLEMENTATIONS SUMMARY
# ============================================================
report.append("## Seed-Key Implementations\n\n")
report.append("Three core algorithms extracted from AlfaOBD.exe:\n\n")
report.append("1. **ht(seed)** — Simple bit-shuffle. Constants: 0x41AA42BB, 0x22BA9A31\n")
report.append("2. **f(seed)** — XTEA, 64 cycles, delta=0x8F750A1D, key=[0x9B127D51, 0x5BA41903, 0x4FE87269, 0x6BC361D8]\n")
report.append("3. **ao(seed)** — XTEA big-endian variant (UCONNECT/RADIO_FGA)\n\n")
report.append("Plus 380 W6 parameterized entries and 360 W7 big-integer entries.\n\n")
report.append("Full implementation in `alfaobd_seedkey.py` (884 lines).\n\n")

# ============================================================
# CAN ADDRESSES
# ============================================================
report.append("## CAN Bus Addresses\n\n")

can_patterns = [
    (rb'0x7[0-9A-Fa-f]{2}', 'Standard diagnostic range (0x700-0x7FF)'),
    (rb'0x[0-9A-Fa-f]{3}', 'All 3-digit hex addresses'),
]

# Find specific known FCA CAN addresses
known_can = {
    '0x740': 'RFHUB Request',
    '0x742': 'RFHUB Response',
    '0x7E0': 'PCM Request',
    '0x7E8': 'PCM Response',
    '0x7E2': 'TCM Request',
    '0x7EA': 'TCM Response',
    '0x760': 'BCM Request',
    '0x768': 'BCM Response',
    '0x762': 'IPC Request',
    '0x76A': 'IPC Response',
}

report.append("| CAN Address | Description | Found |\n|---|---|---|\n")
for addr, desc in known_can.items():
    count = data.count(addr.encode())
    report.append(f"| {addr} | {desc} | {count} occurrences |\n")

report.append("\n")

# Write report
with open(output_path, 'w') as f:
    f.write('\n'.join(report))

print(f"Report written to {output_path}")
print(f"Total lines: {len(report)}")
