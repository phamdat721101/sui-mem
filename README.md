<div align="center">

# 🪐 OpenX

### The Sui-native marketplace where AI agents pay you USDC for memory.

**🐳 Walrus stores it.&nbsp;&nbsp;🧠 MemWal trains it.&nbsp;&nbsp;⚡ Sui settles it.**
*One chain. One wallet. One trust model. No bridges. No Solidity. No middleware glue.*

[![Sui Testnet — Live](https://img.shields.io/badge/Sui_Testnet-Live-4DA2FF?logo=sui&logoColor=white)](https://suiscan.xyz/testnet/object/0x4a760f6c982fbbe814dadb11adfe1a6c6d50bcce156de578b5f33e442f0e2041)
[![Walrus](https://img.shields.io/badge/Walrus-Storage_Layer-7B68EE)](https://walrus.site)
[![MemWal](https://img.shields.io/badge/MemWal-L1→L5_Memory-9D4EDD)](https://docs.wal.app)
[![Move tests](https://img.shields.io/badge/Move_tests-43/43-2EA44F)](#-proof-of-work)
[![Make-it-X gate](https://img.shields.io/badge/Make--it--X-22/22-2EA44F)](#-proof-of-work)
[![License](https://img.shields.io/badge/License-MIT-lightgrey)](LICENSE)

[**🎮 Try the API**](https://api.openx.so/v3/memory/marketplace) · [**🤖 MCP gateway**](https://api.openx.so/mcp) · [**🔍 Suiscan**](https://suiscan.xyz/testnet/object/0x4a760f6c982fbbe814dadb11adfe1a6c6d50bcce156de578b5f33e442f0e2041) · [**📖 Docs**](public/sui-doc/INTEGRATION_REFERENCE.md)

</div>

---

## 🎯 What it is, in one paragraph

OpenX is a **publish-and-earn marketplace for AI-agent-readable knowledge**. A seller curates a brain once, publishes it as a `MemWalBrain` shared object on Sui, and any AI agent — Cursor, Claude Desktop, Bedrock AgentCore, an autonomous worker — pays USDC per query and receives a TEE-attested answer with a three-proof receipt: **Sui tx digest + Walrus blob id + Phala attestation hash**.

## 🚀 The asymmetric claim

> **Only place on the internet today** where AI memory is **storage-decentralized** (Walrus), **training-engine-decentralized** (MemWal), **and** **settlement-decentralized** (Sui Move + USDC) — composed into a single buyer-discoverable marketplace, not three protocols glued with a Postgres mirror.

Manus, Letta, Mem0 ship the agent loop on closed SaaS. Tensorblock secures two primitives via Seal. **OpenX is the only stack that puts buyer-paid memory queries on-chain end-to-end and pays sellers atomically in `Coin<USDC>`.**

---

## 🏛️ Architecture — three decentralized layers, one product

```
        Buyer agent (MCP / browser / API)   POST /v3/memory/brain/:id/query
                          │
                          ▼
              OpenX API · paymentGate → recall
                          │
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
   ⚡ Sui PTB        🧠 MemWal           🐳 Walrus
   (settlement)     (training memory)    (encrypted blobs)
        │                 │                 │
        ▼                 ▼                 ▼
  PaidQueryRecorded  L1  working          AES-256-GCM
  Settlement event   L2  cog-l2-…         + blobId
  distribute<USDC>   L3  cog-l3-…         + epoch renewal
  (pro-rata fan-out) L4  PARA brain       + Quilt batching
                     L5  reflection
                          │
                          ▼
                 🔐 Phala TEE inference
              (attestation hash per call)
```

### 🐳 Walrus — the storage layer

Walrus is the **content layer**: every brain, every workflow artifact, every persona delta lives here.

- 🔒 **AES-256-GCM encrypted in-browser** before PUT — the platform sees ciphertext only.
- 🔑 **Seal IBE threshold-key wrapping** of the AES key per buyer-job-policy.
- 🔁 **Epoch-aware renewal** cron extends storage so paid-for blobs never expire mid-relationship.
- 📦 **Quilt batching** for workflow artifacts → ~50 % storage cost reduction at scale.

> *Walrus is the "what was said + what was produced" — content-addressable, censorship-resistant, replicable from chain alone.*

### 🧠 MemWal — the training memory engine

MemWal (Mysten Labs incubation) is the **cognition layer**. Wrapped behind the SOLID `OpenXMemWalAdapter`, it powers the reflexive loop ("the second hire is cheaper"):

| Level | Namespace | What lives here |
|---|---|---|
| **L1** | working (in-memory) | Active prompt + tool calls |
| **L2** | `cog-l2-{agent}-{job}-{step}` | Per-step episodic memory |
| **L3** | `cog-l3-{agent}-{job}` | Per-job long-term memory |
| **L4** | `cog-l4-{agent}` &nbsp;+&nbsp; `cog-l4-{agent}-{buyer}` | PARA-tagged brain (general + per-buyer slot) |
| **L5** | `cog-l5-{agent}` &nbsp;+&nbsp; `cog-l5-{agent}-{buyer}` | Reflective critique → drives nightly persona auto-rewrite |

Per-agent ed25519 delegate keys (W6) cryptographically scope writes; auditable on-chain; rotatable from the studio.

> *MemWal is the "what was learned" — every paid call gets the agent smarter, and the buyer's repeat-hire reads warm context cached from past runs.*

### ⚡ Sui — the settlement & on-chain truth layer

Every economic primitive — listing, paid query, subscription, right-to-forget, USDC distribution — has a Move counterpart shipped on testnet **today**:

| Move module | Role |
|---|---|
| `openx_memwal_marketplace` | `MemWalBrain` shared object — listing, price, namespace, seller |
| `openx_memwal_billing` | `PaidQueryRecorded` + `SettlementBatchEmitted` events |
| `openx_memwal_revenue_split` | `distribute<T>` — atomic Coin<USDC> fan-out, multi-author |
| `openx_loop_workflow_v1_1` | `init_extension` · `complete_with_outcome` · `delete_per_buyer_memory` |
| `openx_loop_subscription` | `LoopSubscription<T>` escrow + `fork_run` cron + atomic cancel |
| `openx_loop_agent_registry` | `publish_agent` + per-agent delegate-key rotation |

> *Sui is the "who paid whom, when, and what's verifiable forever" — and the `Coin<USDC>` actually moves.*

---

## 🔄 What happens when an agent pays $0.05 USDC for one query

```
1. ⚡ Sui     buyer signs USDC PTB → OpenX records `PaidQueryRecorded`
2. 🧠 MemWal  recall lifts L4 brain hits + per-buyer L4 hits (warm context)
3. 🔐 Phala   TEE infers; attestation hash returned
4. 🐳 Walrus  response AES-encrypted + uploaded → blobId
5. 🔑 Seal    AES key wrapped under buyer-job IBE policy
6. 🧠 MemWal  L2/L3/L5 writes mirror to Walrus blob ids (auditable)
7. ⚡ Sui     settlement worker batches → `distribute<USDC>` → seller wallet
                                          (operator share volume-dials 5%→2%)
```

Every step is verifiable: Sui digest on Suiscan, Walrus blob in any aggregator, MemWal namespace via the buyer's right-to-forget proof endpoint.

---

## 🧾 Proof of work

### Live deployed packages (Sui testnet)

| Component | Package id | Explorer |
|---|---|---|
| **OpenX main** (11 Move modules) | `0x4a760f…0e2041` | [Suiscan ↗](https://suiscan.xyz/testnet/object/0x4a760f6c982fbbe814dadb11adfe1a6c6d50bcce156de578b5f33e442f0e2041) |
| **OpenX Loop v1.1** (workflow + subscription) | `0x289b5a…dbd7a` | [Suiscan ↗](https://suiscan.xyz/testnet/object/0x289b5a6a293a4bca581d53d9b905c2931c938923b6d3eb717be37a36e03dbd7a) |
| **OpenX Loop v2 escrow** | `0xca5b3f…d580b2` | [Suiscan ↗](https://suiscan.xyz/testnet/object/0xca5b3fe93af55d9bb576cd23a7e76fcc21ff749c34df599c11ed8b54e5d580b2) |
| **MemWal upstream** (Mysten incubation) | `0xcf6ad7…229c6` | [Suiscan ↗](https://suiscan.xyz/testnet/object/0xcf6ad755a1cdff7217865c796778fabe5aa399cb0cf2eba986f4b582047229c6) |

### Sample on-chain transactions

| What | Tx digest / Object id | Explorer |
|---|---|---|
| **OpenX package deploy** | `3ScQEmpx…61hjz` | [Suiscan ↗](https://suiscan.xyz/testnet/tx/3ScQEmpxmBmv3U8vUqL9ip73J771rSTK21mfdrt61hjz) · [SuiVision ↗](https://suivision.xyz/txblock/3ScQEmpxmBmv3U8vUqL9ip73J771rSTK21mfdrt61hjz?network=testnet) |
| **MemWalBrain publish** ($0.05 USDC/query) | `A1twpRRa…izt4m` | [Suiscan ↗](https://suiscan.xyz/testnet/tx/A1twpRRaACTwn1rjQV6PgRtqGGcPFWR6SaUuuaCizt4m) |
| **Sample brain object** (shared, v.891417717) | `0x728e0a…35ea` | [Suiscan ↗](https://suiscan.xyz/testnet/object/0x728e0a23f573b9f2c837e959064c643aba0a9fc6b9c11fb300f01d26334e35ea) |
| **Operator wallet** (gas + delegate ops) | `0x7b9a9e…ce96` | [Suiscan ↗](https://suiscan.xyz/testnet/address/0x7b9a9e7b878863cc14adcf2f3ff29094454d3b1fe78d00637cb81dc29ce7ce96) |

### Live endpoints

| | URL |
|---|---|
| 🌐 **Public API** | https://api.openx.so |
| ❤️ **Health** | https://api.openx.so/health |
| 🛒 **MemWal catalog** | https://api.openx.so/v3/memory/marketplace |
| 📋 **Marketplace listings** | https://api.openx.so/v3/marketplace/listings |
| 🔌 **MCP gateway** | https://api.openx.so/mcp |

### Quality gates (run them yourself)

| Gate | Result | Command |
|---|---|---|
| Move on-chain unit tests | ✅ **43 / 43** | `cd packages/sui-contracts && sui move test` |
| Workflow v1.1 unit smoke | ✅ **37 / 37** | `npm run smoke:workflow-v1-1` |
| **Make-it-X** binding gate (5 scenarios) | ✅ **22 / 22** | `npm run smoke:make-it-x` |
| TypeScript zero-error | ✅ api · sdk · sui-sdk · frontend | `npm run build` |
| Postgres migrations | ✅ **22** applied additive-only | `npm run db:migrate` |

The Make-it-X gate runs five end-to-end scenarios under one rubric — `Make-it-true`, `Make-it-discoverable`, `Make-it-pay`, `Make-it-usable`, `Make-it-safe` — recording per-assertion evidence to `scripts/evidence/make-it-x-<timestamp>/`.

---

## ⚙️ Run it locally

Requires Node 20+, Postgres 14+, and a Sui wallet (Slush · Suiet · OKX-Sui).

```bash
git clone https://github.com/phamdat721701/privacy-context.git openx
cd openx
npm install
cp .env.example .env.local        # set DATABASE_URL at minimum
npm run dev                       # API :3001 + frontend :3000
```

Open http://localhost:3000 → click **Connect** → pick a Sui wallet → publish your first brain in 90 seconds.

## 🤖 Drop into Claude Desktop / Cursor

```jsonc
{
  "mcpServers": {
    "openx": { "url": "https://api.openx.so/mcp" }
  }
}
```

Seven MCP tools: `memwal_marketplace_list`, `memwal_marketplace_query` 💸, `memwal_remember`, `memwal_recall`, `memwal_analyze`, `memwal_restore`, `openx_memwal_publish`. Paid tools return JSON-RPC `-32402 Payment Required`; the host pays via x402 receipt and retries.

---

## 🗂️ Repo layout

```
packages/
├── api/                 Express · /v3/memory · /v3/marketplace · /v3/loop · /mcp
├── frontend/            Next.js 14 · Sui dapp-kit · public catalog + studio
├── sdk/                 MemWal adapter · payment router · 8 PTB builders
├── sui-sdk/             Walrus client · Seal key client · Phala TEE client
├── sui-contracts/       Move package — 11 modules, 43 tests
├── sui-contracts-loop-v2/  v2 workflow-escrow package
├── runtime-utils/       resilientCall + circuit breaker
├── openx-mcp/           MCP stdio shim (Bedrock AgentCore)
├── shared/              Postgres types + 22 migrations
└── ui/                  Tailwind preset + atomic components

scripts/   smoke-make-it-x-scenarios · smoke-workflow-v1-1 · seed-* · backfill-*
docs/      PRDs · audits · pitch · runbooks · MEMWAL_ROLLOUT.md
```

Build graph is linear: `runtime-utils → sdk → ui → sui-sdk → openx-mcp → api → frontend`.

---

## 🧰 SOLID by construction

The single supported entry point into MemWal is `packages/sdk/src/memwal/adapter.ts`. The mirror, the executor, the settlement worker, the eight PTB builders — every new file is **one verb, one responsibility, constructor-injected dependencies**. Feature flags gate every PRD. Rollback = flag flip = byte-identical previous behavior.

## 📜 License

MIT. © Pham Nim ([@phamdat721701](https://github.com/phamdat721701))

<div align="center">

*One chain. One wallet. Memory as inventory. Earnings as the artifact.*

</div>
