#!/usr/bin/env python3
"""
SRT Lab — Deep Binary Dissection Engine
Runs as a subprocess called from Node.js analyze.ts
Outputs a JSON object with all extracted intelligence.
"""

import sys
import os
import json
import struct
import subprocess
import tempfile
import zipfile
import marshal
import dis
import io
import re
import hashlib
from pathlib import Path

def run_cmd(cmd, input_data=None, timeout=30):
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout,
            input=input_data
        )
        return result.stdout
    except Exception:
        return ""

def extract_strings(data: bytes, min_len=6) -> list:
    """Extract all printable ASCII and UTF-16 strings."""
    results = []
    # ASCII
    pattern = rb'[\x20-\x7e]{' + str(min_len).encode() + rb',}'
    for m in re.finditer(pattern, data):
        s = m.group().decode('ascii', errors='ignore')
        results.append({"value": s, "offset": hex(m.start()), "encoding": "ascii"})
    # UTF-16 LE
    try:
        decoded = data.decode('utf-16-le', errors='ignore')
        for m in re.finditer(r'[\x20-\x7e]{' + str(min_len) + r',}', decoded):
            results.append({"value": m.group(), "offset": "utf16", "encoding": "utf16"})
    except Exception:
        pass
    return results[:2000]  # cap at 2000

def find_automotive_patterns(data: bytes) -> dict:
    """Scan for FCA/Stellantis-specific byte patterns."""
    findings = {
        "can_ids": [],
        "uds_services": [],
        "seed_key_patterns": [],
        "vin_patterns": [],
        "security_access": [],
        "gpec_patterns": [],
        "crc_polynomials": [],
        "pin_patterns": [],
    }

    # CAN IDs (2-byte big-endian values in automotive range 0x600-0x7FF)
    for i in range(0, len(data) - 1):
        val = struct.unpack('>H', data[i:i+2])[0]
        if 0x600 <= val <= 0x7FF:
            findings["can_ids"].append({"value": hex(val), "offset": hex(i)})
    findings["can_ids"] = findings["can_ids"][:50]

    # UDS service bytes
    uds_services = {
        0x10: "DiagnosticSessionControl",
        0x11: "ECUReset",
        0x14: "ClearDiagnosticInformation",
        0x19: "ReadDTCInformation",
        0x22: "ReadDataByIdentifier",
        0x23: "ReadMemoryByAddress",
        0x27: "SecurityAccess",
        0x28: "CommunicationControl",
        0x2E: "WriteDataByIdentifier",
        0x2F: "InputOutputControlByIdentifier",
        0x31: "RoutineControl",
        0x34: "RequestDownload",
        0x35: "RequestUpload",
        0x36: "TransferData",
        0x37: "RequestTransferExit",
        0x3E: "TesterPresent",
        0x85: "ControlDTCSetting",
    }
    for offset in range(len(data)):
        b = data[offset]
        if b in uds_services:
            # Check context — look for surrounding bytes that look like UDS frames
            ctx = data[max(0,offset-4):offset+8]
            ctx_hex = ctx.hex()
            findings["uds_services"].append({
                "service": hex(b),
                "name": uds_services[b],
                "offset": hex(offset),
                "context": ctx_hex
            })
    findings["uds_services"] = findings["uds_services"][:100]

    # Security access seed/key patterns (0x27 followed by level byte)
    for i in range(len(data) - 1):
        if data[i] == 0x27 and data[i+1] in [0x01, 0x03, 0x05, 0x07, 0x09, 0x11, 0x13, 0x15, 0x17, 0x19, 0x21, 0x23]:
            ctx = data[i:i+16]
            findings["security_access"].append({
                "offset": hex(i),
                "level": hex(data[i+1]),
                "context": ctx.hex()
            })
    findings["security_access"] = findings["security_access"][:50]

    # VIN patterns (17-char alphanumeric)
    text = data.decode('ascii', errors='ignore')
    for m in re.finditer(r'[A-HJ-NPR-Z0-9]{17}', text):
        findings["vin_patterns"].append({"vin": m.group(), "offset": hex(m.start())})
    findings["vin_patterns"] = findings["vin_patterns"][:20]

    # CRC polynomials
    crc_polys = {
        b'\x21\x10': "CRC-16 CCITT (0x1021)",
        b'\x05\x80': "CRC-16 IBM (0x8005)",
        b'\xB7\x1D\xC1\x04': "CRC-32 (0x04C11DB7)",
        b'\xED\xB8\x83\x20': "CRC-32C (0x1EDC6F41)",
    }
    for poly_bytes, name in crc_polys.items():
        idx = 0
        while True:
            pos = data.find(poly_bytes, idx)
            if pos == -1:
                break
            findings["crc_polynomials"].append({"name": name, "offset": hex(pos), "bytes": poly_bytes.hex()})
            idx = pos + 1
    findings["crc_polynomials"] = findings["crc_polynomials"][:20]

    # 4-5 digit PIN patterns in strings
    for m in re.finditer(r'\b\d{4,5}\b', text):
        findings["pin_patterns"].append({"value": m.group(), "offset": hex(m.start())})
    findings["pin_patterns"] = findings["pin_patterns"][:30]

    # GPEC magic bytes
    gpec_markers = [b'\xAA\x55', b'\x55\xAA', b'\xFF\x00\xFF', b'\x00\xFF\x00']
    for marker in gpec_markers:
        pos = data.find(marker)
        if pos != -1:
            ctx = data[pos:pos+16]
            findings["gpec_patterns"].append({"marker": marker.hex(), "offset": hex(pos), "context": ctx.hex()})

    return findings

