# Transponder Writer Bridge — VVDI / Tango

Task #862. Adds the missing step between SRT Lab's RFHUB slot view and the
locksmith bench: instead of exporting bytes to a thumb drive and typing
them into Xhorse Key Tool Plus or Tango by hand, the **KEY WRITER** tab
hands a single slot's chip ID + the resolved RFHUB SEC16 master secret
straight to a USB-connected writer over Web Serial, runs ping → detect →
burn → verify, and returns control to the existing RoutineControl 0x0401
pairing on the RFHUB tab.

The bridge is intentionally narrow. SRT Lab does **not** unlock writer
firmware, ship dealer tokens, or replace the writer's own UI for diag
mode / coil tuning / odometer work. It is a one-button bench tool for
the FCA fobik chip-burn case only.

## Scope

| Concern                              | Owned by | Notes                                                                 |
|--------------------------------------|----------|-----------------------------------------------------------------------|
| Reading RFHUB dump + parsing slots   | SRT Lab  | `rfhubKeySlots.parseKeySlots` (already in repo)                       |
| Resolving SEC16 master secret        | SRT Lab  | First SEC16 slot from `parseKeySlots.sec16.slots[0].raw`              |
| Picking chip family                  | SRT Lab  | `chipFamilies.js` — default `pcf7953` for Gen2 RFHUB                  |
| Framing + I/O over USB-CDC           | SRT Lab  | `protocol.js` (5A A5 frame), `webSerialTransport.js`                  |
| Chip detection / burn / verify       | Writer   | We send the command, the writer talks to the chip                     |
| Vehicle pairing (RoutineControl 0x0401) | SRT Lab | Existing flow on the RFHUB tab — unchanged                            |

## File layout

```
src/lib/keyWriter/
├── chipFamilies.js       — PCF7953 / PCF7945 / Megamos-AES table
├── errors.js             — error-code → label
├── protocol.js           — 5A A5 framing + FrameReader resync
├── serializer.js         — BURN_KEY payload with refuse-on-doubt gates
├── simulator.js          — canned transport + fault profiles
├── webSerialTransport.js — browser Web Serial wrapper
└── index.js              — burnSlot driver (ping → detect → burn → verify)

src/tabs/KeyWriterTab.jsx — the UI
src/lib/__tests__/keyWriter.test.js — 21 unit tests
```

## Protocol notes (**unverified**)

Framing matches public Xhorse VVDI Mini USB-CDC captures (`5A A5 LEN CMD
PAYLOAD CRC`). This is best-effort — Xhorse does not publish a spec and
this code base has not bench-verified the byte layout against a real
device. **Run a few simulator burns first; treat the first live burn as
field-verification of the framing, not as a production write.**

Tango shares the broad shape (frame-with-CRC over USB-CDC) but uses a
different cmd table; the `writer` parameter is plumbed through to the
serializer so we can branch on it once a Tango capture lands.

Opcodes used (canonical, all unverified):

| Opcode | Name        | Direction | Payload                     |
|--------|-------------|-----------|-----------------------------|
| 0x01   | PING        | host→dev  | (empty)                     |
| 0x10   | DETECT_CHIP | host→dev  | `chipOrdinal`               |
| 0x30   | BURN_KEY    | host→dev  | `chipOrdinal | uidLen | UID | payloadLen | payload | secretLen | SEC16` |
| 0x31   | VERIFY      | host→dev  | `chipOrdinal | uidLen | UID | payloadLen | payload` |
| 0xF0   | RESET       | host→dev  | (empty)                     |
| 0x80   | ACK         | dev→host  | status payload              |
| 0x81   | NACK        | dev→host  | one-byte error code         |

Authoritative source is `src/lib/keyWriter/protocol.js` — `CMD.*`. If you edit one, edit both.

## Refuse-on-doubt gates

Lifted from `securityBytes.js`. `serializeBurnKey` refuses to even
build the frame if:

