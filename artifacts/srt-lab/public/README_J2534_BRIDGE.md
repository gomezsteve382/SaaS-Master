# SRT Lab — J2534 HTTP Bridge

A small local Python daemon that lets the hosted SRT Lab web app drive a
real **J2534 PassThru** vehicle communication interface (VCI) — most
commonly an **Autel MaxiFlash** for 2018+ FCA Secure-Gateway (SGW)
vehicles, but any compliant J2534 device works.

The bridge runs on **your** machine (Windows / macOS / Linux), loads the
vendor's J2534 DLL with `ctypes`, and exposes it over plain HTTP on
`127.0.0.1:8765`. The browser-side UI in **AUTEL SGW** tab talks to it
directly.

---

## 0. Why this is HTTP-only and stdlib-only

- **No `pip install` needed.** Python 3.8+ ships everything we use
  (`http.server`, `ctypes`, `threading`, `json`).
- **HTTP is easier to debug** than WebSockets — you can `curl`
  every endpoint while wiring things up.
- **CORS is permissive** so the hosted SRT Lab page can call
  `http://127.0.0.1:8765` from the browser without a proxy.

---

## 1. Install the vendor driver

You need the **J2534 DLL** for your VCI. The bridge does not ship it;
that is licensed by the vendor.

| VCI                              | Where to get the DLL                                     |
| -------------------------------- | -------------------------------------------------------- |
| Autel MaxiFlash / MaxiSys / IM608 | Install **Autel MaxiPC** (or MaxiFlash Elite Manager).  |
| Drew Tech CarDAQ-Plus / Mongoose | Install Drew Tech J2534 toolbox.                         |
| OBDLink EX / MX+                 | Install OBDLink + scantool.net J2534 driver.             |
| Tactrix Openport 2.0             | Install OpenPort drivers.                                |

After installing, locate the DLL. On Windows the Autel one is typically:

```
C:\Program Files (x86)\Autel\MaxiPC\MaxiFlashJ2534.dll
```

Or you can browse `HKLM\SOFTWARE\WOW6432Node\PassThruSupport.04.04` in
`regedit` to see all registered devices and their `FunctionLibrary`
paths.

---

## 2. Run the bridge

### Windows (PowerShell or cmd)

```powershell
python j2534_bridge.py --dll "C:\Program Files (x86)\Autel\MaxiPC\MaxiFlashJ2534.dll"
```

### macOS / Linux

```bash
python3 j2534_bridge.py --dll /path/to/libj2534.so
```

### Useful flags

| Flag        | Default          | Meaning                                          |
| ----------- | ---------------- | ------------------------------------------------ |
| `--dll`     | _(none)_         | Path to the vendor J2534 DLL.                    |
| `--port`    | `8765`           | TCP port to bind.                                |
| `--host`    | `127.0.0.1`      | Bind address. Leave loopback unless you know better. |
| `--verbose` | off              | Log every request and TX/RX frame to stderr.    |
| `--no-open` | off              | Don't auto-`PassThruOpen` on start.              |

You should see something like:

```
================================================================
 SRT Lab — J2534 HTTP Bridge
================================================================
  Listening on   http://127.0.0.1:8765
  DLL            C:\Program Files (x86)\Autel\MaxiPC\MaxiFlashJ2534.dll
  Vendor         Autel MaxiFlash
  ...
  Device opened. firmware=V1.43 dll=V05.03 api=04.04
```

---

## 3. Verify in the SRT Lab UI

1. Open SRT Lab in your browser and switch to the **AUTEL SGW** tab.
2. The bridge URL field defaults to `http://localhost:8765` —
   leave it as-is unless you changed `--port`.
3. Click **Run Test**. You should see green `[OK]` lines for:
   - `/status` reachable
   - `PassThruOpen` succeeded
   - DLL / firmware / API versions read back
   - Vendor detected (e.g. *Autel MaxiFlash*)
4. Click **Save configuration** to persist the bridge URL in
   `localStorage` (`srtlab_autel`).
5. The header chip in the AUTEL tab will switch to
   **✓ BRIDGE CONNECTED**, and the top status strip will show
   **🔐 SGW REQ** whenever the loaded Master VIN is from a 2018+ truck.

---

## 4. HTTP API reference

