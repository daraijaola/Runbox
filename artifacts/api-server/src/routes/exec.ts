/**
 * RunBox execution routes
 *
 * Implements x402-inspired payment gating:
 *   - Protected endpoints return 402 with X-Payment-Required header
 *   - Clients retry with X-Payment-Hash (Stellar tx hash)
 *   - Server verifies payment on-chain via Stellar Horizon
 *   - Successful payment yields a JWT session token
 */

import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { getPaymentRequirements, verifyPayment } from "../lib/payment.js";
import { createSession, verifySession, getSession, extendSession } from "../lib/sessions.js";
import { executeCode as runCode, executeCodeStream, executeCodeWithFiles, SUPPORTED_LANGUAGES as langs } from "../lib/sandbox.js";

const RUNBOX_DEFAULT_MINUTES = parseInt(process.env.RUNBOX_DEFAULT_MINUTES ?? "5");
const RUNBOX_PRICE = process.env.RUNBOX_PRICE ?? "0.01";
const STELLAR_NETWORK = process.env.STELLAR_NETWORK === "mainnet" ? "mainnet" : "testnet";

// ── Helpers ───────────────────────────────────────────────────────────────────

function sendPaymentRequired(res: Response, description?: string) {
  const requirements = getPaymentRequirements(description);
  const encoded = Buffer.from(JSON.stringify(requirements)).toString("base64");
  res
    .status(402)
    .setHeader("X-Payment-Required", encoded)
    .setHeader("Content-Type", "application/json")
    .json({
      error: "Payment Required",
      message: `Pay ${requirements.amount} USDC on stellar:${STELLAR_NETWORK} to ${requirements.payTo}. Then retry with X-Payment-Hash: <tx_hash>.`,
      payment: requirements,
    });
}

function requireSession(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Authorization: Bearer <session_token>" });
    return;
  }

  const token = auth.slice(7);
  const result = verifySession(token);

  if (!result.valid) {
    res.status(401).json({ error: result.error ?? "Invalid session" });
    return;
  }

  (req as Request & { sessionId: string; sessionExpiresAt: Date }).sessionId = result.sessionId!;
  (req as Request & { sessionId: string; sessionExpiresAt: Date }).sessionExpiresAt =
    result.expiresAt!;
  next();
}

// ── Router ────────────────────────────────────────────────────────────────────

const router: IRouter = Router();

/**
 * GET /api/exec/.well-known/runbox.json
 * Machine-readable capabilities manifest for AI agents.
 */
router.get("/.well-known/runbox.json", (_req, res) => {
  const requirements = getPaymentRequirements();
  res.json({
    name: "RunBox",
    version: "1.0.0",
    description: "Pay-per-use isolated code execution for AI agents via x402 on Stellar",
    mpp: {
      protocol: 'mpp',
      version: '1.0.0',
      endpoint: '/api/mpp/exec',
      discovery: '/api/mpp/.well-known/mpp.json',
      description: 'Pay-per-request via MPP stellar/charge (Soroban SAC, no session required)',
    },
    payment: {
      protocol: "x402",
      network: `stellar:${STELLAR_NETWORK}`,
      asset: "USDC",
      pricePerSession: RUNBOX_PRICE,
      defaultSessionMinutes: RUNBOX_DEFAULT_MINUTES,
      pricePerMinute: (parseFloat(RUNBOX_PRICE) / RUNBOX_DEFAULT_MINUTES).toFixed(4),
      payTo: requirements.payTo,
    },
    endpoints: {
      rent: {
        method: "POST",
        path: "/api/exec/rent",
        description:
          "Rent a session. Returns 402 with X-Payment-Required header. Retry with X-Payment-Hash: <stellar_tx_hash> after paying.",
        headers: {
          "X-Payment-Hash": "Stellar transaction hash (64 hex chars)",
        },
        response: {
          session_token: "JWT — use as Authorization: Bearer <token> for /run",
          session_id: "UUID",
          expires_at: "ISO 8601",
          minutes_granted: "number",
        },
      },
      run: {
        method: "POST",
        path: "/api/exec/run",
        auth: "Authorization: Bearer <session_token>",
        body: { language: langs.join(" | "), code: "string" },
        response: {
          stdout: "string",
          stderr: "string",
          exit_code: "number",
          execution_ms: "number",
        },
      },
      extend: {
        method: "POST",
        path: "/api/exec/extend",
        description: "Extend session. Returns 402 until payment is made.",
        auth: "Authorization: Bearer <session_token>",
        headers: { "X-Payment-Hash": "Stellar transaction hash" },
      },
      "run-stream": {
        method: "POST",
        path: "/api/exec/run-stream",
        auth: "Authorization: Bearer <session_token>",
        description: "Streaming code execution via SSE. Returns stdout/stderr chunks in real-time.",
        body: { language: "string", code: "string" },
        response: "text/event-stream: { type: stdout|stderr|exit, data?, exitCode?, executionMs? }",
      },
      "run-files": {
        method: "POST",
        path: "/api/exec/run-files",
        auth: "Authorization: Bearer <session_token>",
        description: "Execute code with file I/O. Send base64 files, read from /input/, write to /output/.",
        body: { language: "string", code: "string", files: [{ name: "string", content: "base64" }] },
        response: "Same as /run plus outputFiles: [{ name, content }]",
      },
      status: {
        method: "GET",
        path: "/api/exec/status/:sessionId",
      },
    },
    supportedLanguages: langs,
    openclawSkill: "clawhub install runbox",
  });
});