- chip family unknown
- slot `idBytes` length ≠ chip `uidBytes + payloadBytes`
- SEC16 length ≠ 16, or SEC16 is all-`0xFF` / all-`0x00`
- chip family does not list the writer in its `writers` array

`burnSlot()` short-circuits with `failedAt: 'burn'` and a structured
`reason` instead of silently sending garbage to the chip. The UI mirrors
this — the **Burn slot** button stays disabled until the RFHUB parse,
slot pick, chip family, and non-blank SEC16 are all in agreement.

## Handoff to RoutineControl 0x0401

The KEY WRITER tab is **chip burn only**. Once a slot reports `KEYMOD
WRITTEN`, the chip itself is paired against the SEC16 master secret but
the RFHUB's per-slot status byte (`AA-50` etc.) is unchanged from the
file you loaded. Bench operator hands the freshly burned chip back to
the car, switches to **RFHUB** tab, runs the existing key-programming
wizard against the same VIN, and the receiver accepts the chip on the
first try because UID + payload already match SEC16. No re-virginization,
no PIN dance.

## HTTP fallback (`/api/key-writer/transport/*`)

Web Serial is Chromium-only. For Firefox, locked-down corporate
browsers, and field laptops where Web Serial is disabled, the tab
exposes a **Probe HTTP fallback** button that hits the api-server.
Two endpoints, both in `artifacts/api-server/src/routes/keyWriter.ts`:

- `GET  /api/key-writer/transport/status` →
  `{ available, reason, model?, firmware? }`. If the server has no
  daemon configured (default), `available:false` with a clear reason
  so the UI can fall back to Simulator cleanly.
- `POST /api/key-writer/transport/send` accepts
  `{ frame: base64 }` and returns `{ frame: base64 }`. Without a
  configured daemon this returns 501 with a clear message.

The server reads `KEY_WRITER_DAEMON_URL` (and optional
`KEY_WRITER_DAEMON_TIMEOUT_MS`) and forwards requests to a small
desktop USB-CDC daemon that the bench operator runs locally. We
deliberately do **not** bundle a native `serialport` addon into the
web-server build — that turns the SRT Lab deploy into a hardware-
specific binary. The relay shape is intentionally trivial so any
language can implement the daemon.

Client side: `src/lib/keyWriter/httpTransport.js` mirrors the
`send(frame) → Promise<Uint8Array>` contract used by WebSerial and
Simulator, so the burn pipeline never needs to special-case transport.

## Writer detection

The **Detect writer** button issues a `CMD.PING` and parses the ACK
payload as `[status, modelId, fwMajor, fwMinor]`. `modelId 0x01` ⇒
"VVDI Mini Key Tool", `0x02` ⇒ "Tango". The result surfaces as
`Writer: …` / `Firmware: v…` pills on the transport card so the
operator can confirm the bench setup before sending real secret
bytes. Refuse-on-doubt: a non-ACK response or a short payload leaves
the pills cleared and surfaces the error in red.

## RFHUB handoff CTA

After a successful burn the tab renders a green **Open RFHUB tab**
button. Clicking it:

1. Writes `{slotIdx, chipId, writerId, at}` to
   `sessionStorage['srtlab:keywriter:handoff']` (one-shot — read +
   cleared by RfhubTab on mount).
2. Calls the parent's `onOpenTab('rfhub')` so the App switches tabs
   without the operator hunting for it.

RfhubTab renders a `<KeyWriterHandoffBanner/>` at the top of its
render output that surfaces the handoff record so the operator can
visually confirm the chip about to be paired matches the one that was
just burned.

## Test coverage

- `src/lib/__tests__/keyWriter.test.js` — framing round-trip,
  FrameReader resync against junk bytes, serializer refusal gates,
  chip family lookup, and the full `burnSlot` happy path + four
  fault profiles (no chip, wrong chip, locked, verify mismatch).
