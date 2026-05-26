#!/usr/bin/env python3
"""Hunt v3 — reconstruct per-routine UDS frames built via the
   `ldloc.X; ldc.i4 <idx>; ldc.i4 <val>; stelem.i1` pattern that we now
   know AlfaOBD uses in SendActiveDiagnostic2/3.

Strategy:
  1. Walk IL linearly, accumulating runs of `(ldloc.X, ldc.i4 idx, ldc.i4 val, stelem.i1)`.
  2. The local index X identifies which buffer is being written.
  3. Within a run, when we see index == 0 with value in UDS_SIDS, that's a frame start.
  4. Continue collecting until either:
       - The local changes (different buffer)
       - A non-(ldloc/ldc/stelem) instruction breaks the chain
       - Index goes backward (new frame)
  5. Output: (frame_start_ip, local_idx, bytes_by_index, surrounding_routine_id_hint).

Routine-ID hint: look back up to 256 bytes for an `ldc.i4 <routine_id>` where the
   routine_id is in DIAG_NAMES (1..3789). This associates each frame to a routine.
"""
import dnfile
import struct
import json
from collections import defaultdict

EXE = "/tmp/exe/AlfaOBD.exe"
OUT_JSON = "/tmp/exe/uds_frames_v3.json"

UDS_SIDS = {
    0x10, 0x11, 0x14, 0x19, 0x22, 0x27, 0x2E, 0x31,
    0x34, 0x36, 0x37, 0x3E, 0x07, 0x18,
}
UDS_SID_NAMES = {
    0x10: "DSC", 0x11: "ECUReset", 0x14: "ClearDTC", 0x19: "ReadDTC",
    0x22: "RDBI", 0x27: "SecurityAccess", 0x2E: "WDBI", 0x31: "RoutineControl",
    0x34: "RequestDownload", 0x36: "TransferData", 0x37: "ExitTransfer", 0x3E: "TesterPresent",
    0x07: "KWP_ReadFault", 0x18: "KWP_ReadDTCByStatus",
}

# IL opcodes
LDLOC_0 = 0x06
LDLOC_3 = 0x09
LDLOC_S = 0x11
LDLOC_PFX = 0xFE  # FE 0C XXXX = ldloc
LDARG_0 = 0x02
LDARG_3 = 0x05
LDARG_S = 0x0E
LDC_I4_M1 = 0x15
LDC_I4_0 = 0x16
LDC_I4_8 = 0x1E
LDC_I4_S = 0x1F
LDC_I4 = 0x20
DUP = 0x25
STELEM_I1 = 0x9C
NEWARR = 0x8D

# Set of known Tier-1 routine IDs we want flags for
TIER1 = {2504, 1520, 1126, 1750, 1751, 2505, 2507, 1367, 2508}


def parse_method_il(pe, body_rva):
    off = pe.get_offset_from_rva(body_rva)
    raw = pe.__data__
    b0 = raw[off]
    if (b0 & 0x03) == 0x02:
        code_size = b0 >> 2
        return bytes(raw[off + 1: off + 1 + code_size])
    code_size = struct.unpack_from("<I", raw, off + 4)[0]
    return bytes(raw[off + 12: off + 12 + code_size])


def decode_ldc_i4(code, ip):
    if ip >= len(code): return None
    op = code[ip]
    if op == LDC_I4_M1: return -1, ip + 1
    if LDC_I4_0 <= op <= LDC_I4_8: return op - LDC_I4_0, ip + 1
    if op == LDC_I4_S and ip + 1 < len(code):
        return struct.unpack_from("<b", code, ip + 1)[0], ip + 2
    if op == LDC_I4 and ip + 4 < len(code):
        return struct.unpack_from("<i", code, ip + 1)[0], ip + 5
    return None


