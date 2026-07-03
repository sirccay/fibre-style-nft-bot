import path from "path";
import { randomUUID } from "crypto";
import type {
  MintChain,
  SupportedMintFunctionSignature
} from "./mintEngine.js";
import type {
  OpenSeaMintMetadata,
  OpenSeaMintStage
} from "./mintDetector.js";
import type { MintJobMintType } from "./mintJobs.js";
import {
  createDefaultGasStrategy,
  normalizeGasStrategy
} from "./gasStrategy.js";
import type { GasStrategy } from "./gasStrategy.js";
import {
  loadJsonFile,
  saveJsonFileAtomic,
  updateJsonFileSync
} from "./jsonStore.js";

export type MintTargetStatus = "active" | "archived";
export type MintTargetCompleteness = "complete" | "incomplete";

export type MintTargetDetectedMetadata = {
  lastCheckedAt?: string;
  collectionName?: string;
  collectionSlug?: string;
  detectedContractAddress?: string;
  detectedChain?: string;
  candidateFunctions?: string[];
  phaseStatus?: string;
  phaseTypeEstimate?: string;
  phaseTypeConfidence?: string;
  phaseTypeEvidence?: string;
  phaseConfidence?: string;
  openSeaMint?: OpenSeaMintMetadata;
  detector?: {
    chain?: unknown;
    contract?: unknown;
    mint?: unknown;
    eligibility?: unknown;
  };
  warnings?: string[];
};

export type MintTarget = {
  targetId: string;
  ownerTelegramId: string;
  name: string;
  chain: MintChain;
  contractAddress: string;
  functionSignature?: SupportedMintFunctionSignature;
  quantity: number;
  priceEth?: string;
  createdAt: string;
  updatedAt: string;
  status: MintTargetStatus;
  targetCompleteness: MintTargetCompleteness;
  collectionSlug?: string;
  sourceUrl?: string;
  notes?: string;
  mintType?: MintJobMintType;
  maxRetries?: number;
  retryDelayMs?: number;
  gasStrategy?: GasStrategy;
  detectedMetadata?: MintTargetDetectedMetadata;
};

type MintTargetsFile = {
  targets: MintTarget[];
};

type CreateMintTargetParams = {
  ownerTelegramId: string;
  name: string;
  chain: MintChain;
  contractAddress: string;
  functionSignature?: SupportedMintFunctionSignature;
  quantity?: number;
  priceEth?: string;
  targetCompleteness?: MintTargetCompleteness;
  collectionSlug?: string;
  sourceUrl?: string;
  notes?: string;
  detectedMetadata?: MintTargetDetectedMetadata;
};

type UpdateMintTargetParams = {
  contractAddress?: string;
  chain: MintChain;
  functionSignature: SupportedMintFunctionSignature;
  quantity: number;
  priceEth: string;
};

type UpdateMintTargetMetadataParams = {
  sourceUrl?: string;
  collectionSlug?: string;
  contractAddress?: string;
  chain?: MintChain;
  detectedMetadata: MintTargetDetectedMetadata;
};

type UpdateMintTargetMintSettingsParams = {
  mintType: MintJobMintType;
  maxRetries: number;
  retryDelayMs: number;
};

type UpdateMintTargetGasStrategyParams = {
  gasStrategy: GasStrategy;
};

const MINT_TARGETS_PATH = path.join(process.cwd(), "data", "mintTargets.json");
const EMPTY_MINT_TARGETS_FILE: MintTargetsFile = { targets: [] };
const SUPPORTED_STORED_MINT_SIGNATURES: SupportedMintFunctionSignature[] = [
  "mint(uint256)",
  "publicMint(uint256)",
  "mintPublic(uint256)",
  "mintTo(address,uint256)",
  "publicMint(address,uint256)"
];

function isMintTargetStatus(value: unknown): value is MintTargetStatus {
  return value === "active" || value === "archived";
}

function isMintTargetCompleteness(
  value: unknown
): value is MintTargetCompleteness {
  return value === "complete" || value === "incomplete";
}

function isSupportedStoredMintFunctionSignature(
  value: unknown
): value is SupportedMintFunctionSignature {
  return SUPPORTED_STORED_MINT_SIGNATURES.includes(
    value as SupportedMintFunctionSignature
  );
}

