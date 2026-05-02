"""
Generate the canonical unlock_catalog.json from the canflash_unlocks/ DLL set.

For each .dll in canflash_unlocks/, this:
  1. Parses the PE export table (ordinal 1=unlock, 2=verify, 3=ecu_info).
  2. Reads and decodes the ecu_info data export:
       offset 0:  u32 pointer to module display-name string
       offset 4:  u16 type (security type, matches CANFLASH_MODULE_MAP['type'])
       offset 6:  u16 tx CAN ID (11-bit)
       offset 8:  u16 rx CAN ID (11-bit)
       offset 10: u16 extra
  3. Cross-references canflash_seedkey.py and srtlab_canflash_algos.py to mark
     each DLL as `reversed` (Python port exists) or `dll_only` (DLL-only).
  4. Emits unlock_catalog.json next to this script — a single source of truth
     consumed by both the python-bridge dispatcher and the SRT Lab UI.

Run:
    python3 srtlab_unlock_catalog_gen.py [--check]

--check exits non-zero if the on-disk catalog differs from a fresh build,
which is what the test suite uses to detect drift.
"""

import argparse
import datetime
import importlib.util
import inspect
import json
import os
import re
import struct
import sys

import pefile


HERE = os.path.dirname(os.path.abspath(__file__))
DLL_DIR = os.path.join(HERE, "canflash_unlocks")
CATALOG_PATH = os.path.join(HERE, "unlock_catalog.json")

# Schema version. Bump when the JSON shape changes.
SCHEMA_VERSION = 1


# ─────────────────────────────────────────────────────────────────────────────
# Family tags — derived from the ecu_info module name + tx/rx CAN ID pair.
# ─────────────────────────────────────────────────────────────────────────────
# Stable machine-readable family identifier per (ecu_info name, tx, rx) tuple
# so the SRT Lab UI can group rows. Keep these lowercase, snake_case.

def family_tag(ecu_name, tx, rx):
    name = (ecu_name or "").strip().lower().replace("/", "_").replace(" ", "_")
    if name in ("bcm_fcm", "bcm", "fcm", "tipm_7", "tipm"):
        return "bcm_fcm_tipm"
    if name == "abs":
        return "abs"
    if name == "pcm":
        return "pcm"
    if name == "tcm":
        return "tcm"
    if name == "egs52":
        return "tcm"
    if name == "itm":
        return "itm"
    if name in ("rak", "raq_ref", "rar", "radio"):
        return "radio_rak"
    if name == "wcm":
        return "wcm"
    if name == "ccn":
        return "ccn"
    if name in ("ddm", "pdm", "ewm"):
        return "doors"
    if name == "hvac":
        return "hvac"
    if name == "amp":
        return "amp"
    if name == "hfm":
        return "hfm"
    if name == "orc":
        return "orc_airbag"
    if name == "ocm":
        return "ocm_airbag"
    if name == "sas":
        return "sas"
    if name == "scm":
        return "scm"
    if name in ("ves", "ves3"):
        return "video"
    if name in ("awd", "fdcm"):
        return "awd"
    if name == "sdar":
        return "sat_radio"
    if name == "ahbm":
        return "brakes_aux"
    if name == "asbs":
        return "brakes_aux"
    if name == "acc":
        return "adaptive_cruise"
    if name == "ptcm":
        return "ptcm"
    if name == "ptim":
        return "ptim"
    if name == "esm":
        return "seat"
    if name == "msmd":
        return "seat"
    if name == "lrsm":
        return "seat"
    if name == "plgm":
        return "liftgate"
    if name == "sunr":
        return "sunroof"
    if name == "pts":
        return "parktronic"
    if name == "hidt":
        return "lighting"
    if name == "cmtc" or name == "eom":
        return "comfort_misc"
    if name.startswith("cummins"):
        return "diesel_pcm"
    return "other"


# ─────────────────────────────────────────────────────────────────────────────
# Python port discovery — read canflash_seedkey.py and srtlab_canflash_algos.py
# without executing them, so generation works even when imports are heavy.
# ─────────────────────────────────────────────────────────────────────────────

