import "dotenv/config";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { Context } from "telegraf";
import { Telegraf, Markup } from "telegraf";
import { ethers } from "ethers";
import {
  addWallet,
  listWalletsForOwner,
  getWalletAddressByLabelForOwner,
  getWalletSignerByLabelForOwner
} from "./vault.js";
import { getTelegramUserId, requireAdmin } from "./auth.js";
import { extractOpenSeaSlug, getOpenSeaCollectionStats, getOpenSeaBestOffer, getOpenSeaBestListing, getOpenSeaNft, getOpenSeaNftsByAccount } from "./opensea.js";
import { checkErc721Ownership, createOpenSeaListing, getMainnetProvider, acceptOpenSeaBestOffer } from "./openseaTrading.js";
import { appendSessionAuditLog, appendWalletAuditLog } from "./audit.js";

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN in .env");
}

const bot = new Telegraf(token);

function getSepoliaRpcUrl(): string {
  const rpcUrl = process.env.SEPOLIA_RPC_URL || process.env.ETH_SEPOLIA_RPC_URL;

  if (!rpcUrl) {
    throw new Error("Missing SEPOLIA_RPC_URL or ETH_SEPOLIA_RPC_URL");
  }

  return rpcUrl;
}

function getProvider() {
  return new ethers.JsonRpcProvider(getSepoliaRpcUrl());
}

const provider = getProvider();

function parseCommandParts(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function getCommandPart(parts: string[], index: number): string {
  const part = parts[index]?.trim();

  if (!part) {
    throw new Error("Missing command argument.");
  }

  return part;
}

function getRequiredTelegramUserId(ctx: Context): string {
  const userId = getTelegramUserId(ctx);

  if (!userId) {
    throw new Error("Could not read Telegram user ID from this request.");
  }

  return userId;
}

function redactSensitiveText(text: string): string {
  const sensitiveEnvNames = [
    "AZURE_CLIENT_SECRET",
    "TELEGRAM_BOT_TOKEN",
    "SEPOLIA_RPC_URL",
    "ETH_SEPOLIA_RPC_URL",
    "ETH_MAINNET_RPC_URL",
    "OPENSEA_API_KEY",
    "VAULT_SECRET"
  ];

  let redacted = text;

  for (const name of sensitiveEnvNames) {
    const value = process.env[name];

    if (value && value.length >= 8) {
      redacted = redacted.split(value).join("[REDACTED]");
    }
  }

  return redacted
    .replace(/0x[a-fA-F0-9]{64}/g, "[REDACTED_HEX_SECRET]")
    .replace(
      /([?&](?:api[_-]?key|key|token|secret)=)[^&\s]+/gi,
      "$1[REDACTED]"
    );
}

function getSafeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return redactSensitiveText(
      (error.message.split("\n")[0] || error.message).slice(0, 300)
    );
  }

  return "Unknown error";
}

function logSafeError(context: string, error: unknown) {
  console.error(`${context}: ${getSafeErrorMessage(error)}`);
}

type TelegramWalletImportContext = Context & {
  message: {
    text: string;
  };
};

type ParsedWalletImportRow =
  | {
      type: "wallet";
      rowNumber: number;
      label?: string;
      privateKey: string;
    }
  | {
      type: "skip";
      rowNumber: number;
      reason: string;
    };

type ImportedTelegramWallet = {
  label: string;
  address: string;
};

type SkippedTelegramWallet = {
  rowNumber: number;
  reason: string;
};

const WALLET_IMPORT_LABEL_PATTERN = /^[A-Za-z0-9_-]{2,32}$/;

function isPrivateChat(ctx: Context): boolean {
  return ctx.chat?.type === "private";
}

async function tryDeleteSensitiveTelegramMessage(ctx: Context) {
  try {
    await (ctx as any).deleteMessage();
  } catch {
    // Best effort only. The bot may lack permission or Telegram may reject it.
  }
}

function extractWalletImportPayload(text: string): string {
  return text.trimStart().replace(
    /^\/(?:addwallet|importwallet|import_wallet)(?:@[A-Za-z0-9_]+)?(?:\s+|$)/i,
    ""
  );
}

function normalizeWalletImportLabel(label: string): string {
  return label.trim().toLowerCase();
}

function isValidWalletImportLabel(label: string): boolean {
  return WALLET_IMPORT_LABEL_PATTERN.test(label);
}

function parseWalletImportRows(payload: string): ParsedWalletImportRow[] {
  const rows: ParsedWalletImportRow[] = [];
  let rowNumber = 0;

  for (const rawLine of payload.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line) {
      continue;
    }

    rowNumber += 1;

    const parts = line.split(/\s+/);

    if (parts.length === 1 && parts[0]) {
      rows.push({
        type: "wallet",
        rowNumber,
        privateKey: parts[0]
      });
      continue;
    }

    if (parts.length === 2 && parts[0] && parts[1]) {
      rows.push({
        type: "wallet",
        rowNumber,
        label: parts[0],
        privateKey: parts[1]
      });
      continue;
    }

    rows.push({
      type: "skip",
      rowNumber,
      reason: "Expected privateKey or label privateKey"
    });
  }

  return rows;
}

function getNextAutoWalletLabel(usedLabels: Set<string>): string {
  let index = 1;

  while (usedLabels.has(`wallet${index}`)) {
    index += 1;
  }

  return `wallet${index}`;
}

async function auditTelegramWalletImport(
  ownerTelegramId: string | null,
  action: string,
  details: {
    importedCount?: number;
    skippedCount?: number;
    reason?: string;
  } = {}
) {
  await appendWalletAuditLog({
    ownerTelegramId,
    action,
    ...details
  });
}

function getWalletImportUsageMessage() {
  return `Use one of these formats:

/addwallet walletLabel privateKey

Or:
/addwallet
privateKey1
privateKey2

Or:
/addwallet
wallet1 privateKey1
wallet2 privateKey2`;
}

function buildWalletImportSummary(
  imported: ImportedTelegramWallet[],
  skipped: SkippedTelegramWallet[]
) {
  const title =
    skipped.length === 0
      ? "✅ Wallet import complete."
      : imported.length > 0
        ? "⚠️ Wallet import finished with issues."
        : "❌ Wallet import rejected.";

  const lines = [
    title,
    "",
    `Imported: ${imported.length}`,
    `Skipped: ${skipped.length}`
  ];

  if (imported.length > 0) {
    lines.push("", imported.length === 1 ? "Wallet:" : "Wallets:");

    for (const wallet of imported) {
      lines.push(`- ${wallet.label}: ${wallet.address}`);
    }

    lines.push("", "Your wallets were encrypted with Azure Key Vault.");
  }

  if (skipped.length > 0) {
    lines.push("", "Skipped:");

    for (const skippedRow of skipped) {
      lines.push(`- row ${skippedRow.rowNumber}: ${skippedRow.reason}`);
    }
  }

  return lines.join("\n");
}

async function handleTelegramWalletImport(ctx: TelegramWalletImportContext) {
  await tryDeleteSensitiveTelegramMessage(ctx);

  if (!isPrivateChat(ctx)) {
    await ctx.reply("Wallet import only works in private chat.");
    return;
  }

  if (!(await requireAdmin(ctx))) return;

  const ownerTelegramId = getRequiredTelegramUserId(ctx);

  await ctx.reply(
    "Import received. If Telegram did not remove your private key message automatically, please delete it from your chat history."
  );

  await auditTelegramWalletImport(ownerTelegramId, "wallet_import_from_telegram_started");

  const payload = extractWalletImportPayload(ctx.message.text);
  const rows = parseWalletImportRows(payload);

  if (rows.length === 0) {
    await auditTelegramWalletImport(
      ownerTelegramId,
      "wallet_import_from_telegram_rejected",
      {
        importedCount: 0,
        skippedCount: 0,
        reason: "missing_wallet_rows"
      }
    );
    await ctx.reply(getWalletImportUsageMessage());
    return;
  }

  const existingWallets = await listWalletsForOwner(ownerTelegramId);
  const usedLabels = new Set(
    existingWallets.map((wallet) => normalizeWalletImportLabel(wallet.label))
  );
  const addressToLabel = new Map(
    existingWallets.map((wallet) => [
      wallet.address.toLowerCase(),
      normalizeWalletImportLabel(wallet.label)
    ])
  );
  const imported: ImportedTelegramWallet[] = [];
  const skipped: SkippedTelegramWallet[] = [];

  for (const row of rows) {
    if (row.type === "skip") {
      skipped.push({
        rowNumber: row.rowNumber,
        reason: row.reason
      });
      continue;
    }

    let parsedWallet: ethers.Wallet;

    try {
      parsedWallet = new ethers.Wallet(row.privateKey);
    } catch {
      skipped.push({
        rowNumber: row.rowNumber,
        reason: "Invalid private key"
      });
      continue;
    }

    const walletAddressLower = parsedWallet.address.toLowerCase();
    const existingLabel = addressToLabel.get(walletAddressLower);

    if (existingLabel) {
      skipped.push({
        rowNumber: row.rowNumber,
        reason: `Wallet address already exists under label ${existingLabel}`
      });
      continue;
    }

    const walletLabel = row.label
      ? normalizeWalletImportLabel(row.label)
      : getNextAutoWalletLabel(usedLabels);

    if (!isValidWalletImportLabel(walletLabel)) {
      skipped.push({
        rowNumber: row.rowNumber,
        reason: "Invalid wallet label"
      });
      continue;
    }

    if (usedLabels.has(walletLabel)) {
      skipped.push({
        rowNumber: row.rowNumber,
        reason: "Wallet label already exists"
      });
      continue;
    }

    try {
      const saved = await addWallet(
        walletLabel,
        row.privateKey,
        ownerTelegramId
      );

      imported.push({
        label: saved.label,
        address: saved.address
      });
      usedLabels.add(saved.label);
      addressToLabel.set(saved.address.toLowerCase(), saved.label);
    } catch (error) {
      skipped.push({
        rowNumber: row.rowNumber,
        reason: getSafeErrorMessage(error)
      });
    }
  }

  const auditAction =
    imported.length > 0 && skipped.length === 0
      ? "wallet_import_from_telegram_success"
      : imported.length > 0
        ? "wallet_import_from_telegram_partial"
        : "wallet_import_from_telegram_rejected";

  await auditTelegramWalletImport(ownerTelegramId, auditAction, {
    importedCount: imported.length,
    skippedCount: skipped.length,
    ...(skipped.length > 0
      ? { reason: skipped.map((row) => row.reason).join("; ").slice(0, 500) }
      : {})
  });

  await ctx.reply(buildWalletImportSummary(imported, skipped));
}

