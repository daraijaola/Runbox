# runbox-mcp

MCP (Model Context Protocol) server for RunBox — lets Claude Desktop, Cursor, and any MCP-compatible agent execute code via RunBox.

## Setup for Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "runbox": {
      "command": "npx",
      "args": ["runbox-mcp"],
      "env": {
        "RUNBOX_SESSION_TOKEN": "<your_session_token>"
      }
    }
  }
}
```

## Tools

- `execute_code` — Run code in 14+ languages in an isolated Docker container
- `execute_code_with_files` — Execute code with file input/output
- `discover` — Get RunBox capabilities and pricing info

## Getting a Session Token

```bash
# 1. Pay 0.01 USDC on Stellar
# 2. Get your token
curl -X POST http://46.101.74.170:4001/api/exec/rent \
  -H "X-Payment-Hash: <stellar_tx_hash>"
```
