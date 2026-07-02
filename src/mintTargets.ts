import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type {
  MintChain,
  SupportedMintFunctionSignature
} from "./mintEngine.js";

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

const MINT_TARGETS_PATH = path.join(process.cwd(), "data", "mintTargets.json");
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

function normalizeQuantity(value: unknown) {
  const quantity = Number(value ?? 1);

  if (!Number.isInteger(quantity) || quantity <= 0) {
    return 1;
  }

  return quantity;
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
    ...(detectedMetadata ? { detectedMetadata } : {})
  };
}

function writeMintTargets(targets: MintTarget[]) {
  const dir = path.dirname(MINT_TARGETS_PATH);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(
    MINT_TARGETS_PATH,
    JSON.stringify({ targets }, null, 2),
    "utf8"
  );
}

function loadMintTargetsFile(): MintTargetsFile {
  if (!fs.existsSync(MINT_TARGETS_PATH)) {
    return { targets: [] };
  }

  const raw = fs.readFileSync(MINT_TARGETS_PATH, "utf8");

  if (!raw.trim()) {
    return { targets: [] };
  }

  const parsed = JSON.parse(raw);
  const rawTargets: any[] = Array.isArray(parsed.targets) ? parsed.targets : [];
  const targets = rawTargets
    .map(normalizeStoredMintTarget)
    .filter((target): target is MintTarget => Boolean(target));

  if (targets.length !== rawTargets.length) {
    writeMintTargets(targets);
  }

  return { targets };
}

export function createMintTarget(params: CreateMintTargetParams): MintTarget {
  const file = loadMintTargetsFile();
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

  file.targets.push(target);
  writeMintTargets(file.targets);
  return target;
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
  const file = loadMintTargetsFile();
  const target = file.targets.find(
    (savedTarget) =>
      savedTarget.targetId === targetId &&
      savedTarget.ownerTelegramId === ownerTelegramId
  );

  if (!target) {
    throw new Error("Mint target not found for this Telegram user.");
  }

  if (target.status === "archived") {
    throw new Error("Mint target is archived and cannot be updated.");
  }

  target.chain = updates.chain;
  target.functionSignature = updates.functionSignature;
  target.quantity = updates.quantity;
  target.priceEth = updates.priceEth;
  target.targetCompleteness = calculateMintTargetCompleteness(target);
  target.updatedAt = new Date().toISOString();

  writeMintTargets(file.targets);
  return target;
}

export function updateMintTargetDetectedMetadataForOwner(
  targetId: string,
  ownerTelegramId: string,
  updates: UpdateMintTargetMetadataParams
) {
  const file = loadMintTargetsFile();
  const target = file.targets.find(
    (savedTarget) =>
      savedTarget.targetId === targetId &&
      savedTarget.ownerTelegramId === ownerTelegramId
  );

  if (!target) {
    throw new Error("Mint target not found for this Telegram user.");
  }

  if (target.status === "archived") {
    throw new Error("Mint target is archived and cannot be refreshed.");
  }

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
  target.updatedAt = new Date().toISOString();

  writeMintTargets(file.targets);
  return target;
}

export function archiveMintTargetForOwner(
  targetId: string,
  ownerTelegramId: string
) {
  const file = loadMintTargetsFile();
  const target = file.targets.find(
    (savedTarget) =>
      savedTarget.targetId === targetId &&
      savedTarget.ownerTelegramId === ownerTelegramId
  );

  if (!target) {
    throw new Error("Mint target not found for this Telegram user.");
  }

  if (target.status !== "archived") {
    target.status = "archived";
    target.updatedAt = new Date().toISOString();
    writeMintTargets(file.targets);
  }

  return target;
}