- `src/lib/__tests__/keyWriterFixture.test.js` — replays the
  recorded wire trace at
  `src/lib/keyWriter/__fixtures__/vvdi-mini-burn-trace.json` so any
  change to framing/serializer bytes trips a clear failure here
  instead of a live-hardware regression. Fixture is synthetic-but-
  stable today; the test stays valid the moment a real VVDI Mini
  capture replaces the bytes (flip `_meta.verified_against_hardware`
  to `true` at the same time).
- `src/tabs/__tests__/KeyWriterTab.ui.test.jsx` — Task #862 smoke
  test: mounts the tab, mocks `parseKeySlots`, walks load → pick
  slot → burn → KEYMOD WRITTEN → handoff CTA → sessionStorage record
  through the React DOM.
- `src/lib/__tests__/keyDump.test.js` — Key Dump capture/clone/export
  (below): `validateKeyRecord` refuse-on-doubt gates, `cloneKeyRecord`,
  `buildKeyDumpManifest` JSON shape + SK-vs-SEC16 honesty note,
  `buildKeyDumpBin`/`parseKeyDumpBin` round-trip, and
  `writeKeyRecordToSlot` clone-on-bench (UID into a free RFHUB slot).

Run with: `pnpm --filter @workspace/srt-lab test`

## Bench verification procedure (for the locksmith)

Until the steps below are executed against a real Xhorse VVDI Mini, the
disclaimer at the top of this file and the orange banner on the KEY
WRITER tab stay in place. **Do not flip them on speculation.**

### What you need on the bench

- A real Xhorse VVDI Mini Key Tool, USB cable, working host driver.
- At least one sacrificial PCF7953 chip (a known-blank fobik insert is
  fine — the burn is destructive).
- A loaded RFHUB dump in SRT Lab whose first SEC16 slot is **non-blank**
  (gate refuses all-`0xFF` / all-`0x00`).
