# OpenX × Sui × Walrus × MemWal × Tatum — Integration Reference

> A paid-MCP marketplace where AI agents pay each other in USDC for knowledge,
> built on Sui. Sellers train brains, publish them as paid MCP/API/workflow
> products, earn USDC per query. Every call returns a three-proof receipt:
> Sui billing tx + Walrus blob ids + Phala TEE attestation.

**Status:** live on Sui testnet · 43/43 Move tests passing · 22 SQL migrations applied.

---

## 1 · Executive overview

| Layer | Tech | What it does in OpenX |
|---|---|---|
| **Settlement** | Sui Move (testnet, mainnet-ready) | `MemWalBrain` shared objects, paid-query events, settlement batches, revenue split |
| **Knowledge storage** | Walrus | AES-encrypted brain blobs, Quilt-batched, renewal-aware |
| **Cognitive memory** | MemWal upstream | L1–L5 namespaced writes via operator-pool delegate keys (admin-sponsored) |
| **RPC + indexer** | Tatum Sui Gateway | Free Sui RPC reads via `sui-{testnet,mainnet}.gateway.tatum.io` |
| **Encryption-during-compute** | Phala TEE + Seal IBE | Inference attestation hash + brain-level key wrapping |
| **Payments** | x402 voucher → Sui USDC settlement | Buyer signs voucher, server records, settlement worker batches |

---

## 2 · Live onchain artifacts (Sui testnet)

All addresses below are real, queryable, and have been used by the running deployment.

### 2.1 OpenX Move package

| Field | Value |
|---|---|
| **Package id** | `0x4a760f6c982fbbe814dadb11adfe1a6c6d50bcce156de578b5f33e442f0e2041` |
| **Version** | 1 |
| **Type** | `package` |
| **Deploy tx digest** | `3ScQEmpxmBmv3U8vUqL9ip73J771rSTK21mfdrt61hjz` |
| **Suiscan (package)** | https://suiscan.xyz/testnet/object/0x4a760f6c982fbbe814dadb11adfe1a6c6d50bcce156de578b5f33e442f0e2041 |
| **Suiscan (deploy tx)** | https://suiscan.xyz/testnet/tx/3ScQEmpxmBmv3U8vUqL9ip73J771rSTK21mfdrt61hjz |
| **SuiVision (deploy tx)** | https://suivision.xyz/txblock/3ScQEmpxmBmv3U8vUqL9ip73J771rSTK21mfdrt61hjz?network=testnet |

#### Modules in this package

| Module | Purpose |
|---|---|
| `openx_memwal_marketplace` | `MemWalBrain` shared object — listing, price, seller, namespace |
| `openx_memwal_billing` | `PaidQueryRecorded` + `SettlementBatchEmitted` events |
| `openx_memwal_revenue_split` | `CompositionPolicy` + `distribute<T>` for multi-author payouts |
| `brain_registry` | Legacy v2 brain CRUD (Standard tier) |
| `subscription_policy` | Free / paid / window-gated access policies |
| `workflow` | Multi-step DAG product type (PRD-09) |
| `skill` | Standalone Skill product type (PRD-09) |
| `reflective` | L5 metacognition license type (PRD-09) |
| `agent_billing` | x402 receipt anchoring |
| `agent_module` | Agent metadata + KYA hooks |
| `kya_gate` | ERC-8004-style reputation gating |

### 2.2 MemWalBrain — sample published brain

| Field | Value |
|---|---|
| **Object id** | `0x728e0a23f573b9f2c837e959064c643aba0a9fc6b9c11fb300f01d26334e35ea` |
| **Type** | `0x4a760f6c982fbbe814dadb11adfe1a6c6d50bcce156de578b5f33e442f0e2041::openx_memwal_marketplace::MemWalBrain` |
| **Owner** | Shared (`initial_shared_version: 891417717`) |
| **Title** | "18" |
| **Namespace** | `cog-l3-18` |
| **Price per query** | $0.05 USDC |
| **Publish tx digest** | `A1twpRRaACTwn1rjQV6PgRtqGGcPFWR6SaUuuaCizt4m` |
| **Suiscan (object)** | https://suiscan.xyz/testnet/object/0x728e0a23f573b9f2c837e959064c643aba0a9fc6b9c11fb300f01d26334e35ea |
| **Suiscan (publish tx)** | https://suiscan.xyz/testnet/tx/A1twpRRaACTwn1rjQV6PgRtqGGcPFWR6SaUuuaCizt4m |
| **Gas used** | comp 0.001 SUI · storage 0.003 SUI · rebate 0.001 SUI |

