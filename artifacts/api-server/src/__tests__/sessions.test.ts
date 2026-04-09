import { describe, it, expect } from "vitest";
import { createSession, verifySession, getSession, extendSession } from "../lib/sessions.js";

describe("Session Management", () => {
  it("creates a valid session", () => {
    const session = createSession(5);
    expect(session.token).toBeTruthy();
    expect(session.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.minutesGranted).toBe(5);
    expect(new Date(session.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("verifies a valid session token", () => {
    const session = createSession(5);
    const result = verifySession(session.token);
    expect(result.valid).toBe(true);
    expect(result.sessionId).toBe(session.sessionId);
  });

  it("rejects an invalid token", () => {
    const result = verifySession("invalid.token.here");
    expect(result.valid).toBe(false);
  });

  it("rejects an empty token", () => {
    const result = verifySession("");
    expect(result.valid).toBe(false);
  });

  it("retrieves session by ID", () => {
    const session = createSession(10);
    const retrieved = getSession(session.sessionId);
    expect(retrieved).toBeTruthy();
    expect(retrieved!.id).toBe(session.sessionId);
  });

  it("returns null for unknown session ID", () => {
    const retrieved = getSession("nonexistent-id");
    expect(retrieved).toBeNull();
  });

  it("extends a session", () => {
    const session = createSession(5);
    const original = getSession(session.sessionId);
    const originalExpiry = original!.expiresAt.getTime();

    const extended = extendSession(session.sessionId, 10);
    expect(extended).toBe(true);

    const updated = getSession(session.sessionId);
    expect(updated!.expiresAt.getTime()).toBeGreaterThan(originalExpiry);
  });

  it("fails to extend nonexistent session", () => {
    const extended = extendSession("nonexistent-id", 5);
    expect(extended).toBe(false);
  });
});
