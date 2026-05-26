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

Run with: `pnpm --filter @workspace/srt-lab test`
