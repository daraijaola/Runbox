import { describe, it, expect } from "vitest";

const BASE = process.env.RUNBOX_TEST_URL ?? "http://localhost:4001";

describe("API Health", () => {
  it("returns healthy status", async () => {
    const res = await fetch(`${BASE}/api/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ok");
  });
});

describe("Well-Known Manifests", () => {
  it("serves runbox.json manifest", async () => {
    const res = await fetch(`${BASE}/api/exec/.well-known/runbox.json`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.name).toBe("RunBox");
    expect(body.version).toBe("1.0.0");
    expect(body.payment).toBeTruthy();
    expect(body.endpoints).toBeTruthy();
    expect(body.supportedLanguages).toBeTruthy();
  });

  it("serves mpp.json manifest", async () => {
    const res = await fetch(`${BASE}/api/mpp/.well-known/mpp.json`);
    expect(res.status).toBe(200);
  });

  it("manifest includes streaming endpoint", async () => {
    const res = await fetch(`${BASE}/api/exec/.well-known/runbox.json`);
    const body = await res.json() as { endpoints: Record<string, unknown> };
    expect(body.endpoints["run-stream"]).toBeTruthy();
  });

  it("manifest includes file I/O endpoint", async () => {
    const res = await fetch(`${BASE}/api/exec/.well-known/runbox.json`);
    const body = await res.json() as { endpoints: Record<string, unknown> };
    expect(body.endpoints["run-files"]).toBeTruthy();
  });
});

describe("x402 Payment Gate", () => {
  it("returns 402 without payment", async () => {
    const res = await fetch(`${BASE}/api/exec/rent`, { method: "POST" });
    expect(res.status).toBe(402);
    const body = await res.json() as { error: string; payment: Record<string, unknown> };
    expect(body.error).toBe("Payment Required");
    expect(body.payment).toBeTruthy();
    expect(body.payment.payTo).toBeTruthy();
    expect(body.payment.amount).toBeTruthy();
  });

  it("includes X-Payment-Required header", async () => {
    const res = await fetch(`${BASE}/api/exec/rent`, { method: "POST" });
    const header = res.headers.get("x-payment-required");
    expect(header).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(header!, "base64").toString());
    expect(decoded.version).toBe(1);
    expect(decoded.scheme).toBe("exact");
  });

  it("rejects invalid tx hash", async () => {
    const res = await fetch(`${BASE}/api/exec/rent`, {
      method: "POST",
      headers: { "X-Payment-Hash": "invalid" },
    });
    expect(res.status).toBe(402);
  });
});

describe("MPP Payment Gate", () => {
  it("returns 402 for unauthenticated MPP request", async () => {
    const res = await fetch(`${BASE}/api/mpp/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: "python", code: "print(1)" }),
    });
    expect(res.status).toBe(402);
  });

  it("includes WWW-Authenticate header", async () => {
    const res = await fetch(`${BASE}/api/mpp/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: "python", code: "print(1)" }),
    });
    const wwwAuth = res.headers.get("www-authenticate");
    expect(wwwAuth).toBeTruthy();
  });
});

describe("Auth Requirements", () => {
  it("run requires auth", async () => {
    const res = await fetch(`${BASE}/api/exec/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: "python", code: "print(1)" }),
    });
    expect(res.status).toBe(401);
  });

  it("run-stream requires auth", async () => {
    const res = await fetch(`${BASE}/api/exec/run-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: "python", code: "print(1)" }),
    });
    expect(res.status).toBe(401);
  });

  it("run-files requires auth", async () => {
    const res = await fetch(`${BASE}/api/exec/run-files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: "python", code: "print(1)" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects invalid bearer token", async () => {
    const res = await fetch(`${BASE}/api/exec/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer invalid_token",
      },
      body: JSON.stringify({ language: "python", code: "print(1)" }),
    });
    expect(res.status).toBe(401);
  });
});