function loadTestNftContract() {
  const filePath = path.join(process.cwd(), "data", "testNft.json");

  if (!fs.existsSync(filePath)) {
    throw new Error("Missing data/testNft.json. Deploy the test NFT contract first.");
  }

  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

type MintRecord = {
  ownerTelegramId?: string;
  walletLabel: string;
  walletAddress: string;
  contractAddress: string;
  tokenIds: string[];
  txHash: string;
  quantity: number;
  paidEth: string;
  network: string;
  mintedAt: string;
};

type TestMintContract = ethers.Contract & {
  PRICE: () => Promise<bigint>;
  publicMint: ((quantity: number, overrides: { value: bigint }) => Promise<ethers.ContractTransactionResponse>) & {
    estimateGas: (quantity: number, overrides: { value: bigint }) => Promise<bigint>;
  };
  isApprovedForAll: (owner: string, operator: string) => Promise<boolean>;
  setApprovalForAll: ((operator: string, approved: boolean) => Promise<ethers.ContractTransactionResponse>) & {
    estimateGas: (operator: string, approved: boolean) => Promise<bigint>;
  };
};

type Erc721OwnerContract = ethers.Contract & {
  ownerOf: (tokenId: string) => Promise<string>;
};

const MINTS_PATH = path.join(process.cwd(), "data", "mints.json");

function loadMints(): MintRecord[] {
  if (!fs.existsSync(MINTS_PATH)) {
    return [];
  }

  const raw = fs.readFileSync(MINTS_PATH, "utf8");

  if (!raw.trim()) {
    return [];
  }

  const parsed = JSON.parse(raw);
  return parsed.mints || [];
}

function saveMint(record: MintRecord) {
  const mints = loadMints();
  mints.push(record);

  const dir = path.dirname(MINTS_PATH);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(
    MINTS_PATH,
    JSON.stringify({ mints }, null, 2),
    "utf8"
  );
}

function getMintedTokenIdsFromReceipt(
  receipt: ethers.TransactionReceipt,
  contractInterface: ethers.Interface,
  walletAddress: string
): string[] {
  const tokenIds: string[] = [];

  for (const log of receipt.logs) {
    try {
      const parsed = contractInterface.parseLog({
        topics: log.topics as string[],
        data: log.data
      });

      if (!parsed) {
        continue;
      }

      if (parsed.name !== "Transfer") {
        continue;
      }

      const from = String(parsed.args[0]).toLowerCase();
      const to = String(parsed.args[1]).toLowerCase();
      const tokenId = parsed.args[2].toString();

      const zeroAddress = "0x0000000000000000000000000000000000000000";

      if (from === zeroAddress && to === walletAddress.toLowerCase()) {
        tokenIds.push(tokenId);
      }
    } catch {
      continue;
    }
  }

  return tokenIds;
}


type PostMintActionStatus = "active" | "cancelled" | "used" | "expired";

type PostMintActionSession = {
  sessionId: string;
  ownerTelegramId: string;
  walletLabel: string;
  walletAddress: string;
  collectionSlug: string;
  contractAddress: string;
  tokenId: string;
  network: "ethereum" | "sepolia";
  createdAt: string;
  expiresAt: string;
  status: PostMintActionStatus;
  customPriceEth?: number;
};

type ValidatedPostMintActionSession = {
  action: PostMintActionSession;
  actorTelegramId: string;
};

const POST_MINT_ACTIONS_PATH = path.join(
  process.cwd(),
  "data",
  "postMintActions.json"
);
const POST_MINT_SESSION_TTL_MS = 30 * 60 * 1000;
const ACTION_SESSION_EXPIRED_MESSAGE =
  "This action session has expired. Please open the NFT actions again.";
const ACTION_ALREADY_USED_OR_CANCELLED_MESSAGE =
  "This action has already been used or cancelled.";

function isPostMintActionStatus(value: unknown): value is PostMintActionStatus {
  return (
    value === "active" ||
    value === "cancelled" ||
    value === "used" ||
    value === "expired"
  );
}

function normalizeStoredPostMintAction(raw: any): PostMintActionSession | null {
  const sessionId =
    typeof raw?.sessionId === "string"
      ? raw.sessionId
      : typeof raw?.id === "string"
        ? raw.id
        : null;

  if (!sessionId) {
    return null;
  }

  const createdAt =
    typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString();
  const createdAtMs = Date.parse(createdAt);
  const fallbackExpiresAt = new Date(
    (Number.isFinite(createdAtMs) ? createdAtMs : Date.now()) +
      POST_MINT_SESSION_TTL_MS
  ).toISOString();
  const status = isPostMintActionStatus(raw.status) ? raw.status : "active";
  const customPriceEth =
    typeof raw.customPriceEth === "number" && Number.isFinite(raw.customPriceEth)
      ? raw.customPriceEth
      : undefined;

  return {
    sessionId,
    ownerTelegramId:
      typeof raw.ownerTelegramId === "string" ? raw.ownerTelegramId : "",
    walletLabel: typeof raw.walletLabel === "string" ? raw.walletLabel : "",
    walletAddress:
      typeof raw.walletAddress === "string" ? raw.walletAddress : "",
    collectionSlug:
      typeof raw.collectionSlug === "string" ? raw.collectionSlug : "",
    contractAddress:
      typeof raw.contractAddress === "string" ? raw.contractAddress : "",
    tokenId: typeof raw.tokenId === "string" ? raw.tokenId : "",
    network: raw.network === "sepolia" ? "sepolia" : "ethereum",
    createdAt,
    expiresAt:
      typeof raw.expiresAt === "string" ? raw.expiresAt : fallbackExpiresAt,
    status,
    ...(customPriceEth === undefined ? {} : { customPriceEth })
  };
}

function isPostMintActionExpired(action: PostMintActionSession): boolean {
  const expiresAtMs = Date.parse(action.expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now();
}

function writePostMintActions(actions: PostMintActionSession[]) {
  const dir = path.dirname(POST_MINT_ACTIONS_PATH);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(
    POST_MINT_ACTIONS_PATH,
    JSON.stringify({ actions }, null, 2),
    "utf8"
  );
}

function loadPostMintActions(): PostMintActionSession[] {
  if (!fs.existsSync(POST_MINT_ACTIONS_PATH)) {
    return [];
  }

  const raw = fs.readFileSync(POST_MINT_ACTIONS_PATH, "utf8");

  if (!raw.trim()) {
    return [];
  }

  const parsed = JSON.parse(raw);
  const rawActions: any[] = Array.isArray(parsed.actions) ? parsed.actions : [];
  const actions = rawActions
    .map(normalizeStoredPostMintAction)
    .filter((action): action is PostMintActionSession => Boolean(action));

  let changed = actions.length !== rawActions.length;

  for (const action of actions) {
    if (action.status === "active" && isPostMintActionExpired(action)) {
      action.status = "expired";
      changed = true;
    }
  }

  if (changed) {
    writePostMintActions(actions);
  }

  return actions;
}

function savePostMintAction(action: PostMintActionSession) {
  const actions = loadPostMintActions();
  actions.push(action);
  writePostMintActions(actions);
}

function updatePostMintActionSession(updated: PostMintActionSession) {
  const actions = loadPostMintActions();
  const index = actions.findIndex(
    (action) => action.sessionId === updated.sessionId
  );

  if (index === -1) {
    actions.push(updated);
  } else {
    actions[index] = updated;
  }

  writePostMintActions(actions);
}

async function auditPostMintSession(
  action: PostMintActionSession,
  auditAction: string,
  actorTelegramId: string | null,
  reason?: string
) {
  await appendSessionAuditLog({
    sessionId: action.sessionId,
    ownerTelegramId: action.ownerTelegramId || null,
    actorTelegramId,
    walletLabel: action.walletLabel,
    walletAddress: action.walletAddress,
    collectionSlug: action.collectionSlug,
    contractAddress: action.contractAddress,
    tokenId: action.tokenId,
    action: auditAction,
    status: action.status,
    ...(reason ? { reason } : {})
  });
}

async function createPostMintActionSession(params: {
  ownerTelegramId: string;
  walletLabel: string;
  walletAddress: string;
  collectionSlug: string;
  contractAddress: string;
  tokenId: string;
  network?: "ethereum" | "sepolia";
}) {
  const createdAt = new Date();
  const action: PostMintActionSession = {
    sessionId: randomUUID(),
    ownerTelegramId: params.ownerTelegramId,
    walletLabel: params.walletLabel,
    walletAddress: params.walletAddress,
    collectionSlug: params.collectionSlug,
    contractAddress: params.contractAddress,
    tokenId: params.tokenId,
    network: params.network || "ethereum",
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(
      createdAt.getTime() + POST_MINT_SESSION_TTL_MS
    ).toISOString(),
    status: "active"
  };

  savePostMintAction(action);
  await auditPostMintSession(action, "session.created", params.ownerTelegramId);
  return action;
}

function getPostMintActionSession(id: string) {
  const actions = loadPostMintActions();
  return actions.find((action) => action.sessionId === id) || null;
}

async function validatePostMintActionSession(
  ctx: Context,
  sessionId: string,
  actionName: string,
  options: { finalAction?: boolean } = {}
): Promise<ValidatedPostMintActionSession | null> {
  const actorTelegramId = getTelegramUserId(ctx);

  if (!actorTelegramId) {
    await ctx.reply("❌ Could not verify your Telegram account for this action.");
    return null;
  }

  const action = getPostMintActionSession(sessionId);

  if (!action) {
    await ctx.reply("❌ This post-mint session was not found.");
    return null;
  }

  if (!action.ownerTelegramId || !action.walletAddress) {
    action.status = "expired";
    updatePostMintActionSession(action);
    await auditPostMintSession(
      action,
      options.finalAction
        ? "final_action.blocked_expired"
        : "session.expired_rejected",
      actorTelegramId,
      `${actionName}:missing_owner_scope`
    );
    await ctx.reply(ACTION_SESSION_EXPIRED_MESSAGE);
    return null;
  }

  if (action.ownerTelegramId !== actorTelegramId) {
    await auditPostMintSession(
      action,
      options.finalAction
        ? "final_action.blocked_wrong_user"
        : "session_action.blocked_wrong_user",
      actorTelegramId,
      actionName
    );
    await ctx.reply("❌ This action is not available for your Telegram account.");
    return null;
  }

  if (action.status === "expired" || isPostMintActionExpired(action)) {
    action.status = "expired";
    updatePostMintActionSession(action);
    await auditPostMintSession(
      action,
      options.finalAction
        ? "final_action.blocked_expired"
        : "session.expired_rejected",
      actorTelegramId,
      actionName
    );
    await ctx.reply(ACTION_SESSION_EXPIRED_MESSAGE);
    return null;
  }

  if (action.status === "used" || action.status === "cancelled") {
    await auditPostMintSession(
      action,
      options.finalAction
        ? "final_action.blocked_already_used"
        : "session_action.blocked_already_used",
      actorTelegramId,
      actionName
    );
    await ctx.reply(ACTION_ALREADY_USED_OR_CANCELLED_MESSAGE);
    return null;
  }

  return { action, actorTelegramId };
}

async function markPostMintActionStatus(
  action: PostMintActionSession,
  actorTelegramId: string,
  status: PostMintActionStatus,
  auditAction: string,
  reason?: string
) {
  const updated = {
    ...action,
    status
  };

  updatePostMintActionSession(updated);
  await auditPostMintSession(updated, auditAction, actorTelegramId, reason);

  return updated;
}

function setPostMintCustomPrice(
  action: PostMintActionSession,
  priceEth: number
) {
  const updated = {
    ...action,
    customPriceEth: priceEth
  };

  updatePostMintActionSession(updated);
  return updated;
}

async function sendPostMintActionMenu(ctx: any, action: PostMintActionSession) {
  await ctx.reply(
    `🎉 Post-Mint Actions

Wallet: ${action.walletLabel}
Collection: ${action.collectionSlug}
Contract: ${action.contractAddress}
Token ID: ${action.tokenId}
Network: ${action.network}
Expires: ${action.expiresAt}

Choose what you want to do next:`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🖼 View NFT", `pm:view:${action.sessionId}`)],
      [Markup.button.callback("📊 Floor / Best Listing", `pm:floor:${action.sessionId}`)],
      [Markup.button.callback("💰 Top Offer", `pm:offer:${action.sessionId}`)],
      [Markup.button.callback("🚨 Accept Top Offer", `pm:acceptofferpreview:${action.sessionId}`)],
      [Markup.button.callback("🏷 List at Floor Preview", `pm:listfloor:${action.sessionId}`)],
      [Markup.button.callback("✅ Confirm Floor Listing", `pm:floorconfirmpreview:${action.sessionId}`)],
      [Markup.button.callback("✍️ Custom List Preview", `pm:custom:${action.sessionId}`)],
      [Markup.button.callback("🧊 Hold", `pm:hold:${action.sessionId}`)]
    ])
  );
}

