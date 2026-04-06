import jwt from "jsonwebtoken";
import crypto from "crypto";
import { logger } from "./logger.js";

const JWT_SECRET = process.env.SESSION_JWT_SECRET ?? "change-me-in-production";
const DEFAULT_MINUTES = parseInt(process.env.RUNBOX_DEFAULT_MINUTES ?? "5");

interface Session {
  id: string;
  expiresAt: Date;
  minutesGranted: number;
  createdAt: Date;
}

const sessions = new Map<string, Session>();

export interface SessionToken {
  token: string;
  sessionId: string;
  expiresAt: Date;
  minutesGranted: number;
}

export function createSession(minutesGranted = DEFAULT_MINUTES): SessionToken {
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + minutesGranted * 60 * 1000);

  sessions.set(sessionId, {
    id: sessionId,
    expiresAt,
    minutesGranted,
    createdAt: new Date(),
  });

  const token = jwt.sign(
    { sessionId, expiresAt: expiresAt.toISOString(), minutesGranted },
    JWT_SECRET,
    { expiresIn: minutesGranted * 60 },
  );

  logger.info({ sessionId, minutesGranted, expiresAt }, "Session created");

  return { token, sessionId, expiresAt, minutesGranted };
}

export interface SessionVerification {
  valid: boolean;
  sessionId?: string;
  expiresAt?: Date;
  secondsRemaining?: number;
  error?: string;
}

export function verifySession(token: string): SessionVerification {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as {
      sessionId: string;
      expiresAt: string;
    };

    const session = sessions.get(payload.sessionId);
    if (!session) {
      return { valid: false, error: "Session not found or expired" };
    }

    const now = new Date();
    if (now > session.expiresAt) {
      sessions.delete(payload.sessionId);
      return { valid: false, error: "Session expired" };
    }

    const secondsRemaining = Math.floor(
      (session.expiresAt.getTime() - now.getTime()) / 1000,
    );

    return {
      valid: true,
      sessionId: payload.sessionId,
      expiresAt: session.expiresAt,
      secondsRemaining,
    };
  } catch {
    return { valid: false, error: "Invalid token" };
  }
}

export function getSession(sessionId: string): Session | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (new Date() > session.expiresAt) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

export function extendSession(sessionId: string, additionalMinutes: number): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  session.expiresAt = new Date(session.expiresAt.getTime() + additionalMinutes * 60 * 1000);
  session.minutesGranted += additionalMinutes;
  logger.info({ sessionId, additionalMinutes, newExpiry: session.expiresAt }, "Session extended");
  return true;
}

setInterval(
  () => {
    const now = new Date();
    let cleaned = 0;
    for (const [id, session] of sessions.entries()) {
      if (now > session.expiresAt) {
        sessions.delete(id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.info({ cleaned }, "Expired sessions cleaned up");
    }
  },
  60 * 1000,
);
