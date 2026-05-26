#!/usr/bin/env python3
"""
Shape-matcher for the AlfaOBD recovered.db lost_and_found table.

Run AFTER lost_and_found.sql.gz arrives. Loads the SQL dump into a fresh
SQLite, then matches every (rootpgno, nfield) group against the 19
documented tables in analysis_notes.txt by column-shape fingerprinting:

  - Diag_names:  nfield=14, c0 INT 1..9999, c1..c8 multilingual TEXT, c9..c13 TEXT
  - Faults:      nfield=12, c0 TEXT(10) hexcode, c1 TEXT device_id, c2..c10 multilingual TEXT
  - Units:       nfield=14, c0 INT small (1..~200), c1..c13 TEXT (short, <=20 chars)
  - STATES:      nfield variable, c0 INT enum-like (~1..50), other cols short TEXT
  - newTable:    nfield=3, c0 TEXT(20) aso_code, c1 INT device_id, c2 TEXT(90) device_type
  - CAN_DELPHI_500_CONFIG: BYTE INT, BIT INT, LENGTH INT, Array TEXT, SETTING TEXT(60), _0.._N TEXT
  - CAN_DELPHI_RAM_CONFIG: byte TEXT(10), bit TEXT(10), length TEXT(10), setting TEXT(50), _0.._N TEXT
  - CAN_MARELLI_CONFIG:    similar to RAM_CONFIG
  - BODY_PN_CONFIG:        REQUEST TEXT(10), BIT TEXT(10), LENGTH TEXT(10), Array TEXT(10), SETTING TEXT(40), _0.._N TEXT(40)
  - TIPM_CGW_CONFIG / FCM_CGW_CONFIG: REQUEST/BIT/LENGTH/SETTING TEXT, _0..pad TEXT
  - FGA_DIESEL_STATIC / FGA_DIESEL_DYNAMIC / FGA_ENGINE_DATA / FGA_ABS_DATA / FGA_IPC_DATA:
        request TEXT, group_name TEXT, bit_pos TEXT, response_name TEXT, bit_len TEXT,
        lower_level TEXT, upper_level TEXT, slope TEXT, offset TEXT, unit_name TEXT, ...
  - FGA_IPC_SNAPSHOT:      dtc TEXT, bit_pos TEXT, data_id TEXT, device_id TEXT
  - FGA_IPC_SNAPSHOT_DATA: data_id TEXT, response_name TEXT, bit_len TEXT, lower_level TEXT, upper_level TEXT
  - Devices_params_units:  ID INT, Device_ID INT, Param_ID INT, Unit_ID INT  (4 INT columns)

Critical setup:
  - text_factory = bytes (avoid UTF-8 abort on the 5-10% byte residue)
  - Group by (rootpgno, nfield), not nfield alone
  - Per-column range fingerprint to disambiguate same-nfield tables

Usage:
  python3 shape-match-lost-and-found.py lost_and_found.sql.gz output_dir/
"""
import gzip
import json
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path