function isMintJobMintType(value: unknown): value is MintJobMintType {
  return (
    value === "manual" ||
    value === "team" ||
    value === "holder" ||
    value === "gtd" ||
    value === "fcfs" ||
    value === "public"
  );
}

function normalizeQuantity(value: unknown) {
  const quantity = Number(value ?? 1);

  if (!Number.isInteger(quantity) || quantity <= 0) {
    return 1;
  }

  return quantity;
}

function normalizeNumberField(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function normalizeOpenSeaMintStage(raw: any): OpenSeaMintStage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const limitPerWallet = normalizeNumberField(raw.limitPerWallet);

  return {
    ...(typeof raw.stageName === "string" ? { stageName: raw.stageName.slice(0, 80) } : {}),
    phaseTypeEstimate:
      typeof raw.phaseTypeEstimate === "string"
        ? raw.phaseTypeEstimate
        : "unknown",
    phaseTypeConfidence:
      typeof raw.phaseTypeConfidence === "string"
        ? raw.phaseTypeConfidence
        : "unknown",
    status: typeof raw.status === "string" ? raw.status : "unknown",
    ...(typeof raw.startTimeText === "string"
      ? { startTimeText: raw.startTimeText.slice(0, 160) }
      : {}),
    ...(typeof raw.endTimeText === "string"
      ? { endTimeText: raw.endTimeText.slice(0, 160) }
      : {}),
    ...(typeof raw.priceText === "string" ? { priceText: raw.priceText.slice(0, 80) } : {}),
    ...(typeof raw.priceEth === "string" ? { priceEth: raw.priceEth.slice(0, 40) } : {}),
    ...(limitPerWallet !== undefined ? { limitPerWallet } : {}),
    ...(typeof raw.eligibilityText === "string"
      ? { eligibilityText: raw.eligibilityText.slice(0, 80) }
      : {}),
    ...(typeof raw.evidence === "string" ? { evidence: raw.evidence.slice(0, 240) } : {})
  };
}

function normalizeOpenSeaMintMetadata(raw: any): OpenSeaMintMetadata | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }

  const mintSchedule = Array.isArray(raw.mintSchedule)
    ? raw.mintSchedule
        .map(normalizeOpenSeaMintStage)
        .filter((stage: OpenSeaMintStage | null): stage is OpenSeaMintStage => Boolean(stage))
        .slice(0, 10)
    : [];
  const mintedCount = normalizeNumberField(raw.mintedCount);
  const maxSupply = normalizeNumberField(raw.maxSupply);
  const currentStageLimitPerWallet = normalizeNumberField(raw.currentStageLimitPerWallet);
  const metadata: OpenSeaMintMetadata = {
    ...(typeof raw.collectionName === "string"
      ? { collectionName: raw.collectionName.slice(0, 100) }
      : {}),
    ...(typeof raw.mintStatusText === "string"
      ? { mintStatusText: raw.mintStatusText.slice(0, 80) }
      : {}),
    ...(mintedCount !== undefined ? { mintedCount } : {}),
    ...(maxSupply !== undefined ? { maxSupply } : {}),
    ...(typeof raw.currentStageName === "string"
      ? { currentStageName: raw.currentStageName.slice(0, 80) }
      : {}),
    ...(typeof raw.currentStagePriceText === "string"
      ? { currentStagePriceText: raw.currentStagePriceText.slice(0, 80) }
      : {}),
    ...(typeof raw.currentStagePriceEth === "string"
      ? { currentStagePriceEth: raw.currentStagePriceEth.slice(0, 40) }
      : {}),
    ...(currentStageLimitPerWallet !== undefined ? { currentStageLimitPerWallet } : {}),
    mintSchedule,
    ...(typeof raw.rawTimeZoneText === "string"
      ? { rawTimeZoneText: raw.rawTimeZoneText.slice(0, 40) }
      : {}),
    metadataSource:
      typeof raw.metadataSource === "string" ? raw.metadataSource : "unknown",
    confidence: typeof raw.confidence === "string" ? raw.confidence : "unknown",
    ...(Array.isArray(raw.warnings)
      ? {
          warnings: raw.warnings
            .filter((value: unknown) => typeof value === "string")
            .map((value: string) => value.slice(0, 240))
            .slice(0, 10)
        }
      : {})
  };

  return Object.keys(metadata).length > 3 || mintSchedule.length > 0
    ? metadata
    : undefined;
}