bot.command("whoami", async (ctx) => {
  const userId = getTelegramUserId(ctx);

  await ctx.reply(
    `Your Telegram user ID is:

${userId}

Add this to your .env:

ADMIN_TELEGRAM_ID=${userId}`
  );
});

bot.start(async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.reply(
    `🔥 Welcome to the NFT Mint Bot MVP

What can this bot do?
• Store burner wallets in encrypted vault
• Check wallet balances
• Mint test NFTs on Sepolia
• Detect minted token IDs
• Track mint transactions

Choose an option below:`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🧾 Subscribe", "subscribe")],
      [Markup.button.callback("🎟 I have a code", "code")],
      [Markup.button.callback("⚙️ Wallet Status", "wallet_status")],
      [Markup.button.callback("🚀 Test Mint", "test_mint")],
      [Markup.button.callback("🖼 My NFTs", "my_nfts")],
      [Markup.button.callback("📦 OpenSea Portfolio", "os_portfolio_help")],
      [Markup.button.callback("✅ Approval", "approval_help")],
      [Markup.button.callback("🌊 OpenSea Floor", "opensea_help")]
    ])
  );
});

bot.action("subscribe", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();
  await ctx.reply(
    `🔒 Subscribe to unlock Mint Bot

MVP tiers:
• Daily — test only
• 2 Weeks — test only
• Monthly — test only

Payment system comes later. For now, we’ll use manual access codes.`
  );
});

bot.action("code", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();
  await ctx.reply("Send your access code like this:\n\n/code YOUR-CODE-HERE");
});

bot.command("code", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const code = parseCommandParts(ctx.message.text)[1];

  if (!code) {
    await ctx.reply("Please send a code like this:\n\n/code YOUR-CODE-HERE");
    return;
  }

  if (code === "TEST123") {
    await ctx.reply("✅ Access unlocked. You can now use the bot MVP.");
  } else {
    await ctx.reply("❌ Invalid code.");
  }
});

for (const command of ["addwallet", "importwallet", "import_wallet"]) {
  bot.command(command, async (ctx) => {
    await handleTelegramWalletImport(ctx as TelegramWalletImportContext);
  });
}

bot.action("wallet_status", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const wallets = await listWalletsForOwner(ownerTelegramId);

    if (wallets.length === 0) {
      await ctx.reply(
        `❌ No wallets found.

Add one first from Terminal:

Use /addwallet in private chat, or:

npm run wallet:add`
      );
      return;
    }

    let message = `⚙️ Wallet Status\n\nNetwork: Sepolia Testnet\n\n`;

    for (const savedWallet of wallets) {
      const balanceWei = await provider.getBalance(savedWallet.address);
      const balanceEth = ethers.formatEther(balanceWei);

      message += `👛 ${savedWallet.label}\n`;
      message += `Address: ${savedWallet.address}\n`;
      message += `Balance: ${balanceEth} ETH\n\n`;
    }

    message += `✅ Wallet vault loaded.`;

    await ctx.reply(message);
  } catch (error) {
    logSafeError("Could not load wallet status", error);
    await ctx.reply("❌ Could not load wallet status. Check Terminal for the error.");
  }
});

bot.command("wallets", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const wallets = await listWalletsForOwner(ownerTelegramId);

    if (wallets.length === 0) {
      await ctx.reply(
        "No wallets found. Add one with /addwallet in private chat, or:\n\nnpm run wallet:add"
      );
      return;
    }

    const message = wallets
      .map((wallet) => `👛 ${wallet.label}\n${wallet.address}`)
      .join("\n\n");

    await ctx.reply(`Saved wallets:\n\n${message}`);
  } catch (error) {
    logSafeError("Could not list wallets", error);
    await ctx.reply("❌ Could not list wallets.");
  }
});

bot.action("test_mint", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();
  await ctx.reply(
    `🚀 Test Mint

Use this command:

/minttest wallet1 1

Format:
/minttest walletLabel quantity

Example:
/minttest wallet1 1`
  );
});

bot.command("minttest", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = parseCommandParts(ctx.message.text);

  if (parts.length < 3) {
    await ctx.reply(
      `Invalid format.

Use:
/minttest wallet1 1`
    );
    return;
  }

  const walletLabel = getCommandPart(parts, 1);
  const quantityRaw = getCommandPart(parts, 2);
  const quantity = Number(quantityRaw);

  if (!Number.isInteger(quantity) || quantity <= 0) {
    await ctx.reply("❌ Quantity must be a whole number greater than 0.");
    return;
  }

  if (quantity > 5) {
    await ctx.reply("❌ This test contract allows max 5 NFTs per transaction.");
    return;
  }

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const testNft = loadTestNftContract();
    const wallet = await getWalletSignerByLabelForOwner(
      walletLabel,
      ownerTelegramId,
      provider,
      "minttest"
    );

    const contract = new ethers.Contract(
      testNft.contractAddress,
      testNft.abi,
      wallet
    ) as unknown as TestMintContract;

    const priceWei: bigint = await contract.PRICE();
    const totalCostWei = priceWei * BigInt(quantity);
    const totalCostEth = ethers.formatEther(totalCostWei);

    await ctx.reply(
      `🔥 Prepping mint...

Network: Sepolia
Wallet: ${walletLabel}
Address: ${wallet.address}
Contract: ${testNft.contractAddress}
Qty: ${quantity}
Mint cost: ${totalCostEth} ETH

Estimating gas...`
    );

    const gasEstimate = await contract.publicMint.estimateGas(quantity, {
      value: totalCostWei
    });

    await ctx.reply(
      `⛽ Gas estimated: ${gasEstimate.toString()}

⚡ Sending mint transaction now...`
    );

    const tx = await contract.publicMint(quantity, {
      value: totalCostWei
    });

    await ctx.reply(
      `✅ Mint transaction sent.

Tx:
${tx.hash}`
    );

    let receipt: ethers.TransactionReceipt | null;

    try {
      receipt = await tx.wait();
    } catch (confirmationError) {
      logSafeError("Mint confirmation wait failed", confirmationError);

      await ctx.reply(
        `⚠️ Mint transaction was sent, but confirmation could not be verified yet.

Tx:
${tx.hash}

Reason:
${getSafeErrorMessage(confirmationError)}`
      );
      return;
    }

    if (receipt?.status === 1) {
      const contractInterface = new ethers.Interface(testNft.abi);

      const tokenIds = getMintedTokenIdsFromReceipt(
        receipt,
        contractInterface,
        wallet.address
      );

      saveMint({
        ownerTelegramId,
        walletLabel,
        walletAddress: wallet.address,
        contractAddress: testNft.contractAddress,
        tokenIds,
        txHash: tx.hash,
        quantity,
        paidEth: totalCostEth,
        network: "sepolia",
        mintedAt: new Date().toISOString()
      });

      const tokenText =
        tokenIds.length > 0
          ? tokenIds.map((id) => `#${id}`).join(", ")
          : "Could not detect token ID";

      await ctx.reply(
        `✅ Minted successfully!

Wallet: ${walletLabel}
Qty: ${quantity}
Token ID(s): ${tokenText}
Paid: ${totalCostEth} ETH
Tx:
${tx.hash}

Saved to local mint history.

Next command:
/nfts ${walletLabel}`
      );
    } else {
      await ctx.reply(
        `❌ Transaction failed.

Tx:
${tx.hash}`
      );
    }
  } catch (error: any) {
    logSafeError("Mint failed", error);

    const errorMessage =
      error?.shortMessage ||
      error?.reason ||
      error?.message ||
      "Unknown mint error";

    await ctx.reply(
      `❌ Mint failed.

Reason:
${errorMessage}`
    );
  }
});

