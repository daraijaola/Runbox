/**
 * x402-inspired payment verification for Stellar USDC payments.
 *
 * Flow:
 *   1. Client calls a protected endpoint → server returns 402 with X-Payment-Required header
 *   2. Client submits USDC on Stellar, gets a tx hash
 *   3. Client retries with X-Payment-Hash header → server verifies on Horizon → issues session
 *
 * No external facilitator needed — payments are verified directly on-chain.
 */

import { logger } from "./logger.js";

const STELLAR_NETWORK = process.env.STELLAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
const STELLAR_ADDRESS = process.env.STELLAR_RECEIVE_ADDRESS ?? "";
const RUNBOX_PRICE = process.env.RUNBOX_PRICE ?? "0.01";

const HORIZON_URLS: Record<string, string> = {
  testnet: "https://horizon-testnet.stellar.org",
  mainnet: "https://horizon.stellar.org",
};

const USDC_ISSUERS: Record<string, string> = {
  testnet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  mainnet: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
};

const HORIZON_BASE = HORIZON_URLS[STELLAR_NETWORK];
const USDC_ISSUER = USDC_ISSUERS[STELLAR_NETWORK];
const STELLAR_ASSET_CODE = "USDC";

// Replay protection — track seen tx hashes
const usedTransactions = new Set<string>();

export interface PaymentRequirements {
  version: 1;
  scheme: "exact";
  network: string;
  payTo: string;
  asset: string;
  amount: string;
  description: string;
}

export function getPaymentRequirements(description = "RunBox execution session"): PaymentRequirements {
  return {
    version: 1,
    scheme: "exact",
    network: `stellar:${STELLAR_NETWORK}`,
    payTo: STELLAR_ADDRESS,
    asset: `${STELLAR_ASSET_CODE}:${USDC_ISSUER}`,
    amount: RUNBOX_PRICE,
    description,
  };
}

export interface PaymentVerificationResult {
  valid: boolean;
  txHash?: string;
  paidAmount?: string;
  payer?: string;
  error?: string;
}

export async function verifyPayment(txHash: string): Promise<PaymentVerificationResult> {
  if (!txHash || !/^[0-9a-fA-F]{64}$/.test(txHash)) {
    return { valid: false, error: "Invalid transaction hash format" };
  }

  const normalizedHash = txHash.toLowerCase();

  if (usedTransactions.has(normalizedHash)) {
    return { valid: false, error: "Transaction already used (replay attack prevention)" };
  }

  if (!STELLAR_ADDRESS) {
    logger.warn("STELLAR_RECEIVE_ADDRESS not configured — accepting payment without verification");
    usedTransactions.add(normalizedHash);
    return { valid: true, txHash: normalizedHash };
  }

  try {
    const url = `${HORIZON_BASE}/transactions/${normalizedHash}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });

    if (!res.ok) {
      if (res.status === 404) {
        return { valid: false, error: "Transaction not found on Stellar network" };
      }
      return { valid: false, error: `Horizon returned ${res.status}` };
    }

    const tx = (await res.json()) as { successful: boolean; id: string };

    if (!tx.successful) {
      return { valid: false, error: "Transaction was not successful" };
    }

    // Fetch operations to verify the payment amount/destination
    const opsUrl = `${HORIZON_BASE}/transactions/${normalizedHash}/operations`;
    const opsRes = await fetch(opsUrl, { signal: AbortSignal.timeout(10_000) });
    const opsBody = (await opsRes.json()) as {
      _embedded: { records: Array<{
        type: string;
        to?: string;
        from?: string;
        asset_code?: string;
        asset_issuer?: string;
        amount?: string;
      }> };
    };

    const paymentOp = opsBody._embedded.records.find(
      (op) =>
        op.type === "payment" &&
        op.to === STELLAR_ADDRESS &&
        op.asset_code === STELLAR_ASSET_CODE &&
        op.asset_issuer === USDC_ISSUER,
    );

    if (!paymentOp) {
      return {
        valid: false,
        error: `No USDC payment to ${STELLAR_ADDRESS} found in transaction`,
      };
    }

    const paidAmount = parseFloat(paymentOp.amount ?? "0");
    const requiredAmount = parseFloat(RUNBOX_PRICE);

    if (paidAmount < requiredAmount) {
      return {
        valid: false,
        error: `Insufficient payment: paid ${paidAmount} USDC, required ${requiredAmount} USDC`,
      };
    }

    usedTransactions.add(normalizedHash);

    logger.info(
      { txHash: normalizedHash, paidAmount, payer: paymentOp.from },
      "Payment verified",
    );

    return {
      valid: true,
      txHash: normalizedHash,
      paidAmount: paymentOp.amount,
      payer: paymentOp.from,
    };
  } catch (err: unknown) {
    logger.error({ err, txHash }, "Payment verification error");
    return {
      valid: false,
      error: err instanceof Error ? err.message : "Payment verification failed",
    };
  }
}

// Purge used transactions older than 24 hours (coarse — in production use Redis with TTL)
setInterval(
  () => {
    if (usedTransactions.size > 10_000) {
      usedTransactions.clear();
      logger.info("Cleared used-transaction cache");
    }
  },
  60 * 60 * 1000,
);