_FN_DEF_RE = re.compile(r"^def\s+(unlock_[a-zA-Z0-9_]+)\s*\(", re.MULTILINE)
_ALGOS_KEY_RE = re.compile(r"^\s*'([a-zA-Z0-9_]+)'\s*:\s*\{\s*'fn'\s*:\s*([a-zA-Z0-9_]+)", re.MULTILINE)
_COVERAGE_BLOCK_RE = re.compile(r"^COVERAGE\s*=\s*\{(.*?)^\}", re.MULTILINE | re.DOTALL)
_COVERAGE_ENTRY_RE = re.compile(
    r"'([a-zA-Z0-9_]+)'\s*:\s*\(\s*'([^']+)'\s*,\s*'([^']*)'\s*\)"
)


def _read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def discover_python_ports():
    """Return {dll_basename: python_function_name} for every reversed module.

    Sources:
      1. canflash_seedkey.py — every `def unlock_<dll>(...)` in the file is
         considered a port for `<dll>.dll`.
      2. srtlab_canflash_algos.py — every CANFLASH_ALGOS entry maps a
         `<dll>` key to a `<dll>_unlock` (or aliased) function.
    """
    ports = {}

    seedkey = os.path.join(HERE, "canflash_seedkey.py")
    if os.path.isfile(seedkey):
        text = _read(seedkey)
        for m in _FN_DEF_RE.finditer(text):
            fname = m.group(1)
            dll_basename = fname[len("unlock_"):]
            ports.setdefault(dll_basename, fname)

    algos = os.path.join(HERE, "srtlab_canflash_algos.py")
    if os.path.isfile(algos):
        text = _read(algos)
        for m in _ALGOS_KEY_RE.finditer(text):
            key, fn = m.group(1), m.group(2)
            ports.setdefault(key, fn)

    return ports


# ─────────────────────────────────────────────────────────────────────────────
# Algorithm-family discovery — surface the per-module "what makes this unlock
# tick" tag (e.g. 't8_xor', 'lcg_pair', 'hitag2_lfsr48', 'crc32_feistel_8round')
# so the SRT Lab UI can show users exactly which crypto family each native port
# implements. Useful when filing bug reports against a specific algorithm.
# ─────────────────────────────────────────────────────────────────────────────