def parse_pe(data: bytes) -> dict:
    """Parse Windows PE structure using pefile."""
    try:
        import pefile
        pe = pefile.PE(data=data)
        result = {
            "type": "PE",
            "machine": hex(pe.FILE_HEADER.Machine),
            "timestamp": pe.FILE_HEADER.TimeDateStamp,
            "sections": [],
            "imports": [],
            "exports": [],
            "resources": [],
        }

        for section in pe.sections:
            name = section.Name.decode('utf-8', errors='ignore').strip('\x00')
            result["sections"].append({
                "name": name,
                "virtual_address": hex(section.VirtualAddress),
                "size": section.SizeOfRawData,
                "entropy": round(section.get_entropy(), 2),
            })

        if hasattr(pe, 'DIRECTORY_ENTRY_IMPORT'):
            for entry in pe.DIRECTORY_ENTRY_IMPORT:
                dll = entry.dll.decode('utf-8', errors='ignore')
                funcs = []
                for imp in entry.imports:
                    if imp.name:
                        funcs.append(imp.name.decode('utf-8', errors='ignore'))
                result["imports"].append({"dll": dll, "functions": funcs[:50]})

        if hasattr(pe, 'DIRECTORY_ENTRY_EXPORT'):
            for exp in pe.DIRECTORY_ENTRY_EXPORT.symbols:
                if exp.name:
                    result["exports"].append(exp.name.decode('utf-8', errors='ignore'))

        return result
    except Exception as e:
        return {"type": "PE_parse_error", "error": str(e)}

