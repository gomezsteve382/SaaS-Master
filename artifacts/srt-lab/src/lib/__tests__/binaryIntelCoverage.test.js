import { describe, it, expect } from "vitest";
import {
  classifyUdsService,
  classifyDid,
  classifyRoutineControl,
  classifySecurityLevel,
  classifyCanId,
  classifyFinding,
} from "../binaryIntelCoverage.js";

// ── UDS service classification ────────────────────────────────────────

describe("classifyUdsService", () => {
  it("marks fully-built services as covered", () => {
    const result = classifyUdsService({ sid: 0x10 });
    expect(result.status).toBe("covered");
    expect(result.evidence).toMatch(/build\.ts/);
  });

  it("marks ReadDataByIdentifier (0x22) as covered", () => {
    const result = classifyUdsService({ sid: 0x22 });
    expect(result.status).toBe("covered");
  });

  it("marks WriteMemoryByAddress (0x3D) as covered", () => {
    const result = classifyUdsService({ sid: 0x3D });
    expect(result.status).toBe("covered");
  });

  it("marks services with catalog entry but no builder as partial", () => {
    const result = classifyUdsService({ sid: 0x24 }); // ReadScalingDataByIdentifier
    expect(result.status).toBe("partial");
    expect(result.evidence).toMatch(/services\.ts/);
  });

  it("marks a completely unknown SID as gap", () => {
    const result = classifyUdsService({ sid: 0xAA });
    expect(result.status).toBe("gap");
    expect(result.evidence).toMatch(/0xAA/i);
  });
});

// ── DID classification ────────────────────────────────────────────────

describe("classifyDid", () => {
  it("marks catalogued standard DID 0xF190 (VIN) as covered", () => {
    const result = classifyDid({ did: 0xF190 });
    expect(result.status).toBe("covered");
    expect(result.evidence).toMatch(/dids\.ts/);
  });

  it("marks BCM config DID 0xDE00 as covered", () => {
    const result = classifyDid({ did: 0xDE00 });
    expect(result.status).toBe("covered");
  });

  it("marks 0xDE01 as partial (SKIM-specific label vs generic BCM block)", () => {
    const result = classifyDid({ did: 0xDE01 });
    expect(result.status).toBe("partial");
    expect(result.evidence).toMatch(/SKIM/i);
  });

  it("marks unknown DID 0xAB01 as gap", () => {
    const result = classifyDid({ did: 0xAB01 });
    expect(result.status).toBe("gap");
    expect(result.evidence).toMatch(/0xAB01/i);
  });

  it("marks unknown DID 0xCD02 as gap", () => {
    const result = classifyDid({ did: 0xCD02 });
    expect(result.status).toBe("gap");
  });

  it("marks PROXI DID 0xFD01 as covered (BCM ECM block in catalog)", () => {
    const result = classifyDid({ did: 0xFD01 });
    expect(result.status).toBe("covered");
  });

  it("marks SGW PROXI DID 0xFD20 as gap (not catalogued)", () => {
    const result = classifyDid({ did: 0xFD20 });
    expect(result.status).toBe("gap");
    expect(result.evidence).toMatch(/0xFD20/i);
  });
});

// ── RoutineControl classification ─────────────────────────────────────

describe("classifyRoutineControl", () => {
  it("marks 0xFF00 (DealerLockoutBypass) as covered", () => {
    const result = classifyRoutineControl({ routineId: 0xFF00 });
    expect(result.status).toBe("covered");
    expect(result.evidence).toMatch(/dealerLockoutBypass/i);
  });

  it("marks 0x0200 (Key Learning Procedure) as partial — builder exists, no wrapper", () => {
    const result = classifyRoutineControl({ routineId: 0x0200 });
    expect(result.status).toBe("partial");
    expect(result.evidence).toMatch(/build\.routineControl/);
  });

  it("marks 0x0100 (Reset Transmission Adaptives) as partial", () => {
    const result = classifyRoutineControl({ routineId: 0x0100 });
    expect(result.status).toBe("partial");
  });
});

// ── Security level classification ─────────────────────────────────────

describe("classifySecurityLevel", () => {
  it("marks standard level 0x01 as covered", () => {
    const result = classifySecurityLevel({ requestSeed: 0x01 });
    expect(result.status).toBe("covered");
    expect(result.evidence).toMatch(/algos\.js/);
  });

  it("marks VILLAIN 0x61 level as gap (S-box missing)", () => {
    const result = classifySecurityLevel({ requestSeed: 0x61 });
    expect(result.status).toBe("gap");
    expect(result.evidence).toMatch(/S-box|FCA_SBox/i);
  });

  it("marks dealer lockout level 0x0B as covered", () => {
    const result = classifySecurityLevel({ requestSeed: 0x0B });
    expect(result.status).toBe("covered");
  });
});

// ── CAN ID classification ─────────────────────────────────────────────

describe("classifyCanId", () => {
  it("marks PCM TX ID 0x7E0 as covered", () => {
    const result = classifyCanId({ txId: 0x7E0, module: "PCM" });
    expect(result.status).toBe("covered");
    expect(result.evidence).toMatch(/PCM/i);
  });

  it("marks BCM TX ID 0x640 as covered", () => {
    const result = classifyCanId({ txId: 0x640, module: "BCM" });
    expect(result.status).toBe("covered");
  });

  it("marks unknown TX ID as gap", () => {
    const result = classifyCanId({ txId: 0x555, module: "Unknown ECU" });
    expect(result.status).toBe("gap");
    expect(result.evidence).toMatch(/0x555/i);
  });

  it("marks SGW TX ID 0x74F as covered (AutelSgwTab + xtea_sgw)", () => {
    const result = classifyCanId({ txId: 0x74F, module: "SGW" });
    expect(result.status).toBe("covered");
    expect(result.evidence).toMatch(/SGW|AutelSgwTab|xtea_sgw/i);
  });

  it("marks BCM PROXI TX ID 0x790 as covered (fcaProxi.js)", () => {
    const result = classifyCanId({ txId: 0x790, module: "BCM PROXI" });
    expect(result.status).toBe("covered");
    expect(result.evidence).toMatch(/fcaProxi|PROXI/i);
  });
});

// ── classifyFinding dispatcher ────────────────────────────────────────

describe("classifyFinding", () => {
  it("dispatches 'udsService' type correctly", () => {
    const r = classifyFinding("udsService", { sid: 0x31 });
    expect(r.status).toBe("covered");
  });

  it("dispatches 'did' type correctly", () => {
    const r = classifyFinding("did", { did: 0xAB01 });
    expect(r.status).toBe("gap");
  });

  it("returns gap with message for unknown type", () => {
    const r = classifyFinding("bogusType", {});
    expect(r.status).toBe("gap");
    expect(r.evidence).toMatch(/bogusType/);
  });
});