# Algorithm-family tag for every reversed module. Originally these were derived
# from a COVERAGE = {…} table inside canflash_seedkey.py (still parsed below
# when present, for backward compatibility), with this dict acting as a thin
# fallback for modules ported in srtlab_canflash_algos.py. Task #548 removed
# the COVERAGE table, so this dict is now the canonical source of truth and is
# kept in lock-step with the `algorithm` field of every reversed entry in
# unlock_catalog.json. When you add or rename a tag here, mirror it on the
# UI side in artifacts/srt-lab/src/lib/algoFriendly.js.
_EXTRA_ALGORITHMS = {
    "HB_ccn": "t8_xor",
    "LX_ccn": "t8_xor",
    "abs": "lcg_pair",
    "ahbm": "imul+t8",
    "aisin_tcm": "aisin_t16_3pass",
    "alpine_amp": "lcg_pair",
    "alpine_radio": "lcg_pair",
    "alpine_rak": "lcg_pair",
    "asbs": "t8_xor",
    "awd_pm_mk": "lcg_halves",
    "borg_awd": "t8_xor+rotate",
    "bosch_abs": "t8_xor",
    "bosch_cdm_win_ddm": "t8_chain",
    "bosch_cdm_win_pdm": "t8_chain",
    "bosch_ddm": "t8_chain",
    "bosch_mddm": "t8_chain",
    "bosch_mpdm": "t8_chain",
    "bosch_mwddm": "t8_chain",
    "bosch_mwpdm": "t8_chain",
    "bosch_orc": "t8_chain+crc",
    "bosch_pdm": "t8_chain",
    "cmtc": "t8_add+bitpack",
    "cummins_849": "cummins_t16",
    "cvt": "rol16_chain_2pass",
    "dcx_ptcm": "lcg_pair",
    "ddm": "t8_xor+bitpack",
    "delphi_hvac": "t8_xor_8tap",
    "delphi_sdar": "t8_add_4tap",
    "edc16c2": "t32_8row_substitution",
    "edc16cp31": "t32_8row_substitution",
    "edc16u31": "t32_8row_substitution",
    "egs52": "imul_xor",
    "eom": "t8_add+bitpack",
    "esm": "byte_lane_mux",
    "ewm": "t16_chain",
    "fdcm": "t8_xor",
    "gpec": "tea-feistel",
    "harman_amp": "t8_add+imul",
    "hella_acc": "lcg_pair",
    "hfm": "t8_xor (32-bit)",
    "hidt": "t16x32_mixed_mul_xor",
    "huntsville_bcm": "t8_xor",
    "huntsville_fcm": "t8_xor",
    "huntsville_fdcm": "t8_xor",
    "huntsville_radio": "t8_xor",
    "hvac": "t8_mul_seed",
    "kicker_amp": "crc32_feistel_8round",
    "lear_wcm": "hitag2_lfsr48",
    "lrsm": "t16_gf2",
    "may_scofield_itm": "t8_xor",
    "mitsubishi_rar": "simple",
    "mitsubishi_ves": "simple",
    "mitsubishi_ves3": "t8_mod_imul",
    "motorola_tipm7": "t8_xor",
    "msmd": "lcg_pair",
    "ngc4_trans": "t8_xor",
    "ngc_engine": "t8_xor",
    "ngc_transmission": "t8_xor",
    "nippon_ccn": "t8_xor",
    "ocm": "t8_xor",
    "pdm": "t8_xor+bitpack",
    "peiker_hfm": "t8_5tap_chain_xor",
    "plgm": "t8_xor",
    "ptim_lx": "t8_xor",
    "pts": "t8_chain+rot",
    "sas": "gf2_4x4_substitution",
    "sunr": "inline",
    "temic_ddm": "~s*K",
    "temic_pdm": "~s*K",
    "teves_abs": "lcg_pair",
    "trw_abs": "t8_xor",
    "trw_hvac": "t8_mul_seed",
    "trw_hvac_2": "t8_mul_seed",
    "trw_ocm": "t8_xor",
    "trw_orc": "t8_xor",
    "trw_sas": "t8_xor",
    "valeo_scm": "lcg_pair",
    "venom_pcm": "t8_xor",
    "visteon_amp": "bit_driven_accum",
    "wcm": "t16_mul",
    "yazaki_fcm": "t8_xor",
}


def discover_algorithm_tags():
    """Return {dll_basename: algorithm_tag} parsed from COVERAGE.

    COVERAGE in canflash_seedkey.py maps each module to a (kind, algorithm)
    tuple. We surface the algorithm string regardless of kind — even
    historically-stale 'dll-only' entries carry useful tags like
    'cummins-style?' or 't8_chain+crc'. Modules that aren't in COVERAGE fall
    back to ``_EXTRA_ALGORITHMS``.
    """
    tags = {}
    seedkey = os.path.join(HERE, "canflash_seedkey.py")
    if os.path.isfile(seedkey):
        text = _read(seedkey)
        m = _COVERAGE_BLOCK_RE.search(text)
        if m:
            for em in _COVERAGE_ENTRY_RE.finditer(m.group(1)):
                key, _kind, algo = em.group(1), em.group(2), em.group(3)
                if algo:
                    tags.setdefault(key, algo)
    for k, v in _EXTRA_ALGORITHMS.items():
        tags.setdefault(k, v)
    return tags


# ─────────────────────────────────────────────────────────────────────────────
# Reasons for the dll_only entries — keep these short, factual, and stable.
# ─────────────────────────────────────────────────────────────────────────────