function normalizeDetectorSnapshot(raw: any): MintTargetDetectedMetadata["detector"] | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }

  return {
    ...(raw.chain && typeof raw.chain === "object" ? { chain: raw.chain } : {}),
    ...(raw.contract && typeof raw.contract === "object" ? { contract: raw.contract } : {}),
    ...(raw.mint && typeof raw.mint === "object" ? { mint: raw.mint } : {}),
    ...(raw.eligibility && typeof raw.eligibility === "object"
      ? { eligibility: raw.eligibility }
      : {})
  };
}

export function getMintTargetMissingFields(target: {
  contractAddress?: string;
  functionSignature?: string;
  priceEth?: string;
  quantity?: number;
}) {
  const missing: string[] = [];

  if (!target.contractAddress) {
    missing.push("contractAddress");
  }

  if (!target.functionSignature) {
    missing.push("functionSignature");
  }

  if (target.priceEth === undefined || target.priceEth === "") {
    missing.push("priceEth");
  }

  if (!target.quantity || target.quantity <= 0) {
    missing.push("quantity");
  }

  return missing;
}

export function calculateMintTargetCompleteness(target: {
  contractAddress?: string;
  functionSignature?: string;
  priceEth?: string;
  quantity?: number;
}): MintTargetCompleteness {
  return getMintTargetMissingFields(target).length === 0
    ? "complete"
    : "incomplete";
}