bot.action("my_nfts", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();
  await ctx.reply(
    `🖼 My NFTs

Use this command:

/nfts wallet1

Example:
/nfts wallet1`
  );
});

bot.command("nfts", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = parseCommandParts(ctx.message.text);
  const walletLabel = parts[1]?.trim().toLowerCase();

  if (!walletLabel) {
    await ctx.reply(
      `Invalid format.

Use:
/nfts wallet1`
    );
    return;
  }

  let walletAddress: string;

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    walletAddress = await getWalletAddressByLabelForOwner(
      walletLabel,
      ownerTelegramId
    );

    const walletAddressLower = walletAddress.toLowerCase();
    const mints = loadMints().filter(
      (mint) =>
        mint.walletLabel.toLowerCase() === walletLabel &&
        (mint.ownerTelegramId === ownerTelegramId ||
          (!mint.ownerTelegramId &&
            mint.walletAddress.toLowerCase() === walletAddressLower))
    );

    if (mints.length === 0) {
      await ctx.reply(`No minted NFTs found for "${walletLabel}" yet.`);
      return;
    }

    let message = `🖼 NFTs for ${walletLabel}\n\n`;

    for (const mint of mints) {
      const tokenText =
        mint.tokenIds.length > 0
          ? mint.tokenIds.map((id) => `#${id}`).join(", ")
          : "Unknown token ID";

      message += `Contract: ${mint.contractAddress}\n`;
      message += `Token ID(s): ${tokenText}\n`;
      message += `Qty: ${mint.quantity}\n`;
      message += `Paid: ${mint.paidEth} ETH\n`;
      message += `Tx: ${mint.txHash}\n\n`;
    }

    await ctx.reply(message);
  } catch (error: any) {
    logSafeError("Could not list minted NFTs", error);

    await ctx.reply(
      `❌ Could not load NFTs for this wallet.

Reason:
${error?.message || "Unknown error"}`
    );
  }
});


bot.action("approval_help", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();
  await ctx.reply(
    `✅ Approval Module

Approval lets another contract/operator move NFTs from your wallet.

For testnet, use:

/approvalstatus wallet1 0xOperatorAddress

/approveall wallet1 0xOperatorAddress

/revokeall wallet1 0xOperatorAddress

Example test operator:
/approveall wallet1 0x0000000000000000000000000000000000000001

Important:
Only approve trusted marketplace/operator contracts on mainnet.`
  );
});

bot.command("approvalstatus", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = parseCommandParts(ctx.message.text);

  if (parts.length < 3) {
    await ctx.reply(
      `Invalid format.

Use:
/approvalstatus wallet1 0xOperatorAddress`
    );
    return;
  }

  const walletLabel = getCommandPart(parts, 1);
  const operator = getCommandPart(parts, 2);

  if (!ethers.isAddress(operator)) {
    await ctx.reply("❌ Invalid operator address.");
    return;
  }

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const testNft = loadTestNftContract();
    const walletAddress = await getWalletAddressByLabelForOwner(
      walletLabel,
      ownerTelegramId
    );

    const contract = new ethers.Contract(
      testNft.contractAddress,
      testNft.abi,
      provider
    ) as unknown as TestMintContract;

    const approved: boolean = await contract.isApprovedForAll(
      walletAddress,
      operator
    );

    await ctx.reply(
      `✅ Approval Status

Network: Sepolia
Wallet: ${walletLabel}
Wallet Address: ${walletAddress}
NFT Contract: ${testNft.contractAddress}
Operator: ${operator}

Approved: ${approved ? "YES ✅" : "NO ❌"}`
    );
  } catch (error: any) {
    logSafeError("Could not check approval", error);

    await ctx.reply(
      `❌ Could not check approval.

Reason:
${error?.shortMessage || error?.message || "Unknown error"}`
    );
  }
});

bot.command("approveall", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = parseCommandParts(ctx.message.text);

  if (parts.length < 3) {
    await ctx.reply(
      `Invalid format.

Use:
/approveall wallet1 0xOperatorAddress`
    );
    return;
  }

  const walletLabel = getCommandPart(parts, 1);
  const operator = getCommandPart(parts, 2);

  if (!ethers.isAddress(operator)) {
    await ctx.reply("❌ Invalid operator address.");
    return;
  }

  if (operator.toLowerCase() === ethers.ZeroAddress.toLowerCase()) {
    await ctx.reply("❌ Operator cannot be the zero address.");
    return;
  }

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const testNft = loadTestNftContract();
    const wallet = await getWalletSignerByLabelForOwner(
      walletLabel,
      ownerTelegramId,
      provider,
      "approveall"
    );

    const contract = new ethers.Contract(
      testNft.contractAddress,
      testNft.abi,
      wallet
    ) as unknown as TestMintContract;

    const alreadyApproved: boolean = await contract.isApprovedForAll(
      wallet.address,
      operator
    );

    if (alreadyApproved) {
      await ctx.reply(
        `✅ Already approved.

Wallet: ${walletLabel}
Operator: ${operator}`
      );
      return;
    }

    await ctx.reply(
      `✅ Prepping approval...

Network: Sepolia
Wallet: ${walletLabel}
Wallet Address: ${wallet.address}
NFT Contract: ${testNft.contractAddress}
Operator: ${operator}

Estimating gas...`
    );

    const gasEstimate = await contract.setApprovalForAll.estimateGas(
      operator,
      true
    );

    await ctx.reply(
      `⛽ Gas estimated: ${gasEstimate.toString()}

⚡ Sending approval transaction...`
    );

    const tx = await contract.setApprovalForAll(operator, true);

    await ctx.reply(
      `⏳ Approval transaction sent.

Tx:
${tx.hash}

Waiting for confirmation...`
    );

    const receipt = await tx.wait();

    if (receipt?.status === 1) {
      await ctx.reply(
        `✅ Approval successful!

Wallet: ${walletLabel}
NFT Contract: ${testNft.contractAddress}
Operator: ${operator}

Tx:
${tx.hash}

Next command:
/approvalstatus ${walletLabel} ${operator}`
      );
    } else {
      await ctx.reply(
        `❌ Approval transaction failed.

Tx:
${tx.hash}`
      );
    }
  } catch (error: any) {
    logSafeError("Approval failed", error);

    await ctx.reply(
      `❌ Approval failed.

Reason:
${error?.shortMessage || error?.reason || error?.message || "Unknown error"}`
    );
  }
});

bot.command("revokeall", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = parseCommandParts(ctx.message.text);

  if (parts.length < 3) {
    await ctx.reply(
      `Invalid format.

Use:
/revokeall wallet1 0xOperatorAddress`
    );
    return;
  }

  const walletLabel = getCommandPart(parts, 1);
  const operator = getCommandPart(parts, 2);

  if (!ethers.isAddress(operator)) {
    await ctx.reply("❌ Invalid operator address.");
    return;
  }

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const testNft = loadTestNftContract();
    const wallet = await getWalletSignerByLabelForOwner(
      walletLabel,
      ownerTelegramId,
      provider,
      "revokeall"
    );

    const contract = new ethers.Contract(
      testNft.contractAddress,
      testNft.abi,
      wallet
    ) as unknown as TestMintContract;

    await ctx.reply(
      `🧹 Prepping approval revoke...

Network: Sepolia
Wallet: ${walletLabel}
NFT Contract: ${testNft.contractAddress}
Operator: ${operator}

Sending revoke transaction...`
    );

    const tx = await contract.setApprovalForAll(operator, false);

    await ctx.reply(
      `⏳ Revoke transaction sent.

Tx:
${tx.hash}

Waiting for confirmation...`
    );

    const receipt = await tx.wait();

    if (receipt?.status === 1) {
      await ctx.reply(
        `✅ Approval revoked!

Wallet: ${walletLabel}
Operator: ${operator}

Tx:
${tx.hash}`
      );
    } else {
      await ctx.reply(
        `❌ Revoke transaction failed.

Tx:
${tx.hash}`
      );
    }
  } catch (error: any) {
    logSafeError("Approval revoke failed", error);

    await ctx.reply(
      `❌ Revoke failed.

Reason:
${error?.shortMessage || error?.reason || error?.message || "Unknown error"}`
    );
  }
});



bot.action("opensea_help", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();
  await ctx.reply(
    `🌊 OpenSea Module

Check collection floor/stats:

/osfloor collection-slug

Or paste an OpenSea collection URL:

/osfloor https://opensea.io/collection/example/overview

Example:
/osfloor doodles-official`
  );
});

bot.command("osfloor", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const input = ctx.message.text.replace("/osfloor", "").trim();

  if (!input) {
    await ctx.reply(
      `Invalid format.

Use:
/osfloor collection-slug

Or:
/osfloor https://opensea.io/collection/example/overview`
    );
    return;
  }

  try {
    const slug = extractOpenSeaSlug(input);

    await ctx.reply(
      `🌊 Checking OpenSea stats...

Collection slug: ${slug}`
    );

    const stats = await getOpenSeaCollectionStats(slug);

    const floorText =
      stats.floorPrice === null
        ? "Not available"
        : `${stats.floorPrice} ${stats.floorSymbol || "ETH"}`;

    const volumeText =
      stats.volume === null ? "Not available" : String(stats.volume);

    const salesText =
      stats.sales === null ? "Not available" : String(stats.sales);

    const ownersText =
      stats.owners === null ? "Not available" : String(stats.owners);

    const averageText =
      stats.averagePrice === null ? "Not available" : String(stats.averagePrice);

    await ctx.reply(
      `🌊 OpenSea Collection Stats

Slug: ${stats.slug}
Floor: ${floorText}
Volume: ${volumeText}
Sales: ${salesText}
Owners: ${ownersText}
Average Price: ${averageText}

Next later:
• Detect top offer
• List NFT at floor
• Custom listing price
• Accept top offer`
    );
  } catch (error: any) {
    logSafeError("Bot handler failed", error);

    await ctx.reply(
      `❌ Could not fetch OpenSea floor.

Reason:
${error?.message || "Unknown OpenSea error"}`
    );
  }
});