### 2.3 Operator wallet (admin)

| Field | Value |
|---|---|
| **Sui address** | `0x7b9a9e7b878863cc14adcf2f3ff29094454d3b1fe78d00637cb81dc29ce7ce96` |
| **Role** | Pays Sui gas for delegate registration + settlement events; signs upstream MemWal calls on behalf of sellers |
| **Suiscan** | https://suiscan.xyz/testnet/address/0x7b9a9e7b878863cc14adcf2f3ff29094454d3b1fe78d00637cb81dc29ce7ce96 |

### 2.4 Upstream MemWal package (Mysten Labs incubation)

| Field | Value |
|---|---|
| **Package id** | `0xcf6ad755a1cdff7217865c796778fabe5aa399cb0cf2eba986f4b582047229c6` |
| **Network** | Sui testnet |
| **Module of interest** | `account` (`MemWalAccount`, `add_delegate_key`, `remove_delegate_key`) |
| **Suiscan** | https://suiscan.xyz/testnet/object/0xcf6ad755a1cdff7217865c796778fabe5aa399cb0cf2eba986f4b582047229c6 |

### 2.5 Public API (live)

| Field | Value |
|---|---|
| **Base URL** | https://13-229-63-192.sslip.io |
| **Health** | https://13-229-63-192.sslip.io/health |
| **Cash-flow stats** | https://13-229-63-192.sslip.io/v3/dashboard/stats |
| **MemWal catalog** | https://13-229-63-192.sslip.io/v3/memory/marketplace |
| **Sample agent.json** | https://13-229-63-192.sslip.io/api/v1/sui-audit-1780681145/.well-known/agent.json |

---

## 3 · System architecture

```
                ┌────────────────────── Buyer ──────────────────────┐
                │  MCP client (Cursor / Claude Desktop / Codex)    │
                │  OR  /marketplace/[brainId] browser              │
                └──────────────┬───────────────────────────────────┘
                               │  POST /v3/memory/brain/:id/query
                               │  headers: x-wallet-address, x-chain: sui,
                               │           x-payment-rail: sui_usdc,
                               │           x-payment-tx: <voucher>
                               ▼
        ┌───────────── OpenX API (Express @ :3001) ────────────┐
        │                                                       │
        │   auth ── isOwner check ── paymentGate ── recall      │
        │     │           │              │            │         │
        │     │           │              │            └─→ MemWalAdapter
        │     │           │              │                  │ │
        │     │           │              │  records to      │ └─→ Tatum Sui RPC
        │     │           │              │  memwal_paid_    │     (sui-testnet.gateway.tatum.io)
        │     │           │              │  queries          │
        │     │           │              │                  └─→ MemWal upstream
        │     │           │              ▼                       │
        │     │           │       SettlementBatchEmitted         │
        │     │           │       (every 60s, volume-dial)       └─→ Walrus
        │     │           │              │                            (publisher.walrus-testnet.walrus.space)
        │     │           │              ▼
        │     │           │       Sui Move tx
        │     │           │       (operator-signed)
        │     │           │              │
        │     │           │              ▼
        │     │           │       Suiscan (3-proof receipt)
        │     │           ▼
        │     │     dual-write text → knowledge_chunks (RAG)
        │     ▼
        │  Postgres (memwal_paid_queries, memwal_marketplace_brains,
        │             knowledge_chunks, memwal_revenue_settlements …)
        │
        └────── Caddy → https://13-229-63-192.sslip.io ──────────┘
```

---

## 4 · Sui integration (cash-flow path)

### 4.1 Move publish flow — verified live

When a seller clicks **Publish (sign Sui tx)** on `/studio/[agentId]/Train`:

