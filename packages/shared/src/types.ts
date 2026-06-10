export interface Brain {
  id: number;
  owner_address: string;
  title: string;
  description: string;
  tags: string[];
  chain: string;
  published: boolean;
  created_at: Date;
}

export interface KnowledgeChunk {
  id: number;
  brain_id: number;
  chunk_index: number;
  content: string;
  created_at: Date;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface ChatHistory {
  id: number;
  user_address: string;
  brain_id: number;
  messages: ChatMessage[];
  summary: string | null;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// v3 — Sui-native agentic marketplace
// ---------------------------------------------------------------------------

export type Chain = 'sui-testnet' | 'sui-mainnet';
export type Rail = 'x402' | 'mpp' | 'sui_usdc';

export interface AgentPersona {
  system_prompt: string;
  tools: string[];
  model: string;
}

export interface AgentPricing {
  x402: string | null;
  mpp: string | null;
  sui_usdc: string | null;
}

export interface AgentRecord {
  id: string;
  brain_id: number;
  owner_address: string;
  chain: Chain;
  persona: AgentPersona;
  pricing: AgentPricing;
  published: boolean;
  created_at: Date;
}

export interface AgentReceipt {
  id: number;
  agent_id: string;
  buyer: string;
  rail: Rail;
  amount_usdc: string;
  tx_or_receipt: string;
  bundle_id: string | null;
  created_at: Date;
}
