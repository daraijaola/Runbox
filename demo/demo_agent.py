#!/usr/bin/env python3
"""
RunBox Demo Agent

Simulates an AI agent that autonomously:
  1. Discovers RunBox capabilities via the .well-known manifest
  2. Requests a session → receives 402 Payment Required
  3. Pays 0.01 USDC on Stellar testnet (or bypasses in demo mode)
  4. Executes Python code in an isolated Docker container
  5. Returns the result

Usage:
  pip install -r requirements.txt
  cp .env.example .env   # set STELLAR_SECRET_KEY, RUNBOX_ENDPOINT, STELLAR_NETWORK
  python demo_agent.py

  # Demo/dev mode (no real Stellar payment needed — bypass server only):
  DEMO_MODE=true python demo_agent.py
"""

import os
import sys
import json
import time
import base64
import secrets
import requests

from dotenv import load_dotenv

load_dotenv()

STELLAR_SECRET_KEY = os.environ.get("STELLAR_SECRET_KEY", "")
RUNBOX_ENDPOINT    = os.environ.get("RUNBOX_ENDPOINT", "http://localhost:4001").rstrip("/")
STELLAR_NETWORK    = os.environ.get("STELLAR_NETWORK", "testnet")
DEMO_MODE          = os.environ.get("DEMO_MODE", "false").lower() == "true"

HORIZON_URLS = {
    "testnet": "https://horizon-testnet.stellar.org",
    "mainnet": "https://horizon.stellar.org",
}

USDC_ISSUERS = {
    "testnet": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    "mainnet": "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
}

STELLAR_EXPLORER = {
    "testnet": "https://stellar.expert/explorer/testnet/tx",
    "mainnet": "https://stellar.expert/explorer/public/tx",
}


def separator(title=""):
    print(f"\n{'─' * 60}")
    if title:
        print(f"  {title}")
        print(f"{'─' * 60}")


def step(msg):
    print(f"\n▶  {msg}")


def ok(msg):
    print(f"   ✓  {msg}")


def info(msg):
    print(f"      {msg}")