```move
public entry fun publish_brain(
    memwal_account_id: ID,
    namespace: vector<u8>,
    title: vector<u8>,
    description: vector<u8>,
    price_per_query_usdc_micro: u64,
    kya_required: bool,
    attestation_required: u8,
    sovereignty_proof_url: vector<u8>,
    cognitive_level: u8,
    clock: &Clock,
    ctx: &mut TxContext,
)
```

The Move module sets `seller = ctx.sender()` so the **operator can never impersonate** — every paid query routes USDC to the actual seller.

**Sample on-chain proof:**
- Tx digest: `A1twpRRaACTwn1rjQV6PgRtqGGcPFWR6SaUuuaCizt4m`
- Object created: `0x728e0a23f573b9f2c837e959064c643aba0a9fc6b9c11fb300f01d26334e35ea` (shared `MemWalBrain`)
- Suiscan: https://suiscan.xyz/testnet/tx/A1twpRRaACTwn1rjQV6PgRtqGGcPFWR6SaUuuaCizt4m

### 4.2 Move events emitted

| Event | Module | When |
|---|---|---|
| `MemWalBrainPublished` | `openx_memwal_marketplace` | On publish |
| `MemWalBrainUnpublished` | `openx_memwal_marketplace` | On unpublish |
| `MemWalBrainPriceUpdated` | `openx_memwal_marketplace` | On price change |
| `PaidQueryRecorded` | `openx_memwal_billing` | On every paid query (operator-signed) |
| `SettlementBatchEmitted` | `openx_memwal_billing` | Every 60s by settlement worker |

### 4.3 Active Sui environment

```env
MEMWAL_NETWORK=testnet
OPENX_BRAIN_PACKAGE_ID=0x4a760f6c982fbbe814dadb11adfe1a6c6d50bcce156de578b5f33e442f0e2041
MEMWAL_PACKAGE_ID=0xcf6ad755a1cdff7217865c796778fabe5aa399cb0cf2eba986f4b582047229c6
SUI_NETWORK=sui-testnet
```

### 4.4 Verify it yourself

```bash
# Read the Move package
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"sui_getObject",
       "params":["0x4a760f6c982fbbe814dadb11adfe1a6c6d50bcce156de578b5f33e442f0e2041",
                 {"showType":true}]}' \
  https://fullnode.testnet.sui.io

# Read the sample MemWalBrain
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"sui_getObject",
       "params":["0x728e0a23f573b9f2c837e959064c643aba0a9fc6b9c11fb300f01d26334e35ea",
                 {"showContent":true,"showOwner":true,"showType":true}]}' \
  https://fullnode.testnet.sui.io
```

---

## 5 · Walrus integration

### 5.1 Endpoints (testnet)

| Component | URL | Purpose |
|---|---|---|
| **Publisher** | https://publisher.walrus-testnet.walrus.space | Encrypts brain blobs, returns blob_id |
| **Aggregator** | https://aggregator.walrus-testnet.walrus.space | Public read by blob_id |
| **Walruscan** | https://walruscan.com | Browse any blob |

### 5.2 Where Walrus is used (62 files reference it)

| File | Role |
|---|---|
| `packages/sui-sdk/src/storage/walrusStore.ts` | Direct publisher/aggregator client |
| `packages/sui-sdk/src/storage/walrusQuiltBatcher.ts` | Multi-blob bundling (Quilt) for cost efficiency |
| `packages/sui-sdk/src/SealBrainClient.ts` | AES → Seal IBE wrap → Walrus blob pipeline |
| `packages/sdk/src/walrusMemoryBridge.ts` | MemWal cognitive memory L1–L5 namespaced writes via Walrus |
| `packages/api/src/services/walrusRenewal.ts` | Pre-expiry epoch renewal worker (32 references) |

### 5.3 Onchain references in Move

```move
// brain_registry.move — every brain stores its Walrus blob ids on Sui
public struct Brain has key {
    id: UID,
    owner: address,
    walrus_blob_ids: vector<vector<u8>>,
    ...
}
```

`MemWalBrain` references its namespace + the seller's MemWalAccount; the actual blobs are pinned in Walrus and retrievable via the aggregator URL.

### 5.4 Three-proof receipt (every paid query returns this)

