#!/usr/bin/env python3
"""Cross-match dispatch context strings against the routine catalog idx[2] field
(ECU numeric code) to associate each UDS frame with its routine_id(s)."""
import json
from collections import defaultdict

CATALOG_IN = "/tmp/exe/all_method_routine_catalog.json"
DISPATCH_IN = "/tmp/exe/full_dispatch_table.json"
ALFAOBD_DATA = "artifacts/srt-lab/src/lib/alfaobdData.generated.js"
OUT = "/tmp/exe/dispatch_to_routine_resolved.json"

# Load catalog
catalog = json.load(open(CATALOG_IN))["routines"]
print(f"Routine catalog: {len(catalog)} routines")

# Load DIAG_NAMES from alfaobdData.generated.js
import re
with open(ALFAOBD_DATA) as f:
    src = f.read()
m = re.search(r'export const DIAG_NAMES = (\{.*?\n\});', src, re.DOTALL)
diag_names = json.loads(m.group(1))
print(f"DIAG_NAMES: {len(diag_names)} entries")

# Build lookups: idx[2] (ECU numeric code) -> [routine_ids]
by_idx2 = defaultdict(list)
by_idx0 = defaultdict(list)  # idx[0] is ECU code/family
by_idx1 = defaultdict(list)  # idx[1] is ECU friendly name

for rid_str, fields in catalog.items():
    rid = int(rid_str)
    if "2" in fields:
        v = fields["2"].strip().strip(",")
        # Multi-value idx[2] sometimes (e.g., "55732,64")
        for piece in v.replace(",", " ").split():
            piece = piece.strip()
            if piece:
                by_idx2[piece].append(rid)
    if "0" in fields:
        by_idx0[fields["0"]].append(rid)
    if "1" in fields:
        by_idx1[fields["1"]].append(rid)

print(f"Unique idx[2] (ECU code) values: {len(by_idx2)}")
print(f"Unique idx[0] (ECU family) values: {len(by_idx0)}")
print(f"Unique idx[1] (ECU friendly) values: {len(by_idx1)}")

# Load dispatch records
disp = json.load(open(DISPATCH_IN))["dispatch"]
print(f"\nDispatch records: {len(disp)}")

# Match each dispatch context against idx[2]
matched_dispatch = []
for r in disp:
    if any(b is None for b in r.get("frame_hex", "").split()):
        continue
    matched_routines = set()
    matched_via = []
    for c in r["context"]:
        text = c["text"]
        if not isinstance(text, str): continue
        # Try idx[2] match (numeric ECU code)
        if text in by_idx2:
            for rid in by_idx2[text]:
                matched_routines.add(rid)
                matched_via.append((rid, "idx2", text))
        # Try idx[0] match (ECU family code)
        if text in by_idx0:
            for rid in by_idx0[text]:
                matched_routines.add(rid)
                matched_via.append((rid, "idx0", text))
        # Try idx[1] match (ECU friendly name)
        if text in by_idx1:
            for rid in by_idx1[text]:
                matched_routines.add(rid)
                matched_via.append((rid, "idx1", text))

    if matched_routines:
        # Get descriptions
        rid_with_desc = []
        for rid in sorted(matched_routines):
            desc = diag_names.get(str(rid), "<no description>")
            rid_with_desc.append({"rid": rid, "description": desc[:120]})
        matched_dispatch.append({
            "method": r["method"],
            "frame_hex": r["frame_hex"],
            "sid": r["sid"],
            "sid_name": r["sid_name"],
            "matched_routine_count": len(matched_routines),
            "matched_routines": rid_with_desc,
            "matched_via": matched_via[:10],
            "context": r["context"][:5],
        })

print(f"\nDispatch records with routine match: {len(matched_dispatch)}")

# Filter to single-routine matches (unambiguous)
unambig = [r for r in matched_dispatch if r["matched_routine_count"] == 1]
print(f"Unambiguous (single-routine) matches: {len(unambig)}")

# Tier-1 specific
tier1 = {1126, 1367, 1520, 1750, 1751, 2504, 2505, 2507, 2508}
tier1_hits = []
for r in matched_dispatch:
    matched_rids = {m["rid"] for m in r["matched_routines"]}
    if matched_rids & tier1:
        tier1_hits.append(r)
print(f"Records hitting at least one Tier-1 routine: {len(tier1_hits)}")
print()
print("Sample Tier-1 dispatch resolutions (first 30):")
seen_combos = set()
for r in tier1_hits[:50]:
    rids = sorted({m["rid"] for m in r["matched_routines"]})
    key = (r["frame_hex"], tuple(rids))
    if key in seen_combos: continue
    seen_combos.add(key)
    print(f"\n  Frame: {r['frame_hex']}  ({r['sid_name']})")
    for rd in r["matched_routines"][:4]:
        if rd["rid"] in tier1:
            print(f"    → rid {rd['rid']}: {rd['description'][:90]!r}")

# Save full output
output = {
    "meta": {
        "matched_dispatch_count": len(matched_dispatch),
        "unambiguous_matches": len(unambig),
        "tier1_hits": len(tier1_hits),
    },
    "matched_dispatch": matched_dispatch,
}
json.dump(output, open(OUT, "w"), indent=1)
print(f"\nWrote {OUT}")