# Column shape fingerprints for the 19 documented tables
TABLE_FINGERPRINTS = {
    "Diag_names": {
        "nfield": 14,
        "c0_kind": "int_range",
        "c0_range": (1, 9999),
        "c1_to_c8": "text_multilingual",  # each language ~10-100 chars
        "discriminator_note": "c0 is INT 1..9999; c1..c8 are multilingual TEXT (EN/DE/CZ/ES/IT/FR/HU/RU)",
    },
    "Faults": {
        "nfield": 12,
        "c0_kind": "text_short",
        "c0_pattern": r"^[A-Z0-9]{1,10}$",  # hexcode like "P0300", "B1602", "0064"
        "c1_kind": "text",
        "c2_to_c10": "text_multilingual",
    },
    "Units": {
        "nfield": 14,
        "c0_kind": "int_range",
        "c0_range": (1, 250),
        "all_text_short": True,  # other cols TEXT(10..20)
        "discriminator_note": "Same nfield=14 as Diag_names, but c0 max is ~200, TEXT cols are <=20 chars",
    },
    "STATES": {
        "nfield_min": 4,
        "nfield_max": 30,  # CREATE truncated in our schema dump
        "c0_kind": "int_range",
        "c0_range": (1, 100),
    },
    "newTable": {
        "nfield": 3,
        "c0_kind": "text_short",  # aso_code TEXT(20)
        "c1_kind": "int",  # device_id INTEGER
        "c2_kind": "text",  # device_type TEXT(90)
    },
    "Devices_params_units": {
        "nfield": 4,
        "all_int": True,  # ID, Device_ID, Param_ID, Unit_ID — all INT
    },
    "CAN_DELPHI_500_CONFIG": {
        "c0_kind": "int",  # BYTE INTEGER
        "c1_kind": "int",  # BIT INTEGER
        "c2_kind": "int",  # LENGTH INTEGER
        "c4_kind": "text_long",  # SETTING TEXT(60)
        "nfield_min": 15,  # has _0.._16+
    },
    "CAN_DELPHI_RAM_CONFIG": {
        "all_text_in_first_4": True,  # byte/bit/length/setting all TEXT(10..50)
        "nfield_min": 15,
    },
    "CAN_MARELLI_CONFIG": {"similar_to": "CAN_DELPHI_RAM_CONFIG"},
    "BODY_PN_CONFIG": {
        "c0_kind": "text_short",  # REQUEST TEXT(10)
        "c4_kind": "text_long",  # SETTING TEXT(40)
        "nfield_min": 15,
    },
    "TIPM_CGW_CONFIG": {"similar_to": "BODY_PN_CONFIG"},
    "FCM_CGW_CONFIG": {"similar_to": "BODY_PN_CONFIG"},
    "FGA_DIESEL_STATIC": {
        "c0_kind": "text_short",  # request
        "c1_kind": "text_short",  # group_name
        "c2_kind": "int",  # bit_pos
        "c3_kind": "text",  # response_name
        "c4_kind": "int",  # bit_len
        "nfield_min": 10,
        "discriminator_note": "FGA family: request TEXT + bit_pos INT + bit_len INT shape",
    },
    "FGA_DIESEL_DYNAMIC": {"similar_to": "FGA_DIESEL_STATIC"},
    "FGA_ENGINE_DATA": {"similar_to": "FGA_DIESEL_STATIC"},
    "FGA_ABS_DATA": {"similar_to": "FGA_DIESEL_STATIC"},
    "FGA_IPC_DATA": {"similar_to": "FGA_DIESEL_STATIC"},
    "FGA_IPC_SNAPSHOT": {
        "nfield": 4,
        "c0_kind": "text_short",  # dtc TEXT(10)
        "c1_kind": "text_short",  # bit_pos TEXT(10)
        "c2_kind": "text_short",  # data_id TEXT(10)
        "c3_kind": "text",  # device_id TEXT(30)
    },
    "FGA_IPC_SNAPSHOT_DATA": {
        "nfield_min": 5,
        "c0_kind": "text_short",
        "c1_kind": "text_short",
        "c2_kind": "text_short",
    },
}