/**
 * POST /api/exec/rent
 *
 * x402 payment gate for session creation.
 * Without payment: returns 402 with payment requirements.
 * With X-Payment-Hash: verifies on Stellar and issues session JWT.
 */
router.post("/rent", async (req, res) => {
  const txHash = req.headers["x-payment-hash"] as string | undefined;

  if (!txHash) {
    sendPaymentRequired(res, `RunBox execution session (${RUNBOX_DEFAULT_MINUTES} min)`);
    return;
  }

  const verification = await verifyPayment(txHash);

  if (!verification.valid) {
    res.status(402).json({
      error: "Payment verification failed",
      reason: verification.error,
      hint: "Ensure your USDC transaction is confirmed on Stellar and the tx hash is correct.",
    });
    return;
  }

  const requestedMinutes = parseInt(String(req.query["minutes"] ?? RUNBOX_DEFAULT_MINUTES));
  const minutes = Math.min(
    Math.max(isNaN(requestedMinutes) ? RUNBOX_DEFAULT_MINUTES : requestedMinutes, 1),
    120,
  );

  const session = createSession(minutes);

  req.log.info(
    { sessionId: session.sessionId, minutes, txHash: verification.txHash },
    "Session rented via payment",
  );

  res.json({
    session_token: session.token,
    session_id: session.sessionId,
    expires_at: session.expiresAt.toISOString(),
    minutes_granted: session.minutesGranted,
    payment: {
      tx_hash: verification.txHash,
      amount_paid: verification.paidAmount,
      payer: verification.payer,
    },
    usage: {
      run: "POST /api/exec/run  Authorization: Bearer <session_token>",
      status: `GET /api/exec/status/${session.sessionId}`,
      extend:
        "POST /api/exec/extend  Authorization: Bearer <session_token>  X-Payment-Hash: <new_tx_hash>",
    },
  });
});

/**
 * POST /api/exec/run
 *
 * Execute code inside a valid session.
 * Requires Authorization: Bearer <session_token>.
 */
router.post("/run", requireSession, async (req, res) => {
  const typedReq = req as Request & { sessionId: string; sessionExpiresAt: Date };
  const { language, code } = req.body as { language?: string; code?: string };

  if (!language || typeof language !== "string") {
    res.status(400).json({ error: "Required field: language" });
    return;
  }

  if (!code || typeof code !== "string") {
    res.status(400).json({ error: "Required field: code" });
    return;
  }

  if (code.length > 100_000) {
    res.status(400).json({ error: "code must be under 100KB" });
    return;
  }

  req.log.info(
    { sessionId: typedReq.sessionId, language, codeLength: code.length },
    "Executing code",
  );

  const result = await runCode(language, code);

  res.json({
    stdout: result.stdout,
    stderr: result.stderr,
    exit_code: result.exitCode,
    execution_ms: result.executionMs,
    language: result.language,
    engine: result.engine,
    session_id: typedReq.sessionId,
    session_expires_at: typedReq.sessionExpiresAt.toISOString(),
  });
});