All endpoints return JSON. Binary payloads are exchanged as **lower-case
hex strings** (no `0x` prefix, no spaces).

| Method | Path           | Body                                                | Returns                                  |
| ------ | -------------- | --------------------------------------------------- | ---------------------------------------- |
| GET    | `/status`      | —                                                   | bridge state, vendor, fw/dll/api versions |
| POST   | `/open`        | `{}`                                                | `PassThruOpen` result + versions          |
| POST   | `/connect`     | `{ "protocol": 6, "flags": 0, "baudrate": 500000 }` | `PassThruConnect` result                  |
| POST   | `/disconnect`  | `{}`                                                | `PassThruDisconnect` result               |
| POST   | `/close`       | `{}`                                                | `PassThruClose` result                    |
| POST   | `/setfilter`   | `{ "txId": 0x750, "rxId": 0x758 }`                  | `{ filterId }`                            |
| POST   | `/sendmsg`     | `{ "txId": 0x750, "data": "22f190", "flags": 64 }`  | `{ ok: true }`                            |
| POST   | `/readmsg`     | `{ "timeoutMs": 1000 }`                             | `{ msg: { canId, data, rxStatus, ts } }`  |

`protocol` defaults to `6` (ISO15765 / UDS). `flags` defaults to
`0x40` (`ISO15765_FRAME_PAD`) for `sendmsg`.

J2534 errors are returned as `{"ok": false, "error": "ERR_TIMEOUT: …"}`
with HTTP 500.

---

## 5. Troubleshooting

| Symptom                                        | Likely cause / fix                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `/open` returns `J2534 DLL not found`          | Wrong `--dll` path. Check the registry / install Autel MaxiPC.                                      |
| `OSError: [WinError 193]` on Windows           | You loaded a **64-bit** Python with a **32-bit** DLL (or vice-versa). Match Python bitness to DLL.  |
| `ERR_DEVICE_NOT_CONNECTED`                     | VCI not plugged in, or another tool (MaxiSys app) has it open. Close the vendor app and retry.      |
| `ERR_TIMEOUT` on `/readmsg`                    | Normal when the bus is idle. Increase `timeoutMs` or send a request first.                          |
| Browser shows "Cannot reach bridge"            | Daemon not running, wrong port, or local firewall blocking loopback. Try `curl http://localhost:8765/status`. |
| Mac says "developer cannot be verified" on DLL | macOS `.dylib` from an unsigned vendor. Right-click → Open in Finder once to allow.                 |
| Linux can't load `.so`                         | Vendor library wants `LD_LIBRARY_PATH`. Run `LD_LIBRARY_PATH=/opt/vendor/lib python3 j2534_bridge.py …`. |

---

## 6. Security notes

- The bridge binds to **`127.0.0.1` only by default**. Do **not**
  change `--host` to `0.0.0.0` on a network you don't trust — anyone
  who can reach the port can flash your ECUs.
- There is no authentication. Treat the daemon like a local debug
  server: only run it while you're using SRT Lab.
- The bridge is **just a relay**. It does not bypass FCA Secure
  Gateway authentication — the Autel VCI handles that internally
  using your licensed Autel subscription. No subscription, no SGW.
- The bridge does **not** automatically perform writes. Every UDS
  request still has to be issued by the web app, and the existing
  pre-write confirmation modal continues to gate destructive
  operations.

---

## 7. Quick smoke test (without the UI)

```bash
# In another terminal
curl http://127.0.0.1:8765/status
curl -X POST http://127.0.0.1:8765/open -H 'Content-Type: application/json' -d '{}'
curl -X POST http://127.0.0.1:8765/connect -H 'Content-Type: application/json' \
     -d '{"protocol":6,"baudrate":500000}'
curl -X POST http://127.0.0.1:8765/setfilter -H 'Content-Type: application/json' \
     -d '{"txId":1872,"rxId":1880}'
curl -X POST http://127.0.0.1:8765/sendmsg -H 'Content-Type: application/json' \
     -d '{"txId":1872,"data":"22f190"}'
curl -X POST http://127.0.0.1:8765/readmsg -H 'Content-Type: application/json' \
     -d '{"timeoutMs":2000}'
```

If you get a real positive response (`62 f1 90 …`), the bridge is
talking to the vehicle.
