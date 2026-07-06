import fs from "fs";
import path from "path";
import { createHash, randomBytes, randomUUID } from "crypto";
import type { PoolClient } from "pg";
import {
  ensureAccessDatabaseSchema,
  getAccessDatabasePool,
  isAccessDatabaseConfigured
} from "./accessDb.js";

export type BetaAccessRole = "beta_user" | "subscriber";

export type SubscriptionTierId = "daily" | "weekly" | "monthly";
export type PaymentChainId = "ethereum" | "solana" | "bsc" | "arbitrum" | "base";
export type PaymentToken = "USDC" | "USDT";
export type PaymentStatus = "pending" | "approved" | "rejected";
export type AccessControlStoreMode = "json" | "postgres";

export type BetaAccessUser = {
  telegramId: string;
  username?: string | undefined;
  firstName?: string | undefined;
  role: BetaAccessRole;
  status: "active" | "revoked";
  createdAt: string;
  updatedAt: string;
  expiresAt?: string | undefined;
  accessCodeLabel?: string | undefined;
  paymentId?: string | undefined;
};

export type BetaAccessCode = {
  codeHash: string;
  label: string;
  note?: string | undefined;
  maxUses: number;
  usedByTelegramIds: string[];
  createdByTelegramId: string;
  createdAt: string;
  expiresAt?: string | undefined;
  revokedAt?: string | undefined;
};

export type PaymentRequest = {
  paymentId: string;
  telegramId: string;
  username?: string | undefined;
  firstName?: string | undefined;
  tierId: SubscriptionTierId;
  amountUsd: number;
  accessDays: number;
  chain: PaymentChainId;
  token: PaymentToken;
  paymentAddress: string;
  status: PaymentStatus;
  createdAt: string;
  updatedAt: string;
  txHash?: string | undefined;
  approvedByTelegramId?: string | undefined;
  rejectedByTelegramId?: string | undefined;
  note?: string | undefined;
};

type AccessControlStore = {
  version: 1;
  users: BetaAccessUser[];
  codes: BetaAccessCode[];
  payments: PaymentRequest[];
};

type QueryExecutor = {
  query: PoolClient["query"];
};

export const SUBSCRIPTION_TIERS: Record<
  SubscriptionTierId,
  { label: string; amountUsd: number; accessDays: number; description: string }
> = {
  daily: {
    label: "Daily",
    amountUsd: 2,
    accessDays: 1,
    description: "24h access"
  },
  weekly: {
    label: "Weekly",
    amountUsd: 7,
    accessDays: 7,
    description: "7 days access"
  },
  monthly: {
    label: "Monthly",
    amountUsd: 20,
    accessDays: 30,
    description: "30 days access"
  }
};

export const PAYMENT_CHAINS: Record<PaymentChainId, { label: string; family: "evm" | "solana" }> = {
  ethereum: { label: "Ethereum", family: "evm" },
  solana: { label: "Solana", family: "solana" },
  bsc: { label: "BSC", family: "evm" },
  arbitrum: { label: "Arbitrum", family: "evm" },
  base: { label: "Base", family: "evm" }
};

const ACCESS_CONTROL_PATH = path.join(process.cwd(), "data", "access-control.json");

let postgresSchemaReadyPromise: Promise<void> | null = null;

function nowISO() {
  return new Date().toISOString();
}

function ensureAccessControlStoreDir() {
  fs.mkdirSync(path.dirname(ACCESS_CONTROL_PATH), { recursive: true });
}

function createEmptyStore(): AccessControlStore {
  return {
    version: 1,
    users: [],
    codes: [],
    payments: []
  };
}

function loadStore(): AccessControlStore {
  ensureAccessControlStoreDir();

  if (!fs.existsSync(ACCESS_CONTROL_PATH)) {
    return createEmptyStore();
  }

  const parsed = JSON.parse(fs.readFileSync(ACCESS_CONTROL_PATH, "utf8")) as Partial<AccessControlStore>;

  return {
    version: 1,
    users: Array.isArray(parsed.users) ? parsed.users : [],
    codes: Array.isArray(parsed.codes) ? parsed.codes : [],
    payments: Array.isArray(parsed.payments) ? parsed.payments : []
  };
}

