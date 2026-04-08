# RunBox Spending Cap — Soroban Smart Contract

On-chain spending policy for AI agents using RunBox.

## What it does

Agents register a **spending budget** on Stellar (Soroban). Before each code execution,
RunBox checks the agent's on-chain budget. If the agent has sufficient funds and hasn't
exceeded their per-call or total limit, the execution proceeds. Otherwise, it's rejected.

This gives agents **cryptographic spending guarantees** — even if the RunBox server is
compromised, the on-chain contract enforces the budget.

## Contract Functions

| Function | Who calls | What it does |
|----------|-----------|--------------|
| `init(admin, service)` | Admin | Set up contract with RunBox service address |
| `register_budget(agent, total_limit, per_call_limit)` | Agent | Register a spending cap |
| `authorize_spend(agent, amount)` | RunBox service | Check + deduct budget before execution |
| `get_budget(agent)` | Anyone | Read agent's remaining budget |
| `pause_budget(agent)` | Agent | Emergency stop |
| `resume_budget(agent)` | Agent | Resume after pause |


## Deployed on Stellar Testnet

| Item | Value |
|------|-------|
| **Contract ID** | `CCXVU6NNDBJ23QSG6OGKUMUEXNLVOSJ4SZOJK3AAL2NTHBCAED66SCG3` |
| **Deploy tx** | [24ded3d6...](https://stellar.expert/explorer/testnet/tx/24ded3d6b082300773b466cc6c8da856703376e60034fb26c50f51d61f1a4160) |
| **Init tx** | [1427320d...](https://stellar.expert/explorer/testnet/tx/1427320d2d25191e80bda3e8294182c5cf9148cb6e860ff2f65473a11d7e570e) |
| **Register budget tx** | [1dd88666...](https://stellar.expert/explorer/testnet/tx/1dd88666cd8dec352a2820bf760dae9e003b90d84c1b0ee6a178bf98d8f27ef5) |
| **Authorize spend tx** | [b3ffd803...](https://stellar.expert/explorer/testnet/tx/b3ffd8038f006e75de34d3542839b97e511d2a2f55be3cb5bf45d07813339073) |
| **Explorer** | [View on Stellar Lab](https://lab.stellar.org/r/testnet/contract/CCXVU6NNDBJ23QSG6OGKUMUEXNLVOSJ4SZOJK3AAL2NTHBCAED66SCG3) |

## Build

```bash
cargo build --target wasm32-unknown-unknown --release
```

## Test

```bash
cargo test
```