def extract_pyinstaller(data: bytes, tmpdir: str) -> dict:
    """Extract and decompile Python bytecode from a PyInstaller EXE."""
    result = {
        "is_pyinstaller": False,
        "python_version": None,
        "modules": [],
        "decompiled_sources": [],
        "interesting_code": [],
    }

    # Check for PyInstaller magic
    if b'PYZ-00.pyz' not in data and b'zPYZ.pyz' not in data and b'MEIPASS' not in data:
        return result

    result["is_pyinstaller"] = True

    # Write to temp file for extraction
    exe_path = os.path.join(tmpdir, "target.exe")
    with open(exe_path, 'wb') as f:
        f.write(data)

    # Try to find the CArchive (PyInstaller's embedded ZIP)
    # PyInstaller appends a ZIP at the end of the EXE
    try:
        # Find the ZIP magic bytes from the end
        zip_magic = b'PK\x03\x04'
        # Search backwards from end for ZIP
        pos = data.rfind(zip_magic)
        if pos != -1:
            zip_data = data[pos:]
            zip_path = os.path.join(tmpdir, "archive.zip")
            with open(zip_path, 'wb') as f:
                f.write(zip_data)
            try:
                with zipfile.ZipFile(zip_path, 'r') as zf:
                    names = zf.namelist()
                    result["modules"] = names[:100]

                    # Extract and decompile .pyc files
                    for name in names:
                        if name.endswith('.pyc') or name.endswith('.pyo'):
                            try:
                                pyc_data = zf.read(name)
                                pyc_path = os.path.join(tmpdir, os.path.basename(name))
                                with open(pyc_path, 'wb') as pf:
                                    pf.write(pyc_data)

                                # Decompile with uncompyle6
                                src_path = pyc_path + ".py"
                                decompile_result = subprocess.run(
                                    ["uncompyle6", "-o", src_path, pyc_path],
                                    capture_output=True, text=True, timeout=10
                                )
                                if os.path.exists(src_path):
                                    with open(src_path, 'r', errors='ignore') as sf:
                                        src = sf.read()
                                    if len(src) > 50:
                                        result["decompiled_sources"].append({
                                            "module": name,
                                            "source": src[:8000]  # cap per module
                                        })
                            except Exception:
                                pass
            except Exception:
                pass
    except Exception:
        pass

    # Also try PyInstxtractor approach — find the PKG/CArchive
    try:
        # PyInstaller magic string
        magic = b'MEI\x0c\x0b\x0a\x0b\x0e'
        pos = data.find(magic)
        if pos != -1:
            result["pyinstaller_magic_offset"] = hex(pos)
    except Exception:
        pass

    # Extract interesting automotive-related code patterns from decompiled sources
    automotive_keywords = [
        'seed', 'key', 'vin', 'can', 'uds', 'ecu', 'bcm', 'skim', 'rfhub',
        'gpec', 'crc', 'checksum', 'security', 'access', 'session', 'diagnostic',
        'download', 'flash', 'program', 'calibration', 'pin', 'unlock', 'boot',
        'algorithm', 'polynomial', 'xor', 'sha', 'md5', 'aes', 'des',
        '0x27', '0x10', '0x2e', '0x34', '0x36', '0x31',
    ]
    for src_entry in result["decompiled_sources"]:
        src = src_entry["source"].lower()
        for kw in automotive_keywords:
            if kw in src:
                # Extract surrounding lines
                lines = src_entry["source"].split('\n')
                for i, line in enumerate(lines):
                    if kw.lower() in line.lower():
                        ctx_lines = lines[max(0,i-3):i+6]
                        result["interesting_code"].append({
                            "module": src_entry["module"],
                            "keyword": kw,
                            "context": '\n'.join(ctx_lines)
                        })
                        break  # one hit per keyword per module

    return result