function saveStore(store: AccessControlStore) {
  ensureAccessControlStoreDir();
  fs.writeFileSync(ACCESS_CONTROL_PATH, JSON.stringify(store, null, 2) + "\n");
}

export function getAccessControlStoreMode(): AccessControlStoreMode {
  return process.env.ACCESS_STORE === "postgres" ? "postgres" : "json";
}

function shouldUsePostgres() {
  return getAccessControlStoreMode() === "postgres";
}

async function ensurePostgresReady() {
  if (!isAccessDatabaseConfigured()) {
    throw new Error("ACCESS_STORE=postgres but DATABASE_URL is not configured.");
  }

  if (!postgresSchemaReadyPromise) {
    postgresSchemaReadyPromise = ensureAccessDatabaseSchema();
  }

  await postgresSchemaReadyPromise;
}

function toOptionalISO(value: unknown): string | undefined {
  if (!value) return undefined;

  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(String(value)).toISOString();
}

function toRequiredISO(value: unknown): string {
  return toOptionalISO(value) || nowISO();
}

function normalizeUsedByTelegramIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }

  return [];
}

function mapUserRow(row: any): BetaAccessUser {
  return {
    telegramId: String(row.telegram_id),
    username: row.username || undefined,
    firstName: row.first_name || undefined,
    role: row.role,
    status: row.status,
    createdAt: toRequiredISO(row.created_at),
    updatedAt: toRequiredISO(row.updated_at),
    expiresAt: toOptionalISO(row.expires_at),
    accessCodeLabel: row.access_code_label || undefined,
    paymentId: row.payment_id || undefined
  };
}

function mapCodeRow(row: any): BetaAccessCode {
  return {
    codeHash: row.code_hash,
    label: row.label,
    note: row.note || undefined,
    maxUses: Number(row.max_uses),
    usedByTelegramIds: normalizeUsedByTelegramIds(row.used_by_telegram_ids),
    createdByTelegramId: String(row.created_by_telegram_id),
    createdAt: toRequiredISO(row.created_at),
    expiresAt: toOptionalISO(row.expires_at),
    revokedAt: toOptionalISO(row.revoked_at)
  };
}

function mapPaymentRow(row: any): PaymentRequest {
  return {
    paymentId: row.payment_id,
    telegramId: String(row.telegram_id),
    username: row.username || undefined,
    firstName: row.first_name || undefined,
    tierId: row.tier_id,
    amountUsd: Number(row.amount_usd),
    accessDays: Number(row.access_days),
    chain: row.chain,
    token: row.token,
    paymentAddress: row.payment_address,
    status: row.status,
    createdAt: toRequiredISO(row.created_at),
    updatedAt: toRequiredISO(row.updated_at),
    txHash: row.tx_hash || undefined,
    approvedByTelegramId: row.approved_by_telegram_id || undefined,
    rejectedByTelegramId: row.rejected_by_telegram_id || undefined,
    note: row.note || undefined
  };
}

export function isPrivateBetaEnabled() {
  return process.env.PRIVATE_BETA_ENABLED === "true";
}

export function normalizeAccessCode(rawCode: string) {
  return rawCode.trim().toUpperCase().replace(/\s+/g, "");
}

function hashAccessCode(rawCode: string) {
  return createHash("sha256").update(normalizeAccessCode(rawCode)).digest("hex");
}

function generateAccessCode() {
  return `PHANTOM-${randomBytes(4).toString("hex").toUpperCase()}-${randomBytes(3)
    .toString("hex")
    .toUpperCase()}`;
}

function generateAccessCodeLabel() {
  return `code_${Date.now()}_${randomBytes(2).toString("hex")}`;
}

function isExpired(expiresAt?: string) {
  return Boolean(expiresAt && new Date(expiresAt).getTime() <= Date.now());
}