def run_demo():
    separator("RunBox Demo — AI Agent pays for code execution on Stellar")

    # ── Discovery ─────────────────────────────────────────────────────────────
    step("Discovering RunBox capabilities...")
    caps = requests.get(
        f"{RUNBOX_ENDPOINT}/api/exec/.well-known/runbox.json", timeout=10
    ).json()
    info(f"Service: {caps['name']} v{caps['version']}")
    info(f"Network: {caps['payment']['network']}")
    info(f"Price:   {caps['payment']['pricePerSession']} USDC / session "
         f"({caps['payment']['defaultSessionMinutes']} min)")
    info(f"Payee:   {caps['payment']['payTo'] or '(bypass mode)'}")

    # ── Task ──────────────────────────────────────────────────────────────────
    separator("Agent Task")
    task = "Compute the first 20 Fibonacci numbers and print them."
    code = """
fibs = [0, 1]
for i in range(18):
    fibs.append(fibs[-1] + fibs[-2])
print("First 20 Fibonacci numbers:")
for i, f in enumerate(fibs):
    print(f"  F({i}) = {f}")
""".strip()

    print(f"  Task:     {task}")
    print(f"  Language: python")

    # ── Step 1: Request session → expect 402 ──────────────────────────────────
    separator("Step 1 — Request session (expect 402)")

    step(f"POST {RUNBOX_ENDPOINT}/api/exec/rent")
    r = requests.post(f"{RUNBOX_ENDPOINT}/api/exec/rent", json={}, timeout=15)

    if r.status_code not in (402, 200):
        print(f"Unexpected status {r.status_code}: {r.text}", file=sys.stderr)
        sys.exit(1)

    if r.status_code == 402:
        ok("Received 402 Payment Required")

        try:
            body = r.json()
        except Exception:
            body = {}

        # FIX: server sends "X-Payment-Required" (with X- prefix)
        pay_header = r.headers.get("x-payment-required", "")
        if pay_header:
            try:
                payment_req = json.loads(base64.b64decode(pay_header).decode())
            except Exception:
                payment_req = body
        else:
            payment_req = body

        # Resolve pay-to address: try nested payment object first, fall back to capabilities
        inner = payment_req.get("payment", {})
        pay_to = (
            inner.get("payTo")
            or payment_req.get("payTo")
            or caps["payment"]["payTo"]
            or ""
        )
        amount_str = (
            inner.get("amount")
            or payment_req.get("amount")
            or caps["payment"]["pricePerSession"]
        )

        info(f"Pay {amount_str} USDC → {pay_to or '(bypass: no address)'}")

        # ── Determine payment mode ────────────────────────────────────────────
        bypass = DEMO_MODE or not pay_to or not STELLAR_SECRET_KEY

        if bypass:
            # ── Bypass / Demo mode ────────────────────────────────────────────
            separator("Step 2 — Demo Mode (synthetic payment hash)")
            tx_hash = secrets.token_hex(32)
            ok(f"Synthetic tx hash generated (bypass/demo mode)")
            info(f"Hash: {tx_hash}")
            info(f"Note: In production this is a real Stellar USDC payment")
        else:
            # ── Real Stellar payment ───────────────────────────────────────────
            from stellar_sdk import Keypair, Network, Server, TransactionBuilder, Asset
            from stellar_sdk.exceptions import NotFoundError

            separator("Step 2 — Submit USDC payment on Stellar")

            horizon_url   = HORIZON_URLS.get(STELLAR_NETWORK, HORIZON_URLS["testnet"])
            net_passphrase = (
                Network.TESTNET_NETWORK_PASSPHRASE
                if STELLAR_NETWORK == "testnet"
                else Network.PUBLIC_NETWORK_PASSPHRASE
            )
            usdc_issuer = USDC_ISSUERS.get(STELLAR_NETWORK, USDC_ISSUERS["testnet"])

            keypair = Keypair.from_secret(STELLAR_SECRET_KEY)
            step(f"Signing payment from {keypair.public_key[:20]}...")

            server  = Server(horizon_url)
            try:
                account = server.load_account(keypair.public_key)
            except NotFoundError:
                print(
                    f"\nAccount {keypair.public_key} not found on Stellar.\n"
                    f"Fund it at: https://laboratory.stellar.org/#account-creator?network=test",
                    file=sys.stderr,
                )
                sys.exit(1)

            usdc = Asset("USDC", usdc_issuer)
            tx = (
                TransactionBuilder(
                    source_account=account,
                    network_passphrase=net_passphrase,
                    base_fee=100,
                )
                .append_payment_op(destination=pay_to, asset=usdc, amount=str(amount_str))
                .add_text_memo("runbox-demo")
                .set_timeout(30)
                .build()
            )
            tx.sign(keypair)

            step("Submitting transaction to Stellar...")
            response = server.submit_transaction(tx)
            tx_hash  = response["hash"]

            ok("Transaction confirmed!")
            info(f"Hash:     {tx_hash}")
            info(f"Explorer: {STELLAR_EXPLORER.get(STELLAR_NETWORK)}/{tx_hash}")

        # ── Step 3: Claim session with payment proof ───────────────────────────
        separator("Step 3 — Claim session with payment proof")

        step("Sending payment proof to RunBox...")
        r2 = requests.post(
            f"{RUNBOX_ENDPOINT}/api/exec/rent",
            json={},
            headers={"X-Payment-Hash": tx_hash},
            timeout=15,
        )

        if not r2.ok:
            print(f"Session claim failed: {r2.status_code} {r2.text}", file=sys.stderr)
            sys.exit(1)

        session = r2.json()
    else:
        session = r.json()

    session_token = session["session_token"]
    ok("Session active!")
    info(f"Session ID: {session.get('session_id', 'N/A')}")
    info(f"Expires:    {session.get('expires_at', 'N/A')}")
    info(f"Minutes:    {session.get('minutes_granted', 'N/A')}")

    # ── Step 4: Execute code ───────────────────────────────────────────────────
    separator("Step 4 — Execute code in isolated sandbox")

    step("Running Python code in Docker container...")
    run_r = requests.post(
        f"{RUNBOX_ENDPOINT}/api/exec/run",
        json={"language": "python", "code": code},
        headers={"Authorization": f"Bearer {session_token}"},
        timeout=60,
    )

    if not run_r.ok:
        print(f"Execution failed: {run_r.status_code} {run_r.text}", file=sys.stderr)
        sys.exit(1)

    result = run_r.json()
    ok(f"Execution complete in {result.get('execution_ms', '?')}ms "
       f"(exit {result.get('exit_code', '?')}, engine: {result.get('engine','?')})")

    separator("Result")
    print(result.get("stdout", "").rstrip())

    if result.get("stderr"):
        print(f"\nStderr:\n{result['stderr']}", file=sys.stderr)

    separator("Summary")
    print("  AI agent completed task autonomously:")
    print("  1. Discovered RunBox via capabilities manifest (.well-known/runbox.json)")
    print("  2. Received HTTP 402 Payment Required")
    if bypass:
        print("  3. Used demo/bypass mode (no real payment — dev server)")
    else:
        print(f"  3. Paid {amount_str} USDC on Stellar {STELLAR_NETWORK} (fully autonomous)")
    print("  4. Executed code in isolated Docker container (no network)")
    print("  5. Received and printed result")
    print()


if __name__ == "__main__":
    run_demo()