bot.command("topoffer", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const raw = ctx.message.text.replace("/topoffer", "").trim();
  const parts = parseCommandParts(raw);

  if (parts.length < 2) {
    await ctx.reply(
      `Invalid format.

Use:
/topoffer collection-slug tokenId

Or:
/topoffer https://opensea.io/collection/example/overview tokenId

Example:
/topoffer doodles-official 1234`
    );
    return;
  }

  const collectionInput = getCommandPart(parts, 0);
  const tokenId = getCommandPart(parts, 1);

  try {
    const slug = extractOpenSeaSlug(collectionInput);

    await ctx.reply(
      `🔎 Checking best OpenSea offer...

Collection: ${slug}
Token ID: ${tokenId}`
    );

    const bestOffer = await getOpenSeaBestOffer(slug, tokenId);

    if (!bestOffer.hasOffer) {
      await ctx.reply(
        `❌ No top offer found.

Collection: ${slug}
Token ID: ${tokenId}

Reason:
${bestOffer.reason}`
      );
      return;
    }

    await ctx.reply(
      `💰 Top Offer Found

Collection: ${bestOffer.slug}
Token ID: ${bestOffer.tokenId}
Offer: ${bestOffer.amount} ${bestOffer.symbol}

Order Hash:
${bestOffer.orderHash}

Protocol:
${bestOffer.protocolAddress}

Next later:
• Ask if you want to accept offer
• Generate fulfillment data
• Send accept-offer transaction`
    );
  } catch (error: any) {
    logSafeError("Bot handler failed", error);

    await ctx.reply(
      `❌ Could not fetch top offer.

Reason:
${error?.message || "Unknown OpenSea error"}`
    );
  }
});



bot.command("bestlisting", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const raw = ctx.message.text.replace("/bestlisting", "").trim();
  const parts = parseCommandParts(raw);

  if (parts.length < 2) {
    await ctx.reply(
      `Invalid format.

Use:
/bestlisting collection-slug tokenId

Or:
/bestlisting https://opensea.io/collection/example/overview tokenId

Example:
/bestlisting doodles-official 1`
    );
    return;
  }

  const collectionInput = getCommandPart(parts, 0);
  const tokenId = getCommandPart(parts, 1);

  try {
    const slug = extractOpenSeaSlug(collectionInput);

    await ctx.reply(
      `🔎 Checking best OpenSea listing...

Collection: ${slug}
Token ID: ${tokenId}`
    );

    const bestListing = await getOpenSeaBestListing(slug, tokenId);

    if (!bestListing.hasListing) {
      await ctx.reply(
        `❌ No active listing found.

Collection: ${slug}
Token ID: ${tokenId}

Reason:
${bestListing.reason}`
      );
      return;
    }

    await ctx.reply(
      `🏷 Best Listing Found

Collection: ${bestListing.slug}
Token ID: ${bestListing.tokenId}
Price: ${bestListing.amount} ${bestListing.symbol}

Order Hash:
${bestListing.orderHash}

Protocol:
${bestListing.protocolAddress}

Next:
• Create listing command
• List at floor
• List at custom price`
    );
  } catch (error: any) {
    logSafeError("Bot handler failed", error);

    await ctx.reply(
      `❌ Could not fetch best listing.

Reason:
${error?.message || "Unknown OpenSea error"}`
    );
  }
});



bot.command("oslistpreview", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = parseCommandParts(ctx.message.text);

  if (parts.length < 5) {
    await ctx.reply(
      `Invalid format.

Use:
/oslistpreview wallet1 0xContractAddress tokenId priceETH

Example:
/oslistpreview wallet1 0x1234... 1 0.05`
    );
    return;
  }

  const walletLabel = getCommandPart(parts, 1);
  const contractAddress = getCommandPart(parts, 2);
  const tokenId = getCommandPart(parts, 3);
  const priceRaw = getCommandPart(parts, 4);
  const priceEth = Number(priceRaw);

  if (!ethers.isAddress(contractAddress)) {
    await ctx.reply("❌ Invalid contract address.");
    return;
  }

  if (!Number.isFinite(priceEth) || priceEth <= 0) {
    await ctx.reply("❌ Price must be a number greater than 0.");
    return;
  }

  try {
    await ctx.reply(
      `🏷 Preparing OpenSea listing preview...

Wallet: ${walletLabel}
Contract: ${contractAddress}
Token ID: ${tokenId}
Price: ${priceEth} ETH

Checking ownership on Ethereum mainnet...`
    );

    const ownership = await checkErc721Ownership({
      walletLabel,
      ownerTelegramId: getRequiredTelegramUserId(ctx),
      contractAddress,
      tokenId
    });

    await ctx.reply(
      `🏷 Listing Preview

Network: Ethereum Mainnet
Wallet: ${walletLabel}
Wallet Address: ${ownership.walletAddress}
Contract: ${contractAddress}
Token ID: ${tokenId}
Owner Onchain: ${ownership.owner}
Wallet Owns Token: ${ownership.ownsToken ? "YES ✅" : "NO ❌"}
Listing Price: ${priceEth} ETH

Live listing is currently locked by:

ALLOW_MAINNET_TRADING=false

When ready, use:
/oslist ${walletLabel} ${contractAddress} ${tokenId} ${priceEth}`
    );
  } catch (error: any) {
    logSafeError("Bot handler failed", error);

    await ctx.reply(
      `❌ Listing preview failed.

Reason:
${error?.message || "Unknown error"}`
    );
  }
});

bot.command("oslist", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = parseCommandParts(ctx.message.text);

  if (parts.length < 5) {
    await ctx.reply(
      `Invalid format.

Use:
/oslist wallet1 0xContractAddress tokenId priceETH

Example:
/oslist wallet1 0x1234... 1 0.05`
    );
    return;
  }

  const walletLabel = getCommandPart(parts, 1);
  const contractAddress = getCommandPart(parts, 2);
  const tokenId = getCommandPart(parts, 3);
  const priceRaw = getCommandPart(parts, 4);
  const priceEth = Number(priceRaw);

  if (!ethers.isAddress(contractAddress)) {
    await ctx.reply("❌ Invalid contract address.");
    return;
  }

  if (!Number.isFinite(priceEth) || priceEth <= 0) {
    await ctx.reply("❌ Price must be a number greater than 0.");
    return;
  }

  try {
    await ctx.reply(
      `⚠️ Live OpenSea Listing Request

Wallet: ${walletLabel}
Contract: ${contractAddress}
Token ID: ${tokenId}
Price: ${priceEth} ETH

Submitting to OpenSea...`
    );

    const result = await createOpenSeaListing({
      walletLabel,
      ownerTelegramId: getRequiredTelegramUserId(ctx),
      contractAddress,
      tokenId,
      priceEth
    });

    await ctx.reply(
      `✅ OpenSea listing created!

Wallet: ${result.wallet}
Contract: ${result.contractAddress}
Token ID: ${result.tokenId}
Price: ${result.priceEth} ETH

OpenSea SDK response:
${JSON.stringify(result.listing, null, 2).slice(0, 2500)}`
    );
  } catch (error: any) {
    logSafeError("Bot handler failed", error);

    await ctx.reply(
      `❌ OpenSea listing failed.

Reason:
${error?.message || "Unknown error"}

For safety, live trading stays disabled until:
ALLOW_MAINNET_TRADING=true`
    );
  }
});



bot.command("osnft", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = parseCommandParts(ctx.message.text);

  if (parts.length < 3) {
    await ctx.reply(
      `Invalid format.

Use:
/osnft 0xContractAddress tokenId

Example:
/osnft 0x9c890D7e4d9beCb20f7b612D5Df3c4157a0837dC 9455`
    );
    return;
  }

  const contractAddress = getCommandPart(parts, 1);
  const tokenId = getCommandPart(parts, 2);

  if (!ethers.isAddress(contractAddress)) {
    await ctx.reply("❌ Invalid contract address.");
    return;
  }

  try {
    await ctx.reply(
      `🔎 Fetching NFT from OpenSea...

Chain: Ethereum
Contract: ${contractAddress}
Token ID: ${tokenId}`
    );

    const nft = await getOpenSeaNft({
      chain: "ethereum",
      contractAddress,
      tokenId
    });

    let onchainOwner = "Could not read ownerOf";

    try {
      const mainnetProvider = getMainnetProvider();
      const erc721 = new ethers.Contract(
        contractAddress,
        ["function ownerOf(uint256 tokenId) view returns (address)"],
        mainnetProvider
      ) as unknown as Erc721OwnerContract;

      onchainOwner = await erc721.ownerOf(tokenId);
    } catch {
      onchainOwner = "Could not read ownerOf. It may be ERC1155 or a custom contract.";
    }

    const slugText = nft.collectionSlug || "Could not detect slug";

    await ctx.reply(
      `🖼 NFT Lookup Result

Name: ${nft.name}
Collection Slug: ${slugText}
Contract: ${nft.contractAddress}
Token ID: ${nft.tokenId}
Standard: ${nft.tokenStandard}
Owner Onchain: ${onchainOwner}

Useful next commands:

/bestlisting ${slugText} ${tokenId}

/topoffer ${slugText} ${tokenId}

/oslistpreview wallet1 ${contractAddress} ${tokenId} 0.01`
    );
  } catch (error: any) {
    logSafeError("Bot handler failed", error);

    await ctx.reply(
      `❌ NFT lookup failed.

Reason:
${error?.message || "Unknown OpenSea error"}`
    );
  }
});