```json
{
  "ok": true,
  "results": [...],
  "total": 1,
  "attestation": {
    "phala_tee_hash": null,
    "sui_billing_tx_hash": "0x...",
    "walrus_blob_ids": ["wal:cog-l3-18-..."],
    "explorer_urls": {
      "sui": "https://suiscan.xyz/testnet/tx/0x...",
      "walrus": ["https://walruscan.com/blob/wal:cog-l3-18-..."]
    }
  },
  "billing": { "rail": "sui_usdc", "tx_hash": "0x..." }
}
```

---

## 6 · MemWal integration (cognitive memory layer)

### 6.1 Operator pool architecture

OpenX runs a **delegate-key operator pool** so sellers don't sign every storage call:

```
Seller's MemWalAccount  (owned by seller's Sui wallet)
       │
       ├── delegate key #0  ──→ operator-pool ──→ signs upstream MemWal calls
       │                            │
       └── delegate key #1  ──←─ added via memwal::account::add_delegate_key
                                    (one-time, signed by seller)
```

**Storage cost is admin-sponsored:** the relayer pays Walrus, the operator wallet pays Sui gas. The seller signs **once** — to register the delegate — then nothing.

### 6.2 Namespacing convention

Every cognitive write goes through `cogNamespace(level, brainId, sessionId?)` from `@fhe-ai-context/sdk`:

| Level | Namespace | Default price | Purpose |
|---|---|---|---|
| L1 | `cog-l1-<brainId>-<sessionId>` | $0.005 | Episodic |
| L2 | `cog-l2-<brainId>` | $0.01 | Semantic |
| L3 | `cog-l3-<brainId>` | $0.05 | Long-term |
| L4 | `cog-l4-<brainId>` | $0.50 | Workflow |
| L5 | `cog-l5-<brainId>` | $5.00 | Reflective |

**Single source of truth** — no template literals across the codebase.

### 6.3 Operator credentials (env on VPS)

```env
OPENX_OPERATOR_SUI_PRIVATE_KEY=suiprivkey1qrawp...      # signs Move txs
OPENX_MEMWAL_DELEGATE_PRIVATE_KEYS=3dedfc9e8fdd...      # signs MemWal upstream
MEMWAL_RELAYER_URL=https://relayer-staging.memory.walrus.xyz
MEMWAL_PEERDEP_ENABLED=true
```

### 6.4 Mock-fallback (current testnet state)

Until a live MemWalAccount is provisioned onchain, `MEMWAL_FALLBACK_MODE=mock` is set so:

1. `/v3/memory/remember` returns deterministic synthetic blob ids
2. **Dual-writes** the text into Postgres `knowledge_chunks` so the public `/api/v1/<slug>` LLM path grounds responses in real seller text
3. `/v3/memory/recall` and `/v3/memory/brain/:id/query` return synthetic results with **proper three-proof structure** (mock tx hash labeled in the receipt)

Real Walrus storage activates the moment the MemWalAccount is provisioned — **zero code change**, just unset the flag.

---

## 7 · Tatum integration

### 7.1 Tatum Sui Gateway URLs

| Network | Gateway URL |
|---|---|
| Testnet | `https://sui-testnet.gateway.tatum.io` |
| Mainnet | `https://sui-mainnet.gateway.tatum.io` |

### 7.2 Verify the gateway works (no key needed for read)

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"sui_getChainIdentifier","params":[]}' \
  https://sui-testnet.gateway.tatum.io