def decode_load_array(code, ip):
    """Returns (local_descriptor_str, ip_after) if code[ip] is a load that pushes the
       byte buffer onto the stack. We treat ldloc.* and ldarg.* as candidates."""
    if ip >= len(code): return None
    op = code[ip]
    if LDLOC_0 <= op <= LDLOC_3:
        return f"L{op - LDLOC_0}", ip + 1
    if op == LDLOC_S and ip + 1 < len(code):
        return f"Ls{code[ip+1]}", ip + 2
    if LDARG_0 <= op <= LDARG_3:
        return f"A{op - LDARG_0}", ip + 1
    if op == LDARG_S and ip + 1 < len(code):
        return f"As{code[ip+1]}", ip + 2
    if op == LDLOC_PFX and ip + 3 < len(code):
        if code[ip+1] == 0x0C:
            idx = struct.unpack_from("<H", code, ip + 2)[0]
            return f"L{idx}", ip + 4
        if code[ip+1] == 0x09:
            idx = struct.unpack_from("<H", code, ip + 2)[0]
            return f"A{idx}", ip + 4
    return None


def scan_method(code):
    """Return list of frames. Each frame is {start_ip, local, bytes:{idx:val}}."""
    n = len(code)
    frames = []
    cur_frame = None  # {start_ip, local, bytes:{}, last_idx, last_ip_after_stelem}

    def finalize(frame):
        if not frame: return
        if not frame["bytes"]: return
        # Build byte array in order, with None for gaps
        max_idx = max(frame["bytes"].keys())
        layout = [None] * (max_idx + 1)
        for idx, val in frame["bytes"].items():
            layout[idx] = val
        sid_byte = layout[0]
        if sid_byte is None or sid_byte not in UDS_SIDS:
            return  # not a UDS frame
        frames.append({
            "start_ip": frame["start_ip"],
            "end_ip": frame["last_ip"],
            "local": frame["local"],
            "layout": layout,
            "filled_count": len(frame["bytes"]),
        })

    ip = 0
    while ip < n:
        # Try to parse `load_array; ldc.i4 idx; ldc.i4 val; stelem.i1`
        load = decode_load_array(code, ip)
        if load is None:
            finalize(cur_frame)
            cur_frame = None
            ip += 1
            continue
        local, ip_after_load = load
        dec_idx = decode_ldc_i4(code, ip_after_load)
        if dec_idx is None:
            finalize(cur_frame)
            cur_frame = None
            ip += 1
            continue
        idx_val, ip_after_idx = dec_idx
        dec_val = decode_ldc_i4(code, ip_after_idx)
        if dec_val is None:
            finalize(cur_frame)
            cur_frame = None
            ip += 1
            continue
        val_val, ip_after_val = dec_val
        if ip_after_val >= n or code[ip_after_val] != STELEM_I1:
            finalize(cur_frame)
            cur_frame = None
            ip += 1
            continue
        # Successful `load; ldc.i4 idx; ldc.i4 val; stelem.i1`
        ip_after_stelem = ip_after_val + 1
        idx_val_u = idx_val & 0xFFFFFFFF
        val_byte = val_val & 0xFF

        # Decide whether this continues current frame or starts a new one
        new_frame = False
        if cur_frame is None:
            new_frame = True
        elif cur_frame["local"] != local:
            new_frame = True
        elif idx_val_u == 0:
            # Index 0 means the start of a frame (unless we're already at 0 with same buffer)
            new_frame = True
        elif idx_val_u <= cur_frame["last_idx"]:
            # Backward index — definitely a new frame
            new_frame = True
        if new_frame:
            finalize(cur_frame)
            # Only start a frame if val[0] is a UDS SID, or skip until next
            if idx_val_u == 0 and val_byte in UDS_SIDS:
                cur_frame = {
                    "start_ip": ip,
                    "local": local,
                    "bytes": {0: val_byte},
                    "last_idx": 0,
                    "last_ip": ip_after_stelem,
                }
            else:
                cur_frame = None
        else:
            # Extend current frame
            cur_frame["bytes"][idx_val_u] = val_byte
            cur_frame["last_idx"] = idx_val_u
            cur_frame["last_ip"] = ip_after_stelem
        ip = ip_after_stelem
    finalize(cur_frame)
    return frames


