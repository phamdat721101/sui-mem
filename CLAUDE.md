# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

FHE AI Context is a monorepo implementing a privacy-preserving AI assistant using Fully Homomorphic Encryption (FHE) on Arbitrum. Users interact with an AI agent while their conversation context remains encrypted on-chain via the CoFHE protocol.

## Monorepo Structure

```
packages/
  sdk/        # TypeScript SDK — FHE encrypt/decrypt for context & memory, permit management
  contracts/  # Solidity contracts (Arbitrum Sepolia/mainnet) using CoFHE
  agent/      # Express backend — loads encrypted context, calls LLM, updates memory on-chain
  frontend/   # Next.js frontend — Privy wallet auth, pixel-art retro UI
scripts/      # start.sh (dev), deploy-contracts.sh
```

## Commands

All commands run from the repo root unless noted.

### Install
```bash
npm install
```

### SDK
```bash
npm run sdk:build          # Build SDK (required before agent/frontend work)
```

### Contracts
```bash
npm run contracts:compile              # Compile Solidity
npm run contracts:test                 # Run Hardhat tests
npm run contracts:deploy:sepolia       # Deploy to Arbitrum Sepolia
# Deploy outputs addresses to packages/contracts/deployments/arbitrum-sepolia.json
```

### Agent (port 3001)
```bash
npm run agent:dev          # Start with ts-node
```

### Frontend (port 3000)
```bash
npm run frontend:dev       # Next.js dev server
```

### Start everything
```bash
./scripts/start.sh         # Builds SDK, then starts agent + frontend concurrently
```

## Environment Setup

Copy `.env.example` to `.env` at root, then per-package:
- `packages/agent/.env` — `AGENT_PRIVATE_KEY`, `OPENAI_API_KEY`, contract addresses, `PORT=3001`, RPC URLs
- `packages/frontend/.env.local` — `NEXT_PUBLIC_PRIVY_APP_ID`, contract addresses, `NEXT_PUBLIC_AGENT_BACKEND_URL`, `NEXT_PUBLIC_CHAIN_ID=421614`

After deploying contracts, copy the 3 addresses from `packages/contracts/deployments/arbitrum-sepolia.json` into both env files.

## Architecture

### Data Flow
1. Frontend (Privy wallet) → user creates/imports a **permit** (CoFHE decryption delegation)
2. Frontend sends `POST /chat` with `{userAddress, message, serializedPermit}` to Agent
3. Agent uses permit to decrypt encrypted context/memory from blockchain (no plaintext stored on-chain)
4. Agent builds LLM system prompt from trust level, sentiment score, memory tier
5. Agent calls OpenAI/Gemini, returns response; memory update happens asynchronously

### Smart Contracts (Arbitrum Sepolia)
- **AIContextManager** — Stores encrypted user context fields (sessionKey, sentimentScore, trustLevel, memoryTier, etc.) using `FHE.asEuint128/64`. Key functions: `writeContext()`, `getContextHandles()`, `conditionalUpgrade()` (branchless FHE.select upgrade)
- **AIMemoryStore** — Tracks encrypted interaction count and last timestamp; only user or authorized agent can update
- **AgentRegistry** — Agents self-register; users assign an agent via `assignAgent()`

### SDK (`packages/sdk/src/`)
- `context/` — `encryptContext.ts` / `decryptContext.ts` using CoFHE SDK
- `memory/` — `encryptMemory.ts` / `decryptMemory.ts`
- `permits/` — `createPermit`, `importPermit`, `revokePermit` (time-limited decryption delegation)
- `utils/` — `hashMemory` (IPFS-style conversation hashing), `encodeSentiment`

### Agent (`packages/agent/src/`)
- `routes/` — `chat.ts`, `permit.ts`, `memory.ts`
- `agent/` — `contextLoader.ts`, `memoryLoader.ts`, `promptBuilder.ts`, `responseHandler.ts`
- `services/blockchainService.ts` — ethers.js interactions with contracts

### Frontend (`packages/frontend/src/`)
- `hooks/` — `useChat.ts`, `usePermit.ts`, `useCofheClient.ts`
- `components/` — `ChatWindow`, `PermitManager`, `WalletConnect`, `OnboardForm`, `ContextStatus`
- Async WebAssembly enabled in `next.config.mjs` for `@cofhe/sdk` WASM module

## Key Technical Details

- **Solidity 0.8.27**, optimizer 200 runs, `evmVersion: cancun`, network chain ID `421614` (Arbitrum Sepolia)
- **SDK must be built before agent or frontend** — both import from `packages/sdk/dist/`
- Frontend uses `serverComponentsExternalPackages: ['@cofhe/sdk']` to handle WASM correctly
- Agent returns chat response immediately; on-chain memory updates are fire-and-forget
- LLM system prompt tone is dynamically adjusted from the encrypted `trustLevel` field