def kind_of(value):
    """Classify a raw cell value into a coarse kind."""
    if value is None:
        return "null"
    if isinstance(value, bytes):
        # Try as int (small fixed-width)
        if len(value) <= 4 and all(0 <= b <= 0xFF for b in value):
            try:
                v = value.decode("ascii")
                if v.isdigit():
                    return "int_str"
            except Exception:
                pass
            return "bytes"
        # Try ASCII decode
        try:
            s = value.decode("utf-8")
            if s.isdigit():
                return "int_str"
            if len(s) <= 20:
                return "text_short"
            if len(s) <= 60:
                return "text"
            return "text_long"
        except UnicodeDecodeError:
            return "bytes"
    if isinstance(value, int):
        return "int"
    if isinstance(value, str):
        if s := value:
            if s.isdigit():
                return "int_str"
            if len(s) <= 20:
                return "text_short"
            if len(s) <= 60:
                return "text"
            return "text_long"
        return "empty"
    return f"other:{type(value).__name__}"


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    in_path = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    # Load the SQL dump (auto-gunzip if .gz)
    print(f"[1/4] Loading {in_path}...")
    if in_path.suffix == ".gz":
        sql_bytes = gzip.decompress(in_path.read_bytes())
    else:
        sql_bytes = in_path.read_bytes()
    print(f"      SQL dump: {len(sql_bytes):,} bytes")

    print(f"[2/4] Loading into fresh in-memory SQLite...")
    conn = sqlite3.connect(":memory:")
    conn.text_factory = bytes  # critical: don't choke on non-UTF8 cells
    cur = conn.cursor()
    # Execute the dump (it's already a .dump output, statement by statement)
    sql_text = sql_bytes.decode("utf-8", errors="replace")
    loaded, errored = 0, 0
    for stmt in re.split(r";\s*\n", sql_text):
        s = stmt.strip()
        if not s or s.upper().startswith(("BEGIN", "COMMIT", "PRAGMA")):
            continue
        try:
            cur.execute(s)
            loaded += 1
        except Exception:
            errored += 1
    conn.commit()
    print(f"      Loaded {loaded} statements, {errored} errors (expected on residue)")

    # Confirm lost_and_found exists
    tables = [r[0].decode() if isinstance(r[0], bytes) else r[0]
              for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    print(f"      Tables: {tables}")
    if "lost_and_found" not in tables:
        print(f"      ERROR: no lost_and_found table found. Aborting.")
        sys.exit(2)

    # 3. Group every row by (rootpgno, nfield) and column shape
    print(f"[3/4] Grouping by (rootpgno, nfield)...")
    cols = [r[1].decode() if isinstance(r[1], bytes) else r[1]
            for r in cur.execute("PRAGMA table_info(lost_and_found)")]
    n_c_cols = sum(1 for c in cols if re.match(r"c\d+$", c))
    print(f"      lost_and_found has {len(cols)} columns; {n_c_cols} c-columns (c0..c{n_c_cols-1})")

    groups = defaultdict(lambda: {"row_count": 0, "col_kinds": defaultdict(Counter),
                                   "c0_int_range": [None, None], "samples": []})
    rows_iter = cur.execute("SELECT * FROM lost_and_found")
    total_scanned = 0
    for row in rows_iter:
        total_scanned += 1
        # Find rootpgno and nfield columns
        row_dict = dict(zip(cols, row))
        rootpgno = row_dict.get("rootpgno")
        nfield = row_dict.get("nfield")
        key = (int(rootpgno) if rootpgno is not None else None,
               int(nfield) if nfield is not None else None)
        g = groups[key]
        g["row_count"] += 1
        # Profile each c-column
        for i in range(n_c_cols):
            v = row_dict.get(f"c{i}")
            k = kind_of(v)
            g["col_kinds"][f"c{i}"][k] += 1
            # Track c0 int range specifically
            if i == 0 and k in ("int", "int_str"):
                try:
                    iv = int(v) if isinstance(v, (int, str)) else int(v.decode())
                    lo, hi = g["c0_int_range"]
                    if lo is None or iv < lo: g["c0_int_range"][0] = iv
                    if hi is None or iv > hi: g["c0_int_range"][1] = iv
                except Exception:
                    pass
        # Keep 3 sample rows per group
        if len(g["samples"]) < 3:
            sample = {}
            for c_name, val in row_dict.items():
                if isinstance(val, bytes):
                    try:
                        sample[c_name] = val.decode("utf-8")
                    except UnicodeDecodeError:
                        sample[c_name] = f"<{len(val)} bytes: {val[:32].hex()}>"
                else:
                    sample[c_name] = val
            g["samples"].append(sample)

    print(f"      Scanned {total_scanned:,} rows; {len(groups)} unique (rootpgno, nfield) groups")

    # 4. Shape-match each group against the table fingerprints
    print(f"[4/4] Shape-matching groups to documented tables...")
    matches = {}
    for key, g in groups.items():
        rootpgno, nfield = key
        candidates = []
        for tbl, fp in TABLE_FINGERPRINTS.items():
            score = 0
            # nfield match
            if "nfield" in fp and fp["nfield"] == nfield: score += 10
            if "nfield_min" in fp and nfield is not None and nfield >= fp["nfield_min"]: score += 5
            # c0 kind match
            if "c0_kind" in fp:
                top_c0 = g["col_kinds"]["c0"].most_common(1)
                if top_c0 and top_c0[0][0].startswith(fp["c0_kind"].split("_")[0]):
                    score += 5
            # c0 int range match
            if "c0_range" in fp and g["c0_int_range"][0] is not None:
                lo, hi = g["c0_int_range"]
                exp_lo, exp_hi = fp["c0_range"]
                if lo >= exp_lo - 5 and hi <= exp_hi + 5: score += 8
            # all_int / all_text checks
            if fp.get("all_int") and all(g["col_kinds"][f"c{i}"].most_common(1)[0][0] == "int"
                                          for i in range(min(4, n_c_cols))
                                          if g["col_kinds"][f"c{i}"]): score += 7
            if score > 0:
                candidates.append((tbl, score))
        candidates.sort(key=lambda x: -x[1])
        matches[f"({rootpgno},{nfield})"] = {
            "rootpgno": rootpgno, "nfield": nfield, "row_count": g["row_count"],
            "c0_int_range": g["c0_int_range"] if g["c0_int_range"][0] is not None else None,
            "top_col_kinds": {c: dict(g["col_kinds"][c].most_common(3)) for c in list(g["col_kinds"])[:8]},
            "best_match_candidates": candidates[:5],
            "sample_rows": g["samples"],
        }

    out_path = out_dir / "lost_and_found-shape-matches.json"
    out_path.write_text(json.dumps(matches, indent=2, ensure_ascii=False, default=str))
    print(f"\nWrote {out_path} ({out_path.stat().st_size:,} bytes)")

    # Quick summary
    print(f"\nTop groups by row count:")
    sorted_groups = sorted(matches.items(), key=lambda x: -x[1]["row_count"])[:15]
    for key, info in sorted_groups:
        best = info["best_match_candidates"][0] if info["best_match_candidates"] else ("?", 0)
        print(f"  {key:<20} rows={info['row_count']:>6}  best_match={best[0]} (score {best[1]})")


if __name__ == "__main__":
    main()
