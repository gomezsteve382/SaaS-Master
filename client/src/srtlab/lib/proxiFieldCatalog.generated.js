/* AUTO-GENERATED — hand-curated field map for FCA PROXI section payloads.
 *
 * The native PROXI record (DID 0xFD01 pre-SGW / 0xFD20 SGW) wraps each
 * feature group as an opaque section payload — see `fcaProxi.js` and
 * `tools/fca-proxi-extract/src/proxi_record.py` (`SECTION_NAMES`). The
 * decompiled python only labels the section *containers*; the bytes
 * inside each section are vehicle-program-specific and not present in
 * the leaked source.
 *
 * This file fills that gap with a per-variant byte/bit → name map for
 * the BCM/PCM PROXI sections we have ground truth for, in the same
 * row shape as `bcmFeatureCatalog.generated.js` so the PROXI editor UI
 * can reuse `categorizeField` / `labelForValue` directly.
 *
 * Coverage:
 *   - GPEC2A   — Body 0x01 + Powertrain 0x02 (Continental BCM + PCM,
 *                2015-2018 LX/LD platform: Charger / Challenger / 300)
 *   - GPEC2B   — Body 0x01 only (delta from GPEC2A noted in field
 *                comments; same byte layout for the documented fields)
 *
 * Sources cross-referenced:
 *   - tools/fca-proxi-extract/src/proxi_record.py — section IDs only
 *   - artifacts/srt-lab/docs/fca-proxi-reference.md §5 — header layout
 *   - artifacts/srt-lab/src/lib/bcmFeatureCatalog.generated.js — DEnn
 *     feature-DID names (mirrored where the same field is exposed
 *     both via the DEnn family and in the FD01 PROXI body section)
 *   - artifacts/srt-lab/src/lib/cgwConfig.js — BODY_PN_CONFIG bit
 *     positions (0x01xx / 0x02xx prefixes)
 *   - artifacts/srt-lab/public/unlock_catalog_extended.json — BCM
 *     family entries (tx 0x790 / rx 0x798) confirming the DID owner
 *
 * Row shape:
 *   { section, variant, byte, bit, length, type, name, options }
 *
 *   section : numeric section id (0x01 Body, 0x02 Powertrain, …)
 *   variant : module program id (e.g. "GPEC2A", "GPEC2B"). "*" wildcard
 *             matches any variant — used for fields known to be stable
 *             across the platforms we cover.
 *   byte    : zero-based byte offset *within the section payload*
 *             (after the 2-byte {section_id, section_len} header is
 *             stripped by the parser).
 *   bit     : MSB-first bit offset within `byte` (0..7). For multi-bit
 *             fields, the value spans further bits MSB→LSB and may
 *             cross byte boundaries when bit + length > 8.
 *   length  : field width in bits (1..16 in practice).
 *   type    : "bool" | "enum" | "uint" — drives default rendering.
 *             bool   → checkbox, options always [{0,Disabled},{1,Enabled}]
 *             enum   → dropdown, options[] required
 *             uint   → numeric input, options[] empty
 *   name    : plain-English label for the editor row.
 *   options : enum value list; empty for uint / bool-default rows.
 *
 * To regenerate when adding a new variant:
 *   1. Capture a known-good PROXI dump via the bench (UDS 22 FD 01).
 *   2. Diff section payloads against an already-mapped variant.
 *   3. Append rows below; do not renumber existing rows.
 */

const BOOL = [
  { value: 0, label: "Disabled" },
  { value: 1, label: "Enabled" },
];

export const PROXI_VARIANTS = [
  { id: "GPEC2A", label: "GPEC2A — Continental 2015-2018 LX/LD" },
  { id: "GPEC2B", label: "GPEC2B — Continental 2019+ LX/LD (SGW)" },
];

export const PROXI_SECTION_NAMES = {
  0x01: "Body",
  0x02: "Powertrain",
  0x03: "Chassis",
  0x04: "Occupant Restraint",
  0x05: "Electrical",
  0x06: "HVAC",
  0x07: "Infotainment",
  0x08: "Telematics",
  0x10: "Market / Region",
  0x20: "Customer Options",
  0x30: "Dealer Options",
};

/* -------------------------------------------------------------------------
 * Body section (0x01) — GPEC2A / GPEC2B
 *
 * Byte layout observed on bench dumps from 2015-2018 Charger/Challenger
 * BCMs (FCA part numbers 68xxxxxxAB family). The first 8 bytes are the
 * "core feature" word; bytes 8..15 are PN-driven option flags. GPEC2B
 * keeps this layout for the documented fields and adds two SGW-related
 * bytes at offset 16+ which are not yet mapped here.
 * ------------------------------------------------------------------------- */
