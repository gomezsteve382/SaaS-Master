# FCA PROXI Tool — Reverse Engineering Reference

> Internal bench reference. Do not redistribute.  
> Derived from: decompiled Python source (`tools/fca-proxi-extract/src/`),
> `Readme.txt`, `license.json`, WinLicense build log for GPEC Unlocker, and
> bench-captured UDS traces.

---

## 1. HWID Algorithm

The tool generates a 4-segment HWID string like `2899614-B9E65D4-73F1D98-D6D5DCB`.

**Segments:** Each segment is a 7-hex-digit (28-bit) value derived from a
different hardware identifier, formatted without `0x` prefix.

| Segment | Source |
|---------|--------|
| 1 (`2899614`) | CPU identifier — from `WMI Win32_Processor.ProcessorId`, XOR-folded to 28 bits |
| 2 (`B9E65D4`) | Motherboard serial — from `WMI Win32_BaseBoard.SerialNumber`, CRC-32 truncated |
| 3 (`73F1D98`) | Primary MAC address — first 6 bytes of the lowest-numbered active NIC |
| 4 (`D6D5DCB`) | Volume serial number of the system drive (C:) via `GetVolumeInformation` |

**Derivation pseudocode (from decompiled `hwid.py`):**
```python
def make_segment(raw_bytes: bytes) -> str:
    crc = binascii.crc32(raw_bytes) & 0xFFFFFFF   # 28-bit mask
    return format(crc, '07X')                       # 7 uppercase hex digits

hwid = '-'.join([
    make_segment(cpu_id_bytes),
    make_segment(mb_serial_bytes),
    make_segment(mac_bytes),
    make_segment(vol_serial_bytes),
])
```

**Anti-VM / Anti-debug checks:** The tool checks for VMware/VirtualBox CPUID
signatures (leaf `0x40000000`) and for the `IsDebuggerPresent` Windows API
before computing the HWID. If either check fires it returns a scrambled HWID
that will never match a valid activation key.

---

## 2. Activation Key Format

The key is an 80-character string over the alphabet
`ABCDEFGHIJKLMNOPQRSTUVWXYZ234567` (RFC 4648 base32, no `=` padding).

**Example:**  
`BS4JTT2G2AYR86KZ545HAEXTAHXZYNBP95U6GSBZZBC8PMDHT23YZEKXRQN6LG7PQCSJ2Z93GRD8Z3RM3R`

**Layout:**
```
Bytes [0..9]   — product edition flags (AES-256-CBC encrypted)
Bytes [10..19] — HWID binding — the four 28-bit segments packed into 14 bytes
Bytes [20..39] — feature bitmask (128 bits)
Bytes [40..79] — HMAC-SHA256 of [0..39] under a hardcoded product key
```

**Validation flow (from `license_check.py`):**
1. Base32-decode the 80-char string → 50 raw bytes.
2. AES-256-CBC decrypt bytes [0..15] with key = SHA-256(`chichitoworkshop` + HWID).
3. Compare decrypted HWID binding in bytes [10..19] against the live HWID.
4. Verify HMAC-SHA256 over bytes [0..39].

**Bypass:** `shfolder.dll` hooks `LoadLibraryExW` and intercepts the
`cryptography`-library call that performs step 3. The hooked function always
returns `True` for the HWID comparison, making the key valid on any machine.

---

## 3. `license.json` Schema

```json
{
  "v":        "1.2.0.1",           // tool version string — must match EXE version
  "product":  "FCA PROXI Tool",    // product name sentinel
  "request":  "chichitoworkshop",  // activation request nonce (any value accepted by bypass)
  "edition":  "chichitoworkshop",  // edition token (any value accepted by bypass)
  "features": ["chichitoworkshop"],// feature list (any array accepted by bypass)
  "sig":      "chichitoworkshop"   // HMAC-SHA256 signature — validated by shfolder.dll as always-OK
}
```

**Normal (non-bypassed) validation:**
- `sig` = base64(HMAC-SHA256(`v+product+request+edition+features.join(',')`, server_secret))
- The EXE checks `sig` on startup and on every PROXI write operation.

**Bypass:** `shfolder.dll` replaces the HMAC verification function with a
stub that returns `True` whenever `sig == "chichitoworkshop"` (or for any
non-empty string — the exact check varies by build; the `chichitoworkshop`
sentinel is the safe choice).

---

## 4. `.key` File Envelope

The `chichitoworkshop.key` file (6 649 bytes) is an AES-CBC encrypted blob:

```
Offset  Len  Field
------  ---  -----
0x00    4    Magic: 0x4B455946 ('KEYF')
0x04    4    Format version: 0x00000001
0x08    16   IV (AES-CBC initialisation vector)
0x18    N    Ciphertext (padded to 16-byte boundary with PKCS7)
```

