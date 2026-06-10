/**
 * dispatchXRef.test.ts
 * Tests for the Seed-Key Dispatch Cross-Reference logic:
 *   - AOBD_DISPATCH (catalog) vs SK_DISPATCH (alfaobdSeedKey.js)
 *   - FCA_MODULE_ALGO unlock path completeness
 *   - AOBD_W6_TABLE wrapper coverage
 */
import { describe, it, expect } from "vitest";

// Import the generated catalog dispatch
// We use dynamic require-style import to avoid ESM issues with .js files
import { createRequire } from "module";
const require = createRequire(import.meta.url);

// Load the modules directly from source
const algosPath = "../client/src/srtlab/lib/alfaobdAlgorithms.generated.js";
const seedKeyPath = "../client/src/srtlab/lib/alfaobdSeedKey.js";

let AOBD_DISPATCH: Record<string, Record<string, string>>;
let AOBD_META: { w6_count: number; w7_count: number; dispatch_keys: number };
let SK_DISPATCH: Record<number, string>;
let FCA_MODULE_ALGO: Record<string, { algo: string; wrapper?: string; level: number; note?: string }>;
let AOBD_W6_TABLE: Record<string, [number, number]>;

// We'll use a beforeAll-style setup via top-level await in the describe block
// Since vitest supports top-level await in ESM, we import at module level
import * as algos from "../client/src/srtlab/lib/alfaobdAlgorithms.generated.js";
import * as seedKey from "../client/src/srtlab/lib/alfaobdSeedKey.js";

AOBD_DISPATCH = (algos as any).AOBD_DISPATCH;
AOBD_META = (algos as any).AOBD_META;
SK_DISPATCH = (seedKey as any).DISPATCH;
FCA_MODULE_ALGO = (seedKey as any).FCA_MODULE_ALGO;
AOBD_W6_TABLE = (seedKey as any).AOBD_W6_TABLE;