def find_routine_ids_in_method(code):
    """Walk IL and return all `ldc.i4 N` constants where 1 <= N <= 4000 (routine id range)
       and their IP. Used as a hint to associate frames with routine_ids."""
    n = len(code)
    out = []
    ip = 0
    while ip < n:
        dec = decode_ldc_i4(code, ip)
        if dec is None:
            ip += 1
            continue
        val, ip_after = dec
        # Only ldc.i4 (full 4-byte) is reliable here — ldc.i4.s -128..127 is too noisy
        if code[ip] == LDC_I4 and 1 <= val <= 4000:
            out.append((ip, val))
        ip = ip_after
    return out


def main():
    print(f"Loading {EXE}…", flush=True)
    pe = dnfile.dnPE(EXE)
    md = pe.net.mdtables

    findings_by_method = {}
    grand_total_frames = 0
    grand_total_routine_control = 0
    grand_total_security_access = 0

    print(f"Scanning {len(md.MethodDef.rows):,} methods…", flush=True)
    for i, m in enumerate(md.MethodDef.rows):
        if m.Rva == 0:
            continue
        try:
            code = parse_method_il(pe, m.Rva)
        except Exception:
            continue
        if len(code) < 8:
            continue
        try:
            frames = scan_method(code)
        except Exception:
            continue
        if not frames:
            continue
        # Get routine_id hints
        ridhints = find_routine_ids_in_method(code)
        # For each frame, find the nearest preceding routine_id hint within 512 bytes
        for f in frames:
            best = None
            for hint_ip, hint_val in ridhints:
                if hint_ip < f["start_ip"] and (f["start_ip"] - hint_ip) < 512:
                    if best is None or hint_ip > best[0]:
                        best = (hint_ip, hint_val)
            f["routine_id_hint"] = best[1] if best else None
            f["sid"] = f["layout"][0]
            f["sid_name"] = UDS_SID_NAMES.get(f["sid"], "?")
            f["bytes_hex"] = [f"0x{b:02X}" if b is not None else None for b in f["layout"]]
            del f["layout"]
        method_name = str(m.Name) if hasattr(m, "Name") else "?"
        findings_by_method[i + 1] = {
            "name": method_name,
            "rva": m.Rva,
            "il_size": len(code),
            "frame_count": len(frames),
            "frames": frames,
        }
        grand_total_frames += len(frames)
        for f in frames:
            if f["sid"] == 0x31:
                grand_total_routine_control += 1
            elif f["sid"] == 0x27:
                grand_total_security_access += 1

    print(f"Total frames extracted: {grand_total_frames:,}")
    print(f"  RoutineControl (0x31): {grand_total_routine_control}")
    print(f"  SecurityAccess (0x27): {grand_total_security_access}")
    print(f"Methods with frames: {len(findings_by_method)}")
    print()
    print("Top methods by frame count:")
    sorted_methods = sorted(findings_by_method.items(), key=lambda x: -x[1]["frame_count"])
    for idx, info in sorted_methods[:15]:
        rc = sum(1 for f in info["frames"] if f["sid"] == 0x31)
        sa = sum(1 for f in info["frames"] if f["sid"] == 0x27)
        rd = sum(1 for f in info["frames"] if f["sid"] == 0x22)
        wd = sum(1 for f in info["frames"] if f["sid"] == 0x2E)
        print(f"  Method[{idx:5d}] {info['name']:<35} total={info['frame_count']:5d}  RC={rc:4d}  SA={sa:3d}  RDBI={rd:3d}  WDBI={wd:3d}")

    # Save full result
    with open(OUT_JSON, "w") as f:
        json.dump(findings_by_method, f, indent=1)
    print(f"\nWrote {OUT_JSON}")

    # Tier-1 specific report
    print("\nTier-1 routine frame hits (routine_id hint matches):")
    for rid in sorted(TIER1):
        for mi, info in findings_by_method.items():
            for f in info["frames"]:
                if f.get("routine_id_hint") == rid:
                    print(f"  rid={rid}  Method[{mi}] {info['name']!r}  sid={f['sid_name']}  bytes={f['bytes_hex']}")


if __name__ == "__main__":
    main()
