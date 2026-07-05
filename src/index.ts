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
  getWalletSignerByLabelForOwner,
  getWalletSummaryByLabelForOwner,
  renameWalletForOwner,
  archiveWalletForOwner
} from "./vault.js";
import { getTelegramUserId, requireAdmin } from "./auth.js";
import {
  formatOpenSeaResolverUserMessage,
  resolveOpenSeaContractForMintFlow
} from "./openSeaContractResolver.js";
import { extractOpenSeaSlug, getOpenSeaCollectionStats, getOpenSeaBestOffer, getOpenSeaBestListing, getOpenSeaNft, getOpenSeaNftsByAccount } from "./opensea.js";
import { checkErc721Ownership, createOpenSeaListing, getMainnetProvider, acceptOpenSeaBestOffer } from "./openseaTrading.js";
import { appendSessionAuditLog, appendWalletAuditLog } from "./audit.js";
import {
  MAINNET_MINTING_DISABLED_MESSAGE,
  getMintProvider,
  getMintRpcStatus,
  isMainnetMintingEnabled,
  normalizeMintChain,
  normalizeMintFunctionSignature,
  previewMint,
  submitMintTransaction,
  validateMintPriceEth,
  validateMintQuantity,
  waitForMintConfirmation,
  SUPPORTED_MINT_FUNCTION_SIGNATURES
} from "./mintEngine.js";
import type {
  MintChain,
  MintPreviewResult,
  SupportedMintFunctionSignature
} from "./mintEngine.js";
import {
  archiveMintTargetForOwner,
  calculateMintTargetCompleteness,
  createMintTarget,
  getMintTargetMissingFields,
  getMintTargetForOwner,
  listMintTargetsForOwner,
  updateMintTargetDetectedMetadataForOwner,
  updateMintTargetGasStrategyForOwner,
  updateMintTargetMintSettingsForOwner,
  updateMintTargetForOwner
} from "./mintTargets.js";
import type { MintTarget } from "./mintTargets.js";
import {
  createMintJob,
  getMintJobForOwner,
  getMintTypeDefaults,
  listActiveMintJobsForOwner,
  listResumableMintJobs,
  normalizeMintJobMintType,
  updateMintJobForOwner,
  updateMintJobStatus
} from "./mintJobs.js";
import type {
  MintJob,
  MintJobMintType,
  MintJobMode,
  MintJobStatus
} from "./mintJobs.js";
import {
  createMintRun,
  getMintRunForOwner,
  listMintRunsForOwner,
  updateMintRunForOwner
} from "./mintRuns.js";
import type { MintRun, MintRunStatus } from "./mintRuns.js";
import {
  createDefaultGasStrategy,
  formatGasStrategy,
  parseGasStrategyInput
} from "./gasStrategy.js";
import type { GasStrategy } from "./gasStrategy.js";
import {
  createMultiMintJob,
  getMultiMintJobForOwner,
  listActiveMultiMintJobsForOwner,
  listResumableMultiMintJobs,
  summarizeMultiMintJobStatus,
  updateMultiMintChildResult,
  updateMultiMintJobForOwner
} from "./multiMintJobs.js";
import type {
  MultiMintJob,
  MultiMintJobStatus
} from "./multiMintJobs.js";
import {
  detectMint,
  detectMintFunctions,
  resolveOpenSeaContracts,
  toSupportedMintChain
} from "./mintDetector.js";
import { getConfiguredDetectorRpcStatus } from "./mintDetectorV2.js";
import type {
  DetectedChainName,
  MintDetectionResult,
  MintFunctionCandidate,
  OpenSeaContractResolutionResult,
  OpenSeaMintMetadata,
  OpenSeaMintStage
} from "./mintDetector.js";
import { detectMintPhase } from "./mintPhaseDetector.js";
import {
  formatMintRouteResolverResult,
  pickBestSupportedRoute,
  resolveMintRoutesForTarget
} from "./mintRouteResolver.js";

import type { MintPhaseDetectionResult } from "./mintPhaseDetector.js";

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN in .env");
}

const bot = new Telegraf(token);

const BOT_COMMANDS = [
  { command: "start", description: "Open bot menu" },
  { command: "addwallet", description: "Import wallet" },
  { command: "importwallet", description: "Import wallet alias" },
  { command: "wallets", description: "Show your wallets" },
  { command: "wallet", description: "View wallet details" },
  { command: "balance", description: "Check wallet balance" },
  { command: "renamewallet", description: "Rename wallet" },
  { command: "deletewallet", description: "Remove wallet" },
  { command: "minttest", description: "Test Sepolia mint" },
  { command: "nfts", description: "Show wallet NFTs" },
  { command: "osportfolio", description: "Show OpenSea portfolio" },
  { command: "postmint", description: "Open NFT action menu" },
  { command: "osfloor", description: "Check collection floor" },
  { command: "topoffer", description: "Check top offer" },
  { command: "bestlisting", description: "Check best listing" },
  { command: "tradingstatus", description: "Show trading lock status" },
  { command: "mainmintpreview", description: "Preview real mint" },
  { command: "mainmint", description: "Create real mint confirmation" },
  { command: "addminttarget", description: "Save mint target" },
  { command: "minttargets", description: "Show mint targets" },
  { command: "minttarget", description: "View mint target" },
  { command: "updateminttarget", description: "Update mint target" },
  { command: "deleteminttarget", description: "Archive mint target" },
  { command: "minttargetpreview", description: "Preview saved mint target" },
  { command: "minttargetnow", description: "Mint saved target" },
  { command: "minthistory", description: "Show mint history" },
  { command: "mintstatus", description: "Show mint run status" },
  { command: "mintingstatus", description: "Show minting lock status" },
  { command: "parsemintlink", description: "Parse mint link" },
  { command: "addmintfromlink", description: "Create mint target from link" },
  { command: "resolvecontract", description: "Resolve OpenSea contract" },
  { command: "resolveroute", description: "Resolve verified mint route" },
  { command: "diagnosemint", description: "Diagnose mint route" },
  { command: "detectmintfunction", description: "Detect mint functions" },
  { command: "detecttargetfunction", description: "Detect target functions" },
  { command: "checkmintphase", description: "Check mint phase" },
  { command: "checkminteligibility", description: "Estimate mint eligibility" },
  { command: "checkmintreadiness", description: "Check mint readiness" },
  { command: "refreshtarget", description: "Refresh mint target metadata" },
  { command: "parserstatus", description: "Show parser status" },
  { command: "setminttype", description: "Set mint target type" },
  { command: "schedulemint", description: "Schedule mint target" },
  { command: "schedulemintphase", description: "Schedule target phase" },
  { command: "mintwatchstatus", description: "Show mint watcher jobs" },
  { command: "mintjob", description: "Show mint job" },
  { command: "cancelmintjob", description: "Cancel mint job" },
  { command: "runmintcheck", description: "Run mint job check" },
  { command: "runmintjob", description: "Run mint job manually" },
  { command: "schedulerstatus", description: "Show scheduler status" },
  { command: "setgas", description: "Set mint gas strategy" },
  { command: "gaspreview", description: "Preview mint gas" },
  { command: "multigaspreview", description: "Preview gas for wallets" },
  { command: "mintready", description: "Check mint readiness" },
  { command: "quickmint", description: "Guided quick mint" },
  { command: "mintflow", description: "Show guided mint flow" },
  { command: "mintmulti", description: "Mint with multiple wallets" },
  { command: "schedulemintmulti", description: "Schedule multi-wallet mint" },
  { command: "runmultimintjob", description: "Run multi-mint job" },
  { command: "multimintjob", description: "Show multi-mint job" },
  { command: "cancelmultimintjob", description: "Cancel multi-mint job" },
  { command: "multimintstatus", description: "Show multi-mint status" },
  { command: "help", description: "Show commands" }
];

type SupportedBalanceNetwork = "sepolia" | "mainnet";

const BALANCE_NETWORK_LABELS: Record<SupportedBalanceNetwork, string> = {
  sepolia: "Sepolia",
  mainnet: "Mainnet"
};
const COMMAND_MENU_REGISTRATION_TIMEOUT_MS = 10_000;
const MAINNET_TRADING_DISABLED_MESSAGE =
  "Mainnet trading is disabled. Set ALLOW_MAINNET_TRADING=true only when you are ready for live testing.";

function getSepoliaRpcUrl(): string {
  const rpcUrl = process.env.SEPOLIA_RPC_URL || process.env.ETH_SEPOLIA_RPC_URL;

  if (!rpcUrl) {
    throw new Error("Missing SEPOLIA_RPC_URL or ETH_SEPOLIA_RPC_URL");
  }

  return rpcUrl;
}

function getMainnetRpcUrl(): string {
  const rpcUrl = process.env.ETH_MAINNET_RPC_URL;

  if (!rpcUrl) {
    throw new Error("Missing ETH_MAINNET_RPC_URL");
  }

  return rpcUrl;
}

function getProvider() {
  return new ethers.JsonRpcProvider(getSepoliaRpcUrl());
}

function getBalanceProvider(network: SupportedBalanceNetwork) {
  if (network === "mainnet") {
    return new ethers.JsonRpcProvider(getMainnetRpcUrl());
  }

  return getProvider();
}

function isMainnetTradingEnabled(): boolean {
  return process.env.ALLOW_MAINNET_TRADING === "true";
}

function getTradingLockStatusText(): string {
  return isMainnetTradingEnabled()
    ? "ENABLED - live mainnet listing/offer actions may execute."
    : "DISABLED - previews only; live listing/offer actions are blocked.";
}

function getConfiguredStatus(value?: string): string {
  return value && value.trim() ? "yes" : "no";
}

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
    "BASE_RPC_URL",
    "ETH_BASE_RPC_URL",
    "ARBITRUM_RPC_URL",
    "ETH_ARBITRUM_RPC_URL",
    "POLYGON_RPC_URL",
    "ETH_POLYGON_RPC_URL",
    "OPENSEA_API_KEY",
    "RESERVOIR_API_KEY",
    "ETHERSCAN_API_KEY",
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


async function replyLong(ctx: Context, text: string, chunkSize = 3500) {
  const safeText = text || "";
  const chunks: string[] = [];

  for (let i = 0; i < safeText.length; i += chunkSize) {
    chunks.push(safeText.slice(i, i + chunkSize));
  }

  if (chunks.length === 0) {
    chunks.push("No output.");
  }

  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
}

function logSafeError(context: string, error: unknown) {
  console.error(`${context}: ${getSafeErrorMessage(error)}`);
}

function shouldRegisterTelegramCommands(): boolean {
  return process.env.REGISTER_TELEGRAM_COMMANDS?.trim().toLowerCase() === "true";
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

function formatShortAddress(address: string): string {
  if (address.length <= 12) {
    return address;
  }

  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatMaybeShortAddress(value: string | null | undefined): string {
  if (!value) {
    return "Not available";
  }

  return ethers.isAddress(value) ? formatShortAddress(value) : value;
}

function normalizeWalletLabel(label: string): string {
  return label.trim().toLowerCase();
}

function isValidWalletLabel(label: string): boolean {
  return WALLET_IMPORT_LABEL_PATTERN.test(label);
}

function formatWalletStatus(status?: string): string {
  return status === "archived" ? "Archived" : "Active";
}

function formatWalletEncryption(kmsProvider?: string): string {
  return kmsProvider === "azure-key-vault" ? "Azure Key Vault" : "Legacy local";
}

function getHelpMessage() {
  return `Commands

Wallets:
/addwallet 0xPRIVATE_KEY
/addwallet
0xPRIVATE_KEY_1
0xPRIVATE_KEY_2
/wallets
/wallet wallet1
/balance wallet1
/balance wallet1 mainnet
/renamewallet wallet1 mintwallet
/deletewallet wallet1

NFTs:
/nfts wallet1
/osportfolio wallet1 5
/postmint wallet1 collectionSlug contractAddress tokenId

OpenSea:
/osfloor collectionSlug
/topoffer collectionSlug tokenId
/bestlisting collectionSlug tokenId
/tradingstatus

Minting:
/mainmintpreview wallet1 0xCONTRACT mint(uint256) 1 0.03 mainnet
/mainmint wallet1 0xCONTRACT mint(uint256) 1 0.03 mainnet
/addminttarget whaleMint 0xCONTRACT mint(uint256) 1 0.03 mainnet
/minttargets
/minttarget targetId
/updateminttarget targetId publicMint(uint256) 2 0.01 mainnet
/deleteminttarget targetId
/minttargetpreview targetId wallet1
/minttargetnow targetId wallet1
/minthistory
/mintstatus runId
/mintingstatus
/parsemintlink https://opensea.io/collection/collectionSlug
/addmintfromlink https://opensea.io/collection/collectionSlug mintName
/resolvecontract collectionSlug
/resolveroute targetId wallet1
/diagnosemint targetId wallet1
/detectmintfunction 0xCONTRACT mainnet
/detecttargetfunction targetId
/checkmintphase targetId
/checkminteligibility targetId wallet1
/checkmintreadiness targetId wallet1
/refreshtarget targetId
/parserstatus

You can also paste an OpenSea/Zora/explorer mint link directly in private chat.

Scheduler:
/setminttype targetId gtd
/schedulemint targetId wallet1 2026-07-04T18:00:00Z watch
/schedulemintphase targetId wallet1 public watch
/mintwatchstatus
/mintjob jobId
/cancelmintjob jobId
/runmintcheck jobId
/runmintjob jobId
/schedulerstatus

Gas and Multi-Wallet Minting:
/setgas targetId auto
/setgas targetId fast
/setgas targetId custom 25 2
/gaspreview targetId wallet1
/multigaspreview targetId wallet1,wallet2
/mintmulti targetId wallet1,wallet2
/schedulemintmulti targetId wallet1,wallet2 2026-07-04T18:00:00Z watch
/runmultimintjob jobId
/multimintjob jobId
/cancelmultimintjob jobId
/multimintstatus

Testing:
/minttest wallet1 1`;
}

function getWalletActionKeyboard(wallets: Array<{ label: string; status?: string }>) {
  const rows = wallets.flatMap((wallet) => {
    if (wallet.status === "archived") {
      return [[Markup.button.callback(`View ${wallet.label}`, `wm:view:${wallet.label}`)]];
    }

    return [
      [
        Markup.button.callback(`View ${wallet.label}`, `wm:view:${wallet.label}`),
        Markup.button.callback("Balance", `wm:balance:${wallet.label}`),
        Markup.button.callback("NFTs", `wm:nfts:${wallet.label}`)
      ]
    ];
  });

  return Markup.inlineKeyboard(rows);
}

async function auditWalletManagementAction(details: {
  ownerTelegramId: string | null;
  action: string;
  walletLabel?: string;
  walletAddress?: string;
  encryptionVersion?: string;
  network?: string;
  newWalletLabel?: string;
  sessionId?: string;
  status?: string;
  reason?: string;
}) {
  await appendWalletAuditLog(details);
}

async function auditOpenSeaSessionAction(
  action: PostMintActionSession,
  auditAction: string,
  actorTelegramId: string | null,
  details: {
    priceEth?: number;
    txHash?: string;
    reason?: string;
  } = {}
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
    ...details
  });
}

async function auditOpenSeaWalletAction(details: {
  ownerTelegramId: string | null;
  action: string;
  walletLabel?: string;
  walletAddress?: string;
  collectionSlug?: string;
  contractAddress?: string;
  tokenId?: string;
  priceEth?: number;
  txHash?: string;
  reason?: string;
}) {
  await appendWalletAuditLog(details);
}

function getOpenSeaPublicResultValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value;
  }

  return null;
}

function getOpenSeaPublicField(source: any, fieldNames: string[]): string | null {
  if (!source || typeof source !== "object") {
    return null;
  }

  for (const fieldName of fieldNames) {
    const rawValue = source[fieldName];
    const value =
      getOpenSeaPublicResultValue(rawValue) ||
      getOpenSeaPublicResultValue(rawValue?.hash) ||
      getOpenSeaPublicResultValue(rawValue?.transactionHash) ||
      getOpenSeaPublicResultValue(rawValue?.txHash);

    if (value) {
      return value;
    }
  }

  return null;
}

function getOpenSeaResultSummary(result: any): string {
  const listing = result?.listing ?? result;
  const txHash = getOpenSeaResultTxHash(result);
  const orderHash =
    getOpenSeaPublicField(result, ["orderHash", "order_hash"]) ||
    getOpenSeaPublicField(listing, ["orderHash", "order_hash"]);
  const protocolAddress =
    getOpenSeaPublicField(result, ["protocolAddress", "protocol_address"]) ||
    getOpenSeaPublicField(listing, ["protocolAddress", "protocol_address"]);

  const lines = [];

  if (txHash) {
    lines.push(`Tx Hash: ${txHash}`);
  }

  if (orderHash) {
    lines.push(`Order Hash: ${orderHash}`);
  }

  if (protocolAddress) {
    lines.push(`Protocol: ${protocolAddress}`);
  }

  if (lines.length === 0) {
    lines.push("OpenSea SDK returned a result but did not provide a public tx/order hash.");
  }

  return lines.join("\n");
}

function getOpenSeaResultTxHash(result: any): string | null {
  const listing = result?.listing ?? result;

  return (
    getOpenSeaPublicField(result, ["txHash", "transactionHash", "hash"]) ||
    getOpenSeaPublicField(listing, ["txHash", "transactionHash", "hash"])
  );
}

async function checkPostMintSessionOwnership(action: PostMintActionSession) {
  const savedWallet = await getWalletSummaryByLabelForOwner(
    action.walletLabel,
    action.ownerTelegramId
  );

  if (savedWallet.address.toLowerCase() !== action.walletAddress.toLowerCase()) {
    throw new Error("Wallet session no longer matches the saved wallet.");
  }

  return checkErc721Ownership({
    walletLabel: action.walletLabel,
    ownerTelegramId: action.ownerTelegramId,
    contractAddress: action.contractAddress,
    tokenId: action.tokenId
  });
}

async function blockOpenSeaActionIfNotOwner(params: {
  ctx: Context;
  action: PostMintActionSession;
  actorTelegramId: string;
  auditAction: string;
  blockedVerb: string;
}) {
  const ownership = await checkPostMintSessionOwnership(params.action);

  if (ownership.ownsToken) {
    return ownership;
  }

  await auditOpenSeaSessionAction(
    params.action,
    params.auditAction,
    params.actorTelegramId,
    {
      reason: `wallet_not_token_owner:${ownership.owner}`
    }
  );

  await params.ctx.reply(
    `❌ Cannot ${params.blockedVerb}.

Wallet does not own this NFT.

Wallet: ${formatShortAddress(ownership.walletAddress)}
Owner Onchain: ${formatMaybeShortAddress(ownership.owner)}`
  );

  return null;
}

async function blockOpenSeaActionIfTradingDisabled(params: {
  ctx: Context;
  action: PostMintActionSession;
  actorTelegramId: string;
  auditAction: string;
  priceEth?: number;
}) {
  if (isMainnetTradingEnabled()) {
    return false;
  }

  await auditOpenSeaSessionAction(
    params.action,
    params.auditAction,
    params.actorTelegramId,
    {
      ...(params.priceEth === undefined ? {} : { priceEth: params.priceEth }),
      reason: "mainnet_trading_disabled"
    }
  );

  await params.ctx.reply(MAINNET_TRADING_DISABLED_MESSAGE);
  return true;
}

type MintCommandParams = {
  walletLabel: string;
  contractAddress: string;
  functionSignature: SupportedMintFunctionSignature;
  quantity: number;
  priceEth: string;
  chain: MintChain;
};

type MintConfirmationStatus = "active" | "used" | "cancelled" | "expired";

type MintConfirmationSession = {
  sessionId: string;
  ownerTelegramId: string;
  walletLabel: string;
  walletAddress: string;
  chain: MintChain;
  contractAddress: string;
  functionSignature: SupportedMintFunctionSignature;
  quantity: number;
  priceEth: string;
  runId: string;
  targetId?: string;
  jobId?: string;
  gasStrategy?: GasStrategy;
  createdAt: string;
  expiresAt: string;
  status: MintConfirmationStatus;
};

type MultiMintConfirmationStatus = "active" | "used" | "cancelled" | "expired";

type MultiMintConfirmationSession = {
  sessionId: string;
  ownerTelegramId: string;
  targetId: string;
  targetName: string;
  chain: MintChain;
  contractAddress: string;
  functionSignature: SupportedMintFunctionSignature;
  quantity: number;
  priceEth: string;
  walletLabels: string[];
  walletAddresses: string[];
  gasStrategy: GasStrategy;
  multiMintJobId?: string;
  createdAt: string;
  expiresAt: string;
  status: MultiMintConfirmationStatus;
};

type ValidatedMintConfirmationSession = {
  session: MintConfirmationSession;
  actorTelegramId: string;
};

type MintTargetDeleteStatus = "active" | "used" | "cancelled" | "expired";

type MintTargetDeleteConfirmation = {
  sessionId: string;
  ownerTelegramId: string;
  targetId: string;
  targetName: string;
  createdAt: string;
  expiresAt: string;
  status: MintTargetDeleteStatus;
};

type MintJobCancelStatus = "active" | "used" | "cancelled" | "expired";

type MintJobCancelConfirmation = {
  sessionId: string;
  ownerTelegramId: string;
  jobId: string;
  targetName: string;
  createdAt: string;
  expiresAt: string;
  status: MintJobCancelStatus;
};

type MultiMintJobCancelConfirmation = {
  sessionId: string;
  ownerTelegramId: string;
  jobId: string;
  targetName: string;
  createdAt: string;
  expiresAt: string;
  status: MintJobCancelStatus;
};

const MINT_CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const MULTI_MINT_CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const MINT_TARGET_DELETE_TTL_MS = 10 * 60 * 1000;
const MINT_JOB_CANCEL_TTL_MS = 10 * 60 * 1000;
const MULTI_MINT_JOB_CANCEL_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MINT_SCHEDULER_POLL_MS = 15_000;
const MIN_MINT_SCHEDULER_POLL_MS = 5_000;
const DEFAULT_MAX_MULTI_MINT_WALLETS = 10;
const HARD_MAX_MULTI_MINT_WALLETS = 10;
const DEFAULT_MULTI_MINT_CONCURRENCY = 2;
const HARD_MAX_MULTI_MINT_CONCURRENCY = 3;
const DEFAULT_MULTI_MINT_DELAY_MS = 1_000;
const MIN_MULTI_MINT_DELAY_MS = 500;
const MINT_TARGET_NAME_PATTERN = /^[A-Za-z0-9_-]{2,40}$/;
const MINT_CONFIRMATION_EXPIRED_MESSAGE =
  "This mint confirmation has expired. Please create it again.";
const MINT_CONFIRMATION_ALREADY_USED_MESSAGE =
  "This mint confirmation has already been used or cancelled.";
const MINT_CONFIRMATION_WRONG_USER_MESSAGE =
  "You cannot use this mint confirmation.";
const mintConfirmations = new Map<string, MintConfirmationSession>();
const multiMintConfirmations = new Map<string, MultiMintConfirmationSession>();
const mintTargetDeleteConfirmations =
  new Map<string, MintTargetDeleteConfirmation>();
const mintJobCancelConfirmations =
  new Map<string, MintJobCancelConfirmation>();
const multiMintJobCancelConfirmations =
  new Map<string, MultiMintJobCancelConfirmation>();
let mintSchedulerTimer: ReturnType<typeof setInterval> | undefined;
let mintSchedulerTickRunning = false;

function getMintLockStatusText(chain: MintChain): string {
  if (chain === "sepolia") {
    return "Sepolia test minting is allowed without ALLOW_MAINNET_MINTING.";
  }

  return isMainnetMintingEnabled()
    ? "ALLOW_MAINNET_MINTING=true - live mainnet mint sends are enabled."
    : "ALLOW_MAINNET_MINTING=false - live mainnet mint sends are blocked.";
}

function isScheduledMainnetMintingEnabled(): boolean {
  return process.env.ALLOW_SCHEDULED_MAINNET_MINTING === "true";
}

function getScheduledMintLockStatusText(chain: MintChain, mode: MintJobMode) {
  if (chain === "sepolia") {
    return "Sepolia scheduled test minting can auto-submit without mainnet locks.";
  }

  if (mode !== "auto") {
    return "Watch mode never auto-sends mainnet transactions.";
  }

  return isMainnetMintingEnabled() && isScheduledMainnetMintingEnabled()
    ? "Mainnet scheduled auto-mint locks are enabled."
    : "Mainnet scheduled auto-minting requires ALLOW_MAINNET_MINTING=true and ALLOW_SCHEDULED_MAINNET_MINTING=true.";
}

function getMintSchedulerPollMs() {
  const configured = Number(process.env.MINT_SCHEDULER_POLL_MS);

  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_MINT_SCHEDULER_POLL_MS;
  }

  return Math.max(Math.floor(configured), MIN_MINT_SCHEDULER_POLL_MS);
}

function getMaxMultiMintWallets() {
  const configured = Number(process.env.MAX_MULTI_MINT_WALLETS);

  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_MAX_MULTI_MINT_WALLETS;
  }

  return Math.min(Math.floor(configured), HARD_MAX_MULTI_MINT_WALLETS);
}

function getMultiMintConcurrency() {
  const configured = Number(process.env.MAX_MULTI_MINT_CONCURRENCY);

  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_MULTI_MINT_CONCURRENCY;
  }

  return Math.min(Math.floor(configured), HARD_MAX_MULTI_MINT_CONCURRENCY);
}

function getMultiMintDelayMs() {
  const configured = Number(process.env.MULTI_MINT_DELAY_MS);

  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_MULTI_MINT_DELAY_MS;
  }

  return Math.max(Math.floor(configured), MIN_MULTI_MINT_DELAY_MS);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeMintTargetName(name: string): string {
  const normalized = name.trim();

  if (!MINT_TARGET_NAME_PATTERN.test(normalized)) {
    throw new Error(
      "Mint target name must be 2-40 characters and use only letters, numbers, hyphen, or underscore."
    );
  }

  return normalized;
}

function parseMintCommandParams(parts: string[]): MintCommandParams {
  if (parts.length < 6) {
    throw new Error(
      "Invalid format. Use: /mainmintpreview wallet1 0xCONTRACT mint(uint256) 1 0.03 mainnet"
    );
  }

  const walletLabel = getCommandPart(parts, 1);
  const contractRaw = getCommandPart(parts, 2);
  const functionSignature = normalizeMintFunctionSignature(getCommandPart(parts, 3));
  const quantity = validateMintQuantity(getCommandPart(parts, 4));
  const priceEth = validateMintPriceEth(getCommandPart(parts, 5));
  const chain = normalizeMintChain(parts[6]);

  if (!ethers.isAddress(contractRaw)) {
    throw new Error("Invalid contract address.");
  }

  return {
    walletLabel,
    contractAddress: ethers.getAddress(contractRaw),
    functionSignature,
    quantity,
    priceEth,
    chain
  };
}

function parseMintTargetParams(parts: string[]) {
  if (parts.length < 6) {
    throw new Error(
      "Invalid format. Use: /addminttarget whaleMint 0xCONTRACT mint(uint256) 1 0.03 mainnet"
    );
  }

  const name = sanitizeMintTargetName(getCommandPart(parts, 1));
  const contractRaw = getCommandPart(parts, 2);
  const functionSignature = normalizeMintFunctionSignature(getCommandPart(parts, 3));
  const quantity = validateMintQuantity(getCommandPart(parts, 4));
  const priceEth = validateMintPriceEth(getCommandPart(parts, 5));
  const chain = normalizeMintChain(parts[6]);

  if (!ethers.isAddress(contractRaw)) {
    throw new Error("Invalid contract address.");
  }

  return {
    name,
    contractAddress: ethers.getAddress(contractRaw),
    functionSignature,
    quantity,
    priceEth,
    chain
  };
}

function parseMintTargetUpdateParams(parts: string[]) {
  if (parts.length < 5) {
    throw new Error(
      "Invalid format. Use: /updateminttarget targetId mint(uint256) 1 0.03 mainnet or /updateminttarget targetId 0xCONTRACT mint(uint256) 1 0.03 mainnet"
    );
  }

  let cursor = 2;
  let contractAddress: string | undefined;
  const possibleContract = parts[cursor]?.trim();

  if (possibleContract && ethers.isAddress(possibleContract)) {
    contractAddress = ethers.getAddress(possibleContract);
    cursor += 1;
  }

  if (parts.length < cursor + 3) {
    throw new Error(
      "Invalid format. Use: /updateminttarget targetId mint(uint256) 1 0.03 mainnet or /updateminttarget targetId 0xCONTRACT mint(uint256) 1 0.03 mainnet"
    );
  }

  return {
    targetId: getCommandPart(parts, 1),
    ...(contractAddress ? { contractAddress } : {}),
    functionSignature: normalizeMintFunctionSignature(getCommandPart(parts, cursor)),
    quantity: validateMintQuantity(getCommandPart(parts, cursor + 1)),
    priceEth: validateMintPriceEth(getCommandPart(parts, cursor + 2)),
    chain: normalizeMintChain(parts[cursor + 3])
  };
}

function formatMintPriceForAudit(priceEth: string) {
  return Number(priceEth);
}

async function auditMintAction(details: {
  ownerTelegramId: string | null;
  action: string;
  walletLabel?: string | undefined;
  walletAddress?: string | undefined;
  targetId?: string | undefined;
  jobId?: string | undefined;
  multiMintJobId?: string | undefined;
  runId?: string | undefined;
  chain?: string | undefined;
  collectionSlug?: string | undefined;
  contractAddress?: string | undefined;
  functionSignature?: string | undefined;
  quantity?: number | undefined;
  candidateFunctions?: string[] | undefined;
  phaseStatus?: string | undefined;
  phaseTypeEstimate?: string | undefined;
  phaseTypeConfidence?: string | undefined;
  priceEth?: string | undefined;
  txHash?: string | undefined;
  mintType?: string | undefined;
  gasStrategyMode?: string | undefined;
  status?: string | undefined;
  reason?: string | undefined;
}) {
  const event: Record<string, string | number | null | string[]> = {
    ownerTelegramId: details.ownerTelegramId,
    action: details.action
  };

  for (const [key, value] of Object.entries(details)) {
    if (key === "ownerTelegramId" || key === "action" || value === undefined) {
      continue;
    }

    event[key] =
      key === "priceEth" && typeof value === "string"
        ? formatMintPriceForAudit(value)
        : value;
  }

  await appendWalletAuditLog(event as any);
}

function formatMintPreviewMessage(
  preview: MintPreviewResult,
  options: { title?: string; runId?: string; targetId?: string } = {}
) {
  const lines = [
    options.title || "Mint Preview",
    "",
    `Wallet: ${preview.walletLabel}`,
    `Address: ${formatShortAddress(preview.walletAddress)}`,
    `Chain: ${preview.chain}`,
    `Contract: ${formatShortAddress(preview.contractAddress)}`,
    `Function: ${preview.functionSignature}`,
    `Quantity: ${preview.quantity}`,
    `Price Each: ${preview.priceEth} ETH`,
    `Total Mint Cost: ${formatEthWithUsd(preview.totalCostEth)}`,
    ...formatGasFields(preview).split("\n"),
    `Minting Lock: ${getMintLockStatusText(preview.chain)}`
  ];

  if (options.targetId) {
    lines.splice(2, 0, `Target ID: ${options.targetId}`);
  }

  if (options.runId) {
    lines.push(`Run ID: ${options.runId}`);
  }

  if (preview.gasEstimateFailed) {
    lines.push(
      "",
      "Gas estimation failed. The mint may not be live, wallet may not be eligible, function may be wrong, or contract may reject the call."
    );

    if (preview.gasEstimateError) {
      lines.push(`Reason: ${preview.gasEstimateError}`);
    }
  }

  return lines.join("\n");
}

function createRunFromPreview(
  ownerTelegramId: string,
  preview: MintPreviewResult,
  status: MintRunStatus,
  targetId?: string,
  jobId?: string
) {
  return createMintRun({
    ownerTelegramId,
    ...(targetId ? { targetId } : {}),
    ...(jobId ? { jobId } : {}),
    walletLabel: preview.walletLabel,
    walletAddress: preview.walletAddress,
    chain: preview.chain,
    contractAddress: preview.contractAddress,
    functionSignature: preview.functionSignature,
    quantity: preview.quantity,
    priceEth: preview.priceEth,
    status
  });
}

function isMintConfirmationExpired(session: MintConfirmationSession) {
  const expiresAtMs = Date.parse(session.expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now();
}

function cleanupMintConfirmations() {
  for (const [sessionId, session] of mintConfirmations.entries()) {
    if (session.status === "active" && isMintConfirmationExpired(session)) {
      session.status = "expired";
    }

    const expiresAtMs = Date.parse(session.expiresAt);
    const cleanupAfterMs = Number.isFinite(expiresAtMs)
      ? expiresAtMs + MINT_CONFIRMATION_TTL_MS
      : Date.now();

    if (cleanupAfterMs <= Date.now()) {
      mintConfirmations.delete(sessionId);
    }
  }
}

function createMintConfirmationSession(params: {
  ownerTelegramId: string;
  walletLabel: string;
  walletAddress: string;
  chain: MintChain;
  contractAddress: string;
  functionSignature: SupportedMintFunctionSignature;
  quantity: number;
  priceEth: string;
  runId: string;
  targetId?: string;
  jobId?: string;
  gasStrategy?: GasStrategy;
}) {
  cleanupMintConfirmations();

  const createdAt = new Date();
  const session: MintConfirmationSession = {
    sessionId: randomUUID(),
    ownerTelegramId: params.ownerTelegramId,
    walletLabel: params.walletLabel,
    walletAddress: params.walletAddress,
    chain: params.chain,
    contractAddress: params.contractAddress,
    functionSignature: params.functionSignature,
    quantity: params.quantity,
    priceEth: params.priceEth,
    runId: params.runId,
    ...(params.targetId ? { targetId: params.targetId } : {}),
    ...(params.jobId ? { jobId: params.jobId } : {}),
    ...(params.gasStrategy ? { gasStrategy: params.gasStrategy } : {}),
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(
      createdAt.getTime() + MINT_CONFIRMATION_TTL_MS
    ).toISOString(),
    status: "active"
  };

  mintConfirmations.set(session.sessionId, session);
  return session;
}

async function validateMintConfirmationSession(
  ctx: Context,
  sessionId: string
): Promise<ValidatedMintConfirmationSession | null> {
  cleanupMintConfirmations();

  const actorTelegramId = getTelegramUserId(ctx);

  if (!actorTelegramId) {
    await ctx.reply("❌ Could not verify your Telegram account for this action.");
    return null;
  }

  const session = mintConfirmations.get(sessionId);

  if (!session) {
    await ctx.reply(MINT_CONFIRMATION_EXPIRED_MESSAGE);
    return null;
  }

  if (session.ownerTelegramId !== actorTelegramId) {
    await auditMintAction({
      ownerTelegramId: session.ownerTelegramId,
      action: "mint_blocked",
      walletLabel: session.walletLabel,
      walletAddress: session.walletAddress,
      targetId: session.targetId,
      runId: session.runId,
      chain: session.chain,
      contractAddress: session.contractAddress,
      functionSignature: session.functionSignature,
      quantity: session.quantity,
      priceEth: session.priceEth,
      status: session.status,
      reason: `wrong_user:actor=${actorTelegramId}`
    });
    await ctx.reply(MINT_CONFIRMATION_WRONG_USER_MESSAGE);
    return null;
  }

  if (session.status === "expired" || isMintConfirmationExpired(session)) {
    session.status = "expired";
    await auditMintAction({
      ownerTelegramId: session.ownerTelegramId,
      action: "mint_blocked",
      walletLabel: session.walletLabel,
      walletAddress: session.walletAddress,
      targetId: session.targetId,
      runId: session.runId,
      chain: session.chain,
      contractAddress: session.contractAddress,
      functionSignature: session.functionSignature,
      quantity: session.quantity,
      priceEth: session.priceEth,
      status: session.status,
      reason: "expired"
    });
    updateMintRunForOwner(session.runId, session.ownerTelegramId, {
      status: "blocked",
      errorReason: "confirmation_expired"
    });
    await ctx.reply(MINT_CONFIRMATION_EXPIRED_MESSAGE);
    return null;
  }

  if (session.status === "used" || session.status === "cancelled") {
    await auditMintAction({
      ownerTelegramId: session.ownerTelegramId,
      action: "mint_blocked",
      walletLabel: session.walletLabel,
      walletAddress: session.walletAddress,
      targetId: session.targetId,
      runId: session.runId,
      chain: session.chain,
      contractAddress: session.contractAddress,
      functionSignature: session.functionSignature,
      quantity: session.quantity,
      priceEth: session.priceEth,
      status: session.status,
      reason: "already_used_or_cancelled"
    });
    await ctx.reply(MINT_CONFIRMATION_ALREADY_USED_MESSAGE);
    return null;
  }

  return { session, actorTelegramId };
}

function isMultiMintConfirmationExpired(session: MultiMintConfirmationSession) {
  const expiresAtMs = Date.parse(session.expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now();
}

function cleanupMultiMintConfirmations() {
  for (const [sessionId, session] of multiMintConfirmations.entries()) {
    if (session.status === "active" && isMultiMintConfirmationExpired(session)) {
      session.status = "expired";
    }

    const expiresAtMs = Date.parse(session.expiresAt);
    const cleanupAfterMs = Number.isFinite(expiresAtMs)
      ? expiresAtMs + MULTI_MINT_CONFIRMATION_TTL_MS
      : Date.now();

    if (cleanupAfterMs <= Date.now()) {
      multiMintConfirmations.delete(sessionId);
    }
  }
}

function createMultiMintConfirmationSession(params: {
  ownerTelegramId: string;
  targetId: string;
  targetName: string;
  chain: MintChain;
  contractAddress: string;
  functionSignature: SupportedMintFunctionSignature;
  quantity: number;
  priceEth: string;
  walletLabels: string[];
  walletAddresses: string[];
  gasStrategy: GasStrategy;
  multiMintJobId?: string;
}) {
  cleanupMultiMintConfirmations();

  const createdAt = new Date();
  const session: MultiMintConfirmationSession = {
    sessionId: randomUUID(),
    ownerTelegramId: params.ownerTelegramId,
    targetId: params.targetId,
    targetName: params.targetName,
    chain: params.chain,
    contractAddress: params.contractAddress,
    functionSignature: params.functionSignature,
    quantity: params.quantity,
    priceEth: params.priceEth,
    walletLabels: params.walletLabels,
    walletAddresses: params.walletAddresses,
    gasStrategy: params.gasStrategy,
    ...(params.multiMintJobId ? { multiMintJobId: params.multiMintJobId } : {}),
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(
      createdAt.getTime() + MULTI_MINT_CONFIRMATION_TTL_MS
    ).toISOString(),
    status: "active"
  };

  multiMintConfirmations.set(session.sessionId, session);
  return session;
}

async function validateMultiMintConfirmationSession(
  ctx: Context,
  sessionId: string
) {
  cleanupMultiMintConfirmations();

  const actorTelegramId = getTelegramUserId(ctx);

  if (!actorTelegramId) {
    await ctx.reply("❌ Could not verify your Telegram account for this action.");
    return null;
  }

  const session = multiMintConfirmations.get(sessionId);

  if (!session) {
    await ctx.reply("This multi-mint confirmation has expired. Please create it again.");
    return null;
  }

  if (session.ownerTelegramId !== actorTelegramId) {
    await auditMintAction({
      ownerTelegramId: session.ownerTelegramId,
      action: "multi_mint_wallet_blocked",
      targetId: session.targetId,
      multiMintJobId: session.multiMintJobId,
      chain: session.chain,
      contractAddress: session.contractAddress,
      functionSignature: session.functionSignature,
      quantity: session.quantity,
      priceEth: session.priceEth,
      gasStrategyMode: session.gasStrategy.mode,
      status: session.status,
      reason: `wrong_user:actor=${actorTelegramId}`
    });
    await ctx.reply("You cannot use this multi-mint confirmation.");
    return null;
  }

  if (session.status === "expired" || isMultiMintConfirmationExpired(session)) {
    session.status = "expired";
    await auditMintAction({
      ownerTelegramId: session.ownerTelegramId,
      action: "multi_mint_wallet_blocked",
      targetId: session.targetId,
      multiMintJobId: session.multiMintJobId,
      chain: session.chain,
      contractAddress: session.contractAddress,
      functionSignature: session.functionSignature,
      quantity: session.quantity,
      priceEth: session.priceEth,
      gasStrategyMode: session.gasStrategy.mode,
      status: session.status,
      reason: "expired"
    });
    await ctx.reply("This multi-mint confirmation has expired. Please create it again.");
    return null;
  }

  if (session.status === "used" || session.status === "cancelled") {
    await auditMintAction({
      ownerTelegramId: session.ownerTelegramId,
      action: "multi_mint_wallet_blocked",
      targetId: session.targetId,
      multiMintJobId: session.multiMintJobId,
      chain: session.chain,
      contractAddress: session.contractAddress,
      functionSignature: session.functionSignature,
      quantity: session.quantity,
      priceEth: session.priceEth,
      gasStrategyMode: session.gasStrategy.mode,
      status: session.status,
      reason: "already_used_or_cancelled"
    });
    await ctx.reply("This multi-mint confirmation has already been used or cancelled.");
    return null;
  }

  return { session, actorTelegramId };
}

function formatMintTarget(target: MintTarget) {
  const missing = getMintTargetMissingFields(target);
  const metadata = target.detectedMetadata;
  return [
    `Name: ${target.name}`,
    `Target ID: ${target.targetId}`,
    `Status: ${target.targetCompleteness === "complete" ? target.status : "Incomplete"}`,
    ...(target.targetCompleteness === "incomplete"
      ? [`Missing: ${missing.join(", ") || "Unknown"}`]
      : []),
    `Chain: ${target.chain}`,
    `Contract: ${target.contractAddress ? formatShortAddress(target.contractAddress) : "Unknown"}`,
    `Function: ${target.functionSignature || "Unknown"}`,
    `Qty: ${target.quantity}`,
    `Price: ${target.priceEth === undefined ? "Unknown" : `${target.priceEth} ETH`}`,
    ...(target.mintType
      ? [
          `Mint Type: ${target.mintType}`,
          `Retries: ${target.maxRetries ?? getMintTypeDefaults(target.mintType).maxRetries}`,
          `Retry Delay: ${target.retryDelayMs ?? getMintTypeDefaults(target.mintType).retryDelayMs}ms`
        ]
      : []),
    `Gas Strategy: ${formatGasStrategy(target.gasStrategy)}`,
    ...(target.collectionSlug ? [`Collection Slug: ${target.collectionSlug}`] : []),
    ...(target.sourceUrl ? [`Source: ${target.sourceUrl}`] : []),
    ...(metadata?.collectionName ? [`Detected Collection: ${metadata.collectionName}`] : []),
    ...(metadata?.candidateFunctions?.length
      ? [`Detected Functions: ${metadata.candidateFunctions.join(", ")}`]
      : []),
    ...(metadata?.phaseStatus ? [`Detected Phase Status: ${metadata.phaseStatus}`] : []),
    ...(metadata?.phaseTypeEstimate
      ? [`Detected Phase Type: ${metadata.phaseTypeEstimate} (${metadata.phaseTypeConfidence || "unknown"})`]
      : []),
    ...(metadata?.openSeaMint ? ["", ...formatOpenSeaMintMetadata(metadata.openSeaMint)] : []),
    `Created: ${target.createdAt}`,
    `Updated: ${target.updatedAt}`
  ].join("\n");
}

function requireCompleteMintTarget(target: MintTarget) {
  const missing = getMintTargetMissingFields(target);

  if (missing.length > 0 || !target.functionSignature || target.priceEth === undefined) {
    throw new Error(
      `Mint target is incomplete. Missing: ${missing.join(", ") || "unknown"}. Complete it with /updateminttarget.`
    );
  }

  return {
    ...target,
    functionSignature: target.functionSignature,
    priceEth: target.priceEth,
    targetCompleteness: calculateMintTargetCompleteness(target)
  };
}

function getTargetGasStrategy(target: MintTarget): GasStrategy {
  return target.gasStrategy || createDefaultGasStrategy();
}

function parseWalletLabelList(rawWallets: string) {
  const labels = rawWallets
    .split(",")
    .map((label) => normalizeWalletLabel(label))
    .filter(Boolean);
  const seen = new Set<string>();

  if (labels.length === 0) {
    throw new Error("At least one wallet label is required.");
  }

  for (const label of labels) {
    if (!isValidWalletLabel(label)) {
      throw new Error(`Invalid wallet label: ${label}`);
    }

    if (seen.has(label)) {
      throw new Error(`Duplicate wallet label: ${label}`);
    }

    seen.add(label);
  }

  const maxWallets = getMaxMultiMintWallets();

  if (labels.length > maxWallets) {
    throw new Error(`Too many wallets. Maximum allowed is ${maxWallets}.`);
  }

  return labels;
}

async function getOwnedActiveWalletSummaries(ownerTelegramId: string, walletLabels: string[]) {
  const wallets = [];

  for (const walletLabel of walletLabels) {
    const wallet = await getWalletSummaryByLabelForOwner(walletLabel, ownerTelegramId);

    if (wallet.status === "archived") {
      throw new Error(`Wallet "${wallet.label}" is archived and cannot be used.`);
    }

    wallets.push(wallet);
  }

  return wallets;
}

function getEthUsdPrice(): number | null {
  const rawPrice = process.env.ETH_USD_PRICE || process.env.ETH_PRICE_USD;

  if (!rawPrice?.trim()) {
    return null;
  }

  const parsed = Number(rawPrice);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function formatUsd(value: number): string {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function formatEthWithUsd(ethValue?: string | null): string {
  if (!ethValue) {
    return "Not available";
  }

  const ethUsdPrice = getEthUsdPrice();

  if (!ethUsdPrice) {
    return `${ethValue} ETH`;
  }

  const parsedEth = Number(ethValue);

  if (!Number.isFinite(parsedEth)) {
    return `${ethValue} ETH`;
  }

  return `${ethValue} ETH (~${formatUsd(parsedEth * ethUsdPrice)})`;
}

function formatEthUsdSourceLine(): string {
  const ethUsdPrice = getEthUsdPrice();

  if (!ethUsdPrice) {
    return "USD Budget: Set ETH_USD_PRICE in .env to show USD estimates.";
  }

  return `USD Budget Rate: 1 ETH = ${formatUsd(ethUsdPrice)}`;
}

function getPreviewFeeGwei(preview: MintPreviewResult): number | null {
  const rawFee = preview.maxFeeGwei || preview.gasPriceGwei;

  if (!rawFee) {
    return null;
  }

  const parsed = Number(rawFee);

  return Number.isFinite(parsed) ? parsed : null;
}

function formatGasAdvisor(preview: MintPreviewResult): string {
  const gasError = preview.gasEstimateError || "";

  if (
    preview.fundedEnough === false ||
    /low balance|insufficient|insufficient funds|wallet balance/i.test(gasError)
  ) {
    return "Blocked: wallet balance is too low for mint cost plus gas. Top up this wallet or use another wallet.";
  }

  if (preview.gasEstimateFailed) {
    return "Blocked: gas estimation failed. Check mint live status, wallet eligibility, price, function, and route.";
  }

  const feeGwei = getPreviewFeeGwei(preview);

  if (feeGwei !== null && feeGwei >= 150) {
    return "High risk: fee cap is very high. Consider waiting, lowering gas, or using a smaller wallet set.";
  }

  if (feeGwei !== null && feeGwei >= 60) {
    return "Elevated: gas is above normal. Confirm only if speed matters.";
  }

  const gasCostEth = Number(preview.estimatedGasCostEth || "0");
  const mintCostEth = Number(preview.totalCostEth);

  if (
    Number.isFinite(gasCostEth) &&
    Number.isFinite(mintCostEth) &&
    mintCostEth > 0 &&
    gasCostEth > mintCostEth * 0.5
  ) {
    return "Review: gas cost is high compared with the mint price.";
  }

  return "Normal: gas looks acceptable for the selected strategy.";
}

function formatMultiGasBudgetSummary(previews: MintPreviewResult[]) {
  if (previews.length === 0) {
    return ["Wallets Previewed: 0"];
  }

  const estimatedGasCostWei = previews.reduce(
    (total, preview) => total + (preview.estimatedGasCostWei ?? 0n),
    0n
  );
  const estimatedTotalCostWei = previews.reduce(
    (total, preview) => total + (preview.estimatedTotalCostWei ?? 0n),
    0n
  );
  const underfundedCount = previews.filter((preview) => preview.fundedEnough === false).length;
  const failedGasCount = previews.filter((preview) => preview.gasEstimateFailed).length;

  return [
    `Wallets Previewed: ${previews.length}`,
    `Estimated Gas Budget: ${formatEthWithUsd(ethers.formatEther(estimatedGasCostWei))}`,
    `Estimated Total Budget: ${formatEthWithUsd(ethers.formatEther(estimatedTotalCostWei))}`,
    `Underfunded Wallets: ${underfundedCount}`,
    `Gas Estimate Failures: ${failedGasCount}`,
    formatEthUsdSourceLine()
  ];
}

function formatGasFields(preview: MintPreviewResult) {
  return [
    `Gas Strategy: ${preview.gasStrategyMode || "auto"}`,
    `Estimated Gas Units: ${preview.gasEstimate || "Not available"}`,
    ...(preview.gasLimit ? [`Gas Limit: ${preview.gasLimit}`] : []),
    ...(preview.maxFeeGwei ? [`Max Fee: ${preview.maxFeeGwei} gwei`] : []),
    ...(preview.maxPriorityFeeGwei ? [`Priority Fee: ${preview.maxPriorityFeeGwei} gwei`] : []),
    ...(preview.gasPriceGwei ? [`Gas Price: ${preview.gasPriceGwei} gwei`] : []),
    ...(preview.estimatedGasCostEth
      ? [`Estimated Gas Cost: ${formatEthWithUsd(preview.estimatedGasCostEth)}`]
      : []),
    ...(preview.estimatedTotalCostEth
      ? [`Estimated Total Cost: ${formatEthWithUsd(preview.estimatedTotalCostEth)}`]
      : []),
    ...(preview.walletBalanceEth
      ? [
          `Wallet Balance: ${formatEthWithUsd(preview.walletBalanceEth)}`,
          `Funded Enough: ${preview.fundedEnough ? "yes" : "no"}`
        ]
      : []),
    `Gas Advisor: ${formatGasAdvisor(preview)}`,
    formatEthUsdSourceLine()
  ].join("\n");
}

function normalizeMintJobMode(rawMode?: string): MintJobMode {
  const normalized = rawMode?.trim().toLowerCase();

  if (!normalized || normalized === "watch") {
    return "watch";
  }

  if (normalized === "auto") {
    return "auto";
  }

  throw new Error("Mode must be watch or auto.");
}

function validateScheduleStartTime(rawStartTime: string) {
  const parsed = Date.parse(rawStartTime);

  if (!Number.isFinite(parsed)) {
    throw new Error("Start time must be a valid ISO date/time.");
  }

  return new Date(parsed).toISOString();
}

function phaseTypeEstimateToMintType(
  phaseTypeEstimate?: string
): MintJobMintType | undefined {
  if (phaseTypeEstimate === "team_phase") return "team";
  if (phaseTypeEstimate === "holder_phase") return "holder";
  if (phaseTypeEstimate === "gtd_phase") return "gtd";
  if (phaseTypeEstimate === "fcfs_phase") return "fcfs";
  if (phaseTypeEstimate === "public_phase") return "public";
  return undefined;
}

function mintTypeToPhaseTypeEstimate(mintType: MintJobMintType) {
  if (mintType === "team") return "team_phase";
  if (mintType === "holder") return "holder_phase";
  if (mintType === "gtd") return "gtd_phase";
  if (mintType === "fcfs") return "fcfs_phase";
  if (mintType === "public") return "public_phase";
  return "unknown";
}

function normalizePhaseMintType(rawPhaseType: string): MintJobMintType {
  const mintType = normalizeMintJobMintType(rawPhaseType);

  if (mintType === "manual") {
    throw new Error("Use /schedulemint with an ISO time for manual schedules.");
  }

  return mintType;
}

function getTargetPhaseTypeEstimate(target: MintTarget) {
  const currentStage = getOpenSeaMintCurrentStage(
    target.detectedMetadata?.openSeaMint
  );

  return (
    currentStage?.phaseTypeEstimate ||
    target.detectedMetadata?.phaseTypeEstimate ||
    undefined
  );
}

function getTargetMintType(target: MintTarget): MintJobMintType {
  return (
    target.mintType ||
    phaseTypeEstimateToMintType(getTargetPhaseTypeEstimate(target)) ||
    "manual"
  );
}

function getTargetMintTypeSettings(target: MintTarget) {
  const mintType = getTargetMintType(target);
  const defaults = getMintTypeDefaults(mintType);

  return {
    mintType,
    maxRetries:
      target.maxRetries === undefined
        ? defaults.maxRetries
        : Math.min(Math.max(Math.floor(target.maxRetries), 0), 5),
    retryDelayMs:
      target.retryDelayMs === undefined
        ? defaults.retryDelayMs
        : Math.max(0, Math.floor(target.retryDelayMs))
  };
}

function findMintScheduleStageForType(
  target: MintTarget,
  mintType: MintJobMintType
): OpenSeaMintStage | undefined {
  const phaseTypeEstimate = mintTypeToPhaseTypeEstimate(mintType);

  return target.detectedMetadata?.openSeaMint?.mintSchedule.find(
    (stage) => stage.phaseTypeEstimate === phaseTypeEstimate
  );
}

function getStageStartTimeISO(stage: OpenSeaMintStage) {
  const rawStart = stage.startTimeText;

  if (!rawStart) {
    throw new Error("Matching phase was detected, but no start time is available.");
  }

  return validateScheduleStartTime(rawStart);
}

async function createMintJobForTarget(params: {
  ownerTelegramId: string;
  target: MintTarget;
  walletLabel: string;
  startTimeISO: string;
  mode: MintJobMode;
  mintType?: MintJobMintType;
}) {
  const target = requireCompleteMintTarget(params.target);
  const wallet = await getWalletSummaryByLabelForOwner(
    params.walletLabel,
    params.ownerTelegramId
  );
  const targetSettings = getTargetMintTypeSettings(target);
  const mintType = params.mintType || targetSettings.mintType;
  const defaults = getMintTypeDefaults(mintType);
  const phaseTypeEstimate = getTargetPhaseTypeEstimate(target);

  return createMintJob({
    ownerTelegramId: params.ownerTelegramId,
    targetId: target.targetId,
    targetName: target.name,
    walletLabel: wallet.label,
    walletAddress: wallet.address,
    chain: target.chain,
    contractAddress: target.contractAddress,
    functionSignature: target.functionSignature,
    quantity: target.quantity,
    priceEth: target.priceEth,
    mintType,
    ...(phaseTypeEstimate ? { phaseTypeEstimate } : {}),
    startTimeISO: params.startTimeISO,
    mode: params.mode,
    maxRetries:
      params.mintType && params.mintType !== targetSettings.mintType
        ? defaults.maxRetries
        : targetSettings.maxRetries,
    retryDelayMs:
      params.mintType && params.mintType !== targetSettings.mintType
        ? defaults.retryDelayMs
        : targetSettings.retryDelayMs
  });
}

function formatMintTypeWarning(mintType: MintJobMintType) {
  if (mintType === "team") {
    return "Team mint warning: normal users may not be eligible.";
  }

  if (mintType === "holder") {
    return "Holder mint warning: holder eligibility must be verified separately unless readiness/gas check succeeds.";
  }

  if (mintType === "gtd") {
    return "GTD mint note: this is intended for guaranteed/allowlist style minting, but eligibility is not guaranteed.";
  }

  if (mintType === "fcfs") {
    return "FCFS mint note: retries are limited and success is never guaranteed.";
  }

  return "";
}

function formatMintJob(job: MintJob) {
  return [
    `Job ID: ${job.jobId}`,
    `Status: ${job.status}`,
    `Mode: ${job.mode}`,
    `Auto-submit: ${job.autoSubmit ? "yes" : "no"}`,
    `Target: ${job.targetName}`,
    `Target ID: ${job.targetId}`,
    `Wallet: ${job.walletLabel}`,
    `Address: ${formatShortAddress(job.walletAddress)}`,
    `Chain: ${job.chain}`,
    `Contract: ${formatShortAddress(job.contractAddress)}`,
    `Function: ${job.functionSignature}`,
    `Qty: ${job.quantity}`,
    `Price Each: ${job.priceEth} ETH`,
    `Mint Type: ${job.mintType}`,
    ...(job.phaseTypeEstimate ? [`Phase Estimate: ${job.phaseTypeEstimate}`] : []),
    `Start: ${job.startTimeISO}`,
    ...(job.endTimeISO ? [`End: ${job.endTimeISO}`] : []),
    `Attempts: ${job.attempts}/${job.maxRetries}`,
    `Retry Delay: ${job.retryDelayMs}ms`,
    ...(job.lastCheckedAt ? [`Last Checked: ${job.lastCheckedAt}`] : []),
    ...(job.lastRunId ? [`Last Run ID: ${job.lastRunId}`] : []),
    ...(job.txHash ? [`Tx: ${job.txHash}`] : []),
    ...(job.safeErrorReason ? [`Reason: ${job.safeErrorReason}`] : []),
    `Created: ${job.createdAt}`,
    `Updated: ${job.updatedAt}`
  ].join("\n");
}

function formatMintJobList(jobs: MintJob[]) {
  if (jobs.length === 0) {
    return "No active mint jobs found.";
  }

  return jobs
    .map((job, index) =>
      [
        `${index + 1}. ${job.targetName}`,
        `Job ID: ${job.jobId}`,
        `Wallet: ${job.walletLabel}`,
        `Chain: ${job.chain}`,
        `Mint Type: ${job.mintType}`,
        `Start: ${job.startTimeISO}`,
        `Mode: ${job.mode}`,
        `Status: ${job.status}`,
        `Attempts: ${job.attempts}/${job.maxRetries}`,
        `Last Checked: ${job.lastCheckedAt || "Never"}`
      ].join("\n")
    )
    .join("\n\n");
}

function formatMultiMintJob(job: MultiMintJob) {
  return [
    `Multi-Mint Job ID: ${job.jobId}`,
    `Status: ${job.status}`,
    `Mode: ${job.mode}`,
    `Target: ${job.targetName}`,
    `Target ID: ${job.targetId}`,
    `Chain: ${job.chain}`,
    `Contract: ${formatShortAddress(job.contractAddress)}`,
    `Function: ${job.functionSignature}`,
    `Qty: ${job.quantity}`,
    `Price Each: ${job.priceEth} ETH`,
    `Gas Strategy: ${formatGasStrategy(job.gasStrategy)}`,
    `Wallet Count: ${job.walletLabels.length}`,
    `Start: ${job.startTimeISO}`,
    ...(job.endTimeISO ? [`End: ${job.endTimeISO}`] : []),
    `Attempts: ${job.attempts}/${job.maxRetries}`,
    `Retry Delay: ${job.retryDelayMs}ms`,
    ...(job.lastCheckedAt ? [`Last Checked: ${job.lastCheckedAt}`] : []),
    ...(job.safeErrorReason ? [`Reason: ${job.safeErrorReason}`] : []),
    "",
    "Wallet Results:",
    ...job.childResults.map((child) =>
      [
        `- ${child.walletLabel}: ${child.status}`,
        `  Address: ${formatShortAddress(child.walletAddress)}`,
        ...(child.runId ? [`  Run ID: ${child.runId}`] : []),
        ...(child.txHash ? [`  Tx: ${child.txHash}`] : []),
        ...(child.safeErrorReason ? [`  Reason: ${child.safeErrorReason}`] : []),
        `  Attempts: ${child.attempts}`
      ].join("\n")
    ),
    "",
    `Created: ${job.createdAt}`,
    `Updated: ${job.updatedAt}`
  ].join("\n");
}

function formatMultiMintJobList(jobs: MultiMintJob[]) {
  if (jobs.length === 0) {
    return "No active multi-mint jobs found.";
  }

  return jobs
    .map((job, index) =>
      [
        `${index + 1}. ${job.targetName}`,
        `Job ID: ${job.jobId}`,
        `Chain: ${job.chain}`,
        `Mode: ${job.mode}`,
        `Status: ${job.status}`,
        `Start: ${job.startTimeISO}`,
        `Wallets: ${job.walletLabels.length}`,
        `Attempts: ${job.attempts}/${job.maxRetries}`
      ].join("\n")
    )
    .join("\n\n");
}

async function sendMultiMintJobAlert(job: MultiMintJob, message: string) {
  try {
    await bot.telegram.sendMessage(job.ownerTelegramId, message);
  } catch (error) {
    logSafeError("Multi-mint job alert failed", error);
  }
}

async function createMultiMintJobForTarget(params: {
  ownerTelegramId: string;
  target: MintTarget;
  walletLabels: string[];
  startTimeISO: string;
  mode: MintJobMode;
}) {
  const target = requireCompleteMintTarget(params.target);
  const wallets = await getOwnedActiveWalletSummaries(
    params.ownerTelegramId,
    params.walletLabels
  );
  const targetSettings = getTargetMintTypeSettings(target);

  return createMultiMintJob({
    ownerTelegramId: params.ownerTelegramId,
    targetId: target.targetId,
    targetName: target.name,
    chain: target.chain,
    contractAddress: target.contractAddress,
    functionSignature: target.functionSignature,
    quantity: target.quantity,
    priceEth: target.priceEth,
    walletLabels: wallets.map((wallet) => wallet.label),
    walletAddresses: wallets.map((wallet) => wallet.address),
    gasStrategy: getTargetGasStrategy(target),
    mode: params.mode,
    startTimeISO: params.startTimeISO,
    maxRetries: targetSettings.maxRetries,
    retryDelayMs: targetSettings.retryDelayMs
  });
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
) {
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(concurrency, 1), items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await worker(items[index]!, index);
      }
    }
  );

  await Promise.all(workers);
}

function createSubmissionDelayGate(delayMs: number) {
  let nextSubmissionAt = 0;
  let chain = Promise.resolve();

  return async () => {
    let release!: () => void;
    const previous = chain;
    chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      const waitMs = Math.max(0, nextSubmissionAt - Date.now());

      if (waitMs > 0) {
        await sleep(waitMs);
      }

      nextSubmissionAt = Date.now() + delayMs;
    } finally {
      release();
    }
  };
}

type MultiMintWalletExecutionResult = {
  walletLabel: string;
  walletAddress: string;
  status: "submitted" | "confirmed" | "failed" | "blocked";
  runId?: string;
  txHash?: string;
  safeErrorReason?: string;
};

function getMultiMintSummaryStatus(results: MultiMintWalletExecutionResult[]) {
  const confirmed = results.filter((result) => result.status === "confirmed").length;
  const submitted = results.filter((result) => result.status === "submitted").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const blocked = results.filter((result) => result.status === "blocked").length;

  if (confirmed === results.length) {
    return "confirmed";
  }

  if (confirmed > 0 || submitted > 0) {
    return failed > 0 || blocked > 0 ? "partial" : "submitted";
  }

  if (blocked > 0 && failed === 0) {
    return "blocked";
  }

  return "failed";
}

function formatMultiMintExecutionSummary(results: MultiMintWalletExecutionResult[]) {
  const submitted = results.filter((result) => result.status === "submitted").length;
  const confirmed = results.filter((result) => result.status === "confirmed").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const blocked = results.filter((result) => result.status === "blocked").length;

  return [
    `Submitted: ${submitted}`,
    `Confirmed: ${confirmed}`,
    `Failed: ${failed}`,
    `Blocked: ${blocked}`,
    "",
    "Per-wallet results:",
    ...results.map((result) =>
      [
        `- ${result.walletLabel}: ${result.status}`,
        `  Address: ${formatShortAddress(result.walletAddress)}`,
        ...(result.runId ? [`  Run ID: ${result.runId}`] : []),
        ...(result.txHash ? [`  Tx: ${result.txHash}`] : []),
        ...(result.safeErrorReason ? [`  Reason: ${result.safeErrorReason}`] : [])
      ].join("\n")
    )
  ].join("\n");
}

async function executeMultiMint(params: {
  ownerTelegramId: string;
  targetId: string;
  targetName: string;
  chain: MintChain;
  contractAddress: string;
  functionSignature: SupportedMintFunctionSignature;
  quantity: number;
  priceEth: string;
  walletLabels: string[];
  walletAddresses: string[];
  gasStrategy: GasStrategy;
  multiMintJobId?: string;
  requireScheduledMainnetLock: boolean;
  notify?: (message: string) => Promise<void>;
}) {
  if (params.chain === "mainnet" && !isMainnetMintingEnabled()) {
    throw new Error(MAINNET_MINTING_DISABLED_MESSAGE);
  }

  if (
    params.chain === "mainnet" &&
    params.requireScheduledMainnetLock &&
    !isScheduledMainnetMintingEnabled()
  ) {
    throw new Error(
      "Scheduled mainnet multi-minting requires ALLOW_SCHEDULED_MAINNET_MINTING=true."
    );
  }

  const results: MultiMintWalletExecutionResult[] = params.walletLabels.map(
    (walletLabel, index) => ({
      walletLabel,
      walletAddress: params.walletAddresses[index]!,
      status: "blocked" as const,
      safeErrorReason: "not_started"
    })
  );
  const delayGate = createSubmissionDelayGate(getMultiMintDelayMs());
  const concurrency = getMultiMintConcurrency();

  await auditMintAction({
    ownerTelegramId: params.ownerTelegramId,
    action: "multi_mint_started",
    targetId: params.targetId,
    multiMintJobId: params.multiMintJobId,
    chain: params.chain,
    contractAddress: params.contractAddress,
    functionSignature: params.functionSignature,
    quantity: params.quantity,
    priceEth: params.priceEth,
    gasStrategyMode: params.gasStrategy.mode,
    status: "started",
    reason: `wallets:${params.walletLabels.length};concurrency:${concurrency}`
  });

  await runWithConcurrency(params.walletLabels, concurrency, async (walletLabel, index) => {
    const walletAddress = params.walletAddresses[index]!;
    let run: MintRun | undefined;

    try {
      const preview = await previewMint({
        ownerTelegramId: params.ownerTelegramId,
        walletLabel,
        contractAddress: params.contractAddress,
        functionSignature: params.functionSignature,
        quantity: params.quantity,
        priceEth: params.priceEth,
        chain: params.chain,
        gasStrategy: params.gasStrategy
      });

      if (preview.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
        throw new Error("Wallet multi-mint snapshot no longer matches the saved wallet.");
      }

      run = createMintRun({
        ownerTelegramId: params.ownerTelegramId,
        targetId: params.targetId,
        ...(params.multiMintJobId ? { multiMintJobId: params.multiMintJobId } : {}),
        walletLabel: preview.walletLabel,
        walletAddress: preview.walletAddress,
        chain: preview.chain,
        contractAddress: preview.contractAddress,
        functionSignature: preview.functionSignature,
        quantity: preview.quantity,
        priceEth: preview.priceEth,
        status: "pending"
      });

      if (params.multiMintJobId) {
        updateMultiMintChildResult(
          params.multiMintJobId,
          params.ownerTelegramId,
          walletLabel,
          {
            runId: run.runId,
            attempts: 1
          }
        );
      }

      if (preview.gasEstimateFailed) {
        const reason = preview.gasEstimateError || "gas_estimation_failed";
        updateMintRunForOwner(run.runId, params.ownerTelegramId, {
          status: "blocked",
          errorReason: reason
        });
        if (params.multiMintJobId) {
          updateMultiMintChildResult(
            params.multiMintJobId,
            params.ownerTelegramId,
            walletLabel,
            {
              status: "blocked",
              safeErrorReason: reason
            }
          );
        }
        results[index] = {
          walletLabel,
          walletAddress: preview.walletAddress,
          status: "blocked",
          runId: run.runId,
          safeErrorReason: reason
        };
        await auditMintAction({
          ownerTelegramId: params.ownerTelegramId,
          action: "multi_mint_wallet_blocked",
          targetId: params.targetId,
          multiMintJobId: params.multiMintJobId,
          runId: run.runId,
          walletLabel,
          walletAddress: preview.walletAddress,
          chain: params.chain,
          contractAddress: params.contractAddress,
          functionSignature: params.functionSignature,
          quantity: params.quantity,
          priceEth: params.priceEth,
          gasStrategyMode: params.gasStrategy.mode,
          status: "blocked",
          reason
        });
        return;
      }

      if (preview.fundedEnough === false) {
        const reason = "insufficient_native_balance_for_estimated_total";
        updateMintRunForOwner(run.runId, params.ownerTelegramId, {
          status: "blocked",
          errorReason: reason
        });
        if (params.multiMintJobId) {
          updateMultiMintChildResult(
            params.multiMintJobId,
            params.ownerTelegramId,
            walletLabel,
            {
              status: "blocked",
              safeErrorReason: reason
            }
          );
        }
        results[index] = {
          walletLabel,
          walletAddress: preview.walletAddress,
          status: "blocked",
          runId: run.runId,
          safeErrorReason: reason
        };
        await auditMintAction({
          ownerTelegramId: params.ownerTelegramId,
          action: "multi_mint_wallet_blocked",
          targetId: params.targetId,
          multiMintJobId: params.multiMintJobId,
          runId: run.runId,
          walletLabel,
          walletAddress: preview.walletAddress,
          chain: params.chain,
          contractAddress: params.contractAddress,
          functionSignature: params.functionSignature,
          quantity: params.quantity,
          priceEth: params.priceEth,
          gasStrategyMode: params.gasStrategy.mode,
          status: "blocked",
          reason
        });
        return;
      }

      await delayGate();
      const submitted = await submitMintTransaction({
        ownerTelegramId: params.ownerTelegramId,
        walletLabel,
        contractAddress: params.contractAddress,
        functionSignature: params.functionSignature,
        quantity: params.quantity,
        priceEth: params.priceEth,
        chain: params.chain,
        gasStrategy: params.gasStrategy
      });

      updateMintRunForOwner(run.runId, params.ownerTelegramId, {
        status: "submitted",
        txHash: submitted.txHash
      });
      if (params.multiMintJobId) {
        updateMultiMintChildResult(
          params.multiMintJobId,
          params.ownerTelegramId,
          walletLabel,
          {
            status: "submitted",
            runId: run.runId,
            txHash: submitted.txHash
          }
        );
      }
      results[index] = {
        walletLabel,
        walletAddress: submitted.walletAddress,
        status: "submitted",
        runId: run.runId,
        txHash: submitted.txHash
      };
      await auditMintAction({
        ownerTelegramId: params.ownerTelegramId,
        action: "multi_mint_wallet_submitted",
        targetId: params.targetId,
        multiMintJobId: params.multiMintJobId,
        runId: run.runId,
        walletLabel,
        walletAddress: submitted.walletAddress,
        chain: params.chain,
        contractAddress: params.contractAddress,
        functionSignature: params.functionSignature,
        quantity: params.quantity,
        priceEth: params.priceEth,
        gasStrategyMode: params.gasStrategy.mode,
        txHash: submitted.txHash,
        status: "submitted"
      });
      await params.notify?.(
        `✅ Multi-mint tx sent for ${walletLabel}.

Run ID: ${run.runId}
Tx:
${submitted.txHash}`
      );

      const confirmation = await waitForMintConfirmation(
        params.chain,
        submitted.txHash
      );

      if (confirmation.status === "confirmed") {
        updateMintRunForOwner(run.runId, params.ownerTelegramId, {
          status: "confirmed",
          confirmedAt: new Date().toISOString()
        });
        if (params.multiMintJobId) {
          updateMultiMintChildResult(
            params.multiMintJobId,
            params.ownerTelegramId,
            walletLabel,
            {
              status: "confirmed",
              txHash: submitted.txHash
            }
          );
        }
        results[index] = {
          walletLabel,
          walletAddress: submitted.walletAddress,
          status: "confirmed",
          runId: run.runId,
          txHash: submitted.txHash
        };
        await auditMintAction({
          ownerTelegramId: params.ownerTelegramId,
          action: "multi_mint_wallet_confirmed",
          targetId: params.targetId,
          multiMintJobId: params.multiMintJobId,
          runId: run.runId,
          walletLabel,
          walletAddress: submitted.walletAddress,
          chain: params.chain,
          contractAddress: params.contractAddress,
          functionSignature: params.functionSignature,
          quantity: params.quantity,
          priceEth: params.priceEth,
          gasStrategyMode: params.gasStrategy.mode,
          txHash: submitted.txHash,
          status: "confirmed"
        });
        return;
      }

      const reason =
        confirmation.status === "timeout"
          ? "confirmation_timeout"
          : "transaction_failed";
      updateMintRunForOwner(run.runId, params.ownerTelegramId, {
        status: confirmation.status === "timeout" ? "submitted" : "failed",
        errorReason: reason
      });
      if (params.multiMintJobId) {
        updateMultiMintChildResult(
          params.multiMintJobId,
          params.ownerTelegramId,
          walletLabel,
          {
            status: confirmation.status === "timeout" ? "submitted" : "failed",
            txHash: submitted.txHash,
            safeErrorReason: reason
          }
        );
      }
      results[index] = {
        walletLabel,
        walletAddress: submitted.walletAddress,
        status: confirmation.status === "timeout" ? "submitted" : "failed",
        runId: run.runId,
        txHash: submitted.txHash,
        safeErrorReason: reason
      };
    } catch (error) {
      const reason = getSafeErrorMessage(error);
      logSafeError(`Multi-mint wallet failed (${walletLabel})`, error);
      run =
        run ||
        createMintRun({
          ownerTelegramId: params.ownerTelegramId,
          targetId: params.targetId,
          ...(params.multiMintJobId ? { multiMintJobId: params.multiMintJobId } : {}),
          walletLabel,
          walletAddress,
          chain: params.chain,
          contractAddress: params.contractAddress,
          functionSignature: params.functionSignature,
          quantity: params.quantity,
          priceEth: params.priceEth,
          status: "failed",
          errorReason: reason
        });
      updateMintRunForOwner(run.runId, params.ownerTelegramId, {
        status: "failed",
        errorReason: reason
      });
      if (params.multiMintJobId) {
        updateMultiMintChildResult(
          params.multiMintJobId,
          params.ownerTelegramId,
          walletLabel,
          {
            status: "failed",
            runId: run.runId,
            safeErrorReason: reason,
            attempts: 1
          }
        );
      }
      results[index] = {
        walletLabel,
        walletAddress,
        status: "failed",
        runId: run.runId,
        safeErrorReason: reason
      };
      await auditMintAction({
        ownerTelegramId: params.ownerTelegramId,
        action: "multi_mint_wallet_failed",
        targetId: params.targetId,
        multiMintJobId: params.multiMintJobId,
        runId: run.runId,
        walletLabel,
        walletAddress,
        chain: params.chain,
        contractAddress: params.contractAddress,
        functionSignature: params.functionSignature,
        quantity: params.quantity,
        priceEth: params.priceEth,
        gasStrategyMode: params.gasStrategy.mode,
        status: "failed",
        reason
      });
    }
  });

  const status = getMultiMintSummaryStatus(results);

  if (params.multiMintJobId) {
    const job = getMultiMintJobForOwner(
      params.multiMintJobId,
      params.ownerTelegramId
    );
    updateMultiMintJobForOwner(params.multiMintJobId, params.ownerTelegramId, {
      status: summarizeMultiMintJobStatus({
        ...job,
        childResults: getMultiMintJobForOwner(
          params.multiMintJobId,
          params.ownerTelegramId
        ).childResults
      }),
      safeErrorReason: status === "confirmed" ? "" : status
    });
  }

  await auditMintAction({
    ownerTelegramId: params.ownerTelegramId,
    action: "multi_mint_completed",
    targetId: params.targetId,
    multiMintJobId: params.multiMintJobId,
    chain: params.chain,
    contractAddress: params.contractAddress,
    functionSignature: params.functionSignature,
    quantity: params.quantity,
    priceEth: params.priceEth,
    gasStrategyMode: params.gasStrategy.mode,
    status
  });

  return { status, results };
}

async function previewGasForMintSnapshot(params: {
  ownerTelegramId: string;
  walletLabel: string;
  contractAddress: string;
  functionSignature: SupportedMintFunctionSignature;
  quantity: number;
  priceEth: string;
  chain: MintChain;
  gasStrategy: GasStrategy;
}) {
  return previewMint({
    ownerTelegramId: params.ownerTelegramId,
    walletLabel: params.walletLabel,
    contractAddress: params.contractAddress,
    functionSignature: params.functionSignature,
    quantity: params.quantity,
    priceEth: params.priceEth,
    chain: params.chain,
    gasStrategy: params.gasStrategy
  });
}

async function previewGasForTargetWallet(params: {
  ownerTelegramId: string;
  target: MintTarget;
  walletLabel: string;
  gasStrategy?: GasStrategy;
}) {
  const target = requireCompleteMintTarget(params.target);
  return previewGasForMintSnapshot({
    ownerTelegramId: params.ownerTelegramId,
    walletLabel: params.walletLabel,
    contractAddress: target.contractAddress,
    functionSignature: target.functionSignature,
    quantity: target.quantity,
    priceEth: target.priceEth,
    chain: target.chain,
    gasStrategy: params.gasStrategy || getTargetGasStrategy(target)
  });
}

async function getMultiMintPreflightForSnapshot(params: {
  ownerTelegramId: string;
  walletLabels: string[];
  contractAddress: string;
  functionSignature: SupportedMintFunctionSignature;
  quantity: number;
  priceEth: string;
  chain: MintChain;
  gasStrategy: GasStrategy;
}) {
  const previews: MintPreviewResult[] = [];
  const failures: Array<{ walletLabel: string; reason: string }> = [];

  for (const walletLabel of params.walletLabels) {
    try {
      const preview = await previewGasForMintSnapshot({
        ownerTelegramId: params.ownerTelegramId,
        walletLabel,
        contractAddress: params.contractAddress,
        functionSignature: params.functionSignature,
        quantity: params.quantity,
        priceEth: params.priceEth,
        chain: params.chain,
        gasStrategy: params.gasStrategy
      });
      previews.push(preview);

      if (preview.gasEstimateFailed) {
        failures.push({
          walletLabel,
          reason: preview.gasEstimateError || "gas_estimation_failed"
        });
      } else if (preview.fundedEnough === false) {
        failures.push({
          walletLabel,
          reason: "insufficient_native_balance_for_estimated_total"
        });
      }
    } catch (error) {
      failures.push({
        walletLabel,
        reason: getSafeErrorMessage(error)
      });
    }
  }

  return { previews, failures };
}

async function getMultiMintPreflight(params: {
  ownerTelegramId: string;
  target: MintTarget;
  walletLabels: string[];
  gasStrategy?: GasStrategy;
}) {
  const target = requireCompleteMintTarget(params.target);

  return getMultiMintPreflightForSnapshot({
    ownerTelegramId: params.ownerTelegramId,
    walletLabels: params.walletLabels,
    contractAddress: target.contractAddress,
    functionSignature: target.functionSignature,
    quantity: target.quantity,
    priceEth: target.priceEth,
    chain: target.chain,
    gasStrategy: params.gasStrategy || getTargetGasStrategy(target)
  });
}

function formatMultiGasPreview(previews: MintPreviewResult[], failures: Array<{ walletLabel: string; reason: string }>) {
  const lines = [
    "Multi Gas Preview",
    "",
    formatMultiGasBudgetSummary(previews).join("\n"),
    "",
    ...previews.map((preview) =>
      [
        `Wallet: ${preview.walletLabel}`,
        `Address: ${formatShortAddress(preview.walletAddress)}`,
        `Balance: ${preview.walletBalanceEth ? formatEthWithUsd(preview.walletBalanceEth) : "Unknown"}`,
        `Estimated Gas Cost: ${formatEthWithUsd(preview.estimatedGasCostEth)}`,
        `Estimated Total Cost: ${formatEthWithUsd(preview.estimatedTotalCostEth)}`,
        `Funded Enough: ${preview.fundedEnough === undefined ? "unknown" : preview.fundedEnough ? "yes" : "no"}`,
        `Gas: ${preview.gasEstimate || "Not available"}`,
        `Gas Advisor: ${formatGasAdvisor(preview)}`,
        ...(preview.gasEstimateError ? [`Reason: ${preview.gasEstimateError}`] : [])
      ].join("\n")
    )
  ];

  if (failures.length > 0) {
    lines.push(
      "",
      "Issues:",
      ...failures.map((failure) => `- ${failure.walletLabel}: ${failure.reason}`)
    );
  }

  lines.push("", "No transaction was sent.");
  return lines.join("\n\n");
}

function parseOptionalCommandGasStrategy(
  parts: string[],
  startIndex: number,
  fallback: GasStrategy
) {
  return parts[startIndex]?.trim() ? parseGasStrategyInput(parts, startIndex) : fallback;
}

function getPreviewReadinessFailures(preview: MintPreviewResult) {
  const failures: Array<{ walletLabel: string; reason: string }> = [];

  if (preview.gasEstimateFailed) {
    failures.push({
      walletLabel: preview.walletLabel,
      reason: preview.gasEstimateError || "gas_estimation_failed"
    });
  } else if (preview.fundedEnough === false) {
    failures.push({
      walletLabel: preview.walletLabel,
      reason: "insufficient_native_balance_for_estimated_total"
    });
  }

  return failures;
}

function formatMintReadinessRecommendation(
  previews: MintPreviewResult[],
  failures: Array<{ walletLabel: string; reason: string }>
) {
  const insufficientFailureCount = failures.filter((failure) =>
    failure.reason.toLowerCase().includes("insufficient")
  ).length;
  const underfundedCount =
    previews.filter((preview) => preview.fundedEnough === false).length +
    insufficientFailureCount;
  const gasEstimateFailureCount =
    previews.filter((preview) => preview.gasEstimateFailed).length +
    failures.filter((failure) => !failure.reason.toLowerCase().includes("insufficient")).length;
  const highGasCount = previews.filter((preview) =>
    formatGasAdvisor(preview).toLowerCase().startsWith("high risk")
  ).length;

  if (underfundedCount > 0) {
    return "Needs funding: top up the affected wallet(s) with native token, then run /mintready again.";
  }

  if (gasEstimateFailureCount > 0) {
    return "Check eligibility: gas estimation failed for at least one wallet. Confirm mint is live, wallet is eligible, function is correct, and price is right.";
  }

  if (highGasCount > 0) {
    return "Gas high: wallet(s) look ready, but gas is expensive. Consider waiting or lowering gas strategy.";
  }

  if (previews.length === 0) {
    return "Not ready: no wallet preview was created.";
  }

  return "Ready: checked wallet(s) look ready. You can run /quickmint when you want to create a confirmation.";
}

function formatMintReadyUsage() {
  return [
    "Use:",
    "/mintready targetId wallet1[,wallet2,...] [gasStrategy]",
    "",
    "Examples:",
    "/mintready 8fce62cc-d032-4e53-9ec2-87aec5be7258 wallet1 fast",
    "/mintready 8fce62cc-d032-4e53-9ec2-87aec5be7258 wallet1,wallet2 fast"
  ].join("\n");
}

function formatQuickMintUsage() {
  return [
    "Use:",
    "/quickmint targetId wallet1[,wallet2,...] [gasStrategy]",
    "",
    "Examples:",
    "/quickmint 8fce62cc-d032-4e53-9ec2-87aec5be7258 wallet1 fast",
    "/quickmint 8fce62cc-d032-4e53-9ec2-87aec5be7258 wallet1,wallet2 fast",
    "",
    "No transaction will be sent until you press the confirmation button."
  ].join("\n");
}

type MultiMintJobReadinessResult = {
  ready: boolean;
  status: "ready" | "not_ready" | "blocked";
  reason?: string;
};

async function runMultiMintJobReadinessCheck(
  job: MultiMintJob,
  options: { countAttempt?: boolean } = {}
): Promise<MultiMintJobReadinessResult> {
  const checkedAt = new Date().toISOString();

  try {
    const preflight = await getMultiMintPreflightForSnapshot({
      ownerTelegramId: job.ownerTelegramId,
      walletLabels: job.walletLabels,
      contractAddress: job.contractAddress,
      functionSignature: job.functionSignature,
      quantity: job.quantity,
      priceEth: job.priceEth,
      chain: job.chain,
      gasStrategy: job.gasStrategy
    });
    const allBlocked =
      preflight.previews.length === 0 ||
      preflight.failures.length === job.walletLabels.length;
    const status = allBlocked ? "blocked" : "ready";
    const reason = preflight.failures[0]?.reason;

    updateMultiMintJobForOwner(job.jobId, job.ownerTelegramId, {
      lastCheckedAt: checkedAt,
      ...(options.countAttempt ? { attempts: job.attempts + 1 } : {}),
      ...(reason ? { safeErrorReason: reason } : {})
    });

    return {
      ready: !allBlocked,
      status,
      ...(reason ? { reason } : {})
    };
  } catch (error) {
    const reason = getSafeErrorMessage(error);
    updateMultiMintJobForOwner(job.jobId, job.ownerTelegramId, {
      lastCheckedAt: checkedAt,
      ...(options.countAttempt ? { attempts: job.attempts + 1 } : {}),
      safeErrorReason: reason
    });

    return { ready: false, status: "not_ready", reason };
  }
}

async function sendMintJobAlert(job: MintJob, message: string) {
  try {
    await bot.telegram.sendMessage(job.ownerTelegramId, message);
  } catch (error) {
    logSafeError("Mint job alert failed", error);
  }
}

type MintJobReadinessResult = {
  ready: boolean;
  status: "ready" | "not_ready" | "blocked";
  reason?: string;
  preview?: MintPreviewResult;
};

async function runMintJobReadinessCheck(
  job: MintJob,
  options: { countAttempt?: boolean } = {}
): Promise<MintJobReadinessResult> {
  const checkedAt = new Date().toISOString();

  try {
    const target = getMintTargetForOwner(job.targetId, job.ownerTelegramId);
    const phase = await detectMintPhase({
      contractAddress: job.contractAddress,
      chain: job.chain,
      evidenceTexts: [
        target.name,
        target.collectionSlug || "",
        target.sourceUrl || "",
        target.notes || ""
      ]
    });
    const startMs = Date.parse(job.startTimeISO);

    if (phase.phaseStatus === "paused" || phase.phaseStatus === "ended") {
      const reason = `phase_${phase.phaseStatus}`;
      updateMintJobForOwner(job.jobId, job.ownerTelegramId, {
        lastCheckedAt: checkedAt,
        ...(options.countAttempt ? { attempts: job.attempts + 1 } : {}),
        safeErrorReason: reason
      });
      return { ready: false, status: "blocked", reason };
    }

    if (
      phase.phaseStatus === "not_live_yet" &&
      Number.isFinite(startMs) &&
      Date.now() < startMs
    ) {
      const reason = "phase_not_live_yet";
      updateMintJobForOwner(job.jobId, job.ownerTelegramId, {
        lastCheckedAt: checkedAt,
        ...(options.countAttempt ? { attempts: job.attempts + 1 } : {}),
        safeErrorReason: reason
      });
      return { ready: false, status: "not_ready", reason };
    }

    const preview = await previewMint({
      ownerTelegramId: job.ownerTelegramId,
      walletLabel: job.walletLabel,
      contractAddress: job.contractAddress,
      functionSignature: job.functionSignature,
      quantity: job.quantity,
      priceEth: job.priceEth,
      chain: job.chain,
      gasStrategy: getTargetGasStrategy(target)
    });

    if (preview.walletAddress.toLowerCase() !== job.walletAddress.toLowerCase()) {
      throw new Error("Wallet job snapshot no longer matches the saved wallet.");
    }

    const provider = getMintProvider(job.chain);
    const balanceWei = await provider.getBalance(preview.walletAddress);

    if (balanceWei < preview.totalCostWei) {
      const reason = "insufficient_native_balance_for_mint_price";
      updateMintJobForOwner(job.jobId, job.ownerTelegramId, {
        lastCheckedAt: checkedAt,
        ...(options.countAttempt ? { attempts: job.attempts + 1 } : {}),
        safeErrorReason: reason
      });
      return { ready: false, status: "blocked", reason, preview };
    }

    if (preview.gasEstimateFailed) {
      const reason = preview.gasEstimateError || "gas_estimation_failed";
      updateMintJobForOwner(job.jobId, job.ownerTelegramId, {
        lastCheckedAt: checkedAt,
        ...(options.countAttempt ? { attempts: job.attempts + 1 } : {}),
        safeErrorReason: reason
      });
      return { ready: false, status: "not_ready", reason, preview };
    }

    updateMintJobForOwner(job.jobId, job.ownerTelegramId, {
      lastCheckedAt: checkedAt,
      ...(options.countAttempt ? { attempts: job.attempts + 1 } : {})
    });
    return { ready: true, status: "ready", preview };
  } catch (error) {
    const reason = getSafeErrorMessage(error);
    updateMintJobForOwner(job.jobId, job.ownerTelegramId, {
      lastCheckedAt: checkedAt,
      ...(options.countAttempt ? { attempts: job.attempts + 1 } : {}),
      safeErrorReason: reason
    });
    return { ready: false, status: "not_ready", reason };
  }
}

function getCommandRemainder(text: string): string {
  return text.trim().split(/\s+/).slice(1).join(" ").trim();
}

function getDetectedChainForTarget(chainName: DetectedChainName): {
  chain: MintChain;
  warning?: string;
} {
  const supported = toSupportedMintChain(chainName);

  if (supported) {
    return { chain: supported };
  }

  return {
    chain: "mainnet",
    warning:
      chainName === "unknown"
        ? "Chain was not detected; target defaulted to mainnet."
        : `Detected chain "${chainName}" is not supported by the mint engine yet; target defaulted to mainnet.`
  };
}

function toSafeMintTargetName(rawName: string): string {
  const cleaned = rawName
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);

  if (cleaned.length >= 2) {
    return cleaned;
  }

  return "mintTarget";
}

function generateMintTargetName(
  ownerTelegramId: string,
  detection: MintDetectionResult,
  providedName?: string
) {
  if (providedName?.trim()) {
    return sanitizeMintTargetName(toSafeMintTargetName(providedName));
  }

  const existingNames = new Set(
    listMintTargetsForOwner(ownerTelegramId).map((target) => target.name.toLowerCase())
  );
  const base = toSafeMintTargetName(
    detection.contract.collectionSlug ||
      detection.contract.collectionName ||
      "mintTarget"
  ).slice(0, 32);

  for (let index = 1; index <= 1000; index++) {
    const candidate = index === 1 ? base : `${base}${index}`;

    if (!existingNames.has(candidate.toLowerCase())) {
      return sanitizeMintTargetName(candidate);
    }
  }

  return `mintTarget${Date.now()}`;
}

function getFoundFunctionCandidates(candidates: MintFunctionCandidate[]) {
  return candidates.filter((candidate) => candidate.foundInBytecode);
}

function formatFunctionCandidates(candidates: MintFunctionCandidate[]) {
  if (candidates.length === 0) {
    return "None checked.";
  }

  const found = getFoundFunctionCandidates(candidates);

  if (found.length === 0) {
    return candidates
      .map(
        (candidate) =>
          `- ${candidate.signature}: selector not found (${candidate.confidence})`
      )
      .join("\n");
  }

  return found
    .map(
      (candidate) =>
        `- ${candidate.signature}: selector ${candidate.selector} found (${candidate.confidence})`
    )
    .join("\n");
}

function getOpenSeaMintCurrentStage(openSeaMint?: OpenSeaMintMetadata) {
  if (!openSeaMint) {
    return undefined;
  }

  if (openSeaMint.currentStageName) {
    const byName = openSeaMint.mintSchedule.find(
      (stage) =>
        stage.stageName?.toLowerCase() ===
        openSeaMint.currentStageName?.toLowerCase()
    );

    if (byName) {
      return byName;
    }
  }

  return openSeaMint.mintSchedule.find((stage) => stage.status === "live");
}

function formatOpenSeaMintMetadata(openSeaMint?: OpenSeaMintMetadata) {
  if (!openSeaMint) {
    return [];
  }

  const lines: string[] = [
    "OpenSea Mint Metadata:",
    ...(openSeaMint.mintStatusText ? [`Mint Status: ${openSeaMint.mintStatusText}`] : []),
    ...(openSeaMint.mintedCount !== undefined || openSeaMint.maxSupply !== undefined
      ? [
          `Items Minted: ${
            openSeaMint.mintedCount !== undefined ? openSeaMint.mintedCount : "Unknown"
          } / ${openSeaMint.maxSupply !== undefined ? openSeaMint.maxSupply : "Unknown"}`
        ]
      : [])
  ];
  const currentStage = getOpenSeaMintCurrentStage(openSeaMint);

  if (
    openSeaMint.currentStageName ||
    openSeaMint.currentStagePriceText ||
    openSeaMint.currentStageLimitPerWallet !== undefined ||
    currentStage
  ) {
    lines.push(
      "",
      "Current Stage:",
      openSeaMint.currentStageName || currentStage?.stageName || "Unknown",
      ...(openSeaMint.currentStagePriceText || currentStage?.priceText
        ? [`Price: ${openSeaMint.currentStagePriceText || currentStage?.priceText}`]
        : []),
      ...(openSeaMint.currentStageLimitPerWallet !== undefined ||
      currentStage?.limitPerWallet !== undefined
        ? [
            `Limit: ${
              openSeaMint.currentStageLimitPerWallet ??
              currentStage?.limitPerWallet
            } per wallet`
          ]
        : []),
      ...(currentStage?.eligibilityText
        ? [`Eligibility: ${currentStage.eligibilityText}`]
        : []),
      ...(currentStage?.status ? [`Status: ${currentStage.status}`] : [])
    );
  }

  if (openSeaMint.mintSchedule.length > 0) {
    lines.push("", "Mint Schedule:");

    for (const [index, stage] of openSeaMint.mintSchedule.entries()) {
      lines.push(
        `${index + 1}. ${stage.stageName || "Unknown stage"}`,
        `Status: ${stage.status}`,
        `Phase Type: ${stage.phaseTypeEstimate} (${stage.phaseTypeConfidence})`,
        ...(stage.startTimeText ? [`Time: ${stage.startTimeText}`] : []),
        ...(stage.endTimeText ? [`Ends: ${stage.endTimeText}`] : []),
        ...(stage.priceText ? [`Price: ${stage.priceText}`] : []),
        ...(stage.limitPerWallet !== undefined
          ? [`Limit: ${stage.limitPerWallet} per wallet`]
          : []),
        ...(stage.eligibilityText ? [`Eligibility: ${stage.eligibilityText}`] : []),
        ""
      );
    }
  }

  lines.push(
    `Metadata Source: ${openSeaMint.metadataSource}`,
    `Mint Schedule Confidence: ${openSeaMint.confidence}`
  );

  if (openSeaMint.rawTimeZoneText) {
    lines.push(`Time Zone Text: ${openSeaMint.rawTimeZoneText}`);
  }

  return lines;
}

function formatStructuredDetectorDetails(detection: MintDetectionResult) {
  const structured = detection.structured;

  return [
    "Detector Details:",
    `Platform: ${structured.contract.platform}`,
    `Verified Source: ${structured.contract.verifiedSource ? "yes" : "no"}`,
    `Token Standard: ${structured.contract.tokenStandard}`,
    `Likely Function: ${
      structured.mint.function.name
        ? `${structured.mint.function.name} (${structured.mint.function.selector || "selector unknown"}, ${structured.mint.function.confidence})`
        : "Unknown"
    }`,
    ...(structured.mint.function.signature
      ? [`Function Signature: ${structured.mint.function.signature}`]
      : []),
    `Price: ${
      structured.mint.price.eth
        ? `${structured.mint.price.eth} ETH (${structured.mint.price.source}, ${structured.mint.price.confidence})`
        : `Unknown (${structured.mint.price.source})`
    }`,
    `Phase: ${structured.mint.phase.status} (${structured.mint.phase.confidence})`,
    ...(structured.mint.phase.startTime ? [`Start: ${structured.mint.phase.startTime}`] : []),
    ...(structured.mint.phase.endTime ? [`End: ${structured.mint.phase.endTime}`] : []),
    ...(structured.eligibility
      ? [
          `Allowlist Detected: ${structured.eligibility.allowlistDetected ? "yes" : "no"}`,
          `Wallet On Allowlist: ${structured.eligibility.walletOnAllowlist}`,
          `Wallet Already Minted: ${structured.eligibility.walletAlreadyMinted ?? "unknown"}`,
          `Max Per Wallet: ${structured.eligibility.maxPerWallet ?? "unknown"}`,
          `Eligibility Estimate: ${structured.eligibility.estimate}`
        ]
      : [])
  ];
}

function getDetectionMetadata(detection: MintDetectionResult) {
  return {
    lastCheckedAt: detection.detectedAt,
    ...(detection.contract.collectionName
      ? { collectionName: detection.contract.collectionName }
      : {}),
    ...(detection.contract.collectionSlug
      ? { collectionSlug: detection.contract.collectionSlug }
      : {}),
    ...(detection.contract.address
      ? { detectedContractAddress: detection.contract.address }
      : {}),
    detectedChain: detection.chain.name,
    candidateFunctions: getFoundFunctionCandidates(detection.mint.candidateFunctions).map(
      (candidate) => candidate.signature
    ),
    phaseStatus: detection.mint.phaseStatus,
    phaseTypeEstimate: detection.mint.phaseTypeEstimate,
    phaseTypeConfidence: detection.mint.phaseTypeConfidence,
    phaseTypeEvidence: detection.mint.phaseTypeEvidence,
    phaseConfidence: detection.mint.confidence,
    ...(detection.mint.openSeaMint ? { openSeaMint: detection.mint.openSeaMint } : {}),
    detector: {
      chain: detection.structured.chain,
      contract: detection.structured.contract,
      mint: detection.structured.mint,
      eligibility: detection.structured.eligibility
    },
    warnings: detection.warnings.slice(0, 10)
  };
}

function formatMintDetectionResult(detection: MintDetectionResult) {
  const detected: string[] = [];
  const notDetected: string[] = [];
  const openSeaMint = detection.mint.openSeaMint;

  if (detection.contract.collectionSlug) {
    detected.push("Collection slug");
  } else {
    notDetected.push("Collection slug");
  }

  if (detection.contract.address) {
    detected.push("Contract address");
  } else {
    notDetected.push("Contract address");
  }

  if (getFoundFunctionCandidates(detection.mint.candidateFunctions).length > 0) {
    detected.push("Mint function candidate");
  } else {
    notDetected.push("Mint function");
  }

  if (detection.mint.priceEth || openSeaMint?.currentStagePriceText) {
    detected.push("Mint price");
  } else {
    notDetected.push("Mint price");
  }

  if (detection.mint.phaseStatus !== "unknown" || openSeaMint?.mintStatusText) {
    detected.push("Mint phase");
  } else {
    notDetected.push("Mint phase");
  }

  if (
    detection.mint.startTime ||
    openSeaMint?.mintSchedule.some((stage) => stage.startTimeText)
  ) {
    detected.push("Mint start time");
  } else {
    notDetected.push("Mint start time");
  }

  if (openSeaMint?.mintSchedule.length) {
    detected.push("Mint schedule");
  }

  if (openSeaMint?.mintedCount !== undefined || openSeaMint?.maxSupply !== undefined) {
    detected.push("Minted supply");
  }

  return [
    "Mint Link Parsed",
    "",
    `Source: ${detection.source.platform}`,
    ...(detection.contract.collectionName
      ? [`Collection: ${detection.contract.collectionName}`]
      : []),
    ...(detection.contract.collectionSlug
      ? [`Slug: ${detection.contract.collectionSlug}`]
      : []),
    `Chain: ${detection.chain.name}`,
    ...(detection.contract.address
      ? [`Contract: ${formatShortAddress(detection.contract.address)}`]
      : ["Contract: Unknown"]),
    ...(detection.contract.tokenStandard
      ? [`Token Standard: ${detection.contract.tokenStandard}`]
      : []),
    ...(detection.contract.tokenId ? [`Token ID: ${detection.contract.tokenId}`] : []),
    ...(openSeaMint ? ["", ...formatOpenSeaMintMetadata(openSeaMint)] : []),
    "",
    ...formatStructuredDetectorDetails(detection),
    "",
    "Detected:",
    ...(detected.length > 0 ? detected.map((item) => `- ${item}`) : ["- None"]),
    "",
    "Not detected:",
    ...(notDetected.length > 0 ? notDetected.map((item) => `- ${item}`) : ["- None"]),
    "",
    "Function candidates:",
    formatFunctionCandidates(detection.mint.candidateFunctions),
    "",
    "Phase:",
    `- Status: ${detection.mint.phaseStatus}`,
    `- Type: ${detection.mint.phaseTypeEstimate} (${detection.mint.phaseTypeConfidence})`,
    `- Evidence: ${detection.mint.phaseTypeEvidence}`,
    "",
    "Confidence:",
    `- Contract: ${detection.contract.confidence}`,
    `- Chain: ${detection.chain.confidence}`,
    `- Mint: ${detection.mint.confidence}`,
    ...(openSeaMint ? [`- Mint schedule: ${openSeaMint.confidence}`] : []),
    ...(detection.warnings.length > 0
      ? ["", "Warnings:", ...detection.warnings.map((warning) => `- ${warning}`)]
      : []),
    "",
    "Next:",
    "Use /addmintfromlink URL to save this as a draft target."
  ].join("\n");
}

function formatOpenSeaContractResolution(result: OpenSeaContractResolutionResult) {
  const reliable = result.candidates.filter(
    (candidate) => candidate.confidence === "high" || candidate.confidence === "medium"
  );

  return [
    "OpenSea Contract Resolver",
    "",
    ...(result.collectionName ? [`Collection: ${result.collectionName}`] : []),
    ...(result.slug ? [`Slug: ${result.slug}`] : []),
    "",
    result.candidates.length === 0
      ? "Contract could not be safely detected."
      : reliable.length === 1 && result.candidates.length === 1
        ? `Resolved Contract:\n${result.candidates[0]!.address}`
        : "Contract Candidates:",
    ...(result.candidates.length > 0
      ? result.candidates.map((candidate) =>
          [
            `- ${candidate.address}`,
            `  Confidence: ${candidate.confidence}`,
            `  Source: ${candidate.source}`,
            ...(candidate.chainName ? [`  Chain: ${candidate.chainName}`] : []),
            ...(candidate.tokenStandard ? [`  Token Standard: ${candidate.tokenStandard}`] : []),
            ...(candidate.evidence ? [`  Evidence: ${candidate.evidence}`] : [])
          ].join("\n")
        )
      : []),
    ...(result.warnings.length > 0
      ? ["", "Warnings:", ...result.warnings.map((warning) => `- ${warning}`)]
      : [])
  ].join("\n");
}

function detectionHasMintMetadata(detection: MintDetectionResult) {
  const openSeaMint = detection.mint.openSeaMint;

  return Boolean(
    openSeaMint?.mintStatusText ||
      openSeaMint?.mintSchedule.length ||
      openSeaMint?.mintedCount !== undefined ||
      openSeaMint?.maxSupply !== undefined ||
      openSeaMint?.currentStageName ||
      openSeaMint?.currentStagePriceText ||
      detection.mint.priceEth ||
      detection.mint.phaseStatus !== "unknown"
  );
}

async function replyWithMintDetection(
  ctx: Context,
  input: string,
  reasonPrefix?: string
) {
  const detection = await detectMint(input);

  await auditMintAction({
    ownerTelegramId: getTelegramUserId(ctx),
    action: "mint_link_parsed",
    contractAddress: detection.contract.address,
    chain: detection.chain.name,
    collectionSlug: detection.contract.collectionSlug,
    candidateFunctions: getFoundFunctionCandidates(detection.mint.candidateFunctions).map(
      (candidate) => candidate.signature
    ),
    phaseStatus: detection.mint.phaseStatus,
    phaseTypeEstimate: detection.mint.phaseTypeEstimate,
    phaseTypeConfidence: detection.mint.phaseTypeConfidence,
    reason: reasonPrefix || detection.warnings[0]
  });

  await ctx.reply(formatMintDetectionResult(detection));
  return detection;
}

const PRIVATE_KEY_SHAPED_PATTERN = /0x[a-fA-F0-9]{64}/;
const EXACT_EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const URL_PATTERN = /https?:\/\/[^\s<>()]+/gi;
const EXPLORER_HOSTS = new Set([
  "etherscan.io",
  "www.etherscan.io",
  "sepolia.etherscan.io",
  "basescan.org",
  "www.basescan.org",
  "arbiscan.io",
  "www.arbiscan.io",
  "polygonscan.com",
  "www.polygonscan.com"
]);

function getDirectMintLinkInput(text: string): string | null {
  const trimmed = text.trim();

  if (!trimmed || trimmed.startsWith("/") || PRIVATE_KEY_SHAPED_PATTERN.test(trimmed)) {
    return null;
  }

  if (EXACT_EVM_ADDRESS_PATTERN.test(trimmed)) {
    return ethers.getAddress(trimmed);
  }

  const matches = [...trimmed.matchAll(URL_PATTERN)];

  for (const match of matches) {
    const rawUrl = match[0]?.replace(/[.,;!?)\]]+$/g, "");

    if (!rawUrl) {
      continue;
    }

    try {
      const url = new URL(rawUrl);
      const host = url.hostname.toLowerCase();
      const parts = url.pathname
        .split("/")
        .map((part) => part.trim())
        .filter(Boolean);

      if (
        host.endsWith("opensea.io") &&
        (parts.includes("collection") || parts.includes("assets"))
      ) {
        return url.toString();
      }

      if (host.endsWith("zora.co") && parts.includes("collect")) {
        return url.toString();
      }

      if (EXPLORER_HOSTS.has(host) && parts[0] === "address" && parts[1]) {
        return url.toString();
      }
    } catch {
      // Ignore malformed URLs in regular chat text.
    }
  }

  return null;
}

function formatPhaseDetectionResult(phase: MintPhaseDetectionResult) {
  return [
    "Mint Phase Check",
    "",
    `Chain: ${phase.chain}`,
    `Contract: ${formatShortAddress(phase.contractAddress)}`,
    `Phase Status: ${phase.phaseStatus}`,
    `Phase Type: ${phase.phaseTypeEstimate} (${phase.phaseTypeConfidence})`,
    `Evidence: ${phase.phaseTypeEvidence}`,
    `Confidence: ${phase.confidence}`,
    "",
    "Booleans:",
    ...(phase.detectedBooleans.length > 0
      ? phase.detectedBooleans.map((field) => `- ${field.name}: ${field.value}`)
      : ["- None"]),
    "",
    "Times:",
    ...(phase.detectedTimes.length > 0
      ? phase.detectedTimes.map(
          (field) => `- ${field.name}: ${field.iso || field.value}`
        )
      : ["- None"]),
    "",
    "Prices:",
    ...(phase.detectedPrices.length > 0
      ? phase.detectedPrices.map((field) => `- ${field.name}: ${field.eth} ETH`)
      : ["- None"]),
    "",
    "Supply:",
    ...(phase.detectedSupply.length > 0
      ? phase.detectedSupply.map((field) => `- ${field.name}: ${field.value}`)
      : ["- None"]),
    "",
    phase.summary,
    ...(phase.warnings.length > 0
      ? ["", "Warnings:", ...phase.warnings.map((warning) => `- ${warning}`)]
      : [])
  ].join("\n");
}

async function getContractExists(chain: MintChain, contractAddress: string) {
  const provider = getMintProvider(chain);
  const code = await provider.getCode(contractAddress);
  return code !== "0x";
}

function formatMintRun(run: MintRun) {
  return [
    `Run ID: ${run.runId}`,
    ...(run.targetId ? [`Target ID: ${run.targetId}`] : []),
    ...(run.jobId ? [`Job ID: ${run.jobId}`] : []),
    ...(run.multiMintJobId ? [`Multi-Mint Job ID: ${run.multiMintJobId}`] : []),
    `Status: ${run.status}`,
    `Wallet: ${run.walletLabel}`,
    `Address: ${formatShortAddress(run.walletAddress)}`,
    `Chain: ${run.chain}`,
    `Contract: ${formatShortAddress(run.contractAddress)}`,
    `Function: ${run.functionSignature}`,
    `Qty: ${run.quantity}`,
    `Price Each: ${run.priceEth} ETH`,
    ...(run.txHash ? [`Tx: ${run.txHash}`] : []),
    ...(run.errorReason ? [`Reason: ${run.errorReason}`] : []),
    `Created: ${run.createdAt}`,
    `Updated: ${run.updatedAt}`,
    ...(run.confirmedAt ? [`Confirmed: ${run.confirmedAt}`] : [])
  ].join("\n");
}

function isMintTargetDeleteExpired(session: MintTargetDeleteConfirmation) {
  const expiresAtMs = Date.parse(session.expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now();
}

function cleanupMintTargetDeleteConfirmations() {
  for (const [sessionId, session] of mintTargetDeleteConfirmations.entries()) {
    if (session.status === "active" && isMintTargetDeleteExpired(session)) {
      session.status = "expired";
    }

    const expiresAtMs = Date.parse(session.expiresAt);
    const cleanupAfterMs = Number.isFinite(expiresAtMs)
      ? expiresAtMs + MINT_TARGET_DELETE_TTL_MS
      : Date.now();

    if (cleanupAfterMs <= Date.now()) {
      mintTargetDeleteConfirmations.delete(sessionId);
    }
  }
}

function createMintTargetDeleteConfirmation(params: {
  ownerTelegramId: string;
  targetId: string;
  targetName: string;
}) {
  cleanupMintTargetDeleteConfirmations();

  const createdAt = new Date();
  const session: MintTargetDeleteConfirmation = {
    sessionId: randomUUID(),
    ownerTelegramId: params.ownerTelegramId,
    targetId: params.targetId,
    targetName: params.targetName,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(
      createdAt.getTime() + MINT_TARGET_DELETE_TTL_MS
    ).toISOString(),
    status: "active"
  };

  mintTargetDeleteConfirmations.set(session.sessionId, session);
  return session;
}

async function validateMintTargetDeleteConfirmation(
  ctx: Context,
  sessionId: string
) {
  cleanupMintTargetDeleteConfirmations();

  const actorTelegramId = getTelegramUserId(ctx);

  if (!actorTelegramId) {
    await ctx.reply("❌ Could not verify your Telegram account for this action.");
    return null;
  }

  const session = mintTargetDeleteConfirmations.get(sessionId);

  if (!session) {
    await ctx.reply("This mint target removal confirmation has expired. Run /deleteminttarget again.");
    return null;
  }

  if (session.ownerTelegramId !== actorTelegramId) {
    await auditMintAction({
      ownerTelegramId: session.ownerTelegramId,
      action: "mint_target_archive_blocked",
      targetId: session.targetId,
      status: session.status,
      reason: `wrong_user:actor=${actorTelegramId}`
    });
    await ctx.reply("You cannot use this mint target confirmation.");
    return null;
  }

  if (session.status === "expired" || isMintTargetDeleteExpired(session)) {
    session.status = "expired";
    await auditMintAction({
      ownerTelegramId: session.ownerTelegramId,
      action: "mint_target_archive_blocked",
      targetId: session.targetId,
      status: session.status,
      reason: "expired"
    });
    await ctx.reply("This mint target removal confirmation has expired. Run /deleteminttarget again.");
    return null;
  }

  if (session.status === "used" || session.status === "cancelled") {
    await auditMintAction({
      ownerTelegramId: session.ownerTelegramId,
      action: "mint_target_archive_blocked",
      targetId: session.targetId,
      status: session.status,
      reason: "already_used_or_cancelled"
    });
    await ctx.reply("This mint target confirmation has already been used or cancelled.");
    return null;
  }

  return { session, actorTelegramId };
}

function isMintJobCancelExpired(session: MintJobCancelConfirmation) {
  const expiresAtMs = Date.parse(session.expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now();
}

function cleanupMintJobCancelConfirmations() {
  for (const [sessionId, session] of mintJobCancelConfirmations.entries()) {
    if (session.status === "active" && isMintJobCancelExpired(session)) {
      session.status = "expired";
    }

    const expiresAtMs = Date.parse(session.expiresAt);
    const cleanupAfterMs = Number.isFinite(expiresAtMs)
      ? expiresAtMs + MINT_JOB_CANCEL_TTL_MS
      : Date.now();

    if (cleanupAfterMs <= Date.now()) {
      mintJobCancelConfirmations.delete(sessionId);
    }
  }
}

function createMintJobCancelConfirmation(params: {
  ownerTelegramId: string;
  jobId: string;
  targetName: string;
}) {
  cleanupMintJobCancelConfirmations();

  const createdAt = new Date();
  const session: MintJobCancelConfirmation = {
    sessionId: randomUUID(),
    ownerTelegramId: params.ownerTelegramId,
    jobId: params.jobId,
    targetName: params.targetName,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(
      createdAt.getTime() + MINT_JOB_CANCEL_TTL_MS
    ).toISOString(),
    status: "active"
  };

  mintJobCancelConfirmations.set(session.sessionId, session);
  return session;
}

async function validateMintJobCancelConfirmation(
  ctx: Context,
  sessionId: string
) {
  cleanupMintJobCancelConfirmations();

  const actorTelegramId = getTelegramUserId(ctx);

  if (!actorTelegramId) {
    await ctx.reply("❌ Could not verify your Telegram account for this action.");
    return null;
  }

  const session = mintJobCancelConfirmations.get(sessionId);

  if (!session) {
    await ctx.reply("This mint job cancellation has expired. Run /cancelmintjob again.");
    return null;
  }

  if (session.ownerTelegramId !== actorTelegramId) {
    await auditMintAction({
      ownerTelegramId: session.ownerTelegramId,
      action: "mint_job_cancel_blocked",
      jobId: session.jobId,
      status: session.status,
      reason: `wrong_user:actor=${actorTelegramId}`
    });
    await ctx.reply("You cannot use this mint job cancellation.");
    return null;
  }

  if (session.status === "expired" || isMintJobCancelExpired(session)) {
    session.status = "expired";
    await auditMintAction({
      ownerTelegramId: session.ownerTelegramId,
      action: "mint_job_cancel_blocked",
      jobId: session.jobId,
      status: session.status,
      reason: "expired"
    });
    await ctx.reply("This mint job cancellation has expired. Run /cancelmintjob again.");
    return null;
  }

  if (session.status === "used" || session.status === "cancelled") {
    await auditMintAction({
      ownerTelegramId: session.ownerTelegramId,
      action: "mint_job_cancel_blocked",
      jobId: session.jobId,
      status: session.status,
      reason: "already_used_or_cancelled"
    });
    await ctx.reply("This mint job cancellation has already been used or cancelled.");
    return null;
  }

  return { session, actorTelegramId };
}

function isMultiMintJobCancelExpired(session: MultiMintJobCancelConfirmation) {
  const expiresAtMs = Date.parse(session.expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now();
}

function cleanupMultiMintJobCancelConfirmations() {
  for (const [sessionId, session] of multiMintJobCancelConfirmations.entries()) {
    if (session.status === "active" && isMultiMintJobCancelExpired(session)) {
      session.status = "expired";
    }

    const expiresAtMs = Date.parse(session.expiresAt);
    const cleanupAfterMs = Number.isFinite(expiresAtMs)
      ? expiresAtMs + MULTI_MINT_JOB_CANCEL_TTL_MS
      : Date.now();

    if (cleanupAfterMs <= Date.now()) {
      multiMintJobCancelConfirmations.delete(sessionId);
    }
  }
}

function createMultiMintJobCancelConfirmation(params: {
  ownerTelegramId: string;
  jobId: string;
  targetName: string;
}) {
  cleanupMultiMintJobCancelConfirmations();

  const createdAt = new Date();
  const session: MultiMintJobCancelConfirmation = {
    sessionId: randomUUID(),
    ownerTelegramId: params.ownerTelegramId,
    jobId: params.jobId,
    targetName: params.targetName,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(
      createdAt.getTime() + MULTI_MINT_JOB_CANCEL_TTL_MS
    ).toISOString(),
    status: "active"
  };

  multiMintJobCancelConfirmations.set(session.sessionId, session);
  return session;
}

async function validateMultiMintJobCancelConfirmation(
  ctx: Context,
  sessionId: string
) {
  cleanupMultiMintJobCancelConfirmations();

  const actorTelegramId = getTelegramUserId(ctx);

  if (!actorTelegramId) {
    await ctx.reply("❌ Could not verify your Telegram account for this action.");
    return null;
  }

  const session = multiMintJobCancelConfirmations.get(sessionId);

  if (!session) {
    await ctx.reply("This multi-mint job cancellation has expired. Run /cancelmultimintjob again.");
    return null;
  }

  if (session.ownerTelegramId !== actorTelegramId) {
    await auditMintAction({
      ownerTelegramId: session.ownerTelegramId,
      action: "multi_mint_job_blocked",
      multiMintJobId: session.jobId,
      status: session.status,
      reason: `wrong_user:actor=${actorTelegramId}`
    });
    await ctx.reply("You cannot use this multi-mint job cancellation.");
    return null;
  }

  if (session.status === "expired" || isMultiMintJobCancelExpired(session)) {
    session.status = "expired";
    await auditMintAction({
      ownerTelegramId: session.ownerTelegramId,
      action: "multi_mint_job_blocked",
      multiMintJobId: session.jobId,
      status: session.status,
      reason: "expired"
    });
    await ctx.reply("This multi-mint job cancellation has expired. Run /cancelmultimintjob again.");
    return null;
  }

  if (session.status === "used" || session.status === "cancelled") {
    await auditMintAction({
      ownerTelegramId: session.ownerTelegramId,
      action: "multi_mint_job_blocked",
      multiMintJobId: session.jobId,
      status: session.status,
      reason: "already_used_or_cancelled"
    });
    await ctx.reply("This multi-mint job cancellation has already been used or cancelled.");
    return null;
  }

  return { session, actorTelegramId };
}

function shouldCheckMintJob(job: MintJob, nowMs = Date.now()) {
  if (!["scheduled", "watching", "ready"].includes(job.status)) {
    return false;
  }

  const startMs = Date.parse(job.startTimeISO);

  if (!Number.isFinite(startMs) || startMs > nowMs) {
    return false;
  }

  if (job.endTimeISO) {
    const endMs = Date.parse(job.endTimeISO);

    if (Number.isFinite(endMs) && endMs <= nowMs) {
      return true;
    }
  }

  if (job.status === "ready" && job.mode === "watch") {
    return false;
  }

  if (!job.lastCheckedAt) {
    return true;
  }

  const lastCheckedMs = Date.parse(job.lastCheckedAt);

  if (!Number.isFinite(lastCheckedMs)) {
    return true;
  }

  return lastCheckedMs + job.retryDelayMs <= nowMs;
}

async function markMintJobTerminal(params: {
  job: MintJob;
  status: Extract<MintJobStatus, "failed" | "blocked" | "expired">;
  auditAction: string;
  reason: string;
}) {
  const currentJob = getMintJobForOwner(
    params.job.jobId,
    params.job.ownerTelegramId
  );
  const run = currentJob.lastRunId
    ? null
    : createMintRun({
        ownerTelegramId: currentJob.ownerTelegramId,
        targetId: currentJob.targetId,
        jobId: currentJob.jobId,
        walletLabel: currentJob.walletLabel,
        walletAddress: currentJob.walletAddress,
        chain: currentJob.chain,
        contractAddress: currentJob.contractAddress,
        functionSignature: currentJob.functionSignature,
        quantity: currentJob.quantity,
        priceEth: currentJob.priceEth,
        status: params.status === "failed" ? "failed" : "blocked",
        errorReason: params.reason
      });
  const updated = updateMintJobStatus(
    currentJob.jobId,
    currentJob.ownerTelegramId,
    params.status,
    params.reason
  );

  if (run) {
    updateMintJobForOwner(updated.jobId, updated.ownerTelegramId, {
      lastRunId: run.runId
    });
  }

  await auditMintAction({
    ownerTelegramId: updated.ownerTelegramId,
    action: params.auditAction,
    targetId: updated.targetId,
    jobId: updated.jobId,
    ...(run || updated.lastRunId ? { runId: run?.runId || updated.lastRunId } : {}),
    walletLabel: updated.walletLabel,
    walletAddress: updated.walletAddress,
    chain: updated.chain,
    contractAddress: updated.contractAddress,
    functionSignature: updated.functionSignature,
    quantity: updated.quantity,
    priceEth: updated.priceEth,
    mintType: updated.mintType,
    status: updated.status,
    reason: params.reason
  });
  await sendMintJobAlert(
    updated,
    `Mint job ${params.status}.

Job ID: ${updated.jobId}
Target: ${updated.targetName}
Reason: ${params.reason}`
  );
}

async function executeAutoMintJob(job: MintJob, preview: MintPreviewResult) {
  if (
    job.chain === "mainnet" &&
    (!isMainnetMintingEnabled() || !isScheduledMainnetMintingEnabled())
  ) {
    const reason = "scheduled_mainnet_minting_disabled";
    const run = createMintRun({
      ownerTelegramId: job.ownerTelegramId,
      targetId: job.targetId,
      jobId: job.jobId,
      walletLabel: preview.walletLabel,
      walletAddress: preview.walletAddress,
      chain: preview.chain,
      contractAddress: preview.contractAddress,
      functionSignature: preview.functionSignature,
      quantity: preview.quantity,
      priceEth: preview.priceEth,
      status: "blocked",
      errorReason: reason
    });
    const updated = updateMintJobForOwner(job.jobId, job.ownerTelegramId, {
      status: "blocked",
      lastRunId: run.runId,
      safeErrorReason: reason
    });

    await auditMintAction({
      ownerTelegramId: updated.ownerTelegramId,
      action: "mint_job_blocked",
      targetId: updated.targetId,
      jobId: updated.jobId,
      runId: run.runId,
      walletLabel: updated.walletLabel,
      walletAddress: updated.walletAddress,
      chain: updated.chain,
      contractAddress: updated.contractAddress,
      functionSignature: updated.functionSignature,
      quantity: updated.quantity,
      priceEth: updated.priceEth,
      mintType: updated.mintType,
      status: updated.status,
      reason
    });

    await sendMintJobAlert(
      updated,
      `Mint job blocked.

Job ID: ${updated.jobId}
Target: ${updated.targetName}
Reason: Mainnet scheduled auto-minting requires ALLOW_MAINNET_MINTING=true and ALLOW_SCHEDULED_MAINNET_MINTING=true.`
    );
    return;
  }

  const run = createMintRun({
    ownerTelegramId: job.ownerTelegramId,
    targetId: job.targetId,
    jobId: job.jobId,
    walletLabel: preview.walletLabel,
    walletAddress: preview.walletAddress,
    chain: preview.chain,
    contractAddress: preview.contractAddress,
    functionSignature: preview.functionSignature,
    quantity: preview.quantity,
    priceEth: preview.priceEth,
    status: "pending"
  });
  updateMintJobForOwner(job.jobId, job.ownerTelegramId, {
    lastRunId: run.runId
  });

  try {
    const target = getMintTargetForOwner(job.targetId, job.ownerTelegramId);
    const submitted = await submitMintTransaction({
      ownerTelegramId: job.ownerTelegramId,
      walletLabel: job.walletLabel,
      contractAddress: job.contractAddress,
      functionSignature: job.functionSignature,
      quantity: job.quantity,
      priceEth: job.priceEth,
      chain: job.chain,
      gasStrategy: getTargetGasStrategy(target)
    });
    updateMintRunForOwner(run.runId, job.ownerTelegramId, {
      status: "submitted",
      txHash: submitted.txHash
    });
    const submittedJob = updateMintJobForOwner(job.jobId, job.ownerTelegramId, {
      status: "submitted",
      txHash: submitted.txHash,
      safeErrorReason: ""
    });

    await auditMintAction({
      ownerTelegramId: submittedJob.ownerTelegramId,
      action: "mint_job_submitted",
      targetId: submittedJob.targetId,
      jobId: submittedJob.jobId,
      runId: run.runId,
      walletLabel: submittedJob.walletLabel,
      walletAddress: submitted.walletAddress,
      chain: submittedJob.chain,
      contractAddress: submittedJob.contractAddress,
      functionSignature: submittedJob.functionSignature,
      quantity: submittedJob.quantity,
      priceEth: submittedJob.priceEth,
      mintType: submittedJob.mintType,
      txHash: submitted.txHash,
      status: submittedJob.status
    });
    await sendMintJobAlert(
      submittedJob,
      `✅ Scheduled mint transaction sent.

Job ID: ${submittedJob.jobId}
Run ID: ${run.runId}
Tx:
${submitted.txHash}`
    );

    const confirmation = await waitForMintConfirmation(job.chain, submitted.txHash);

    if (confirmation.status === "confirmed") {
      updateMintRunForOwner(run.runId, job.ownerTelegramId, {
        status: "confirmed",
        confirmedAt: new Date().toISOString()
      });
      const confirmedJob = updateMintJobForOwner(job.jobId, job.ownerTelegramId, {
        status: "confirmed",
        txHash: submitted.txHash
      });
      await auditMintAction({
        ownerTelegramId: confirmedJob.ownerTelegramId,
        action: "mint_job_confirmed",
        targetId: confirmedJob.targetId,
        jobId: confirmedJob.jobId,
        runId: run.runId,
        walletLabel: confirmedJob.walletLabel,
        walletAddress: submitted.walletAddress,
        chain: confirmedJob.chain,
        contractAddress: confirmedJob.contractAddress,
        functionSignature: confirmedJob.functionSignature,
        quantity: confirmedJob.quantity,
        priceEth: confirmedJob.priceEth,
        mintType: confirmedJob.mintType,
        txHash: submitted.txHash,
        status: confirmedJob.status
      });
      await sendMintJobAlert(
        confirmedJob,
        `✅ Scheduled mint confirmed.

Job ID: ${confirmedJob.jobId}
Run ID: ${run.runId}
Tx:
${submitted.txHash}`
      );
      return;
    }

    if (confirmation.status === "timeout") {
      updateMintRunForOwner(run.runId, job.ownerTelegramId, {
        status: "submitted",
        errorReason: "confirmation_timeout"
      });
      updateMintJobForOwner(job.jobId, job.ownerTelegramId, {
        status: "submitted",
        txHash: submitted.txHash,
        safeErrorReason: "confirmation_timeout"
      });
      await sendMintJobAlert(
        submittedJob,
        `⚠️ Scheduled mint was sent, but confirmation timed out.

Job ID: ${submittedJob.jobId}
Run ID: ${run.runId}
Tx:
${submitted.txHash}`
      );
      return;
    }

    updateMintRunForOwner(run.runId, job.ownerTelegramId, {
      status: "failed",
      errorReason: "transaction_failed",
      confirmedAt: new Date().toISOString()
    });
    await markMintJobTerminal({
      job,
      status: "failed",
      auditAction: "mint_job_failed",
      reason: "transaction_failed"
    });
  } catch (error) {
    const reason = getSafeErrorMessage(error);
    logSafeError("Scheduled mint submit failed", error);
    updateMintRunForOwner(run.runId, job.ownerTelegramId, {
      status: "failed",
      errorReason: reason
    });
    await markMintJobTerminal({
      job,
      status: "failed",
      auditAction: "mint_job_failed",
      reason
    });
  }
}

async function processMintJob(job: MintJob) {
  const nowMs = Date.now();

  if (job.endTimeISO) {
    const endMs = Date.parse(job.endTimeISO);

    if (Number.isFinite(endMs) && endMs <= nowMs) {
      await markMintJobTerminal({
        job,
        status: "expired",
        auditAction: "mint_job_expired",
        reason: "job_end_time_passed"
      });
      return;
    }
  }

  if (job.status === "scheduled") {
    job = updateMintJobForOwner(job.jobId, job.ownerTelegramId, {
      status: "watching"
    });
  }

  const readiness = await runMintJobReadinessCheck(job, { countAttempt: true });
  const updated = getMintJobForOwner(job.jobId, job.ownerTelegramId);

  await auditMintAction({
    ownerTelegramId: updated.ownerTelegramId,
    action: "mint_job_checked",
    targetId: updated.targetId,
    jobId: updated.jobId,
    walletLabel: updated.walletLabel,
    walletAddress: updated.walletAddress,
    chain: updated.chain,
    contractAddress: updated.contractAddress,
    functionSignature: updated.functionSignature,
    quantity: updated.quantity,
    priceEth: updated.priceEth,
    mintType: updated.mintType,
    status: readiness.status,
    reason: readiness.reason
  });

  if (readiness.ready && readiness.preview) {
    if (updated.mode === "watch") {
      const readyJob = updateMintJobStatus(
        updated.jobId,
        updated.ownerTelegramId,
        "ready"
      );
      await auditMintAction({
        ownerTelegramId: readyJob.ownerTelegramId,
        action: "mint_job_ready",
        targetId: readyJob.targetId,
        jobId: readyJob.jobId,
        walletLabel: readyJob.walletLabel,
        walletAddress: readyJob.walletAddress,
        chain: readyJob.chain,
        contractAddress: readyJob.contractAddress,
        functionSignature: readyJob.functionSignature,
        quantity: readyJob.quantity,
        priceEth: readyJob.priceEth,
        mintType: readyJob.mintType,
        status: readyJob.status
      });
      await sendMintJobAlert(
        readyJob,
        `Mint target is ready. Use /runmintjob ${readyJob.jobId} to mint now.

Job ID: ${readyJob.jobId}
Target: ${readyJob.targetName}
Wallet: ${readyJob.walletLabel}`
      );
      return;
    }

    await executeAutoMintJob(updated, readiness.preview);
    return;
  }

  if (readiness.status === "blocked" || updated.attempts > updated.maxRetries) {
    await markMintJobTerminal({
      job: updated,
      status: readiness.status === "blocked" ? "blocked" : "failed",
      auditAction:
        readiness.status === "blocked" ? "mint_job_blocked" : "mint_job_failed",
      reason: readiness.reason || "retry_limit_exhausted"
    });
  }
}

function shouldCheckMultiMintJob(job: MultiMintJob, nowMs = Date.now()) {
  if (!["scheduled", "watching", "ready"].includes(job.status)) {
    return false;
  }

  const startMs = Date.parse(job.startTimeISO);

  if (!Number.isFinite(startMs) || startMs > nowMs) {
    return false;
  }

  if (job.status === "ready" && job.mode === "watch") {
    return false;
  }

  if (!job.lastCheckedAt) {
    return true;
  }

  const lastCheckedMs = Date.parse(job.lastCheckedAt);

  if (!Number.isFinite(lastCheckedMs)) {
    return true;
  }

  return lastCheckedMs + job.retryDelayMs <= nowMs;
}

async function markMultiMintJobTerminal(params: {
  job: MultiMintJob;
  status: Extract<MultiMintJobStatus, "failed" | "blocked" | "expired">;
  auditAction: string;
  reason: string;
}) {
  const updated = updateMultiMintJobForOwner(
    params.job.jobId,
    params.job.ownerTelegramId,
    {
      status: params.status,
      safeErrorReason: params.reason
    }
  );

  await auditMintAction({
    ownerTelegramId: updated.ownerTelegramId,
    action: params.auditAction,
    targetId: updated.targetId,
    multiMintJobId: updated.jobId,
    chain: updated.chain,
    contractAddress: updated.contractAddress,
    functionSignature: updated.functionSignature,
    quantity: updated.quantity,
    priceEth: updated.priceEth,
    gasStrategyMode: updated.gasStrategy.mode,
    status: updated.status,
    reason: params.reason
  });
  await sendMultiMintJobAlert(
    updated,
    `Multi-mint job ${params.status}.

Job ID: ${updated.jobId}
Target: ${updated.targetName}
Reason: ${params.reason}`
  );
}

async function executeAutoMultiMintJob(job: MultiMintJob) {
  if (
    job.chain === "mainnet" &&
    (!isMainnetMintingEnabled() || !isScheduledMainnetMintingEnabled())
  ) {
    await markMultiMintJobTerminal({
      job,
      status: "blocked",
      auditAction: "multi_mint_job_blocked",
      reason: "scheduled_mainnet_minting_disabled"
    });
    return;
  }

  const updated = updateMultiMintJobForOwner(job.jobId, job.ownerTelegramId, {
    status: "submitted"
  });
  const result = await executeMultiMint({
    ownerTelegramId: updated.ownerTelegramId,
    targetId: updated.targetId,
    targetName: updated.targetName,
    chain: updated.chain,
    contractAddress: updated.contractAddress,
    functionSignature: updated.functionSignature,
    quantity: updated.quantity,
    priceEth: updated.priceEth,
    walletLabels: updated.walletLabels,
    walletAddresses: updated.walletAddresses,
    gasStrategy: updated.gasStrategy,
    multiMintJobId: updated.jobId,
    requireScheduledMainnetLock: true,
    notify: (message) => sendMultiMintJobAlert(updated, message)
  });
  const finalJob = updateMultiMintJobForOwner(updated.jobId, updated.ownerTelegramId, {
    status: result.status as MultiMintJobStatus,
    safeErrorReason: result.status === "confirmed" ? "" : result.status
  });

  await auditMintAction({
    ownerTelegramId: finalJob.ownerTelegramId,
    action:
      finalJob.status === "confirmed"
        ? "multi_mint_job_confirmed"
        : finalJob.status === "blocked"
          ? "multi_mint_job_blocked"
          : finalJob.status === "failed"
            ? "multi_mint_job_failed"
            : "multi_mint_completed",
    targetId: finalJob.targetId,
    multiMintJobId: finalJob.jobId,
    chain: finalJob.chain,
    contractAddress: finalJob.contractAddress,
    functionSignature: finalJob.functionSignature,
    quantity: finalJob.quantity,
    priceEth: finalJob.priceEth,
    gasStrategyMode: finalJob.gasStrategy.mode,
    status: finalJob.status
  });
  await sendMultiMintJobAlert(
    finalJob,
    `Multi-mint job finished.

Job ID: ${finalJob.jobId}
Status: ${finalJob.status}

${formatMultiMintExecutionSummary(result.results)}`
  );
}

async function processMultiMintJob(job: MultiMintJob) {
  const nowMs = Date.now();

  if (job.endTimeISO) {
    const endMs = Date.parse(job.endTimeISO);

    if (Number.isFinite(endMs) && endMs <= nowMs) {
      await markMultiMintJobTerminal({
        job,
        status: "expired",
        auditAction: "multi_mint_job_failed",
        reason: "job_end_time_passed"
      });
      return;
    }
  }

  if (job.status === "scheduled") {
    job = updateMultiMintJobForOwner(job.jobId, job.ownerTelegramId, {
      status: "watching"
    });
  }

  const readiness = await runMultiMintJobReadinessCheck(job, {
    countAttempt: true
  });
  const updated = getMultiMintJobForOwner(job.jobId, job.ownerTelegramId);

  if (readiness.ready) {
    if (updated.mode === "watch") {
      const readyJob = updateMultiMintJobForOwner(
        updated.jobId,
        updated.ownerTelegramId,
        { status: "ready" }
      );
      await auditMintAction({
        ownerTelegramId: readyJob.ownerTelegramId,
        action: "multi_mint_job_ready",
        targetId: readyJob.targetId,
        multiMintJobId: readyJob.jobId,
        chain: readyJob.chain,
        contractAddress: readyJob.contractAddress,
        functionSignature: readyJob.functionSignature,
        quantity: readyJob.quantity,
        priceEth: readyJob.priceEth,
        gasStrategyMode: readyJob.gasStrategy.mode,
        status: readyJob.status
      });
      await sendMultiMintJobAlert(
        readyJob,
        `Multi-wallet mint target is ready. Use /runmultimintjob ${readyJob.jobId} to confirm.

Job ID: ${readyJob.jobId}
Target: ${readyJob.targetName}
Wallets: ${readyJob.walletLabels.join(", ")}`
      );
      return;
    }

    await executeAutoMultiMintJob(updated);
    return;
  }

  if (readiness.status === "blocked" || updated.attempts > updated.maxRetries) {
    await markMultiMintJobTerminal({
      job: updated,
      status: readiness.status === "blocked" ? "blocked" : "failed",
      auditAction:
        readiness.status === "blocked"
          ? "multi_mint_job_blocked"
          : "multi_mint_job_failed",
      reason: readiness.reason || "retry_limit_exhausted"
    });
  }
}

async function runMintSchedulerTick() {
  if (mintSchedulerTickRunning) {
    return;
  }

  mintSchedulerTickRunning = true;

  try {
    const jobs = listResumableMintJobs();

    for (const job of jobs) {
      if (!shouldCheckMintJob(job)) {
        continue;
      }

      try {
        await processMintJob(job);
      } catch (error) {
        logSafeError("Mint scheduler job failed", error);
      }
    }

    const multiJobs = listResumableMultiMintJobs();

    for (const job of multiJobs) {
      if (!shouldCheckMultiMintJob(job)) {
        continue;
      }

      try {
        await processMultiMintJob(job);
      } catch (error) {
        logSafeError("Mint scheduler multi-job failed", error);
      }
    }
  } catch (error) {
    logSafeError("Mint scheduler tick failed", error);
  } finally {
    mintSchedulerTickRunning = false;
  }
}

function startMintScheduler() {
  try {
    if (mintSchedulerTimer) {
      return;
    }

    const pollMs = getMintSchedulerPollMs();
    const jobs = listResumableMintJobs();
    const multiJobs = listResumableMultiMintJobs();

    for (const job of jobs) {
      void auditMintAction({
        ownerTelegramId: job.ownerTelegramId,
        action: "mint_job_resumed",
        targetId: job.targetId,
        jobId: job.jobId,
        walletLabel: job.walletLabel,
        walletAddress: job.walletAddress,
        chain: job.chain,
        contractAddress: job.contractAddress,
        functionSignature: job.functionSignature,
        quantity: job.quantity,
        priceEth: job.priceEth,
        mintType: job.mintType,
        status: job.status
      });
    }

    for (const job of multiJobs) {
      void auditMintAction({
        ownerTelegramId: job.ownerTelegramId,
        action: "mint_job_resumed",
        targetId: job.targetId,
        multiMintJobId: job.jobId,
        chain: job.chain,
        contractAddress: job.contractAddress,
        functionSignature: job.functionSignature,
        quantity: job.quantity,
        priceEth: job.priceEth,
        gasStrategyMode: job.gasStrategy.mode,
        status: job.status
      });
    }

    void auditMintAction({
      ownerTelegramId: null,
      action: "mint_scheduler_started",
      status: "enabled",
      reason: `poll_ms:${pollMs}`
    });

    mintSchedulerTimer = setInterval(() => {
      void runMintSchedulerTick();
    }, pollMs);
    void runMintSchedulerTick();
  } catch (error) {
    logSafeError("Mint scheduler startup failed; continuing bot startup", error);
  }
}

function getOfferExpirationText(offer: any): string {
  return offer.expiration || "Not available";
}

function getOfferMakerText(offer: any): string {
  return formatMaybeShortAddress(offer.maker);
}

async function registerTelegramCommandMenu() {
  try {
    await withTimeout(
      bot.telegram.setMyCommands(BOT_COMMANDS),
      COMMAND_MENU_REGISTRATION_TIMEOUT_MS,
      "Telegram command menu registration timed out after 10 seconds."
    );

    try {
      await auditWalletManagementAction({
        ownerTelegramId: null,
        action: "command_menu_registered"
      });
    } catch (auditError) {
      logSafeError("Command menu audit failed", auditError);
    }
  } catch (error) {
    logSafeError("Could not register Telegram command menu; continuing startup", error);
  }
}

async function sendWalletsList(ctx: Context) {
  const ownerTelegramId = getRequiredTelegramUserId(ctx);
  const wallets = await listWalletsForOwner(ownerTelegramId);

  if (wallets.length === 0) {
    await ctx.reply(
      "No wallets found. Add one with /addwallet in private chat, or:\n\nnpm run wallet:add"
    );
    return;
  }

  const message = wallets
    .map((wallet) => {
      const status = formatWalletStatus(wallet.status);

      return [
        `Wallet: ${wallet.label}`,
        `Address: ${formatShortAddress(wallet.address)}`,
        `Status: ${status}`
      ].join("\n");
    })
    .join("\n\n");

  await ctx.reply(
    `Your wallets:\n\n${message}`,
    getWalletActionKeyboard(wallets)
  );
}

async function sendWalletDetails(ctx: Context, walletLabel: string) {
  const ownerTelegramId = getRequiredTelegramUserId(ctx);
  const wallet = await getWalletSummaryByLabelForOwner(
    walletLabel,
    ownerTelegramId,
    { includeArchived: true }
  );

  await auditWalletManagementAction({
    ownerTelegramId,
    action: "wallet_viewed",
    walletLabel: wallet.label,
    walletAddress: wallet.address,
    encryptionVersion: wallet.encryptionVersion,
    status: wallet.status
  });

  const details = [
    `Wallet: ${wallet.label}`,
    `Address: ${formatShortAddress(wallet.address)}`,
    `Status: ${formatWalletStatus(wallet.status)}`,
    `Encryption: ${formatWalletEncryption(wallet.kmsProvider)}`,
    `Created: ${wallet.createdAt}`
  ];

  if (wallet.archivedAt) {
    details.push(`Archived: ${wallet.archivedAt}`);
  }

  if (wallet.status === "archived") {
    await ctx.reply(
      `${details.join("\n")}\n\nArchived wallets cannot be used for bot actions.`
    );
    return;
  }

  await ctx.reply(
    `${details.join("\n")}\n\nActions:`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback("Balance", `wm:balance:${wallet.label}`),
        Markup.button.callback("NFTs", `wm:nfts:${wallet.label}`),
        Markup.button.callback("Portfolio", `wm:portfolio:${wallet.label}`)
      ]
    ])
  );
}

function parseBalanceNetwork(rawNetwork?: string): SupportedBalanceNetwork {
  const normalized = rawNetwork?.trim().toLowerCase();

  if (!normalized || normalized === "sepolia") {
    return "sepolia";
  }

  if (normalized === "mainnet") {
    return "mainnet";
  }

  throw new Error("Network must be sepolia or mainnet.");
}

async function sendWalletBalance(
  ctx: Context,
  walletLabel: string,
  network: SupportedBalanceNetwork
) {
  const ownerTelegramId = getRequiredTelegramUserId(ctx);
  const wallet = await getWalletSummaryByLabelForOwner(
    walletLabel,
    ownerTelegramId
  );
  const balanceProvider = getBalanceProvider(network);
  const balanceWei = await balanceProvider.getBalance(wallet.address);
  const balanceEth = ethers.formatEther(balanceWei);

  await auditWalletManagementAction({
    ownerTelegramId,
    action: "wallet_balance_checked",
    walletLabel: wallet.label,
    walletAddress: wallet.address,
    encryptionVersion: wallet.encryptionVersion,
    network
  });

  await ctx.reply(
    `Balance for ${wallet.label} on ${BALANCE_NETWORK_LABELS[network]}:\n${balanceEth} ETH`
  );
}

type WalletDeleteConfirmationStatus = "active" | "used" | "cancelled" | "expired";

type WalletDeleteConfirmation = {
  sessionId: string;
  ownerTelegramId: string;
  walletLabel: string;
  walletAddress: string;
  encryptionVersion: string;
  createdAt: string;
  expiresAt: string;
  status: WalletDeleteConfirmationStatus;
};

const WALLET_DELETE_CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const walletDeleteConfirmations = new Map<string, WalletDeleteConfirmation>();

function isWalletDeleteConfirmationExpired(session: WalletDeleteConfirmation) {
  const expiresAtMs = Date.parse(session.expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now();
}

function cleanupWalletDeleteConfirmations() {
  for (const [sessionId, session] of walletDeleteConfirmations.entries()) {
    if (session.status === "active" && isWalletDeleteConfirmationExpired(session)) {
      session.status = "expired";
    }

    const expiresAtMs = Date.parse(session.expiresAt);
    const cleanupAfterMs = Number.isFinite(expiresAtMs)
      ? expiresAtMs + WALLET_DELETE_CONFIRMATION_TTL_MS
      : Date.now();

    if (cleanupAfterMs <= Date.now()) {
      walletDeleteConfirmations.delete(sessionId);
    }
  }
}

function createWalletDeleteConfirmation(params: {
  ownerTelegramId: string;
  walletLabel: string;
  walletAddress: string;
  encryptionVersion: string;
}) {
  cleanupWalletDeleteConfirmations();

  const createdAt = new Date();
  const session: WalletDeleteConfirmation = {
    sessionId: randomUUID(),
    ownerTelegramId: params.ownerTelegramId,
    walletLabel: params.walletLabel,
    walletAddress: params.walletAddress,
    encryptionVersion: params.encryptionVersion,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(
      createdAt.getTime() + WALLET_DELETE_CONFIRMATION_TTL_MS
    ).toISOString(),
    status: "active"
  };

  walletDeleteConfirmations.set(session.sessionId, session);
  return session;
}

async function auditWalletDeleteConfirmation(
  session: WalletDeleteConfirmation,
  action: string,
  actorTelegramId: string | null,
  reason?: string
) {
  await auditWalletManagementAction({
    ownerTelegramId: session.ownerTelegramId,
    action,
    walletLabel: session.walletLabel,
    walletAddress: session.walletAddress,
    encryptionVersion: session.encryptionVersion,
    sessionId: session.sessionId,
    status: session.status,
    ...(actorTelegramId && actorTelegramId !== session.ownerTelegramId
      ? { reason: reason ? `${reason}; actor=${actorTelegramId}` : `actor=${actorTelegramId}` }
      : reason
        ? { reason }
        : {})
  });
}

async function validateWalletDeleteConfirmation(
  ctx: Context,
  sessionId: string
) {
  cleanupWalletDeleteConfirmations();

  const actorTelegramId = getTelegramUserId(ctx);

  if (!actorTelegramId) {
    await ctx.reply("❌ Could not verify your Telegram account for this action.");
    return null;
  }

  const session = walletDeleteConfirmations.get(sessionId);

  if (!session) {
    await ctx.reply("This wallet removal confirmation has expired. Run /deletewallet again.");
    return null;
  }

  if (session.ownerTelegramId !== actorTelegramId) {
    await auditWalletDeleteConfirmation(
      session,
      "wallet_delete_blocked_wrong_user",
      actorTelegramId,
      "wrong_user"
    );
    await ctx.reply("❌ This wallet removal confirmation is not available for your Telegram account.");
    return null;
  }

  if (session.status === "expired" || isWalletDeleteConfirmationExpired(session)) {
    session.status = "expired";
    await auditWalletDeleteConfirmation(
      session,
      "wallet_delete_blocked_expired",
      actorTelegramId,
      "expired"
    );
    await ctx.reply("This wallet removal confirmation has expired. Run /deletewallet again.");
    return null;
  }

  if (session.status === "used" || session.status === "cancelled") {
    await auditWalletDeleteConfirmation(
      session,
      "wallet_delete_blocked_already_used",
      actorTelegramId,
      "already_used_or_cancelled"
    );
    await ctx.reply("This wallet removal confirmation has already been used or cancelled.");
    return null;
  }

  return { session, actorTelegramId };
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
const ACTION_WRONG_USER_MESSAGE = "You cannot use this action session.";

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
    await ctx.reply(ACTION_WRONG_USER_MESSAGE);
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


bot.command(["resolveroute", "diagnosemint"], async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const parts = parseCommandParts(ctx.message.text);

    if (parts.length < 3) {
      throw new Error(`Invalid format. Use: ${parts[0]} targetId wallet1`);
    }

    const targetId = getCommandPart(parts, 1);
    const walletLabel = getCommandPart(parts, 2);
    const target = getMintTargetForOwner(targetId, ownerTelegramId);

    if (!target.priceEth) {
      throw new Error("Target is missing priceEth. Update it before resolving route.");
    }

    const result = await resolveMintRoutesForTarget({
      ownerTelegramId,
      target,
      walletLabel
    });

    const best = pickBestSupportedRoute(result.candidates);
    let savedMessage = "";

    if (best) {
      const saved = updateMintTargetForOwner(target.targetId, ownerTelegramId, {
        contractAddress: best.mintContractAddress,
        chain: target.chain,
        functionSignature: normalizeMintFunctionSignature(best.functionSignature),
        quantity: target.quantity,
        priceEth: best.pricePerTokenEth || target.priceEth
      });

      await auditMintAction({
        ownerTelegramId,
        action: "mint_route_resolved",
        walletLabel,
        walletAddress: result.walletAddress,
        targetId: target.targetId,
        chain: target.chain,
        contractAddress: best.mintContractAddress,
        functionSignature: best.functionSignature,
        quantity: target.quantity,
        priceEth: best.pricePerTokenEth || target.priceEth,
        status: "saved",
        reason: best.source
      });

      savedMessage = `

✅ Saved working route to target.

Updated Target:
Contract: ${formatShortAddress(saved.contractAddress)}
Function: ${saved.functionSignature}
Price Each: ${saved.priceEth} ETH

Now test:
/gaspreview ${saved.targetId} ${walletLabel}
/quickmint ${saved.targetId} ${walletLabel}`;
    } else {
      await auditMintAction({
        ownerTelegramId,
        action: "mint_route_resolved",
        walletLabel,
        targetId: target.targetId,
        chain: target.chain,
        contractAddress: target.contractAddress,
        status: "no_supported_route",
        reason: "no gas-estimating supported route found"
      });
    }

    await replyLong(ctx, formatMintRouteResolverResult(result) + savedMessage);
  } catch (error) {
    logSafeError("resolveroute failed", error);
    await ctx.reply(`❌ Could not resolve mint route.

Reason:
${getSafeErrorMessage(error)}

Try:
- confirm the contract is the real mint contract
- confirm ETHERSCAN_API_KEY is set
- confirm the mint is live
- confirm the wallet is eligible`);
  }
});

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

bot.command("help", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.reply(getHelpMessage());
});

bot.command("tradingstatus", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.reply(
    `Trading Status

ALLOW_MAINNET_TRADING: ${isMainnetTradingEnabled() ? "true" : "false"}
ETH_MAINNET_RPC_URL configured: ${getConfiguredStatus(process.env.ETH_MAINNET_RPC_URL)}
OpenSea API key configured: ${getConfiguredStatus(process.env.OPENSEA_API_KEY)}

Live listing and accept-offer actions require:
ALLOW_MAINNET_TRADING=true

${MAINNET_TRADING_DISABLED_MESSAGE}`
  );
});

bot.command("mintingstatus", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const rpcStatus = getMintRpcStatus();

  await ctx.reply(
    `Minting Status

ALLOW_MAINNET_MINTING: ${isMainnetMintingEnabled() ? "true" : "false"}
ETH_MAINNET_RPC_URL configured: ${rpcStatus.mainnetRpcConfigured ? "yes" : "no"}
SEPOLIA_RPC_URL or ETH_SEPOLIA_RPC_URL configured: ${rpcStatus.sepoliaRpcConfigured ? "yes" : "no"}
OpenSea API key configured: ${getConfiguredStatus(process.env.OPENSEA_API_KEY)}

Live Ethereum mainnet minting requires:
ALLOW_MAINNET_MINTING=true

Mainnet minting uses real ETH. Keep this disabled until you are ready for live minting.`
  );
});

bot.command("parserstatus", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const rpcStatus = getMintRpcStatus();
  const detectorRpcStatus = getConfiguredDetectorRpcStatus();

  await ctx.reply(
    `Parser Status

OPENSEA_API_KEY configured: ${getConfiguredStatus(process.env.OPENSEA_API_KEY)}
RESERVOIR_API_KEY configured: ${getConfiguredStatus(process.env.RESERVOIR_API_KEY)}
ETHERSCAN_API_KEY configured: ${getConfiguredStatus(process.env.ETHERSCAN_API_KEY)}
ETH_MAINNET_RPC_URL configured: ${rpcStatus.mainnetRpcConfigured ? "yes" : "no"}
SEPOLIA_RPC_URL or ETH_SEPOLIA_RPC_URL configured: ${rpcStatus.sepoliaRpcConfigured ? "yes" : "no"}
Direct link auto-parser: enabled
OpenSea page metadata fallback: enabled
Reservoir mint-stage lookup: ${getConfiguredStatus(process.env.RESERVOIR_API_KEY) === "yes" ? "enabled" : "disabled"}
Etherscan V2 ABI fallback: ${getConfiguredStatus(process.env.ETHERSCAN_API_KEY) === "yes" ? "enabled" : "disabled"}
4byte selector lookup fallback: enabled

Detector RPCs:
${detectorRpcStatus.map((chain) => `- ${chain.name}: ${chain.configured ? "yes" : "no"}`).join("\n")}

Supported platforms:
- OpenSea collection and asset URLs
- Zora collect URL parsing
- Magic Eden / Blur / Manifold visible-address parsing
- Explorer address links
- Raw addresses
- Generic URL/text address detection

Supported function detection:
- Selector scan for supported mint functions
- Reservoir mint-stage function hints
- Etherscan V2 verified ABI scan
- 4byte lookup for unverified bytecode selectors

Supported phase detection:
- Common read-only contract fields
- Reservoir mint stages

Future upgrades:
- Platform-specific canonical ABI packs for advanced Seadrop/Manifold/Thirdweb/Zora mints
- Advanced allowlist membership APIs`
  );
});

bot.command("parsemintlink", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const input = getCommandRemainder(ctx.message.text);

  if (!input) {
    await ctx.reply("Use:\n/parsemintlink URL_OR_TEXT");
    return;
  }

  try {
    await replyWithMintDetection(ctx, input);
  } catch (error) {
    logSafeError("Could not parse mint link", error);
    await ctx.reply(`❌ Could not parse mint link.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.command("resolvecontract", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const input = getCommandRemainder(ctx.message.text);

  if (!input) {
    await ctx.reply("Use:\n/resolvecontract collectionSlug_or_OpenSea_URL");
    return;
  }

  try {
    const result = await resolveOpenSeaContracts(input);
    await ctx.reply(formatOpenSeaContractResolution(result));
  } catch (error) {
    logSafeError("Could not resolve OpenSea contract", error);
    await ctx.reply(`❌ Could not resolve contract.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.command("addmintfromlink", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = parseCommandParts(ctx.message.text);
  const input = parts[1]?.trim();
  const providedName = parts.slice(2).join("_").trim();

  if (!input) {
    await ctx.reply("Use:\n/addmintfromlink URL_OR_TEXT mintName");
    return;
  }

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const detection = await detectMint(input);
    const hasMintMetadata = detectionHasMintMetadata(detection);

    if (!detection.contract.address && !hasMintMetadata) {
      await auditMintAction({
        ownerTelegramId,
        action: "mint_target_created_from_link",
        chain: detection.chain.name,
        collectionSlug: detection.contract.collectionSlug,
        status: "blocked",
        reason: "contract_not_detected"
      });
      await ctx.reply(
        "I could not safely detect the contract address. Please create the target manually with /addminttarget."
      );
      return;
    }

    const detectedChain = getDetectedChainForTarget(detection.chain.name);
    const foundCandidates = detection.contract.address
      ? getFoundFunctionCandidates(detection.mint.candidateFunctions)
      : [];
    const target = createMintTarget({
      ownerTelegramId,
      name: generateMintTargetName(ownerTelegramId, detection, providedName),
      chain: detectedChain.chain,
      contractAddress: detection.contract.address || "",
      ...(foundCandidates.length === 1
        ? { functionSignature: foundCandidates[0]!.signature }
        : {}),
      quantity: 1,
      ...(detection.mint.priceEth ? { priceEth: detection.mint.priceEth } : {}),
      ...(detection.contract.collectionSlug
        ? { collectionSlug: detection.contract.collectionSlug }
        : {}),
      ...(detection.source.sourceUrl ? { sourceUrl: detection.source.sourceUrl } : {}),
      detectedMetadata: getDetectionMetadata(detection)
    });

    await auditMintAction({
      ownerTelegramId,
      action: "mint_target_created_from_link",
      targetId: target.targetId,
      ...(target.contractAddress ? { contractAddress: target.contractAddress } : {}),
      chain: target.chain,
      collectionSlug: target.collectionSlug,
      candidateFunctions: foundCandidates.map((candidate) => candidate.signature),
      phaseStatus: detection.mint.phaseStatus,
      phaseTypeEstimate: detection.mint.phaseTypeEstimate,
      phaseTypeConfidence: detection.mint.phaseTypeConfidence,
      status: target.targetCompleteness,
      reason: detection.contract.address
        ? detectedChain.warning
        : "contract_not_detected_saved_incomplete"
    });

    const contractMissingMessage = !detection.contract.address
      ? "\n\nI saved this as an incomplete target. Add contract/function later with /updateminttarget or create manually with /addminttarget."
      : "";

    await ctx.reply(
      `✅ Mint target draft saved.

${formatMintTarget(target)}

${detectedChain.warning ? `Warning: ${detectedChain.warning}\n\n` : ""}${
        target.targetCompleteness === "incomplete"
          ? detection.contract.address
            ? `Complete it with:\n/updateminttarget ${target.targetId} publicMint(uint256) 1 0.03 ${target.chain}`
            : `Complete it with:\n/updateminttarget ${target.targetId} 0xCONTRACT publicMint(uint256) 1 0.03 ${target.chain}${contractMissingMessage}`
          : "Target appears complete, but preview before minting."
      }`
    );
  } catch (error) {
    logSafeError("Could not add mint target from link", error);
    await ctx.reply(`❌ Could not add mint target from link.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.command("detectmintfunction", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = parseCommandParts(ctx.message.text);
  const contractAddress = parts[1]?.trim();

  if (!contractAddress) {
    await ctx.reply("Use:\n/detectmintfunction 0xCONTRACT mainnet");
    return;
  }

  if (!ethers.isAddress(contractAddress)) {
    await ctx.reply("❌ Invalid contract address.");
    return;
  }

  try {
    const chain = normalizeMintChain(parts[2]);
    const result = await detectMintFunctions({
      contractAddress,
      chain
    });
    const found = getFoundFunctionCandidates(result.candidateFunctions);

    await auditMintAction({
      ownerTelegramId: getTelegramUserId(ctx),
      action: "mint_function_detected",
      contractAddress: ethers.getAddress(contractAddress),
      chain,
      candidateFunctions: found.map((candidate) => candidate.signature),
      reason: result.warnings[0]
    });

    if (!result.contractExists) {
      await ctx.reply(
        `No contract code found for ${formatShortAddress(contractAddress)} on ${chain}.`
      );
      return;
    }

    await ctx.reply(
      `Mint Function Detection

Chain: ${chain}
Contract: ${formatShortAddress(contractAddress)}

Candidate functions:
${formatFunctionCandidates(result.candidateFunctions)}

Selector presence is not proof the function is callable. Use /mainmintpreview or /checkminteligibility before minting.`
    );
  } catch (error) {
    logSafeError("Could not detect mint functions", error);
    await ctx.reply(`❌ Could not detect mint functions.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.command("detecttargetfunction", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const targetId = parseCommandParts(ctx.message.text)[1]?.trim();

  if (!targetId) {
    await ctx.reply("Use:\n/detecttargetfunction targetId");
    return;
  }

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const target = getMintTargetForOwner(targetId, ownerTelegramId);

    if (!target.contractAddress || !ethers.isAddress(target.contractAddress)) {
      await ctx.reply(
        "This mint target is missing contractAddress. Add it with:\n/updateminttarget targetId 0xCONTRACT publicMint(uint256) 1 PRICE_ETH mainnet"
      );
      return;
    }

    const result = await detectMintFunctions({
      contractAddress: target.contractAddress,
      chain: target.chain
    });
    const found = getFoundFunctionCandidates(result.candidateFunctions);

    await auditMintAction({
      ownerTelegramId,
      action: "mint_function_detected",
      targetId: target.targetId,
      contractAddress: target.contractAddress,
      chain: target.chain,
      candidateFunctions: found.map((candidate) => candidate.signature),
      reason: result.warnings[0]
    });

    await ctx.reply(
      `Target Function Detection

Target: ${target.name}
Target ID: ${target.targetId}
Chain: ${target.chain}
Contract: ${target.contractAddress ? formatShortAddress(target.contractAddress) : "Unknown"}

Candidate functions:
${formatFunctionCandidates(result.candidateFunctions)}

${
  found.length === 1
    ? `You can update the target with:\n/updateminttarget ${target.targetId} ${found[0]!.signature} 1 PRICE_ETH ${target.chain}`
    : "No single supported function could be safely selected."
}`
    );
  } catch (error) {
    logSafeError("Could not detect target function", error);
    await ctx.reply(`❌ Could not detect target function.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.command("checkmintphase", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const targetId = parseCommandParts(ctx.message.text)[1]?.trim();

  if (!targetId) {
    await ctx.reply("Use:\n/checkmintphase targetId");
    return;
  }

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const target = getMintTargetForOwner(targetId, ownerTelegramId);

    if (!target.contractAddress || !ethers.isAddress(target.contractAddress)) {
      const openSeaMint = target.detectedMetadata?.openSeaMint;
      const openSeaCurrentStage = getOpenSeaMintCurrentStage(openSeaMint);

      await auditMintAction({
        ownerTelegramId,
        action: "mint_phase_checked",
        targetId: target.targetId,
        chain: target.chain,
        collectionSlug: target.collectionSlug,
        phaseStatus: openSeaCurrentStage?.status || target.detectedMetadata?.phaseStatus || "unknown",
        phaseTypeEstimate:
          openSeaCurrentStage?.phaseTypeEstimate ||
          target.detectedMetadata?.phaseTypeEstimate ||
          "unknown",
        phaseTypeConfidence:
          openSeaCurrentStage?.phaseTypeConfidence ||
          target.detectedMetadata?.phaseTypeConfidence ||
          "unknown",
        reason: "contractAddress_missing"
      });

      await ctx.reply(
        [
          "Mint Phase Check",
          "",
          ...(openSeaMint
            ? [
                "Stored OpenSea Mint Schedule",
                "",
                ...formatOpenSeaMintMetadata(openSeaMint),
                ""
              ]
            : []),
          "On-chain phase probe skipped because contractAddress is missing.",
          "Add the contract with /updateminttarget or create manually with /addminttarget."
        ].join("\n")
      );
      return;
    }

    const phase = await detectMintPhase({
      contractAddress: target.contractAddress,
      chain: target.chain,
      evidenceTexts: [
        target.name,
        target.collectionSlug || "",
        target.sourceUrl || "",
        target.notes || ""
      ]
    });

    await auditMintAction({
      ownerTelegramId,
      action: "mint_phase_checked",
      targetId: target.targetId,
      contractAddress: target.contractAddress,
      chain: target.chain,
      collectionSlug: target.collectionSlug,
      phaseStatus: phase.phaseStatus,
      phaseTypeEstimate: phase.phaseTypeEstimate,
      phaseTypeConfidence: phase.phaseTypeConfidence,
      reason: phase.warnings[0]
    });

    await ctx.reply(
      [
        ...(target.detectedMetadata?.openSeaMint
          ? [
              "Stored OpenSea Mint Schedule",
              "",
              ...formatOpenSeaMintMetadata(target.detectedMetadata.openSeaMint),
              "",
              "On-chain Phase Probe",
              ""
            ]
          : []),
        formatPhaseDetectionResult(phase)
      ].join("\n")
    );
  } catch (error) {
    logSafeError("Could not check mint phase", error);
    await ctx.reply(`❌ Could not check mint phase.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.command("checkminteligibility", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = parseCommandParts(ctx.message.text);
  const targetId = parts[1]?.trim();
  const walletLabel = parts[2]?.trim();

  if (!targetId || !walletLabel) {
    await ctx.reply("Use:\n/checkminteligibility targetId wallet1");
    return;
  }

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const target = requireCompleteMintTarget(
      getMintTargetForOwner(targetId, ownerTelegramId)
    );
    const gasStrategy = getTargetGasStrategy(target);
    const preview = await previewMint({
      ownerTelegramId,
      walletLabel,
      contractAddress: target.contractAddress,
      functionSignature: target.functionSignature,
      quantity: target.quantity,
      priceEth: target.priceEth,
      chain: target.chain,
      gasStrategy
    });

    await auditMintAction({
      ownerTelegramId,
      action: "mint_eligibility_checked",
      targetId: target.targetId,
      walletLabel: preview.walletLabel,
      walletAddress: preview.walletAddress,
      contractAddress: target.contractAddress,
      chain: target.chain,
      functionSignature: target.functionSignature,
      quantity: target.quantity,
      priceEth: target.priceEth,
      status: preview.gasEstimateFailed ? "unknown_or_not_eligible" : "likely_callable",
      reason: preview.gasEstimateError
    });

    await ctx.reply(
      `Mint Eligibility Estimate

Target: ${target.name}
Wallet: ${preview.walletLabel}
Address: ${formatShortAddress(preview.walletAddress)}
Gas Estimate: ${preview.gasEstimate || "Not available"}

Result: ${
  preview.gasEstimateFailed
    ? "unknown or not eligible. Mint may not be live, function/price may be wrong, wallet may not be eligible, or contract may reject the call."
    : "likely callable/eligible, but not guaranteed."
}
${preview.gasEstimateError ? `\nReason:\n${preview.gasEstimateError}` : ""}

This is only an estimate. It is not guaranteed eligibility.`
    );
  } catch (error) {
    logSafeError("Could not check mint eligibility", error);
    await ctx.reply(`❌ Could not check mint eligibility.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.command("checkmintreadiness", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = parseCommandParts(ctx.message.text);
  const targetId = parts[1]?.trim();
  const walletLabel = parts[2]?.trim();

  if (!targetId || !walletLabel) {
    await ctx.reply("Use:\n/checkmintreadiness targetId wallet1");
    return;
  }

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const target = getMintTargetForOwner(targetId, ownerTelegramId);
    const targetMissing = getMintTargetMissingFields(target);
    const hasContractAddress = Boolean(
      target.contractAddress && ethers.isAddress(target.contractAddress)
    );
    const openSeaMint = target.detectedMetadata?.openSeaMint;
    const openSeaCurrentStage = getOpenSeaMintCurrentStage(openSeaMint);
    const openSeaPhaseStatus =
      openSeaCurrentStage?.status ||
      (openSeaMint?.mintStatusText?.toLowerCase().includes("minting now")
        ? "live"
        : openSeaMint?.mintStatusText?.toLowerCase().includes("minting soon")
          ? "not_live_yet"
          : openSeaMint?.mintStatusText?.toLowerCase().includes("sold out") ||
              openSeaMint?.mintStatusText?.toLowerCase().includes("mint ended")
            ? "ended"
            : "unknown");
    const pagePriceIsNotEth =
      Boolean(openSeaMint?.currentStagePriceText) &&
      !openSeaMint?.currentStagePriceEth &&
      target.priceEth === undefined;
    const openSeaPhaseBlocksReadiness =
      openSeaPhaseStatus === "not_live_yet" ||
      openSeaPhaseStatus === "ended" ||
      openSeaPhaseStatus === "paused";
    const wallet = await getWalletSummaryByLabelForOwner(walletLabel, ownerTelegramId);
    const contractExists = hasContractAddress
      ? await getContractExists(target.chain, target.contractAddress)
      : false;
    const functionSupported = Boolean(target.functionSignature);
    const phase = hasContractAddress
      ? await detectMintPhase({
          contractAddress: target.contractAddress,
          chain: target.chain,
          evidenceTexts: [
            target.name,
            target.collectionSlug || "",
            target.sourceUrl || "",
            target.notes || ""
          ]
        })
      : null;
    let balanceEnough: boolean | null = null;
    let gasEstimate: string | null = null;
    let gasError: string | undefined;

    if (target.priceEth !== undefined) {
      const provider = getMintProvider(target.chain);
      const balanceWei = await provider.getBalance(wallet.address);
      const totalCostWei = ethers.parseEther(target.priceEth) * BigInt(target.quantity);
      balanceEnough = balanceWei >= totalCostWei;
    }

    if (targetMissing.length === 0 && target.functionSignature && target.priceEth !== undefined) {
      const preview = await previewMint({
        ownerTelegramId,
        walletLabel,
        contractAddress: target.contractAddress,
        functionSignature: target.functionSignature,
        quantity: target.quantity,
        priceEth: target.priceEth,
        chain: target.chain
      });
      gasEstimate = preview.gasEstimate;
      gasError = preview.gasEstimateError;
    }

    const mainnetLockAllows =
      target.chain !== "mainnet" || isMainnetMintingEnabled();
    const phaseStatusForDisplay = phase?.phaseStatus || openSeaPhaseStatus;
    const phaseTypeForDisplay =
      phase?.phaseTypeEstimate ||
      openSeaCurrentStage?.phaseTypeEstimate ||
      target.detectedMetadata?.phaseTypeEstimate ||
      "unknown";
    const phaseTypeConfidenceForDisplay =
      phase?.phaseTypeConfidence ||
      openSeaCurrentStage?.phaseTypeConfidence ||
      target.detectedMetadata?.phaseTypeConfidence ||
      "unknown";
    const notReadyReasons = [
      ...(!hasContractAddress ? ["contractAddress missing"] : []),
      ...(!functionSupported ? ["functionSignature missing"] : []),
      ...(target.priceEth === undefined || target.priceEth === "" ? ["priceEth missing"] : []),
      ...(!contractExists && hasContractAddress ? ["contract not found on selected chain"] : []),
      ...(balanceEnough === false ? ["wallet balance below mint price"] : []),
      ...(pagePriceIsNotEth ? ["OpenSea price is not an ETH value"] : []),
      ...(openSeaPhaseBlocksReadiness ? [`OpenSea phase is ${openSeaPhaseStatus}`] : []),
      ...(!mainnetLockAllows ? ["mainnet minting lock disabled"] : [])
    ];
    const finalStatus =
      notReadyReasons.length > 0 ? "no" : gasEstimate ? "yes" : "unknown";

    await auditMintAction({
      ownerTelegramId,
      action: "mint_readiness_checked",
      targetId: target.targetId,
      walletLabel: wallet.label,
      walletAddress: wallet.address,
      ...(hasContractAddress ? { contractAddress: target.contractAddress } : {}),
      chain: target.chain,
      ...(target.functionSignature ? { functionSignature: target.functionSignature } : {}),
      quantity: target.quantity,
      priceEth: target.priceEth,
      phaseStatus: phaseStatusForDisplay,
      phaseTypeEstimate: phaseTypeForDisplay,
      phaseTypeConfidence: phaseTypeConfidenceForDisplay,
      status: finalStatus,
      reason: gasError || notReadyReasons[0]
    });

    await ctx.reply(
      `Ready Check

Target complete: ${targetMissing.length === 0 ? "yes" : "no"}
Contract exists: ${
        hasContractAddress ? (contractExists ? "yes" : "no") : "no - contractAddress missing"
      }
Supported function: ${functionSupported ? "yes" : "no"}
Wallet active: yes
Balance enough for mint price: ${balanceEnough === null ? "unknown" : balanceEnough ? "yes" : "no"}
Gas estimate: ${gasEstimate ? gasEstimate : "no"}
Phase status: ${phaseStatusForDisplay}
Phase type estimate: ${phaseTypeForDisplay}
Detected OpenSea mint status: ${openSeaMint?.mintStatusText || "unknown"}
Detected current stage: ${openSeaCurrentStage?.stageName || openSeaMint?.currentStageName || "unknown"}
Detected page price: ${openSeaMint?.currentStagePriceText || "unknown"}
Mainnet minting lock: ${isMainnetMintingEnabled() ? "enabled" : "disabled"}

Final:
Ready for manual mint: ${finalStatus}
${targetMissing.length > 0 ? `\nMissing: ${targetMissing.join(", ")}` : ""}${
        notReadyReasons.length > 0
          ? `\nNot ready reason: ${notReadyReasons.join(", ")}`
          : ""
      }${
        pagePriceIsNotEth
          ? `\nDetected page price is not an ETH value. Set priceEth with /updateminttarget before minting.`
          : ""
      }${
        openSeaPhaseBlocksReadiness
          ? `\nDetected page phase is ${openSeaPhaseStatus}; treat this target as not ready.`
          : ""
      }${
        gasError ? `\nGas reason: ${gasError}` : ""
      }${
        phaseTypeForDisplay === "holder_phase"
          ? "\nHolder phase note: holder eligibility verification is limited unless the required collection contract is known."
          : ""
      }${
        openSeaMint
          ? `\n\nStored OpenSea Mint Schedule\n\n${formatOpenSeaMintMetadata(openSeaMint).join("\n")}`
          : ""
      }`
    );
  } catch (error) {
    logSafeError("Could not check mint readiness", error);
    await ctx.reply(`❌ Could not check mint readiness.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.command("refreshtarget", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const targetId = parseCommandParts(ctx.message.text)[1]?.trim();

  if (!targetId) {
    await ctx.reply("Use:\n/refreshtarget targetId");
    return;
  }

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const target = getMintTargetForOwner(targetId, ownerTelegramId);
    const detection = await detectMint(target.sourceUrl || target.contractAddress || target.name);
    const resolvedContractAddress = target.contractAddress || detection.contract.address || "";
    const hasResolvedContract = Boolean(
      resolvedContractAddress && ethers.isAddress(resolvedContractAddress)
    );
    let foundCandidates: MintFunctionCandidate[] = [];
    let functionWarnings: string[] = [];
    let phaseStatus = detection.mint.phaseStatus;
    let phaseTypeEstimate = detection.mint.phaseTypeEstimate;
    let phaseTypeConfidence = detection.mint.phaseTypeConfidence;
    let phaseTypeEvidence = detection.mint.phaseTypeEvidence;
    let phaseConfidence = detection.mint.confidence;
    let phaseWarnings: string[] = [];

    if (hasResolvedContract) {
      const functionResult = await detectMintFunctions({
        contractAddress: resolvedContractAddress,
        chain: target.chain
      });
      const phase = await detectMintPhase({
        contractAddress: resolvedContractAddress,
        chain: target.chain,
        evidenceTexts: [
          target.name,
          target.collectionSlug || "",
          detection.contract.collectionSlug || "",
          target.sourceUrl || "",
          target.notes || ""
        ]
      });

      foundCandidates = getFoundFunctionCandidates(functionResult.candidateFunctions);
      functionWarnings = functionResult.warnings;
      phaseStatus = phase.phaseStatus;
      phaseTypeEstimate = phase.phaseTypeEstimate;
      phaseTypeConfidence = phase.phaseTypeConfidence;
      phaseTypeEvidence = phase.phaseTypeEvidence;
      phaseConfidence = phase.confidence;
      phaseWarnings = phase.warnings;
    }

    const detectedMetadata = {
      ...getDetectionMetadata(detection),
      lastCheckedAt: new Date().toISOString(),
      ...(resolvedContractAddress ? { detectedContractAddress: resolvedContractAddress } : {}),
      detectedChain: target.chain,
      candidateFunctions: foundCandidates.map((candidate) => candidate.signature),
      phaseStatus,
      phaseTypeEstimate,
      phaseTypeConfidence,
      phaseTypeEvidence,
      phaseConfidence,
      warnings: [...detection.warnings, ...functionWarnings, ...phaseWarnings].slice(0, 10)
    };
    const updated = updateMintTargetDetectedMetadataForOwner(
      target.targetId,
      ownerTelegramId,
      {
        ...(target.sourceUrl || detection.source.sourceUrl
          ? { sourceUrl: target.sourceUrl || detection.source.sourceUrl }
          : {}),
        ...(detection.contract.collectionSlug
          ? { collectionSlug: detection.contract.collectionSlug }
          : {}),
        ...(resolvedContractAddress && !target.contractAddress
          ? { contractAddress: resolvedContractAddress }
          : {}),
        detectedMetadata
      }
    );

    await auditMintAction({
      ownerTelegramId,
      action: "mint_target_refreshed",
      targetId: updated.targetId,
      ...(updated.contractAddress ? { contractAddress: updated.contractAddress } : {}),
      chain: updated.chain,
      collectionSlug: updated.collectionSlug,
      candidateFunctions: updated.detectedMetadata?.candidateFunctions,
      phaseStatus: updated.detectedMetadata?.phaseStatus,
      phaseTypeEstimate: updated.detectedMetadata?.phaseTypeEstimate,
      phaseTypeConfidence: updated.detectedMetadata?.phaseTypeConfidence,
      reason: updated.detectedMetadata?.warnings?.[0]
    });

    await ctx.reply(`✅ Mint target refreshed.\n\n${formatMintTarget(updated)}`);
  } catch (error) {
    logSafeError("Could not refresh mint target", error);
    await ctx.reply(`❌ Could not refresh mint target.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.command("setgas", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = parseCommandParts(ctx.message.text);
  const targetId = parts[1]?.trim();

  if (!targetId || !parts[2]) {
    await ctx.reply(
      "Use:\n/setgas targetId auto\n/setgas targetId standard\n/setgas targetId fast\n/setgas targetId custom 25 2"
    );
    return;
  }

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const gasStrategy = parseGasStrategyInput(parts, 2);
    const target = updateMintTargetGasStrategyForOwner(
      targetId,
      ownerTelegramId,
      { gasStrategy }
    );

    await auditMintAction({
      ownerTelegramId,
      action: "gas_strategy_updated",
      targetId: target.targetId,
      chain: target.chain,
      contractAddress: target.contractAddress,
      functionSignature: target.functionSignature,
      quantity: target.quantity,
      priceEth: target.priceEth,
      gasStrategyMode: target.gasStrategy?.mode,
      status: target.status
    });

    await ctx.reply(
      `✅ Gas strategy updated.

Target: ${target.name}
Target ID: ${target.targetId}
Gas Strategy: ${formatGasStrategy(target.gasStrategy)}

No transaction was sent.`
    );
  } catch (error) {
    logSafeError("Could not set gas strategy", error);
    await ctx.reply(`❌ Could not set gas strategy.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.command("gaspreview", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = parseCommandParts(ctx.message.text);
  const targetId = parts[1]?.trim();
  const walletLabel = parts[2]?.trim();

  if (!targetId || !walletLabel) {
    await ctx.reply("Use:\n/gaspreview targetId wallet1");
    return;
  }

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const target = requireCompleteMintTarget(
      getMintTargetForOwner(targetId, ownerTelegramId)
    );
    const preview = await previewGasForTargetWallet({
      ownerTelegramId,
      target,
      walletLabel
    });

    await auditMintAction({
      ownerTelegramId,
      action: "gas_preview_requested",
      walletLabel: preview.walletLabel,
      walletAddress: preview.walletAddress,
      targetId: target.targetId,
      chain: preview.chain,
      contractAddress: preview.contractAddress,
      functionSignature: preview.functionSignature,
      quantity: preview.quantity,
      priceEth: preview.priceEth,
      gasStrategyMode: preview.gasStrategyMode,
      status: preview.gasEstimateFailed ? "failed" : "previewed",
      ...(preview.gasEstimateError ? { reason: preview.gasEstimateError } : {})
    });

    await ctx.reply(
      `Gas Preview

Target: ${target.name}
Target ID: ${target.targetId}
Wallet: ${preview.walletLabel}
Address: ${formatShortAddress(preview.walletAddress)}
Chain: ${preview.chain}
Contract: ${formatShortAddress(preview.contractAddress)}
Function: ${preview.functionSignature}
Quantity: ${preview.quantity}
Mint Price: ${preview.totalCostEth} ETH

${formatGasFields(preview)}

No transaction was sent.${
        preview.gasEstimateFailed
          ? `\n\nGas estimation failed.\nReason: ${preview.gasEstimateError || "Unknown"}`
          : ""
      }`
    );
  } catch (error) {
    logSafeError("Could not preview gas", error);
    await ctx.reply(`❌ Could not preview gas.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.command("multigaspreview", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = parseCommandParts(ctx.message.text);
  const targetId = parts[1]?.trim();
  const rawWallets = parts[2]?.trim();

  if (!targetId || !rawWallets) {
    await ctx.reply("Use:\n/multigaspreview targetId wallet1,wallet2,wallet3");
    return;
  }

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const target = requireCompleteMintTarget(
      getMintTargetForOwner(targetId, ownerTelegramId)
    );
    const walletLabels = parseWalletLabelList(rawWallets);
    await getOwnedActiveWalletSummaries(ownerTelegramId, walletLabels);
    const preflight = await getMultiMintPreflight({
      ownerTelegramId,
      target,
      walletLabels
    });

    await auditMintAction({
      ownerTelegramId,
      action: "multi_gas_preview_requested",
      targetId: target.targetId,
      chain: target.chain,
      contractAddress: target.contractAddress,
      functionSignature: target.functionSignature,
      quantity: target.quantity,
      priceEth: target.priceEth,
      gasStrategyMode: getTargetGasStrategy(target).mode,
      status: preflight.failures.length > 0 ? "partial" : "previewed",
      reason: `wallets:${walletLabels.length}`
    });

    await ctx.reply(
      `${formatMultiGasPreview(preflight.previews, preflight.failures)}

Gas Strategy: ${formatGasStrategy(getTargetGasStrategy(target))}
Wallet Cap: ${getMaxMultiMintWallets()}
Concurrency Cap: ${getMultiMintConcurrency()}`
    );
  } catch (error) {
    logSafeError("Could not preview multi-wallet gas", error);
    await ctx.reply(`❌ Could not preview multi-wallet gas.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});



type MintFlowTargetDraftStep =
  | "name"
  | "contractAddress"
  | "functionSignature"
  | "quantity"
  | "priceEth"
  | "chain";

type MintFlowTargetDraftData = {
  name?: string;
  contractAddress?: string;
  functionSignature?: SupportedMintFunctionSignature;
  quantity?: number;
  priceEth?: string;
  chain?: MintChain;
  sourceUrl?: string;
  collectionSlug?: string;
};

type MintFlowTargetDraftSession = {
  sessionId: string;
  ownerTelegramId: string;
  step: MintFlowTargetDraftStep;
  data: MintFlowTargetDraftData;
  createdAt: string;
  expiresAt: string;
  status: "active" | "used" | "cancelled" | "expired";
};

const MINT_FLOW_TARGET_DRAFT_TTL_MS = 15 * 60 * 1000;
const mintFlowTargetDraftSessions = new Map<string, MintFlowTargetDraftSession>();
const activeMintFlowTargetDraftByOwner = new Map<string, string>();

const MINT_FLOW_FUNCTION_PRESETS = {
  mint: "mint(uint256)",
  publicMint: "publicMint(uint256)",
  mintPublic: "mintPublic(uint256)",
  mintTo: "mintTo(address,uint256)",
  publicMintTo: "publicMint(address,uint256)",
  seaDropMintPublic: "mintPublic(address,address,address,uint256)"
} as const;

const MINT_FLOW_PRICE_PRESETS = {
  free: "0",
  p001: "0.01",
  p003: "0.03",
  p005: "0.05"
} as const;

function createMintFlowTargetDraftSessionId() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const sessionId = randomUUID().replace(/-/g, "").slice(0, 8);

    if (!mintFlowTargetDraftSessions.has(sessionId)) {
      return sessionId;
    }
  }

  return randomUUID().replace(/-/g, "").slice(0, 12);
}

function isMintFlowTargetDraftExpired(session: MintFlowTargetDraftSession) {
  const expiresAtMs = Date.parse(session.expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now();
}

function cleanupMintFlowTargetDraftSessions() {
  for (const [sessionId, session] of mintFlowTargetDraftSessions.entries()) {
    if (session.status === "active" && isMintFlowTargetDraftExpired(session)) {
      session.status = "expired";
    }

    const expiresAtMs = Date.parse(session.expiresAt);
    const cleanupAfterMs = Number.isFinite(expiresAtMs)
      ? expiresAtMs + MINT_FLOW_TARGET_DRAFT_TTL_MS
      : Date.now();

    if (cleanupAfterMs <= Date.now()) {
      mintFlowTargetDraftSessions.delete(sessionId);

      if (activeMintFlowTargetDraftByOwner.get(session.ownerTelegramId) === sessionId) {
        activeMintFlowTargetDraftByOwner.delete(session.ownerTelegramId);
      }
    }
  }
}

function createMintFlowTargetDraftSession(ownerTelegramId: string) {
  cleanupMintFlowTargetDraftSessions();

  const existingId = activeMintFlowTargetDraftByOwner.get(ownerTelegramId);

  if (existingId) {
    const existing = mintFlowTargetDraftSessions.get(existingId);

    if (existing && existing.status === "active" && !isMintFlowTargetDraftExpired(existing)) {
      return existing;
    }
  }

  const createdAt = new Date();
  const session: MintFlowTargetDraftSession = {
    sessionId: createMintFlowTargetDraftSessionId(),
    ownerTelegramId,
    step: "name",
    data: {},
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(
      createdAt.getTime() + MINT_FLOW_TARGET_DRAFT_TTL_MS
    ).toISOString(),
    status: "active"
  };

  mintFlowTargetDraftSessions.set(session.sessionId, session);
  activeMintFlowTargetDraftByOwner.set(ownerTelegramId, session.sessionId);
  return session;
}

function getActiveMintFlowTargetDraftSession(ownerTelegramId: string) {
  cleanupMintFlowTargetDraftSessions();

  const sessionId = activeMintFlowTargetDraftByOwner.get(ownerTelegramId);

  if (!sessionId) {
    return null;
  }

  const session = mintFlowTargetDraftSessions.get(sessionId);

  if (!session || session.status !== "active" || isMintFlowTargetDraftExpired(session)) {
    activeMintFlowTargetDraftByOwner.delete(ownerTelegramId);

    if (session) {
      session.status = "expired";
    }

    return null;
  }

  return session;
}

async function getMintFlowTargetDraftSession(ctx: Context, sessionId: string) {
  cleanupMintFlowTargetDraftSessions();

  const actorTelegramId = getTelegramUserId(ctx);

  if (!actorTelegramId) {
    await ctx.reply("❌ Could not verify your Telegram account for this action.");
    return null;
  }

  const session = mintFlowTargetDraftSessions.get(sessionId);

  if (!session) {
    await ctx.reply("This target creation flow has expired. Run /mintflow again.");
    return null;
  }

  if (session.ownerTelegramId !== actorTelegramId) {
    await ctx.reply("You cannot use this target creation flow.");
    return null;
  }

  if (session.status !== "active" || isMintFlowTargetDraftExpired(session)) {
    session.status = "expired";
    await ctx.reply("This target creation flow has expired. Run /mintflow again.");
    return null;
  }

  return session;
}

function getNextMintFlowTargetDraftStep(
  session: MintFlowTargetDraftSession
): MintFlowTargetDraftStep | null {
  if (!session.data.name) return "name";
  if (!session.data.contractAddress) return "contractAddress";
  if (!session.data.functionSignature) return "functionSignature";
  if (!session.data.quantity) return "quantity";
  if (!session.data.priceEth) return "priceEth";
  if (!session.data.chain) return "chain";
  return null;
}

function formatMintFlowTargetDraftProgress(session: MintFlowTargetDraftSession) {
  return [
    `Name: ${session.data.name || "Not set"}`,
    `Contract: ${session.data.contractAddress ? formatShortAddress(session.data.contractAddress) : "Not set"}`,
    `Function: ${session.data.functionSignature || "Not set"}`,
    `Quantity: ${session.data.quantity || "Not set"}`,
    `Price: ${session.data.priceEth === undefined ? "Not set" : `${session.data.priceEth} ETH`}`,
    `Chain: ${session.data.chain || "Not set"}`
  ].join("\n");
}


async function scanMintFlowTargetDraftFunctions(
  ctx: Context,
  session: MintFlowTargetDraftSession,
  walletLabel: string
) {
  if (!session.data.contractAddress || !session.data.chain) {
    await ctx.reply("Add a contract address or OpenSea link before scanning functions.");
    return;
  }

  const quantity = session.data.quantity || 1;
  const priceEth = session.data.priceEth ?? "0";
  const results: Array<{
    signature: SupportedMintFunctionSignature;
    ok: boolean;
    gasEstimate?: string | null;
    reason?: string;
  }> = [];

  await ctx.reply(
    `🤖 Scanning supported mint functions...

Wallet: ${walletLabel}
Chain: ${session.data.chain}
Contract: ${formatShortAddress(session.data.contractAddress)}
Quantity Used: ${quantity}
Price Used: ${priceEth} ETH

This is a gas/readiness simulation only. No transaction will be sent.`
  );

  for (const signature of SUPPORTED_MINT_FUNCTION_SIGNATURES) {
    try {
      const preview = await previewMint({
        ownerTelegramId: session.ownerTelegramId,
        walletLabel,
        contractAddress: session.data.contractAddress,
        functionSignature: signature,
        quantity,
        priceEth,
        chain: session.data.chain
      });

      results.push({
        signature,
        ok: !preview.gasEstimateFailed && Boolean(preview.gasEstimate),
        gasEstimate: preview.gasEstimate,
        ...(preview.gasEstimateError ? { reason: preview.gasEstimateError } : {})
      });
    } catch (error) {
      results.push({
        signature,
        ok: false,
        reason: getSafeErrorMessage(error)
      });
    }
  }

  const working = results.filter((result) => result.ok);
  const report = [
    "🤖 Function Scan Result",
    "",
    `Wallet: ${walletLabel}`,
    `Chain: ${session.data.chain}`,
    `Contract: ${formatShortAddress(session.data.contractAddress)}`,
    `Quantity Used: ${quantity}`,
    `Price Used: ${priceEth} ETH`,
    "",
    ...results.map((result) => {
      if (result.ok) {
        return `✅ ${result.signature} — gas estimate ${result.gasEstimate}`;
      }

      return `❌ ${result.signature}${result.reason ? ` — ${result.reason}` : ""}`;
    }),
    "",
    working.length === 1
      ? `Recommended: ${working[0]!.signature}`
      : working.length > 1
        ? "Multiple functions simulated successfully. Pick the one that matches the project's official mint docs."
        : "No supported function simulated successfully. This mint may require a custom whitelist/proof/signature function."
  ].join("\n");

  await ctx.reply(report);

  await auditMintAction({
    ownerTelegramId: session.ownerTelegramId,
    action: "guided_mint_function_scan",
    walletLabel,
    chain: session.data.chain,
    contractAddress: session.data.contractAddress,
    quantity,
    priceEth,
    candidateFunctions: results
      .filter((result) => result.ok)
      .map((result) => result.signature),
    status:
      working.length === 1
        ? "single_supported_function"
        : working.length > 1
          ? "multiple_supported_functions"
          : "no_supported_function",
    reason:
      working.length === 1
        ? working[0]!.signature
        : working.length > 1
          ? "multiple_simulation_successes"
          : "all_supported_functions_failed"
  });

  if (working.length === 1) {
    session.data.functionSignature = working[0]!.signature;
    await ctx.reply(`✅ Auto-selected function: ${session.data.functionSignature}`);
    await sendMintFlowTargetDraftPrompt(ctx, session);
    return;
  }

  if (working.length > 1) {
    await ctx.reply(
      "Choose one of the successful functions:",
      Markup.inlineKeyboard([
        ...working.map((result) => [
          Markup.button.callback(
            result.signature,
            `mft:f:${session.sessionId}:${Object.entries(MINT_FLOW_FUNCTION_PRESETS).find(([, value]) => value === result.signature)?.[0] || "publicMint"}`
          )
        ]),
        [Markup.button.callback("Cancel", `mft:cancel:${session.sessionId}`)]
      ])
    );
    return;
  }

  await sendMintFlowTargetDraftPrompt(ctx, session);
}

async function sendMintFlowFunctionScanWalletSelection(
  ctx: Context,
  session: MintFlowTargetDraftSession
) {
  const wallets = (await listWalletsForOwner(session.ownerTelegramId)).filter(
    (wallet) => wallet.status !== "archived"
  );

  if (wallets.length === 0) {
    await ctx.reply("No active wallets found. Add a wallet first, then scan functions.");
    return;
  }

  await ctx.reply(
    `Choose the wallet to simulate with.

For public mints, pick a funded wallet.
For GTD/whitelist, pick the wallet that is actually eligible.

No transaction will be sent.`,
    Markup.inlineKeyboard([
      ...wallets.map((wallet) => [
        Markup.button.callback(
          `${wallet.label} (${formatShortAddress(wallet.address)})`,
          `mft:scanw:${session.sessionId}:${wallet.label}`
        )
      ]),
      [Markup.button.callback("Cancel", `mft:cancel:${session.sessionId}`)]
    ])
  );
}


async function sendMintFlowTargetDraftPrompt(
  ctx: Context,
  session: MintFlowTargetDraftSession
) {
  const step = getNextMintFlowTargetDraftStep(session);

  if (!step) {
    await finalizeMintFlowTargetDraft(ctx, session);
    return;
  }

  session.step = step;

  if (step === "name") {
    await ctx.reply(
      `➕ Create New Mint Target

Step 1/6: send the target name.

Use 2-40 characters. Letters, numbers, hyphen, and underscore only.

Example:
azukiMint`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Cancel", `mft:cancel:${session.sessionId}`)]
      ])
    );
    return;
  }

  if (step === "contractAddress") {
    await ctx.reply(
      `Step 2/6: send the contract address or mint page link.

Progress:
${formatMintFlowTargetDraftProgress(session)}

Examples:
0x1234...
https://opensea.io/collection/collection-name

The bot will try to auto-detect contract, chain, function, and price from supported links.

Do not send private keys or seed phrases.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Cancel", `mft:cancel:${session.sessionId}`)]
      ])
    );
    return;
  }

  if (step === "functionSignature") {
    await ctx.reply(
      `Step 3/6: choose the mint function.

Progress:
${formatMintFlowTargetDraftProgress(session)}

Most common:
- publicMint(uint256)
- mint(uint256)

OpenSea SeaDrop:
- mintPublic(address,address,address,uint256)

For OpenSea public mints, use Auto-Scan Route with Wallet or choose OpenSea SeaDrop if the route was already detected.

You can also type a supported function manually.`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback("publicMint(uint256)", `mft:f:${session.sessionId}:publicMint`),
          Markup.button.callback("mint(uint256)", `mft:f:${session.sessionId}:mint`)
        ],
        [
          Markup.button.callback("mintPublic(uint256)", `mft:f:${session.sessionId}:mintPublic`)
        ],
        [
          Markup.button.callback("mintTo(address,uint256)", `mft:f:${session.sessionId}:mintTo`)
        ],
        [
          Markup.button.callback("publicMint(address,uint256)", `mft:f:${session.sessionId}:publicMintTo`)
        ],
        [
          Markup.button.callback("OpenSea SeaDrop", `mft:f:${session.sessionId}:seaDropMintPublic`)
        ],
        [Markup.button.callback("🤖 Auto-Scan Route with Wallet", `mft:scan:${session.sessionId}`)],
        [Markup.button.callback("Cancel", `mft:cancel:${session.sessionId}`)]
      ])
    );
    return;
  }

  if (step === "quantity") {
    await ctx.reply(
      `Step 4/6: choose quantity.

Progress:
${formatMintFlowTargetDraftProgress(session)}

You can tap a button or type a whole number.`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback("1", `mft:q:${session.sessionId}:1`),
          Markup.button.callback("2", `mft:q:${session.sessionId}:2`),
          Markup.button.callback("3", `mft:q:${session.sessionId}:3`)
        ],
        [Markup.button.callback("Cancel", `mft:cancel:${session.sessionId}`)]
      ])
    );
    return;
  }

  if (step === "priceEth") {
    await ctx.reply(
      `Step 5/6: choose mint price per NFT.

Progress:
${formatMintFlowTargetDraftProgress(session)}

You can tap a button or type the ETH price.`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback("Free / 0 ETH", `mft:p:${session.sessionId}:free`),
          Markup.button.callback("0.01 ETH", `mft:p:${session.sessionId}:p001`)
        ],
        [
          Markup.button.callback("0.03 ETH", `mft:p:${session.sessionId}:p003`),
          Markup.button.callback("0.05 ETH", `mft:p:${session.sessionId}:p005`)
        ],
        [Markup.button.callback("Cancel", `mft:cancel:${session.sessionId}`)]
      ])
    );
    return;
  }

  await ctx.reply(
    `Step 6/6: choose chain.

Progress:
${formatMintFlowTargetDraftProgress(session)}

For testing, use Sepolia.
For live minting, use Mainnet. Mainnet sends still stay protected by your existing safety lock.`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback("Sepolia", `mft:c:${session.sessionId}:sepolia`),
        Markup.button.callback("Mainnet", `mft:c:${session.sessionId}:mainnet`)
      ],
      [Markup.button.callback("Cancel", `mft:cancel:${session.sessionId}`)]
    ])
  );
}

async function finalizeMintFlowTargetDraft(
  ctx: Context,
  session: MintFlowTargetDraftSession
) {
  const {
    name,
    contractAddress,
    functionSignature,
    quantity,
    priceEth,
    chain,
    sourceUrl,
    collectionSlug
  } = session.data;

  if (!name || !contractAddress || !functionSignature || !quantity || priceEth === undefined || !chain) {
    await sendMintFlowTargetDraftPrompt(ctx, session);
    return;
  }

  const target = createMintTarget({
    ownerTelegramId: session.ownerTelegramId,
    name,
    contractAddress,
    functionSignature,
    quantity,
    priceEth,
    chain,
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(collectionSlug ? { collectionSlug } : {})
  });

  session.status = "used";
  activeMintFlowTargetDraftByOwner.delete(session.ownerTelegramId);

  await auditMintAction({
    ownerTelegramId: session.ownerTelegramId,
    action: "guided_mint_target_created",
    targetId: target.targetId,
    chain: target.chain,
    contractAddress: target.contractAddress,
    functionSignature: target.functionSignature,
    quantity: target.quantity,
    priceEth: target.priceEth,
    status: target.status
  });

  await ctx.reply(
    `✅ Mint target created.

${formatMintTarget(target)}

Next:
Choose what you want to do with this target.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🚀 Continue Quick Mint", `mfw:t:q:${target.targetId}`)],
      [Markup.button.callback("✅ Check Readiness", `mfw:t:r:${target.targetId}`)],
      [Markup.button.callback("⬅️ Back to Mint Flow", "mf:menu")]
    ])
  );
}

async function applyMintFlowTargetDraftText(
  ctx: Context,
  session: MintFlowTargetDraftSession,
  input: string
) {
  try {
    if (session.step === "name") {
      session.data.name = sanitizeMintTargetName(input);
    } else if (session.step === "contractAddress") {
      if (ethers.isAddress(input)) {
        session.data.contractAddress = ethers.getAddress(input);
      } else {
        const linkInput = getDirectMintLinkInput(input);

        if (!linkInput) {
          throw new Error("Invalid contract address or unsupported mint link.");
        }

        await ctx.reply("🔎 Detecting mint details from link...");

        const resolverResult = await resolveOpenSeaContractForMintFlow(linkInput);

        if (resolverResult.status !== "resolved") {
          await auditMintAction({
            ownerTelegramId: session.ownerTelegramId,
            action: "guided_mint_target_link_detected",
            collectionSlug: "slug" in resolverResult ? resolverResult.slug : undefined,
            status: resolverResult.status,
            reason: "message" in resolverResult ? resolverResult.message : resolverResult.status
          });

          await ctx.reply(formatOpenSeaResolverUserMessage(resolverResult));
          return;
        }

        const candidate = resolverResult.candidate;

        if (!candidate.supportedMintChain) {
          await ctx.reply(
            `OpenSea resolved a contract, but the chain is not supported by this bot yet.

Resolved:
${candidate.chainName}: ${formatShortAddress(candidate.address)}

Paste an Ethereum mainnet or Sepolia contract address to continue.`
          );
          return;
        }

        session.data.contractAddress = ethers.getAddress(candidate.address);
        session.data.chain = candidate.supportedMintChain;
        session.data.collectionSlug = resolverResult.slug;
        session.data.sourceUrl = linkInput;

        await ctx.reply(
          `✅ OpenSea contract resolved.

Slug: ${resolverResult.slug}
Chain: ${session.data.chain}
Contract: ${formatShortAddress(session.data.contractAddress)}`
        );

        try {
          const detection = await detectMint(linkInput);
          const foundCandidates = getFoundFunctionCandidates(detection.mint.candidateFunctions);

          if (foundCandidates.length === 1) {
            session.data.functionSignature = normalizeMintFunctionSignature(
              foundCandidates[0]!.signature
            );
          }

          if (detection.mint.priceEth) {
            session.data.priceEth = validateMintPriceEth(detection.mint.priceEth);
          }

          await auditMintAction({
            ownerTelegramId: session.ownerTelegramId,
            action: "guided_mint_target_link_detected",
            chain: session.data.chain,
            contractAddress: session.data.contractAddress,
            collectionSlug: resolverResult.slug,
            candidateFunctions: foundCandidates.map((foundCandidate) => foundCandidate.signature),
            phaseStatus: detection.mint.phaseStatus,
            phaseTypeEstimate: detection.mint.phaseTypeEstimate,
            phaseTypeConfidence: detection.mint.phaseTypeConfidence,
            status: "detected",
            reason: `opensea_resolver:${candidate.source}`
          });
        } catch (detectionError) {
          logSafeError("OpenSea mint metadata detection failed after contract resolution", detectionError);

          await auditMintAction({
            ownerTelegramId: session.ownerTelegramId,
            action: "guided_mint_target_link_detected",
            chain: session.data.chain,
            contractAddress: session.data.contractAddress,
            collectionSlug: resolverResult.slug,
            status: "contract_detected_metadata_failed",
            reason: getSafeErrorMessage(detectionError)
          });
        }

        if (linkInput.includes("opensea.io") && session.data.chain === "mainnet") {
          session.data.functionSignature = normalizeMintFunctionSignature(
            "mintPublic(address,address,address,uint256)"
          );

          await ctx.reply(
            "✅ OpenSea SeaDrop route auto-selected. You do not need to choose a mint function manually."
          );
        }
      }
    } else if (session.step === "functionSignature") {
      session.data.functionSignature = normalizeMintFunctionSignature(input);
    } else if (session.step === "quantity") {
      session.data.quantity = validateMintQuantity(input);
    } else if (session.step === "priceEth") {
      session.data.priceEth = validateMintPriceEth(input);
    } else if (session.step === "chain") {
      session.data.chain = normalizeMintChain(input);
    }

    await sendMintFlowTargetDraftPrompt(ctx, session);
  } catch (error) {
    await ctx.reply(
      `❌ Invalid value.

Reason:
${getSafeErrorMessage(error)}

Please try again.`
    );
    await sendMintFlowTargetDraftPrompt(ctx, session);
  }
}

async function handleMintFlowTargetDraftText(ctx: Context) {
  const ownerTelegramId = getTelegramUserId(ctx);

  if (!ownerTelegramId) {
    return false;
  }

  const session = getActiveMintFlowTargetDraftSession(ownerTelegramId);

  if (!session) {
    return false;
  }

  if (!(await requireAdmin(ctx))) {
    return true;
  }

  const rawText = (ctx as any).message?.text;

  if (typeof rawText !== "string") {
    return true;
  }

  const input = rawText.trim();

  if (!input || input.startsWith("/")) {
    return false;
  }

  await applyMintFlowTargetDraftText(ctx, session, input);
  return true;
}


type MintFlowWizardAction = "ready" | "quick";

type MintFlowWizardSession = {
  sessionId: string;
  ownerTelegramId: string;
  action: MintFlowWizardAction;
  targetId: string;
  walletLabels: string[];
  gasStrategy?: GasStrategy;
  createdAt: string;
  expiresAt: string;
  status: "active" | "used" | "cancelled" | "expired";
};

const MINT_FLOW_WIZARD_TTL_MS = 10 * 60 * 1000;
const mintFlowWizardSessions = new Map<string, MintFlowWizardSession>();

function createMintFlowWizardSessionId() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const sessionId = randomUUID().replace(/-/g, "").slice(0, 8);

    if (!mintFlowWizardSessions.has(sessionId)) {
      return sessionId;
    }
  }

  return randomUUID().replace(/-/g, "").slice(0, 12);
}

function isMintFlowWizardExpired(session: MintFlowWizardSession) {
  const expiresAtMs = Date.parse(session.expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now();
}

function cleanupMintFlowWizardSessions() {
  for (const [sessionId, session] of mintFlowWizardSessions.entries()) {
    if (session.status === "active" && isMintFlowWizardExpired(session)) {
      session.status = "expired";
    }

    const expiresAtMs = Date.parse(session.expiresAt);
    const cleanupAfterMs = Number.isFinite(expiresAtMs)
      ? expiresAtMs + MINT_FLOW_WIZARD_TTL_MS
      : Date.now();

    if (cleanupAfterMs <= Date.now()) {
      mintFlowWizardSessions.delete(sessionId);
    }
  }
}

function createMintFlowWizardSession(params: {
  ownerTelegramId: string;
  action: MintFlowWizardAction;
  targetId: string;
}) {
  cleanupMintFlowWizardSessions();

  const createdAt = new Date();
  const session: MintFlowWizardSession = {
    sessionId: createMintFlowWizardSessionId(),
    ownerTelegramId: params.ownerTelegramId,
    action: params.action,
    targetId: params.targetId,
    walletLabels: [],
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + MINT_FLOW_WIZARD_TTL_MS).toISOString(),
    status: "active"
  };

  mintFlowWizardSessions.set(session.sessionId, session);
  return session;
}

async function getMintFlowWizardSession(ctx: Context, sessionId: string) {
  cleanupMintFlowWizardSessions();

  const actorTelegramId = getTelegramUserId(ctx);

  if (!actorTelegramId) {
    await ctx.reply("❌ Could not verify your Telegram account for this action.");
    return null;
  }

  const session = mintFlowWizardSessions.get(sessionId);

  if (!session) {
    await ctx.reply("This mint flow has expired. Run /mintflow again.");
    return null;
  }

  if (session.ownerTelegramId !== actorTelegramId) {
    await ctx.reply("You cannot use this mint flow.");
    return null;
  }

  if (session.status !== "active" || isMintFlowWizardExpired(session)) {
    session.status = "expired";
    await ctx.reply("This mint flow has expired. Run /mintflow again.");
    return null;
  }

  return session;
}

function getMintFlowActionCode(action: MintFlowWizardAction) {
  return action === "quick" ? "q" : "r";
}

function getMintFlowActionFromCode(rawAction: string): MintFlowWizardAction {
  return rawAction === "q" ? "quick" : "ready";
}

function getMintFlowActionLabel(action: MintFlowWizardAction) {
  return action === "quick" ? "Quick Mint" : "Check Readiness";
}

function chunkMintFlowRows<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    rows.push(items.slice(index, index + size));
  }

  return rows;
}

function getMintFlowPresetGasStrategy(
  mode: "target" | "auto" | "standard" | "fast",
  target: MintTarget
) {
  if (mode === "target") {
    return getTargetGasStrategy(target);
  }

  return parseGasStrategyInput(["", "", mode], 2);
}

async function sendMintFlowTargetSelection(ctx: Context, action: MintFlowWizardAction) {
  const ownerTelegramId = getRequiredTelegramUserId(ctx);
  const targets = listMintTargetsForOwner(ownerTelegramId);

  if (targets.length === 0) {
    await ctx.reply("No active mint targets found. Add one with /addminttarget.");
    return;
  }

  await ctx.reply(
    `${getMintFlowActionLabel(action)}

Step 1/4: choose a saved mint target.`,
    Markup.inlineKeyboard([
      ...targets.map((target) => [
        Markup.button.callback(
          `${target.name} (${target.chain})`,
          `mfw:t:${getMintFlowActionCode(action)}:${target.targetId}`
        )
      ]),
      [Markup.button.callback("➕ Create New Target", "mf:create_target")],
      [Markup.button.callback("⬅️ Back to Menu", "mf:menu")]
    ])
  );
}

async function sendMintFlowWalletSelection(ctx: Context, session: MintFlowWizardSession) {
  const wallets = await listWalletsForOwner(session.ownerTelegramId);
  const activeWallets = wallets.filter((wallet) => wallet.status !== "archived");
  const target = getMintTargetForOwner(session.targetId, session.ownerTelegramId);

  if (activeWallets.length === 0) {
    await ctx.reply("No active wallets found. Add one with /addwallet.");
    return;
  }

  const walletButtons = activeWallets.map((wallet) =>
    Markup.button.callback(
      `${session.walletLabels.includes(wallet.label) ? "✅ " : ""}${wallet.label}`,
      `mfw:w:${session.sessionId}:${wallet.label}`
    )
  );

  await ctx.reply(
    `${getMintFlowActionLabel(session.action)}

Target: ${target.name}
Target ID: ${target.targetId}

Step 2/4: choose wallet(s).

Selected: ${session.walletLabels.length > 0 ? session.walletLabels.join(", ") : "none"}

Tap wallet buttons to select/unselect.`,
    Markup.inlineKeyboard([
      ...chunkMintFlowRows(walletButtons, 2),
      [Markup.button.callback("Continue → Gas", `mfw:wg:${session.sessionId}`)],
      [Markup.button.callback("Cancel", `mfw:cancel:${session.sessionId}`)]
    ])
  );
}

async function sendMintFlowGasSelection(ctx: Context, session: MintFlowWizardSession) {
  const target = getMintTargetForOwner(session.targetId, session.ownerTelegramId);
  const targetGasStrategy = getTargetGasStrategy(target);

  await ctx.reply(
    `${getMintFlowActionLabel(session.action)}

Target: ${target.name}
Wallets: ${session.walletLabels.join(", ")}

Step 3/4: choose gas strategy.

Target default: ${formatGasStrategy(targetGasStrategy)}

Custom gas is still supported through:
/quickmint targetId wallet1 custom maxFeeGwei priorityFeeGwei`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback("Target Default", `mfw:g:${session.sessionId}:target`),
        Markup.button.callback("Auto", `mfw:g:${session.sessionId}:auto`)
      ],
      [
        Markup.button.callback("Standard", `mfw:g:${session.sessionId}:standard`),
        Markup.button.callback("Fast", `mfw:g:${session.sessionId}:fast`)
      ],
      [
        Markup.button.callback("⬅️ Wallets", `mfw:backw:${session.sessionId}`),
        Markup.button.callback("Cancel", `mfw:cancel:${session.sessionId}`)
      ]
    ])
  );
}

async function sendMintFlowReadyResult(ctx: Context, session: MintFlowWizardSession) {
  if (!session.gasStrategy) {
    await sendMintFlowGasSelection(ctx, session);
    return;
  }

  const target = requireCompleteMintTarget(
    getMintTargetForOwner(session.targetId, session.ownerTelegramId)
  );

  if (session.walletLabels.length === 1) {
    const walletLabel = session.walletLabels[0]!;
    const preview = await previewGasForTargetWallet({
      ownerTelegramId: session.ownerTelegramId,
      target,
      walletLabel,
      gasStrategy: session.gasStrategy
    });
    const failures = getPreviewReadinessFailures(preview);

    await ctx.reply(
      `Mint Readiness

Target: ${target.name}
Target ID: ${target.targetId}
Wallet Count: 1
Gas Strategy: ${formatGasStrategy(session.gasStrategy)}

Wallet: ${preview.walletLabel}
Address: ${formatShortAddress(preview.walletAddress)}

${formatGasFields(preview)}

Recommendation:
${formatMintReadinessRecommendation([preview], failures)}

No transaction was sent.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🚀 Create Confirmation", `mfw:create:${session.sessionId}`)],
        [Markup.button.callback("Change Gas", `mfw:gasback:${session.sessionId}`)],
        [Markup.button.callback("Cancel", `mfw:cancel:${session.sessionId}`)]
      ])
    );
    return;
  }

  const wallets = await getOwnedActiveWalletSummaries(
    session.ownerTelegramId,
    session.walletLabels
  );
  const preflight = await getMultiMintPreflight({
    ownerTelegramId: session.ownerTelegramId,
    target,
    walletLabels: session.walletLabels,
    gasStrategy: session.gasStrategy
  });

  await ctx.reply(
    `Mint Readiness

Target: ${target.name}
Target ID: ${target.targetId}
Wallet Count: ${wallets.length}
Wallets: ${wallets.map((wallet) => wallet.label).join(", ")}
Gas Strategy: ${formatGasStrategy(session.gasStrategy)}

${formatMultiGasPreview(preflight.previews, preflight.failures)}

Recommendation:
${formatMintReadinessRecommendation(preflight.previews, preflight.failures)}`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🚀 Create Confirmation", `mfw:create:${session.sessionId}`)],
      [Markup.button.callback("Change Gas", `mfw:gasback:${session.sessionId}`)],
      [Markup.button.callback("Cancel", `mfw:cancel:${session.sessionId}`)]
    ])
  );
}

async function sendMintFlowReview(ctx: Context, session: MintFlowWizardSession) {
  if (session.action === "ready") {
    await sendMintFlowReadyResult(ctx, session);
    return;
  }

  if (!session.gasStrategy) {
    await sendMintFlowGasSelection(ctx, session);
    return;
  }

  const target = requireCompleteMintTarget(
    getMintTargetForOwner(session.targetId, session.ownerTelegramId)
  );

  if (session.walletLabels.length === 1) {
    const walletLabel = session.walletLabels[0]!;
    const preview = await previewGasForTargetWallet({
      ownerTelegramId: session.ownerTelegramId,
      target,
      walletLabel,
      gasStrategy: session.gasStrategy
    });
    const failures = getPreviewReadinessFailures(preview);

    await ctx.reply(
      `Quick Mint Review

Target: ${target.name}
Target ID: ${target.targetId}
Wallet: ${preview.walletLabel}
Gas Strategy: ${formatGasStrategy(session.gasStrategy)}

${formatGasFields(preview)}

Recommendation:
${formatMintReadinessRecommendation([preview], failures)}

Step 4/4: create final confirmation.

No transaction will be sent until you press Confirm Mint on the next screen.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Create Confirmation", `mfw:create:${session.sessionId}`)],
        [Markup.button.callback("Change Gas", `mfw:gasback:${session.sessionId}`)],
        [Markup.button.callback("Cancel", `mfw:cancel:${session.sessionId}`)]
      ])
    );
    return;
  }

  const wallets = await getOwnedActiveWalletSummaries(
    session.ownerTelegramId,
    session.walletLabels
  );
  const preflight = await getMultiMintPreflight({
    ownerTelegramId: session.ownerTelegramId,
    target,
    walletLabels: session.walletLabels,
    gasStrategy: session.gasStrategy
  });

  await ctx.reply(
    `Quick Multi-Mint Review

Target: ${target.name}
Target ID: ${target.targetId}
Wallets (${wallets.length}): ${wallets.map((wallet) => wallet.label).join(", ")}
Gas Strategy: ${formatGasStrategy(session.gasStrategy)}

${formatMultiGasPreview(preflight.previews, preflight.failures)}

Recommendation:
${formatMintReadinessRecommendation(preflight.previews, preflight.failures)}

Step 4/4: create final confirmation.

No transaction will be sent until you press Confirm Multi Mint on the next screen.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("Create Multi-Mint Confirmation", `mfw:create:${session.sessionId}`)],
      [Markup.button.callback("Change Gas", `mfw:gasback:${session.sessionId}`)],
      [Markup.button.callback("Cancel", `mfw:cancel:${session.sessionId}`)]
    ])
  );
}

async function createMintFlowFinalConfirmation(ctx: Context, session: MintFlowWizardSession) {
  if (!session.gasStrategy) {
    await sendMintFlowGasSelection(ctx, session);
    return;
  }

  const target = requireCompleteMintTarget(
    getMintTargetForOwner(session.targetId, session.ownerTelegramId)
  );

  if (session.walletLabels.length === 1) {
    const walletLabel = session.walletLabels[0]!;
    const preview = await previewGasForTargetWallet({
      ownerTelegramId: session.ownerTelegramId,
      target,
      walletLabel,
      gasStrategy: session.gasStrategy
    });
    const run = createRunFromPreview(
      session.ownerTelegramId,
      preview,
      "pending",
      target.targetId
    );
    const mintSession = createMintConfirmationSession({
      ownerTelegramId: session.ownerTelegramId,
      walletLabel: preview.walletLabel,
      walletAddress: preview.walletAddress,
      chain: preview.chain,
      contractAddress: preview.contractAddress,
      functionSignature: preview.functionSignature,
      quantity: preview.quantity,
      priceEth: preview.priceEth,
      runId: run.runId,
      targetId: target.targetId,
      gasStrategy: session.gasStrategy
    });

    session.status = "used";

    await auditMintAction({
      ownerTelegramId: session.ownerTelegramId,
      action: "guided_mint_confirmation_created",
      walletLabel: preview.walletLabel,
      walletAddress: preview.walletAddress,
      targetId: target.targetId,
      runId: run.runId,
      chain: preview.chain,
      contractAddress: preview.contractAddress,
      functionSignature: preview.functionSignature,
      quantity: preview.quantity,
      priceEth: preview.priceEth,
      gasStrategyMode: session.gasStrategy.mode,
      status: mintSession.status
    });

    await ctx.reply(
      `${formatMintPreviewMessage(preview, {
        title: `Guided Mint Confirmation: ${target.name}`,
        targetId: target.targetId,
        runId: run.runId
      })}

This confirmation expires in 10 minutes.

No transaction will be sent until you press Confirm Mint.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Confirm Mint", `mint:confirm:${mintSession.sessionId}`)],
        [Markup.button.callback("Cancel", `mint:cancel:${mintSession.sessionId}`)]
      ])
    );
    return;
  }

  const wallets = await getOwnedActiveWalletSummaries(
    session.ownerTelegramId,
    session.walletLabels
  );
  const preflight = await getMultiMintPreflight({
    ownerTelegramId: session.ownerTelegramId,
    target,
    walletLabels: session.walletLabels,
    gasStrategy: session.gasStrategy
  });
  const multiSession = createMultiMintConfirmationSession({
    ownerTelegramId: session.ownerTelegramId,
    targetId: target.targetId,
    targetName: target.name,
    chain: target.chain,
    contractAddress: target.contractAddress,
    functionSignature: target.functionSignature,
    quantity: target.quantity,
    priceEth: target.priceEth,
    walletLabels: wallets.map((wallet) => wallet.label),
    walletAddresses: wallets.map((wallet) => wallet.address),
    gasStrategy: session.gasStrategy
  });

  session.status = "used";

  await auditMintAction({
    ownerTelegramId: session.ownerTelegramId,
    action: "guided_multi_mint_confirmation_created",
    targetId: target.targetId,
    chain: target.chain,
    contractAddress: target.contractAddress,
    functionSignature: target.functionSignature,
    quantity: target.quantity,
    priceEth: target.priceEth,
    gasStrategyMode: session.gasStrategy.mode,
    status: multiSession.status,
    reason: `wallets:${wallets.length}`
  });

  await ctx.reply(
    `Guided Multi-Mint Confirmation

Target: ${target.name}
Target ID: ${target.targetId}
Chain: ${target.chain}
Contract: ${formatShortAddress(target.contractAddress)}
Function: ${target.functionSignature}
Quantity Per Wallet: ${target.quantity}
Price Per Wallet: ${target.priceEth} ETH
Gas Strategy: ${formatGasStrategy(session.gasStrategy)}
Wallets (${wallets.length}): ${wallets.map((wallet) => wallet.label).join(", ")}
Concurrency Cap: ${getMultiMintConcurrency()}
Delay Between Submissions: ${getMultiMintDelayMs()}ms
Minting Lock: ${getMintLockStatusText(target.chain)}

Preflight:
${formatMultiGasPreview(preflight.previews, preflight.failures)}

Recommendation:
${formatMintReadinessRecommendation(preflight.previews, preflight.failures)}

This confirmation expires in 10 minutes.

No transaction will be sent until you press Confirm Multi Mint.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("Confirm Multi Mint", `mm:confirm:${multiSession.sessionId}`)],
      [Markup.button.callback("Cancel", `mm:cancel:${multiSession.sessionId}`)]
    ])
  );
}


type OpenSeaQuickMintStatus = "active" | "used" | "cancelled" | "expired";
type OpenSeaQuickMintStep = "link" | "quantity" | "wallet";

type OpenSeaQuickMintSession = {
  sessionId: string;
  ownerTelegramId: string;
  step: OpenSeaQuickMintStep;
  sourceUrl?: string;
  targetId?: string;
  createdAt: string;
  expiresAt: string;
  status: OpenSeaQuickMintStatus;
};

const OPENSEA_QUICK_MINT_TTL_MS = 15 * 60 * 1000;
const openSeaQuickMintSessions = new Map<string, OpenSeaQuickMintSession>();
const activeOpenSeaQuickMintByOwner = new Map<string, string>();

function createOpenSeaQuickMintSessionId() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const sessionId = randomUUID().replace(/-/g, "").slice(0, 8);

    if (!openSeaQuickMintSessions.has(sessionId)) {
      return sessionId;
    }
  }

  return randomUUID().replace(/-/g, "").slice(0, 12);
}

function isOpenSeaQuickMintExpired(session: OpenSeaQuickMintSession) {
  const expiresAtMs = Date.parse(session.expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now();
}

function cleanupOpenSeaQuickMintSessions() {
  for (const [sessionId, session] of openSeaQuickMintSessions.entries()) {
    if (session.status === "active" && isOpenSeaQuickMintExpired(session)) {
      session.status = "expired";
    }

    const expiresAtMs = Date.parse(session.expiresAt);
    const cleanupAfterMs = Number.isFinite(expiresAtMs)
      ? expiresAtMs + OPENSEA_QUICK_MINT_TTL_MS
      : Date.now();

    if (cleanupAfterMs <= Date.now()) {
      openSeaQuickMintSessions.delete(sessionId);

      if (activeOpenSeaQuickMintByOwner.get(session.ownerTelegramId) === sessionId) {
        activeOpenSeaQuickMintByOwner.delete(session.ownerTelegramId);
      }
    }
  }
}

function createOpenSeaQuickMintSession(ownerTelegramId: string) {
  cleanupOpenSeaQuickMintSessions();

  const existingId = activeOpenSeaQuickMintByOwner.get(ownerTelegramId);
  const existing = existingId ? openSeaQuickMintSessions.get(existingId) : null;

  if (existing && existing.status === "active") {
    existing.status = "cancelled";
  }

  if (existingId) {
    activeOpenSeaQuickMintByOwner.delete(ownerTelegramId);
  }

  const createdAt = new Date();
  const session: OpenSeaQuickMintSession = {
    sessionId: createOpenSeaQuickMintSessionId(),
    ownerTelegramId,
    step: "link",
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + OPENSEA_QUICK_MINT_TTL_MS).toISOString(),
    status: "active"
  };

  openSeaQuickMintSessions.set(session.sessionId, session);
  activeOpenSeaQuickMintByOwner.set(ownerTelegramId, session.sessionId);
  return session;
}

function getActiveOpenSeaQuickMintSession(ownerTelegramId: string) {
  cleanupOpenSeaQuickMintSessions();

  const sessionId = activeOpenSeaQuickMintByOwner.get(ownerTelegramId);

  if (!sessionId) {
    return null;
  }

  const session = openSeaQuickMintSessions.get(sessionId);

  if (!session || session.status !== "active" || isOpenSeaQuickMintExpired(session)) {
    activeOpenSeaQuickMintByOwner.delete(ownerTelegramId);

    if (session) {
      session.status = "expired";
    }

    return null;
  }

  return session;
}

async function getOpenSeaQuickMintSession(ctx: Context, sessionId: string) {
  cleanupOpenSeaQuickMintSessions();

  const actorTelegramId = getTelegramUserId(ctx);

  if (!actorTelegramId) {
    await ctx.reply("❌ Could not verify your Telegram account for this action.");
    return null;
  }

  const session = openSeaQuickMintSessions.get(sessionId);

  if (!session) {
    await ctx.reply("This OpenSea mint flow expired. Paste the OpenSea link again.");
    return null;
  }

  if (session.ownerTelegramId !== actorTelegramId) {
    await ctx.reply("You cannot use this OpenSea mint flow.");
    return null;
  }

  if (session.status !== "active" || isOpenSeaQuickMintExpired(session)) {
    session.status = "expired";
    await ctx.reply("This OpenSea mint flow expired. Paste the OpenSea link again.");
    return null;
  }

  return session;
}

async function sendOpenSeaQuickMintLinkPrompt(ctx: Context, session: OpenSeaQuickMintSession) {
  session.step = "link";

  await ctx.reply(
    `🔗 OpenSea Quick Mint

Paste the OpenSea collection mint link.

Example:
https://opensea.io/collection/project-name

The bot will auto-detect:
- contract
- chain
- price
- SeaDrop route

No transaction will be sent until final confirmation.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("Cancel", `osqm:cancel:${session.sessionId}`)]
    ])
  );
}

async function sendOpenSeaQuickMintQuantitySelection(
  ctx: Context,
  session: OpenSeaQuickMintSession
) {
  if (!session.targetId) {
    await ctx.reply("This OpenSea mint flow is missing a target. Paste the link again.");
    return;
  }

  const target = getMintTargetForOwner(session.targetId, session.ownerTelegramId);
  session.step = "quantity";

  await ctx.reply(
    `✅ OpenSea mint target prepared.

Target: ${target.name}
Target ID: ${target.targetId}
Chain: ${target.chain}
Contract: ${formatShortAddress(target.contractAddress)}
Function: ${target.functionSignature}
Price Each: ${target.priceEth} ETH

Choose quantity:`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback("1", `osqm:q:${session.sessionId}:1`),
        Markup.button.callback("2", `osqm:q:${session.sessionId}:2`),
        Markup.button.callback("3", `osqm:q:${session.sessionId}:3`)
      ],
      [
        Markup.button.callback("5", `osqm:q:${session.sessionId}:5`),
        Markup.button.callback("10", `osqm:q:${session.sessionId}:10`),
        Markup.button.callback("25", `osqm:q:${session.sessionId}:25`)
      ],
      [
        Markup.button.callback("50", `osqm:q:${session.sessionId}:50`),
        Markup.button.callback("100", `osqm:q:${session.sessionId}:100`)
      ],
      [Markup.button.callback("Cancel", `osqm:cancel:${session.sessionId}`)]
    ])
  );
}

async function sendOpenSeaQuickMintWalletSelection(
  ctx: Context,
  session: OpenSeaQuickMintSession
) {
  if (!session.targetId) {
    await ctx.reply("This OpenSea mint flow is missing a target. Paste the link again.");
    return;
  }

  const target = getMintTargetForOwner(session.targetId, session.ownerTelegramId);
  const wallets = (await listWalletsForOwner(session.ownerTelegramId)).filter(
    (wallet) => wallet.status !== "archived"
  );

  if (wallets.length === 0) {
    await ctx.reply("No active wallets found. Add one with /addwallet.");
    return;
  }

  session.step = "wallet";

  await ctx.reply(
    `👛 Choose wallet

Target: ${target.name}
Quantity: ${target.quantity}
Price Each: ${target.priceEth} ETH
Total Mint Cost: ${ethers.formatEther(
      ethers.parseEther(target.priceEth || "0") * BigInt(target.quantity)
    )} ETH

Choose one wallet below for fastest flow.\n\nFor multiple wallets, use the multi-wallet selector.`,
    Markup.inlineKeyboard([
      ...wallets.map((wallet) => [
        Markup.button.callback(
          `${wallet.label} (${formatShortAddress(wallet.address)})`,
          `osqm:w:${session.sessionId}:${wallet.label}`
        )
      ]),
      [Markup.button.callback("👛 Select Multiple Wallets", `osqm:multi:${session.sessionId}`)],
      [Markup.button.callback("Cancel", `osqm:cancel:${session.sessionId}`)]
    ])
  );
}

async function prepareOpenSeaQuickMintTargetFromLink(
  ctx: Context,
  session: OpenSeaQuickMintSession,
  input: string
) {
  const linkInput = getDirectMintLinkInput(input);

  if (!linkInput || !linkInput.includes("opensea.io")) {
    await ctx.reply("Please paste a supported OpenSea collection link.");
    return;
  }

  await ctx.reply("🔎 Detecting OpenSea mint...");

  const resolverResult = await resolveOpenSeaContractForMintFlow(linkInput);

  if (resolverResult.status !== "resolved") {
    await ctx.reply(formatOpenSeaResolverUserMessage(resolverResult));
    return;
  }

  const candidate = resolverResult.candidate;

  if (!candidate.supportedMintChain) {
    await ctx.reply(
      `OpenSea resolved a contract, but this chain is not supported yet.

Resolved:
${candidate.chainName}: ${formatShortAddress(candidate.address)}`
    );
    return;
  }

  const detection = await detectMint(linkInput);
  const priceEth = detection.mint.priceEth;

  if (priceEth === undefined) {
    await ctx.reply(
      `❌ I detected the OpenSea contract, but could not safely detect the mint price.

Try /mintflow → Create New Target manually, or paste a mint link where OpenSea shows the current price.`
    );
    return;
  }

  const target = createMintTarget({
    ownerTelegramId: session.ownerTelegramId,
    name: generateMintTargetName(session.ownerTelegramId, detection, ""),
    contractAddress: ethers.getAddress(candidate.address),
    functionSignature: normalizeMintFunctionSignature(
      "mintPublic(address,address,address,uint256)"
    ),
    quantity: 1,
    priceEth: validateMintPriceEth(priceEth),
    chain: candidate.supportedMintChain,
    sourceUrl: linkInput,
    collectionSlug: resolverResult.slug,
    detectedMetadata: getDetectionMetadata(detection)
  });

  session.sourceUrl = linkInput;
  session.targetId = target.targetId;

  await auditMintAction({
    ownerTelegramId: session.ownerTelegramId,
    action: "opensea_quick_mint_target_created",
    targetId: target.targetId,
    chain: target.chain,
    contractAddress: target.contractAddress,
    functionSignature: target.functionSignature,
    quantity: target.quantity,
    priceEth: target.priceEth,
    collectionSlug: target.collectionSlug,
    status: target.status,
    reason: "direct_opensea_quick_mint"
  });

  await ctx.reply(
    `✅ OpenSea mint detected.

Collection: ${detection.contract.collectionName || resolverResult.slug}
Slug: ${resolverResult.slug}
Chain: ${target.chain}
Contract: ${formatShortAddress(target.contractAddress)}
Price Each: ${target.priceEth} ETH
Route: OpenSea SeaDrop

Target ID: ${target.targetId}`
  );

  await sendOpenSeaQuickMintQuantitySelection(ctx, session);
}

async function createOpenSeaQuickMintFinalConfirmation(
  ctx: Context,
  session: OpenSeaQuickMintSession,
  walletLabel: string
) {
  if (!session.targetId) {
    await ctx.reply("This OpenSea mint flow is missing a target. Paste the link again.");
    return;
  }

  let target = requireCompleteMintTarget(
    getMintTargetForOwner(session.targetId, session.ownerTelegramId)
  );

  await ctx.reply("⛽ Auto-resolving mint route and previewing gas...");

  let routeNote = "Route: using saved OpenSea SeaDrop route.";

  try {
    const routeResult = await resolveMintRoutesForTarget({
      ownerTelegramId: session.ownerTelegramId,
      target,
      walletLabel
    });
    const best = pickBestSupportedRoute(routeResult.candidates);

    if (best) {
      target = requireCompleteMintTarget(
        updateMintTargetForOwner(target.targetId, session.ownerTelegramId, {
          contractAddress: best.mintContractAddress,
          chain: target.chain,
          functionSignature: normalizeMintFunctionSignature(best.functionSignature),
          quantity: target.quantity,
          priceEth: best.pricePerTokenEth || target.priceEth
        })
      );
      routeNote = `Route: verified ${best.functionSignature}.`;
    } else {
      routeNote =
        "Route: SeaDrop selected, but resolver could not verify a best route. Gas preview below is the source of truth.";
    }
  } catch (error) {
    routeNote = `Route: SeaDrop selected. Resolver note: ${getSafeErrorMessage(error)}`;
  }

  const gasStrategy = getTargetGasStrategy(target);
  const preview = await previewGasForTargetWallet({
    ownerTelegramId: session.ownerTelegramId,
    target,
    walletLabel,
    gasStrategy
  });
  const run = createRunFromPreview(
    session.ownerTelegramId,
    preview,
    "pending",
    target.targetId
  );
  const mintSession = createMintConfirmationSession({
    ownerTelegramId: session.ownerTelegramId,
    walletLabel: preview.walletLabel,
    walletAddress: preview.walletAddress,
    chain: preview.chain,
    contractAddress: preview.contractAddress,
    functionSignature: preview.functionSignature,
    quantity: preview.quantity,
    priceEth: preview.priceEth,
    runId: run.runId,
    targetId: target.targetId,
    gasStrategy
  });

  session.status = "used";
  activeOpenSeaQuickMintByOwner.delete(session.ownerTelegramId);

  await auditMintAction({
    ownerTelegramId: session.ownerTelegramId,
    action: "opensea_quick_mint_confirmation_created",
    walletLabel: preview.walletLabel,
    walletAddress: preview.walletAddress,
    targetId: target.targetId,
    runId: run.runId,
    chain: preview.chain,
    contractAddress: preview.contractAddress,
    functionSignature: preview.functionSignature,
    quantity: preview.quantity,
    priceEth: preview.priceEth,
    gasStrategyMode: gasStrategy.mode,
    status: mintSession.status
  });

  await ctx.reply(
    `${formatMintPreviewMessage(preview, {
      title: `OpenSea Quick Mint Confirmation: ${target.name}`,
      targetId: target.targetId,
      runId: run.runId
    })}

${routeNote}

This confirmation expires in 10 minutes.

No transaction will be sent until you press Confirm Mint.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("Confirm Mint", `mint:confirm:${mintSession.sessionId}`)],
      [Markup.button.callback("Cancel", `mint:cancel:${mintSession.sessionId}`)]
    ])
  );
}

async function startOpenSeaQuickMintFlow(ctx: Context) {
  const ownerTelegramId = getRequiredTelegramUserId(ctx);
  const session = createOpenSeaQuickMintSession(ownerTelegramId);
  await sendOpenSeaQuickMintLinkPrompt(ctx, session);
}

async function startOpenSeaQuickMintFromLink(ctx: Context, input: string) {
  const ownerTelegramId = getRequiredTelegramUserId(ctx);
  const session = createOpenSeaQuickMintSession(ownerTelegramId);
  await prepareOpenSeaQuickMintTargetFromLink(ctx, session, input);
}

async function handleOpenSeaQuickMintText(ctx: Context) {
  const ownerTelegramId = getTelegramUserId(ctx);

  if (!ownerTelegramId) {
    return false;
  }

  const session = getActiveOpenSeaQuickMintSession(ownerTelegramId);

  if (!session || session.step !== "link") {
    return false;
  }

  if (!(await requireAdmin(ctx))) {
    return true;
  }

  const rawText = (ctx as any).message?.text;

  if (typeof rawText !== "string" || rawText.trim().startsWith("/")) {
    return false;
  }

  try {
    await prepareOpenSeaQuickMintTargetFromLink(ctx, session, rawText.trim());
  } catch (error) {
    logSafeError("OpenSea quick mint link handling failed", error);
    await ctx.reply(`❌ Could not prepare OpenSea quick mint.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }

  return true;
}


function getMintFlowMenuText() {
  return `🚀 Guided Mint Flow

Choose what you want to do next.

Recommended flow:
1. Create Target or Show Targets
2. Show Wallets
3. Check Readiness
4. Quick Mint
5. Press Confirm only after checking gas + USD budget

Safety:
- No transaction is sent from this menu.
- /mintready never sends a transaction.
- /quickmint only sends after you press Confirm.`;
}

function getMintFlowKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➕ Create New Target", "mf:create_target")],
    [
      Markup.button.callback("✅ Check Readiness", "mf:ready"),
      Markup.button.callback("🚀 Quick Mint", "mf:quick")
    ],
    [
      Markup.button.callback("🎯 Show Targets", "mf:targets"),
      Markup.button.callback("👛 Show Wallets", "mf:wallets")
    ],
    [
      Markup.button.callback("⛽ Gas Preview", "mf:gas"),
      Markup.button.callback("📅 Schedule Multi-Mint", "mf:schedule")
    ],
    [Markup.button.callback("🔄 Refresh Menu", "mf:menu")]
  ]);
}

async function sendMintFlowMenu(ctx: Context) {
  await ctx.reply(getMintFlowMenuText(), getMintFlowKeyboard());
}

bot.command("mintflow", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await sendMintFlowMenu(ctx);
});

bot.action("mf:menu", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();
  await sendMintFlowMenu(ctx);
});

bot.action("mf:ready", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();
  await sendMintFlowTargetSelection(ctx, "ready");
});

bot.action("mf:quick", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();
  await sendMintFlowTargetSelection(ctx, "quick");
});

bot.action("mf:gas", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();
  await ctx.reply(
    `⛽ Gas Preview

Single wallet:
/gaspreview targetId wallet1

Multiple wallets:
/multigaspreview targetId wallet1,wallet2

Gas preview checks estimated gas, estimated total cost, USD budget, and wallet funding.
No transaction is sent.`
  );
});

bot.action("mf:schedule", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();
  await ctx.reply(
    `📅 Schedule Multi-Mint

Use:
/schedulemintmulti targetId wallet1,wallet2 2026-07-04T18:00:00Z watch

Then check jobs:
/mintwatchstatus

When ready, manually run confirmation:
/runmultimintjob jobId

Scheduled multi-mint still requires final confirmation unless you explicitly use auto mode and mainnet locks are enabled.`
  );
});

bot.action("mf:wallets", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  try {
    await sendWalletsList(ctx);
  } catch (error) {
    logSafeError("Could not show wallets from mint flow", error);
    await ctx.reply(`❌ Could not show wallets.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.action("mf:targets", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const targets = listMintTargetsForOwner(ownerTelegramId);

    if (targets.length === 0) {
      await ctx.reply("No active mint targets found. Add one with /addminttarget.");
      return;
    }

    const message = targets
      .map((target, index) =>
        [
          `${index + 1}. ${target.name}`,
          `Target ID: ${target.targetId}`,
          `Chain: ${target.chain}`,
          `Contract: ${target.contractAddress ? formatShortAddress(target.contractAddress) : "Unknown"}`,
          `Completeness: ${target.targetCompleteness}`,
          `Function: ${target.functionSignature || "Unknown"}`,
          `Qty: ${target.quantity}`,
          `Price: ${target.priceEth === undefined ? "Unknown" : `${target.priceEth} ETH`}`
        ].join("\n")
      )
      .join("\n\n");

    await ctx.reply(`Your mint targets:\n\n${message}`);
  } catch (error) {
    logSafeError("Could not show mint targets from mint flow", error);
    await ctx.reply(`❌ Could not show mint targets.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.action("mf:create_target", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  try {
    await startOpenSeaQuickMintFlow(ctx);
  } catch (error) {
    logSafeError("Could not start OpenSea quick mint flow", error);
    await ctx.reply(`❌ Could not start OpenSea quick mint flow.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});


bot.action(/^osqm:q:([0-9a-f]{8,12}):(\d+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const session = await getOpenSeaQuickMintSession(ctx, ctx.match[1] || "");

  if (!session || !session.targetId) {
    return;
  }

  try {
    const quantity = validateMintQuantity(ctx.match[2] || "1");
    const currentTarget = requireCompleteMintTarget(
      getMintTargetForOwner(session.targetId, session.ownerTelegramId)
    );
    const target = updateMintTargetForOwner(session.targetId, session.ownerTelegramId, {
      contractAddress: currentTarget.contractAddress,
      chain: currentTarget.chain,
      functionSignature: currentTarget.functionSignature,
      quantity,
      priceEth: currentTarget.priceEth
    });

    await auditMintAction({
      ownerTelegramId: session.ownerTelegramId,
      action: "opensea_quick_mint_quantity_selected",
      targetId: target.targetId,
      chain: target.chain,
      contractAddress: target.contractAddress,
      functionSignature: target.functionSignature,
      quantity: target.quantity,
      priceEth: target.priceEth,
      status: target.status
    });

    await sendOpenSeaQuickMintWalletSelection(ctx, session);
  } catch (error) {
    logSafeError("Could not select OpenSea quick mint quantity", error);
    await ctx.reply(`❌ Could not select quantity.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.action(/^osqm:w:([0-9a-f]{8,12}):([^:]{1,32})$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const session = await getOpenSeaQuickMintSession(ctx, ctx.match[1] || "");

  if (!session) {
    return;
  }

  try {
    const walletLabel = normalizeWalletLabel(ctx.match[2] || "");
    await createOpenSeaQuickMintFinalConfirmation(ctx, session, walletLabel);
  } catch (error) {
    logSafeError("Could not create OpenSea quick mint confirmation", error);
    await ctx.reply(`❌ Could not create OpenSea quick mint confirmation.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});


bot.action(/^osqm:multi:([0-9a-f]{8,12})$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const session = await getOpenSeaQuickMintSession(ctx, ctx.match[1] || "");

  if (!session || !session.targetId) {
    await ctx.reply("This OpenSea mint flow expired. Paste the OpenSea link again.");
    return;
  }

  try {
    const target = getMintTargetForOwner(session.targetId, session.ownerTelegramId);
    const wizard = createMintFlowWizardSession({
      ownerTelegramId: session.ownerTelegramId,
      action: "quick",
      targetId: target.targetId
    });

    session.status = "used";
    activeOpenSeaQuickMintByOwner.delete(session.ownerTelegramId);

    await ctx.reply(
      `✅ Multi-wallet mode enabled.

Target: ${target.name}
Target ID: ${target.targetId}

Tap multiple wallets, then press Continue → Gas.`
    );

    await sendMintFlowWalletSelection(ctx, wizard);
  } catch (error) {
    logSafeError("Could not start OpenSea multi-wallet mint flow", error);
    await ctx.reply(`❌ Could not start multi-wallet flow.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.action(/^osqm:cancel:([0-9a-f]{8,12})$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const session = await getOpenSeaQuickMintSession(ctx, ctx.match[1] || "");

  if (!session) {
    return;
  }

  session.status = "cancelled";
  activeOpenSeaQuickMintByOwner.delete(session.ownerTelegramId);

  await ctx.reply("OpenSea quick mint flow cancelled.");
});


bot.action(/^mft:scan:([0-9a-f]{8,12})$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const session = await getMintFlowTargetDraftSession(ctx, ctx.match[1] || "");

  if (!session) {
    return;
  }

  await sendMintFlowFunctionScanWalletSelection(ctx, session);
});

bot.action(/^mft:scanw:([0-9a-f]{8,12}):([^:]{1,32})$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const session = await getMintFlowTargetDraftSession(ctx, ctx.match[1] || "");

  if (!session) {
    return;
  }

  const walletLabel = ctx.match[2] || "";

  await scanMintFlowTargetDraftFunctions(ctx, session, walletLabel);
});

bot.action(/^mft:f:([0-9a-f]{8,12}):([A-Za-z0-9_]+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const session = await getMintFlowTargetDraftSession(ctx, ctx.match[1] || "");

  if (!session) {
    return;
  }

  const code = ctx.match[2] as keyof typeof MINT_FLOW_FUNCTION_PRESETS;
  const signature = MINT_FLOW_FUNCTION_PRESETS[code];

  if (!signature) {
    await ctx.reply("Unsupported function preset. Please type the function manually.");
    return;
  }

  session.data.functionSignature = normalizeMintFunctionSignature(signature);
  await sendMintFlowTargetDraftPrompt(ctx, session);
});

bot.action(/^mft:q:([0-9a-f]{8,12}):(\d+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const session = await getMintFlowTargetDraftSession(ctx, ctx.match[1] || "");

  if (!session) {
    return;
  }

  session.data.quantity = validateMintQuantity(ctx.match[2] || "1");
  await sendMintFlowTargetDraftPrompt(ctx, session);
});

bot.action(/^mft:p:([0-9a-f]{8,12}):(free|p001|p003|p005)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const session = await getMintFlowTargetDraftSession(ctx, ctx.match[1] || "");

  if (!session) {
    return;
  }

  const code = ctx.match[2] as keyof typeof MINT_FLOW_PRICE_PRESETS;
  session.data.priceEth = validateMintPriceEth(MINT_FLOW_PRICE_PRESETS[code]);
  await sendMintFlowTargetDraftPrompt(ctx, session);
});

bot.action(/^mft:c:([0-9a-f]{8,12}):(sepolia|mainnet)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const session = await getMintFlowTargetDraftSession(ctx, ctx.match[1] || "");

  if (!session) {
    return;
  }

  session.data.chain = normalizeMintChain(ctx.match[2]);
  await sendMintFlowTargetDraftPrompt(ctx, session);
});

bot.action(/^mft:cancel:([0-9a-f]{8,12})$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const session = await getMintFlowTargetDraftSession(ctx, ctx.match[1] || "");

  if (!session) {
    return;
  }

  session.status = "cancelled";
  activeMintFlowTargetDraftByOwner.delete(session.ownerTelegramId);
  await ctx.reply("Cancelled target creation. Run /mintflow to start again.");
});


bot.action(/^mfw:t:([qr]):([0-9a-f-]+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const action = getMintFlowActionFromCode(ctx.match[1] || "r");
    const targetId = ctx.match[2];

    if (!targetId) {
      await ctx.reply("Mint target not found. Run /minttargets and choose a Target ID.");
      return;
    }

    const target = getMintTargetForOwner(targetId, ownerTelegramId);
    const session = createMintFlowWizardSession({
      ownerTelegramId,
      action,
      targetId: target.targetId
    });

    await sendMintFlowWalletSelection(ctx, session);
  } catch (error) {
    logSafeError("Mint flow target selection failed", error);
    await ctx.reply(`❌ Could not select mint target.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.action(/^mfw:w:([0-9a-f]{8,12}):([A-Za-z0-9_-]{2,32})$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const session = await getMintFlowWizardSession(ctx, ctx.match[1] || "");

  if (!session) {
    return;
  }

  const walletLabel = ctx.match[2];

  if (!walletLabel) {
    await ctx.reply("Wallet label missing. Run /mintflow again.");
    return;
  }

  if (session.walletLabels.includes(walletLabel)) {
    session.walletLabels = session.walletLabels.filter((label) => label !== walletLabel);
  } else {
    session.walletLabels.push(walletLabel);
  }

  await sendMintFlowWalletSelection(ctx, session);
});

bot.action(/^mfw:wg:([0-9a-f]{8,12})$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const session = await getMintFlowWizardSession(ctx, ctx.match[1] || "");

  if (!session) {
    return;
  }

  if (session.walletLabels.length === 0) {
    await ctx.reply("Choose at least one wallet first.");
    return;
  }

  await sendMintFlowGasSelection(ctx, session);
});

bot.action(/^mfw:backw:([0-9a-f]{8,12})$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const session = await getMintFlowWizardSession(ctx, ctx.match[1] || "");

  if (!session) {
    return;
  }

  await sendMintFlowWalletSelection(ctx, session);
});

bot.action(/^mfw:g:([0-9a-f]{8,12}):(target|auto|standard|fast)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  try {
    const session = await getMintFlowWizardSession(ctx, ctx.match[1] || "");

    if (!session) {
      return;
    }

    const mode = (ctx.match[2] || "target") as "target" | "auto" | "standard" | "fast";
    const target = getMintTargetForOwner(session.targetId, session.ownerTelegramId);
    session.gasStrategy = getMintFlowPresetGasStrategy(mode, target);

    await sendMintFlowReview(ctx, session);
  } catch (error) {
    logSafeError("Mint flow gas selection failed", error);
    await ctx.reply(`❌ Could not select gas strategy.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.action(/^mfw:gasback:([0-9a-f]{8,12})$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const session = await getMintFlowWizardSession(ctx, ctx.match[1] || "");

  if (!session) {
    return;
  }

  await sendMintFlowGasSelection(ctx, session);
});

bot.action(/^mfw:create:([0-9a-f]{8,12})$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  try {
    const session = await getMintFlowWizardSession(ctx, ctx.match[1] || "");

    if (!session) {
      return;
    }

    await createMintFlowFinalConfirmation(ctx, session);
  } catch (error) {
    logSafeError("Mint flow final confirmation failed", error);
    await ctx.reply(`❌ Could not create final confirmation.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.action(/^mfw:cancel:([0-9a-f]{8,12})$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const session = await getMintFlowWizardSession(ctx, ctx.match[1] || "");

  if (!session) {
    return;
  }

  session.status = "cancelled";
  await ctx.reply("Cancelled guided mint flow. Run /mintflow to start again.");
});


bot.command("mintready", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = parseCommandParts(ctx.message.text);
  const targetId = parts[1]?.trim();
  const rawWallets = parts[2]?.trim();

  if (!targetId || !rawWallets) {
    await ctx.reply(formatMintReadyUsage());
    return;
  }

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const target = requireCompleteMintTarget(
      getMintTargetForOwner(targetId, ownerTelegramId)
    );
    const walletLabels = parseWalletLabelList(rawWallets);
    const gasStrategy = parseOptionalCommandGasStrategy(
      parts,
      3,
      getTargetGasStrategy(target)
    );

    if (walletLabels.length === 1) {
      const walletLabel = walletLabels[0]!;
      const preview = await previewGasForTargetWallet({
        ownerTelegramId,
        target,
        walletLabel,
        gasStrategy
      });
      const failures = getPreviewReadinessFailures(preview);

      await auditMintAction({
        ownerTelegramId,
        action: "mint_ready_checked",
        walletLabel: preview.walletLabel,
        walletAddress: preview.walletAddress,
        targetId: target.targetId,
        chain: preview.chain,
        contractAddress: preview.contractAddress,
        functionSignature: preview.functionSignature,
        quantity: preview.quantity,
        priceEth: preview.priceEth,
        gasStrategyMode: gasStrategy.mode,
        status: failures.length > 0 ? "blocked" : "ready",
        ...(failures[0]?.reason ? { reason: failures[0].reason } : {})
      });

      await ctx.reply(
        `Mint Readiness

Target: ${target.name}
Target ID: ${target.targetId}
Wallet Count: 1
Gas Strategy: ${formatGasStrategy(gasStrategy)}

Wallet: ${preview.walletLabel}
Address: ${formatShortAddress(preview.walletAddress)}

${formatGasFields(preview)}

Recommendation:
${formatMintReadinessRecommendation([preview], failures)}

No transaction was sent.`
      );
      return;
    }

    const wallets = await getOwnedActiveWalletSummaries(ownerTelegramId, walletLabels);
    const preflight = await getMultiMintPreflight({
      ownerTelegramId,
      target,
      walletLabels,
      gasStrategy
    });

    await auditMintAction({
      ownerTelegramId,
      action: "multi_mint_ready_checked",
      targetId: target.targetId,
      chain: target.chain,
      contractAddress: target.contractAddress,
      functionSignature: target.functionSignature,
      quantity: target.quantity,
      priceEth: target.priceEth,
      gasStrategyMode: gasStrategy.mode,
      status: preflight.failures.length > 0 ? "partial" : "ready",
      reason: `wallets:${wallets.length}`
    });

    await ctx.reply(
      `Mint Readiness

Target: ${target.name}
Target ID: ${target.targetId}
Wallet Count: ${wallets.length}
Wallets: ${wallets.map((wallet) => wallet.label).join(", ")}
Gas Strategy: ${formatGasStrategy(gasStrategy)}

${formatMultiGasPreview(preflight.previews, preflight.failures)}

Recommendation:
${formatMintReadinessRecommendation(preflight.previews, preflight.failures)}`
    );
  } catch (error) {
    logSafeError("Could not check mint readiness", error);
    const reason = getSafeErrorMessage(error);
    await ctx.reply(
      `❌ Could not check mint readiness.

Reason:
${reason}

Next:
- Run /minttargets and copy the real Target ID.
- Run /wallets and confirm the wallet label.
- Then run /mintready again.`
    );
  }
});

bot.command("quickmint", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = parseCommandParts(ctx.message.text);
  const targetId = parts[1]?.trim();
  const rawWallets = parts[2]?.trim();

  if (!targetId || !rawWallets) {
    await ctx.reply(formatQuickMintUsage());
    return;
  }

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const target = requireCompleteMintTarget(
      getMintTargetForOwner(targetId, ownerTelegramId)
    );
    const walletLabels = parseWalletLabelList(rawWallets);
    const gasStrategy = parseOptionalCommandGasStrategy(
      parts,
      3,
      getTargetGasStrategy(target)
    );

    if (walletLabels.length === 1) {
      const walletLabel = walletLabels[0]!;
      const preview = await previewGasForTargetWallet({
        ownerTelegramId,
        target,
        walletLabel,
        gasStrategy
      });
      const run = createRunFromPreview(ownerTelegramId, preview, "pending", target.targetId);
      const session = createMintConfirmationSession({
        ownerTelegramId,
        walletLabel: preview.walletLabel,
        walletAddress: preview.walletAddress,
        chain: preview.chain,
        contractAddress: preview.contractAddress,
        functionSignature: preview.functionSignature,
        quantity: preview.quantity,
        priceEth: preview.priceEth,
        runId: run.runId,
        targetId: target.targetId,
        gasStrategy
      });

      await auditMintAction({
        ownerTelegramId,
        action: "quick_mint_confirmation_created",
        walletLabel: preview.walletLabel,
        walletAddress: preview.walletAddress,
        targetId: target.targetId,
        runId: run.runId,
        chain: preview.chain,
        contractAddress: preview.contractAddress,
        functionSignature: preview.functionSignature,
        quantity: preview.quantity,
        priceEth: preview.priceEth,
        gasStrategyMode: gasStrategy.mode,
        status: session.status
      });

      await ctx.reply(
        `${formatMintPreviewMessage(preview, {
          title: `Quick Mint Confirmation: ${target.name}`,
          targetId: target.targetId,
          runId: run.runId
        })}

This confirmation expires in 10 minutes.

No transaction will be sent until you press Confirm Mint.`,
        Markup.inlineKeyboard([
          [Markup.button.callback("Confirm Mint", `mint:confirm:${session.sessionId}`)],
          [Markup.button.callback("Cancel", `mint:cancel:${session.sessionId}`)]
        ])
      );
      return;
    }

    const wallets = await getOwnedActiveWalletSummaries(ownerTelegramId, walletLabels);
    const preflight = await getMultiMintPreflight({
      ownerTelegramId,
      target,
      walletLabels,
      gasStrategy
    });
    const session = createMultiMintConfirmationSession({
      ownerTelegramId,
      targetId: target.targetId,
      targetName: target.name,
      chain: target.chain,
      contractAddress: target.contractAddress,
      functionSignature: target.functionSignature,
      quantity: target.quantity,
      priceEth: target.priceEth,
      walletLabels: wallets.map((wallet) => wallet.label),
      walletAddresses: wallets.map((wallet) => wallet.address),
      gasStrategy
    });

    await auditMintAction({
      ownerTelegramId,
      action: "quick_multi_mint_confirmation_created",
      targetId: target.targetId,
      chain: target.chain,
      contractAddress: target.contractAddress,
      functionSignature: target.functionSignature,
      quantity: target.quantity,
      priceEth: target.priceEth,
      gasStrategyMode: gasStrategy.mode,
      status: session.status,
      reason: `wallets:${wallets.length}`
    });

    await ctx.reply(
      `Quick Multi-Mint Confirmation

Target: ${target.name}
Target ID: ${target.targetId}
Chain: ${target.chain}
Contract: ${formatShortAddress(target.contractAddress)}
Function: ${target.functionSignature}
Quantity Per Wallet: ${target.quantity}
Price Per Wallet: ${target.priceEth} ETH
Gas Strategy: ${formatGasStrategy(gasStrategy)}
Wallets (${wallets.length}): ${wallets.map((wallet) => wallet.label).join(", ")}
Concurrency Cap: ${getMultiMintConcurrency()}
Delay Between Submissions: ${getMultiMintDelayMs()}ms
Minting Lock: ${getMintLockStatusText(target.chain)}

Preflight:
${formatMultiGasPreview(preflight.previews, preflight.failures)}

Recommendation:
${formatMintReadinessRecommendation(preflight.previews, preflight.failures)}

This confirmation expires in 10 minutes.

No transaction will be sent until you press Confirm Multi Mint.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Confirm Multi Mint", `mm:confirm:${session.sessionId}`)],
        [Markup.button.callback("Cancel", `mm:cancel:${session.sessionId}`)]
      ])
    );
  } catch (error) {
    logSafeError("Could not create quick mint confirmation", error);
    const reason = getSafeErrorMessage(error);
    await ctx.reply(
      `❌ Could not create quick mint confirmation.

Reason:
${reason}

Next:
- Run /minttargets and copy the real Target ID.
- Run /wallets and confirm the wallet label.
- Run /mintready first if you want to check gas/funding before confirmation.`
    );
  }
});

bot.command("mintmulti", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = parseCommandParts(ctx.message.text);
  const targetId = parts[1]?.trim();
  const rawWallets = parts[2]?.trim();

  if (!targetId || !rawWallets) {
    await ctx.reply("Use:\n/mintmulti targetId wallet1,wallet2,wallet3");
    return;
  }

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const target = requireCompleteMintTarget(
      getMintTargetForOwner(targetId, ownerTelegramId)
    );
    const walletLabels = parseWalletLabelList(rawWallets);
    const wallets = await getOwnedActiveWalletSummaries(ownerTelegramId, walletLabels);
    const preflight = await getMultiMintPreflight({
      ownerTelegramId,
      target,
      walletLabels
    });
    const gasStrategy = getTargetGasStrategy(target);
    const session = createMultiMintConfirmationSession({
      ownerTelegramId,
      targetId: target.targetId,
      targetName: target.name,
      chain: target.chain,
      contractAddress: target.contractAddress,
      functionSignature: target.functionSignature,
      quantity: target.quantity,
      priceEth: target.priceEth,
      walletLabels: wallets.map((wallet) => wallet.label),
      walletAddresses: wallets.map((wallet) => wallet.address),
      gasStrategy
    });

    await auditMintAction({
      ownerTelegramId,
      action: "multi_mint_confirm_requested",
      targetId: target.targetId,
      chain: target.chain,
      contractAddress: target.contractAddress,
      functionSignature: target.functionSignature,
      quantity: target.quantity,
      priceEth: target.priceEth,
      gasStrategyMode: gasStrategy.mode,
      status: session.status,
      reason: `wallets:${wallets.length}`
    });

    await ctx.reply(
      `Multi-Mint Confirmation

Target: ${target.name}
Target ID: ${target.targetId}
Chain: ${target.chain}
Contract: ${formatShortAddress(target.contractAddress)}
Function: ${target.functionSignature}
Quantity Per Wallet: ${target.quantity}
Price Per Wallet: ${target.priceEth} ETH
Gas Strategy: ${formatGasStrategy(gasStrategy)}
Wallets (${wallets.length}): ${wallets.map((wallet) => wallet.label).join(", ")}
Concurrency Cap: ${getMultiMintConcurrency()}
Delay Between Submissions: ${getMultiMintDelayMs()}ms
Minting Lock: ${getMintLockStatusText(target.chain)}

Preflight:
${formatMultiGasPreview(preflight.previews, preflight.failures)}

This confirmation expires in 10 minutes.

No transaction will be sent until you press Confirm Multi Mint.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Confirm Multi Mint", `mm:confirm:${session.sessionId}`)],
        [Markup.button.callback("Cancel", `mm:cancel:${session.sessionId}`)]
      ])
    );
  } catch (error) {
    logSafeError("Could not create multi-mint confirmation", error);
    await ctx.reply(`❌ Could not create multi-mint confirmation.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.action(/^mm:confirm:([0-9a-f-]+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const sessionId = ctx.match[1];

  if (!sessionId) {
    await ctx.reply("This multi-mint confirmation has expired. Please create it again.");
    return;
  }

  const validated = await validateMultiMintConfirmationSession(ctx, sessionId);

  if (!validated) {
    return;
  }

  const { session } = validated;
  session.status = "used";

  try {
    await ctx.reply(
      `Starting multi-mint.

Target: ${session.targetName}
Wallets: ${session.walletLabels.join(", ")}
Concurrency: ${getMultiMintConcurrency()}
Delay: ${getMultiMintDelayMs()}ms`
    );
    const result = await executeMultiMint({
      ownerTelegramId: session.ownerTelegramId,
      targetId: session.targetId,
      targetName: session.targetName,
      chain: session.chain,
      contractAddress: session.contractAddress,
      functionSignature: session.functionSignature,
      quantity: session.quantity,
      priceEth: session.priceEth,
      walletLabels: session.walletLabels,
      walletAddresses: session.walletAddresses,
      gasStrategy: session.gasStrategy,
      ...(session.multiMintJobId ? { multiMintJobId: session.multiMintJobId } : {}),
      requireScheduledMainnetLock: false,
      notify: async (message) => {
        await ctx.reply(message);
      }
    });

    await ctx.reply(
      `Multi-mint finished.

Status: ${result.status}

${formatMultiMintExecutionSummary(result.results)}`
    );
  } catch (error) {
    logSafeError("Multi-mint confirmation failed", error);
    if (session.multiMintJobId) {
      updateMultiMintJobForOwner(session.multiMintJobId, session.ownerTelegramId, {
        status: "blocked",
        safeErrorReason: getSafeErrorMessage(error)
      });
    }
    await auditMintAction({
      ownerTelegramId: session.ownerTelegramId,
      action: "multi_mint_wallet_blocked",
      targetId: session.targetId,
      multiMintJobId: session.multiMintJobId,
      chain: session.chain,
      contractAddress: session.contractAddress,
      functionSignature: session.functionSignature,
      quantity: session.quantity,
      priceEth: session.priceEth,
      gasStrategyMode: session.gasStrategy.mode,
      status: "blocked",
      reason: getSafeErrorMessage(error)
    });
    await ctx.reply(`❌ Multi-mint blocked.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.action(/^mm:cancel:([0-9a-f-]+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const sessionId = ctx.match[1];

  if (!sessionId) {
    await ctx.reply("This multi-mint confirmation has expired. Please create it again.");
    return;
  }

  const validated = await validateMultiMintConfirmationSession(ctx, sessionId);

  if (!validated) {
    return;
  }

  validated.session.status = "cancelled";
  await ctx.reply(`Cancelled multi-mint confirmation for ${validated.session.targetName}.`);
});

bot.command("setminttype", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = parseCommandParts(ctx.message.text);
  const targetId = parts[1]?.trim();
  const rawMintType = parts[2]?.trim();

  if (!targetId || !rawMintType) {
    await ctx.reply("Use:\n/setminttype targetId manual|team|holder|gtd|fcfs|public");
    return;
  }

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const mintType = normalizeMintJobMintType(rawMintType);
    const defaults = getMintTypeDefaults(mintType);
    const target = updateMintTargetMintSettingsForOwner(
      targetId,
      ownerTelegramId,
      {
        mintType,
        maxRetries: defaults.maxRetries,
        retryDelayMs: defaults.retryDelayMs
      }
    );

    await auditMintAction({
      ownerTelegramId,
      action: "mint_target_updated",
      targetId: target.targetId,
      chain: target.chain,
      contractAddress: target.contractAddress,
      functionSignature: target.functionSignature,
      quantity: target.quantity,
      priceEth: target.priceEth,
      mintType,
      status: target.status,
      reason: "mint_type_updated"
    });

    await ctx.reply(
      `✅ Mint type updated.

Target: ${target.name}
Target ID: ${target.targetId}
Mint Type: ${mintType}
Max Retries: ${defaults.maxRetries}
Retry Delay: ${defaults.retryDelayMs}ms${
        formatMintTypeWarning(mintType) ? `\n\n${formatMintTypeWarning(mintType)}` : ""
      }`
    );
  } catch (error) {
    logSafeError("Could not set mint type", error);
    await ctx.reply(`❌ Could not set mint type.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.command("schedulemint", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = parseCommandParts(ctx.message.text);
  const targetId = parts[1]?.trim();
  const walletLabel = parts[2]?.trim();
  const rawStartTime = parts[3]?.trim();
  const rawMode = parts[4]?.trim();

  if (!targetId || !walletLabel || !rawStartTime) {
    await ctx.reply("Use:\n/schedulemint targetId wallet1 2026-07-04T18:00:00Z [watch|auto]");
    return;
  }

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const target = getMintTargetForOwner(targetId, ownerTelegramId);
    const missing = getMintTargetMissingFields(target);

    if (missing.length > 0 || !target.functionSignature || target.priceEth === undefined) {
      await ctx.reply(
        `This target is incomplete. Missing contract address, function signature, price, or chain.\n\nMissing: ${missing.join(", ") || "unknown"}`
      );
      return;
    }

    const mode = normalizeMintJobMode(rawMode);
    const startTimeISO = validateScheduleStartTime(rawStartTime);
    const job = await createMintJobForTarget({
      ownerTelegramId,
      target,
      walletLabel,
      startTimeISO,
      mode
    });

    await auditMintAction({
      ownerTelegramId,
      action: "mint_job_created",
      targetId: job.targetId,
      jobId: job.jobId,
      walletLabel: job.walletLabel,
      walletAddress: job.walletAddress,
      chain: job.chain,
      contractAddress: job.contractAddress,
      functionSignature: job.functionSignature,
      quantity: job.quantity,
      priceEth: job.priceEth,
      mintType: job.mintType,
      status: job.status
    });

    await ctx.reply(
      `✅ Mint job scheduled.

${formatMintJob(job)}

Minting Lock: ${getMintLockStatusText(job.chain)}
Scheduled Lock: ${getScheduledMintLockStatusText(job.chain, job.mode)}${
        job.chain === "mainnet" && job.mode === "auto"
          ? "\n\nAuto mainnet minting requires both ALLOW_MAINNET_MINTING=true and ALLOW_SCHEDULED_MAINNET_MINTING=true."
          : ""
      }${
        formatMintTypeWarning(job.mintType) ? `\n\n${formatMintTypeWarning(job.mintType)}` : ""
      }`
    );
  } catch (error) {
    logSafeError("Could not schedule mint", error);
    await ctx.reply(`❌ Could not schedule mint.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.command("schedulemintphase", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = parseCommandParts(ctx.message.text);
  const targetId = parts[1]?.trim();
  const walletLabel = parts[2]?.trim();
  const rawPhaseType = parts[3]?.trim();
  const rawMode = parts[4]?.trim();

  if (!targetId || !walletLabel || !rawPhaseType) {
    await ctx.reply("Use:\n/schedulemintphase targetId wallet1 public [watch|auto]");
    return;
  }

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const target = getMintTargetForOwner(targetId, ownerTelegramId);
    const missing = getMintTargetMissingFields(target);

    if (missing.length > 0 || !target.functionSignature || target.priceEth === undefined) {
      await ctx.reply(
        `This target is incomplete. Missing contract address, function signature, price, or chain.\n\nMissing: ${missing.join(", ") || "unknown"}`
      );
      return;
    }

    const mintType = normalizePhaseMintType(rawPhaseType);
    const stage = findMintScheduleStageForType(target, mintType);

    if (!stage) {
      await ctx.reply(
        "No matching detected mint phase was found on this target. Use /schedulemint with a manual ISO time."
      );
      return;
    }

    const startTimeISO = getStageStartTimeISO(stage);
    const mode = normalizeMintJobMode(rawMode);
    const job = await createMintJobForTarget({
      ownerTelegramId,
      target,
      walletLabel,
      startTimeISO,
      mode,
      mintType
    });

    await auditMintAction({
      ownerTelegramId,
      action: "mint_job_created",
      targetId: job.targetId,
      jobId: job.jobId,
      walletLabel: job.walletLabel,
      walletAddress: job.walletAddress,
      chain: job.chain,
      contractAddress: job.contractAddress,
      functionSignature: job.functionSignature,
      quantity: job.quantity,
      priceEth: job.priceEth,
      mintType: job.mintType,
      status: job.status,
      reason: `phase:${stage.stageName || mintType}`
    });

    await ctx.reply(
      `✅ Mint phase job scheduled.

Matched Phase: ${stage.stageName || mintType}
${formatMintJob(job)}

Minting Lock: ${getMintLockStatusText(job.chain)}
Scheduled Lock: ${getScheduledMintLockStatusText(job.chain, job.mode)}${
        formatMintTypeWarning(job.mintType) ? `\n\n${formatMintTypeWarning(job.mintType)}` : ""
      }`
    );
  } catch (error) {
    logSafeError("Could not schedule mint phase", error);
    await ctx.reply(`❌ Could not schedule mint phase.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.command("mintwatchstatus", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const jobs = listActiveMintJobsForOwner(ownerTelegramId);
    await ctx.reply(`Mint Watch Status\n\n${formatMintJobList(jobs)}`);
  } catch (error) {
    logSafeError("Could not show mint watch status", error);
    await ctx.reply(`❌ Could not show mint watch status.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.command("mintjob", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const jobId = parseCommandParts(ctx.message.text)[1]?.trim();

  if (!jobId) {
    await ctx.reply("Use:\n/mintjob jobId");
    return;
  }

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const job = getMintJobForOwner(jobId, ownerTelegramId);
    await ctx.reply(formatMintJob(job));
  } catch (error) {
    logSafeError("Could not show mint job", error);
    await ctx.reply(`❌ Could not show mint job.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.command("cancelmintjob", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const jobId = parseCommandParts(ctx.message.text)[1]?.trim();

  if (!jobId) {
    await ctx.reply("Use:\n/cancelmintjob jobId");
    return;
  }

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const job = getMintJobForOwner(jobId, ownerTelegramId);

    if (["cancelled", "confirmed", "failed", "expired", "blocked"].includes(job.status)) {
      await ctx.reply(`Mint job is already ${job.status}.`);
      return;
    }

    const session = createMintJobCancelConfirmation({
      ownerTelegramId,
      jobId: job.jobId,
      targetName: job.targetName
    });

    await auditMintAction({
      ownerTelegramId,
      action: "mint_job_cancel_requested",
      targetId: job.targetId,
      jobId: job.jobId,
      walletLabel: job.walletLabel,
      walletAddress: job.walletAddress,
      chain: job.chain,
      contractAddress: job.contractAddress,
      functionSignature: job.functionSignature,
      quantity: job.quantity,
      priceEth: job.priceEth,
      mintType: job.mintType,
      status: job.status
    });

    await ctx.reply(
      `Cancel mint job?

Job ID: ${job.jobId}
Target: ${job.targetName}

This confirmation expires in 10 minutes.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Confirm Cancel", `mj:cancel_confirm:${session.sessionId}`)],
        [Markup.button.callback("Keep Job", `mj:cancel_cancel:${session.sessionId}`)]
      ])
    );
  } catch (error) {
    logSafeError("Could not request mint job cancellation", error);
    await ctx.reply(`❌ Could not request mint job cancellation.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.action(/^mj:cancel_confirm:([0-9a-f-]+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const sessionId = ctx.match[1];

  if (!sessionId) {
    await ctx.reply("This mint job cancellation has expired. Run /cancelmintjob again.");
    return;
  }

  const validated = await validateMintJobCancelConfirmation(ctx, sessionId);

  if (!validated) {
    return;
  }

  const { session } = validated;

  try {
    const job = updateMintJobStatus(
      session.jobId,
      session.ownerTelegramId,
      "cancelled",
      "cancelled_by_user"
    );
    session.status = "used";
    await auditMintAction({
      ownerTelegramId: job.ownerTelegramId,
      action: "mint_job_cancelled",
      targetId: job.targetId,
      jobId: job.jobId,
      walletLabel: job.walletLabel,
      walletAddress: job.walletAddress,
      chain: job.chain,
      contractAddress: job.contractAddress,
      functionSignature: job.functionSignature,
      quantity: job.quantity,
      priceEth: job.priceEth,
      mintType: job.mintType,
      status: job.status,
      reason: "cancelled_by_user"
    });
    await ctx.reply(`✅ Mint job cancelled.\n\n${formatMintJob(job)}`);
  } catch (error) {
    logSafeError("Could not cancel mint job", error);
    await ctx.reply(`❌ Could not cancel mint job.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.action(/^mj:cancel_cancel:([0-9a-f-]+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const sessionId = ctx.match[1];

  if (!sessionId) {
    await ctx.reply("This mint job cancellation has expired. Run /cancelmintjob again.");
    return;
  }

  const validated = await validateMintJobCancelConfirmation(ctx, sessionId);

  if (!validated) {
    return;
  }

  validated.session.status = "cancelled";
  await ctx.reply(`Mint job kept: ${validated.session.jobId}`);
});

bot.command("runmintcheck", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const jobId = parseCommandParts(ctx.message.text)[1]?.trim();

  if (!jobId) {
    await ctx.reply("Use:\n/runmintcheck jobId");
    return;
  }

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const job = getMintJobForOwner(jobId, ownerTelegramId);
    const readiness = await runMintJobReadinessCheck(job, { countAttempt: false });
    const updated = getMintJobForOwner(job.jobId, ownerTelegramId);

    await auditMintAction({
      ownerTelegramId,
      action: "mint_job_checked",
      targetId: updated.targetId,
      jobId: updated.jobId,
      walletLabel: updated.walletLabel,
      walletAddress: updated.walletAddress,
      chain: updated.chain,
      contractAddress: updated.contractAddress,
      functionSignature: updated.functionSignature,
      quantity: updated.quantity,
      priceEth: updated.priceEth,
      mintType: updated.mintType,
      status: readiness.status,
      reason: readiness.reason
    });

    await ctx.reply(
      `Mint Job Check

Job ID: ${updated.jobId}
Target: ${updated.targetName}
Status: ${readiness.status}
Ready: ${readiness.ready ? "yes" : "no"}
Gas Estimate: ${readiness.preview?.gasEstimate || "Not available"}
Reason: ${readiness.reason || "No blocking reason detected."}

No transaction was sent.`
    );
  } catch (error) {
    logSafeError("Could not run mint job check", error);
    await ctx.reply(`❌ Could not run mint job check.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.command("runmintjob", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const jobId = parseCommandParts(ctx.message.text)[1]?.trim();

  if (!jobId) {
    await ctx.reply("Use:\n/runmintjob jobId");
    return;
  }

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const job = getMintJobForOwner(jobId, ownerTelegramId);

    if (job.status === "cancelled" || job.status === "confirmed") {
      await ctx.reply(`Mint job is ${job.status} and cannot be run.`);
      return;
    }

    const target = getMintTargetForOwner(job.targetId, ownerTelegramId);
    const gasStrategy = getTargetGasStrategy(target);
    const preview = await previewMint({
      ownerTelegramId,
      walletLabel: job.walletLabel,
      contractAddress: job.contractAddress,
      functionSignature: job.functionSignature,
      quantity: job.quantity,
      priceEth: job.priceEth,
      chain: job.chain,
      gasStrategy
    });
    const run = createRunFromPreview(
      ownerTelegramId,
      preview,
      "pending",
      job.targetId,
      job.jobId
    );
    updateMintJobForOwner(job.jobId, ownerTelegramId, {
      lastRunId: run.runId
    });
    const session = createMintConfirmationSession({
      ownerTelegramId,
      walletLabel: preview.walletLabel,
      walletAddress: preview.walletAddress,
      chain: preview.chain,
      contractAddress: preview.contractAddress,
      functionSignature: preview.functionSignature,
      quantity: preview.quantity,
      priceEth: preview.priceEth,
      runId: run.runId,
      targetId: job.targetId,
      jobId: job.jobId,
      gasStrategy
    });

    await auditMintAction({
      ownerTelegramId,
      action: "mint_confirmation_created",
      targetId: job.targetId,
      jobId: job.jobId,
      runId: run.runId,
      walletLabel: preview.walletLabel,
      walletAddress: preview.walletAddress,
      chain: preview.chain,
      contractAddress: preview.contractAddress,
      functionSignature: preview.functionSignature,
      quantity: preview.quantity,
      priceEth: preview.priceEth,
      mintType: job.mintType,
      status: session.status
    });

    await ctx.reply(
      `${formatMintPreviewMessage(preview, {
        title: `Final Scheduled Mint Confirmation: ${job.targetName}`,
        targetId: job.targetId,
        runId: run.runId
      })}

Job ID: ${job.jobId}
Mode: manual confirmation

This confirmation expires in 10 minutes.

No transaction will be sent until you press Confirm Mint.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Confirm Mint", `mint:confirm:${session.sessionId}`)],
        [Markup.button.callback("Cancel", `mint:cancel:${session.sessionId}`)]
      ])
    );
  } catch (error) {
    logSafeError("Could not run mint job", error);
    await ctx.reply(`❌ Could not run mint job.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.command("schedulerstatus", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const rpcStatus = getMintRpcStatus();
    const activeJobs = listActiveMintJobsForOwner(ownerTelegramId);
    const activeMultiJobs = listActiveMultiMintJobsForOwner(ownerTelegramId);

    await ctx.reply(
      `Scheduler Status

Scheduler enabled: ${mintSchedulerTimer ? "yes" : "no"}
MINT_SCHEDULER_POLL_MS: ${getMintSchedulerPollMs()}
ALLOW_MAINNET_MINTING: ${isMainnetMintingEnabled() ? "true" : "false"}
ALLOW_SCHEDULED_MAINNET_MINTING: ${isScheduledMainnetMintingEnabled() ? "true" : "false"}
Active jobs for you: ${activeJobs.length}
Active multi-mint jobs for you: ${activeMultiJobs.length}
MAX_MULTI_MINT_WALLETS: ${getMaxMultiMintWallets()}
MAX_MULTI_MINT_CONCURRENCY: ${getMultiMintConcurrency()}
MULTI_MINT_DELAY_MS: ${getMultiMintDelayMs()}
ETH_MAINNET_RPC_URL configured: ${rpcStatus.mainnetRpcConfigured ? "yes" : "no"}
SEPOLIA_RPC_URL or ETH_SEPOLIA_RPC_URL configured: ${rpcStatus.sepoliaRpcConfigured ? "yes" : "no"}

Scheduled Ethereum mainnet auto-minting requires both ALLOW_MAINNET_MINTING=true and ALLOW_SCHEDULED_MAINNET_MINTING=true.`
    );
  } catch (error) {
    logSafeError("Could not show scheduler status", error);
    await ctx.reply(`❌ Could not show scheduler status.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.command("schedulemintmulti", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = parseCommandParts(ctx.message.text);
  const targetId = parts[1]?.trim();
  const rawWallets = parts[2]?.trim();
  const rawStartTime = parts[3]?.trim();
  const rawMode = parts[4]?.trim();

  if (!targetId || !rawWallets || !rawStartTime) {
    await ctx.reply(
      "Use:\n/schedulemintmulti targetId wallet1,wallet2 2026-07-04T18:00:00Z [watch|auto]"
    );
    return;
  }

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const target = getMintTargetForOwner(targetId, ownerTelegramId);
    const missing = getMintTargetMissingFields(target);

    if (missing.length > 0 || !target.functionSignature || target.priceEth === undefined) {
      await ctx.reply(
        `This target is incomplete. Missing contract address, function signature, price, or chain.\n\nMissing: ${missing.join(", ") || "unknown"}`
      );
      return;
    }

    const walletLabels = parseWalletLabelList(rawWallets);
    const mode = normalizeMintJobMode(rawMode);
    const startTimeISO = validateScheduleStartTime(rawStartTime);
    const job = await createMultiMintJobForTarget({
      ownerTelegramId,
      target,
      walletLabels,
      startTimeISO,
      mode
    });

    await auditMintAction({
      ownerTelegramId,
      action: "multi_mint_job_created",
      targetId: job.targetId,
      multiMintJobId: job.jobId,
      chain: job.chain,
      contractAddress: job.contractAddress,
      functionSignature: job.functionSignature,
      quantity: job.quantity,
      priceEth: job.priceEth,
      gasStrategyMode: job.gasStrategy.mode,
      status: job.status,
      reason: `wallets:${job.walletLabels.length}`
    });

    await ctx.reply(
      `✅ Multi-mint job scheduled.

${formatMultiMintJob(job)}

Minting Lock: ${getMintLockStatusText(job.chain)}
Scheduled Lock: ${getScheduledMintLockStatusText(job.chain, job.mode)}${
        job.chain === "mainnet" && job.mode === "auto"
          ? "\n\nAuto mainnet multi-minting requires both ALLOW_MAINNET_MINTING=true and ALLOW_SCHEDULED_MAINNET_MINTING=true."
          : ""
      }`
    );
  } catch (error) {
    logSafeError("Could not schedule multi-mint", error);
    await ctx.reply(`❌ Could not schedule multi-mint.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.command("runmultimintjob", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const jobId = parseCommandParts(ctx.message.text)[1]?.trim();

  if (!jobId) {
    await ctx.reply("Use:\n/runmultimintjob jobId");
    return;
  }

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const job = getMultiMintJobForOwner(jobId, ownerTelegramId);

    if (["cancelled", "confirmed", "failed", "expired", "blocked"].includes(job.status)) {
      await ctx.reply(`Multi-mint job is ${job.status} and cannot be run.`);
      return;
    }

    const preflight = await getMultiMintPreflightForSnapshot({
      ownerTelegramId,
      walletLabels: job.walletLabels,
      contractAddress: job.contractAddress,
      functionSignature: job.functionSignature,
      quantity: job.quantity,
      priceEth: job.priceEth,
      chain: job.chain,
      gasStrategy: job.gasStrategy
    });

    const session = createMultiMintConfirmationSession({
      ownerTelegramId,
      targetId: job.targetId,
      targetName: job.targetName,
      chain: job.chain,
      contractAddress: job.contractAddress,
      functionSignature: job.functionSignature,
      quantity: job.quantity,
      priceEth: job.priceEth,
      walletLabels: job.walletLabels,
      walletAddresses: job.walletAddresses,
      gasStrategy: job.gasStrategy,
      multiMintJobId: job.jobId
    });

    await auditMintAction({
      ownerTelegramId,
      action: "multi_mint_confirm_requested",
      targetId: job.targetId,
      multiMintJobId: job.jobId,
      chain: job.chain,
      contractAddress: job.contractAddress,
      functionSignature: job.functionSignature,
      quantity: job.quantity,
      priceEth: job.priceEth,
      gasStrategyMode: job.gasStrategy.mode,
      status: session.status,
      reason: `wallets:${job.walletLabels.length}`
    });

    await ctx.reply(
      `Multi-Mint Job Confirmation

${formatMultiMintJob(job)}

Preflight with saved job gas strategy:
${formatMultiGasPreview(preflight.previews, preflight.failures)}

This confirmation expires in 10 minutes.

No transaction will be sent until you press Confirm Multi Mint.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Confirm Multi Mint", `mm:confirm:${session.sessionId}`)],
        [Markup.button.callback("Cancel", `mm:cancel:${session.sessionId}`)]
      ])
    );
  } catch (error) {
    logSafeError("Could not create multi-mint job confirmation", error);
    await ctx.reply(`❌ Could not create multi-mint job confirmation.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.command("multimintjob", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const jobId = parseCommandParts(ctx.message.text)[1]?.trim();

  if (!jobId) {
    await ctx.reply("Use:\n/multimintjob jobId");
    return;
  }

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const job = getMultiMintJobForOwner(jobId, ownerTelegramId);
    await ctx.reply(formatMultiMintJob(job));
  } catch (error) {
    logSafeError("Could not show multi-mint job", error);
    await ctx.reply(`❌ Could not show multi-mint job.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.command("cancelmultimintjob", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const jobId = parseCommandParts(ctx.message.text)[1]?.trim();

  if (!jobId) {
    await ctx.reply("Use:\n/cancelmultimintjob jobId");
    return;
  }

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const job = getMultiMintJobForOwner(jobId, ownerTelegramId);

    if (["cancelled", "confirmed", "failed", "expired", "blocked"].includes(job.status)) {
      await ctx.reply(`Multi-mint job is already ${job.status}.`);
      return;
    }

    const session = createMultiMintJobCancelConfirmation({
      ownerTelegramId,
      jobId: job.jobId,
      targetName: job.targetName
    });

    await auditMintAction({
      ownerTelegramId,
      action: "multi_mint_job_cancel_requested",
      targetId: job.targetId,
      multiMintJobId: job.jobId,
      chain: job.chain,
      contractAddress: job.contractAddress,
      functionSignature: job.functionSignature,
      quantity: job.quantity,
      priceEth: job.priceEth,
      gasStrategyMode: job.gasStrategy.mode,
      status: job.status
    });

    await ctx.reply(
      `Cancel multi-mint job?

Job ID: ${job.jobId}
Target: ${job.targetName}

This confirmation expires in 10 minutes.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Confirm Cancel", `mmj:cancel_confirm:${session.sessionId}`)],
        [Markup.button.callback("Keep Job", `mmj:cancel_cancel:${session.sessionId}`)]
      ])
    );
  } catch (error) {
    logSafeError("Could not request multi-mint cancellation", error);
    await ctx.reply(`❌ Could not request multi-mint cancellation.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.action(/^mmj:cancel_confirm:([0-9a-f-]+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const sessionId = ctx.match[1];

  if (!sessionId) {
    await ctx.reply("This multi-mint job cancellation has expired. Run /cancelmultimintjob again.");
    return;
  }

  const validated = await validateMultiMintJobCancelConfirmation(ctx, sessionId);

  if (!validated) {
    return;
  }

  const { session } = validated;

  try {
    const job = updateMultiMintJobForOwner(
      session.jobId,
      session.ownerTelegramId,
      {
        status: "cancelled",
        safeErrorReason: "cancelled_by_user"
      }
    );
    session.status = "used";
    await auditMintAction({
      ownerTelegramId: job.ownerTelegramId,
      action: "multi_mint_job_cancelled",
      targetId: job.targetId,
      multiMintJobId: job.jobId,
      chain: job.chain,
      contractAddress: job.contractAddress,
      functionSignature: job.functionSignature,
      quantity: job.quantity,
      priceEth: job.priceEth,
      gasStrategyMode: job.gasStrategy.mode,
      status: job.status,
      reason: "cancelled_by_user"
    });
    await ctx.reply(`✅ Multi-mint job cancelled.\n\n${formatMultiMintJob(job)}`);
  } catch (error) {
    logSafeError("Could not cancel multi-mint job", error);
    await ctx.reply(`❌ Could not cancel multi-mint job.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.action(/^mmj:cancel_cancel:([0-9a-f-]+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const sessionId = ctx.match[1];

  if (!sessionId) {
    await ctx.reply("This multi-mint job cancellation has expired. Run /cancelmultimintjob again.");
    return;
  }

  const validated = await validateMultiMintJobCancelConfirmation(ctx, sessionId);

  if (!validated) {
    return;
  }

  validated.session.status = "cancelled";
  await ctx.reply(`Multi-mint job kept: ${validated.session.jobId}`);
});

bot.command("multimintstatus", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const rpcStatus = getMintRpcStatus();
    const activeJobs = listActiveMultiMintJobsForOwner(ownerTelegramId);
    const pendingCount = activeJobs.filter((job) =>
      ["scheduled", "watching"].includes(job.status)
    ).length;
    const readyCount = activeJobs.filter((job) => job.status === "ready").length;
    const submittedCount = activeJobs.filter((job) =>
      ["submitted", "partial"].includes(job.status)
    ).length;

    await ctx.reply(
      `Multi-Mint Status

MAX_MULTI_MINT_WALLETS: ${getMaxMultiMintWallets()}
MAX_MULTI_MINT_CONCURRENCY: ${getMultiMintConcurrency()}
MULTI_MINT_DELAY_MS: ${getMultiMintDelayMs()}
ALLOW_MAINNET_MINTING: ${isMainnetMintingEnabled() ? "true" : "false"}
ALLOW_SCHEDULED_MAINNET_MINTING: ${isScheduledMainnetMintingEnabled() ? "true" : "false"}
Active multi jobs for you: ${activeJobs.length}
Pending/Watching: ${pendingCount}
Ready: ${readyCount}
Submitted/Partial: ${submittedCount}
Gas strategy support: enabled
ETH_MAINNET_RPC_URL configured: ${rpcStatus.mainnetRpcConfigured ? "yes" : "no"}
SEPOLIA_RPC_URL or ETH_SEPOLIA_RPC_URL configured: ${rpcStatus.sepoliaRpcConfigured ? "yes" : "no"}`
    );
  } catch (error) {
    logSafeError("Could not show multi-mint status", error);
    await ctx.reply(`❌ Could not show multi-mint status.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.command("mainmintpreview", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const params = parseMintCommandParams(parseCommandParts(ctx.message.text));
    const preview = await previewMint({
      ownerTelegramId,
      ...params
    });
    const run = createRunFromPreview(ownerTelegramId, preview, "previewed");

    await auditMintAction({
      ownerTelegramId,
      action: "mint_previewed",
      walletLabel: preview.walletLabel,
      walletAddress: preview.walletAddress,
      runId: run.runId,
      chain: preview.chain,
      contractAddress: preview.contractAddress,
      functionSignature: preview.functionSignature,
      quantity: preview.quantity,
      priceEth: preview.priceEth,
      status: run.status,
      ...(preview.gasEstimateFailed ? { reason: "gas_estimation_failed" } : {})
    });

    await ctx.reply(formatMintPreviewMessage(preview, { runId: run.runId }));
  } catch (error) {
    logSafeError("Mint preview failed", error);
    await ctx.reply(`❌ Mint preview failed.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.command("mainmint", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const params = parseMintCommandParams(parseCommandParts(ctx.message.text));
    const preview = await previewMint({
      ownerTelegramId,
      ...params
    });
    const run = createRunFromPreview(ownerTelegramId, preview, "pending");
    const session = createMintConfirmationSession({
      ownerTelegramId,
      walletLabel: preview.walletLabel,
      walletAddress: preview.walletAddress,
      chain: preview.chain,
      contractAddress: preview.contractAddress,
      functionSignature: preview.functionSignature,
      quantity: preview.quantity,
      priceEth: preview.priceEth,
      runId: run.runId
    });

    await auditMintAction({
      ownerTelegramId,
      action: "mint_confirmation_created",
      walletLabel: preview.walletLabel,
      walletAddress: preview.walletAddress,
      runId: run.runId,
      chain: preview.chain,
      contractAddress: preview.contractAddress,
      functionSignature: preview.functionSignature,
      quantity: preview.quantity,
      priceEth: preview.priceEth,
      status: session.status
    });

    await ctx.reply(
      `${formatMintPreviewMessage(preview, {
        title: "Final Mint Confirmation",
        runId: run.runId
      })}

This confirmation expires in 10 minutes.

No transaction will be sent until you press Confirm Mint.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Confirm Mint", `mint:confirm:${session.sessionId}`)],
        [Markup.button.callback("Cancel", `mint:cancel:${session.sessionId}`)]
      ])
    );
  } catch (error) {
    logSafeError("Could not create mint confirmation", error);
    await ctx.reply(`❌ Could not create mint confirmation.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.action(/^mint:confirm:([0-9a-f-]+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const sessionId = ctx.match[1];

  if (!sessionId) {
    await ctx.reply(MINT_CONFIRMATION_EXPIRED_MESSAGE);
    return;
  }

  const validated = await validateMintConfirmationSession(ctx, sessionId);

  if (!validated) {
    return;
  }

  const { session, actorTelegramId } = validated;

  try {
    const preview = await previewMint({
      ownerTelegramId: session.ownerTelegramId,
      walletLabel: session.walletLabel,
      contractAddress: session.contractAddress,
      functionSignature: session.functionSignature,
      quantity: session.quantity,
      priceEth: session.priceEth,
      chain: session.chain,
      ...(session.gasStrategy ? { gasStrategy: session.gasStrategy } : {})
    });

    if (preview.walletAddress.toLowerCase() !== session.walletAddress.toLowerCase()) {
      throw new Error("Wallet session no longer matches the saved wallet.");
    }

    if (session.chain === "mainnet" && !isMainnetMintingEnabled()) {
      session.status = "used";
      updateMintRunForOwner(session.runId, session.ownerTelegramId, {
        status: "blocked",
        errorReason: "mainnet_minting_disabled"
      });
      if (session.jobId) {
        updateMintJobForOwner(session.jobId, session.ownerTelegramId, {
          status: "blocked",
          lastRunId: session.runId,
          safeErrorReason: "mainnet_minting_disabled"
        });
      }
      await auditMintAction({
        ownerTelegramId: session.ownerTelegramId,
        action: "mint_blocked",
        walletLabel: session.walletLabel,
        walletAddress: session.walletAddress,
        targetId: session.targetId,
        jobId: session.jobId,
        runId: session.runId,
        chain: session.chain,
        contractAddress: session.contractAddress,
        functionSignature: session.functionSignature,
        quantity: session.quantity,
        priceEth: session.priceEth,
        status: "blocked",
        reason: "mainnet_minting_disabled"
      });
      await ctx.reply(MAINNET_MINTING_DISABLED_MESSAGE);
      return;
    }

    if (preview.gasEstimateFailed) {
      session.status = "used";
      updateMintRunForOwner(session.runId, session.ownerTelegramId, {
        status: "blocked",
        errorReason: "gas_estimation_failed"
      });
      if (session.jobId) {
        updateMintJobForOwner(session.jobId, session.ownerTelegramId, {
          status: "blocked",
          lastRunId: session.runId,
          safeErrorReason: preview.gasEstimateError || "gas_estimation_failed"
        });
      }
      await auditMintAction({
        ownerTelegramId: session.ownerTelegramId,
        action: "mint_blocked",
        walletLabel: session.walletLabel,
        walletAddress: session.walletAddress,
        targetId: session.targetId,
        jobId: session.jobId,
        runId: session.runId,
        chain: session.chain,
        contractAddress: session.contractAddress,
        functionSignature: session.functionSignature,
        quantity: session.quantity,
        priceEth: session.priceEth,
        status: "blocked",
        reason: "gas_estimation_failed"
      });
      await ctx.reply(
        `Gas estimation failed. The mint may not be live, wallet may not be eligible, function may be wrong, or contract may reject the call.${
          preview.gasEstimateError ? `\n\nReason:\n${preview.gasEstimateError}` : ""
        }`
      );
      return;
    }

    session.status = "used";
    const submitted = await submitMintTransaction({
      ownerTelegramId: session.ownerTelegramId,
      walletLabel: session.walletLabel,
      contractAddress: session.contractAddress,
      functionSignature: session.functionSignature,
      quantity: session.quantity,
      priceEth: session.priceEth,
      chain: session.chain,
      ...(session.gasStrategy ? { gasStrategy: session.gasStrategy } : {})
    });

    updateMintRunForOwner(session.runId, session.ownerTelegramId, {
      status: "submitted",
      txHash: submitted.txHash
    });
    if (session.jobId) {
      updateMintJobForOwner(session.jobId, session.ownerTelegramId, {
        status: "submitted",
        lastRunId: session.runId,
        txHash: submitted.txHash
      });
    }

    await auditMintAction({
      ownerTelegramId: session.ownerTelegramId,
      action: "mint_submitted",
      walletLabel: session.walletLabel,
      walletAddress: submitted.walletAddress,
      targetId: session.targetId,
      jobId: session.jobId,
      runId: session.runId,
      chain: session.chain,
      contractAddress: session.contractAddress,
      functionSignature: session.functionSignature,
      quantity: session.quantity,
      priceEth: session.priceEth,
      txHash: submitted.txHash,
      status: "submitted"
    });

    await ctx.reply(
      `✅ Mint transaction sent.

Run ID: ${session.runId}
Tx:
${submitted.txHash}`
    );

    try {
      const confirmation = await waitForMintConfirmation(
        session.chain,
        submitted.txHash
      );

      if (confirmation.status === "confirmed") {
        updateMintRunForOwner(session.runId, session.ownerTelegramId, {
          status: "confirmed",
          confirmedAt: new Date().toISOString()
        });
        if (session.jobId) {
          updateMintJobForOwner(session.jobId, session.ownerTelegramId, {
            status: "confirmed",
            lastRunId: session.runId,
            txHash: submitted.txHash
          });
        }
        await auditMintAction({
          ownerTelegramId: session.ownerTelegramId,
          action: "mint_confirmed",
          walletLabel: session.walletLabel,
          walletAddress: submitted.walletAddress,
          targetId: session.targetId,
          jobId: session.jobId,
          runId: session.runId,
          chain: session.chain,
          contractAddress: session.contractAddress,
          functionSignature: session.functionSignature,
          quantity: session.quantity,
          priceEth: session.priceEth,
          txHash: submitted.txHash,
          status: "confirmed"
        });
        await ctx.reply(
          `✅ Mint confirmed.

Run ID: ${session.runId}
Tx:
${submitted.txHash}`
        );
        return;
      }

      if (confirmation.status === "timeout") {
        updateMintRunForOwner(session.runId, session.ownerTelegramId, {
          status: "submitted",
          errorReason: "confirmation_timeout"
        });
        if (session.jobId) {
          updateMintJobForOwner(session.jobId, session.ownerTelegramId, {
            status: "submitted",
            lastRunId: session.runId,
            txHash: submitted.txHash,
            safeErrorReason: "confirmation_timeout"
          });
        }
        await ctx.reply(
          `⚠️ Mint transaction was sent, but confirmation timed out.

Run ID: ${session.runId}
Tx:
${submitted.txHash}`
        );
        return;
      }

      updateMintRunForOwner(session.runId, session.ownerTelegramId, {
        status: "failed",
        errorReason: "transaction_failed",
        confirmedAt: new Date().toISOString()
      });
      if (session.jobId) {
        updateMintJobForOwner(session.jobId, session.ownerTelegramId, {
          status: "failed",
          lastRunId: session.runId,
          txHash: submitted.txHash,
          safeErrorReason: "transaction_failed"
        });
      }
      await auditMintAction({
        ownerTelegramId: session.ownerTelegramId,
        action: "mint_failed",
        walletLabel: session.walletLabel,
        walletAddress: submitted.walletAddress,
        targetId: session.targetId,
        jobId: session.jobId,
        runId: session.runId,
        chain: session.chain,
        contractAddress: session.contractAddress,
        functionSignature: session.functionSignature,
        quantity: session.quantity,
        priceEth: session.priceEth,
        txHash: submitted.txHash,
        status: "failed",
        reason: "transaction_failed"
      });
      await ctx.reply(
        `❌ Mint transaction failed.

Run ID: ${session.runId}
Tx:
${submitted.txHash}`
      );
    } catch (confirmationError) {
      logSafeError("Mint confirmation wait failed", confirmationError);
      updateMintRunForOwner(session.runId, session.ownerTelegramId, {
        status: "submitted",
        errorReason: getSafeErrorMessage(confirmationError)
      });
      if (session.jobId) {
        updateMintJobForOwner(session.jobId, session.ownerTelegramId, {
          status: "submitted",
          lastRunId: session.runId,
          txHash: submitted.txHash,
          safeErrorReason: getSafeErrorMessage(confirmationError)
        });
      }
      await ctx.reply(
        `⚠️ Mint transaction was sent, but confirmation could not be verified yet.

Run ID: ${session.runId}
Tx:
${submitted.txHash}

Reason:
${getSafeErrorMessage(confirmationError)}`
      );
    }
  } catch (error) {
    logSafeError("Mint confirmation failed", error);
    session.status = "used";
    updateMintRunForOwner(session.runId, session.ownerTelegramId, {
      status: "failed",
      errorReason: getSafeErrorMessage(error)
    });
    if (session.jobId) {
      updateMintJobForOwner(session.jobId, session.ownerTelegramId, {
        status: "failed",
        lastRunId: session.runId,
        safeErrorReason: getSafeErrorMessage(error)
      });
    }
    await auditMintAction({
      ownerTelegramId: session.ownerTelegramId,
      action: "mint_failed",
      walletLabel: session.walletLabel,
      walletAddress: session.walletAddress,
      targetId: session.targetId,
      jobId: session.jobId,
      runId: session.runId,
      chain: session.chain,
      contractAddress: session.contractAddress,
      functionSignature: session.functionSignature,
      quantity: session.quantity,
      priceEth: session.priceEth,
      status: "failed",
      reason: getSafeErrorMessage(error)
    });
    await ctx.reply(`❌ Mint failed.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.action(/^mint:cancel:([0-9a-f-]+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const sessionId = ctx.match[1];

  if (!sessionId) {
    await ctx.reply(MINT_CONFIRMATION_EXPIRED_MESSAGE);
    return;
  }

  const validated = await validateMintConfirmationSession(ctx, sessionId);

  if (!validated) {
    return;
  }

  const { session, actorTelegramId } = validated;
  session.status = "cancelled";
  updateMintRunForOwner(session.runId, session.ownerTelegramId, {
    status: "cancelled",
    errorReason: "cancelled_by_user"
  });
  if (session.jobId) {
    updateMintJobForOwner(session.jobId, session.ownerTelegramId, {
      status: "cancelled",
      lastRunId: session.runId,
      safeErrorReason: "cancelled_by_user"
    });
  }
  await auditMintAction({
    ownerTelegramId: session.ownerTelegramId,
    action: "mint_blocked",
    walletLabel: session.walletLabel,
    walletAddress: session.walletAddress,
    targetId: session.targetId,
    jobId: session.jobId,
    runId: session.runId,
    chain: session.chain,
    contractAddress: session.contractAddress,
    functionSignature: session.functionSignature,
    quantity: session.quantity,
    priceEth: session.priceEth,
    status: "cancelled",
    reason: `cancelled_by=${actorTelegramId}`
  });

  await ctx.reply(`Cancelled mint confirmation for run ${session.runId}.`);
});

bot.command("addminttarget", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const params = parseMintTargetParams(parseCommandParts(ctx.message.text));
    const target = createMintTarget({
      ownerTelegramId,
      ...params
    });

    await auditMintAction({
      ownerTelegramId,
      action: "mint_target_created",
      targetId: target.targetId,
      chain: target.chain,
      contractAddress: target.contractAddress,
      functionSignature: target.functionSignature,
      quantity: target.quantity,
      priceEth: target.priceEth,
      status: target.status
    });

    await ctx.reply(`✅ Mint target saved.\n\n${formatMintTarget(target)}`);
  } catch (error) {
    logSafeError("Could not add mint target", error);
    await ctx.reply(`❌ Could not add mint target.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.command("minttargets", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const targets = listMintTargetsForOwner(ownerTelegramId);

    if (targets.length === 0) {
      await ctx.reply("No active mint targets found. Add one with /addminttarget.");
      return;
    }

    const message = targets
      .map((target, index) =>
        [
          `${index + 1}. ${target.name}`,
          `Target ID: ${target.targetId}`,
          `Chain: ${target.chain}`,
          `Contract: ${target.contractAddress ? formatShortAddress(target.contractAddress) : "Unknown"}`,
          `Completeness: ${target.targetCompleteness}`,
          `Function: ${target.functionSignature || "Unknown"}`,
          `Qty: ${target.quantity}`,
          `Price: ${target.priceEth === undefined ? "Unknown" : `${target.priceEth} ETH`}`
        ].join("\n")
      )
      .join("\n\n");

    await ctx.reply(`Your mint targets:\n\n${message}`);
  } catch (error) {
    logSafeError("Could not list mint targets", error);
    await ctx.reply(`❌ Could not list mint targets.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.command("minttarget", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const targetId = parseCommandParts(ctx.message.text)[1]?.trim();

    if (!targetId) {
      await ctx.reply("Use:\n/minttarget targetId");
      return;
    }

    const target = getMintTargetForOwner(targetId, ownerTelegramId, {
      includeArchived: true
    });

    await ctx.reply(formatMintTarget(target));
  } catch (error) {
    logSafeError("Could not load mint target", error);
    await ctx.reply(`❌ Could not load mint target.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.command("updateminttarget", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const parsed = parseMintTargetUpdateParams(parseCommandParts(ctx.message.text));
    const target = updateMintTargetForOwner(parsed.targetId, ownerTelegramId, {
      ...(parsed.contractAddress ? { contractAddress: parsed.contractAddress } : {}),
      chain: parsed.chain,
      functionSignature: parsed.functionSignature,
      quantity: parsed.quantity,
      priceEth: parsed.priceEth
    });

    await auditMintAction({
      ownerTelegramId,
      action: "mint_target_updated",
      targetId: target.targetId,
      chain: target.chain,
      contractAddress: target.contractAddress,
      functionSignature: target.functionSignature,
      quantity: target.quantity,
      priceEth: target.priceEth,
      status: target.status
    });

    await ctx.reply(`✅ Mint target updated.\n\n${formatMintTarget(target)}`);
  } catch (error) {
    logSafeError("Could not update mint target", error);
    await ctx.reply(`❌ Could not update mint target.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.command("deleteminttarget", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const targetId = parseCommandParts(ctx.message.text)[1]?.trim();

    if (!targetId) {
      await ctx.reply("Use:\n/deleteminttarget targetId");
      return;
    }

    const target = getMintTargetForOwner(targetId, ownerTelegramId, {
      includeArchived: true
    });

    if (target.status === "archived") {
      await ctx.reply(`Mint target "${target.name}" is already archived.`);
      return;
    }

    const session = createMintTargetDeleteConfirmation({
      ownerTelegramId,
      targetId: target.targetId,
      targetName: target.name
    });

    await ctx.reply(
      `Are you sure you want to remove mint target "${target.name}"?

This archives the target locally. It does not interact with the contract.

This confirmation expires in 10 minutes.`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "Confirm Remove",
            `mt:delete_confirm:${session.sessionId}`
          )
        ],
        [Markup.button.callback("Cancel", `mt:delete_cancel:${session.sessionId}`)]
      ])
    );
  } catch (error) {
    logSafeError("Could not request mint target deletion", error);
    await ctx.reply(`❌ Could not request mint target removal.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.action(/^mt:delete_confirm:([0-9a-f-]+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const sessionId = ctx.match[1];

  if (!sessionId) {
    await ctx.reply("This mint target removal confirmation has expired. Run /deleteminttarget again.");
    return;
  }

  const validated = await validateMintTargetDeleteConfirmation(ctx, sessionId);

  if (!validated) {
    return;
  }

  const { session } = validated;

  try {
    const target = archiveMintTargetForOwner(
      session.targetId,
      session.ownerTelegramId
    );
    session.status = "used";
    await auditMintAction({
      ownerTelegramId: session.ownerTelegramId,
      action: "mint_target_archived",
      targetId: target.targetId,
      chain: target.chain,
      contractAddress: target.contractAddress,
      functionSignature: target.functionSignature,
      quantity: target.quantity,
      priceEth: target.priceEth,
      status: target.status
    });
    await ctx.reply(`✅ Mint target archived.\n\n${formatMintTarget(target)}`);
  } catch (error) {
    logSafeError("Could not archive mint target", error);
    await ctx.reply(`❌ Could not archive mint target.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.action(/^mt:delete_cancel:([0-9a-f-]+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const sessionId = ctx.match[1];

  if (!sessionId) {
    await ctx.reply("This mint target removal confirmation has expired. Run /deleteminttarget again.");
    return;
  }

  const validated = await validateMintTargetDeleteConfirmation(ctx, sessionId);

  if (!validated) {
    return;
  }

  validated.session.status = "cancelled";
  await ctx.reply(`Cancelled removal for mint target "${validated.session.targetName}".`);
});

bot.command("minttargetpreview", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const parts = parseCommandParts(ctx.message.text);
    const targetId = parts[1]?.trim();
    const walletLabel = parts[2]?.trim();

    if (!targetId || !walletLabel) {
      await ctx.reply("Use:\n/minttargetpreview targetId wallet1");
      return;
    }

    const target = requireCompleteMintTarget(
      getMintTargetForOwner(targetId, ownerTelegramId)
    );
    const gasStrategy = getTargetGasStrategy(target);
    const preview = await previewMint({
      ownerTelegramId,
      walletLabel,
      contractAddress: target.contractAddress,
      functionSignature: target.functionSignature,
      quantity: target.quantity,
      priceEth: target.priceEth,
      chain: target.chain,
      gasStrategy
    });
    const run = createRunFromPreview(
      ownerTelegramId,
      preview,
      "previewed",
      target.targetId
    );

    await auditMintAction({
      ownerTelegramId,
      action: "mint_previewed",
      walletLabel: preview.walletLabel,
      walletAddress: preview.walletAddress,
      targetId: target.targetId,
      runId: run.runId,
      chain: preview.chain,
      contractAddress: preview.contractAddress,
      functionSignature: preview.functionSignature,
      quantity: preview.quantity,
      priceEth: preview.priceEth,
      status: run.status,
      ...(preview.gasEstimateFailed ? { reason: "gas_estimation_failed" } : {})
    });

    await ctx.reply(
      formatMintPreviewMessage(preview, {
        title: `Mint Target Preview: ${target.name}`,
        targetId: target.targetId,
        runId: run.runId
      })
    );
  } catch (error) {
    logSafeError("Mint target preview failed", error);
    await ctx.reply(`❌ Mint target preview failed.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.command("minttargetnow", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const parts = parseCommandParts(ctx.message.text);
    const targetId = parts[1]?.trim();
    const walletLabel = parts[2]?.trim();

    if (!targetId || !walletLabel) {
      await ctx.reply("Use:\n/minttargetnow targetId wallet1");
      return;
    }

    const target = requireCompleteMintTarget(
      getMintTargetForOwner(targetId, ownerTelegramId)
    );
    const gasStrategy = getTargetGasStrategy(target);
    const preview = await previewMint({
      ownerTelegramId,
      walletLabel,
      contractAddress: target.contractAddress,
      functionSignature: target.functionSignature,
      quantity: target.quantity,
      priceEth: target.priceEth,
      chain: target.chain,
      gasStrategy
    });
    const run = createRunFromPreview(
      ownerTelegramId,
      preview,
      "pending",
      target.targetId
    );
    const session = createMintConfirmationSession({
      ownerTelegramId,
      walletLabel: preview.walletLabel,
      walletAddress: preview.walletAddress,
      chain: preview.chain,
      contractAddress: preview.contractAddress,
      functionSignature: preview.functionSignature,
      quantity: preview.quantity,
      priceEth: preview.priceEth,
      runId: run.runId,
      targetId: target.targetId,
      gasStrategy
    });

    await auditMintAction({
      ownerTelegramId,
      action: "mint_confirmation_created",
      walletLabel: preview.walletLabel,
      walletAddress: preview.walletAddress,
      targetId: target.targetId,
      runId: run.runId,
      chain: preview.chain,
      contractAddress: preview.contractAddress,
      functionSignature: preview.functionSignature,
      quantity: preview.quantity,
      priceEth: preview.priceEth,
      status: session.status
    });

    await ctx.reply(
      `${formatMintPreviewMessage(preview, {
        title: `Final Mint Target Confirmation: ${target.name}`,
        targetId: target.targetId,
        runId: run.runId
      })}

This confirmation expires in 10 minutes.

No transaction will be sent until you press Confirm Mint.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Confirm Mint", `mint:confirm:${session.sessionId}`)],
        [Markup.button.callback("Cancel", `mint:cancel:${session.sessionId}`)]
      ])
    );
  } catch (error) {
    logSafeError("Could not create mint target confirmation", error);
    await ctx.reply(`❌ Could not create mint target confirmation.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.command("minthistory", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const limitRaw = parseCommandParts(ctx.message.text)[1]?.trim();
    const limit = limitRaw ? Number(limitRaw) : 10;
    const runs = listMintRunsForOwner(
      ownerTelegramId,
      Number.isFinite(limit) ? limit : 10
    );

    if (runs.length === 0) {
      await ctx.reply("No mint history found yet.");
      return;
    }

    await ctx.reply(
      `Recent mint runs:\n\n${runs
        .map((run) =>
          [
            `Run ID: ${run.runId}`,
            `Status: ${run.status}`,
            `Wallet: ${run.walletLabel}`,
            `Chain: ${run.chain}`,
            `Contract: ${formatShortAddress(run.contractAddress)}`,
            `Function: ${run.functionSignature}`,
            ...(run.txHash ? [`Tx: ${run.txHash}`] : [])
          ].join("\n")
        )
        .join("\n\n")}`
    );
  } catch (error) {
    logSafeError("Could not load mint history", error);
    await ctx.reply(`❌ Could not load mint history.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.command("mintstatus", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const runId = parseCommandParts(ctx.message.text)[1]?.trim();

    if (!runId) {
      await ctx.reply("Use:\n/mintstatus runId");
      return;
    }

    const run = getMintRunForOwner(runId, ownerTelegramId);

    await auditMintAction({
      ownerTelegramId,
      action: "mint_run_viewed",
      walletLabel: run.walletLabel,
      walletAddress: run.walletAddress,
      targetId: run.targetId,
      runId: run.runId,
      chain: run.chain,
      contractAddress: run.contractAddress,
      functionSignature: run.functionSignature,
      quantity: run.quantity,
      priceEth: run.priceEth,
      txHash: run.txHash,
      status: run.status
    });

    await ctx.reply(formatMintRun(run));
  } catch (error) {
    logSafeError("Could not load mint run", error);
    await ctx.reply(`❌ Could not load mint run.\n\nReason:\n${getSafeErrorMessage(error)}`);
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
    await sendWalletsList(ctx);
  } catch (error) {
    logSafeError("Could not load wallet status", error);
    await ctx.reply("❌ Could not load wallet status. Check Terminal for the error.");
  }
});

bot.command("wallets", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  try {
    await sendWalletsList(ctx);
  } catch (error) {
    logSafeError("Could not list wallets", error);
    await ctx.reply("❌ Could not list wallets.");
  }
});

bot.command("wallet", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = parseCommandParts(ctx.message.text);
  const walletLabel = parts[1]?.trim();

  if (!walletLabel) {
    await ctx.reply(
      `Invalid format.

Use:
/wallet wallet1`
    );
    return;
  }

  try {
    await sendWalletDetails(ctx, walletLabel);
  } catch (error) {
    logSafeError("Could not load wallet details", error);
    await ctx.reply(`❌ Could not load wallet "${normalizeWalletLabel(walletLabel)}".`);
  }
});

bot.action(/^wm:view:([A-Za-z0-9_-]{2,32})$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  try {
    const walletLabel = ctx.match[1];

    if (!walletLabel) {
      await ctx.reply("❌ Could not read wallet label from this action.");
      return;
    }

    await sendWalletDetails(ctx, walletLabel);
  } catch (error) {
    logSafeError("Could not load wallet details", error);
    await ctx.reply("❌ Could not load wallet details.");
  }
});

bot.command("balance", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = parseCommandParts(ctx.message.text);
  const walletLabel = parts[1]?.trim();

  if (!walletLabel) {
    await ctx.reply(
      `Invalid format.

Use:
/balance wallet1
/balance wallet1 sepolia
/balance wallet1 mainnet`
    );
    return;
  }

  let network: SupportedBalanceNetwork;

  try {
    network = parseBalanceNetwork(parts[2]);
  } catch (error) {
    await ctx.reply(`❌ ${getSafeErrorMessage(error)}`);
    return;
  }

  try {
    await sendWalletBalance(ctx, walletLabel, network);
  } catch (error) {
    logSafeError("Could not check wallet balance", error);
    await ctx.reply(
      `❌ Could not check balance.

Reason:
${getSafeErrorMessage(error)}`
    );
  }
});

bot.action(/^wm:balance:([A-Za-z0-9_-]{2,32})$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  try {
    const walletLabel = ctx.match[1];

    if (!walletLabel) {
      await ctx.reply("❌ Could not read wallet label from this action.");
      return;
    }

    await sendWalletBalance(ctx, walletLabel, "sepolia");
  } catch (error) {
    logSafeError("Could not check wallet balance", error);
    await ctx.reply(`❌ Could not check balance.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.action(/^wm:nfts:([A-Za-z0-9_-]{2,32})$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();
  const walletLabel = ctx.match[1];

  if (!walletLabel) {
    await ctx.reply("❌ Could not read wallet label from this action.");
    return;
  }

  await ctx.reply(`Use:\n/nfts ${walletLabel}`);
});

bot.action(/^wm:portfolio:([A-Za-z0-9_-]{2,32})$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();
  const walletLabel = ctx.match[1];

  if (!walletLabel) {
    await ctx.reply("❌ Could not read wallet label from this action.");
    return;
  }

  await ctx.reply(`Use:\n/osportfolio ${walletLabel} 5`);
});

bot.command("renamewallet", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = parseCommandParts(ctx.message.text);
  const oldLabel = parts[1]?.trim();
  const newLabelRaw = parts[2]?.trim();

  if (!oldLabel || !newLabelRaw) {
    await ctx.reply(
      `Invalid format.

Use:
/renamewallet wallet1 mintwallet`
    );
    return;
  }

  const newLabel = normalizeWalletLabel(newLabelRaw);

  if (!isValidWalletLabel(newLabel)) {
    await ctx.reply(
      "❌ New wallet label must be 2-32 characters and use only letters, numbers, hyphen, or underscore."
    );
    return;
  }

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const oldWallet = await getWalletSummaryByLabelForOwner(
      oldLabel,
      ownerTelegramId,
      { includeArchived: true }
    );
    const renamed = await renameWalletForOwner(oldLabel, newLabel, ownerTelegramId);

    await auditWalletManagementAction({
      ownerTelegramId,
      action: "wallet_renamed",
      walletLabel: normalizeWalletLabel(oldLabel),
      newWalletLabel: renamed.label,
      walletAddress: renamed.address,
      encryptionVersion: renamed.encryptionVersion,
      status: renamed.status
    });

    await ctx.reply(
      `✅ Wallet renamed.

Old label: ${oldWallet.label}
New label: ${renamed.label}
Address: ${formatShortAddress(renamed.address)}`
    );
  } catch (error) {
    logSafeError("Could not rename wallet", error);
    await ctx.reply(`❌ Could not rename wallet.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.command("deletewallet", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = parseCommandParts(ctx.message.text);
  const walletLabel = parts[1]?.trim();

  if (!walletLabel) {
    await ctx.reply(
      `Invalid format.

Use:
/deletewallet wallet1`
    );
    return;
  }

  try {
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
    const wallet = await getWalletSummaryByLabelForOwner(
      walletLabel,
      ownerTelegramId,
      { includeArchived: true }
    );

    if (wallet.status === "archived") {
      await ctx.reply(`Wallet "${wallet.label}" is already archived.`);
      return;
    }

    const session = createWalletDeleteConfirmation({
      ownerTelegramId,
      walletLabel: wallet.label,
      walletAddress: wallet.address,
      encryptionVersion: wallet.encryptionVersion
    });

    await auditWalletDeleteConfirmation(
      session,
      "wallet_delete_requested",
      ownerTelegramId
    );

    await ctx.reply(
      `Are you sure you want to remove ${wallet.label}?
This will disable it inside the bot. It will not affect the wallet on-chain.

This confirmation expires in 10 minutes.`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "Confirm Remove",
            `wm:delete_confirm:${session.sessionId}`
          )
        ],
        [Markup.button.callback("Cancel", `wm:delete_cancel:${session.sessionId}`)]
      ])
    );
  } catch (error) {
    logSafeError("Could not request wallet deletion", error);
    await ctx.reply(`❌ Could not request wallet removal.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.action(/^wm:delete_confirm:([0-9a-f-]+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const sessionId = ctx.match[1];

  if (!sessionId) {
    await ctx.reply("This wallet removal confirmation has expired. Run /deletewallet again.");
    return;
  }

  const validated = await validateWalletDeleteConfirmation(ctx, sessionId);

  if (!validated) {
    return;
  }

  const { session, actorTelegramId } = validated;

  try {
    const archived = await archiveWalletForOwner(
      session.walletLabel,
      session.ownerTelegramId
    );

    session.status = "used";
    await auditWalletDeleteConfirmation(
      session,
      "wallet_delete_confirmed",
      actorTelegramId
    );

    await ctx.reply(
      `✅ Wallet archived.

Wallet: ${archived.label}
Address: ${formatShortAddress(archived.address)}
Status: ${formatWalletStatus(archived.status)}`
    );
  } catch (error) {
    logSafeError("Could not archive wallet", error);
    await ctx.reply(`❌ Could not archive wallet.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

bot.action(/^wm:delete_cancel:([0-9a-f-]+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const sessionId = ctx.match[1];

  if (!sessionId) {
    await ctx.reply("This wallet removal confirmation has expired. Run /deletewallet again.");
    return;
  }

  const validated = await validateWalletDeleteConfirmation(ctx, sessionId);

  if (!validated) {
    return;
  }

  const { session, actorTelegramId } = validated;
  session.status = "cancelled";

  await auditWalletDeleteConfirmation(
    session,
    "wallet_delete_cancelled",
    actorTelegramId
  );

  await ctx.reply(`Cancelled wallet removal for ${session.walletLabel}.`);
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
      getProvider(),
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
        mint.walletAddress.toLowerCase() === walletAddressLower &&
        (mint.ownerTelegramId === ownerTelegramId ||
          (!mint.ownerTelegramId &&
            mint.walletLabel.toLowerCase() === walletLabel))
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
      getProvider()
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
      getProvider(),
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
      getProvider(),
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
${getSafeErrorMessage(error)}`
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
Maker: ${getOfferMakerText(bestOffer)}
Expiration: ${getOfferExpirationText(bestOffer)}

Order Hash:
${bestOffer.orderHash}

Protocol:
${bestOffer.protocolAddress}

Trading Lock:
${getTradingLockStatusText()}

Use /postmint or /osportfolio to open owner-scoped NFT action sessions before accepting an offer.`
    );
  } catch (error: any) {
    logSafeError("Bot handler failed", error);

    await ctx.reply(
      `❌ Could not fetch top offer.

Reason:
${getSafeErrorMessage(error)}`
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
${getSafeErrorMessage(error)}`
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
    const ownerTelegramId = getRequiredTelegramUserId(ctx);

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
      ownerTelegramId,
      contractAddress,
      tokenId
    });

    if (!ownership.ownsToken) {
      await auditOpenSeaWalletAction({
        ownerTelegramId,
        action: "opensea_listing_blocked",
        walletLabel,
        walletAddress: ownership.walletAddress,
        contractAddress,
        tokenId,
        priceEth,
        reason: `wallet_not_token_owner:${ownership.owner}`
      });
      await ctx.reply(
        `❌ Listing preview blocked.

Wallet does not own this NFT.

Wallet: ${formatShortAddress(ownership.walletAddress)}
Owner Onchain: ${formatMaybeShortAddress(ownership.owner)}`
      );
      return;
    }

    await ctx.reply(
      `🏷 Listing Preview

Network: Ethereum Mainnet
Wallet: ${walletLabel}
Wallet Address: ${formatShortAddress(ownership.walletAddress)}
Contract: ${formatShortAddress(contractAddress)}
Token ID: ${tokenId}
Owner Onchain: ${formatMaybeShortAddress(ownership.owner)}
Wallet Owns Token: YES
Listing Price: ${priceEth} ETH

Trading Lock:
${getTradingLockStatusText()}

When ready, use:
/oslist ${walletLabel} ${contractAddress} ${tokenId} ${priceEth}`
    );

    await auditOpenSeaWalletAction({
      ownerTelegramId,
      action: "opensea_listing_previewed",
      walletLabel,
      walletAddress: ownership.walletAddress,
      contractAddress,
      tokenId,
      priceEth
    });
  } catch (error: any) {
    logSafeError("Bot handler failed", error);

    await ctx.reply(
      `❌ Listing preview failed.

Reason:
${getSafeErrorMessage(error)}`
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
    const ownerTelegramId = getRequiredTelegramUserId(ctx);

    await ctx.reply(
      `⚠️ Live OpenSea Listing Request

Wallet: ${walletLabel}
Contract: ${contractAddress}
Token ID: ${tokenId}
Price: ${priceEth} ETH

Checking ownership before any live action...`
    );

    const ownership = await checkErc721Ownership({
      walletLabel,
      ownerTelegramId,
      contractAddress,
      tokenId
    });

    if (!ownership.ownsToken) {
      await auditOpenSeaWalletAction({
        ownerTelegramId,
        action: "opensea_listing_blocked",
        walletLabel,
        walletAddress: ownership.walletAddress,
        contractAddress,
        tokenId,
        priceEth,
        reason: `wallet_not_token_owner:${ownership.owner}`
      });
      await ctx.reply(
        `❌ Listing cancelled.

Wallet does not own this NFT.

Wallet: ${formatShortAddress(ownership.walletAddress)}
Owner Onchain: ${formatMaybeShortAddress(ownership.owner)}`
      );
      return;
    }

    if (!isMainnetTradingEnabled()) {
      await auditOpenSeaWalletAction({
        ownerTelegramId,
        action: "opensea_listing_blocked",
        walletLabel,
        walletAddress: ownership.walletAddress,
        contractAddress,
        tokenId,
        priceEth,
        reason: "mainnet_trading_disabled"
      });
      await ctx.reply(MAINNET_TRADING_DISABLED_MESSAGE);
      return;
    }

    await ctx.reply(
      `🏷 Ownership confirmed. Submitting to OpenSea...

If OpenSea requires approval, the SDK may request or submit an approval transaction before the listing order is created.`
    );

    const result = await createOpenSeaListing({
      walletLabel,
      ownerTelegramId,
      contractAddress,
      tokenId,
      priceEth
    });

    const resultSummary = getOpenSeaResultSummary(result);
    const txHash = getOpenSeaResultTxHash(result) || undefined;

    await auditOpenSeaWalletAction({
      ownerTelegramId,
      action: "opensea_listing_confirmed",
      walletLabel,
      walletAddress: result.wallet,
      contractAddress,
      tokenId,
      priceEth,
      ...(txHash ? { txHash } : {}),
      reason: "submitted"
    });

    await ctx.reply(
      `✅ OpenSea listing created!

Wallet: ${result.wallet}
Contract: ${result.contractAddress}
Token ID: ${result.tokenId}
Price: ${result.priceEth} ETH

OpenSea result:
${resultSummary}`
    );
  } catch (error: any) {
    logSafeError("Bot handler failed", error);

    await ctx.reply(
      `❌ OpenSea listing failed.

Reason:
${getSafeErrorMessage(error)}

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
${getSafeErrorMessage(error)}`
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
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
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
      ownerTelegramId,
      contractAddress,
      tokenId
    });

    if (!ownership.ownsToken) {
      await auditOpenSeaWalletAction({
        ownerTelegramId,
        action: "opensea_listing_blocked",
        walletLabel,
        walletAddress: ownership.walletAddress,
        collectionSlug: slug,
        contractAddress,
        tokenId,
        priceEth: Number(stats.floorPrice),
        reason: `wallet_not_token_owner:${ownership.owner}`
      });
      await ctx.reply(
        `❌ Floor listing preview blocked.

Wallet does not own this NFT.

Wallet: ${formatShortAddress(ownership.walletAddress)}
Owner Onchain: ${formatMaybeShortAddress(ownership.owner)}`
      );
      return;
    }

    await ctx.reply(
      `🏷 Floor Listing Preview

Network: Ethereum Mainnet
Collection: ${slug}
Floor Price: ${stats.floorPrice} ${stats.floorSymbol || "ETH"}

Wallet: ${walletLabel}
Wallet Address: ${formatShortAddress(ownership.walletAddress)}
Contract: ${formatShortAddress(contractAddress)}
Token ID: ${tokenId}
Owner Onchain: ${formatMaybeShortAddress(ownership.owner)}
Wallet Owns Token: YES

Suggested Listing Price:
${stats.floorPrice} ETH

Trading Lock:
${getTradingLockStatusText()}

When ready, use:
/listfloor ${walletLabel} ${slug} ${contractAddress} ${tokenId}`
    );

    await auditOpenSeaWalletAction({
      ownerTelegramId,
      action: "opensea_listing_previewed",
      walletLabel,
      walletAddress: ownership.walletAddress,
      collectionSlug: slug,
      contractAddress,
      tokenId,
      priceEth: Number(stats.floorPrice)
    });
  } catch (error: any) {
    logSafeError("Bot handler failed", error);

    await ctx.reply(
      `❌ Floor listing preview failed.

Reason:
${getSafeErrorMessage(error)}`
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
    const ownerTelegramId = getRequiredTelegramUserId(ctx);
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
      ownerTelegramId,
      contractAddress,
      tokenId
    });

    if (!ownership.ownsToken) {
      await auditOpenSeaWalletAction({
        ownerTelegramId,
        action: "opensea_listing_blocked",
        walletLabel,
        walletAddress: ownership.walletAddress,
        collectionSlug: slug,
        contractAddress,
        tokenId,
        priceEth: Number(stats.floorPrice),
        reason: `wallet_not_token_owner:${ownership.owner}`
      });
      await ctx.reply(
        `❌ Listing cancelled.

Wallet does not own this NFT.

Wallet: ${formatShortAddress(ownership.walletAddress)}
Owner Onchain: ${formatMaybeShortAddress(ownership.owner)}`
      );
      return;
    }

    const priceEth = Number(stats.floorPrice);

    if (!isMainnetTradingEnabled()) {
      await auditOpenSeaWalletAction({
        ownerTelegramId,
        action: "opensea_listing_blocked",
        walletLabel,
        walletAddress: ownership.walletAddress,
        collectionSlug: slug,
        contractAddress,
        tokenId,
        priceEth,
        reason: "mainnet_trading_disabled"
      });
      await ctx.reply(MAINNET_TRADING_DISABLED_MESSAGE);
      return;
    }

    await ctx.reply(
      `✅ Ownership confirmed.

Submitting OpenSea listing at floor price:
${priceEth} ETH

If OpenSea requires approval, the SDK may request or submit an approval transaction before the listing order is created.`
    );

    const result = await createOpenSeaListing({
      walletLabel,
      ownerTelegramId,
      contractAddress,
      tokenId,
      priceEth
    });

    const resultSummary = getOpenSeaResultSummary(result);
    const txHash = getOpenSeaResultTxHash(result) || undefined;

    await auditOpenSeaWalletAction({
      ownerTelegramId,
      action: "opensea_listing_confirmed",
      walletLabel,
      walletAddress: result.wallet,
      collectionSlug: slug,
      contractAddress,
      tokenId,
      priceEth,
      ...(txHash ? { txHash } : {}),
      reason: "submitted"
    });

    await ctx.reply(
      `✅ OpenSea floor listing created!

Wallet: ${result.wallet}
Contract: ${result.contractAddress}
Token ID: ${result.tokenId}
Price: ${result.priceEth} ETH

OpenSea result:
${resultSummary}`
    );
  } catch (error: any) {
    logSafeError("Bot handler failed", error);

    await ctx.reply(
      `❌ Floor listing failed.

Reason:
${getSafeErrorMessage(error)}

Safety lock status:
${getTradingLockStatusText()}`
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
    const ownership = await checkErc721Ownership({
      walletLabel,
      ownerTelegramId,
      contractAddress,
      tokenId
    });

    if (!ownership.ownsToken) {
      await auditOpenSeaWalletAction({
        ownerTelegramId,
        action: "opensea_listing_blocked",
        walletLabel,
        walletAddress,
        collectionSlug,
        contractAddress,
        tokenId,
        reason: `wallet_not_token_owner:${ownership.owner}`
      });
      await ctx.reply(
        `❌ Could not open NFT actions.

Wallet does not own this NFT.

Wallet: ${formatShortAddress(walletAddress)}
Owner Onchain: ${formatMaybeShortAddress(ownership.owner)}`
      );
      return;
    }

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
${getSafeErrorMessage(error)}`
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

  const { action, actorTelegramId } = validated;

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
${getSafeErrorMessage(error)}`
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

  const { action, actorTelegramId } = validated;

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
${getSafeErrorMessage(error)}`
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

  const { action, actorTelegramId } = validated;

  try {
    await ctx.reply(
      `💰 Checking top offer...

Collection: ${action.collectionSlug}
Token ID: ${action.tokenId}`
    );

    const ownership = await blockOpenSeaActionIfNotOwner({
      ctx,
      action,
      actorTelegramId,
      auditAction: "opensea_top_offer_checked",
      blockedVerb: "check offers for this NFT"
    });

    if (!ownership) {
      return;
    }

    const bestOffer = await getOpenSeaBestOffer(
      action.collectionSlug,
      action.tokenId
    );

    if (!bestOffer.hasOffer) {
      await auditOpenSeaSessionAction(
        action,
        "opensea_top_offer_checked",
        actorTelegramId,
        { reason: "no_top_offer" }
      );
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
Wallet: ${action.walletLabel}
Wallet Address: ${formatShortAddress(ownership.walletAddress)}
Wallet Owns Token: YES
Offer: ${bestOffer.amount} ${bestOffer.symbol}
Maker: ${getOfferMakerText(bestOffer)}
Expiration: ${getOfferExpirationText(bestOffer)}

Order Hash:
${bestOffer.orderHash}

Trading Lock:
${getTradingLockStatusText()}

Use "Accept Top Offer" from the NFT action menu to preview the sale before any live action.`
    );

    await auditOpenSeaSessionAction(
      action,
      "opensea_top_offer_checked",
      actorTelegramId,
      { reason: "offer_found" }
    );
  } catch (error: any) {
    logSafeError("Bot handler failed", error);

    await ctx.reply(
      `❌ Could not fetch top offer.

Reason:
${getSafeErrorMessage(error)}`
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

  const { action, actorTelegramId } = validated;

  try {
    await ctx.reply(
      `🏷 Preparing list-at-floor preview...

Wallet: ${action.walletLabel}
Collection: ${action.collectionSlug}
Token ID: ${action.tokenId}`
    );

    const stats = await getOpenSeaCollectionStats(action.collectionSlug);

    if (stats.floorPrice === null) {
      await auditOpenSeaSessionAction(
        action,
        "opensea_listing_blocked",
        actorTelegramId,
        { reason: "floor_price_unavailable" }
      );
      await ctx.reply("❌ Could not detect collection floor price.");
      return;
    }

    const ownership = await blockOpenSeaActionIfNotOwner({
      ctx,
      action,
      actorTelegramId,
      auditAction: "opensea_listing_blocked",
      blockedVerb: "preview a listing for this NFT"
    });

    if (!ownership) {
      return;
    }

    await ctx.reply(
      `🏷 List at Floor Preview

Collection: ${action.collectionSlug}
Floor Price: ${stats.floorPrice} ${stats.floorSymbol || "ETH"}
Estimated/List Price: ${stats.floorPrice} ETH

Wallet: ${action.walletLabel}
Wallet Address: ${formatShortAddress(ownership.walletAddress)}
Contract: ${formatShortAddress(action.contractAddress)}
Token ID: ${action.tokenId}
Owner Onchain: ${formatMaybeShortAddress(ownership.owner)}
Wallet Owns Token: YES

Trading Lock:
${getTradingLockStatusText()}

No signing has happened yet.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Confirm List at Floor", `pm:floorconfirmpreview:${action.sessionId}`)],
        [Markup.button.callback("Cancel", `pm:cancel:${action.sessionId}`)]
      ])
    );

    await auditOpenSeaSessionAction(
      action,
      "opensea_listing_previewed",
      actorTelegramId,
      { priceEth: Number(stats.floorPrice) }
    );
  } catch (error: any) {
    logSafeError("Bot handler failed", error);

    await ctx.reply(
      `❌ List-at-floor preview failed.

Reason:
${getSafeErrorMessage(error)}`
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

  const { action, actorTelegramId } = validated;

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
      await auditOpenSeaSessionAction(
        action,
        "opensea_listing_blocked",
        actorTelegramId,
        { reason: "floor_price_unavailable" }
      );
      await ctx.reply("❌ Could not detect floor price. Listing cancelled.");
      return;
    }

    const ownership = await blockOpenSeaActionIfNotOwner({
      ctx,
      action,
      actorTelegramId,
      auditAction: "opensea_listing_blocked",
      blockedVerb: "list this NFT"
    });

    if (!ownership) {
      return;
    }

    await ctx.reply(
      `✅ Final Listing Confirmation

Network: Ethereum Mainnet
Collection: ${action.collectionSlug}
Wallet: ${action.walletLabel}
Wallet Address: ${formatShortAddress(ownership.walletAddress)}
Contract: ${formatShortAddress(action.contractAddress)}
Token ID: ${action.tokenId}

Current Floor Price:
${stats.floorPrice} ${stats.floorSymbol || "ETH"}

Trading Lock:
${getTradingLockStatusText()}

If live trading is disabled, the next button will NOT create a listing.`,
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
${getSafeErrorMessage(error)}`
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

  let action = validated.action;

  try {
    await ctx.reply(
      `🚨 Final command received.

Re-checking current floor price and wallet ownership before listing...`
    );

    const stats = await getOpenSeaCollectionStats(action.collectionSlug);

    if (stats.floorPrice === null) {
      await auditOpenSeaSessionAction(
        action,
        "opensea_listing_blocked",
        validated.actorTelegramId,
        { reason: "floor_price_unavailable" }
      );
      await ctx.reply("❌ Could not detect floor price. Listing cancelled.");
      return;
    }

    const ownership = await blockOpenSeaActionIfNotOwner({
      ctx,
      action,
      actorTelegramId: validated.actorTelegramId,
      auditAction: "opensea_listing_blocked",
      blockedVerb: "list this NFT"
    });

    if (!ownership) {
      return;
    }

    const priceEth = Number(stats.floorPrice);

    if (
      await blockOpenSeaActionIfTradingDisabled({
        ctx,
        action,
        actorTelegramId: validated.actorTelegramId,
        auditAction: "opensea_listing_blocked",
        priceEth
      })
    ) {
      return;
    }

    action = await markPostMintActionStatus(
      action,
      validated.actorTelegramId,
      "used",
      "final_action.confirmed",
      "floor-list-final"
    );

    await auditOpenSeaSessionAction(
      action,
      "opensea_listing_confirmed",
      validated.actorTelegramId,
      { priceEth }
    );

    await ctx.reply(
      `🏷 Submitting OpenSea listing...

Wallet: ${action.walletLabel}
Contract: ${action.contractAddress}
Token ID: ${action.tokenId}
Price: ${priceEth} ETH

If OpenSea requires approval, the SDK may request or submit an approval transaction before the listing order is created.`
    );

    const result = await createOpenSeaListing({
      walletLabel: action.walletLabel,
      ownerTelegramId: action.ownerTelegramId,
      contractAddress: action.contractAddress,
      tokenId: action.tokenId,
      priceEth
    });

    const resultSummary = getOpenSeaResultSummary(result);
    const txHash = getOpenSeaResultTxHash(result) || undefined;

    await auditOpenSeaSessionAction(
      action,
      "opensea_listing_confirmed",
      validated.actorTelegramId,
      {
        priceEth,
        ...(txHash ? { txHash } : {}),
        reason: "submitted"
      }
    );

    await ctx.reply(
      `✅ OpenSea listing created!

Wallet: ${result.wallet}
Contract: ${result.contractAddress}
Token ID: ${result.tokenId}
Price: ${result.priceEth} ETH

OpenSea result:
${resultSummary}`
    );
  } catch (error: any) {
    logSafeError("Bot handler failed", error);
    await auditOpenSeaSessionAction(
      action,
      "opensea_action_failed",
      validated.actorTelegramId,
      { reason: getSafeErrorMessage(error) }
    );

    await ctx.reply(
      `❌ Live floor listing failed.

Reason:
${getSafeErrorMessage(error)}

Safety lock status:
${getTradingLockStatusText()}`
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

    const ownership = await blockOpenSeaActionIfNotOwner({
      ctx,
      action,
      actorTelegramId: validated.actorTelegramId,
      auditAction: "opensea_listing_blocked",
      blockedVerb: "preview a custom listing for this NFT"
    });

    if (!ownership) {
      return;
    }

    await ctx.reply(
      `✅ Custom Listing Confirmation

Network: Ethereum Mainnet
Collection: ${action.collectionSlug}
Wallet: ${action.walletLabel}
Wallet Address: ${formatShortAddress(ownership.walletAddress)}
Contract: ${formatShortAddress(action.contractAddress)}
Token ID: ${action.tokenId}

Listing Price:
${priceEth} ETH

Trading Lock:
${getTradingLockStatusText()}

No signing has happened yet. If live trading is disabled, the confirm button will NOT create a listing.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🚨 Confirm Custom Listing", `pm:customlistfinal:${sessionId}`)],
        [Markup.button.callback("❌ Cancel", `pm:cancel:${sessionId}`)]
      ])
    );

    await auditOpenSeaSessionAction(
      action,
      "opensea_custom_listing_previewed",
      validated.actorTelegramId,
      { priceEth }
    );
  } catch (error: any) {
    logSafeError("Bot handler failed", error);

    await ctx.reply(
      `❌ Custom listing confirmation failed.

Reason:
${getSafeErrorMessage(error)}`
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
    await auditOpenSeaSessionAction(
      validated.action,
      "opensea_listing_blocked",
      validated.actorTelegramId,
      { reason: "invalid_custom_price" }
    );
    await ctx.reply("❌ Invalid custom listing price. Please open the custom listing preview again.");
    return;
  }

  let action = validated.action;

  try {
    await ctx.reply(
      `🚨 Final custom listing command received.

Re-checking ownership before submitting...`
    );

    const ownership = await blockOpenSeaActionIfNotOwner({
      ctx,
      action,
      actorTelegramId: validated.actorTelegramId,
      auditAction: "opensea_listing_blocked",
      blockedVerb: "list this NFT"
    });

    if (!ownership) {
      return;
    }

    if (
      await blockOpenSeaActionIfTradingDisabled({
        ctx,
        action,
        actorTelegramId: validated.actorTelegramId,
        auditAction: "opensea_listing_blocked",
        priceEth
      })
    ) {
      return;
    }

    action = await markPostMintActionStatus(
      action,
      validated.actorTelegramId,
      "used",
      "final_action.confirmed",
      "custom-list-final"
    );

    await auditOpenSeaSessionAction(
      action,
      "opensea_listing_confirmed",
      validated.actorTelegramId,
      { priceEth }
    );

    await ctx.reply(
      `🏷 Submitting custom OpenSea listing...

Wallet: ${action.walletLabel}
Contract: ${action.contractAddress}
Token ID: ${action.tokenId}
Price: ${priceEth} ETH

If OpenSea requires approval, the SDK may request or submit an approval transaction before the listing order is created.`
    );

    const result = await createOpenSeaListing({
      walletLabel: action.walletLabel,
      ownerTelegramId: action.ownerTelegramId,
      contractAddress: action.contractAddress,
      tokenId: action.tokenId,
      priceEth
    });

    const resultSummary = getOpenSeaResultSummary(result);
    const txHash = getOpenSeaResultTxHash(result) || undefined;

    await auditOpenSeaSessionAction(
      action,
      "opensea_listing_confirmed",
      validated.actorTelegramId,
      {
        priceEth,
        ...(txHash ? { txHash } : {}),
        reason: "submitted"
      }
    );

    await ctx.reply(
      `✅ Custom OpenSea listing created!

Wallet: ${result.wallet}
Contract: ${result.contractAddress}
Token ID: ${result.tokenId}
Price: ${result.priceEth} ETH

OpenSea result:
${resultSummary}`
    );
  } catch (error: any) {
    logSafeError("Bot handler failed", error);
    await auditOpenSeaSessionAction(
      action,
      "opensea_action_failed",
      validated.actorTelegramId,
      { reason: getSafeErrorMessage(error) }
    );

    await ctx.reply(
      `❌ Custom listing failed.

Reason:
${getSafeErrorMessage(error)}

Safety lock status:
${getTradingLockStatusText()}`
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

  const { action, actorTelegramId } = validated;

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
      await auditOpenSeaSessionAction(
        action,
        "opensea_accept_offer_blocked",
        actorTelegramId,
        { reason: "no_top_offer" }
      );
      await ctx.reply(
        `❌ No top offer found.

Collection: ${action.collectionSlug}
Token ID: ${action.tokenId}`
      );
      return;
    }

    const ownership = await blockOpenSeaActionIfNotOwner({
      ctx,
      action,
      actorTelegramId,
      auditAction: "opensea_accept_offer_blocked",
      blockedVerb: "accept an offer for this NFT"
    });

    if (!ownership) {
      return;
    }

    await ctx.reply(
      `⚠️ Accept Top Offer Confirmation

Network: Ethereum Mainnet
Collection: ${action.collectionSlug}
Wallet: ${action.walletLabel}
Wallet Address: ${formatShortAddress(ownership.walletAddress)}
Contract: ${formatShortAddress(action.contractAddress)}
Token ID: ${action.tokenId}
Wallet Owns Token: YES

Top Offer:
${bestOffer.amount} ${bestOffer.symbol}
Maker: ${getOfferMakerText(bestOffer)}
Expiration: ${getOfferExpirationText(bestOffer)}

Order Hash:
${bestOffer.orderHash}

Trading Lock:
${getTradingLockStatusText()}

No signing has happened yet. If you confirm, this will sell the NFT for the top offer only when live trading is enabled.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🚨 Confirm Accept Top Offer", `pm:acceptofferfinal:${action.sessionId}`)],
        [Markup.button.callback("❌ Cancel", `pm:cancel:${action.sessionId}`)]
      ])
    );

    await auditOpenSeaSessionAction(
      action,
      "opensea_accept_offer_previewed",
      actorTelegramId,
      { reason: "offer_found" }
    );
  } catch (error: any) {
    logSafeError("Bot handler failed", error);

    await ctx.reply(
      `❌ Accept-offer preview failed.

Reason:
${getSafeErrorMessage(error)}`
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

  let action = validated.action;

  try {
    await ctx.reply(
      `🚨 Final accept-offer command received.

Re-checking ownership and latest top offer before submitting...`
    );

    const ownership = await blockOpenSeaActionIfNotOwner({
      ctx,
      action,
      actorTelegramId: validated.actorTelegramId,
      auditAction: "opensea_accept_offer_blocked",
      blockedVerb: "accept an offer for this NFT"
    });

    if (!ownership) {
      return;
    }

    if (
      await blockOpenSeaActionIfTradingDisabled({
        ctx,
        action,
        actorTelegramId: validated.actorTelegramId,
        auditAction: "opensea_accept_offer_blocked"
      })
    ) {
      return;
    }

    action = await markPostMintActionStatus(
      action,
      validated.actorTelegramId,
      "used",
      "final_action.confirmed",
      "accept-offer-final"
    );

    await auditOpenSeaSessionAction(
      action,
      "opensea_accept_offer_confirmed",
      validated.actorTelegramId
    );

    const result = await acceptOpenSeaBestOffer({
      walletLabel: action.walletLabel,
      ownerTelegramId: action.ownerTelegramId,
      collectionSlug: action.collectionSlug,
      contractAddress: action.contractAddress,
      tokenId: action.tokenId
    });

    const resultSummary = getOpenSeaResultSummary(result);
    const txHash = getOpenSeaResultTxHash(result) || undefined;

    await auditOpenSeaSessionAction(
      action,
      "opensea_accept_offer_confirmed",
      validated.actorTelegramId,
      {
        ...(txHash ? { txHash } : {}),
        reason: "submitted"
      }
    );

    await ctx.reply(
      `✅ Top offer accepted!

Wallet: ${result.wallet}
Collection: ${result.collectionSlug}
Contract: ${result.contractAddress}
Token ID: ${result.tokenId}
Offer: ${result.offerAmount} ${result.offerSymbol}

Order Hash:
${result.orderHash}

OpenSea result:
${resultSummary}`
    );
  } catch (error: any) {
    logSafeError("Bot handler failed", error);
    await auditOpenSeaSessionAction(
      action,
      "opensea_action_failed",
      validated.actorTelegramId,
      { reason: getSafeErrorMessage(error) }
    );

    await ctx.reply(
      `❌ Accept top offer failed.

Reason:
${getSafeErrorMessage(error)}

Safety lock status:
${getTradingLockStatusText()}`
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
${getSafeErrorMessage(error)}`
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

bot.on("text", async (ctx) => {
  if (ctx.chat?.type !== "private") {
    return;
  }

  if (await handleOpenSeaQuickMintText(ctx)) {
    return;
  }

  if (await handleMintFlowTargetDraftText(ctx)) {
    return;
  }

  const input = getDirectMintLinkInput(ctx.message.text);

  if (!input) {
    return;
  }

  if (!(await requireAdmin(ctx))) return;

  try {
    if (input.includes("opensea.io")) {
      await startOpenSeaQuickMintFromLink(ctx, input);
      return;
    }

    await replyWithMintDetection(ctx, input, "direct_link_auto_parser");
  } catch (error) {
    logSafeError("Could not auto-parse mint link", error);
    await ctx.reply(`❌ Could not parse mint link.\n\nReason:\n${getSafeErrorMessage(error)}`);
  }
});

async function startBot() {
  if (shouldRegisterTelegramCommands()) {
    await registerTelegramCommandMenu();
  }

  const launchPromise = bot.launch();

  launchPromise.catch((error) => {
    logSafeError("Bot launch failed", error);
    process.exit(1);
  });

  console.log("Bot is running...");
  console.log("Admin lock + NFT mint module loaded.");
  startMintScheduler();

  if (!shouldRegisterTelegramCommands()) {
    console.log(
      "Telegram command menu registration skipped. Manage slash commands through BotFather, or set REGISTER_TELEGRAM_COMMANDS=true to enable startup registration."
    );
  }
}

startBot().catch((error) => {
  logSafeError("Bot startup failed", error);
  process.exit(1);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
