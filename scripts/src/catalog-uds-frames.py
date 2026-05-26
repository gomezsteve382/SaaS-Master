#!/usr/bin/env python3
"""Catalog UDS frames extracted by hunt_v3.py — dedupe, categorize, verify
   CDA-known frames, and emit a JSON suitable for downstream code generation.
"""
import json
from collections import defaultdict, Counter

SRC = "/tmp/exe/uds_frames_v3.json"
OUT = "/tmp/exe/uds_dispatch_catalog.json"

UDS_SID_NAMES = {
    0x10: "DSC", 0x11: "ECUReset", 0x14: "ClearDTC", 0x19: "ReadDTC",
    0x22: "RDBI", 0x27: "SecurityAccess", 0x2E: "WDBI", 0x31: "RoutineControl",
    0x34: "RequestDownload", 0x36: "TransferData", 0x37: "ExitTransfer", 0x3E: "TesterPresent",
    0x07: "KWP_ReadFault", 0x18: "KWP_ReadDTCByStatus",
}

# Known frames we MUST see (CDA-verified)
CDA_KNOWN = {
    "22 20 23": "PROXI Read (CDA-verified)",
    "2E 20 23": "PROXI Write (CDA-verified)",
    "22 10 2A": "EOL Read (CDA-verified)",
    "22 40 A2": "EOL Read alt (CDA-verified)",
}

d = json.load(open(SRC))

# Aggregate: hex-string of frame bytes (omit None placeholders) -> count, methods seen in
unique_frames = defaultdict(lambda: {"count": 0, "methods": Counter(), "sid": None, "len": 0, "bytes": []})

for method_idx, info in d.items():
    for f in info["frames"]:
        bs = f["bytes_hex"]
        # Skip frames with None gaps for the catalog (treat as malformed-extraction)
        if any(b is None for b in bs):
            continue
        key = " ".join(b[2:] for b in bs)  # "31 01 02 CB"
        unique_frames[key]["count"] += 1
        unique_frames[key]["methods"][f"Method[{method_idx}]:{info['name']}"] += 1
        unique_frames[key]["sid"] = f["sid"]
        unique_frames[key]["len"] = len(bs)
        unique_frames[key]["bytes"] = [int(b, 16) for b in bs]

print(f"Total unique UDS frames: {len(unique_frames)}")
print()

# CDA-known verification
print("CDA-known frame verification:")
for k, label in CDA_KNOWN.items():
    if k in unique_frames:
        print(f"  ✓ '{k}' ({label}): {unique_frames[k]['count']}x")
    else:
        # Look for prefix match
        prefix_hits = [u for u in unique_frames if u.startswith(k)]
        if prefix_hits:
            print(f"  ⚠ '{k}' ({label}): not exact; prefix matches: {prefix_hits[:3]}")
        else:
            print(f"  ✗ '{k}' ({label}): NOT FOUND")

# Group by SID
by_sid = defaultdict(list)
for k, v in unique_frames.items():
    by_sid[v["sid"]].append((k, v))

print()
print("By UDS service (unique frame count):")
for sid in sorted(by_sid.keys()):
    name = UDS_SID_NAMES.get(sid, f"?0x{sid:02X}")
    print(f"  {name:<20} {len(by_sid[sid]):5d} unique frames")

# For RoutineControl: group by RID
print()
print("RoutineControl RID distribution (first byte after subfunction):")
rc_rids = Counter()
for k, v in by_sid[0x31]:
    if v["len"] >= 4:
        rid_hi = v["bytes"][2]
        rid_lo = v["bytes"][3]
        rid_word = (rid_hi << 8) | rid_lo
        rc_rids[rid_word] += 1
print(f"  Unique RIDs: {len(rc_rids)}")
print(f"  Top 20 RIDs by frame variants:")
for rid, cnt in rc_rids.most_common(20):
    print(f"    0x{rid:04X}: {cnt} frame variants")

# Output
output = {
    "meta": {
        "source": "AlfaOBD.exe v2.5.7.0 IL extraction",
        "method_count_scanned": len(d),
        "frames_unique": len(unique_frames),
        "frames_by_sid": {UDS_SID_NAMES.get(sid, f"0x{sid:02X}"): len(frames) for sid, frames in by_sid.items()},
        "cda_known_verification": {
            k: ("present" if k in unique_frames else "not found")
            for k in CDA_KNOWN
        },
        "extraction_method": "ldloc.X; ldc.i4 idx; ldc.i4 val; stelem.i1 pattern scan over IL",
    },
    "frames": [
        {
            "hex": k,
            "bytes": v["bytes"],
            "sid": v["sid"],
            "sid_name": UDS_SID_NAMES.get(v["sid"], "?"),
            "len": v["len"],
            "occurrences": v["count"],
            "methods": [f"{n} x{c}" for n, c in v["methods"].most_common(3)],
        }
        for k, v in sorted(unique_frames.items(), key=lambda x: (x[1]["sid"], x[0]))
    ],
}

with open(OUT, "w") as f:
    json.dump(output, f, indent=1)
print(f"\nWrote {OUT}")
