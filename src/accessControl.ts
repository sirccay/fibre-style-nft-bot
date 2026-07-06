import fs from "fs";
import path from "path";
import { createHash, randomBytes, randomUUID } from "crypto";

export type BetaAccessRole = "beta_user" | "subscriber";

export type SubscriptionTierId = "daily" | "weekly" | "monthly";
export type PaymentChainId = "ethereum" | "solana" | "bsc" | "arbitrum" | "base";
export type PaymentToken = "USDC" | "USDT";
export type PaymentStatus = "pending" | "approved" | "rejected";

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

function isExpired(expiresAt?: string) {
  return Boolean(expiresAt && new Date(expiresAt).getTime() <= Date.now());
}

export function getBetaAccessUser(telegramId: string): BetaAccessUser | null {
  const store = loadStore();
  return store.users.find((user) => user.telegramId === telegramId) || null;
}

export function hasActiveBetaAccess(telegramId: string): boolean {
  const user = getBetaAccessUser(telegramId);

  return Boolean(user && user.status === "active" && !isExpired(user.expiresAt));
}

function upsertActiveUser(params: {
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

export function createBetaAccessCode(params: {
  createdByTelegramId: string;
  maxUses?: number;
  daysValid?: number;
  note?: string | undefined;
}) {
  const store = loadStore();
  const code = generateAccessCode();
  const createdAt = nowISO();
  const daysValid =
    params.daysValid && Number.isFinite(params.daysValid) && params.daysValid > 0
      ? Math.floor(params.daysValid)
      : 30;

  const record: BetaAccessCode = {
    codeHash: hashAccessCode(code),
    label: `code_${store.codes.length + 1}_${Date.now()}`,
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

  store.codes.push(record);
  saveStore(store);

  return { code, record };
}

export function redeemBetaAccessCode(params: {
  code: string;
  telegramId: string;
  username?: string | undefined;
  firstName?: string | undefined;
}) {
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

  upsertActiveUser({
    telegramId: params.telegramId,
    username: params.username,
    firstName: params.firstName,
    role: "beta_user",
    expiresAt: code.expiresAt,
    accessCodeLabel: code.label
  });

  return { ok: true as const, expiresAt: code.expiresAt };
}

export function getPaymentAddress(chain: PaymentChainId) {
  const chainInfo = PAYMENT_CHAINS[chain];

  if (chainInfo.family === "solana") {
    return process.env.SUBSCRIPTION_SOLANA_ADDRESS || "";
  }

  return process.env.SUBSCRIPTION_EVM_ADDRESS || "";
}

export function createPaymentRequest(params: {
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

  const store = loadStore();
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

  store.payments.push(request);
  saveStore(store);

  return request;
}

export function attachPaymentTxHash(params: {
  paymentId: string;
  telegramId: string;
  txHash: string;
}) {
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

export function listPaymentRequests(status?: PaymentStatus) {
  const payments = loadStore().payments;

  if (!status) return payments;

  return payments.filter((payment) => payment.status === status);
}

export function approvePaymentRequest(params: {
  paymentId: string;
  approvedByTelegramId: string;
}) {
  const store = loadStore();
  const payment = store.payments.find((item) => item.paymentId === params.paymentId);

  if (!payment) return { ok: false as const, reason: "payment_not_found" };
  if (payment.status !== "pending") return { ok: false as const, reason: "payment_not_pending" };

  const expiresAt = new Date(Date.now() + payment.accessDays * 24 * 60 * 60 * 1000).toISOString();

  payment.status = "approved";
  payment.approvedByTelegramId = params.approvedByTelegramId;
  payment.updatedAt = nowISO();

  saveStore(store);

  upsertActiveUser({
    telegramId: payment.telegramId,
    username: payment.username,
    firstName: payment.firstName,
    role: "subscriber",
    expiresAt,
    paymentId: payment.paymentId
  });

  return { ok: true as const, payment, expiresAt };
}

export function rejectPaymentRequest(params: {
  paymentId: string;
  rejectedByTelegramId: string;
  note?: string | undefined;
}) {
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

export function listBetaAccessUsers() {
  return loadStore().users;
}

export function listBetaAccessCodes() {
  return loadStore().codes;
}

export function revokeBetaAccessUser(telegramId: string) {
  const store = loadStore();
  const user = store.users.find((item) => item.telegramId === telegramId);

  if (!user) return null;

  user.status = "revoked";
  user.updatedAt = nowISO();

  saveStore(store);
  return user;
}

export function revokeBetaAccessCode(label: string) {
  const store = loadStore();
  const code = store.codes.find((item) => item.label === label);

  if (!code) return null;

  code.revokedAt = nowISO();

  saveStore(store);
  return code;
}

export function getAccessControlStatus() {
  const store = loadStore();

  return {
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