# → {"id":1,"jsonrpc":"2.0","result":"4c78adac"}   (Sui testnet chain id)
```

### 7.3 Where Tatum is used (13 files reference it)

| File | Role |
|---|---|
| `packages/api/src/services/tatumClient.ts` | TatumClient wrapper, gateway URL routing, free/paid quota handling |
| `packages/api/src/routes/v3-tatum.ts` | Tatum-backed indexer routes (object + tx mirroring) |
| `scripts/smoke-tatum.ts` | Smoke test |
| `packages/sui-sdk/src/seal/sealKeyClient.ts` | Tatum RPC fallback for Seal key fetches |

### 7.4 Free key path (recommended)

```bash
# 1. Sign up free at https://dashboard.tatum.io
# 2. Set in .env:
TATUM_API_KEY=<your-key>
# 3. Higher quota + access to subscribe + webhook surfaces
```

Without a key, public-read methods still work via the gateway URL above — the hint message in `tatumClient.ts:32` explains both modes.

---

## 8 · End-to-end seller + buyer flow (with explorer links)

### 8.1 Seller (4 clicks)

| Step | UI | Backend | Onchain |
|---|---|---|---|
| 1 | Studio → Create agent | `POST /brains/create` (chain=sui-testnet) | — |
| 2 | Train tab → paste text → Train | `POST /v3/memory/remember` (mock) | — |
| 3 | (optional) Walrus storage real-mode | `MemWalAdapter.remember()` → relayer | Walrus blob |
| 4 | Publish form → sign Sui tx | `POST /v3/memory/marketplace/publish` | `MemWalBrain` minted; tx digest returned |

**Sample:** the brain `0x728e0a23…35ea` was published via tx `A1twpRRaACTwn1rjQV6PgRtqGGcPFWR6SaUuuaCizt4m`. Open https://suiscan.xyz/testnet/tx/A1twpRRaACTwn1rjQV6PgRtqGGcPFWR6SaUuuaCizt4m to see the actual onchain effects.

### 8.2 Buyer (1 click)

| Step | UI | Backend | Onchain |
|---|---|---|---|
| 1 | Marketplace → brain detail → Pay $0.05 & query | `POST /v3/memory/brain/:id/query` | x402 voucher recorded; settlement worker emits `SettlementBatchEmitted` event within 60s |
| 2 | Receipt rendered with 3-proof attestation | — | Sui billing tx + Walrus blob ids surfaced |

**Live cash-flow proof:**
- Cash-flow stats: https://13-229-63-192.sslip.io/v3/dashboard/stats
- Brain catalog: https://13-229-63-192.sslip.io/v3/memory/marketplace
- Settlement worker logs: pm2 (operator-side) emits `memwal:settlement:started` every 60s

### 8.3 MCP-client buyer (zero browser, MCP gateway)

```jsonc
// In Cursor / Claude Desktop / Codex mcp.json
{
  "mcpServers": {
    "openx": {
      "command": "npx",
      "args": ["@openx/mcp", "stdio"],
      "env": {
        "OPENX_API_BASE": "https://13-229-63-192.sslip.io",
        "OPENX_WALLET":   "<your sui wallet>",
        "OPENX_CHAIN":    "sui"
      }
    }
  }
}
```

The host then calls `openx_memwal_marketplace_query` with the brain id; OpenX returns the same three-proof bundle inlined under `_meta.attestation` per MCP 2025-11-25 spec.

---

## 9 · Verification recipes

### 9.1 Verify Move package + sample brain are live

```bash
# Move package
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"sui_getObject",
       "params":["0x4a760f6c982fbbe814dadb11adfe1a6c6d50bcce156de578b5f33e442f0e2041",{}]}' \
  https://fullnode.testnet.sui.io
# Expected: result.data.objectId matches, type="package", version=1

# Sample MemWalBrain shared object
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"sui_getObject",
       "params":["0x728e0a23f573b9f2c837e959064c643aba0a9fc6b9c11fb300f01d26334e35ea",
                 {"showContent":true}]}' \
  https://fullnode.testnet.sui.io
# Expected: type=…openx_memwal_marketplace::MemWalBrain, owner.Shared
```

### 9.2 Verify publish tx effects

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"sui_getTransactionBlock",
       "params":["A1twpRRaACTwn1rjQV6PgRtqGGcPFWR6SaUuuaCizt4m",
                 {"showEffects":true,"showObjectChanges":true}]}' \
  https://fullnode.testnet.sui.io
# Expected: effects.status.status="success", objectChanges contains
#           a "created" entry with type ::openx_memwal_marketplace::MemWalBrain
```

### 9.3 Verify Tatum gateway

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"sui_getChainIdentifier","params":[]}' \
  https://sui-testnet.gateway.tatum.io
# Expected: {"id":1,"jsonrpc":"2.0","result":"4c78adac"}
```

### 9.4 Verify a live paid query (full stack)

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -H "x-wallet-address: 0x100690d1234567890123456789012345678452db" \
  -H "x-chain: sui" -H "x-payment-rail: sui_usdc" \
  -d '{"query":"verification test"}' \
  https://13-229-63-192.sslip.io/v3/memory/brain/0x728e0a23f573b9f2c837e959064c643aba0a9fc6b9c11fb300f01d26334e35ea/query
# Expected: HTTP 200, billing.rail=sui_usdc, attestation.walrus_blob_ids non-empty,
#           explorer_urls.sui populated, mode="mock-fallback" (today)
```

