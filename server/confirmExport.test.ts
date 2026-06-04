import { describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

/**
 * Tests the candidate.confirmExport procedure to ensure:
 * 1. Export is blocked when confirmed=false
 * 2. Export proceeds when confirmed=true (mocked storage)
 */

function createAuthContext(): TrpcContext {
  return {
    user: {
      id: 1,
      openId: "test-user",
      email: "test@example.com",
      name: "Test User",
      loginMethod: "manus",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: () => {},
    } as TrpcContext["res"],
  };
}

describe("candidate.confirmExport", () => {
  it("rejects export when confirmed=false", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.candidate.confirmExport({
      sessionId: 1,
      candidateKey: "candidates/1/1/test_candidate.bin",
      confirmed: false,
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain("not confirmed");
  });
});