async function upsertActiveUserPostgres(
  executor: QueryExecutor,
  params: {
    telegramId: string;
    username?: string | undefined;
    firstName?: string | undefined;
    role: BetaAccessRole;
    expiresAt?: string | undefined;
    accessCodeLabel?: string | undefined;
    paymentId?: string | undefined;
  }
) {
  const updatedAt = nowISO();

  await executor.query(
    `
      INSERT INTO access_users (
        telegram_id,
        username,
        first_name,
        role,
        status,
        created_at,
        updated_at,
        expires_at,
        access_code_label,
        payment_id
      )
      VALUES ($1,$2,$3,$4,'active',$5,$5,$6,$7,$8)
      ON CONFLICT (telegram_id)
      DO UPDATE SET
        username = COALESCE(EXCLUDED.username, access_users.username),
        first_name = COALESCE(EXCLUDED.first_name, access_users.first_name),
        role = EXCLUDED.role,
        status = 'active',
        updated_at = EXCLUDED.updated_at,
        expires_at = EXCLUDED.expires_at,
        access_code_label = COALESCE(EXCLUDED.access_code_label, access_users.access_code_label),
        payment_id = COALESCE(EXCLUDED.payment_id, access_users.payment_id)
    `,
    [
      params.telegramId,
      params.username || null,
      params.firstName || null,
      params.role,
      updatedAt,
      params.expiresAt || null,
      params.accessCodeLabel || null,
      params.paymentId || null
    ]
  );
}

function upsertActiveUserJson(params: {
  telegramId: string;
  username?: string | undefined;
  firstName?: string | undefined;
  role: BetaAccessRole;
  expiresAt?: string | undefined;
  accessCodeLabel?: string | undefined;
  paymentId?: string | undefined;
}) {
  const store = loadStore();
  const existing = store.users.find((user) => user.telegramId === params.telegramId);
  const updatedAt = nowISO();

  if (existing) {
    existing.username = params.username || existing.username;
    existing.firstName = params.firstName || existing.firstName;
    existing.role = params.role;
    existing.status = "active";
    existing.updatedAt = updatedAt;
    existing.expiresAt = params.expiresAt;
    existing.accessCodeLabel = params.accessCodeLabel || existing.accessCodeLabel;
    existing.paymentId = params.paymentId || existing.paymentId;
  } else {
    store.users.push({
      telegramId: params.telegramId,
      username: params.username,
      firstName: params.firstName,
      role: params.role,
      status: "active",
      createdAt: updatedAt,
      updatedAt,
      expiresAt: params.expiresAt,
      accessCodeLabel: params.accessCodeLabel,
      paymentId: params.paymentId
    });
  }

  saveStore(store);
}

export async function getBetaAccessUser(telegramId: string): Promise<BetaAccessUser | null> {
  if (!shouldUsePostgres()) {
    const store = loadStore();
    return store.users.find((user) => user.telegramId === telegramId) || null;
  }

  await ensurePostgresReady();

  const db = getAccessDatabasePool();
  const result = await db.query(
    `SELECT * FROM access_users WHERE telegram_id = $1 LIMIT 1`,
    [telegramId]
  );

  return result.rows[0] ? mapUserRow(result.rows[0]) : null;
}

export async function hasActiveBetaAccess(telegramId: string): Promise<boolean> {
  const user = await getBetaAccessUser(telegramId);

  return Boolean(user && user.status === "active" && !isExpired(user.expiresAt));
}

export async function createBetaAccessCode(params: {
  createdByTelegramId: string;
  maxUses?: number;
  daysValid?: number;
  note?: string | undefined;
}) {
  const code = generateAccessCode();
  const createdAt = nowISO();
  const daysValid =
    params.daysValid && Number.isFinite(params.daysValid) && params.daysValid > 0
      ? Math.floor(params.daysValid)
      : 30;

  const record: BetaAccessCode = {
    codeHash: hashAccessCode(code),
    label: generateAccessCodeLabel(),
    note: params.note,
    maxUses:
      params.maxUses && Number.isFinite(params.maxUses) && params.maxUses > 0
        ? Math.floor(params.maxUses)
        : 1,
    usedByTelegramIds: [],
    createdByTelegramId: params.createdByTelegramId,
    createdAt,
    expiresAt: new Date(Date.now() + daysValid * 24 * 60 * 60 * 1000).toISOString()
  };

  if (!shouldUsePostgres()) {
    const store = loadStore();
    store.codes.push(record);
    saveStore(store);

    return { code, record };
  }

  await ensurePostgresReady();

  const db = getAccessDatabasePool();
  await db.query(
    `
      INSERT INTO access_codes (
        code_hash,
        label,
        note,
        max_uses,
        used_by_telegram_ids,
        created_by_telegram_id,
        created_at,
        expires_at,
        revoked_at
      )
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)
    `,
    [
      record.codeHash,
      record.label,
      record.note || null,
      record.maxUses,
      JSON.stringify(record.usedByTelegramIds),
      record.createdByTelegramId,
      record.createdAt,
      record.expiresAt || null,
      record.revokedAt || null
    ]
  );

  return { code, record };
}