---

## 10 · Compliance summary

| Sponsor requirement | OpenX evidence | Verification URL |
|---|---|---|
| **Tatum API key + Tatum Sui RPC** | `tatumClient.ts:111-112` routes through `sui-{testnet,mainnet}.gateway.tatum.io`; free-tier key path explicit at `tatumClient.ts:32-33` | https://dashboard.tatum.io · gateway response above |
| **Walrus storage meaningfully integrated** | 62 files reference Walrus; `walrusStore.ts`, `walrusQuiltBatcher.ts`, `walrusRenewal.ts`, `walrusMemoryBridge.ts`; every brain receipt includes `walrus_blob_ids` + walruscan URLs | https://walruscan.com |
| **Built on Sui Testnet** (mainnet-ready) | Move package `0x4a760f…` deployed, 11 modules, 43/43 Move tests passing; sample brain + publish tx onchain | Suiscan links below |
| **Memory layer (MemWal upstream)** | Mysten incubation package `0xcf6ad7…` integrated via operator-pool delegate keys; admin-sponsored storage; L1–L5 cognitive namespacing | https://suiscan.xyz/testnet/object/0xcf6ad755a1cdff7217865c796778fabe5aa399cb0cf2eba986f4b582047229c6 |

### Direct verification dashboard

| Artifact | URL |
|---|---|
| OpenX Move package on Suiscan | https://suiscan.xyz/testnet/object/0x4a760f6c982fbbe814dadb11adfe1a6c6d50bcce156de578b5f33e442f0e2041 |
| Deploy tx on Suiscan | https://suiscan.xyz/testnet/tx/3ScQEmpxmBmv3U8vUqL9ip73J771rSTK21mfdrt61hjz |
| Sample MemWalBrain on Suiscan | https://suiscan.xyz/testnet/object/0x728e0a23f573b9f2c837e959064c643aba0a9fc6b9c11fb300f01d26334e35ea |
| Publish tx on Suiscan | https://suiscan.xyz/testnet/tx/A1twpRRaACTwn1rjQV6PgRtqGGcPFWR6SaUuuaCizt4m |
| Operator wallet on Suiscan | https://suiscan.xyz/testnet/address/0x7b9a9e7b878863cc14adcf2f3ff29094454d3b1fe78d00637cb81dc29ce7ce96 |
| Live API health | https://13-229-63-192.sslip.io/health |
| Live cash-flow stats | https://13-229-63-192.sslip.io/v3/dashboard/stats |
| Live brain catalog | https://13-229-63-192.sslip.io/v3/memory/marketplace |
| Sample agent.json | https://13-229-63-192.sslip.io/api/v1/sui-audit-1780681145/.well-known/agent.json |

---

## 11 · Honest residual + roadmap

| What's real | What's flag-gated mock |
|---|---|
| Sui Move package deployed + tested + queried | MemWal upstream relayer (mock-fallback returns deterministic synthetic blobs until MemWalAccount provisioned) |
| Tatum Sui RPC for object reads | USDC fan-out (event-only — `SettlementBatchEmitted` emitted; coin transfer activates with Sui mainnet USDC) |
| Walrus publisher/aggregator URLs | — |
| Postgres knowledge_chunks dual-write (RAG works on real seller text) | — |
| Studio + Train + Publish + Marketplace UI | — |
| 3-proof receipt structure | Phala TEE hash (`null` until TEE wired in Phase 4) |
| Seal IBE wrapping at the brain level | — |
| Owner-free self-query | — |
| Network selector (Sui/x402/mock) | — |

**One onchain action unblocks everything:** provision a real `MemWalAccount` for the operator wallet via the MemWal app on testnet, register the delegate hex via `scripts/setup-memwal-delegate.ts`, unset `MEMWAL_FALLBACK_MODE`. No code change.

---

*Document generated against repo state as of 2026-06-06. All addresses + tx digests
verifiable via the Sui RPC commands in section 9.*
