# MicroPod II Transport — Setup, Permissions & Transport Switch

This document covers everything needed to use the wiTECH MicroPod II as the
UDS transport for offline flash, VIN write, and module reset operations in
SRT Lab (Task #613).

## What this is

The MicroPod II adapter exposes the **same JSON-RPC surface** as the existing
Autel J2534 bridge (`j2534_bridge.py`) but targets the OEM Mopar pass-thru
device instead of the Autel MaxiFlash DLL.  All existing flows —
`flashEcuOffline()`, VIN write, module reset, ADCM routine unlock, SGW
re-unlock — work through either transport without any code changes.  The
operator picks one from the External Tools tab.

```
┌──────────────────────────────────┐
│   SRT Lab (React)                │
│   bridgeEngine.js                │
│   createEngineForActiveTransport │
└──────────┬──────────────┬────────┘
           │ j2534        │ micropod-ii
           ▼              ▼
  j2534_bridge.py   micropod_bridge.py
  (port 8765)       (port 8766)
  Autel DLL         USB bulk / pyusb
  J2534 DLL         MicroPod II
```

---

## Hardware requirements

| Item | Notes |
|------|-------|
| wiTECH MicroPod II | p/n 04718820AD or 05026360AD |
| Firmware | ≥ 4.0 (update via wiTECH 2.0 if needed) |
| USB cable | Included micro-B cable; use the supplied cable — third-party cables sometimes lack D+ signal integrity |

The bridge daemon uses **pyusb** to talk to the device at the USB bulk level.
It does **not** rely on the wiTECH 2.0 desktop application being installed,
but the device's USB driver (WinUSB on Windows, native HID on Linux) must be
present.

---

## Installation

### 1. Install pyusb

```bash
pip install pyusb
```

Linux additionally needs **libusb**:

```bash
# Debian / Ubuntu
sudo apt-get install libusb-1.0-0

# Arch
sudo pacman -S libusb

# macOS (Homebrew)
brew install libusb
```

### 2. Permission / udev rule (Linux only)

Without a udev rule the bridge will fail with `PERMISSION_DENIED` when it
tries to claim the USB interface.

Create `/etc/udev/rules.d/99-micropod.rules`:

```
SUBSYSTEM=="usb", ATTR{idVendor}=="0c2e", ATTR{idProduct}=="0a6b", MODE="0666", GROUP="plugdev"
```

Then reload:

```bash
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Log out and back in (or run `newgrp plugdev`) so your user inherits the group
membership.

### 3. Windows driver

On Windows the device normally enumerates under the wiTECH 2.0 WinUSB driver.
If it does not appear in Device Manager after plugging in, use **Zadig** to
install the WinUSB driver for VID 0x0C2E / PID 0x0A6B.

---

## Running the bridge

```bash
# From the project root:
python3 tools/python-bridge/bridge/micropod_bridge.py

# Override port:
python3 tools/python-bridge/bridge/micropod_bridge.py --port 8766

# Verbose USB framing:
python3 tools/python-bridge/bridge/micropod_bridge.py --verbose

# Probe-on-demand (do not open device at startup):
python3 tools/python-bridge/bridge/micropod_bridge.py --no-open
```

The daemon listens on `http://127.0.0.1:8766` by default. It will print the
pod's serial number and firmware version once the USB interface is claimed.

---

## Switching transports in SRT Lab

1. Open the **External Tools** tab.
2. Under **UDS TRANSPORT** you will see two panels — _Autel MaxiFlash J2534_
   and _wiTECH MicroPod II_.
3. The MicroPod II panel shows live status: daemon reachable, pod present,
   firmware version, serial number.
4. Click **Use MicroPod II** to select it.  The choice is persisted in
   `localStorage` (`srtlab_transport`) so it survives page refreshes.
5. All subsequent flash / VIN-write / reset operations in any tab will route
   through the MicroPod II bridge.  Click **Use J2534 Pass-Thru** to revert.

---

## Error codes

| Code | Meaning | Fix |
|------|---------|-----|
| `POD_NOT_FOUND` | No MicroPod II at VID 0x0C2E / PID 0x0A6B | Check USB cable; check Device Manager / `lsusb` |
| `PERMISSION_DENIED` | `claim_interface` failed | Add udev rule (Linux) or install WinUSB driver (Windows) |
| `FIRMWARE_TOO_OLD` | Firmware < 4.0 | Update via wiTECH 2.0 before using this bridge |
| `pyusb not installed` | Missing Python dependency | `pip install pyusb` |

---

## Provenance

The adapter surface is sourced from the CDA SWF class enumeration:

```
com.chrysler.cda.domain.discovery.device:MicroPodII
```

harvested into `tools/cda-extractor/out/harvestedStrings.generated.json`
under `#microPodSurface`.  The J2534-equivalent framing the pod exposes once
it is in diagnostic mode is documented in SAE J2534-2 and is the only
protocol this bridge uses — no Chrysler firmware or calibration data is
shipped, redistributed, or reverse-engineered here.

---

## Bench-trace test

A vitest bench-trace test pins the frame builder/parser contract and the UDS
engine surface so the framing cannot silently drift:

```bash
pnpm --filter @workspace/srt-lab exec vitest run micropodIITransport
```

The fixture-replay section (`describe.skip`) activates automatically once a
recorded trace file is placed at:

```
artifacts/srt-lab/src/lib/__fixtures__/micropodIITrace.fixture.json
```

Shape of the fixture:

```json
{
  "frames": [
    { "dir": "TX", "hex": "010100021003000007E00000000000", "canId": 2016 },
    { "dir": "RX", "hex": "020100025003000007E80000000000", "canId": 2024 }
  ]
}
```

---

## Scope

**In scope:**
- USB enumeration and bulk I/O for the MicroPod II in J2534 mode
- keepalive so the channel stays alive during long erase / transfer phases
- The same `/open /connect /setfilter /sendmsg /readmsg /disconnect /close`
  surface that `j2534_bridge.py` exposes

**Out of scope:**
- Shipping or redistributing any Chrysler-owned firmware or calibration files
- Reverse-engineering MicroPod II firmware updates
- Reworking the J2534 daemon (`j2534_bridge.py`) itself
- UI redesign beyond the transport selector and live-status panel
