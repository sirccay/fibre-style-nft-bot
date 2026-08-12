import path from "path";
import { randomUUID } from "crypto";
import type {
  MintChain,
  SupportedMintFunctionSignature
} from "./mintEngine.js";
import {
  createDefaultGasStrategy,
  normalizeGasStrategy
} from "./gasStrategy.js";
import type { GasStrategy } from "./gasStrategy.js";
import type { MintJobMode } from "./mintJobs.js";
import {
  loadJsonFile,
  saveJsonFileAtomic,
  updateJsonFileSync
} from "./jsonStore.js";

export type MultiMintJobStatus =
  | "scheduled"
  | "watching"
  | "ready"
  | "submitted"
  | "confirmed"
  | "partial"
  | "failed"
  | "cancelled"
  | "expired"
  | "blocked";

export type MultiMintChildStatus =
  | "pending"
  | "ready"
  | "submitted"
  | "confirmed"
  | "failed"
  | "blocked";

export type MultiMintChildResult = {
  walletLabel: string;
  walletAddress: string;
  status: MultiMintChildStatus;
  runId?: string;
  txHash?: string;
  safeErrorReason?: string;
  attempts: number;
  updatedAt: string;
};

export type MultiMintJob = {
  jobId: string;
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
  mode: MintJobMode;
  status: MultiMintJobStatus;
  startTimeISO: string;
  endTimeISO?: string;
  childResults: MultiMintChildResult[];
  maxRetries: number;
  retryDelayMs: number;
  attempts: number;
  lastCheckedAt?: string;
  safeErrorReason?: string;
  createdAt: string;
  updatedAt: string;
};

type MultiMintJobsFile = {
  jobs: MultiMintJob[];
};

type CreateMultiMintJobParams = {
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
  gasStrategy?: GasStrategy;
  mode: MintJobMode;
  startTimeISO: string;
  endTimeISO?: string;
  maxRetries: number;
  retryDelayMs: number;
};

type UpdateMultiMintJobParams = Partial<{
  status: MultiMintJobStatus;
  attempts: number;
  lastCheckedAt: string;
  safeErrorReason: string;
  endTimeISO: string;
  childResults: MultiMintChildResult[];
}>;

const MULTI_MINT_JOBS_PATH = path.join(process.cwd(), "data", "multiMintJobs.json");
const EMPTY_MULTI_MINT_JOBS_FILE: MultiMintJobsFile = { jobs: [] };
const SUPPORTED_STORED_MINT_SIGNATURES: SupportedMintFunctionSignature[] = [
  "mint(uint256)",
  "publicMint(uint256)",
  "mintPublic(uint256)",
  "mintTo(address,uint256)",
  "publicMint(address,uint256)"
];

function isMultiMintJobStatus(value: unknown): value is MultiMintJobStatus {
  return (
    value === "scheduled" ||
    value === "watching" ||
    value === "ready" ||
    value === "submitted" ||
    value === "confirmed" ||
    value === "partial" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "expired" ||
    value === "blocked"
  );
}

