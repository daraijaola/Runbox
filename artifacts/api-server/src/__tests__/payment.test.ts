import { describe, it, expect } from "vitest";
import { getPaymentRequirements } from "../lib/payment.js";

describe("Payment Requirements", () => {
  it("returns correct structure", () => {
    const req = getPaymentRequirements();
    expect(req.version).toBe(1);
    expect(req.scheme).toBe("exact");
    expect(req.network).toMatch(/^stellar:/);
    expect(req.asset).toMatch(/^USDC:/);
    expect(parseFloat(req.amount)).toBeGreaterThan(0);
    expect(typeof req.payTo).toBe("string");
  });

  it("includes custom description", () => {
    const req = getPaymentRequirements("test session");
    expect(req.description).toBe("test session");
  });

  it("defaults description when not provided", () => {
    const req = getPaymentRequirements();
    expect(req.description).toContain("RunBox");
  });

  it("returns valid Stellar address format when configured", () => {
    const req = getPaymentRequirements();
    if (req.payTo) {
      expect(req.payTo).toMatch(/^G[A-Z2-7]{55}$/);
    } else {
      expect(req.payTo).toBe("");
    }
  });

  it("returns correct network based on env", () => {
    const req = getPaymentRequirements();
    const expectedNet = process.env.STELLAR_NETWORK === "mainnet" ? "stellar:mainnet" : "stellar:testnet";
    expect(req.network).toBe(expectedNet);
  });
});