- A USB-CDC packet capture tool:
  - Windows: Wireshark + USBPcap (filter on the writer's interface).
  - Linux: `usbmon` + `tshark -i usbmonN -Y 'usb.src==... || usb.dst==...'`.
  - macOS: `wireshark` against the IOUSBHost interface, or run the burn
    through the HTTP fallback daemon and log frames there — easier.

### Capture procedure

1. Start the packet capture **before** plugging the writer in, so the
   enumeration descriptors are recorded too (useful if `modelId` /
   firmware shape needs to change).
2. In SRT Lab → KEY WRITER, set transport to **Web Serial** (or **HTTP
   fallback** if you're routing through the daemon), pick the same
   inputs the fixture pins:
   - `chipId: pcf7953`
   - `writer: vvdi-mini`
   - load any RFHUB whose first slot has a non-blank SEC16
3. Click **Detect writer** → record the ACK payload bytes.
4. Click **Burn slot** on the first slot. The pipeline will issue
   PING → DETECT_CHIP → BURN_KEY → VERIFY in that order.
5. Stop the capture. Export request/response pairs as hex.

### Folding the capture back into the repo

The fixture is engineered to accept a real capture as a drop-in
replacement. Do **not** rewrite the test; rewrite the fixture.

1. Open `src/lib/keyWriter/__fixtures__/vvdi-mini-burn-trace.json`.
2. Update `_meta.inputs` to the exact slot id bytes and SEC16 secret
   the bench actually used (else the contract test diverges from the
   hardware on inputs alone).
3. For each of the four `exchanges` entries (`ping`, `detect_chip`,
   `burn_key`, `verify`), paste the captured `request_hex` and
   `response_hex` in place of the synthetic bytes.
4. Run `pnpm --filter @workspace/srt-lab test
   src/lib/__tests__/keyWriterFixture.test.js`.
   - If `buildXxxRequest` byte-equality fails, the real writer disagrees
     with our serializer. Diff the bytes, decide which side is correct
     (almost always the writer), and update `protocol.js` /
     `serializer.js` until the test passes against the real capture.
   - If response parsing fails, update `protocol.js` `parseFrame` /
     `CMD.*` to match what the device actually sends.
5. Only after the test passes against the real bytes:
   - Set `_meta.verified_against_hardware: true`.
   - Replace the `source` and `notes` block with a one-line provenance
     (date, writer firmware version, capture tool).
   - In this file, replace the "**unverified**" labels in the Protocol
     notes section and remove the "treat the first live burn as field
     verification" sentence.
   - In `src/tabs/KeyWriterTab.jsx`, downgrade the orange "needs bench
     verification" disclaimer to a neutral "verified against VVDI Mini
     fw vX.Y on YYYY-MM-DD" pill.

### What changes if the writer is a Tango, not a VVDI Mini

Same procedure, but capture into a second fixture file
(`tango-burn-trace.json`) and add a parallel contract test. Do not
overload the VVDI fixture — the `writer` field in `_meta.inputs` is
what disambiguates, and the serializer is already plumbed to branch on
it.

---

# Key Dump — capture / clone / export

Task #985. The KEY WRITER tab also carries a **Key Dump** card (above
the RFHUB loader). This is the locksmith's "I read a transponder with my
external tool, now do something useful with it" surface. It is
independent of the USB-CDC burn pipeline above — it does not talk to a
writer, it works on captured bytes.

## What a Key Dump is

The operator reads a chip on their bench tool (Autel / VVDI / Tango) and
pastes the result into the card:

- **chip family** — `id46` (PCF7945), `pcf7945`, `pcf7953`,
  `megamos-aes` (`chipFamilies.js`).
- **transponder UID** — the chip's serial (e.g. `00 77 A2 9B`).
- **SK** — the *transponder secret key* the read tool recovered.
- **flags** — locked, coding scheme (Manchester/Biphase/PSK/FSK),
  encryption, cloneable.

### SK is NOT SEC16

This is the load-bearing safety rule of the whole feature. **SK is the
transponder's own secret; SEC16 is the vehicle/RFHUB immobilizer master
secret.** They are different bytes with different lengths and different
roles. The manifest writes an explicit `_sk_warning` field saying so,
and nothing in this code path ever copies SEC16 into the SK field or
vice-versa. If you extend this surface, keep them in separate slots.

## Two outputs (both confirmed wanted)

1. **Clone on bench** — `writeKeyRecordToSlot(bytes, idx, {uid, payload,
   overwrite})` in `rfhubKeySlots.js` stamps the captured UID into a
   free slot of a **loaded RFHUB dump**, sets the `AA-50` marker, and
   returns the patched buffer for download as a `.bin`. This is the
   "second blank key for the same car" path. Refuse-on-doubt: rejects a
   non-RFHUB buffer, an out-of-range index, an occupied slot (unless
   `overwrite`), and a missing/empty UID. The optional `payload` is the
   trailing bytes of the slot's ID block; when omitted the slot's
   payload bytes are zeroed and `payloadKnown:false` is returned so the
   caller knows the clone is UID-only.
2. **Portable export** — `buildKeyDumpManifest(record)` (JSON) +
   `buildKeyDumpBin({uid, sk, flags, chipId})` (`.bin`) in
   `autelExport.js` produce a portable key dump for an external chip
   writer. The `.bin` is a small `KDMP` container (magic `4B 44 4D 50`,
   version, chip ordinal, flags byte, uid, sk) that round-trips through
   `parseKeyDumpBin`.

## File layout (added for Task #985)

```
src/lib/keyWriter/
├── keyRecord.js   — makeKeyRecord / cloneKeyRecord / validateKeyRecord
├── chipFamilies.js — + id46 family, per-family skBytes
├── serializer.js   — CHIP_ORDINAL incl. id46
└── autelExport.js  — buildKeyDumpManifest / buildKeyDumpBin /
                       parseKeyDumpBin / keyDumpBaseName

src/lib/rfhubKeySlots.js — writeKeyRecordToSlot
src/tabs/KeyWriterTab.jsx — Key Dump card (data-testid: key-dump-*)
src/lib/__tests__/keyDump.test.js — unit tests
```