// ── Helper: build cross-reference rows (mirrors AlfaObdIntelTab logic) ──
function buildXRefRows() {
  const out: Array<{
    famKey: string;
    lvlKey: string;
    wrapper: string;
    inSeedKey: string | null;
    status: "match" | "mismatch" | "catalog-only" | "seedkey-only";
    wrapperComputable: boolean;
  }> = [];

  for (const [famKey, levels] of Object.entries(AOBD_DISPATCH)) {
    for (const [lvlKey, wrapper] of Object.entries(levels)) {
      if (lvlKey.startsWith("_")) continue;
      const famMatch = famKey.match(/family_(\d+)/);
      const lvlMatch = lvlKey.match(/aj_(\d+)/);
      const familyId = famMatch ? parseInt(famMatch[1]) : null;
      const secLevel = lvlMatch ? parseInt(lvlMatch[1]) : null;
      const dispKey =
        familyId != null && secLevel != null ? familyId * 100 + secLevel : null;
      const inSK = dispKey != null ? SK_DISPATCH[dispKey] : null;
      const wrapperMatch = inSK === wrapper;
      out.push({
        famKey,
        lvlKey,
        wrapper,
        inSeedKey: inSK || null,
        status: !inSK ? "catalog-only" : wrapperMatch ? "match" : "mismatch",
        wrapperComputable: !!(wrapper && AOBD_W6_TABLE[wrapper]),
      });
    }
  }

  for (const [key, wrapper] of Object.entries(SK_DISPATCH)) {
    const numKey = parseInt(key as string);
    const familyId = Math.floor(numKey / 100);
    const secLevel = numKey % 100;
    const famKey = `family_${familyId}`;
    const lvlKey = `aj_${secLevel}`;
    const inCatalog = AOBD_DISPATCH[famKey]?.[lvlKey];
    if (!inCatalog) {
      out.push({
        famKey,
        lvlKey,
        wrapper,
        inSeedKey: wrapper,
        status: "seedkey-only",
        wrapperComputable: !!(AOBD_W6_TABLE[wrapper]),
      });
    }
  }

  return out;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("AOBD_DISPATCH catalog structure", () => {
  it("has the expected number of dispatch keys from AOBD_META", () => {
    expect(Object.keys(AOBD_DISPATCH).length).toBe(AOBD_META.dispatch_keys);
  });

  it("contains family_27 (GPEC2A) with all four security levels", () => {
    const f27 = AOBD_DISPATCH["family_27"];
    expect(f27).toBeDefined();
    expect(f27["aj_1"]).toBe("tv");
    expect(f27["aj_3"]).toBe("tu");
    expect(f27["aj_5"]).toBe("tt");
    expect(f27["aj_7"]).toBe("tp");
  });

  it("contains family_39 (RF Hub) with level 1 → wrapper au", () => {
    const f39 = AOBD_DISPATCH["family_39"];
    expect(f39).toBeDefined();
    expect(f39["aj_1"]).toBe("au");
  });

  it("all wrapper values in catalog are non-empty strings", () => {
    for (const [famKey, levels] of Object.entries(AOBD_DISPATCH)) {
      for (const [lvlKey, wrapper] of Object.entries(levels)) {
        if (lvlKey.startsWith("_")) continue;
        expect(typeof wrapper).toBe("string");
        expect(wrapper.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("SK_DISPATCH (alfaobdSeedKey.js) structure", () => {
  it("has entries for all family_27 GPEC2A levels", () => {
    expect(SK_DISPATCH[27 * 100 + 1]).toBe("tv");
    expect(SK_DISPATCH[27 * 100 + 3]).toBe("tu");
    expect(SK_DISPATCH[27 * 100 + 5]).toBe("tt");
    expect(SK_DISPATCH[27 * 100 + 7]).toBe("tp");
  });

  it("has entry for family_39 level 1 → au (RF Hub)", () => {
    expect(SK_DISPATCH[39 * 100 + 1]).toBe("au");
  });

  it("all dispatch values are non-empty strings", () => {
    for (const [, wrapper] of Object.entries(SK_DISPATCH)) {
      expect(typeof wrapper).toBe("string");
      expect((wrapper as string).length).toBeGreaterThan(0);
    }
  });
});

describe("Dispatch cross-reference (catalog vs alfaobdSeedKey)", () => {
  const rows = buildXRefRows();

  it("produces rows for every catalog entry", () => {
    const catalogEntries = Object.values(AOBD_DISPATCH).flatMap((levels) =>
      Object.entries(levels).filter(([k]) => !k.startsWith("_"))
    );
    const catalogRows = rows.filter(
      (r) => r.status === "match" || r.status === "catalog-only" || r.status === "mismatch"
    );
    expect(catalogRows.length).toBe(catalogEntries.length);
  });

  it("has zero mismatches — both tables agree on all shared entries", () => {
    const mismatches = rows.filter((r) => r.status === "mismatch");
    expect(mismatches).toHaveLength(0);
  });

  it("all matched wrappers are computable (present in AOBD_W6_TABLE)", () => {
    const matchedRows = rows.filter((r) => r.status === "match");
    for (const row of matchedRows) {
      expect(row.wrapperComputable).toBe(true);
    }
  });

  it("family_27 aj_5 (GPEC2A level 5) is a match with wrapper tt", () => {
    const gpec2aRow = rows.find(
      (r) => r.famKey === "family_27" && r.lvlKey === "aj_5"
    );
    expect(gpec2aRow).toBeDefined();
    expect(gpec2aRow!.status).toBe("match");
    expect(gpec2aRow!.wrapper).toBe("tt");
    expect(gpec2aRow!.inSeedKey).toBe("tt");
    expect(gpec2aRow!.wrapperComputable).toBe(true);
  });
});

describe("FCA_MODULE_ALGO unlock path completeness", () => {
  it("covers all critical FCA module types", () => {
    const required = ["ECM", "PCM", "BCM", "TCM", "TIPM", "SGW", "RFHUB", "RADIO", "ABS", "ORC", "IPC"];
    for (const mod of required) {
      expect(FCA_MODULE_ALGO[mod]).toBeDefined();
    }
  });

  it("each module entry has algo and level fields", () => {
    for (const [mod, info] of Object.entries(FCA_MODULE_ALGO)) {
      expect(typeof info.algo).toBe("string");
      expect(typeof info.level).toBe("number");
    }
  });

  it("ECM uses GPEC2A w6/tt at level 5", () => {
    const ecm = FCA_MODULE_ALGO["ECM"];
    expect(ecm.algo).toBe("w6");
    expect(ecm.wrapper).toBe("tt");
    expect(ecm.level).toBe(5);
  });

  it("RFHUB uses w6/au at level 1", () => {
    const rfhub = FCA_MODULE_ALGO["RFHUB"];
    expect(rfhub.algo).toBe("w6");
    expect(rfhub.wrapper).toBe("au");
    expect(rfhub.level).toBe(1);
  });

  it("SGW uses aes_cmac at level 0x11", () => {
    const sgw = FCA_MODULE_ALGO["SGW"];
    expect(sgw.algo).toBe("aes_cmac");
    expect(sgw.level).toBe(0x11);
  });

  it("all w6 modules have a wrapper that exists in AOBD_W6_TABLE", () => {
    for (const [mod, info] of Object.entries(FCA_MODULE_ALGO)) {
      if (info.algo === "w6") {
        expect(info.wrapper).toBeDefined();
        expect(AOBD_W6_TABLE[info.wrapper!]).toBeDefined();
      }
    }
  });

  it("security level is odd (UDS 27 XX where XX is odd for request)", () => {
    for (const [mod, info] of Object.entries(FCA_MODULE_ALGO)) {
      if (info.algo !== "aes_cmac") {
        // Standard UDS security levels are odd numbers (1, 3, 5, 7, ...)
        expect(info.level % 2).toBe(1);
      }
    }
  });
});

describe("AOBD_W6_TABLE coverage", () => {
  it("has at least 200 wrappers (alfaobdSeedKey.js ships a 200-entry subset of the full 380-entry catalog)", () => {
    // alfaobdSeedKey.js contains the 200 most-used wrappers.
    // AOBD_META.w6_count (380) is the full catalog count in alfaobdAlgorithms.generated.js.
    const tableSize = Object.keys(AOBD_W6_TABLE).length;
    expect(tableSize).toBeGreaterThanOrEqual(200);
    expect(tableSize).toBeLessThanOrEqual(AOBD_META.w6_count);
  });

  it("wrapper tt (GPEC2A level 5) has valid [r, s] parameters", () => {
    const tt = AOBD_W6_TABLE["tt"];
    expect(Array.isArray(tt)).toBe(true);
    expect(tt.length).toBe(2);
    expect(typeof tt[0]).toBe("number");
    expect(typeof tt[1]).toBe("number");
  });

  it("wrapper au (RF Hub) has valid [r, s] parameters", () => {
    const au = AOBD_W6_TABLE["au"];
    expect(Array.isArray(au)).toBe(true);
    expect(au.length).toBe(2);
  });

  it("all wrapper values are [number, number] tuples", () => {
    for (const [name, params] of Object.entries(AOBD_W6_TABLE)) {
      expect(Array.isArray(params)).toBe(true);
      expect((params as unknown[]).length).toBe(2);
      expect(typeof (params as number[])[0]).toBe("number");
      expect(typeof (params as number[])[1]).toBe("number");
    }
  });
});
