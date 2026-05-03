/**
 * Vitest: VILLAIN VIN/SKIM/SRI DID dictionary assertions.
 *
 * Loads unlock_catalog_extended.json directly from the filesystem and asserts
 * that every DID and operation imported from VILLAIN is present with the
 * correct label and protocol scope.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const catalogPath = resolve(__dirname, "../../public/unlock_catalog_extended.json");
const catalog = JSON.parse(readFileSync(catalogPath, "utf-8"));

const VILLAIN_DIDs = [
  { hex: "0x7B90",      label: "Current VIN" },
  { hex: "0x7B88",      label: "Original VIN" },
  { hex: "0x6E2025",    label: "Bus-Transmitted VIN" },
  { hex: "0x6E2027",    label: "WCM Configured VIN" },
  { hex: "0x6E9EB0",    label: "SKIM State (0x80=Enabled, 0x00=Disabled)" },
  { hex: "0x6EF190",    label: "EPS VIN" },
  { hex: "0xF79EB045",  label: "SKIM State Flag (SCI-B)" },
];

describe("VILLAIN DID map entries", () => {
  const didMaps = catalog?.uds?.did_maps ?? [];

  it("unlock_catalog_extended.json has a uds.did_maps array", () => {
    expect(Array.isArray(didMaps)).toBe(true);
    expect(didMaps.length).toBeGreaterThan(0);
  });

  it("contains a VILLAIN-sourced did_map entry", () => {
    const villainMap = didMaps.find((m) => m.name && m.name.includes("VILLAIN"));
    expect(villainMap).toBeDefined();
    expect(Array.isArray(villainMap.entries)).toBe(true);
    expect(villainMap.entries.length).toBeGreaterThanOrEqual(7);
  });

  for (const { hex, label } of VILLAIN_DIDs) {
    it(`DID ${hex} is labeled "${label}"`, () => {
      const allEntries = didMaps.flatMap((m) =>
        Array.isArray(m.entries) ? m.entries : Array.isArray(m.sample) ? m.sample : []
      );
      const match = allEntries.find(
        (e) => String(e.did).toLowerCase() === hex.toLowerCase() && e.value === label
      );
      expect(
        match,
        `Expected DID ${hex} with label "${label}" in uds.did_maps`
      ).toBeDefined();
    });
  }
});

describe("VILLAIN Operations section", () => {
  const ops = catalog?.villain_operations;

  it("villain_operations key exists at the top level", () => {
    expect(ops).toBeDefined();
    expect(ops.provenance).toMatch(/VILLAIN/i);
  });

  it("contains groups array with at least 10 named groups (all required protocols covered)", () => {
    expect(Array.isArray(ops?.groups)).toBe(true);
    expect(ops.groups.length).toBeGreaterThanOrEqual(10);
  });

  it("covers all 6 required protocol scopes", () => {
    const protocols = new Set((ops?.groups ?? []).map((g) => g.protocol));
    expect(protocols.has("CHRYSLER ECU CAN 11-BIT")).toBe(true);
    expect(protocols.has("CAN 29-BIT")).toBe(true);
    expect(protocols.has("SCI A ENGINE")).toBe(true);
    expect(protocols.has("SCI B ENGINE")).toBe(true);
    expect(protocols.has("CHRYSLER TIPM")).toBe(true);
    expect(protocols.has("EPS")).toBe(true);
  });

  const expectedGroups = [
    { name: "VIN Read/Write",                 protocol: "CHRYSLER ECU CAN 11-BIT" },
    { name: "VIN Read/Write (Extended CAN)",  protocol: "CAN 29-BIT" },
    { name: "SKIM State",                     protocol: "CHRYSLER ECU CAN 11-BIT" },
    { name: "SKIM State Flag (SCI-B)",        protocol: "SCI B ENGINE" },
    { name: "IMMO Keys",                      protocol: "CHRYSLER ECU CAN 11-BIT" },
    { name: "SRI Mileage",                    protocol: "SCI A ENGINE" },
    { name: "EPS VIN",                        protocol: "EPS" },
    { name: "EPROM",                          protocol: "SCI A ENGINE" },
    { name: "Tuner",                          protocol: "CHRYSLER ECU CAN 11-BIT" },
    { name: "TIPM VIN",                       protocol: "CHRYSLER TIPM" },
  ];

  for (const { name, protocol } of expectedGroups) {
    it(`group "${name}" exists with protocol "${protocol}"`, () => {
      const group = (ops?.groups ?? []).find((g) => g.name === name);
      expect(group, `Missing VILLAIN group "${name}"`).toBeDefined();
      expect(group.protocol).toBe(protocol);
      expect(Array.isArray(group.operations)).toBe(true);
      expect(group.operations.length).toBeGreaterThan(0);
    });
  }

  it('SKIM group documents "0x80=Enabled, 0x00=Disabled" in notes', () => {
    const skimGroup = (ops?.groups ?? []).find((g) => g.name === "SKIM State");
    const stateRead = (skimGroup?.operations ?? []).find(
      (o) => o.id === "skim_state_read"
    );
    expect(stateRead?.notes).toMatch(/0x80.*Enabled/i);
    expect(stateRead?.notes).toMatch(/0x00.*Disabled/i);
  });

  it("SKIM group has key slots 1-6", () => {
    const skimGroup = (ops?.groups ?? []).find((g) => g.name === "SKIM State");
    for (let i = 1; i <= 6; i++) {
      const slot = (skimGroup?.operations ?? []).find(
        (o) => o.id === `skim_key_slot_${i}`
      );
      expect(slot, `Missing SKIM key slot ${i}`).toBeDefined();
    }
  });

  it("IMMO Keys group has slots 1-6", () => {
    const immoGroup = (ops?.groups ?? []).find((g) => g.name === "IMMO Keys");
    for (let i = 1; i <= 6; i++) {
      const slot = (immoGroup?.operations ?? []).find(
        (o) => o.id === `immo_key_slot_${i}`
      );
      expect(slot, `Missing IMMO key slot ${i}`).toBeDefined();
    }
  });

  it("SRI Mileage group notes mention E2 prefix", () => {
    const sriGroup = (ops?.groups ?? []).find((g) => g.name === "SRI Mileage");
    const readOp = (sriGroup?.operations ?? []).find((o) => o.id === "sri_mileage_read");
    const writeOp = (sriGroup?.operations ?? []).find((o) => o.id === "sri_mileage_write");
    expect(readOp?.notes).toMatch(/E2/i);
    expect(writeOp?.notes).toMatch(/E2/i);
  });

  it("Tuner group has all 5 operations", () => {
    const tunerGroup = (ops?.groups ?? []).find((g) => g.name === "Tuner");
    const ids = (tunerGroup?.operations ?? []).map((o) => o.id);
    expect(ids).toContain("tuner_unlock_boot");
    expect(ids).toContain("tuner_write_ecu");
    expect(ids).toContain("tuner_read_ecu");
    expect(ids).toContain("tuner_write_eprom");
    expect(ids).toContain("tuner_read_eprom");
  });

  it("EPROM group has read/write/save operations", () => {
    const epromGroup = (ops?.groups ?? []).find((g) => g.name === "EPROM");
    const ids = (epromGroup?.operations ?? []).map((o) => o.id);
    expect(ids).toContain("eprom_read");
    expect(ids).toContain("eprom_write");
    expect(ids).toContain("eprom_save");
  });
});

describe("dids.js consumer path — VILLAIN DIDs reachable via getDidDescription()", () => {
  it("getDidDescription resolves Current VIN (0x7B90) from CRITICAL_DIDS seed", async () => {
    const { _resetDidDescriptionsForTests, getDidDescription } = await import("../lib/dids.js");
    _resetDidDescriptionsForTests();
    const label = getDidDescription(0x7B90);
    expect(label).toBe("Current VIN");
  });

  it("getDidDescription resolves Original VIN (0x7B88) from CRITICAL_DIDS seed", async () => {
    const { getDidDescription } = await import("../lib/dids.js");
    const label = getDidDescription(0x7B88);
    expect(label).toBe("Original VIN");
  });

  it("getDidDescription resolves Bus-Transmitted VIN (0x6E2025) from CRITICAL_DIDS seed", async () => {
    const { getDidDescription } = await import("../lib/dids.js");
    const label = getDidDescription(0x6E2025);
    expect(label).toBe("Bus-Transmitted VIN");
  });

  it("getDidDescription resolves WCM Configured VIN (0x6E2027) from CRITICAL_DIDS seed", async () => {
    const { getDidDescription } = await import("../lib/dids.js");
    const label = getDidDescription(0x6E2027);
    expect(label).toBe("WCM Configured VIN");
  });

  it("getDidDescription resolves SKIM State (0x6E9EB0) from CRITICAL_DIDS seed", async () => {
    const { getDidDescription } = await import("../lib/dids.js");
    const label = getDidDescription(0x6E9EB0);
    expect(label).toBe("SKIM State");
  });

  it("getDidDescription resolves EPS VIN (0x6EF190) from CRITICAL_DIDS seed", async () => {
    const { getDidDescription } = await import("../lib/dids.js");
    const label = getDidDescription(0x6EF190);
    expect(label).toBe("EPS VIN");
  });

  it("getDidDescription resolves shared-only DID 0xDE00 via @workspace/uds delegation", async () => {
    // 0xDE00 is in lib/uds DID_CATALOG (BCM configuration window) but is
    // not in CRITICAL_DIDS — so resolving it proves the seedFromShared-
    // Catalog() delegation path is wired up correctly.
    const { _resetDidDescriptionsForTests, getDidDescription } = await import("../lib/dids.js");
    _resetDidDescriptionsForTests();
    expect(getDidDescription(0xDE00)).toBe("BCM Configuration Block 00");
  });

  it("getDidDescriptions returns all distinct labels for SKIM State DID", async () => {
    const { getDidDescriptions } = await import("../lib/dids.js");
    const labels = getDidDescriptions(0x6E9EB0);
    expect(labels).toContain("SKIM State");
  });
});

describe("CRITICAL_DIDS baseline in backups.js", () => {
  it("backups.js CRITICAL_DIDS contains new VILLAIN BCM DIDs", async () => {
    const { CRITICAL_DIDS } = await import("../lib/backups.js");
    const bcm = CRITICAL_DIDS?.BCM ?? [];
    const dids = bcm.map((e) => e.did);
    expect(dids).toContain(0x6E2025);
    expect(dids).toContain(0x6E2027);
    expect(dids).toContain(0x6E9EB0);
  });

  it("backups.js CRITICAL_DIDS has EPS module with EPS VIN DID", async () => {
    const { CRITICAL_DIDS } = await import("../lib/backups.js");
    const eps = CRITICAL_DIDS?.EPS ?? [];
    const dids = eps.map((e) => e.did);
    expect(dids).toContain(0x6EF190);
    const epsVin = eps.find((e) => e.did === 0x6EF190);
    expect(epsVin?.critical).toBe(true);
  });
});