bot.command("listfloorpreview", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = parseCommandParts(ctx.message.text);

  if (parts.length < 5) {
    await ctx.reply(
      `Invalid format.

Use:
/listfloorpreview wallet1 collectionSlug contractAddress tokenId

Example:
/listfloorpreview wallet1 whackywhales 0x9c890D7e4d9beCb20f7b612D5Df3c4157a0837dC 9455`
    );
    return;
  }

  const walletLabel = getCommandPart(parts, 1);
  const collectionInput = getCommandPart(parts, 2);
  const contractAddress = getCommandPart(parts, 3);
  const tokenId = getCommandPart(parts, 4);

  if (!ethers.isAddress(contractAddress)) {
    await ctx.reply("❌ Invalid contract address.");
    return;
  }

  try {
    const slug = extractOpenSeaSlug(collectionInput);

    await ctx.reply(
      `🏷 Preparing floor listing preview...

Wallet: ${walletLabel}
Collection: ${slug}
Contract: ${contractAddress}
Token ID: ${tokenId}

Fetching floor price and checking ownership...`
    );

    const stats = await getOpenSeaCollectionStats(slug);

    if (stats.floorPrice === null) {
      await ctx.reply(
        `❌ Could not detect floor price for ${slug}.

Try:
/osfloor ${slug}`
      );
      return;
    }

    const ownership = await checkErc721Ownership({
      walletLabel,
      ownerTelegramId: getRequiredTelegramUserId(ctx),
      contractAddress,
      tokenId
    });

    await ctx.reply(
      `🏷 Floor Listing Preview

Network: Ethereum Mainnet
Collection: ${slug}
Floor Price: ${stats.floorPrice} ${stats.floorSymbol || "ETH"}

Wallet: ${walletLabel}
Wallet Address: ${ownership.walletAddress}
Contract: ${contractAddress}
Token ID: ${tokenId}
Owner Onchain: ${ownership.owner}
Wallet Owns Token: ${ownership.ownsToken ? "YES ✅" : "NO ❌"}

Suggested Listing Price:
${stats.floorPrice} ETH

Live listing is still locked by:
ALLOW_MAINNET_TRADING=false

When ready, use:
/listfloor ${walletLabel} ${slug} ${contractAddress} ${tokenId}`
    );
  } catch (error: any) {
    logSafeError("Bot handler failed", error);

    await ctx.reply(
      `❌ Floor listing preview failed.

Reason:
${error?.message || "Unknown error"}`
    );
  }
});

bot.command("listfloor", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = parseCommandParts(ctx.message.text);

  if (parts.length < 5) {
    await ctx.reply(
      `Invalid format.

Use:
/listfloor wallet1 collectionSlug contractAddress tokenId

Example:
/listfloor wallet1 whackywhales 0x9c890D7e4d9beCb20f7b612D5Df3c4157a0837dC 9455`
    );
    return;
  }

  const walletLabel = getCommandPart(parts, 1);
  const collectionInput = getCommandPart(parts, 2);
  const contractAddress = getCommandPart(parts, 3);
  const tokenId = getCommandPart(parts, 4);

  if (!ethers.isAddress(contractAddress)) {
    await ctx.reply("❌ Invalid contract address.");
    return;
  }

  try {
    const slug = extractOpenSeaSlug(collectionInput);

    await ctx.reply(
      `⚠️ Live floor listing request

Wallet: ${walletLabel}
Collection: ${slug}
Contract: ${contractAddress}
Token ID: ${tokenId}

Fetching current floor price...`
    );

    const stats = await getOpenSeaCollectionStats(slug);

    if (stats.floorPrice === null) {
      await ctx.reply(
        `❌ Could not detect floor price for ${slug}. Listing cancelled.`
      );
      return;
    }

    await ctx.reply(
      `🏷 Current Floor: ${stats.floorPrice} ${stats.floorSymbol || "ETH"}

Checking ownership before listing...`
    );

    const ownership = await checkErc721Ownership({
      walletLabel,
      ownerTelegramId: getRequiredTelegramUserId(ctx),
      contractAddress,
      tokenId
    });

    if (!ownership.ownsToken) {
      await ctx.reply(
        `❌ Listing cancelled.

Wallet does not own this NFT.

Wallet: ${ownership.walletAddress}
Owner Onchain: ${ownership.owner}`
      );
      return;
    }

    await ctx.reply(
      `✅ Ownership confirmed.

Submitting OpenSea listing at floor price:
${stats.floorPrice} ETH`
    );

    const result = await createOpenSeaListing({
      walletLabel,
      ownerTelegramId: getRequiredTelegramUserId(ctx),
      contractAddress,
      tokenId,
      priceEth: Number(stats.floorPrice)
    });

    await ctx.reply(
      `✅ OpenSea floor listing created!

Wallet: ${result.wallet}
Contract: ${result.contractAddress}
Token ID: ${result.tokenId}
Price: ${result.priceEth} ETH

OpenSea SDK response:
${JSON.stringify(result.listing, null, 2).slice(0, 2500)}`
    );
  } catch (error: any) {
    logSafeError("Bot handler failed", error);

    await ctx.reply(
      `❌ Floor listing failed.

Reason:
${error?.message || "Unknown error"}

Live trading is locked unless:
ALLOW_MAINNET_TRADING=true`
    );
  }
});



bot.command("postmint", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = parseCommandParts(ctx.message.text);

  if (parts.length < 5) {
    await ctx.reply(
      `Invalid format.

Use:
/postmint wallet1 collectionSlug contractAddress tokenId

Example:
/postmint wallet1 whackywhales 0x9c890D7e4d9beCb20f7b612D5Df3c4157a0837dC 9455`
    );
    return;
  }

  const walletLabel = getCommandPart(parts, 1);
  const collectionInput = getCommandPart(parts, 2);
  const contractAddress = getCommandPart(parts, 3);
  const tokenId = getCommandPart(parts, 4);

  if (!ethers.isAddress(contractAddress)) {
    await ctx.reply("❌ Invalid contract address.");
    return;
  }

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const collectionSlug = extractOpenSeaSlug(collectionInput);
    const walletAddress = await getWalletAddressByLabelForOwner(
      walletLabel,
      ownerTelegramId
    );

    const action = await createPostMintActionSession({
      ownerTelegramId,
      walletLabel,
      walletAddress,
      collectionSlug,
      contractAddress,
      tokenId,
      network: "ethereum"
    });

    await sendPostMintActionMenu(ctx, action);
  } catch (error: any) {
    logSafeError("Bot handler failed", error);

    await ctx.reply(
      `❌ Could not create post-mint menu.

Reason:
${error?.message || "Unknown error"}`
    );
  }
});

bot.action(/^pm:view:(.+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const id = (ctx as any).match[1];
  const validated = await validatePostMintActionSession(ctx, id, "view-nft");

  if (!validated) {
    return;
  }

  const { action } = validated;

  try {
    if (action.network !== "ethereum") {
      await ctx.reply("This action is only available for Ethereum mainnet NFTs for now.");
      return;
    }

    const nft = await getOpenSeaNft({
      chain: "ethereum",
      contractAddress: action.contractAddress,
      tokenId: action.tokenId
    });

    await ctx.reply(
      `🖼 NFT

Name: ${nft.name}
Collection: ${nft.collectionSlug || action.collectionSlug}
Contract: ${action.contractAddress}
Token ID: ${action.tokenId}
Standard: ${nft.tokenStandard}
OpenSea URL: ${nft.openseaUrl || "Not available"}`
    );
  } catch (error: any) {
    logSafeError("Bot handler failed", error);

    await ctx.reply(
      `❌ Could not view NFT.

Reason:
${error?.message || "Unknown error"}`
    );
  }
});

bot.action(/^pm:floor:(.+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const id = (ctx as any).match[1];
  const validated = await validatePostMintActionSession(ctx, id, "market-snapshot");

  if (!validated) {
    return;
  }

  const { action } = validated;

  try {
    await ctx.reply(
      `📊 Checking floor and best listing...

Collection: ${action.collectionSlug}
Token ID: ${action.tokenId}`
    );

    const stats = await getOpenSeaCollectionStats(action.collectionSlug);
    const bestListing = await getOpenSeaBestListing(
      action.collectionSlug,
      action.tokenId
    );

    const floorText =
      stats.floorPrice === null
        ? "Not available"
        : `${stats.floorPrice} ${stats.floorSymbol || "ETH"}`;

    const listingText = bestListing.hasListing
      ? `${bestListing.amount} ${bestListing.symbol}`
      : "No active listing found for this NFT";

    await ctx.reply(
      `📊 Market Snapshot

Collection: ${action.collectionSlug}
Token ID: ${action.tokenId}

Collection Floor:
${floorText}

Best Listing For This NFT:
${listingText}

Useful:
• Use "List at Floor Preview" to prepare a floor listing.
• Use "Top Offer" to check if there is an offer to accept.`
    );
  } catch (error: any) {
    logSafeError("Bot handler failed", error);

    await ctx.reply(
      `❌ Could not fetch market snapshot.

Reason:
${error?.message || "Unknown error"}`
    );
  }
});

bot.action(/^pm:offer:(.+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const id = (ctx as any).match[1];
  const validated = await validatePostMintActionSession(ctx, id, "top-offer");

  if (!validated) {
    return;
  }

  const { action } = validated;

  try {
    await ctx.reply(
      `💰 Checking top offer...

Collection: ${action.collectionSlug}
Token ID: ${action.tokenId}`
    );

    const bestOffer = await getOpenSeaBestOffer(
      action.collectionSlug,
      action.tokenId
    );

    if (!bestOffer.hasOffer) {
      await ctx.reply(
        `❌ No top offer found.

Collection: ${action.collectionSlug}
Token ID: ${action.tokenId}`
      );
      return;
    }

    await ctx.reply(
      `💰 Top Offer

Collection: ${action.collectionSlug}
Token ID: ${action.tokenId}
Offer: ${bestOffer.amount} ${bestOffer.symbol}

Order Hash:
${bestOffer.orderHash}

Next module:
[Accept Top Offer] with confirmation before sending the transaction.`
    );
  } catch (error: any) {
    logSafeError("Bot handler failed", error);

    await ctx.reply(
      `❌ Could not fetch top offer.

Reason:
${error?.message || "Unknown error"}`
    );
  }
});