/**
 * POST /api/exec/extend
 *
 * Extend a session. Requires both session token AND payment.
 */
router.post("/extend", requireSession, async (req, res) => {
  const typedReq = req as Request & { sessionId: string };
  const txHash = req.headers["x-payment-hash"] as string | undefined;

  if (!txHash) {
    sendPaymentRequired(res, `Extend RunBox session by ${RUNBOX_DEFAULT_MINUTES} minutes`);
    return;
  }

  const verification = await verifyPayment(txHash);

  if (!verification.valid) {
    res.status(402).json({
      error: "Payment verification failed",
      reason: verification.error,
    });
    return;
  }

  const { session_id } = req.body as { session_id?: string };
  const targetId = session_id ?? typedReq.sessionId;

  const extended = extendSession(targetId, RUNBOX_DEFAULT_MINUTES);
  if (!extended) {
    res.status(404).json({ error: "Session not found or expired" });
    return;
  }

  const session = getSession(targetId);
  req.log.info(
    { sessionId: targetId, additionalMinutes: RUNBOX_DEFAULT_MINUTES },
    "Session extended",
  );

  res.json({
    session_id: targetId,
    extended_by_minutes: RUNBOX_DEFAULT_MINUTES,
    new_expires_at: session?.expiresAt.toISOString(),
    payment: { tx_hash: verification.txHash },
  });
});

/**
 * GET /api/exec/status/:sessionId
 *
 * Check remaining time on a session. Public endpoint.
 */
router.get("/status/:sessionId", (req, res) => {
  const session = getSession(req.params.sessionId);

  if (!session) {
    res.status(404).json({ error: "Session not found or expired" });
    return;
  }

  const secondsRemaining = Math.max(
    0,
    Math.floor((session.expiresAt.getTime() - Date.now()) / 1000),
  );

  res.json({
    session_id: session.id,
    expires_at: session.expiresAt.toISOString(),
    seconds_remaining: secondsRemaining,
    minutes_remaining: Math.floor(secondsRemaining / 60),
    active: secondsRemaining > 0,
    supported_languages: langs,
  });
});



/**
 * POST /api/exec/run-stream
 *
 * Streaming code execution via Server-Sent Events.
 * Requires active session (Authorization: Bearer <token>).
 * Body: { language, code }
 */
router.post("/run-stream", requireSession, (req: Request, res: Response) => {
  const { language, code } = req.body ?? {};

  if (!language || !code) {
    res.status(400).json({ error: "language and code are required" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const { kill } = executeCodeStream(language, code, {
    onStdout: (data: string) => {
      res.write(`data: ${JSON.stringify({ type: "stdout", data })}\n\n`);
    },
    onStderr: (data: string) => {
      res.write(`data: ${JSON.stringify({ type: "stderr", data })}\n\n`);
    },
    onExit: (exitCode: number, executionMs: number) => {
      res.write(`data: ${JSON.stringify({ type: "exit", exitCode, executionMs })}\n\n`);
      res.end();
    },
  });

  req.on("close", () => { kill(); });
});


/**
 * POST /api/exec/run-files
 *
 * Code execution with file input/output.
 * Requires active session (Authorization: Bearer <token>).
 * Body: { language, code, files?: [{ name, content (base64) }] }
 * Response includes outputFiles (anything written to /output/ in the container).
 */
router.post("/run-files", requireSession, async (req: Request, res: Response) => {
  const { language, code, files } = req.body ?? {};

  if (!language || !code) {
    res.status(400).json({ error: "language and code are required" });
    return;
  }

  try {
    const result = await executeCodeWithFiles(language, code, files ?? []);
    req.log.info({ language, exitCode: result.exitCode, ms: result.executionMs, filesIn: (files ?? []).length, filesOut: result.outputFiles.length }, "File I/O execution");
    res.json(result);
  } catch (err) {
    req.log.error({ err, language }, "File I/O execution error");
    res.status(500).json({ error: "Code execution failed" });
  }
});

export default router;
