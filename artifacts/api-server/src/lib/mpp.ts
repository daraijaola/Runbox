/**
 * MPP (Machine Payments Protocol) server setup for RunBox.
 *
 * @stellar/mpp implements the official 402 payment standard for Stellar agents.
 * mppx handler return shape:
 *   status 402: { challenge: FetchResponse, status: 402 }
 *   status 200: { status: 200, withReceipt(fetchRes) => Promise<FetchResponse> }
 */

import { Mppx } from "mppx/server";
import { stellar } from "@stellar/mpp/charge/server";
import {
  STELLAR_TESTNET,
  STELLAR_PUBNET,
  USDC_SAC_TESTNET,
  USDC_SAC_MAINNET,
} from "@stellar/mpp";
import type { Request, Response } from "express";

const NET = process.env.STELLAR_NETWORK === "mainnet" ? STELLAR_PUBNET : STELLAR_TESTNET;
const USDC_SAC = NET === STELLAR_PUBNET ? USDC_SAC_MAINNET : USDC_SAC_TESTNET;
const RECIPIENT = process.env.STELLAR_RECEIVE_ADDRESS ?? "";
const PRICE = process.env.RUNBOX_PRICE ?? "0.01";

/** The Mppx server instance. Configured once at startup. */
export const mppServer = Mppx.create({
  methods: [
    stellar.charge({
      network: NET,
      recipient: RECIPIENT,
      currency: USDC_SAC,
    }),
  ],
  secretKey: process.env.MPP_SECRET_KEY ?? process.env.SESSION_JWT_SECRET!,
});

export const MPP_USDC_SAC = USDC_SAC;
export const MPP_NETWORK = NET;
export const MPP_PRICE = PRICE;

/**
 * mppx handler return type — matches mppx internals.
 * 402: challenge Fetch Response to forward
 * 200: payment verified, call withReceipt(yourFetchRes) to get final response
 */
export type MppResult =
  | { status: 402; challenge: globalThis.Response }
  | { status: 200; withReceipt: (res: globalThis.Response) => Promise<globalThis.Response> };

/**
 * Run an mppx method handler against an Express request.
 * Converts Node IncomingMessage to a Fetch Request for mppx.
 */
export async function runMppHandler(
  // mppx returns its internal type at runtime which matches MppResult — cast needed
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (req: globalThis.Request) => Promise<any>,
  expressReq: Request,
): Promise<MppResult> {
  // Build a Fetch Request from the Express request.
  // mppx only reads the Authorization header — body is irrelevant for payment gating.
  const url = `http://localhost${expressReq.originalUrl}`;
  const fetchReq = new globalThis.Request(url, {
    method: expressReq.method,
    headers: expressReq.headers as Record<string, string>,
  });
  return handler(fetchReq) as unknown as Promise<MppResult>;
}

/**
 * Write a Fetch Response to an Express ServerResponse.
 * Copies status, headers (including WWW-Authenticate / Payment-Receipt), and body.
 */
export async function sendFetchResponse(
  fetchRes: globalThis.Response,
  res: Response,
): Promise<void> {
  res.status(fetchRes.status);
  // Iterate with entries() — standard on Web Fetch Headers
  try {
    for (const [key, value] of (fetchRes.headers as Headers).entries()) {
      res.setHeader(key, value);
    }
  } catch {
    // Fallback: plain object
    const plain = fetchRes.headers as unknown as Record<string, string>;
    if (plain && typeof plain === "object") {
      for (const [k, v] of Object.entries(plain)) {
        res.setHeader(k, v);
      }
    }
  }
  const body = await fetchRes.text().catch(() => "");
  res.send(body || "");
}
