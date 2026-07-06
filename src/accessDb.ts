import { Pool } from "pg";

let pool: Pool | null = null;

export function getAccessDatabaseUrl() {
  return process.env.DATABASE_URL || "";
}

export function isAccessDatabaseConfigured() {
  return Boolean(getAccessDatabaseUrl());
}

export function getAccessDatabasePool() {
  const connectionString = getAccessDatabaseUrl();

  if (!connectionString) {
    throw new Error("DATABASE_URL is not configured.");
  }

  if (!pool) {
    pool = new Pool({
      connectionString,
      ssl:
        process.env.DATABASE_SSL === "false"
          ? false
          : { rejectUnauthorized: false }
    });
  }

  return pool;
}

export async function ensureAccessDatabaseSchema() {
  const db = getAccessDatabasePool();

  await db.query(`
    CREATE TABLE IF NOT EXISTS access_users (
      telegram_id TEXT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      role TEXT NOT NULL CHECK (role IN ('beta_user', 'subscriber')),
      status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ,
      access_code_label TEXT,
      payment_id TEXT
    );

    CREATE TABLE IF NOT EXISTS access_codes (
      code_hash TEXT PRIMARY KEY,
      label TEXT NOT NULL UNIQUE,
      note TEXT,
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_by_telegram_ids JSONB NOT NULL DEFAULT '[]',
      created_by_telegram_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS payment_requests (
      payment_id TEXT PRIMARY KEY,
      telegram_id TEXT NOT NULL,
      username TEXT,
      first_name TEXT,
      tier_id TEXT NOT NULL CHECK (tier_id IN ('daily', 'weekly', 'monthly')),
      amount_usd NUMERIC NOT NULL,
      access_days INTEGER NOT NULL,
      chain TEXT NOT NULL CHECK (chain IN ('ethereum', 'solana', 'bsc', 'arbitrum', 'base')),
      token TEXT NOT NULL CHECK (token IN ('USDC', 'USDT')),
      payment_address TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      tx_hash TEXT,
      approved_by_telegram_id TEXT,
      rejected_by_telegram_id TEXT,
      note TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_access_users_status ON access_users(status);
    CREATE INDEX IF NOT EXISTS idx_access_codes_label ON access_codes(label);
    CREATE INDEX IF NOT EXISTS idx_payment_requests_status ON payment_requests(status);
    CREATE INDEX IF NOT EXISTS idx_payment_requests_telegram_id ON payment_requests(telegram_id);
  `);
}

export async function getAccessDatabaseStatus() {
  if (!isAccessDatabaseConfigured()) {
    return {
      configured: false,
      ok: false,
      message: "DATABASE_URL is not configured."
    };
  }

  try {
    const db = getAccessDatabasePool();
    const result = await db.query("SELECT NOW() AS now");
    return {
      configured: true,
      ok: true,
      message: `Connected. Server time: ${result.rows[0]?.now}`
    };
  } catch (error: any) {
    return {
      configured: true,
      ok: false,
      message: error?.message || "Unknown database error."
    };
  }
}
