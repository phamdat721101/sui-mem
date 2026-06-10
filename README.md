# OpenX — Sui-native AI agent memory marketplace

> **Agents pay you USDC to query your brain. Memory + payment + privacy live on one chain — Sui.**

| | |
|---|---|
| **Stack** | Sui Move · Walrus blob storage · Seal IBE · Phala TEE · MemWal · USDC · x402 |
| **Network** | Sui Testnet (default) · Sui Mainnet (production) |
| **License** | MIT |

---

## What it is

OpenX is a **publish-and-earn marketplace for AI-agent-readable knowledge**. A seller curates a brain once, publishes it as a `MemWalBrain` shared object on Sui, and any agent — Cursor, Claude Desktop, an autonomous worker — pays USDC per query and receives a TEE-attested answer.

One chain, one wallet, one trust model:

- **Memory** — Mysten Labs **MemWal** (L1–L5 cognitive memory primitive) wrapped by OpenX's Move package for ownership + a marketplace.
- **Payment** — **USDC on Sui** via x402 / sui-usdc / MPP rails. No EVM wallets, no bridge.
- **Privacy** — Walrus blob storage + **Seal IBE threshold keys** + **Phala TEE** for inference attestation.

OpenX is a thin layer of payments, ownership, and a marketplace on top of native Sui primitives. There is no Solidity, no Fhenix, no Privy/wagmi. The platform is cryptographically blind: even the OpenX server cannot decrypt a brain without a Seal key share + payment receipt + TEE attestation.

---

## How it works

```
              Buyer agent (MCP / browser / API)
                          │
                          │  POST /v3/memory/brain/:id/query
                          │  x-payment-rail: sui_usdc | x402 | mpp
                          ▼
        ┌─────────── OpenX API ───────────┐
        │  auth → paymentGate → recall    │
        └────┬───────────┬────────────────┘
             │           │
   Sui Move tx     OpenXMemWalAdapter           Walrus + Seal + Phala TEE
   (operator-                  │                          │
    signed)                    ├─→ MemWal (L1–L5 recall)  │  attested answer
        │                      ├─→ Walrus (encrypted blob)│  + sovereignty
        ▼                      └─→ Seal IBE key share     │  proof
PaidQueryRecorded                                         ▼
SettlementBatchEmitted                          three-proof bundle
                                                (Sui tx + Walrus blob + Phala quote)
```

---

## Repo layout

```
packages/
├── api/               Express API · /v3/memory · /v3/marketplace · /mcp
├── frontend/          Next.js 14 · Sui dapp-kit ConnectButton + public catalog
├── sdk/               MemWal adapter · payment router · MCP tools · cognitive namespaces
├── sui-sdk/           Walrus client · Seal key client · Phala TEE inference
├── sui-contracts/     Move package — `MemWalBrain` shared object, subscription policy
├── runtime-utils/     resilientCall + circuit breaker + HMAC resume tokens
├── openx-mcp/         MCP stdio shim for Claude Desktop / Cursor / AgentCore
├── shared/            Postgres types + DB helpers + migrations
└── ui/                Tailwind preset + atomic components

scripts/               smoke-walrus, smoke-sui-flow, smoke-memwal-adapter, ...
```

Build orchestration is `npm workspaces`. The dependency graph is linear:

```
runtime-utils → sdk → ui → sui-sdk → openx-mcp → api
                                            ↓
                                         frontend
```

---

## Run it locally

Requires Node 20+, Postgres 14+, and a Sui wallet (Slush / Suiet / OKX-Sui).

```bash
git clone https://github.com/phamdat721701/privacy-context.git openx
cd openx
npm install
cp .env.example .env.local        # set DATABASE_URL at minimum
npm run dev                       # API :3001 + frontend :3000
```

Then open http://localhost:3000, click **Connect**, pick a Sui wallet.

The landing page is intentionally minimal — it lists the public MemWal-tier brains (`GET /v3/memory/marketplace`). To publish, hit `/v3/marketplace/seller/publish` directly with your wallet header — see the OpenAPI surface in the API package.

---

## Try the live API

```bash
curl https://api.openx.so/health
curl https://api.openx.so/v3/memory/marketplace
curl https://api.openx.so/v3/marketplace/listings
```

MCP host integration (Claude Desktop, Cursor, etc.):

```jsonc
{
  "mcpServers": {
    "openx": {
      "command": "npx",
      "args": ["-y", "@openx/mcp"],
      "env": {
        "OPENX_API_URL": "https://api.openx.so",
        "OPENX_WALLET_ADDRESS": "0xyour_sui_address"
      }
    }
  }
}
```

The MCP gateway exposes seven tools: `memwal_marketplace_list`, `memwal_marketplace_query` (paid), `memwal_remember`, `memwal_recall`, `memwal_analyze`, `memwal_restore`, `openx_memwal_publish`. Paid tools return the standard JSON-RPC `-32402 Payment Required` envelope; the host pays via the receipt and retries.

---

## SOLID by construction

The single supported entry point into MemWal is `packages/sdk/src/memwal/adapter.ts`:

- **SRP** — one class, one responsibility.
- **DIP** — Redis, payment gate, logger are all constructor-injected.
- **OCP** — extending point costs or adding a new public method requires no change to the kernel.
- **G4 isolation** — `@mysten-incubation/memwal` is loaded only when `MEMWAL_PEERDEP_ENABLED=true`. Standard installs never trigger the import.

The same discipline applies elsewhere: `payRouter.ts` is a pure dispatcher over `RailAdapter`, `paymentGate.ts` emits a single 402 envelope across all three rails, `OpenXMcpServer` is a stateless dispatcher.

---

## What changed in this pivot

This repo previously dual-tiered between **Fhenix CoFHE on Arbitrum** (Standard) and **Sui** (Trustless). The Fhenix layer added 3 unpaid costs:

1. Two wallets at onboard (Privy/EVM + Slush/Sui).
2. `BrainKeyVaultV2.unwrap()` permit ceremony that the Seal IBE flow doesn't need.
3. Two RPCs, two indexers, two settlement clocks, two security models.

With Seal + Walrus + MemWal mature, EVM only added friction. The pivot is a strategic simplification, not a feature regression — every Move test (43/43) still passes, and the trustless tier was already the canonical product.

---

## License

MIT. © Pham Nim ([@phamdat721701](https://github.com/phamdat721701)).

*One chain. One wallet. Memory as inventory. Earnings as the artifact.*
