import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type {
  MintChain,
  SupportedMintFunctionSignature
} from "./mintEngine.js";

export type MintTargetStatus = "active" | "archived";

export type MintTarget = {
  targetId: string;
  ownerTelegramId: string;
  name: string;
  chain: MintChain;
  contractAddress: string;
  functionSignature: SupportedMintFunctionSignature;
  quantity: number;
  priceEth: string;
  createdAt: string;
  updatedAt: string;
  status: MintTargetStatus;
  collectionSlug?: string;
  sourceUrl?: string;
  notes?: string;
};

type MintTargetsFile = {
  targets: MintTarget[];
};

type CreateMintTargetParams = {
  ownerTelegramId: string;
  name: string;
  chain: MintChain;
  contractAddress: string;
  functionSignature: SupportedMintFunctionSignature;
  quantity: number;
  priceEth: string;
  collectionSlug?: string;
  sourceUrl?: string;
  notes?: string;
};

type UpdateMintTargetParams = {
  chain: MintChain;
  functionSignature: SupportedMintFunctionSignature;
  quantity: number;
  priceEth: string;
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

function isSupportedStoredMintFunctionSignature(
  value: unknown
): value is SupportedMintFunctionSignature {
  return SUPPORTED_STORED_MINT_SIGNATURES.includes(
    value as SupportedMintFunctionSignature
  );
}

function normalizeStoredMintTarget(raw: any): MintTarget | null {
  if (
    typeof raw?.targetId !== "string" ||
    typeof raw?.ownerTelegramId !== "string" ||
    typeof raw?.name !== "string" ||
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
    targetId: raw.targetId,
    ownerTelegramId: raw.ownerTelegramId,
    name: raw.name,
    chain: raw.chain === "sepolia" ? "sepolia" : "mainnet",
    contractAddress: raw.contractAddress,
    functionSignature: raw.functionSignature,
    quantity,
    priceEth: raw.priceEth,
    createdAt,
    updatedAt,
    status: isMintTargetStatus(raw.status) ? raw.status : "active",
    ...(typeof raw.collectionSlug === "string"
      ? { collectionSlug: raw.collectionSlug }
      : {}),
    ...(typeof raw.sourceUrl === "string" ? { sourceUrl: raw.sourceUrl } : {}),
    ...(typeof raw.notes === "string" ? { notes: raw.notes } : {})
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
  const target: MintTarget = {
    targetId: randomUUID(),
    ownerTelegramId: params.ownerTelegramId,
    name: params.name,
    chain: params.chain,
    contractAddress: params.contractAddress,
    functionSignature: params.functionSignature,
    quantity: params.quantity,
    priceEth: params.priceEth,
    createdAt: now,
    updatedAt: now,
    status: "active",
    ...(params.collectionSlug ? { collectionSlug: params.collectionSlug } : {}),
    ...(params.sourceUrl ? { sourceUrl: params.sourceUrl } : {}),
    ...(params.notes ? { notes: params.notes } : {})
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