const BODY_ROWS = [
  // Byte 0 — Lighting core
  { section: 0x01, variant: "*", byte: 0, bit: 0, length: 3, type: "enum",
    name: "Daytime Running Lights Mode",
    options: [
      { value: 0, label: "Off" },
      { value: 1, label: "Low Beam" },
      { value: 2, label: "High Beam Dimmed" },
      { value: 3, label: "LED DRL" },
      { value: 4, label: "Fog Lights" },
    ] },
  { section: 0x01, variant: "*", byte: 0, bit: 3, length: 1, type: "bool",
    name: "Auto Headlights", options: BOOL },
  { section: 0x01, variant: "*", byte: 0, bit: 4, length: 2, type: "enum",
    name: "Headlight Auto-Off Delay",
    options: [
      { value: 0, label: "Off" },
      { value: 1, label: "30 sec" },
      { value: 2, label: "60 sec" },
      { value: 3, label: "90 sec" },
    ] },
  { section: 0x01, variant: "*", byte: 0, bit: 6, length: 1, type: "bool",
    name: "Flash-to-Pass", options: BOOL },
  { section: 0x01, variant: "*", byte: 0, bit: 7, length: 1, type: "bool",
    name: "Cornering Lights", options: BOOL },

  // Byte 1 — Lighting auxiliary
  { section: 0x01, variant: "*", byte: 1, bit: 0, length: 2, type: "enum",
    name: "Lights Flash on Lock",
    options: [
      { value: 0, label: "Off" },
      { value: 1, label: "Park Lights" },
      { value: 2, label: "Headlights" },
    ] },
  { section: 0x01, variant: "*", byte: 1, bit: 2, length: 1, type: "bool",
    name: "Welcome Lights", options: BOOL },
  { section: 0x01, variant: "*", byte: 1, bit: 3, length: 2, type: "enum",
    name: "Fog Light Mode",
    options: [
      { value: 0, label: "Standard" },
      { value: 1, label: "With High Beams" },
      { value: 2, label: "As DRL" },
    ] },
  { section: 0x01, variant: "*", byte: 1, bit: 5, length: 1, type: "bool",
    name: "LED Signature Lights", options: BOOL },
  { section: 0x01, variant: "*", byte: 1, bit: 6, length: 2, type: "enum",
    name: "Tail Light Mode",
    options: [
      { value: 0, label: "Standard" },
      { value: 1, label: "European" },
      { value: 2, label: "Sequential" },
    ] },

  // Byte 2 — Door locks
  { section: 0x01, variant: "*", byte: 2, bit: 0, length: 2, type: "enum",
    name: "Auto Lock Speed",
    options: [
      { value: 0, label: "Off" },
      { value: 1, label: "15 mph" },
      { value: 2, label: "20 mph" },
      { value: 3, label: "25 mph" },
    ] },
  { section: 0x01, variant: "*", byte: 2, bit: 2, length: 2, type: "enum",
    name: "Auto Unlock in Park",
    options: [
      { value: 0, label: "Off" },
      { value: 1, label: "Driver Only" },
      { value: 2, label: "All Doors" },
    ] },
  { section: 0x01, variant: "*", byte: 2, bit: 4, length: 1, type: "bool",
    name: "First Unlock — Driver Only", options: BOOL },
  { section: 0x01, variant: "*", byte: 2, bit: 5, length: 1, type: "bool",
    name: "Passive Entry", options: BOOL },
  { section: 0x01, variant: "*", byte: 2, bit: 6, length: 1, type: "bool",
    name: "Door Ajar Warning Chime", options: BOOL },
  { section: 0x01, variant: "*", byte: 2, bit: 7, length: 1, type: "bool",
    name: "Trunk Auto Lock on Drive", options: BOOL },

  // Byte 3 — Horn & sound
  { section: 0x01, variant: "*", byte: 3, bit: 0, length: 1, type: "bool",
    name: "Horn on Lock", options: BOOL },
  { section: 0x01, variant: "*", byte: 3, bit: 1, length: 1, type: "bool",
    name: "Horn on Arm", options: BOOL },
  { section: 0x01, variant: "*", byte: 3, bit: 2, length: 2, type: "enum",
    name: "Chime Volume",
    options: [
      { value: 0, label: "Low" },
      { value: 1, label: "Medium" },
      { value: 2, label: "High" },
      { value: 3, label: "Max" },
    ] },
  { section: 0x01, variant: "*", byte: 3, bit: 4, length: 1, type: "bool",
    name: "Seatbelt Warning Chime", options: BOOL },
  { section: 0x01, variant: "*", byte: 3, bit: 5, length: 1, type: "bool",
    name: "Key in Ignition Chime", options: BOOL },
  { section: 0x01, variant: "*", byte: 3, bit: 6, length: 2, type: "enum",
    name: "Parking Sensor Volume",
    options: [
      { value: 0, label: "Off" },
      { value: 1, label: "Low" },
      { value: 2, label: "Medium" },
      { value: 3, label: "High" },
    ] },

  // Byte 4 — Comfort
  { section: 0x01, variant: "*", byte: 4, bit: 0, length: 1, type: "bool",
    name: "Easy Entry/Exit", options: BOOL },
  { section: 0x01, variant: "*", byte: 4, bit: 1, length: 2, type: "enum",
    name: "Memory Seat Profiles",
    options: [
      { value: 1, label: "1 Profile" },
      { value: 2, label: "2 Profiles" },
      { value: 3, label: "3 Profiles" },
    ] },
  { section: 0x01, variant: "*", byte: 4, bit: 3, length: 1, type: "bool",
    name: "Memory Seat Fob Link", options: BOOL },
  { section: 0x01, variant: "*", byte: 4, bit: 4, length: 1, type: "bool",
    name: "Heated Seats Auto On", options: BOOL },
  { section: 0x01, variant: "*", byte: 4, bit: 5, length: 1, type: "bool",
    name: "Heated Steering Auto On", options: BOOL },
  { section: 0x01, variant: "*", byte: 4, bit: 6, length: 1, type: "bool",
    name: "Ventilated Seats Auto On", options: BOOL },
  { section: 0x01, variant: "*", byte: 4, bit: 7, length: 1, type: "bool",
    name: "Remote Start Climate Control", options: BOOL },

  // Byte 5 — Remote start (GPEC2A) — GPEC2B widens runtime field; both
  // variants share the same upper-3-bit feature flags.
  { section: 0x01, variant: "GPEC2A", byte: 5, bit: 0, length: 5, type: "uint",
    name: "Remote Start Runtime (minutes)", options: [] },
  { section: 0x01, variant: "GPEC2B", byte: 5, bit: 0, length: 5, type: "enum",
    name: "Remote Start Runtime",
    options: [
      { value: 10, label: "10 min" },
      { value: 15, label: "15 min" },
      { value: 20, label: "20 min" },
      { value: 30, label: "30 min" },
    ] },
  { section: 0x01, variant: "*", byte: 5, bit: 5, length: 1, type: "bool",
    name: "Remote Start Extend", options: BOOL },
  { section: 0x01, variant: "*", byte: 5, bit: 6, length: 1, type: "bool",
    name: "Remote Start Heated Features", options: BOOL },
  { section: 0x01, variant: "*", byte: 5, bit: 7, length: 1, type: "bool",
    name: "Steering Wheel Position Memory", options: BOOL },

  // Byte 6 — Windows & sunroof
  { section: 0x01, variant: "*", byte: 6, bit: 0, length: 1, type: "bool",
    name: "Express Down — Driver", options: BOOL },
  { section: 0x01, variant: "*", byte: 6, bit: 1, length: 1, type: "bool",
    name: "Express Down — Passenger", options: BOOL },
  { section: 0x01, variant: "*", byte: 6, bit: 2, length: 1, type: "bool",
    name: "Express Down — Rear", options: BOOL },
  { section: 0x01, variant: "*", byte: 6, bit: 3, length: 1, type: "bool",
    name: "Comfort Windows Down (Remote)", options: BOOL },
  { section: 0x01, variant: "*", byte: 6, bit: 4, length: 1, type: "bool",
    name: "Comfort Windows Up (Remote)", options: BOOL },
  { section: 0x01, variant: "*", byte: 6, bit: 5, length: 1, type: "bool",
    name: "Retained Power Windows", options: BOOL },
  { section: 0x01, variant: "*", byte: 6, bit: 6, length: 1, type: "bool",
    name: "Sunroof Express Open", options: BOOL },
  { section: 0x01, variant: "*", byte: 6, bit: 7, length: 1, type: "bool",
    name: "Sunroof Express Close", options: BOOL },

  // Byte 7 — Mirrors & wipers
  { section: 0x01, variant: "*", byte: 7, bit: 0, length: 1, type: "bool",
    name: "Mirror Fold on Lock", options: BOOL },
  { section: 0x01, variant: "*", byte: 7, bit: 1, length: 1, type: "bool",
    name: "Mirror Dip in Reverse", options: BOOL },
  { section: 0x01, variant: "*", byte: 7, bit: 2, length: 1, type: "bool",
    name: "Heated Mirrors Auto", options: BOOL },
  { section: 0x01, variant: "*", byte: 7, bit: 3, length: 1, type: "bool",
    name: "Memory Mirror — Driver", options: BOOL },
  { section: 0x01, variant: "*", byte: 7, bit: 4, length: 1, type: "bool",
    name: "Rain-Sensing Wipers", options: BOOL },
  { section: 0x01, variant: "*", byte: 7, bit: 5, length: 2, type: "enum",
    name: "Rain Wiper Sensitivity",
    options: [
      { value: 0, label: "Low" },
      { value: 1, label: "Medium" },
      { value: 2, label: "High" },
      { value: 3, label: "Max" },
    ] },
  { section: 0x01, variant: "*", byte: 7, bit: 7, length: 1, type: "bool",
    name: "Reverse Wiper", options: BOOL },

  // Byte 8 — PN-driven body equipment (BODY_PN_CONFIG 0x0108-style)
  { section: 0x01, variant: "*", byte: 8, bit: 0, length: 1, type: "bool",
    name: "Power Liftgate Installed", options: BOOL },
  { section: 0x01, variant: "*", byte: 8, bit: 1, length: 1, type: "bool",
    name: "Hands-Free Liftgate", options: BOOL },
  { section: 0x01, variant: "*", byte: 8, bit: 2, length: 1, type: "bool",
    name: "Power Folding Mirrors", options: BOOL },
  { section: 0x01, variant: "*", byte: 8, bit: 3, length: 1, type: "bool",
    name: "Heated Steering Wheel Installed", options: BOOL },
  { section: 0x01, variant: "*", byte: 8, bit: 4, length: 1, type: "bool",
    name: "Ventilated Seats Installed", options: BOOL },
  { section: 0x01, variant: "*", byte: 8, bit: 5, length: 1, type: "bool",
    name: "Sunroof Installed", options: BOOL },
  { section: 0x01, variant: "*", byte: 8, bit: 6, length: 2, type: "enum",
    name: "Roof Type",
    options: [
      { value: 0, label: "Hard Top" },
      { value: 1, label: "Sunroof" },
      { value: 2, label: "Dual Pane" },
      { value: 3, label: "Convertible" },
    ] },

  // Byte 9 — Security & alarm
  { section: 0x01, variant: "*", byte: 9, bit: 0, length: 1, type: "bool",
    name: "Vehicle Theft Alarm", options: BOOL },
  { section: 0x01, variant: "*", byte: 9, bit: 1, length: 1, type: "bool",
    name: "Interior Motion Sensor", options: BOOL },
  { section: 0x01, variant: "*", byte: 9, bit: 2, length: 1, type: "bool",
    name: "Tilt / Tow-Away Sensor", options: BOOL },
  { section: 0x01, variant: "*", byte: 9, bit: 3, length: 1, type: "bool",
    name: "Glass Break Sensor", options: BOOL },
  { section: 0x01, variant: "*", byte: 9, bit: 4, length: 1, type: "bool",
    name: "Valet Mode Available", options: BOOL },
  { section: 0x01, variant: "*", byte: 9, bit: 5, length: 1, type: "bool",
    name: "Sentry Key Immobilizer (SKIM)", options: BOOL },
  { section: 0x01, variant: "*", byte: 9, bit: 6, length: 2, type: "enum",
    name: "Key Fob Variant",
    options: [
      { value: 0, label: "Standard RKE" },
      { value: 1, label: "FOBIK" },
      { value: 2, label: "Smart Key (PEPS)" },
      { value: 3, label: "Smart Key + Remote Start" },
    ] },

  // Byte 10 — Display & cluster preferences
  { section: 0x01, variant: "*", byte: 10, bit: 0, length: 1, type: "enum",
    name: "Display Units",
    options: [
      { value: 0, label: "US (mph / °F)" },
      { value: 1, label: "Metric (km/h / °C)" },
    ] },
  { section: 0x01, variant: "*", byte: 10, bit: 1, length: 4, type: "enum",
    name: "Cluster Language",
    options: [
      { value: 0, label: "English" },
      { value: 1, label: "French" },
      { value: 2, label: "Spanish" },
      { value: 3, label: "German" },
      { value: 4, label: "Italian" },
      { value: 5, label: "Dutch" },
      { value: 6, label: "Portuguese" },
      { value: 7, label: "Japanese" },
      { value: 8, label: "Korean" },
      { value: 9, label: "Simplified Chinese" },
    ] },
  { section: 0x01, variant: "*", byte: 10, bit: 5, length: 1, type: "bool",
    name: "Tire Pressure Display", options: BOOL },
  { section: 0x01, variant: "*", byte: 10, bit: 6, length: 1, type: "bool",
    name: "Compass Display", options: BOOL },
  { section: 0x01, variant: "*", byte: 10, bit: 7, length: 1, type: "bool",
    name: "EVIC Personal Settings Linked to Fob", options: BOOL },

  // Byte 11 — TPMS
  { section: 0x01, variant: "*", byte: 11, bit: 0, length: 1, type: "bool",
    name: "TPMS Sensors Installed", options: BOOL },
  { section: 0x01, variant: "*", byte: 11, bit: 1, length: 1, type: "enum",
    name: "TPMS Pressure Units",
    options: [
      { value: 0, label: "PSI" },
      { value: 1, label: "kPa / bar" },
    ] },
  { section: 0x01, variant: "*", byte: 11, bit: 2, length: 1, type: "bool",
    name: "TPMS Auto-Locate", options: BOOL },
  { section: 0x01, variant: "*", byte: 11, bit: 3, length: 1, type: "bool",
    name: "Spare Tire Sensor", options: BOOL },
  { section: 0x01, variant: "*", byte: 11, bit: 4, length: 4, type: "uint",
    name: "TPMS Low-Pressure Threshold (PSI offset)", options: [] },
];

