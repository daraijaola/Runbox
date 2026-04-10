<p align="center">
  <img src="docs/runbox-logo.png" alt="RunBox" width="600"/>
</p>

# RunBox

**Pay-per-use isolated code execution for AI agents, powered by x402 + MPP on Stellar.**

RunBox lets any AI agent execute code in a secure Docker sandbox by paying 0.01 USDC on Stellar. No API key. No account signup. No human approval. The payment IS the authentication.

Built for the **Stellar Hacks: Agents** hackathon. Purpose-built for [OpenClaw](https://github.com/openclaw/openclaw) agents via [ClawHub](https://clawhub.ai).

---

## Demo

<p align="center">
  <img src="docs/runbox-demo.gif" alt="RunBox demo" width="800"/>
</p>

> **Live transaction:** [View on Stellar Expert](https://stellar.expert/explorer/testnet/tx/9c4d173e14bbc5fdbaa66fc617483c09d9d16b6bf41e1e2abd70e684d7b1eab1) — 0.01 USDC paid, verified on-chain, code executed in 319ms.

---

## Features

| Feature | Description |
|---------|-------------|
| **x402 Sessions** | Pay once, execute many times within a session window |
| **MPP Pay-per-request** | Soroban SAC transfers via `@stellar/mpp` — no session needed |
| **16 Languages** | Python, JavaScript, TypeScript, Bash, Ruby, PHP, Perl, Lua, Go, Rust, Java, C, C++, R, and more |
| **Streaming Output** | SSE endpoint streams stdout/stderr in real-time as code runs |
| **File I/O** | Send files into the sandbox, get output files back (base64) |
| **MCP Server** | Claude Desktop and Cursor integration via Model Context Protocol |
| **npm Client SDK** | `@runbox/client` — one-line integration for any agent |
| **Soroban Spending Cap** | On-chain budget enforcement smart contract |
| **OpenClaw Skill** | `clawhub install runbox` — instant agent integration |
| **Docker Isolation** | No network, memory/CPU limits, 60s timeout per execution |

---

## Quick Start

### Option 1: npm Client SDK

```typescript
import { RunBox } from "@runbox/client";

const box = new RunBox();

// Pay for a session
const session = await box.rent("<stellar_tx_hash>");

// Execute code
const result = await box.exec("python", "print('hello from RunBox')");
console.log(result.stdout); // "hello from RunBox"

// Stream output in real-time
for await (const event of box.execStream("python", "for i in range(5): print(i)")) {
  if (event.type === "stdout") process.stdout.write(event.data);
}

// File I/O
const fileResult = await box.execWithFiles("python",
  "open('/output/result.txt','w').write(open('/input/data.txt').read().upper())",
  [{ name: "data.txt", content: btoa("hello world") }]
);
```

### Option 2: MCP (Claude Desktop / Cursor)

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "runbox": {
      "command": "npx",
      "args": ["@runbox/mcp"],
      "env": {
        "RUNBOX_SESSION_TOKEN": "<your_session_token>"
      }
    }
  }
}
```

Then just ask Claude: *"Run this Python code: print('hello')"*

### Option 3: OpenClaw

```bash
clawhub install runbox
```

### Option 4: Direct HTTP

```bash
# 1. Get payment requirements
curl -X POST http://46.101.74.170:4001/api/exec/rent
# Returns 402 with payment details

# 2. Pay 0.01 USDC on Stellar, then:
curl -X POST http://46.101.74.170:4001/api/exec/rent \
  -H "X-Payment-Hash: <stellar_tx_hash>"
# Returns session_token

# 3. Execute code
curl -X POST http://46.101.74.170:4001/api/exec/run \
  -H "Authorization: Bearer <session_token>" \
  -H "Content-Type: application/json" \
  -d '{"language":"python","code":"print(42)"}'
```

---

## API Endpoints

### x402 Session Flow

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/exec/rent` | X-Payment-Hash | Pay USDC, get session token |
| POST | `/api/exec/run` | Bearer token | Execute code |
| POST | `/api/exec/run-stream` | Bearer token | Execute with SSE streaming output |
| POST | `/api/exec/run-files` | Bearer token | Execute with file input/output |
| POST | `/api/exec/extend` | Bearer + X-Payment-Hash | Extend session time |
| GET | `/api/exec/status/:id` | None | Check session status |
| GET | `/api/exec/.well-known/runbox.json` | None | Machine-readable capabilities |