function isMultiMintChildStatus(value: unknown): value is MultiMintChildStatus {
  return (
    value === "pending" ||
    value === "ready" ||
    value === "submitted" ||
    value === "confirmed" ||
    value === "failed" ||
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

function normalizeNonNegativeInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function normalizeIsoDate(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function normalizeStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeChildResult(raw: any): MultiMintChildResult | null {
  if (
    typeof raw?.walletLabel !== "string" ||
    typeof raw?.walletAddress !== "string"
  ) {
    return null;
  }

  return {
    walletLabel: raw.walletLabel,
    walletAddress: raw.walletAddress,
    status: isMultiMintChildStatus(raw.status) ? raw.status : "pending",
    ...(typeof raw.runId === "string" ? { runId: raw.runId } : {}),
    ...(typeof raw.txHash === "string" ? { txHash: raw.txHash } : {}),
    ...(typeof raw.safeErrorReason === "string"
      ? { safeErrorReason: raw.safeErrorReason.slice(0, 300) }
      : {}),
    attempts: normalizeNonNegativeInteger(raw.attempts),
    updatedAt:
      typeof raw.updatedAt === "string"
        ? raw.updatedAt
        : new Date().toISOString()
  };
}

function normalizeStoredMultiMintJob(raw: any): MultiMintJob | null {
  if (
    typeof raw?.jobId !== "string" ||
    typeof raw?.ownerTelegramId !== "string" ||
    typeof raw?.targetId !== "string" ||
    typeof raw?.targetName !== "string" ||
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

  const walletLabels = normalizeStringArray(raw.walletLabels);
  const walletAddresses = normalizeStringArray(raw.walletAddresses);

  if (walletLabels.length === 0 || walletLabels.length !== walletAddresses.length) {
    return null;
  }

  const now = new Date().toISOString();
  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : now;
  const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : createdAt;
  const childResults = Array.isArray(raw.childResults)
    ? raw.childResults
        .map(normalizeChildResult)
        .filter((child: MultiMintChildResult | null): child is MultiMintChildResult => Boolean(child))
    : [];
  const normalizedChildren =
    childResults.length === walletLabels.length
      ? childResults
      : walletLabels.map((walletLabel, index) => ({
          walletLabel,
          walletAddress: walletAddresses[index]!,
          status: "pending" as const,
          attempts: 0,
          updatedAt
        }));

  return {
    jobId: raw.jobId,
    ownerTelegramId: raw.ownerTelegramId,
    targetId: raw.targetId,
    targetName: raw.targetName,
    chain: raw.chain === "sepolia" ? "sepolia" : raw.chain === "robinhood" ? "robinhood" : "mainnet",
    contractAddress: raw.contractAddress,
    functionSignature: raw.functionSignature,
    quantity,
    priceEth: raw.priceEth,
    walletLabels,
    walletAddresses,
    gasStrategy: normalizeGasStrategy(raw.gasStrategy || createDefaultGasStrategy(createdAt)),
    mode: isMintJobMode(raw.mode) ? raw.mode : "watch",
    status: isMultiMintJobStatus(raw.status) ? raw.status : "scheduled",
    startTimeISO,
    ...(normalizeIsoDate(raw.endTimeISO)
      ? { endTimeISO: normalizeIsoDate(raw.endTimeISO)! }
      : {}),
    childResults: normalizedChildren,
    maxRetries: Math.min(normalizeNonNegativeInteger(raw.maxRetries), 5),
    retryDelayMs: Math.max(500, normalizeNonNegativeInteger(raw.retryDelayMs)),
    attempts: normalizeNonNegativeInteger(raw.attempts),
    ...(normalizeIsoDate(raw.lastCheckedAt)
      ? { lastCheckedAt: normalizeIsoDate(raw.lastCheckedAt)! }
      : {}),
    ...(typeof raw.safeErrorReason === "string"
      ? { safeErrorReason: raw.safeErrorReason.slice(0, 300) }
      : {}),
    createdAt,
    updatedAt
  };
}

function normalizeMultiMintJobsFile(parsed: MultiMintJobsFile): MultiMintJobsFile {
  const rawJobs: any[] = Array.isArray(parsed.jobs) ? parsed.jobs : [];
  const jobs = rawJobs
    .map(normalizeStoredMultiMintJob)
    .filter((job): job is MultiMintJob => Boolean(job));

  return { jobs };
}

function writeMultiMintJobs(jobs: MultiMintJob[]) {
  saveJsonFileAtomic(MULTI_MINT_JOBS_PATH, { jobs });
}

function loadMultiMintJobsFile(): MultiMintJobsFile {
  const parsed = loadJsonFile<MultiMintJobsFile>(
    MULTI_MINT_JOBS_PATH,
    EMPTY_MULTI_MINT_JOBS_FILE
  );
  const file = normalizeMultiMintJobsFile(parsed);

  if (file.jobs.length !== (Array.isArray(parsed.jobs) ? parsed.jobs.length : 0)) {
    writeMultiMintJobs(file.jobs);
  }

  return file;
}

export function createMultiMintJob(params: CreateMultiMintJobParams): MultiMintJob {
  const now = new Date().toISOString();
  const childResults = params.walletLabels.map((walletLabel, index) => ({
    walletLabel,
    walletAddress: params.walletAddresses[index]!,
    status: "pending" as const,
    attempts: 0,
    updatedAt: now
  }));
  const job: MultiMintJob = {
    jobId: randomUUID(),
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
    gasStrategy: normalizeGasStrategy(params.gasStrategy || createDefaultGasStrategy(now)),
    mode: params.mode,
    status: "scheduled",
    startTimeISO: params.startTimeISO,
    ...(params.endTimeISO ? { endTimeISO: params.endTimeISO } : {}),
    childResults,
    maxRetries: Math.min(Math.max(Math.floor(params.maxRetries), 0), 5),
    retryDelayMs: Math.max(Math.floor(params.retryDelayMs), 500),
    attempts: 0,
    createdAt: now,
    updatedAt: now
  };

  updateJsonFileSync<MultiMintJobsFile>(
    MULTI_MINT_JOBS_PATH,
    EMPTY_MULTI_MINT_JOBS_FILE,
    (current) => {
      const file = normalizeMultiMintJobsFile(current);
      file.jobs.push(job);
      return file;
    }
  );
  return job;
}

export function listMultiMintJobsForOwner(ownerTelegramId: string) {
  return loadMultiMintJobsFile()
    .jobs.filter((job) => job.ownerTelegramId === ownerTelegramId)
    .sort((a, b) => Date.parse(a.startTimeISO) - Date.parse(b.startTimeISO));
}

export function listActiveMultiMintJobsForOwner(ownerTelegramId: string) {
  return listMultiMintJobsForOwner(ownerTelegramId).filter((job) =>
    ["scheduled", "watching", "ready", "submitted", "partial"].includes(job.status)
  );
}

export function listResumableMultiMintJobs() {
  return loadMultiMintJobsFile().jobs.filter((job) =>
    ["scheduled", "watching", "ready"].includes(job.status)
  );
}

export function getMultiMintJobForOwner(jobId: string, ownerTelegramId: string) {
  const job = loadMultiMintJobsFile().jobs.find(
    (savedJob) =>
      savedJob.jobId === jobId && savedJob.ownerTelegramId === ownerTelegramId
  );

  if (!job) {
    throw new Error("Multi-mint job not found for this Telegram user.");
  }

  return job;
}

export function updateMultiMintJobForOwner(
  jobId: string,
  ownerTelegramId: string,
  updates: UpdateMultiMintJobParams
) {
  let updatedJob: MultiMintJob | undefined;

  updateJsonFileSync<MultiMintJobsFile>(
    MULTI_MINT_JOBS_PATH,
    EMPTY_MULTI_MINT_JOBS_FILE,
    (current) => {
      const file = normalizeMultiMintJobsFile(current);
      const job = file.jobs.find(
        (savedJob) =>
          savedJob.jobId === jobId && savedJob.ownerTelegramId === ownerTelegramId
      );

      if (!job) {
        throw new Error("Multi-mint job not found for this Telegram user.");
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

      if (updates.safeErrorReason !== undefined) {
        job.safeErrorReason = updates.safeErrorReason.slice(0, 300);
      }

      if (updates.endTimeISO) {
        job.endTimeISO = updates.endTimeISO;
      }

      if (updates.childResults) {
        job.childResults = updates.childResults;
      }

      job.updatedAt = new Date().toISOString();
      updatedJob = job;
      return file;
    }
  );

  return updatedJob!;
}

export function updateMultiMintChildResult(
  jobId: string,
  ownerTelegramId: string,
  walletLabel: string,
  updates: Partial<{
    status: MultiMintChildStatus;
    runId: string;
    txHash: string;
    safeErrorReason: string;
    attempts: number;
  }>
) {
  let updatedJob: MultiMintJob | undefined;

  updateJsonFileSync<MultiMintJobsFile>(
    MULTI_MINT_JOBS_PATH,
    EMPTY_MULTI_MINT_JOBS_FILE,
    (current) => {
      const file = normalizeMultiMintJobsFile(current);
      const job = file.jobs.find(
        (savedJob) =>
          savedJob.jobId === jobId && savedJob.ownerTelegramId === ownerTelegramId
      );

      if (!job) {
        throw new Error("Multi-mint job not found for this Telegram user.");
      }

      let childFound = false;
      job.childResults = job.childResults.map((child) => {
        if (child.walletLabel !== walletLabel) {
          return child;
        }

        childFound = true;
        return {
          ...child,
          ...(updates.status ? { status: updates.status } : {}),
          ...(updates.runId ? { runId: updates.runId } : {}),
          ...(updates.txHash ? { txHash: updates.txHash } : {}),
          ...(updates.safeErrorReason
            ? { safeErrorReason: updates.safeErrorReason.slice(0, 300) }
            : {}),
          ...(updates.attempts !== undefined
            ? { attempts: Math.max(0, Math.floor(updates.attempts)) }
            : {}),
          updatedAt: new Date().toISOString()
        };
      });

      if (!childFound) {
        throw new Error("Multi-mint child wallet not found for this job.");
      }

      job.updatedAt = new Date().toISOString();
      updatedJob = job;
      return file;
    }
  );

  return updatedJob!;
}

export function summarizeMultiMintJobStatus(job: MultiMintJob): MultiMintJobStatus {
  const confirmed = job.childResults.filter((child) => child.status === "confirmed").length;
  const submitted = job.childResults.filter((child) => child.status === "submitted").length;
  const failed = job.childResults.filter((child) => child.status === "failed").length;
  const blocked = job.childResults.filter((child) => child.status === "blocked").length;

  if (confirmed === job.childResults.length) {
    return "confirmed";
  }

  if (confirmed > 0 || submitted > 0) {
    return failed > 0 || blocked > 0 ? "partial" : "submitted";
  }

  if (failed + blocked === job.childResults.length) {
    return blocked > 0 && failed === 0 ? "blocked" : "failed";
  }

  return job.status;
}