def build_hex_chunks(data: bytes, chunk_size=4096) -> list:
    """Build annotated hex chunks for LLM consumption."""
    chunks = []
    total = len(data)
    # Sample: header (first 8KB), middle sections, tail (last 4KB)
    regions = []

    if total <= 32768:
        # Small file — send everything
        regions = [(0, total, "full")]
    else:
        # Large file — send strategic regions
        regions = [
            (0, 8192, "header"),
            (total // 4, total // 4 + 4096, "quarter_1"),
            (total // 2, total // 2 + 4096, "midpoint"),
            (3 * total // 4, 3 * total // 4 + 4096, "quarter_3"),
            (max(0, total - 4096), total, "tail"),
        ]

    for start, end, label in regions:
        end = min(end, total)
        chunk = data[start:end]
        hex_lines = []
        for i in range(0, len(chunk), 16):
            row = chunk[i:i+16]
            hex_part = ' '.join(f'{b:02x}' for b in row)
            ascii_part = ''.join(chr(b) if 32 <= b < 127 else '.' for b in row)
            hex_lines.append(f"{start+i:08x}  {hex_part:<48}  |{ascii_part}|")
        chunks.append({
            "region": label,
            "offset_start": hex(start),
            "offset_end": hex(end),
            "hex": '\n'.join(hex_lines[:256])  # max 256 lines per chunk
        })

    return chunks

def dissect(filepath: str) -> dict:
    """Main dissection entry point."""
    with open(filepath, 'rb') as f:
        data = f.read()

    file_hash = hashlib.sha256(data).hexdigest()
    file_size = len(data)

    # Basic file type detection
    file_type_raw = run_cmd(["file", filepath]).strip()

    # All strings
    all_strings = extract_strings(data)

    # Automotive pattern scan
    automotive = find_automotive_patterns(data)

    # PE parsing
    pe_info = {}
    if data[:2] == b'MZ':
        pe_info = parse_pe(data)

    # ELF parsing
    elf_info = {}
    if data[:4] == b'\x7fELF':
        elf_info = {
            "type": "ELF",
            "readelf_headers": run_cmd(["readelf", "-h", filepath])[:2000],
            "readelf_sections": run_cmd(["readelf", "-S", filepath])[:3000],
            "readelf_symbols": run_cmd(["readelf", "-s", filepath])[:3000],
        }

    # objdump for disassembly sample
    disasm = ""
    if data[:2] == b'MZ' or data[:4] == b'\x7fELF':
        disasm = run_cmd(["objdump", "-d", "--no-show-raw-insn", filepath], timeout=20)[:8000]

    # PyInstaller extraction
    with tempfile.TemporaryDirectory() as tmpdir:
        pyinstaller_info = extract_pyinstaller(data, tmpdir)

    # Hex chunks
    hex_chunks = build_hex_chunks(data)

    # Interesting strings (automotive-focused)
    automotive_string_keywords = [
        'seed', 'key', 'vin', 'can', 'uds', 'ecu', 'bcm', 'skim', 'rfhub',
        'gpec', 'crc', 'checksum', 'security', 'access', 'session', 'diagnostic',
        'download', 'flash', 'program', 'calibration', 'pin', 'boot', 'algorithm',
        'polynomial', 'xor', 'sha', 'md5', 'aes', 'des', 'fca', 'stellantis',
        'chrysler', 'dodge', 'jeep', 'ram', 'mopar', 'witech', 'alpha', 'gpec',
        'python', 'import', 'def ', 'class ', 'return', 'serial', 'socket',
        'connect', 'send', 'recv', 'byte', 'struct', 'pack', 'unpack',
    ]
    interesting_strings = [
        s for s in all_strings
        if any(kw.lower() in s["value"].lower() for kw in automotive_string_keywords)
    ][:500]

    return {
        "sha256": file_hash,
        "file_size": file_size,
        "file_type": file_type_raw,
        "is_pe": data[:2] == b'MZ',
        "is_elf": data[:4] == b'\x7fELF',
        "pe_info": pe_info,
        "elf_info": elf_info,
        "disassembly_sample": disasm,
        "pyinstaller": pyinstaller_info,
        "automotive_patterns": automotive,
        "interesting_strings": interesting_strings,
        "all_strings_count": len(all_strings),
        "hex_chunks": hex_chunks,
    }

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No file path provided"}))
        sys.exit(1)

    filepath = sys.argv[1]
    if not os.path.exists(filepath):
        print(json.dumps({"error": f"File not found: {filepath}"}))
        sys.exit(1)

    try:
        result = dissect(filepath)
        print(json.dumps(result, default=str))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