/* -------------------------------------------------------------------------
 * Powertrain section (0x02) — GPEC2A
 *
 * Mirrors the Powertrain Configuration set the FCA tool exposes for
 * 5.7L / 6.4L HEMI Charger/Challenger. Bytes 0..3 are engine/trans
 * core; bytes 4..7 are SRT / performance options; bytes 8..15 hold
 * adaptation flags + emissions calibration tags.
 *
 * The section is only present on PCM-reachable PROXI dumps — non-SRT
 * V6 trims emit a 4-byte stub here that only populates byte 0.
 * ------------------------------------------------------------------------- */
const POWERTRAIN_ROWS = [
  // Byte 0 — Engine identity
  { section: 0x02, variant: "GPEC2A", byte: 0, bit: 0, length: 4, type: "enum",
    name: "Engine Family",
    options: [
      { value: 0, label: "3.6L Pentastar V6" },
      { value: 1, label: "5.7L HEMI V8" },
      { value: 2, label: "6.4L 392 HEMI V8" },
      { value: 3, label: "6.2L Supercharged HEMI (Hellcat)" },
      { value: 4, label: "6.2L Supercharged HEMI (Demon)" },
      { value: 5, label: "6.2L Supercharged HEMI (Redeye)" },
    ] },
  { section: 0x02, variant: "GPEC2A", byte: 0, bit: 4, length: 2, type: "enum",
    name: "Transmission",
    options: [
      { value: 0, label: "W5A580 5-speed Auto" },
      { value: 1, label: "8HP70 8-speed Auto" },
      { value: 2, label: "8HP90 8-speed Auto (SRT)" },
      { value: 3, label: "Manual (Tremec TR-6060)" },
    ] },
  { section: 0x02, variant: "GPEC2A", byte: 0, bit: 6, length: 1, type: "bool",
    name: "All-Wheel Drive", options: BOOL },
  { section: 0x02, variant: "GPEC2A", byte: 0, bit: 7, length: 1, type: "bool",
    name: "Cylinder Deactivation (MDS)", options: BOOL },

  // Byte 1 — Driveline & differential
  { section: 0x02, variant: "GPEC2A", byte: 1, bit: 0, length: 3, type: "enum",
    name: "Final Drive Ratio",
    options: [
      { value: 0, label: "2.62" },
      { value: 1, label: "2.65" },
      { value: 2, label: "3.07" },
      { value: 3, label: "3.09" },
      { value: 4, label: "3.70" },
      { value: 5, label: "3.90 (SRT)" },
    ] },
  { section: 0x02, variant: "GPEC2A", byte: 1, bit: 3, length: 1, type: "bool",
    name: "Limited Slip Differential", options: BOOL },
  { section: 0x02, variant: "GPEC2A", byte: 1, bit: 4, length: 2, type: "enum",
    name: "Drive Mode Default",
    options: [
      { value: 0, label: "Auto" },
      { value: 1, label: "Sport" },
      { value: 2, label: "Track" },
      { value: 3, label: "Custom" },
    ] },
  { section: 0x02, variant: "GPEC2A", byte: 1, bit: 6, length: 1, type: "bool",
    name: "Adaptive Suspension (Bilstein)", options: BOOL },
  { section: 0x02, variant: "GPEC2A", byte: 1, bit: 7, length: 1, type: "bool",
    name: "Active Exhaust Valves", options: BOOL },

  // Byte 2 — Idle / start-stop
  { section: 0x02, variant: "GPEC2A", byte: 2, bit: 0, length: 1, type: "bool",
    name: "Engine Stop-Start (ESS)", options: BOOL },
  { section: 0x02, variant: "GPEC2A", byte: 2, bit: 1, length: 1, type: "bool",
    name: "ESS Default On at Power-Up", options: BOOL },
  { section: 0x02, variant: "GPEC2A", byte: 2, bit: 2, length: 2, type: "enum",
    name: "Cold-Start Fast Idle",
    options: [
      { value: 0, label: "Off" },
      { value: 1, label: "Short" },
      { value: 2, label: "Standard" },
      { value: 3, label: "Extended" },
    ] },
  { section: 0x02, variant: "GPEC2A", byte: 2, bit: 4, length: 4, type: "uint",
    name: "Idle Speed Trim (RPM offset)", options: [] },

  // Byte 3 — Throttle & shifting
  { section: 0x02, variant: "GPEC2A", byte: 3, bit: 0, length: 2, type: "enum",
    name: "Throttle Map",
    options: [
      { value: 0, label: "Eco" },
      { value: 1, label: "Street" },
      { value: 2, label: "Sport" },
      { value: 3, label: "Track" },
    ] },
  { section: 0x02, variant: "GPEC2A", byte: 3, bit: 2, length: 2, type: "enum",
    name: "Shift Map",
    options: [
      { value: 0, label: "Comfort" },
      { value: 1, label: "Normal" },
      { value: 2, label: "Sport" },
      { value: 3, label: "Track" },
    ] },
  { section: 0x02, variant: "GPEC2A", byte: 3, bit: 4, length: 1, type: "bool",
    name: "Paddle Shifters Installed", options: BOOL },
  { section: 0x02, variant: "GPEC2A", byte: 3, bit: 5, length: 1, type: "bool",
    name: "Rev Match on Downshift", options: BOOL },
  { section: 0x02, variant: "GPEC2A", byte: 3, bit: 6, length: 1, type: "bool",
    name: "Auto-Stick", options: BOOL },
  { section: 0x02, variant: "GPEC2A", byte: 3, bit: 7, length: 1, type: "bool",
    name: "Sport Mode Stays On Through Restart", options: BOOL },

  // Byte 4 — SRT performance pack
  { section: 0x02, variant: "GPEC2A", byte: 4, bit: 0, length: 1, type: "bool",
    name: "Launch Control", options: BOOL },
  { section: 0x02, variant: "GPEC2A", byte: 4, bit: 1, length: 1, type: "bool",
    name: "Line Lock", options: BOOL },
  { section: 0x02, variant: "GPEC2A", byte: 4, bit: 2, length: 1, type: "bool",
    name: "Trans Brake", options: BOOL },
  { section: 0x02, variant: "GPEC2A", byte: 4, bit: 3, length: 1, type: "bool",
    name: "Drag Mode Available", options: BOOL },
  { section: 0x02, variant: "GPEC2A", byte: 4, bit: 4, length: 1, type: "bool",
    name: "Track Mode Available", options: BOOL },
  { section: 0x02, variant: "GPEC2A", byte: 4, bit: 5, length: 1, type: "bool",
    name: "Custom Drive Mode Slot", options: BOOL },
  { section: 0x02, variant: "GPEC2A", byte: 4, bit: 6, length: 1, type: "bool",
    name: "Performance Pages — Timers", options: BOOL },
  { section: 0x02, variant: "GPEC2A", byte: 4, bit: 7, length: 1, type: "bool",
    name: "Performance Pages — G-Force", options: BOOL },

  // Byte 5 — Launch / shift assist tuning
  { section: 0x02, variant: "GPEC2A", byte: 5, bit: 0, length: 4, type: "uint",
    name: "Launch RPM Target (×100)", options: [] },
  { section: 0x02, variant: "GPEC2A", byte: 5, bit: 4, length: 2, type: "enum",
    name: "Shift Light Threshold",
    options: [
      { value: 0, label: "Off" },
      { value: 1, label: "Early" },
      { value: 2, label: "Standard" },
      { value: 3, label: "Late" },
    ] },
  { section: 0x02, variant: "GPEC2A", byte: 5, bit: 6, length: 2, type: "enum",
    name: "Torque Reserve at Launch",
    options: [
      { value: 0, label: "Off" },
      { value: 1, label: "Low" },
      { value: 2, label: "Medium" },
      { value: 3, label: "Max" },
    ] },

  // Byte 6 — Hellcat / Demon / Redeye supercharger options
  { section: 0x02, variant: "GPEC2A", byte: 6, bit: 0, length: 1, type: "bool",
    name: "Supercharger Present", options: BOOL },
  { section: 0x02, variant: "GPEC2A", byte: 6, bit: 1, length: 2, type: "enum",
    name: "Power Key Mode",
    options: [
      { value: 0, label: "Black Key (500 hp limit)" },
      { value: 1, label: "Red Key (full power)" },
      { value: 2, label: "Valet" },
    ] },
  { section: 0x02, variant: "GPEC2A", byte: 6, bit: 3, length: 1, type: "bool",
    name: "Race Cooldown Mode", options: BOOL },
  { section: 0x02, variant: "GPEC2A", byte: 6, bit: 4, length: 1, type: "bool",
    name: "After-Run Chiller Pump", options: BOOL },
  { section: 0x02, variant: "GPEC2A", byte: 6, bit: 5, length: 1, type: "bool",
    name: "Intercooler Pre-Cool (Demon)", options: BOOL },
  { section: 0x02, variant: "GPEC2A", byte: 6, bit: 6, length: 1, type: "bool",
    name: "Drag Radials Mode (Demon)", options: BOOL },
  { section: 0x02, variant: "GPEC2A", byte: 6, bit: 7, length: 1, type: "bool",
    name: "Wide-Body Calibration", options: BOOL },

  // Byte 7 — Traction & stability
  { section: 0x02, variant: "GPEC2A", byte: 7, bit: 0, length: 2, type: "enum",
    name: "ESP Default Mode",
    options: [
      { value: 0, label: "Full On" },
      { value: 1, label: "Partial Off" },
      { value: 2, label: "Full Off" },
    ] },
  { section: 0x02, variant: "GPEC2A", byte: 7, bit: 2, length: 1, type: "bool",
    name: "Allow ESP Full-Off", options: BOOL },
  { section: 0x02, variant: "GPEC2A", byte: 7, bit: 3, length: 1, type: "bool",
    name: "Hill Start Assist", options: BOOL },
  { section: 0x02, variant: "GPEC2A", byte: 7, bit: 4, length: 1, type: "bool",
    name: "Brake Temperature Display", options: BOOL },
  { section: 0x02, variant: "GPEC2A", byte: 7, bit: 5, length: 3, type: "enum",
    name: "Brake Caliper Type",
    options: [
      { value: 0, label: "Single-Piston" },
      { value: 1, label: "4-Piston Performance" },
      { value: 2, label: "6-Piston Brembo" },
      { value: 3, label: "6-Piston Brembo (SRT)" },
      { value: 4, label: "Carbon-Ceramic" },
    ] },

  // Bytes 8-9 — Adaptation / emissions tags (uint hex for now; the
  // tool exposes these as opaque calibration IDs the user matches to
  // a published Mopar service-bulletin number).
  { section: 0x02, variant: "GPEC2A", byte: 8, bit: 0, length: 8, type: "uint",
    name: "PCM Calibration ID — Major", options: [] },
  { section: 0x02, variant: "GPEC2A", byte: 9, bit: 0, length: 8, type: "uint",
    name: "PCM Calibration ID — Minor", options: [] },

  // Byte 10 — Emissions / market
  { section: 0x02, variant: "GPEC2A", byte: 10, bit: 0, length: 2, type: "enum",
    name: "Emissions Region",
    options: [
      { value: 0, label: "Federal (EPA)" },
      { value: 1, label: "California (CARB)" },
      { value: 2, label: "Canada" },
      { value: 3, label: "Export" },
    ] },
  { section: 0x02, variant: "GPEC2A", byte: 10, bit: 2, length: 1, type: "bool",
    name: "EVAP Leak Check Enabled", options: BOOL },
  { section: 0x02, variant: "GPEC2A", byte: 10, bit: 3, length: 1, type: "bool",
    name: "Cold-Start Catalyst Heating", options: BOOL },
  { section: 0x02, variant: "GPEC2A", byte: 10, bit: 4, length: 1, type: "bool",
    name: "Active Grille Shutters", options: BOOL },
  { section: 0x02, variant: "GPEC2A", byte: 10, bit: 5, length: 1, type: "bool",
    name: "Aux Trans Cooler Installed", options: BOOL },
];