**Key derivation:**
```python
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

kdf = PBKDF2HMAC(
    algorithm=hashes.SHA256(),
    length=32,
    salt=b'FCAProxiToolSalt',   # hardcoded in the EXE
    iterations=100_000,
)
key = kdf.derive(hwid.encode('ascii'))  # HWID string as the password
```

The decrypted plaintext is the raw activation payload (same content as the
base32-decoded activation key). The bypass makes decryption succeed
unconditionally by short-circuiting the plaintext check.

---

## 5. PROXI Record Format

A PROXI record is a 128-byte (0x80) vehicle-specific configuration blob
stored in the BCM. It is exchanged via UDS:

- **Read:** service 0x22, DID 0xFD01 (pre-SGW) or 0xFD20 (SGW platforms)
- **Write:** service 0x2E, same DID

### Header (bytes 0x00–0x03)

| Offset | Len | Field | Notes |
|--------|-----|-------|-------|
| 0x00 | 1 | `section_count` | Number of sections that follow (typically 8) |
| 0x01 | 1 | `format_version` | 0x01 or 0x02 |
| 0x02 | 2 | `total_length` | **Little-endian** byte count incl. header + CRC |

### Sections (bytes 0x04 … total_length–3)

Each section:

| Offset | Len | Field |
|--------|-----|-------|
| +0 | 1 | `section_id` |
| +1 | 1 | `section_len` (payload only, not including these 2 bytes) |
| +2 | N | Payload bytes |

### Known Section IDs

| ID | Name |
|----|------|
| 0x01 | Body |
| 0x02 | Powertrain |
| 0x03 | Chassis |
| 0x04 | Occupant Restraint |
| 0x05 | Electrical |
| 0x06 | HVAC |
| 0x07 | Infotainment |
| 0x08 | Telematics |
| 0x10 | Market / Region |
| 0x20 | Customer Options |
| 0x30 | Dealer Options |

### CRC (last 2 bytes)

Big-endian CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) over all bytes
from 0x00 to `total_length–3` inclusive.

### Cross-reference to `unlock_catalog_extended.json`

The BCM PROXI DID 0xFD01 is listed in the catalog under family `bcm` with
tx_can_id 0x790 / rx_can_id 0x798 (standard Chrysler BCM CAN IDs). The
`bcm.dll` security unlock (seed→key via `cfBCM`) must be completed before
0x2E writes are accepted.

---

## 6. UDS Services Issued by the Tool

When reading or writing a PROXI on a live vehicle (non-SGW), FCA PROXI Tool
issues the following UDS sequence:

```
→ 10 03          DiagnosticSessionControl — Extended (0x03)
← 50 03 ...

→ 27 01          SecurityAccess — RequestSeed level 1
← 67 01 [seed]

→ 27 02 [key]   SecurityAccess — SendKey level 1
← 67 02

→ 22 FD 01       ReadDataByIdentifier — PROXI DID
← 62 FD 01 [128 bytes of PROXI record]

// (user edits fields in the tool UI)

→ 2E FD 01 [128 bytes]   WriteDataByIdentifier — PROXI DID
← 6E FD 01

→ 11 01          ECUReset — Hard
← 51 01
```

On SGW-protected platforms (2019+ with Secure Gateway Module):
- DID changes to 0xFD20.
- An additional SGW authentication handshake (Autel MaxiFlash proprietary)
  is required before any 0x2E is accepted.

---

## 7. External Tools Tab

The **External Tools** tab in SRT Lab (`src/tabs/ExternalToolsTab.jsx`) lists
each vendored tool with:

- **Name / version** — from `manifest.json`
- **Status** — present / missing / wrong HWID / bridge offline (polled from
  `POST /tools/status` every 12 seconds)
- **Launch button** — calls `POST /tools/launch` on the J2534 bridge, which:
  1. Reads `manifest.json` and verifies that each file's byte size matches.
  2. Spawns the EXE via `subprocess.Popen(cwd=vendor_dir)`.
  3. Returns `{ ok: true, pid: <pid> }` or `{ ok: false, error: "..." }`.
- **Reveal in folder** button — calls `POST /tools/reveal`, which opens an
  Explorer / Finder window at the vendor directory.

---

## 8. Native JS Module (`src/lib/fcaProxi.js`)

`fcaProxi.js` implements:

| Export | Purpose |
|--------|---------|
| `parseProxi(buffer)` | Parse a PROXI binary → structured object |
| `serializeProxi(parsed)` | Serialize back to bytes (recomputes CRC) |
| `buildProxi(sections, version)` | Build a synthetic PROXI from a section array |
| `validateLicenseJson(obj)` | Validate the license.json envelope shape |
| `verifyManifest(manifest, fileSizeMap)` | Check file sizes against manifest |
| `SECTION_NAMES` | Section ID → human name map |

Round-trip guarantee: `serializeProxi(parseProxi(buf)).every((b,i) => b === buf[i])` 
holds for any well-formed PROXI record.
