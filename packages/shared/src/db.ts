import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

/** Execute a SQL query against the shared pool. */
export function query(sql: string, params?: unknown[]) {
  return pool.query(sql, params);
}

export const TABLES = {
  BRAINS: 'brains',
  KNOWLEDGE_CHUNKS: 'knowledge_chunks',
  SUBSCRIPTIONS: 'subscriptions',
  CHAT_HISTORY: 'chat_history',
} as const;