def dll_only_reason(dll_basename, ecu_name, family):
    """A short, plain-English reason a module is currently dll_only.

    Falls back to a generic "not yet reversed" message. Intentionally keeps
    each reason factual (what blocks the port) rather than promising work.
    """
    n = dll_basename.lower()
    if family == "doors":
        return "door-module unlock not yet reversed; runs under Unicorn"
    if family == "amp":
        return "amplifier unlock not yet reversed; runs under Unicorn"
    if family == "hvac":
        return "HVAC unlock not yet reversed; runs under Unicorn"
    if family == "ccn":
        return "center-console nav unlock not yet reversed; runs under Unicorn"
    if family == "video":
        return "VES rear-seat-video unlock not yet reversed; runs under Unicorn"
    if family == "orc_airbag" or family == "ocm_airbag":
        return "airbag/occupant-restraint unlock not yet reversed; runs under Unicorn"
    if family == "sas" or family == "scm":
        return "steering-column/angle unlock not yet reversed; runs under Unicorn"
    if family == "sat_radio":
        return "satellite-radio unlock not yet reversed; runs under Unicorn"
    if family == "hfm":
        return "handsfree-module unlock not yet reversed; runs under Unicorn"
    if family == "awd":
        return "AWD/transfer-case unlock not yet reversed; runs under Unicorn"
    if family == "diesel_pcm" or n.startswith("edc"):
        return "Bosch EDC diesel-PCM unlock not yet reversed; runs under Unicorn"
    if family == "brakes_aux":
        return "auxiliary-brakes unlock not yet reversed; runs under Unicorn"
    if family == "adaptive_cruise":
        return "adaptive-cruise unlock not yet reversed; runs under Unicorn"
    if family == "seat":
        return "seat-module unlock not yet reversed; runs under Unicorn"
    if family == "liftgate":
        return "power-liftgate unlock not yet reversed; runs under Unicorn"
    if family == "sunroof":
        return "sunroof unlock not yet reversed; runs under Unicorn"
    if family == "parktronic":
        return "parktronic unlock not yet reversed; runs under Unicorn"
    if family == "lighting":
        return "lighting unlock not yet reversed; runs under Unicorn"
    if family == "comfort_misc":
        return "comfort-module unlock not yet reversed; runs under Unicorn"
    if family == "ptcm" or family == "ptim":
        return "powertrain-integrated-module unlock not yet reversed; runs under Unicorn"
    if family == "tcm" and n != "ngc_transmission":
        return "transmission unlock not yet reversed; runs under Unicorn"
    if family == "pcm":
        return "PCM unlock not yet reversed; runs under Unicorn"
    return "not yet reversed; runs under Unicorn DLL emulation"


# ─────────────────────────────────────────────────────────────────────────────
# Per-DLL ecu_info decoder
# ─────────────────────────────────────────────────────────────────────────────