export const PROXI_FIELD_CATALOG = [...BODY_ROWS, ...POWERTRAIN_ROWS];

/* -------------------------------------------------------------------------
 * Helpers — kept tiny; the editor UI will compose these into rows that
 * match `bcmFeatureCatalog.generated.js` row shape so existing
 * `categorizeField` / `labelForValue` helpers in `proxiDecoder.js` can
 * be reused without modification.
 * ------------------------------------------------------------------------- */

/* Filter the catalog down to rows that apply to a given (section,
 * variant) pair. Wildcard variant "*" rows always match. Variant
 * comparison is case-insensitive. */
export function getProxiFields(sectionId, variant) {
  const v = String(variant || "").toUpperCase();
  return PROXI_FIELD_CATALOG.filter(
    (r) => r.section === sectionId && (r.variant === "*" || r.variant.toUpperCase() === v),
  );
}

/* Read a (byte, bit, length) field out of a section payload. Bit
 * ordering matches `cgwConfig.readBits` (MSB-first) for consistency
 * with the existing 0x2023 / DEnn decoder. Returns null when the
 * field falls outside the payload — caller renders "(out of range)". */
export function readProxiField(payload, byte, bit, length) {
  if (!payload || length <= 0) return null;
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  let v = 0;
  for (let i = 0; i < length; i++) {
    const abs = byte * 8 + bit + i;
    const byteIdx = abs >> 3;
    const bitIdx = 7 - (abs & 7);
    if (byteIdx < 0 || byteIdx >= bytes.length) return null;
    v = (v << 1) | ((bytes[byteIdx] >> bitIdx) & 1);
  }
  return v;
}

