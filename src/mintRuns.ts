import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type {
  MintChain,
  SupportedMintFunctionSignature
} from "./mintEngine.js";

export type MintRunStatus =
  | "previewed"
  | "pending"
  | "submitted"
  | "confirmed"
  | "failed"
  | "blocked"
  | "cancelled";

export type MintRun = {
  runId: string;
  ownerTelegramId: string;
  targetId?: string;
  jobId?: string;
  walletLabel: string;
  walletAddress: string;
  chain: MintChain;
  contractAddress: string;
  functionSignature: SupportedMintFunctionSignature;
  quantity: number;
  priceEth: string;
  txHash?: string;
  status: MintRunStatus;
  errorReason?: string;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
};

type MintRunsFile = {
  runs: MintRun[];
};

type CreateMintRunParams = {
  ownerTelegramId: string;
  targetId?: string;
  jobId?: string;
  walletLabel: string;
  walletAddress: string;
  chain: MintChain;
  contractAddress: string;
  functionSignature: SupportedMintFunctionSignature;
  quantity: number;
  priceEth: string;
  txHash?: string;
  status: MintRunStatus;
  errorReason?: string;
};

type UpdateMintRunParams = Partial<{
  txHash: string;
  status: MintRunStatus;
  errorReason: string;
  confirmedAt: string;
  jobId: string;
}>;

const MINT_RUNS_PATH = path.join(process.cwd(), "data", "mintRuns.json");
const SUPPORTED_STORED_MINT_SIGNATURES: SupportedMintFunctionSignature[] = [
  "mint(uint256)",
  "publicMint(uint256)",
  "mintPublic(uint256)",
  "mintTo(address,uint256)",
  "publicMint(address,uint256)"
];

function isMintRunStatus(value: unknown): value is MintRunStatus {
  return (
    value === "previewed" ||
    value === "pending" ||
    value === "submitted" ||
    value === "confirmed" ||
    value === "failed" ||
    value === "blocked" ||
    value === "cancelled"
  );
}

function isSupportedStoredMintFunctionSignature(
  value: unknown
): value is SupportedMintFunctionSignature {
  return SUPPORTED_STORED_MINT_SIGNATURES.includes(
    value as SupportedMintFunctionSignature
  );
}

function normalizeStoredMintRun(raw: any): MintRun | null {
  if (
    typeof raw?.runId !== "string" ||
    typeof raw?.ownerTelegramId !== "string" ||
    typeof raw?.walletLabel !== "string" ||
    typeof raw?.walletAddress !== "string" ||
    typeof raw?.chain !== "string" ||
    typeof raw?.contractAddress !== "string" ||
    typeof raw?.functionSignature !== "string" ||
    typeof raw?.priceEth !== "string"
  ) {
    return null;
  }

  const quantity = Number(raw.quantity);

  if (!Number.isInteger(quantity) || quantity <= 0) {
    return null;
  }

  if (!isSupportedStoredMintFunctionSignature(raw.functionSignature)) {
    return null;
  }

  const createdAt =
    typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString();
  const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : createdAt;

  return {
    runId: raw.runId,
    ownerTelegramId: raw.ownerTelegramId,
    ...(typeof raw.targetId === "string" ? { targetId: raw.targetId } : {}),
    ...(typeof raw.jobId === "string" ? { jobId: raw.jobId } : {}),
    walletLabel: raw.walletLabel,
    walletAddress: raw.walletAddress,
    chain: raw.chain === "sepolia" ? "sepolia" : "mainnet",
    contractAddress: raw.contractAddress,
    functionSignature: raw.functionSignature,
    quantity,
    priceEth: raw.priceEth,
    ...(typeof raw.txHash === "string" ? { txHash: raw.txHash } : {}),
    status: isMintRunStatus(raw.status) ? raw.status : "pending",
    ...(typeof raw.errorReason === "string"
      ? { errorReason: raw.errorReason }
      : {}),
    createdAt,
    updatedAt,
    ...(typeof raw.confirmedAt === "string"
      ? { confirmedAt: raw.confirmedAt }
      : {})
  };
}

function writeMintRuns(runs: MintRun[]) {
  const dir = path.dirname(MINT_RUNS_PATH);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(
    MINT_RUNS_PATH,
    JSON.stringify({ runs }, null, 2),
    "utf8"
  );
}

function loadMintRunsFile(): MintRunsFile {
  if (!fs.existsSync(MINT_RUNS_PATH)) {
    return { runs: [] };
  }

  const raw = fs.readFileSync(MINT_RUNS_PATH, "utf8");

  if (!raw.trim()) {
    return { runs: [] };
  }

  const parsed = JSON.parse(raw);
  const rawRuns: any[] = Array.isArray(parsed.runs) ? parsed.runs : [];
  const runs = rawRuns
    .map(normalizeStoredMintRun)
    .filter((run): run is MintRun => Boolean(run));

  if (runs.length !== rawRuns.length) {
    writeMintRuns(runs);
  }

  return { runs };
}

export function createMintRun(params: CreateMintRunParams): MintRun {
  const file = loadMintRunsFile();
  const now = new Date().toISOString();
  const run: MintRun = {
    runId: randomUUID(),
    ownerTelegramId: params.ownerTelegramId,
    ...(params.targetId ? { targetId: params.targetId } : {}),
    ...(params.jobId ? { jobId: params.jobId } : {}),
    walletLabel: params.walletLabel,
    walletAddress: params.walletAddress,
    chain: params.chain,
    contractAddress: params.contractAddress,
    functionSignature: params.functionSignature,
    quantity: params.quantity,
    priceEth: params.priceEth,
    ...(params.txHash ? { txHash: params.txHash } : {}),
    status: params.status,
    ...(params.errorReason ? { errorReason: params.errorReason } : {}),
    createdAt: now,
    updatedAt: now
  };

  file.runs.push(run);
  writeMintRuns(file.runs);
  return run;
}

export function updateMintRunForOwner(
  runId: string,
  ownerTelegramId: string,
  updates: UpdateMintRunParams
) {
  const file = loadMintRunsFile();
  const run = file.runs.find(
    (savedRun) =>
      savedRun.runId === runId && savedRun.ownerTelegramId === ownerTelegramId
  );

  if (!run) {
    throw new Error("Mint run not found for this Telegram user.");
  }

  if (updates.status) {
    run.status = updates.status;
  }

  if (updates.txHash) {
    run.txHash = updates.txHash;
  }

  if (updates.errorReason) {
    run.errorReason = updates.errorReason;
  }

  if (updates.confirmedAt) {
    run.confirmedAt = updates.confirmedAt;
  }

  if (updates.jobId) {
    run.jobId = updates.jobId;
  }

  run.updatedAt = new Date().toISOString();
  writeMintRuns(file.runs);
  return run;
}

export function listMintRunsForOwner(ownerTelegramId: string, limit = 10) {
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 50);

  return loadMintRunsFile()
    .runs.filter((run) => run.ownerTelegramId === ownerTelegramId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, safeLimit);
}

export function getMintRunForOwner(runId: string, ownerTelegramId: string) {
  const run = loadMintRunsFile().runs.find(
    (savedRun) =>
      savedRun.runId === runId && savedRun.ownerTelegramId === ownerTelegramId
  );

  if (!run) {
    throw new Error("Mint run not found for this Telegram user.");
  }

  return run;
}
