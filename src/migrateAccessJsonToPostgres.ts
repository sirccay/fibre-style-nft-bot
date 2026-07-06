import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { ensureAccessDatabaseSchema, getAccessDatabasePool } from "./accessDb.js";

dotenv.config();

type AccessControlStore = {
  version: 1;
  users: any[];
  codes: any[];
  payments: any[];
};

const ACCESS_CONTROL_PATH = path.join(process.cwd(), "data", "access-control.json");

function readAccessJson(): AccessControlStore {
  if (!fs.existsSync(ACCESS_CONTROL_PATH)) {
    return { version: 1, users: [], codes: [], payments: [] };
  }

  const parsed = JSON.parse(fs.readFileSync(ACCESS_CONTROL_PATH, "utf8"));

  return {
    version: 1,
    users: Array.isArray(parsed.users) ? parsed.users : [],
    codes: Array.isArray(parsed.codes) ? parsed.codes : [],
    payments: Array.isArray(parsed.payments) ? parsed.payments : []
  };
}

await ensureAccessDatabaseSchema();

const store = readAccessJson();
const db = getAccessDatabasePool();

for (const user of store.users) {
  await db.query(
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
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (telegram_id)
      DO UPDATE SET
        username = EXCLUDED.username,
        first_name = EXCLUDED.first_name,
        role = EXCLUDED.role,
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at,
        expires_at = EXCLUDED.expires_at,
        access_code_label = EXCLUDED.access_code_label,
        payment_id = EXCLUDED.payment_id
    `,
    [
      user.telegramId,
      user.username || null,
      user.firstName || null,
      user.role,
      user.status,
      user.createdAt,
      user.updatedAt,
      user.expiresAt || null,
      user.accessCodeLabel || null,
      user.paymentId || null
    ]
  );
}

for (const code of store.codes) {
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
      ON CONFLICT (code_hash)
      DO UPDATE SET
        label = EXCLUDED.label,
        note = EXCLUDED.note,
        max_uses = EXCLUDED.max_uses,
        used_by_telegram_ids = EXCLUDED.used_by_telegram_ids,
        expires_at = EXCLUDED.expires_at,
        revoked_at = EXCLUDED.revoked_at
    `,
    [
      code.codeHash,
      code.label,
      code.note || null,
      code.maxUses,
      JSON.stringify(Array.isArray(code.usedByTelegramIds) ? code.usedByTelegramIds : []),
      code.createdByTelegramId,
      code.createdAt,
      code.expiresAt || null,
      code.revokedAt || null
    ]
  );
}

for (const payment of store.payments) {
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
      ON CONFLICT (payment_id)
      DO UPDATE SET
        username = EXCLUDED.username,
        first_name = EXCLUDED.first_name,
        tier_id = EXCLUDED.tier_id,
        amount_usd = EXCLUDED.amount_usd,
        access_days = EXCLUDED.access_days,
        chain = EXCLUDED.chain,
        token = EXCLUDED.token,
        payment_address = EXCLUDED.payment_address,
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at,
        tx_hash = EXCLUDED.tx_hash,
        approved_by_telegram_id = EXCLUDED.approved_by_telegram_id,
        rejected_by_telegram_id = EXCLUDED.rejected_by_telegram_id,
        note = EXCLUDED.note
    `,
    [
      payment.paymentId,
      payment.telegramId,
      payment.username || null,
      payment.firstName || null,
      payment.tierId,
      payment.amountUsd,
      payment.accessDays,
      payment.chain,
      payment.token,
      payment.paymentAddress,
      payment.status,
      payment.createdAt,
      payment.updatedAt,
      payment.txHash || null,
      payment.approvedByTelegramId || null,
      payment.rejectedByTelegramId || null,
      payment.note || null
    ]
  );
}

console.log("OK migrated access-control JSON into PostgreSQL.");
console.log(`Users: ${store.users.length}`);
console.log(`Codes: ${store.codes.length}`);
console.log(`Payments: ${store.payments.length}`);
