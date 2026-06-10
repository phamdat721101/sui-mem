# @openx/mcp

OpenX MCP stdio shim. Lets Claude Desktop / Cursor / Bedrock AgentCore spawn
the OpenX MCP server as a subprocess.

For most use cases, the **HTTP transport at `https://api.openx.so/mcp`** is
simpler — no install needed:

```jsonc
// Claude Desktop config
{
  "mcpServers": {
    "openx": { "url": "https://api.openx.so/mcp" }
  }
}
```

This package is the **stdio fallback** for hosts that don't yet support HTTP
MCP transport.

## Install

```bash
npm i -g @openx/mcp
# or one-shot via npx (no install)
npx -y @openx/mcp
```

## Claude Desktop config (stdio mode)

```jsonc
{
  "mcpServers": {
    "openx": {
      "command": "npx",
      "args": ["-y", "@openx/mcp"],
      "env": {
        "OPENX_API_URL": "https://api.openx.so",
        "OPENX_API_KEY": "ox_…",
        "OPENX_BRAIN_ID": "0xabc…",
        "OPENX_PRICE_PER_QUERY": "0.01"
      }
    }
  }
}
```

## Tools exposed

| Tool | Paid? | What it does |
|---|:-:|---|
| `openx_brain_search` | free | Semantic search across published brains |
| `openx_brain_remember` | free | Store text in caller-owned brain |
| `openx_brain_recall` | **paid** | Retrieve memories from a target brain |
| `openx_brain_ask` | **paid** | LLM-answered query with TEE attestation |
| `openx_brain_publish` | free | Publish a brain to the catalog |
| `openx_brain_cost` | free | Walrus storage cost in USD + WAL |
| `openx_brain_restore` | free | Sovereignty proof from Walrus alone |

Paid tools return a `-32402` JSON-RPC error with an x402 `paymentRequired`
envelope. Hosts that handle x402 will pay-then-retry automatically.

## License

MIT.