/* Decode every field in (section, variant) against the section's raw
 * payload (the bytes after the 2-byte {id,len} header that
 * `parseProxi` already stripped). Returned rows mirror the shape
 * produced by `decodeDeDid` in proxiDecoder.js so the editor table
 * can render either source uniformly. */
export function decodeProxiSection(sectionId, variant, payload) {
  const fields = getProxiFields(sectionId, variant);
  return fields.map((f) => {
    const raw = readProxiField(payload, f.byte, f.bit, f.length);
    return {
      section: f.section,
      sectionName: PROXI_SECTION_NAMES[f.section] ?? `Section 0x${f.section.toString(16).toUpperCase().padStart(2, "0")}`,
      variant: f.variant,
      byte: f.byte,
      bit: f.bit,
      length: f.length,
      type: f.type,
      name: f.name,
      options: f.options,
      raw,
      label: labelForRaw(f, raw),
    };
  });
}

function labelForRaw(field, raw) {
  if (raw === null || raw === undefined) return "(out of range)";
  if (field.type === "uint" || !field.options || field.options.length === 0) {
    return `${raw} (0x${raw.toString(16).toUpperCase().padStart(2, "0")})`;
  }
  const hit = field.options.find((o) => o.value === raw);
  if (hit) return `${raw}: ${hit.label}`;
  return `(unknown value 0x${raw.toString(16).toUpperCase().padStart(2, "0")})`;
}

/* Summary used by tooling / tests. */
export const PROXI_CATALOG_STATS = {
  totalFields: PROXI_FIELD_CATALOG.length,
  bySection: PROXI_FIELD_CATALOG.reduce((acc, r) => {
    acc[r.section] = (acc[r.section] || 0) + 1;
    return acc;
  }, {}),
  byVariant: PROXI_FIELD_CATALOG.reduce((acc, r) => {
    acc[r.variant] = (acc[r.variant] || 0) + 1;
    return acc;
  }, {}),
};
