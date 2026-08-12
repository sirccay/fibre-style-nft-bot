import path from "path";
import { randomUUID } from "crypto";
import type {
  MintChain,
  SupportedMintFunctionSignature
} from "./mintEngine.js";
import {
  loadJsonFile,
  saveJsonFileAtomic,
  updateJsonFileSync
} from "./jsonStore.js";

export type MintJobMintType =
  | "manual"
  | "team"
  | "holder"
  | "gtd"
  | "fcfs"
  | "public";

export type MintJobStatus =
  | "scheduled"
  | "watching"
  | "ready"
  | "submitted"
  | "confirmed"
  | "failed"
  | "cancelled"
  | "expired"
  | "blocked";

export type MintJobMode = "watch" | "auto";

export type MintJob = {
  jobId: string;
  ownerTelegramId: string;
  targetId: string;
  targetName: string;
  walletLabel: string;
  walletAddress: string;
  chain: MintChain;
  contractAddress: string;
  functionSignature: SupportedMintFunctionSignature;
  quantity: number;
  priceEth: string;
  mintType: MintJobMintType;
  phaseTypeEstimate?: string;
  startTimeISO: string;
  endTimeISO?: string;
  status: MintJobStatus;
  mode: MintJobMode;
  autoSubmit: boolean;
  maxRetries: number;
  retryDelayMs: number;
  attempts: number;
  lastCheckedAt?: string;
  lastRunId?: string;
  txHash?: string;
  safeErrorReason?: string;
  createdAt: string;
  updatedAt: string;
};

type MintJobsFile = {
  jobs: MintJob[];
};

type CreateMintJobParams = {
  ownerTelegramId: string;
  targetId: string;
  targetName: string;
  walletLabel: string;
  walletAddress: string;
  chain: MintChain;
  contractAddress: string;
  functionSignature: SupportedMintFunctionSignature;
  quantity: number;
  priceEth: string;
  mintType: MintJobMintType;
  phaseTypeEstimate?: string;
  startTimeISO: string;
  endTimeISO?: string;
  mode: MintJobMode;
  maxRetries?: number;
  retryDelayMs?: number;
};

type UpdateMintJobParams = Partial<{
  status: MintJobStatus;
  attempts: number;
  lastCheckedAt: string;
  lastRunId: string;
  txHash: string;
  safeErrorReason: string;
  endTimeISO: string;
}>;

const MINT_JOBS_PATH = path.join(process.cwd(), "data", "mintJobs.json");
const EMPTY_MINT_JOBS_FILE: MintJobsFile = { jobs: [] };
const MAX_MINT_JOB_RETRIES = 5;
const SUPPORTED_STORED_MINT_SIGNATURES: SupportedMintFunctionSignature[] = [
  "mint(uint256)",
  "publicMint(uint256)",
  "mintPublic(uint256)",
  "mintTo(address,uint256)",
  "publicMint(address,uint256)"
];

export const MINT_TYPE_DEFAULTS: Record<
  MintJobMintType,
  { maxRetries: number; retryDelayMs: number }
> = {
  manual: { maxRetries: 0, retryDelayMs: 3_000 },
  team: { maxRetries: 1, retryDelayMs: 3_000 },
  holder: { maxRetries: 2, retryDelayMs: 3_000 },
  gtd: { maxRetries: 2, retryDelayMs: 3_000 },
  fcfs: { maxRetries: 3, retryDelayMs: 1_000 },
  public: { maxRetries: 2, retryDelayMs: 2_000 }
};

export function isMintJobMintType(value: unknown): value is MintJobMintType {
  return (
    value === "manual" ||
    value === "team" ||
    value === "holder" ||
    value === "gtd" ||
    value === "fcfs" ||
    value === "public"
  );
}

export function normalizeMintJobMintType(rawValue?: string): MintJobMintType {
  const normalized = rawValue?.trim().toLowerCase();

  if (isMintJobMintType(normalized)) {
    return normalized;
  }

  throw new Error("Mint type must be manual, team, holder, gtd, fcfs, or public.");
}

export function getMintTypeDefaults(mintType: MintJobMintType) {
  return MINT_TYPE_DEFAULTS[mintType];
}

export function clampMintJobRetries(value: unknown) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return Math.min(Math.floor(parsed), MAX_MINT_JOB_RETRIES);
}

function isMintJobStatus(value: unknown): value is MintJobStatus {
  return (
    value === "scheduled" ||
    value === "watching" ||
    value === "ready" ||
    value === "submitted" ||
    value === "confirmed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "expired" ||
    value === "blocked"
  );
}

