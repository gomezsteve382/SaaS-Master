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

## Future: Express daemon

A future task can mirror this over an `/api/key-writer/*` endpoint
backed by a Node `serialport` daemon for desktop browsers without Web
Serial (Firefox, locked-down corporate Chromiums). Out of scope here
because the only existing native bridge — `tools/python-bridge/` — is
off-limits by user preference, and adding a second daemon is a separate
architecture call.

## Test coverage

`src/lib/__tests__/keyWriter.test.js` — 21 tests covering framing
round-trip, FrameReader resync against junk bytes, serializer refusal
gates, chip family lookup, and the full `burnSlot` happy path + four
fault profiles (no chip, wrong chip, locked, verify mismatch).

Run with: `pnpm --filter @workspace/srt-lab test`