function normalizeDetectedMetadata(raw: any): MintTargetDetectedMetadata | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }

  const openSeaMint = normalizeOpenSeaMintMetadata(raw.openSeaMint);
  const detector = normalizeDetectorSnapshot(raw.detector);
  const metadata: MintTargetDetectedMetadata = {
    ...(typeof raw.lastCheckedAt === "string" ? { lastCheckedAt: raw.lastCheckedAt } : {}),
    ...(typeof raw.collectionName === "string" ? { collectionName: raw.collectionName } : {}),
    ...(typeof raw.collectionSlug === "string" ? { collectionSlug: raw.collectionSlug } : {}),
    ...(typeof raw.detectedContractAddress === "string"
      ? { detectedContractAddress: raw.detectedContractAddress }
      : {}),
    ...(typeof raw.detectedChain === "string" ? { detectedChain: raw.detectedChain } : {}),
    ...(Array.isArray(raw.candidateFunctions)
      ? {
          candidateFunctions: raw.candidateFunctions
            .filter((value: unknown) => typeof value === "string")
            .slice(0, 20)
        }
      : {}),
    ...(typeof raw.phaseStatus === "string" ? { phaseStatus: raw.phaseStatus } : {}),
    ...(typeof raw.phaseTypeEstimate === "string"
      ? { phaseTypeEstimate: raw.phaseTypeEstimate }
      : {}),
    ...(typeof raw.phaseTypeConfidence === "string"
      ? { phaseTypeConfidence: raw.phaseTypeConfidence }
      : {}),
    ...(typeof raw.phaseTypeEvidence === "string"
      ? { phaseTypeEvidence: raw.phaseTypeEvidence }
      : {}),
    ...(typeof raw.phaseConfidence === "string"
      ? { phaseConfidence: raw.phaseConfidence }
      : {}),
    ...(openSeaMint ? { openSeaMint } : {}),
    ...(detector ? { detector } : {}),
    ...(Array.isArray(raw.warnings)
      ? {
          warnings: raw.warnings
            .filter((value: unknown) => typeof value === "string")
            .slice(0, 20)
        }
      : {})
  };

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function normalizeStoredMintTarget(raw: any): MintTarget | null {
  if (
    typeof raw?.targetId !== "string" ||
    typeof raw?.ownerTelegramId !== "string" ||
    typeof raw?.name !== "string" ||
    typeof raw?.chain !== "string" ||
    typeof raw?.contractAddress !== "string"
  ) {
    return null;
  }

  const quantity = normalizeQuantity(raw.quantity);
  const functionSignature = isSupportedStoredMintFunctionSignature(raw.functionSignature)
    ? raw.functionSignature
    : undefined;
  const priceEth = typeof raw.priceEth === "string" ? raw.priceEth : undefined;
  const createdAt =
    typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString();
  const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : createdAt;
  const targetCompleteness = isMintTargetCompleteness(raw.targetCompleteness)
    ? raw.targetCompleteness
    : calculateMintTargetCompleteness({
        contractAddress: raw.contractAddress,
        functionSignature,
        priceEth,
        quantity
      });
  const detectedMetadata = normalizeDetectedMetadata(raw.detectedMetadata);
  const maxRetries = normalizeNumberField(raw.maxRetries);
  const retryDelayMs = normalizeNumberField(raw.retryDelayMs);
  const gasStrategy = raw.gasStrategy
    ? normalizeGasStrategy(raw.gasStrategy)
    : undefined;

  return {
    targetId: raw.targetId,
    ownerTelegramId: raw.ownerTelegramId,
    name: raw.name,
    chain: raw.chain === "sepolia" ? "sepolia" : "mainnet",
    contractAddress: raw.contractAddress,
    ...(functionSignature ? { functionSignature } : {}),
    quantity,
    ...(priceEth === undefined ? {} : { priceEth }),
    createdAt,
    updatedAt,
    status: isMintTargetStatus(raw.status) ? raw.status : "active",
    targetCompleteness,
    ...(typeof raw.collectionSlug === "string"
      ? { collectionSlug: raw.collectionSlug }
      : {}),
    ...(typeof raw.sourceUrl === "string" ? { sourceUrl: raw.sourceUrl } : {}),
    ...(typeof raw.notes === "string" ? { notes: raw.notes } : {}),
    ...(isMintJobMintType(raw.mintType) ? { mintType: raw.mintType } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    ...(retryDelayMs !== undefined ? { retryDelayMs } : {}),
    ...(gasStrategy ? { gasStrategy } : {}),
    ...(detectedMetadata ? { detectedMetadata } : {})
  };
}

function normalizeMintTargetsFile(parsed: MintTargetsFile): MintTargetsFile {
  const rawTargets: any[] = Array.isArray(parsed.targets) ? parsed.targets : [];
  const targets = rawTargets
    .map(normalizeStoredMintTarget)
    .filter((target): target is MintTarget => Boolean(target));

  return { targets };
}

function writeMintTargets(targets: MintTarget[]) {
  saveJsonFileAtomic(MINT_TARGETS_PATH, { targets });
}

function loadMintTargetsFile(): MintTargetsFile {
  const parsed = loadJsonFile<MintTargetsFile>(
    MINT_TARGETS_PATH,
    EMPTY_MINT_TARGETS_FILE
  );
  const file = normalizeMintTargetsFile(parsed);

  if (file.targets.length !== (Array.isArray(parsed.targets) ? parsed.targets.length : 0)) {
    writeMintTargets(file.targets);
  }

  return file;
}

export function createMintTarget(params: CreateMintTargetParams): MintTarget {
  const now = new Date().toISOString();
  const quantity = params.quantity || 1;
  const target: MintTarget = {
    targetId: randomUUID(),
    ownerTelegramId: params.ownerTelegramId,
    name: params.name,
    chain: params.chain,
    contractAddress: params.contractAddress,
    ...(params.functionSignature ? { functionSignature: params.functionSignature } : {}),
    quantity,
    ...(params.priceEth === undefined ? {} : { priceEth: params.priceEth }),
    createdAt: now,
    updatedAt: now,
    status: "active",
    targetCompleteness:
      params.targetCompleteness ||
      calculateMintTargetCompleteness({
        contractAddress: params.contractAddress,
        ...(params.functionSignature ? { functionSignature: params.functionSignature } : {}),
        ...(params.priceEth === undefined ? {} : { priceEth: params.priceEth }),
        quantity
      }),
    ...(params.collectionSlug ? { collectionSlug: params.collectionSlug } : {}),
    ...(params.sourceUrl ? { sourceUrl: params.sourceUrl } : {}),
    ...(params.notes ? { notes: params.notes } : {}),
    ...(params.detectedMetadata ? { detectedMetadata: params.detectedMetadata } : {})
  };

  updateJsonFileSync<MintTargetsFile>(
    MINT_TARGETS_PATH,
    EMPTY_MINT_TARGETS_FILE,
    (current) => {
      const file = normalizeMintTargetsFile(current);
      file.targets.push(target);
      return file;
    }
  );
  return target;
}

function updateMintTargetRecord(
  targetId: string,
  ownerTelegramId: string,
  updater: (target: MintTarget) => void,
  options: { includeArchived?: boolean; archivedError?: string } = {}
) {
  let updatedTarget: MintTarget | undefined;

  updateJsonFileSync<MintTargetsFile>(
    MINT_TARGETS_PATH,
    EMPTY_MINT_TARGETS_FILE,
    (current) => {
      const file = normalizeMintTargetsFile(current);
      const target = file.targets.find(
        (savedTarget) =>
          savedTarget.targetId === targetId &&
          savedTarget.ownerTelegramId === ownerTelegramId
      );

      if (!target) {
        throw new Error("Mint target not found for this Telegram user.");
      }

      if (!options.includeArchived && target.status === "archived") {
        throw new Error(options.archivedError || "Mint target is archived and cannot be updated.");
      }

      updater(target);
      target.updatedAt = new Date().toISOString();
      updatedTarget = target;
      return file;
    }
  );

  return updatedTarget!;
}

export function listMintTargetsForOwner(ownerTelegramId: string) {
  return loadMintTargetsFile().targets.filter(
    (target) =>
      target.ownerTelegramId === ownerTelegramId && target.status === "active"
  );
}

export function getMintTargetForOwner(
  targetId: string,
  ownerTelegramId: string,
  options: { includeArchived?: boolean } = {}
) {
  const target = loadMintTargetsFile().targets.find(
    (savedTarget) =>
      savedTarget.targetId === targetId &&
      savedTarget.ownerTelegramId === ownerTelegramId
  );

  if (!target) {
    throw new Error("Mint target not found for this Telegram user.");
  }

  if (!options.includeArchived && target.status === "archived") {
    throw new Error("Mint target is archived and cannot be used.");
  }

  return target;
}

export function updateMintTargetForOwner(
  targetId: string,
  ownerTelegramId: string,
  updates: UpdateMintTargetParams
) {
  return updateMintTargetRecord(targetId, ownerTelegramId, (target) => {
    if (updates.contractAddress !== undefined) {
      target.contractAddress = updates.contractAddress;
    }

    target.chain = updates.chain;
    target.functionSignature = updates.functionSignature;
    target.quantity = updates.quantity;
    target.priceEth = updates.priceEth;
    target.targetCompleteness = calculateMintTargetCompleteness(target);
  });
}

export function updateMintTargetDetectedMetadataForOwner(
  targetId: string,
  ownerTelegramId: string,
  updates: UpdateMintTargetMetadataParams
) {
  return updateMintTargetRecord(
    targetId,
    ownerTelegramId,
    (target) => {
      if (updates.sourceUrl) {
        target.sourceUrl = updates.sourceUrl;
      }

      if (updates.collectionSlug) {
        target.collectionSlug = updates.collectionSlug;
      }

      if (updates.contractAddress) {
        target.contractAddress = updates.contractAddress;
      }

      if (updates.chain) {
        target.chain = updates.chain;
      }

      target.detectedMetadata = updates.detectedMetadata;
      target.targetCompleteness = calculateMintTargetCompleteness(target);
    },
    { archivedError: "Mint target is archived and cannot be refreshed." }
  );
}

export function updateMintTargetMintSettingsForOwner(
  targetId: string,
  ownerTelegramId: string,
  updates: UpdateMintTargetMintSettingsParams
) {
  return updateMintTargetRecord(targetId, ownerTelegramId, (target) => {
    target.mintType = updates.mintType;
    target.maxRetries = updates.maxRetries;
    target.retryDelayMs = updates.retryDelayMs;
  });
}

export function updateMintTargetGasStrategyForOwner(
  targetId: string,
  ownerTelegramId: string,
  updates: UpdateMintTargetGasStrategyParams
) {
  return updateMintTargetRecord(targetId, ownerTelegramId, (target) => {
    const now = new Date().toISOString();
    target.gasStrategy = {
      ...normalizeGasStrategy(updates.gasStrategy || createDefaultGasStrategy(now)),
      updatedAt: now
    };
  });
}

export function archiveMintTargetForOwner(
  targetId: string,
  ownerTelegramId: string
) {
  return updateMintTargetRecord(
    targetId,
    ownerTelegramId,
    (target) => {
      if (target.status !== "archived") {
        target.status = "archived";
      }
    },
    { includeArchived: true }
  );
}