bot.action(/^pm:listfloor:(.+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const id = (ctx as any).match[1];
  const validated = await validatePostMintActionSession(
    ctx,
    id,
    "list-floor-preview"
  );

  if (!validated) {
    return;
  }

  const { action } = validated;

  try {
    await ctx.reply(
      `🏷 Preparing list-at-floor preview...

Wallet: ${action.walletLabel}
Collection: ${action.collectionSlug}
Token ID: ${action.tokenId}`
    );

    const stats = await getOpenSeaCollectionStats(action.collectionSlug);

    if (stats.floorPrice === null) {
      await ctx.reply("❌ Could not detect collection floor price.");
      return;
    }

    const ownership = await checkErc721Ownership({
      walletLabel: action.walletLabel,
      ownerTelegramId: action.ownerTelegramId,
      contractAddress: action.contractAddress,
      tokenId: action.tokenId
    });

    await ctx.reply(
      `🏷 List at Floor Preview

Collection: ${action.collectionSlug}
Floor Price: ${stats.floorPrice} ${stats.floorSymbol || "ETH"}

Wallet: ${action.walletLabel}
Wallet Address: ${ownership.walletAddress}
Contract: ${action.contractAddress}
Token ID: ${action.tokenId}
Owner Onchain: ${ownership.owner}
Wallet Owns Token: ${ownership.ownsToken ? "YES ✅" : "NO ❌"}

Suggested command:
/listfloor ${action.walletLabel} ${action.collectionSlug} ${action.contractAddress} ${action.tokenId}

Live listing lock:
ALLOW_MAINNET_TRADING=${process.env.ALLOW_MAINNET_TRADING || "false"}`
    );
  } catch (error: any) {
    logSafeError("Bot handler failed", error);

    await ctx.reply(
      `❌ List-at-floor preview failed.

Reason:
${error?.message || "Unknown error"}`
    );
  }
});

bot.action(/^pm:custom:(.+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const id = (ctx as any).match[1];
  const validated = await validatePostMintActionSession(
    ctx,
    id,
    "custom-list-preview"
  );

  if (!validated) {
    return;
  }

  const { action } = validated;

  await ctx.reply(
    `✍️ Custom Listing

NFT:
${action.collectionSlug} #${action.tokenId}

Send your custom price like this:

/customprice ${action.sessionId} PRICE_ETH

Example:
/customprice ${action.sessionId} 0.03

The bot will check ownership and then show a final confirmation button before listing.`
  );
});

bot.action(/^pm:hold:(.+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const id = (ctx as any).match[1];
  const validated = await validatePostMintActionSession(ctx, id, "hold");

  if (!validated) {
    return;
  }

  const action = await markPostMintActionStatus(
    validated.action,
    validated.actorTelegramId,
    "cancelled",
    "session.cancelled",
    "hold"
  );

  await ctx.reply(
    `🧊 Holding NFT.

Collection: ${action.collectionSlug}
Token ID: ${action.tokenId}

No listing or offer action taken.`
  );
});



bot.action(/^pm:floorconfirmpreview:(.+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const id = (ctx as any).match[1];
  const validated = await validatePostMintActionSession(
    ctx,
    id,
    "floor-confirm-preview"
  );

  if (!validated) {
    return;
  }

  const { action } = validated;

  try {
    await ctx.reply(
      `⚠️ Preparing final floor listing confirmation...

Wallet: ${action.walletLabel}
Collection: ${action.collectionSlug}
Contract: ${action.contractAddress}
Token ID: ${action.tokenId}

Checking floor price and ownership again...`
    );

    const stats = await getOpenSeaCollectionStats(action.collectionSlug);

    if (stats.floorPrice === null) {
      await ctx.reply("❌ Could not detect floor price. Listing cancelled.");
      return;
    }

    const ownership = await checkErc721Ownership({
      walletLabel: action.walletLabel,
      ownerTelegramId: action.ownerTelegramId,
      contractAddress: action.contractAddress,
      tokenId: action.tokenId
    });

    if (!ownership.ownsToken) {
      await ctx.reply(
        `❌ Cannot list this NFT.

Wallet does not own token.

Wallet: ${ownership.walletAddress}
Owner Onchain: ${ownership.owner}`
      );
      return;
    }

    await ctx.reply(
      `✅ Final Listing Confirmation

Network: Ethereum Mainnet
Collection: ${action.collectionSlug}
Wallet: ${action.walletLabel}
Wallet Address: ${ownership.walletAddress}
Contract: ${action.contractAddress}
Token ID: ${action.tokenId}

Current Floor Price:
${stats.floorPrice} ${stats.floorSymbol || "ETH"}

Live trading lock:
ALLOW_MAINNET_TRADING=${process.env.ALLOW_MAINNET_TRADING || "false"}

If live trading is false, the next button will NOT create a listing.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🚨 Confirm Live List at Floor", `pm:floorlistfinal:${action.sessionId}`)],
        [Markup.button.callback("❌ Cancel", `pm:cancel:${action.sessionId}`)]
      ])
    );
  } catch (error: any) {
    logSafeError("Bot handler failed", error);

    await ctx.reply(
      `❌ Final listing confirmation failed.

Reason:
${error?.message || "Unknown error"}`
    );
  }
});

bot.action(/^pm:floorlistfinal:(.+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const id = (ctx as any).match[1];
  const validated = await validatePostMintActionSession(
    ctx,
    id,
    "floor-list-final",
    { finalAction: true }
  );

  if (!validated) {
    return;
  }

  const action = await markPostMintActionStatus(
    validated.action,
    validated.actorTelegramId,
    "used",
    "final_action.confirmed",
    "floor-list-final"
  );

  try {
    await ctx.reply(
      `🚨 Final command received.

Re-checking current floor price and wallet ownership before listing...`
    );

    const stats = await getOpenSeaCollectionStats(action.collectionSlug);

    if (stats.floorPrice === null) {
      await ctx.reply("❌ Could not detect floor price. Listing cancelled.");
      return;
    }

    const ownership = await checkErc721Ownership({
      walletLabel: action.walletLabel,
      ownerTelegramId: action.ownerTelegramId,
      contractAddress: action.contractAddress,
      tokenId: action.tokenId
    });

    if (!ownership.ownsToken) {
      await ctx.reply(
        `❌ Listing cancelled.

Wallet does not own this NFT.

Wallet: ${ownership.walletAddress}
Owner Onchain: ${ownership.owner}`
      );
      return;
    }

    await ctx.reply(
      `🏷 Submitting OpenSea listing...

Wallet: ${action.walletLabel}
Contract: ${action.contractAddress}
Token ID: ${action.tokenId}
Price: ${stats.floorPrice} ETH`
    );

    const result = await createOpenSeaListing({
      walletLabel: action.walletLabel,
      ownerTelegramId: action.ownerTelegramId,
      contractAddress: action.contractAddress,
      tokenId: action.tokenId,
      priceEth: Number(stats.floorPrice)
    });

    await ctx.reply(
      `✅ OpenSea listing created!

Wallet: ${result.wallet}
Contract: ${result.contractAddress}
Token ID: ${result.tokenId}
Price: ${result.priceEth} ETH

OpenSea SDK response:
${JSON.stringify(result.listing, null, 2).slice(0, 2500)}`
    );
  } catch (error: any) {
    logSafeError("Bot handler failed", error);

    await ctx.reply(
      `❌ Live floor listing failed.

Reason:
${error?.message || "Unknown error"}

Safety lock status:
ALLOW_MAINNET_TRADING=${process.env.ALLOW_MAINNET_TRADING || "false"}`
    );
  }
});

bot.action(/^pm:cancel:(.+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const id = (ctx as any).match[1];
  const validated = await validatePostMintActionSession(ctx, id, "cancel");

  if (!validated) {
    return;
  }

  const action = await markPostMintActionStatus(
    validated.action,
    validated.actorTelegramId,
    "cancelled",
    "session.cancelled",
    "cancel"
  );

  await ctx.reply(
    `❌ Action cancelled.

Collection: ${action.collectionSlug}
Token ID: ${action.tokenId}

No transaction was sent.`
  );
});



bot.command("customprice", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = parseCommandParts(ctx.message.text);

  if (parts.length < 3) {
    await ctx.reply(
      `Invalid format.

Use:
/customprice POST_MINT_SESSION_ID priceETH

Example:
/customprice abc123 0.03

Tip:
Click "Custom List Preview" from the post-mint menu and it will show you the correct session ID.`
    );
    return;
  }

  const sessionId = getCommandPart(parts, 1);
  const priceRaw = getCommandPart(parts, 2);
  const priceEth = Number(priceRaw);

  if (!Number.isFinite(priceEth) || priceEth <= 0) {
    await ctx.reply("❌ Price must be a number greater than 0.");
    return;
  }

  if (priceEth > 1000) {
    await ctx.reply("❌ Price looks too high. Please check and try again.");
    return;
  }

  const validated = await validatePostMintActionSession(
    ctx,
    sessionId,
    "custom-price"
  );

  if (!validated) {
    return;
  }

  try {
    const action = setPostMintCustomPrice(validated.action, priceEth);

    await ctx.reply(
      `✍️ Preparing custom listing confirmation...

Wallet: ${action.walletLabel}
Collection: ${action.collectionSlug}
Contract: ${action.contractAddress}
Token ID: ${action.tokenId}
Custom Price: ${priceEth} ETH

Checking ownership...`
    );

    const ownership = await checkErc721Ownership({
      walletLabel: action.walletLabel,
      ownerTelegramId: action.ownerTelegramId,
      contractAddress: action.contractAddress,
      tokenId: action.tokenId
    });

    if (!ownership.ownsToken) {
      await ctx.reply(
        `❌ Cannot list this NFT.

Wallet does not own token.

Wallet: ${ownership.walletAddress}
Owner Onchain: ${ownership.owner}`
      );
      return;
    }

    await ctx.reply(
      `✅ Custom Listing Confirmation

Network: Ethereum Mainnet
Collection: ${action.collectionSlug}
Wallet: ${action.walletLabel}
Wallet Address: ${ownership.walletAddress}
Contract: ${action.contractAddress}
Token ID: ${action.tokenId}

Listing Price:
${priceEth} ETH

Live trading lock:
ALLOW_MAINNET_TRADING=${process.env.ALLOW_MAINNET_TRADING || "false"}

If live trading is false, the confirm button will NOT create a listing.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🚨 Confirm Custom Listing", `pm:customlistfinal:${sessionId}`)],
        [Markup.button.callback("❌ Cancel", `pm:cancel:${sessionId}`)]
      ])
    );
  } catch (error: any) {
    logSafeError("Bot handler failed", error);

    await ctx.reply(
      `❌ Custom listing confirmation failed.

Reason:
${error?.message || "Unknown error"}`
    );
  }
});

