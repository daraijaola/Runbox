/**
 * MPP-gated code execution endpoint.
 *
 * Machine Payments Protocol (MPP) pay-per-request flow:
 *   1. POST /api/mpp/exec  { language, code }
 *      → 402 with WWW-Authenticate: Payment <challenge>
 *   2. Agent pays USDC on Stellar (Soroban SAC transfer), retries with
 *      Authorization: Payment <credential>
 *   3. RunBox verifies on-chain via Soroban RPC
 *      → runs code in Docker → returns result with Payment-Receipt header
 */

import { Router, type IRouter, type Request, type Response } from "express";
import {
  mppServer,
  MPP_NETWORK,
  MPP_PRICE,
  MPP_USDC_SAC,
  runMppHandler,
  sendFetchResponse,
  type MppResult,
} from "../lib/mpp.js";
import { executeCode as runCode, SUPPORTED_LANGUAGES as langs } from "../lib/sandbox.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

/**
 * GET /api/mpp/.well-known/mpp.json
 * Machine-readable MPP capability descriptor for AI agent discovery.
 */
router.get("/.well-known/mpp.json", (_req, res) => {
  res.json({
    protocol: "mpp",
    version: "1.0.0",
    network: MPP_NETWORK,
    methods: ["stellar/charge"],
    currency: {
      asset: "USDC",
      sacAddress: MPP_USDC_SAC,
      pricePerRequest: MPP_PRICE,
      decimals: 7,
    },
    endpoints: {
      exec: {
        method: "POST",
        path: "/api/mpp/exec",
        description: "Pay-per-request code execution via MPP stellar/charge",
        body: { language: langs.join(" | "), code: "string" },
        auth: "Authorization: Payment <mppx-credential>",
        response: {
          stdout: "string",
          stderr: "string",
          exit_code: "number",
          execution_ms: "number",
        },
      },
    },
  });
});

/**
 * POST /api/mpp/exec
 * Pay-per-request execution via MPP.  No session — each request is independently paid.
 */
router.post("/exec", async (req: Request, res: Response) => {
  const { language, code } = req.body ?? {};

  if (!language || !code) {
    res.status(400).json({ error: "Missing required fields: language, code" });
    return;
  }

  if (!langs.includes(language)) {
    res.status(400).json({ error: `Unsupported language: ${language}`, supported: langs });
    return;
  }

  // Build the charge handler for this request
  const handler = mppServer.charge({
    amount: MPP_PRICE,
    description: `RunBox: execute ${language} code`,
  });

  let mppResult: MppResult;
  try {
    mppResult = await runMppHandler(handler, req);
  } catch (err) {
    logger.error({ err }, "MPP handler error");
    res.status(500).json({ error: "Payment handler error" });
    return;
  }

  // 402 — forward the challenge (includes WWW-Authenticate header with payment details)
  if (mppResult.status === 402) {
    await sendFetchResponse(mppResult.challenge, res);
    return;
  }

  // 200 — payment verified!  Run the code, wrap result with Payment-Receipt
  const start = Date.now();
  try {
    const result = await runCode(language, code);
    const execution_ms = Date.now() - start;

    logger.info({ language, execution_ms }, "MPP exec: code executed after payment");

    const responseBody = JSON.stringify({
      ...result,
      execution_ms,
      payment: { protocol: "mpp", network: MPP_NETWORK },
    });

    // Build the Fetch Response and let mppx attach the Payment-Receipt header
    const fetchRes = new globalThis.Response(responseBody, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    const finalRes = await mppResult.withReceipt(fetchRes);
    await sendFetchResponse(finalRes, res);
  } catch (err) {
    logger.error({ err, language }, "MPP exec: sandbox error");
    res.status(500).json({ error: "Code execution failed" });
  }
});

export default router;