export async function redeemBetaAccessCode(params: {
  code: string;
  telegramId: string;
  username?: string | undefined;
  firstName?: string | undefined;
}) {
  if (!shouldUsePostgres()) {
    const store = loadStore();
    const codeHash = hashAccessCode(params.code);
    const code = store.codes.find((item) => item.codeHash === codeHash);

    if (!code) return { ok: false as const, reason: "invalid_code" };
    if (code.revokedAt) return { ok: false as const, reason: "code_revoked" };
    if (isExpired(code.expiresAt)) return { ok: false as const, reason: "code_expired" };

    if (
      code.usedByTelegramIds.length >= code.maxUses &&
      !code.usedByTelegramIds.includes(params.telegramId)
    ) {
      return { ok: false as const, reason: "code_fully_used" };
    }

    if (!code.usedByTelegramIds.includes(params.telegramId)) {
      code.usedByTelegramIds.push(params.telegramId);
    }

    saveStore(store);

    upsertActiveUserJson({
      telegramId: params.telegramId,
      username: params.username,
      firstName: params.firstName,
      role: "beta_user",
      expiresAt: code.expiresAt,
      accessCodeLabel: code.label
    });

    return { ok: true as const, expiresAt: code.expiresAt };
  }

  await ensurePostgresReady();

  const db = getAccessDatabasePool();
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const codeHash = hashAccessCode(params.code);
    const result = await client.query(
      `SELECT * FROM access_codes WHERE code_hash = $1 FOR UPDATE`,
      [codeHash]
    );

    const row = result.rows[0];

    if (!row) {
      await client.query("ROLLBACK");
      return { ok: false as const, reason: "invalid_code" };
    }

    const code = mapCodeRow(row);

    if (code.revokedAt) {
      await client.query("ROLLBACK");
      return { ok: false as const, reason: "code_revoked" };
    }

    if (isExpired(code.expiresAt)) {
      await client.query("ROLLBACK");
      return { ok: false as const, reason: "code_expired" };
    }

    if (
      code.usedByTelegramIds.length >= code.maxUses &&
      !code.usedByTelegramIds.includes(params.telegramId)
    ) {
      await client.query("ROLLBACK");
      return { ok: false as const, reason: "code_fully_used" };
    }

    if (!code.usedByTelegramIds.includes(params.telegramId)) {
      code.usedByTelegramIds.push(params.telegramId);
    }

    await client.query(
      `UPDATE access_codes SET used_by_telegram_ids = $2::jsonb WHERE code_hash = $1`,
      [code.codeHash, JSON.stringify(code.usedByTelegramIds)]
    );

    await upsertActiveUserPostgres(client, {
      telegramId: params.telegramId,
      username: params.username,
      firstName: params.firstName,
      role: "beta_user",
      expiresAt: code.expiresAt,
      accessCodeLabel: code.label
    });

    await client.query("COMMIT");

    return { ok: true as const, expiresAt: code.expiresAt };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function getPaymentAddress(chain: PaymentChainId) {
  const chainInfo = PAYMENT_CHAINS[chain];

  if (chainInfo.family === "solana") {
    return process.env.SUBSCRIPTION_SOLANA_ADDRESS || "";
  }

  return process.env.SUBSCRIPTION_EVM_ADDRESS || "";
}

export async function createPaymentRequest(params: {
  telegramId: string;
  username?: string | undefined;
  firstName?: string | undefined;
  tierId: SubscriptionTierId;
  chain: PaymentChainId;
  token: PaymentToken;
}) {
  const tier = SUBSCRIPTION_TIERS[params.tierId];
  const paymentAddress = getPaymentAddress(params.chain);

  if (!tier) {
    throw new Error("Invalid subscription tier.");
  }

  if (!paymentAddress) {
    throw new Error("Payment address is not configured for this chain.");
  }

  const createdAt = nowISO();

  const request: PaymentRequest = {
    paymentId: randomUUID().slice(0, 12),
    telegramId: params.telegramId,
    username: params.username,
    firstName: params.firstName,
    tierId: params.tierId,
    amountUsd: tier.amountUsd,
    accessDays: tier.accessDays,
    chain: params.chain,
    token: params.token,
    paymentAddress,
    status: "pending",
    createdAt,
    updatedAt: createdAt
  };

  if (!shouldUsePostgres()) {
    const store = loadStore();
    store.payments.push(request);
    saveStore(store);

    return request;
  }

  await ensurePostgresReady();

  const db = getAccessDatabasePool();
  await db.query(
    `
      INSERT INTO payment_requests (
        payment_id,
        telegram_id,
        username,
        first_name,
        tier_id,
        amount_usd,
        access_days,
        chain,
        token,
        payment_address,
        status,
        created_at,
        updated_at,
        tx_hash,
        approved_by_telegram_id,
        rejected_by_telegram_id,
        note
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    `,
    [
      request.paymentId,
      request.telegramId,
      request.username || null,
      request.firstName || null,
      request.tierId,
      request.amountUsd,
      request.accessDays,
      request.chain,
      request.token,
      request.paymentAddress,
      request.status,
      request.createdAt,
      request.updatedAt,
      request.txHash || null,
      request.approvedByTelegramId || null,
      request.rejectedByTelegramId || null,
      request.note || null
    ]
  );

  return request;
}

export async function attachPaymentTxHash(params: {
  paymentId: string;
  telegramId: string;
  txHash: string;
}) {
  if (!shouldUsePostgres()) {
    const store = loadStore();
    const payment = store.payments.find((item) => item.paymentId === params.paymentId);

    if (!payment) return { ok: false as const, reason: "payment_not_found" };
    if (payment.telegramId !== params.telegramId) return { ok: false as const, reason: "wrong_user" };
    if (payment.status !== "pending") return { ok: false as const, reason: "payment_not_pending" };

    payment.txHash = params.txHash.trim();
    payment.updatedAt = nowISO();

    saveStore(store);

    return { ok: true as const, payment };
  }

  await ensurePostgresReady();

  const db = getAccessDatabasePool();
  const found = await db.query(
    `SELECT * FROM payment_requests WHERE payment_id = $1 LIMIT 1`,
    [params.paymentId]
  );

  const payment = found.rows[0] ? mapPaymentRow(found.rows[0]) : null;

  if (!payment) return { ok: false as const, reason: "payment_not_found" };
  if (payment.telegramId !== params.telegramId) return { ok: false as const, reason: "wrong_user" };
  if (payment.status !== "pending") return { ok: false as const, reason: "payment_not_pending" };

  const updatedAt = nowISO();
  const updated = await db.query(
    `
      UPDATE payment_requests
      SET tx_hash = $3, updated_at = $4
      WHERE payment_id = $1 AND telegram_id = $2
      RETURNING *
    `,
    [params.paymentId, params.telegramId, params.txHash.trim(), updatedAt]
  );

  return { ok: true as const, payment: mapPaymentRow(updated.rows[0]) };
}

export async function listPaymentRequests(status?: PaymentStatus) {
  if (!shouldUsePostgres()) {
    const payments = loadStore().payments;

    if (!status) return payments;

    return payments.filter((payment) => payment.status === status);
  }

  await ensurePostgresReady();

  const db = getAccessDatabasePool();

  const result = status
    ? await db.query(
        `SELECT * FROM payment_requests WHERE status = $1 ORDER BY created_at ASC`,
        [status]
      )
    : await db.query(`SELECT * FROM payment_requests ORDER BY created_at ASC`);

  return result.rows.map(mapPaymentRow);
}

export async function approvePaymentRequest(params: {
  paymentId: string;
  approvedByTelegramId: string;
}) {
  if (!shouldUsePostgres()) {
    const store = loadStore();
    const payment = store.payments.find((item) => item.paymentId === params.paymentId);

    if (!payment) return { ok: false as const, reason: "payment_not_found" };
    if (payment.status !== "pending") return { ok: false as const, reason: "payment_not_pending" };

    const expiresAt = new Date(Date.now() + payment.accessDays * 24 * 60 * 60 * 1000).toISOString();

    payment.status = "approved";
    payment.approvedByTelegramId = params.approvedByTelegramId;
    payment.updatedAt = nowISO();

    saveStore(store);

    upsertActiveUserJson({
      telegramId: payment.telegramId,
      username: payment.username,
      firstName: payment.firstName,
      role: "subscriber",
      expiresAt,
      paymentId: payment.paymentId
    });

    return { ok: true as const, payment, expiresAt };
  }

  await ensurePostgresReady();

  const db = getAccessDatabasePool();
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const found = await client.query(
      `SELECT * FROM payment_requests WHERE payment_id = $1 FOR UPDATE`,
      [params.paymentId]
    );

    const payment = found.rows[0] ? mapPaymentRow(found.rows[0]) : null;

    if (!payment) {
      await client.query("ROLLBACK");
      return { ok: false as const, reason: "payment_not_found" };
    }

    if (payment.status !== "pending") {
      await client.query("ROLLBACK");
      return { ok: false as const, reason: "payment_not_pending" };
    }

    const expiresAt = new Date(Date.now() + payment.accessDays * 24 * 60 * 60 * 1000).toISOString();
    const updatedAt = nowISO();

    const updated = await client.query(
      `
        UPDATE payment_requests
        SET status = 'approved',
            approved_by_telegram_id = $2,
            updated_at = $3
        WHERE payment_id = $1
        RETURNING *
      `,
      [params.paymentId, params.approvedByTelegramId, updatedAt]
    );

    const updatedPayment = mapPaymentRow(updated.rows[0]);

    await upsertActiveUserPostgres(client, {
      telegramId: updatedPayment.telegramId,
      username: updatedPayment.username,
      firstName: updatedPayment.firstName,
      role: "subscriber",
      expiresAt,
      paymentId: updatedPayment.paymentId
    });

    await client.query("COMMIT");

    return { ok: true as const, payment: updatedPayment, expiresAt };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function rejectPaymentRequest(params: {
  paymentId: string;
  rejectedByTelegramId: string;
  note?: string | undefined;
}) {
  if (!shouldUsePostgres()) {
    const store = loadStore();
    const payment = store.payments.find((item) => item.paymentId === params.paymentId);

    if (!payment) return { ok: false as const, reason: "payment_not_found" };
    if (payment.status !== "pending") return { ok: false as const, reason: "payment_not_pending" };

    payment.status = "rejected";
    payment.rejectedByTelegramId = params.rejectedByTelegramId;
    payment.note = params.note;
    payment.updatedAt = nowISO();

    saveStore(store);

    return { ok: true as const, payment };
  }

  await ensurePostgresReady();

  const db = getAccessDatabasePool();
  const found = await db.query(
    `SELECT * FROM payment_requests WHERE payment_id = $1 LIMIT 1`,
    [params.paymentId]
  );

  const payment = found.rows[0] ? mapPaymentRow(found.rows[0]) : null;

  if (!payment) return { ok: false as const, reason: "payment_not_found" };
  if (payment.status !== "pending") return { ok: false as const, reason: "payment_not_pending" };

  const updated = await db.query(
    `
      UPDATE payment_requests
      SET status = 'rejected',
          rejected_by_telegram_id = $2,
          note = $3,
          updated_at = $4
      WHERE payment_id = $1
      RETURNING *
    `,
    [params.paymentId, params.rejectedByTelegramId, params.note || null, nowISO()]
  );

  return { ok: true as const, payment: mapPaymentRow(updated.rows[0]) };
}

export async function listBetaAccessUsers() {
  if (!shouldUsePostgres()) {
    return loadStore().users;
  }

  await ensurePostgresReady();

  const db = getAccessDatabasePool();
  const result = await db.query(`SELECT * FROM access_users ORDER BY created_at ASC`);

  return result.rows.map(mapUserRow);
}

export async function listBetaAccessCodes() {
  if (!shouldUsePostgres()) {
    return loadStore().codes;
  }

  await ensurePostgresReady();

  const db = getAccessDatabasePool();
  const result = await db.query(`SELECT * FROM access_codes ORDER BY created_at ASC`);

  return result.rows.map(mapCodeRow);
}

export async function revokeBetaAccessUser(telegramId: string) {
  if (!shouldUsePostgres()) {
    const store = loadStore();
    const user = store.users.find((item) => item.telegramId === telegramId);

    if (!user) return null;

    user.status = "revoked";
    user.updatedAt = nowISO();

    saveStore(store);
    return user;
  }

  await ensurePostgresReady();

  const db = getAccessDatabasePool();
  const result = await db.query(
    `
      UPDATE access_users
      SET status = 'revoked',
          updated_at = $2
      WHERE telegram_id = $1
      RETURNING *
    `,
    [telegramId, nowISO()]
  );

  return result.rows[0] ? mapUserRow(result.rows[0]) : null;
}

export async function revokeBetaAccessCode(label: string) {
  if (!shouldUsePostgres()) {
    const store = loadStore();
    const code = store.codes.find((item) => item.label === label);

    if (!code) return null;

    code.revokedAt = nowISO();

    saveStore(store);
    return code;
  }

  await ensurePostgresReady();

  const db = getAccessDatabasePool();
  const result = await db.query(
    `
      UPDATE access_codes
      SET revoked_at = $2
      WHERE label = $1
      RETURNING *
    `,
    [label, nowISO()]
  );

  return result.rows[0] ? mapCodeRow(result.rows[0]) : null;
}

export async function getAccessControlStatus() {
  if (!shouldUsePostgres()) {
    const store = loadStore();

    return {
      storeMode: getAccessControlStoreMode(),
      privateBetaEnabled: isPrivateBetaEnabled(),
      activeUsers: store.users.filter((user) => user.status === "active" && !isExpired(user.expiresAt)).length,
      revokedUsers: store.users.filter((user) => user.status === "revoked").length,
      activeCodes: store.codes.filter((code) => !code.revokedAt && !isExpired(code.expiresAt)).length,
      revokedCodes: store.codes.filter((code) => Boolean(code.revokedAt)).length,
      pendingPayments: store.payments.filter((payment) => payment.status === "pending").length,
      approvedPayments: store.payments.filter((payment) => payment.status === "approved").length,
      rejectedPayments: store.payments.filter((payment) => payment.status === "rejected").length
    };
  }

  await ensurePostgresReady();

  const db = getAccessDatabasePool();

  const [
    activeUsers,
    revokedUsers,
    activeCodes,
    revokedCodes,
    pendingPayments,
    approvedPayments,
    rejectedPayments
  ] = await Promise.all([
    db.query(`SELECT COUNT(*)::int AS count FROM access_users WHERE status = 'active' AND (expires_at IS NULL OR expires_at > NOW())`),
    db.query(`SELECT COUNT(*)::int AS count FROM access_users WHERE status = 'revoked'`),
    db.query(`SELECT COUNT(*)::int AS count FROM access_codes WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`),
    db.query(`SELECT COUNT(*)::int AS count FROM access_codes WHERE revoked_at IS NOT NULL`),
    db.query(`SELECT COUNT(*)::int AS count FROM payment_requests WHERE status = 'pending'`),
    db.query(`SELECT COUNT(*)::int AS count FROM payment_requests WHERE status = 'approved'`),
    db.query(`SELECT COUNT(*)::int AS count FROM payment_requests WHERE status = 'rejected'`)
  ]);

  return {
    storeMode: getAccessControlStoreMode(),
    privateBetaEnabled: isPrivateBetaEnabled(),
    activeUsers: Number(activeUsers.rows[0]?.count || 0),
    revokedUsers: Number(revokedUsers.rows[0]?.count || 0),
    activeCodes: Number(activeCodes.rows[0]?.count || 0),
    revokedCodes: Number(revokedCodes.rows[0]?.count || 0),
    pendingPayments: Number(pendingPayments.rows[0]?.count || 0),
    approvedPayments: Number(approvedPayments.rows[0]?.count || 0),
    rejectedPayments: Number(rejectedPayments.rows[0]?.count || 0)
  };
}