bot.action(/^pm:customlistfinal:(.+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const sessionId = (ctx as any).match[1];
  const validated = await validatePostMintActionSession(
    ctx,
    sessionId,
    "custom-list-final",
    { finalAction: true }
  );

  if (!validated) {
    return;
  }

  const priceEth = validated.action.customPriceEth;

  if (!Number.isFinite(priceEth) || !priceEth || priceEth <= 0) {
    await ctx.reply("❌ Invalid custom listing price. Please open the custom listing preview again.");
    return;
  }

  const action = await markPostMintActionStatus(
    validated.action,
    validated.actorTelegramId,
    "used",
    "final_action.confirmed",
    "custom-list-final"
  );

  try {
    await ctx.reply(
      `🚨 Final custom listing command received.

Re-checking ownership before submitting...`
    );

    const ownership = await checkErc721Ownership({
      walletLabel: action.walletLabel,
      ownerTelegramId: action.ownerTelegramId,
      contractAddress: action.contractAddress,
      tokenId: action.tokenId
    });

    if (!ownership.ownsToken) {
      await ctx.reply(
        `❌ Listing cancelled.

Wallet does not own this NFT.

Wallet: ${ownership.walletAddress}
Owner Onchain: ${ownership.owner}`
      );
      return;
    }

    await ctx.reply(
      `🏷 Submitting custom OpenSea listing...

Wallet: ${action.walletLabel}
Contract: ${action.contractAddress}
Token ID: ${action.tokenId}
Price: ${priceEth} ETH`
    );

    const result = await createOpenSeaListing({
      walletLabel: action.walletLabel,
      ownerTelegramId: action.ownerTelegramId,
      contractAddress: action.contractAddress,
      tokenId: action.tokenId,
      priceEth
    });

    await ctx.reply(
      `✅ Custom OpenSea listing created!

Wallet: ${result.wallet}
Contract: ${result.contractAddress}
Token ID: ${result.tokenId}
Price: ${result.priceEth} ETH

OpenSea SDK response:
${JSON.stringify(result.listing, null, 2).slice(0, 2500)}`
    );
  } catch (error: any) {
    logSafeError("Bot handler failed", error);

    await ctx.reply(
      `❌ Custom listing failed.

Reason:
${error?.message || "Unknown error"}

Safety lock status:
ALLOW_MAINNET_TRADING=${process.env.ALLOW_MAINNET_TRADING || "false"}`
    );
  }
});



bot.action(/^pm:acceptofferpreview:(.+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const id = (ctx as any).match[1];
  const validated = await validatePostMintActionSession(
    ctx,
    id,
    "accept-offer-preview"
  );

  if (!validated) {
    return;
  }

  const { action } = validated;

  try {
    await ctx.reply(
      `💰 Preparing accept-offer confirmation...

Wallet: ${action.walletLabel}
Collection: ${action.collectionSlug}
Contract: ${action.contractAddress}
Token ID: ${action.tokenId}

Checking top offer and ownership...`
    );

    const bestOffer = await getOpenSeaBestOffer(
      action.collectionSlug,
      action.tokenId
    );

    if (!bestOffer.hasOffer) {
      await ctx.reply(
        `❌ No top offer found.

Collection: ${action.collectionSlug}
Token ID: ${action.tokenId}`
      );
      return;
    }

    const ownership = await checkErc721Ownership({
      walletLabel: action.walletLabel,
      ownerTelegramId: action.ownerTelegramId,
      contractAddress: action.contractAddress,
      tokenId: action.tokenId
    });

    if (!ownership.ownsToken) {
      await ctx.reply(
        `❌ Cannot accept offer.

Wallet does not own this NFT.

Wallet: ${ownership.walletAddress}
Owner Onchain: ${ownership.owner}`
      );
      return;
    }

    await ctx.reply(
      `⚠️ Accept Top Offer Confirmation

Network: Ethereum Mainnet
Collection: ${action.collectionSlug}
Wallet: ${action.walletLabel}
Wallet Address: ${ownership.walletAddress}
Contract: ${action.contractAddress}
Token ID: ${action.tokenId}

Top Offer:
${bestOffer.amount} ${bestOffer.symbol}

Order Hash:
${bestOffer.orderHash}

Live trading lock:
ALLOW_MAINNET_TRADING=${process.env.ALLOW_MAINNET_TRADING || "false"}

If you confirm, this will sell the NFT for the top offer when live trading is enabled.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🚨 Confirm Accept Top Offer", `pm:acceptofferfinal:${action.sessionId}`)],
        [Markup.button.callback("❌ Cancel", `pm:cancel:${action.sessionId}`)]
      ])
    );
  } catch (error: any) {
    logSafeError("Bot handler failed", error);

    await ctx.reply(
      `❌ Accept-offer preview failed.

Reason:
${error?.message || "Unknown error"}`
    );
  }
});

bot.action(/^pm:acceptofferfinal:(.+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const id = (ctx as any).match[1];
  const validated = await validatePostMintActionSession(
    ctx,
    id,
    "accept-offer-final",
    { finalAction: true }
  );

  if (!validated) {
    return;
  }

  const action = await markPostMintActionStatus(
    validated.action,
    validated.actorTelegramId,
    "used",
    "final_action.confirmed",
    "accept-offer-final"
  );

  try {
    await ctx.reply(
      `🚨 Final accept-offer command received.

Re-checking ownership and latest top offer before submitting...`
    );

    const result = await acceptOpenSeaBestOffer({
      walletLabel: action.walletLabel,
      ownerTelegramId: action.ownerTelegramId,
      collectionSlug: action.collectionSlug,
      contractAddress: action.contractAddress,
      tokenId: action.tokenId
    });

    await ctx.reply(
      `✅ Top offer accepted!

Wallet: ${result.wallet}
Collection: ${result.collectionSlug}
Contract: ${result.contractAddress}
Token ID: ${result.tokenId}
Offer: ${result.offerAmount} ${result.offerSymbol}

Order Hash:
${result.orderHash}

Tx:
${result.txHash}`
    );
  } catch (error: any) {
    logSafeError("Bot handler failed", error);

    await ctx.reply(
      `❌ Accept top offer failed.

Reason:
${error?.message || "Unknown error"}

Safety lock status:
ALLOW_MAINNET_TRADING=${process.env.ALLOW_MAINNET_TRADING || "false"}`
    );
  }
});



bot.action("os_portfolio_help", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  await ctx.reply(
    `📦 OpenSea Portfolio Scanner

Scan NFTs owned by a saved wallet:

/osportfolio wallet1

Optional limit:
/osportfolio wallet1 20

After scanning, click any NFT to open the post-mint action menu.`
  );
});

bot.command("osportfolio", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = parseCommandParts(ctx.message.text);
  const walletLabel = parts[1]?.trim().toLowerCase();
  const limitRaw = parts[2];

  if (!walletLabel) {
    await ctx.reply(
      `Invalid format.

Use:
/osportfolio wallet1

Or:
/osportfolio wallet1 20`
    );
    return;
  }

  const limit = limitRaw ? Number(limitRaw) : 10;

  if (!Number.isInteger(limit) || limit <= 0 || limit > 50) {
    await ctx.reply("❌ Limit must be a whole number from 1 to 50.");
    return;
  }

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const walletAddress = await getWalletAddressByLabelForOwner(
      walletLabel,
      ownerTelegramId
    );

    await ctx.reply(
      `📦 Scanning OpenSea portfolio...

Wallet: ${walletLabel}
Address: ${walletAddress}
Chain: Ethereum
Limit: ${limit}`
    );

    const portfolio = await getOpenSeaNftsByAccount({
      chain: "ethereum",
      address: walletAddress,
      limit
    });

    if (portfolio.nfts.length === 0) {
      await ctx.reply(
        `No NFTs found for ${walletLabel} on OpenSea.

Wallet:
${walletAddress}`
      );
      return;
    }

    let message = `📦 OpenSea Portfolio\n\nWallet: ${walletLabel}\nAddress: ${walletAddress}\n\n`;

    const buttons: any[] = [];

    for (const nft of portfolio.nfts) {
      const action = await createPostMintActionSession({
        ownerTelegramId,
        walletLabel,
        walletAddress,
        collectionSlug: nft.collectionSlug,
        contractAddress: nft.contractAddress,
        tokenId: nft.identifier,
        network: "ethereum"
      });

      message += `• ${nft.name}\n`;
      message += `  Collection: ${nft.collectionSlug}\n`;
      message += `  Token ID: ${nft.identifier}\n\n`;

      const shortName =
        nft.name.length > 24 ? nft.name.slice(0, 21) + "..." : nft.name;

      buttons.push([
        Markup.button.callback(
          `🖼 ${shortName}`,
          `pf:open:${action.sessionId}`
        )
      ]);
    }

    message += `Click an NFT below to open actions.`;

    await ctx.reply(message, Markup.inlineKeyboard(buttons));
  } catch (error: any) {
    logSafeError("Bot handler failed", error);

    await ctx.reply(
      `❌ Portfolio scan failed.

Reason:
${error?.message || "Unknown error"}`
    );
  }
});

bot.action(/^pf:open:(.+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const id = (ctx as any).match[1];
  const validated = await validatePostMintActionSession(
    ctx,
    id,
    "portfolio-open"
  );

  if (!validated) {
    return;
  }

  await sendPostMintActionMenu(ctx, validated.action);
});


bot.launch();

console.log("Bot is running...");
console.log("Admin lock + NFT mint module loaded.");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