function isMintJobMode(value: unknown): value is MintJobMode {
  return value === "watch" || value === "auto";
}

function isSupportedStoredMintFunctionSignature(
  value: unknown
): value is SupportedMintFunctionSignature {
  return SUPPORTED_STORED_MINT_SIGNATURES.includes(
    value as SupportedMintFunctionSignature
  );
}

function normalizePositiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeIsoDate(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function normalizeStoredMintJob(raw: any): MintJob | null {
  if (
    typeof raw?.jobId !== "string" ||
    typeof raw?.ownerTelegramId !== "string" ||
    typeof raw?.targetId !== "string" ||
    typeof raw?.targetName !== "string" ||
    typeof raw?.walletLabel !== "string" ||
    typeof raw?.walletAddress !== "string" ||
    typeof raw?.chain !== "string" ||
    typeof raw?.contractAddress !== "string" ||
    typeof raw?.functionSignature !== "string" ||
    typeof raw?.priceEth !== "string"
  ) {
    return null;
  }

  if (!isSupportedStoredMintFunctionSignature(raw.functionSignature)) {
    return null;
  }

  const quantity = normalizePositiveInteger(raw.quantity);
  const startTimeISO = normalizeIsoDate(raw.startTimeISO);

  if (!quantity || !startTimeISO) {
    return null;
  }

  const mintType = isMintJobMintType(raw.mintType) ? raw.mintType : "manual";
  const mode = isMintJobMode(raw.mode) ? raw.mode : "watch";
  const defaults = getMintTypeDefaults(mintType);
  const createdAt =
    typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString();
  const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : createdAt;
  const lastCheckedAt = normalizeIsoDate(raw.lastCheckedAt);
  const endTimeISO = normalizeIsoDate(raw.endTimeISO);
  const attempts = Math.max(0, Math.floor(Number(raw.attempts || 0)));

  return {
    jobId: raw.jobId,
    ownerTelegramId: raw.ownerTelegramId,
    targetId: raw.targetId,
    targetName: raw.targetName,
    walletLabel: raw.walletLabel,
    walletAddress: raw.walletAddress,
    chain: raw.chain === "sepolia" ? "sepolia" : raw.chain === "robinhood" ? "robinhood" : "mainnet",
    contractAddress: raw.contractAddress,
    functionSignature: raw.functionSignature,
    quantity,
    priceEth: raw.priceEth,
    mintType,
    ...(typeof raw.phaseTypeEstimate === "string"
      ? { phaseTypeEstimate: raw.phaseTypeEstimate }
      : {}),
    startTimeISO,
    ...(endTimeISO ? { endTimeISO } : {}),
    status: isMintJobStatus(raw.status) ? raw.status : "scheduled",
    mode,
    autoSubmit: mode === "auto" && raw.autoSubmit !== false,
    maxRetries: clampMintJobRetries(raw.maxRetries ?? defaults.maxRetries),
    retryDelayMs: Math.max(0, Math.floor(Number(raw.retryDelayMs ?? defaults.retryDelayMs))),
    attempts,
    ...(lastCheckedAt ? { lastCheckedAt } : {}),
    ...(typeof raw.lastRunId === "string" ? { lastRunId: raw.lastRunId } : {}),
    ...(typeof raw.txHash === "string" ? { txHash: raw.txHash } : {}),
    ...(typeof raw.safeErrorReason === "string"
      ? { safeErrorReason: raw.safeErrorReason.slice(0, 300) }
      : {}),
    createdAt,
    updatedAt
  };
}

function normalizeMintJobsFile(parsed: MintJobsFile): MintJobsFile {
  const rawJobs: any[] = Array.isArray(parsed.jobs) ? parsed.jobs : [];
  const jobs = rawJobs
    .map(normalizeStoredMintJob)
    .filter((job): job is MintJob => Boolean(job));

  return { jobs };
}

function writeMintJobs(jobs: MintJob[]) {
  saveJsonFileAtomic(MINT_JOBS_PATH, { jobs });
}

function loadMintJobsFile(): MintJobsFile {
  const parsed = loadJsonFile<MintJobsFile>(
    MINT_JOBS_PATH,
    EMPTY_MINT_JOBS_FILE
  );
  const file = normalizeMintJobsFile(parsed);

  if (file.jobs.length !== (Array.isArray(parsed.jobs) ? parsed.jobs.length : 0)) {
    writeMintJobs(file.jobs);
  }

  return file;
}

export function createMintJob(params: CreateMintJobParams): MintJob {
  const now = new Date().toISOString();
  const defaults = getMintTypeDefaults(params.mintType);
  const maxRetries = clampMintJobRetries(params.maxRetries ?? defaults.maxRetries);
  const retryDelayMs = Math.max(
    0,
    Math.floor(Number(params.retryDelayMs ?? defaults.retryDelayMs))
  );
  const job: MintJob = {
    jobId: randomUUID(),
    ownerTelegramId: params.ownerTelegramId,
    targetId: params.targetId,
    targetName: params.targetName,
    walletLabel: params.walletLabel,
    walletAddress: params.walletAddress,
    chain: params.chain,
    contractAddress: params.contractAddress,
    functionSignature: params.functionSignature,
    quantity: params.quantity,
    priceEth: params.priceEth,
    mintType: params.mintType,
    ...(params.phaseTypeEstimate ? { phaseTypeEstimate: params.phaseTypeEstimate } : {}),
    startTimeISO: params.startTimeISO,
    ...(params.endTimeISO ? { endTimeISO: params.endTimeISO } : {}),
    status: "scheduled",
    mode: params.mode,
    autoSubmit: params.mode === "auto",
    maxRetries,
    retryDelayMs,
    attempts: 0,
    createdAt: now,
    updatedAt: now
  };

  updateJsonFileSync<MintJobsFile>(
    MINT_JOBS_PATH,
    EMPTY_MINT_JOBS_FILE,
    (current) => {
      const file = normalizeMintJobsFile(current);
      file.jobs.push(job);
      return file;
    }
  );
  return job;
}

export function listMintJobsForOwner(ownerTelegramId: string) {
  return loadMintJobsFile()
    .jobs.filter((job) => job.ownerTelegramId === ownerTelegramId)
    .sort((a, b) => Date.parse(a.startTimeISO) - Date.parse(b.startTimeISO));
}

export function listActiveMintJobsForOwner(ownerTelegramId: string) {
  return listMintJobsForOwner(ownerTelegramId).filter((job) =>
    ["scheduled", "watching", "ready"].includes(job.status)
  );
}

export function listResumableMintJobs() {
  return loadMintJobsFile().jobs.filter((job) =>
    ["scheduled", "watching", "ready"].includes(job.status)
  );
}

export function getMintJobForOwner(jobId: string, ownerTelegramId: string) {
  const job = loadMintJobsFile().jobs.find(
    (savedJob) =>
      savedJob.jobId === jobId && savedJob.ownerTelegramId === ownerTelegramId
  );

  if (!job) {
    throw new Error("Mint job not found for this Telegram user.");
  }

  return job;
}

export function updateMintJobForOwner(
  jobId: string,
  ownerTelegramId: string,
  updates: UpdateMintJobParams
) {
  let updatedJob: MintJob | undefined;

  updateJsonFileSync<MintJobsFile>(
    MINT_JOBS_PATH,
    EMPTY_MINT_JOBS_FILE,
    (current) => {
      const file = normalizeMintJobsFile(current);
      const job = file.jobs.find(
        (savedJob) =>
          savedJob.jobId === jobId && savedJob.ownerTelegramId === ownerTelegramId
      );

      if (!job) {
        throw new Error("Mint job not found for this Telegram user.");
      }

      if (updates.status) {
        job.status = updates.status;
      }

      if (updates.attempts !== undefined) {
        job.attempts = Math.max(0, Math.floor(updates.attempts));
      }

      if (updates.lastCheckedAt) {
        job.lastCheckedAt = updates.lastCheckedAt;
      }

      if (updates.lastRunId) {
        job.lastRunId = updates.lastRunId;
      }

      if (updates.txHash) {
        job.txHash = updates.txHash;
      }

      if (updates.safeErrorReason) {
        job.safeErrorReason = updates.safeErrorReason.slice(0, 300);
      }

      if (updates.endTimeISO) {
        job.endTimeISO = updates.endTimeISO;
      }

      job.updatedAt = new Date().toISOString();
      updatedJob = job;
      return file;
    }
  );

  return updatedJob!;
}

export function updateMintJobStatus(
  jobId: string,
  ownerTelegramId: string,
  status: MintJobStatus,
  safeErrorReason?: string
) {
  return updateMintJobForOwner(jobId, ownerTelegramId, {
    status,
    ...(safeErrorReason ? { safeErrorReason } : {})
  });
}