### MPP Pay-per-Request

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/mpp/exec` | WWW-Authenticate | Pay-per-request via Soroban SAC |
| GET | `/api/mpp/.well-known/mpp.json` | None | MPP capability discovery |

---

## Streaming Output (SSE)

```bash
curl -X POST http://46.101.74.170:4001/api/exec/run-stream \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"language":"python","code":"import time\nfor i in range(5):\n    print(i)\n    time.sleep(1)"}'
```

Events:
```
data: {"type":"stdout","data":"0\n"}
data: {"type":"stdout","data":"1\n"}
data: {"type":"stdout","data":"2\n"}
data: {"type":"exit","exitCode":0,"executionMs":5032}
```

---

## File I/O

```bash
curl -X POST http://46.101.74.170:4001/api/exec/run-files \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "language": "python",
    "code": "data = open(\"/input/data.csv\").read()\nresult = data.upper()\nopen(\"/output/result.txt\", \"w\").write(result)",
    "files": [{"name": "data.csv", "content": "aGVsbG8sd29ybGQ="}]
  }'
```

Response includes `outputFiles` array with base64-encoded files written to `/output/`.

---

## Machine Payments Protocol (MPP)

RunBox implements the **Machine Payments Protocol** via `@stellar/mpp` — the official Stellar standard for agentic micropayments.

Unlike x402 sessions, MPP is **pay-per-request** — each execution independently negotiates payment via RFC-standard `WWW-Authenticate` / `Payment-Receipt` headers.

### MPP Flow

```
Agent                          RunBox                         Stellar
  |                              |                              |
  |-- POST /api/mpp/exec ------>|                              |
  |<---- 402 + WWW-Authenticate |                              |
  |                              |                              |
  |-- Soroban SAC transfer ---->|----------------------------->|
  |                              |                              |
  |-- POST /api/mpp/exec ------>|                              |
  |   + Authorization header    |-- verify on-chain ---------->|
  |<---- 200 + Payment-Receipt  |<---- confirmed --------------|
  |   + execution result        |                              |
```

---

## Soroban Spending Cap Contract

On-chain budget enforcement for AI agents. Agents register a spending limit, RunBox validates against it before each execution.

**Deployed on Stellar Testnet:**
- Contract: [`CCXVU6NNDBJ23QSG6OGKUMUEXNLVOSJ4SZOJK3AAL2NTHBCAED66SCG3`](https://lab.stellar.org/r/testnet/contract/CCXVU6NNDBJ23QSG6OGKUMUEXNLVOSJ4SZOJK3AAL2NTHBCAED66SCG3)
- Deploy tx: [`24ded3d6...`](https://stellar.expert/explorer/testnet/tx/24ded3d6b082300773b466cc6c8da856703376e60034fb26c50f51d61f1a4160)
- Verified spend tx: [`b3ffd803...`](https://stellar.expert/explorer/testnet/tx/b3ffd8038f006e75de34d3542839b97e511d2a2f55be3cb5bf45d07813339073)

```
contracts/spending-cap/
  src/lib.rs       Soroban Rust contract (2 passing tests)
  Cargo.toml       Build config
```

### Contract Functions

| Function | Caller | Description |
|----------|--------|-------------|
| `register_budget(agent, total, per_call)` | Agent | Set spending limits |
| `authorize_spend(agent, amount)` | RunBox | Check + deduct before execution |
| `get_budget(agent)` | Anyone | Read remaining budget |
| `pause_budget(agent)` | Agent | Emergency stop |
| `resume_budget(agent)` | Agent | Resume after pause |

Even if RunBox is compromised, the on-chain contract enforces the budget.

---

## Supported Languages

Python, JavaScript, TypeScript, Bash, Ruby, PHP, Perl, Lua, Go, Rust, Java, C, C++, R

All run in isolated Docker containers with no network access.

---

## Security Model

- **No network access** inside containers (`--network none`)
- **Memory limited**: 128 MB per execution
- **CPU limited**: 0.5 cores per execution
- **Timeout**: 60 seconds max
- **Replay protection**: Each Stellar tx hash used only once
- **On-chain verification**: Payments verified directly on Stellar Horizon
- **On-chain spending caps**: Soroban contract enforces agent budgets

---

## Repository Layout

```
packages/
  runbox-client/          @runbox/client npm SDK
  runbox-mcp/             @runbox/mcp MCP server for Claude/Cursor

contracts/
  spending-cap/           Soroban spending-cap smart contract (Rust)

artifacts/api-server/
  src/
    routes/exec.ts        x402 session + execution endpoints
    routes/mpp-exec.ts    MPP pay-per-request endpoint
    lib/payment.ts        Stellar USDC verification via Horizon
    lib/mpp.ts            MPP server setup (@stellar/mpp)
    lib/sessions.ts       JWT session management
    lib/sandbox.ts        Docker execution engine (16 languages)

skill/
  SKILL.md                OpenClaw skill definition
  scripts/run.py          Autonomous x402 payment + execution

demo/
  demo_agent.py           Full x402 demo script
```

---

## Links

- **Live server:** http://46.101.74.170:4001
- **GitHub:** https://github.com/daraijaola/Runbox
- **Demo video:** https://youtu.be/qUWUI5Xn160
- **OpenClaw install:** `clawhub install runbox`

---

MIT License 2026