def decode_ecu_info(dll_path):
    """Return {raw_hex, name, tx, rx, type, extra, decode_failed, error?}."""
    out = {
        "raw_hex": None,
        "name": None,
        "tx_can_id": None,
        "rx_can_id": None,
        "type": None,
        "extra": None,
        "decode_failed": True,
        "error": None,
    }
    try:
        pe = pefile.PE(dll_path, fast_load=True)
        pe.parse_data_directories(
            directories=[pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_EXPORT"]]
        )
        if not hasattr(pe, "DIRECTORY_ENTRY_EXPORT"):
            out["error"] = "no export directory"
            return out
        ecu_info_rva = None
        ordinals = {}
        for s in pe.DIRECTORY_ENTRY_EXPORT.symbols:
            nm = s.name.decode() if s.name else None
            ordinals[s.ordinal] = nm or f"@ord_{s.ordinal}"
            if nm == "ecu_info":
                ecu_info_rva = s.address
        if ecu_info_rva is None:
            out["error"] = "no ecu_info export"
            return out
        raw = pe.get_data(ecu_info_rva, 12)
        out["raw_hex"] = raw.hex()
        if len(raw) < 12:
            out["error"] = "ecu_info too short"
            return out
        name_ptr, val1, tx, rx, extra = struct.unpack("<IHHHH", raw[:12])
        try:
            name_data = pe.get_data(name_ptr - pe.OPTIONAL_HEADER.ImageBase, 64)
            name = name_data.split(b"\x00")[0].decode("latin1", errors="replace")
        except Exception as exc:  # pragma: no cover - fallback
            name = None
            out["error"] = f"name string at {hex(name_ptr)} unreadable: {exc}"
        out.update({
            "name": name,
            "tx_can_id": tx,
            "rx_can_id": rx,
            "type": val1,
            "extra": extra,
            "decode_failed": False,
            "ordinals": ordinals,
        })
        return out
    except Exception as exc:
        out["error"] = f"PE parse failed: {exc}"
        return out


# ─────────────────────────────────────────────────────────────────────────────
# Display-name lookup — prefer human-friendly labels from srtlab_unlock_catalog
# ─────────────────────────────────────────────────────────────────────────────

_LABEL_RE = re.compile(
    r"'([a-zA-Z0-9_]+)'\s*:\s*\{[^}]*?'label'\s*:\s*'([^']+)'",
)


def discover_display_labels():
    path = os.path.join(HERE, "srtlab_unlock_catalog.py")
    out = {}
    if not os.path.isfile(path):
        return out
    text = _read(path)
    for m in _LABEL_RE.finditer(text):
        out.setdefault(m.group(1), m.group(2))
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Generator
# ─────────────────────────────────────────────────────────────────────────────

def build_catalog():
    if not os.path.isdir(DLL_DIR):
        raise SystemExit(f"DLL dir not found: {DLL_DIR}")

    ports = discover_python_ports()
    labels = discover_display_labels()
    algo_tags = discover_algorithm_tags()

    files = sorted(f for f in os.listdir(DLL_DIR) if f.lower().endswith(".dll"))
    entries = []
    for f in files:
        path = os.path.join(DLL_DIR, f)
        size = os.path.getsize(path)
        basename = f[:-4]
        info = decode_ecu_info(path)
        family = family_tag(info.get("name"), info.get("tx_can_id"), info.get("rx_can_id"))
        py_fn = ports.get(basename)
        if py_fn:
            status = "reversed"
            reason = None
        else:
            status = "dll_only"
            reason = dll_only_reason(basename, info.get("name"), family)
        display = labels.get(basename) or (basename.replace("_", " ").title())
        entries.append({
            "file": f,
            "module": basename,
            "display_name": display,
            "size_bytes": size,
            "ecu_info": info,
            "tx_can_id": info.get("tx_can_id"),
            "rx_can_id": info.get("rx_can_id"),
            "family": family,
            "status": status,
            "python_function": py_fn,
            "algorithm": algo_tags.get(basename),
            "reason": reason,
        })

    return {
        "schema_version": SCHEMA_VERSION,
        "generated_by": "srtlab_unlock_catalog_gen.py",
        "dll_dir": "tools/python-bridge/tools/canflash_unlocks",
        "entry_count": len(entries),
        "reversed_count": sum(1 for e in entries if e["status"] == "reversed"),
        "dll_only_count": sum(1 for e in entries if e["status"] == "dll_only"),
        "entries": entries,
    }


def write_catalog(catalog, path=CATALOG_PATH):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(catalog, f, indent=2, sort_keys=False)
        f.write("\n")


def render_for_compare(catalog):
    return json.dumps(catalog, indent=2, sort_keys=False) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="exit non-zero if the on-disk catalog differs from a fresh build",
    )
    parser.add_argument(
        "--out",
        default=CATALOG_PATH,
        help="output path (default: unlock_catalog.json next to this script)",
    )
    args = parser.parse_args()

    catalog = build_catalog()
    rendered = render_for_compare(catalog)

    if args.check:
        if not os.path.isfile(args.out):
            print(f"unlock_catalog.json missing at {args.out} — run without --check first.")
            sys.exit(1)
        with open(args.out, "r", encoding="utf-8") as f:
            current = f.read()
        if current != rendered:
            print(f"unlock_catalog.json is out of date — re-run srtlab_unlock_catalog_gen.py.")
            sys.exit(1)
        print(f"unlock_catalog.json is up to date ({catalog['entry_count']} DLLs).")
        return

    write_catalog(catalog, args.out)
    print(
        f"Wrote {args.out}: {catalog['entry_count']} DLLs "
        f"({catalog['reversed_count']} reversed, {catalog['dll_only_count']} dll_only)."
    )


if __name__ == "__main__":
    main()
