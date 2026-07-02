import { ethers } from "ethers";
import {
  getMintProvider,
  getMintSafeErrorReason,
  SUPPORTED_MINT_FUNCTION_SIGNATURES
} from "./mintEngine.js";
import type {
  MintChain,
  SupportedMintFunctionSignature
} from "./mintEngine.js";
import {
  detectMintPhase,
  estimatePhaseTypeFromTexts
} from "./mintPhaseDetector.js";
import type {
  Confidence,
  MintPhaseStatus,
  MintPhaseTypeEstimate
} from "./mintPhaseDetector.js";

export type MintSourcePlatform =
  | "opensea"
  | "zora"
  | "manifold"
  | "explorer"
  | "generic"
  | "raw_address"
  | "unknown";

export type DetectedChainName =
  | "mainnet"
  | "sepolia"
  | "base"
  | "arbitrum"
  | "polygon"
  | "unknown";

export type MintFunctionCandidate = {
  signature: SupportedMintFunctionSignature;
  selector: string;
  foundInBytecode: boolean;
  confidence: Confidence;
};

export type OpenSeaMintMetadataSource =
  | "reservoir"
  | "opensea_api"
  | "opensea_page_embedded_json"
  | "opensea_page_text"
  | "unknown";

export type OpenSeaMintStage = {
  stageName?: string;
  phaseTypeEstimate: MintPhaseTypeEstimate;
  phaseTypeConfidence: Confidence;
  status: MintPhaseStatus;
  startTimeText?: string;
  endTimeText?: string;
  priceText?: string;
  priceEth?: string;
  limitPerWallet?: number;
  eligibilityText?: string;
  evidence?: string;
};

export type OpenSeaMintMetadata = {
  collectionName?: string;
  mintStatusText?: string;
  mintedCount?: number;
  maxSupply?: number;
  currentStageName?: string;
  currentStagePriceText?: string;
  currentStagePriceEth?: string;
  currentStageLimitPerWallet?: number;
  mintSchedule: OpenSeaMintStage[];
  rawTimeZoneText?: string;
  metadataSource: OpenSeaMintMetadataSource;
  confidence: Confidence;
  warnings?: string[];
};

export type MintDetectionResult = {
  input: string;
  detectedAt: string;
  warnings: string[];
  source: {
    platform: MintSourcePlatform;
    sourceUrl?: string;
    confidence: Confidence;
  };
  chain: {
    name: DetectedChainName;
    chainId?: number;
    confidence: Confidence;
  };
  contract: {
    address?: string;
    collectionSlug?: string;
    collectionName?: string;
    tokenStandard?: string;
    tokenId?: string;
    confidence: Confidence;
  };
  mint: {
    candidateFunctions: MintFunctionCandidate[];
    priceEth?: string;
    phaseStatus: MintPhaseStatus;
    phaseTypeEstimate: MintPhaseTypeEstimate;
    phaseTypeConfidence: Confidence;
    phaseTypeEvidence: string;
    startTime?: string;
    endTime?: string;
    openSeaMint?: OpenSeaMintMetadata;
    confidence: Confidence;
  };
  eligibility?: {
    walletAddress: string;
    estimate: "unknown" | "not_checked";
    reason: string;
  };
};

type ParsedMintInput = {
  platform: MintSourcePlatform;
  sourceUrl?: string;
  chainName: DetectedChainName;
  chainId?: number;
  chainConfidence: Confidence;
  contractAddress?: string;
  contractConfidence: Confidence;
  collectionSlug?: string;
  collectionName?: string;
  tokenId?: string;
  warnings: string[];
};

type OpenSeaCollectionDetails = {
  name?: string;
  collectionSlug?: string;
  contractAddress?: string;
  chainName?: DetectedChainName;
  tokenStandard?: string;
  openSeaMint?: OpenSeaMintMetadata;
};

const ADDRESS_PATTERN = /0x[a-fA-F0-9]{40}/;

const CHAIN_DETAILS: Record<
  Exclude<DetectedChainName, "unknown">,
  { chainId: number; aliases: string[] }
> = {
  mainnet: { chainId: 1, aliases: ["ethereum", "eth", "mainnet"] },
  sepolia: { chainId: 11155111, aliases: ["sepolia"] },
  base: { chainId: 8453, aliases: ["base"] },
  arbitrum: { chainId: 42161, aliases: ["arbitrum", "arb", "arbitrum-one"] },
  polygon: { chainId: 137, aliases: ["polygon", "matic"] }
};

function normalizeChain(rawChain?: string | null): {
  name: DetectedChainName;
  chainId?: number;
  confidence: Confidence;
} {
  const normalized = rawChain?.trim().toLowerCase();

  if (!normalized) {
    return { name: "unknown", confidence: "unknown" };
  }

  for (const [name, details] of Object.entries(CHAIN_DETAILS)) {
    if (details.aliases.includes(normalized)) {
      return {
        name: name as DetectedChainName,
        chainId: details.chainId,
        confidence: "medium"
      };
    }
  }

  return { name: "unknown", confidence: "unknown" };
}

export function toSupportedMintChain(
  chainName: DetectedChainName
): MintChain | null {
  if (chainName === "mainnet" || chainName === "sepolia") {
    return chainName;
  }

  return null;
}

function getChainId(chainName: DetectedChainName): number | undefined {
  if (chainName === "unknown") {
    return undefined;
  }

  return CHAIN_DETAILS[chainName].chainId;
}

function getFirstAddress(input: string): string | undefined {
  const match = input.match(ADDRESS_PATTERN);

  if (!match) {
    return undefined;
  }

  return ethers.getAddress(match[0]);
}

function parseOpenSeaUrl(url: URL): ParsedMintInput {
  const parts = url.pathname
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  const collectionIndex = parts.indexOf("collection");
  const assetsIndex = parts.indexOf("assets");

  if (collectionIndex !== -1 && parts[collectionIndex + 1]) {
    const collectionSlug = parts[collectionIndex + 1] as string;

    return {
      platform: "opensea",
      sourceUrl: url.toString(),
      chainName: "mainnet",
      chainId: 1,
      chainConfidence: "low",
      collectionSlug,
      contractConfidence: "unknown",
      warnings: []
    };
  }

  if (assetsIndex !== -1) {
    const maybeChain = parts[assetsIndex + 1];
    const maybeContract = parts[assetsIndex + 2];
    const maybeTokenId = parts[assetsIndex + 3];
    const chain = normalizeChain(maybeChain);

    if (maybeContract && ethers.isAddress(maybeContract)) {
      return {
        platform: "opensea",
        sourceUrl: url.toString(),
        chainName: chain.name,
        ...(chain.chainId ? { chainId: chain.chainId } : {}),
        chainConfidence: chain.confidence,
        contractAddress: ethers.getAddress(maybeContract),
        contractConfidence: "high",
        ...(maybeTokenId ? { tokenId: maybeTokenId } : {}),
        warnings: []
      };
    }
  }

  return {
    platform: "opensea",
    sourceUrl: url.toString(),
    chainName: "unknown",
    chainConfidence: "unknown",
    contractConfidence: "unknown",
    warnings: ["OpenSea URL was recognized, but collection or asset details were not detected."]
  };
}

function parseZoraUrl(url: URL): ParsedMintInput {
  const parts = url.pathname
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  const collectIndex = parts.indexOf("collect");
  const collectValue = collectIndex === -1 ? null : parts[collectIndex + 1];
  const warnings: string[] = [];

  if (collectValue) {
    const [chainRaw, addressRaw] = collectValue.split(":");
    const chain = normalizeChain(chainRaw);

    if (addressRaw && ethers.isAddress(addressRaw)) {
      return {
        platform: "zora",
        sourceUrl: url.toString(),
        chainName: chain.name,
        ...(chain.chainId ? { chainId: chain.chainId } : {}),
        chainConfidence: chain.confidence,
        contractAddress: ethers.getAddress(addressRaw),
        contractConfidence: "high",
        warnings
      };
    }
  }

  const address = getFirstAddress(url.toString());
  warnings.push("Zora URL was recognized, but collect route details were incomplete.");

  return {
    platform: "zora",
    sourceUrl: url.toString(),
    chainName: "unknown",
    chainConfidence: "unknown",
    ...(address ? { contractAddress: address } : {}),
    contractConfidence: address ? "medium" : "unknown",
    warnings
  };
}

function parseExplorerUrl(url: URL): ParsedMintInput {
  const host = url.hostname.toLowerCase();
  const parts = url.pathname
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  const addressIndex = parts.indexOf("address");
  const addressRaw = addressIndex === -1 ? null : parts[addressIndex + 1];
  const chainName =
    host.includes("sepolia") ? "sepolia" :
    host.includes("basescan") ? "base" :
    host.includes("arbiscan") ? "arbitrum" :
    host.includes("polygonscan") ? "polygon" :
    host.includes("etherscan") ? "mainnet" :
    "unknown";
  const chainId = getChainId(chainName);
  const address =
    addressRaw && ethers.isAddress(addressRaw)
      ? ethers.getAddress(addressRaw)
      : getFirstAddress(url.toString());

  return {
    platform: "explorer",
    sourceUrl: url.toString(),
    chainName,
    ...(chainId === undefined ? {} : { chainId }),
    chainConfidence: chainName === "unknown" ? "unknown" : "medium",
    ...(address ? { contractAddress: address } : {}),
    contractConfidence: address ? "high" : "unknown",
    warnings: address ? [] : ["Explorer URL was recognized, but no address was detected."]
  };
}

function parseManifoldUrl(url: URL): ParsedMintInput {
  const address = getFirstAddress(url.toString());

  return {
    platform: "manifold",
    sourceUrl: url.toString(),
    chainName: "unknown",
    chainConfidence: "unknown",
    ...(address ? { contractAddress: address } : {}),
    contractConfidence: address ? "medium" : "unknown",
    warnings: address ? [] : ["Manifold URL was recognized, but no contract address was visible."]
  };
}

function parseMintInput(input: string): ParsedMintInput {
  const trimmed = input.trim();

  if (!trimmed) {
    return {
      platform: "unknown",
      chainName: "unknown",
      chainConfidence: "unknown",
      contractConfidence: "unknown",
      warnings: ["No input was provided."]
    };
  }

  if (ethers.isAddress(trimmed)) {
    return {
      platform: "raw_address",
      chainName: "unknown",
      chainConfidence: "unknown",
      contractAddress: ethers.getAddress(trimmed),
      contractConfidence: "high",
      warnings: []
    };
  }

  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();

    if (host.includes("opensea.io")) {
      return parseOpenSeaUrl(url);
    }

    if (host.includes("zora.co")) {
      return parseZoraUrl(url);
    }

    if (host.includes("etherscan.io") || host.includes("basescan.org") || host.includes("arbiscan.io") || host.includes("polygonscan.com")) {
      return parseExplorerUrl(url);
    }

    if (host.includes("manifold") || host.includes("gallery")) {
      return parseManifoldUrl(url);
    }

    const address = getFirstAddress(trimmed);

    return {
      platform: address ? "generic" : "unknown",
      sourceUrl: url.toString(),
      chainName: "unknown",
      chainConfidence: "unknown",
      ...(address ? { contractAddress: address } : {}),
      contractConfidence: address ? "low" : "unknown",
      warnings: address
        ? ["Generic URL parsed by visible contract address only."]
        : ["No supported mint link pattern or contract address was detected."]
    };
  } catch {
    const address = getFirstAddress(trimmed);

    return {
      platform: address ? "generic" : "unknown",
      chainName: "unknown",
      chainConfidence: "unknown",
      ...(address ? { contractAddress: address } : {}),
      contractConfidence: address ? "low" : "unknown",
      warnings: address
        ? ["Text parsed by visible contract address only."]
        : ["No supported mint link pattern or contract address was detected."]
    };
  }
}

async function fetchOpenSeaCollectionDetails(
  slug: string
): Promise<OpenSeaCollectionDetails | null> {
  const apiKey = process.env.OPENSEA_API_KEY;

  if (!apiKey) {
    return null;
  }

  try {
    const response = await fetch(
      `https://api.opensea.io/api/v2/collections/${slug}`,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-api-key": apiKey
        }
      }
    );

    if (!response.ok) {
      return null;
    }

    const data: any = await response.json();
    const collection = data.collection ?? data;
    const contract =
      collection.contracts?.[0]?.address ??
      collection.primary_asset_contracts?.[0]?.address ??
      collection.primary_asset_contract?.address ??
      collection.contract_address ??
      null;
    const chainRaw =
      collection.contracts?.[0]?.chain ??
      collection.chain ??
      collection.network ??
      null;
    const chain = normalizeChain(chainRaw);
    const tokenStandard =
      collection.contracts?.[0]?.token_standard ??
      collection.primary_asset_contracts?.[0]?.schema_name ??
      collection.primary_asset_contract?.schema_name ??
      collection.token_standard ??
      collection.tokenStandard ??
      null;
    const openSeaMint = extractOpenSeaMintFromText(
      JSON.stringify(collection),
      "opensea_api",
      "medium"
    );

    return {
      ...(typeof collection.name === "string" ? { name: collection.name } : {}),
      collectionSlug: slug,
      ...(contract && ethers.isAddress(contract)
        ? { contractAddress: ethers.getAddress(contract) }
        : {}),
      ...(chain.name !== "unknown" ? { chainName: chain.name } : {}),
      ...(typeof tokenStandard === "string" ? { tokenStandard } : {}),
      ...(openSeaMint ? { openSeaMint } : {})
    };
  } catch {
    return null;
  }
}

const OPEN_SEA_MINT_FETCH_TIMEOUT_MS = 8_000;
const OPEN_SEA_PAGE_USER_AGENT =
  "Mozilla/5.0 (compatible; FibreStyleMintParser/1.0; +https://opensea.io)";

const OPEN_SEA_STAGE_NAMES = [
  "Public stage",
  "Public sale",
  "Public mint",
  "Team phase",
  "Holder phase",
  "Team",
  "GTD",
  "FCFS",
  "Allowlist",
  "Whitelist",
  "Holder",
  "Holders",
  "Public"
];

function normalizeDisplayText(text: string) {
  return text
    .replace(/\\u003c/gi, "<")
    .replace(/\\u003e/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeStatusText(value: string): string {
  const normalized = value.toLowerCase();

  if (normalized.includes("minting now")) return "Minting Now";
  if (normalized.includes("minting soon")) return "Minting Soon";
  if (normalized.includes("sold out")) return "Sold Out";
  if (normalized.includes("mint ended")) return "Mint Ended";

  return value.trim();
}

function parseIntegerText(value?: string | null): number | undefined {
  if (!value) return undefined;

  const parsed = Number(value.replace(/,/g, ""));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseEthFromPriceText(priceText?: string): string | undefined {
  if (!priceText) return undefined;

  const match = priceText.match(/\b(\d+(?:\.\d+)?)\s*ETH\b/i);
  if (!match) return undefined;

  try {
    return ethers.formatEther(ethers.parseEther(match[1]!));
  } catch {
    return undefined;
  }
}

function getPriceText(text: string): string | undefined {
  const free = text.match(/\bFREE\b/i);
  if (free) return "Free";

  const eth = text.match(/\b\d+(?:\.\d+)?\s*ETH\b/i);
  if (eth) return eth[0].trim();

  const usd = text.match(/\$\s*\d+(?:\.\d+)?/);
  if (usd) return usd[0].replace(/\s+/g, "");

  return undefined;
}

function getLimitPerWallet(text: string): number | undefined {
  const match = text.match(/\bLIMIT\s+(\d[\d,]*)\s+PER\s+WALLET\b/i);
  return parseIntegerText(match?.[1]);
}

function getEligibilityText(text: string): string | undefined {
  if (/\bNOT\s+ELIGIBLE\b/i.test(text)) return "Not eligible";
  if (/\bELIGIBLE\b/i.test(text)) return "Eligible";
  return undefined;
}

function getMintStatusFromText(text: string): string | undefined {
  const match = text.match(/\b(Minting Now|Minting Soon|Mint Ended|Sold Out)\b/i);
  return match ? normalizeStatusText(match[1]!) : undefined;
}

function classifyStatusFromMintText(statusText?: string): MintPhaseStatus {
  const normalized = statusText?.toLowerCase() || "";

  if (normalized.includes("minting now")) return "live";
  if (normalized.includes("minting soon")) return "not_live_yet";
  if (normalized.includes("mint ended") || normalized.includes("sold out")) return "ended";

  return "unknown";
}

function classifyStageStatus(params: {
  stageText: string;
  mintStatusText?: string | undefined;
  isCurrentStage: boolean;
}): MintPhaseStatus {
  const text = params.stageText.toLowerCase();
  const overall = classifyStatusFromMintText(params.mintStatusText);

  if (text.includes("paused")) return "paused";
  if (text.includes("minting now") || params.isCurrentStage && overall === "live") {
    return "live";
  }
  if (text.includes("minting soon")) return "not_live_yet";
  if (text.includes("sold out") || text.includes("mint ended")) return "ended";
  if (/\bstarts\b/i.test(params.stageText) && overall !== "live") return "not_live_yet";
  if (/\bstarted\b/i.test(params.stageText) && !params.isCurrentStage) return "ended";

  return params.isCurrentStage ? overall : "unknown";
}

function getRawTimeText(text: string, label: "Started" | "Starts" | "Ends") {
  const pattern = new RegExp(
    `\\b${label}:?\\s+(.+?)(?=\\s+(?:FREE|\\$|\\d+(?:\\.\\d+)?\\s*ETH|LIMIT|ELIGIBLE|NOT\\s+ELIGIBLE|Minting\\s+Now|Minting\\s+Soon|Team\\b|GTD\\b|FCFS\\b|Allowlist\\b|Whitelist\\b|Holder\\b|Public\\b|$))`,
    "i"
  );
  const match = text.match(pattern);

  return match?.[1]?.trim();
}

function inferStageNameNearStatus(text: string, mintStatusText?: string) {
  if (!mintStatusText) return undefined;

  const statusIndex = text.toLowerCase().indexOf(mintStatusText.toLowerCase());
  if (statusIndex === -1) return undefined;

  const beforeStatus = text.slice(Math.max(0, statusIndex - 240), statusIndex);
  let bestMatch: { name: string; index: number } | undefined;

  for (const stageName of OPEN_SEA_STAGE_NAMES) {
    const matches = [...beforeStatus.matchAll(new RegExp(`\\b${stageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"))];
    const last = matches.at(-1);

    if (last?.index !== undefined && (!bestMatch || last.index > bestMatch.index)) {
      bestMatch = { name: stageName, index: last.index };
    }
  }

  return bestMatch?.name;
}

function buildOpenSeaMintStage(params: {
  stageName: string;
  stageText: string;
  mintStatusText?: string | undefined;
  isCurrentStage: boolean;
  confidence: Confidence;
}): OpenSeaMintStage {
  const phaseType = estimatePhaseTypeFromTexts([params.stageName, params.stageText], params.confidence);
  const priceText = getPriceText(params.stageText);
  const priceEth = parseEthFromPriceText(priceText);
  const limitPerWallet = getLimitPerWallet(params.stageText);
  const eligibilityText = getEligibilityText(params.stageText);
  const startTimeText =
    getRawTimeText(params.stageText, "Started") ||
    getRawTimeText(params.stageText, "Starts");
  const endTimeText = getRawTimeText(params.stageText, "Ends");

  return {
    stageName: params.stageName,
    phaseTypeEstimate: phaseType.phaseTypeEstimate,
    phaseTypeConfidence: phaseType.phaseTypeConfidence,
    status: classifyStageStatus({
      stageText: params.stageText,
      mintStatusText: params.mintStatusText,
      isCurrentStage: params.isCurrentStage
    }),
    ...(startTimeText ? { startTimeText } : {}),
    ...(endTimeText ? { endTimeText } : {}),
    ...(priceText ? { priceText } : {}),
    ...(priceEth ? { priceEth } : {}),
    ...(limitPerWallet !== undefined ? { limitPerWallet } : {}),
    ...(eligibilityText ? { eligibilityText } : {}),
    evidence: phaseType.phaseTypeEvidence
  };
}

function findOpenSeaMintStageWindows(text: string, mintStatusText?: string) {
  const stages: OpenSeaMintStage[] = [];
  const seen = new Set<string>();
  const currentStageName = inferStageNameNearStatus(text, mintStatusText);

  for (const stageName of OPEN_SEA_STAGE_NAMES) {
    const escaped = stageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = [...text.matchAll(new RegExp(`\\b${escaped}\\b`, "gi"))];

    for (const match of matches) {
      if (match.index === undefined) continue;

      const key = `${stageName.toLowerCase()}:${match.index}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const stageText = text.slice(match.index, match.index + 520).trim();
      const hasMintSignal =
        /\b(Started|Starts|Ends|FREE|\$|\d+(?:\.\d+)?\s*ETH|LIMIT\s+\d[\d,]*\s+PER\s+WALLET|ELIGIBLE|MINTING\s+NOW|MINTING\s+SOON)\b/i.test(stageText);

      if (!hasMintSignal) continue;

      stages.push(
        buildOpenSeaMintStage({
          stageName,
          stageText,
          mintStatusText,
          isCurrentStage:
            currentStageName?.toLowerCase() === stageName.toLowerCase() ||
            /\bMINTING\s+NOW\b/i.test(stageText),
          confidence: "medium"
        })
      );
    }
  }

  const byName = new Map<string, OpenSeaMintStage>();
  for (const stage of stages) {
    if (!stage.stageName) continue;

    const key = stage.stageName.toLowerCase();
    const existing = byName.get(key);
    const existingScore =
      (existing?.startTimeText ? 1 : 0) +
      (existing?.priceText ? 1 : 0) +
      (existing?.limitPerWallet ? 1 : 0) +
      (existing?.eligibilityText ? 1 : 0);
    const score =
      (stage.startTimeText ? 1 : 0) +
      (stage.priceText ? 1 : 0) +
      (stage.limitPerWallet ? 1 : 0) +
      (stage.eligibilityText ? 1 : 0);

    if (!existing || score > existingScore) {
      byName.set(key, stage);
    }
  }

  return [...byName.values()].slice(0, 10);
}

function extractOpenSeaMintFromText(
  rawText: string,
  metadataSource: OpenSeaMintMetadataSource,
  confidence: Confidence
): OpenSeaMintMetadata | null {
  const text = normalizeDisplayText(rawText);

  if (!text) return null;

  const mintStatusText = getMintStatusFromText(text);
  const mintedMatch =
    text.match(/\bItems\s+minted\s+(\d[\d,]*)\s*\/\s*(\d[\d,]*)\b/i) ||
    text.match(/\b(\d[\d,]*)\s*\/\s*(\d[\d,]*)\b/);
  const mintedCount = parseIntegerText(mintedMatch?.[1]);
  const maxSupply = parseIntegerText(mintedMatch?.[2]);
  const mintSchedule = findOpenSeaMintStageWindows(text, mintStatusText);
  const currentStageName = inferStageNameNearStatus(text, mintStatusText);
  const statusIndex = mintStatusText
    ? text.toLowerCase().indexOf(mintStatusText.toLowerCase())
    : -1;
  const currentWindow =
    statusIndex === -1
      ? ""
      : text.slice(Math.max(0, statusIndex - 240), statusIndex + 240);
  const currentStage =
    mintSchedule.find(
      (stage) =>
        currentStageName &&
        stage.stageName?.toLowerCase() === currentStageName.toLowerCase()
    ) ||
    mintSchedule.find((stage) => stage.status === "live");
  const currentStagePriceText =
    currentStage?.priceText ||
    getPriceText(currentWindow) ||
    undefined;
  const currentStagePriceEth = parseEthFromPriceText(currentStagePriceText);
  const currentStageLimitPerWallet =
    currentStage?.limitPerWallet || getLimitPerWallet(currentWindow);
  const rawTimeZoneText = text.match(/\bGMT[+-]\d+\b/i)?.[0];
  const hasMintData =
    mintStatusText ||
    mintedCount !== undefined ||
    maxSupply !== undefined ||
    currentStageName ||
    currentStagePriceText ||
    currentStageLimitPerWallet !== undefined ||
    mintSchedule.length > 0;

  if (!hasMintData) {
    return null;
  }

  return {
    ...(mintStatusText ? { mintStatusText } : {}),
    ...(mintedCount !== undefined ? { mintedCount } : {}),
    ...(maxSupply !== undefined ? { maxSupply } : {}),
    ...(currentStageName ? { currentStageName } : {}),
    ...(currentStagePriceText ? { currentStagePriceText } : {}),
    ...(currentStagePriceEth ? { currentStagePriceEth } : {}),
    ...(currentStageLimitPerWallet !== undefined
      ? { currentStageLimitPerWallet }
      : {}),
    mintSchedule,
    ...(rawTimeZoneText ? { rawTimeZoneText } : {}),
    metadataSource,
    confidence
  };
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function extractJsonScriptText(html: string) {
  const texts: string[] = [];
  const nextData = html.match(
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  );

  if (nextData?.[1]) {
    try {
      texts.push(JSON.stringify(JSON.parse(nextData[1])));
    } catch {
      texts.push(nextData[1]);
    }
  }

  for (const match of html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )) {
    if (match[1]) {
      texts.push(match[1]);
    }
  }

  for (const match of html.matchAll(
    /<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi
  )) {
    if (match[1]) {
      texts.push(match[1]);
    }
  }

  for (const match of html.matchAll(/<script(?![^>]+\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    const scriptText = match[1];

    if (
      scriptText &&
      /\b(minting now|minting soon|public stage|team|gtd|allowlist|whitelist|limit per wallet|eligible|items minted)\b/i.test(scriptText)
    ) {
      texts.push(scriptText.slice(0, 1_000_000));
    }
  }

  return texts;
}

function extractOpenGraphText(html: string) {
  const texts: string[] = [];

  for (const match of html.matchAll(
    /<meta[^>]+(?:property|name)=["'](?:og:title|og:description|description|twitter:title|twitter:description)["'][^>]+content=["']([^"']+)["'][^>]*>/gi
  )) {
    if (match[1]) {
      texts.push(match[1]);
    }
  }

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (title) {
    texts.push(title);
  }

  return texts;
}

function extractOpenSeaCollectionNameFromHtml(html: string): string | undefined {
  for (const text of extractOpenGraphText(html)) {
    const normalized = normalizeDisplayText(text);
    const withoutOpenSea = normalized
      .replace(/\s*\|\s*OpenSea.*$/i, "")
      .replace(/\s*-\s*OpenSea.*$/i, "")
      .trim();
    const collectionMatch = withoutOpenSea.match(/^(.+?)\s*[-|]\s*(?:NFT\s+)?Collection\b/i);
    const candidate = collectionMatch?.[1]?.trim() || withoutOpenSea;

    if (
      candidate &&
      candidate.length <= 80 &&
      !/^opensea$/i.test(candidate) &&
      !/^the largest nft marketplace/i.test(candidate)
    ) {
      return candidate;
    }
  }

  return undefined;
}

async function fetchOpenSeaPageMintMetadata(
  slug: string
): Promise<OpenSeaMintMetadata | null> {
  const urls = [
    `https://opensea.io/collection/${encodeURIComponent(slug)}/overview`,
    `https://opensea.io/collection/${encodeURIComponent(slug)}/mint`,
    `https://opensea.io/collection/${encodeURIComponent(slug)}`
  ];
  const warnings: string[] = [];

  for (const url of urls) {
    try {
      const response = await fetchWithTimeout(
        url,
        {
          method: "GET",
          headers: {
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "user-agent": OPEN_SEA_PAGE_USER_AGENT
          }
        },
        OPEN_SEA_MINT_FETCH_TIMEOUT_MS
      );

      if (!response.ok) {
        warnings.push(`OpenSea page fetch returned HTTP ${response.status}.`);
        continue;
      }

      const html = await response.text();
      const collectionName = extractOpenSeaCollectionNameFromHtml(html);
      const embeddedText = extractJsonScriptText(html).join(" ");
      const embeddedMetadata = extractOpenSeaMintFromText(
        embeddedText,
        "opensea_page_embedded_json",
        "medium"
      );

      if (embeddedMetadata) {
        return {
          ...embeddedMetadata,
          ...(collectionName ? { collectionName } : {}),
          warnings: [...(embeddedMetadata.warnings || []), ...warnings]
        };
      }

      const pageText = [
        ...extractOpenGraphText(html),
        normalizeDisplayText(html)
      ].join(" ");
      const textMetadata = extractOpenSeaMintFromText(
        pageText,
        "opensea_page_text",
        "low"
      );

      if (textMetadata) {
        return {
          ...textMetadata,
          ...(collectionName ? { collectionName } : {}),
          warnings: [...(textMetadata.warnings || []), ...warnings]
        };
      }
    } catch (error) {
      warnings.push(`OpenSea page metadata unavailable: ${getMintSafeErrorReason(error)}`);
    }
  }

  return warnings.length > 0
    ? {
        mintSchedule: [],
        metadataSource: "unknown",
        confidence: "unknown",
        warnings: warnings.slice(0, 3)
      }
    : null;
}

function getReservoirBaseUrl(chainName: DetectedChainName) {
  if (chainName === "base") return "https://api-base.reservoir.tools";
  if (chainName === "arbitrum") return "https://api-arbitrum.reservoir.tools";
  if (chainName === "polygon") return "https://api-polygon.reservoir.tools";
  if (chainName === "sepolia") return "https://api-sepolia.reservoir.tools";
  return "https://api.reservoir.tools";
}

async function fetchReservoirMintMetadata(params: {
  slug?: string;
  contractAddress?: string;
  chainName: DetectedChainName;
}): Promise<OpenSeaMintMetadata | null> {
  const apiKey = process.env.RESERVOIR_API_KEY;

  if (!apiKey) return null;

  const baseUrl = getReservoirBaseUrl(params.chainName);
  const urls: string[] = [];

  if (params.contractAddress) {
    urls.push(
      `${baseUrl}/collections/v7?id=${encodeURIComponent(params.contractAddress)}`,
      `${baseUrl}/collections/${encodeURIComponent(params.contractAddress)}/mint/v1`
    );
  }

  if (params.slug) {
    urls.push(`${baseUrl}/collections/v7?slug=${encodeURIComponent(params.slug)}`);
  }

  const warnings: string[] = [];

  for (const url of urls) {
    try {
      const response = await fetchWithTimeout(
        url,
        {
          method: "GET",
          headers: {
            accept: "application/json",
            "x-api-key": apiKey
          }
        },
        OPEN_SEA_MINT_FETCH_TIMEOUT_MS
      );

      if (response.status === 401 || response.status === 403 || response.status === 429) {
        warnings.push(`Reservoir mint metadata returned HTTP ${response.status}.`);
        continue;
      }

      if (!response.ok) {
        continue;
      }

      const data = await response.json();
      const metadata = extractOpenSeaMintFromText(
        JSON.stringify(data),
        "reservoir",
        "high"
      );

      if (metadata) {
        return {
          ...metadata,
          warnings: [...(metadata.warnings || []), ...warnings]
        };
      }
    } catch (error) {
      warnings.push(`Reservoir mint metadata unavailable: ${getMintSafeErrorReason(error)}`);
    }
  }

  return warnings.length > 0
    ? {
        mintSchedule: [],
        metadataSource: "unknown",
        confidence: "unknown",
        warnings: warnings.slice(0, 3)
      }
    : null;
}

async function fetchOpenSeaMintMetadata(params: {
  slug: string;
  contractAddress?: string;
  chainName: DetectedChainName;
}): Promise<OpenSeaMintMetadata | null> {
  const reservoir = await fetchReservoirMintMetadata(params);

  if (reservoir && reservoir.metadataSource === "reservoir") {
    return reservoir;
  }

  const page = await fetchOpenSeaPageMintMetadata(params.slug);

  if (page && page.metadataSource !== "unknown") {
    return page;
  }

  if (reservoir || page) {
    const warnings = [
      ...(reservoir?.warnings || []),
      ...(page?.warnings || [])
    ].slice(0, 5);

    return warnings.length > 0
      ? {
          mintSchedule: [],
          metadataSource: "unknown",
          confidence: "unknown",
          warnings
        }
      : null;
  }

  return null;
}

export function getFunctionSelector(signature: SupportedMintFunctionSignature) {
  return ethers.id(signature).slice(0, 10);
}

export async function detectMintFunctions(params: {
  contractAddress: string;
  chain: MintChain;
}): Promise<{
  contractExists: boolean;
  candidateFunctions: MintFunctionCandidate[];
  warnings: string[];
}> {
  const warnings: string[] = [];
  const contractAddress = ethers.getAddress(params.contractAddress);
  const provider = getMintProvider(params.chain);

  try {
    const code = await provider.getCode(contractAddress);

    if (code === "0x") {
      return {
        contractExists: false,
        candidateFunctions: [],
        warnings: ["No contract code found at this address on the selected chain."]
      };
    }

    const bytecode = code.toLowerCase();
    const candidateFunctions = SUPPORTED_MINT_FUNCTION_SIGNATURES.map((signature) => {
      const selector = getFunctionSelector(signature);
      const foundInBytecode = bytecode.includes(selector.slice(2).toLowerCase());

      return {
        signature,
        selector,
        foundInBytecode,
        confidence: foundInBytecode ? "medium" : "low" as Confidence
      };
    });

    return {
      contractExists: true,
      candidateFunctions,
      warnings
    };
  } catch (error) {
    warnings.push(`Could not read contract bytecode: ${getMintSafeErrorReason(error)}`);
    return {
      contractExists: false,
      candidateFunctions: SUPPORTED_MINT_FUNCTION_SIGNATURES.map((signature) => ({
        signature,
        selector: getFunctionSelector(signature),
        foundInBytecode: false,
        confidence: "unknown"
      })),
      warnings
    };
  }
}

function getFirstPhaseTime(
  fields: Array<{ name: string; iso?: string }>,
  pattern: "start" | "end"
) {
  return fields.find((field) => field.name.toLowerCase().includes(pattern))?.iso;
}

export async function detectMint(
  input: string,
  walletAddress?: string
): Promise<MintDetectionResult> {
  const parsed = parseMintInput(input);
  const warnings = [...parsed.warnings];
  let collectionName = parsed.collectionName;
  let collectionSlug = parsed.collectionSlug;
  let contractAddress = parsed.contractAddress;
  let contractConfidence = parsed.contractConfidence;
  let tokenStandard: string | undefined;
  let chainName = parsed.chainName;
  let chainId = parsed.chainId;
  let chainConfidence = parsed.chainConfidence;
  let openSeaMint: OpenSeaMintMetadata | undefined;
  let candidateFunctions: MintFunctionCandidate[] = [];
  let priceEth: string | undefined;
  let phaseStatus: MintPhaseStatus = "unknown";
  let phaseTypeEstimate: MintPhaseTypeEstimate = "unknown";
  let phaseTypeConfidence: Confidence = "unknown";
  let phaseTypeEvidence =
    "GTD/FCFS/Public phase type could not be safely detected. The project may use custom phase naming or off-chain mint logic.";
  let startTime: string | undefined;
  let endTime: string | undefined;
  let mintConfidence: Confidence = "unknown";

  if (parsed.platform === "opensea" && collectionSlug && !contractAddress) {
    const details = await fetchOpenSeaCollectionDetails(collectionSlug);

    if (details) {
      collectionName = details.name || collectionName;
      collectionSlug = details.collectionSlug || collectionSlug;

      if (details.contractAddress) {
        contractAddress = details.contractAddress;
        contractConfidence = "medium";
      }

      if (details.chainName) {
        chainName = details.chainName;
        chainId = getChainId(details.chainName);
        chainConfidence = "medium";
      }

      tokenStandard = details.tokenStandard || tokenStandard;
      openSeaMint = details.openSeaMint || openSeaMint;
    } else {
      warnings.push("OpenSea collection details could not be fetched or API key is not configured.");
    }
  }

  if (parsed.platform === "opensea" && collectionSlug) {
    const mintMetadata = await fetchOpenSeaMintMetadata({
      slug: collectionSlug,
      ...(contractAddress ? { contractAddress } : {}),
      chainName
    });

    if (mintMetadata) {
      if (mintMetadata.metadataSource === "unknown") {
        warnings.push(...(mintMetadata.warnings || []));
      } else {
        openSeaMint = mintMetadata || openSeaMint;
        collectionName = collectionName || mintMetadata.collectionName;
        priceEth = mintMetadata.currentStagePriceEth || priceEth;
        const metadataStatus = classifyStatusFromMintText(mintMetadata.mintStatusText);
        const liveStage = mintMetadata.mintSchedule.find(
          (stage) => stage.status === "live"
        );
        const currentStage = mintMetadata.currentStageName
          ? mintMetadata.mintSchedule.find(
              (stage) =>
                stage.stageName?.toLowerCase() ===
                mintMetadata.currentStageName?.toLowerCase()
            )
          : liveStage;
        const stagePhaseType = currentStage
          ? estimatePhaseTypeFromTexts(
              [currentStage.stageName || "", currentStage.evidence || ""],
              currentStage.phaseTypeConfidence
            )
          : mintMetadata.currentStageName
            ? estimatePhaseTypeFromTexts(
                [mintMetadata.currentStageName],
                mintMetadata.confidence
              )
            : null;

        if (metadataStatus !== "unknown") {
          phaseStatus = metadataStatus;
        } else if (liveStage) {
          phaseStatus = liveStage.status;
        }

        if (stagePhaseType && stagePhaseType.phaseTypeEstimate !== "unknown") {
          phaseTypeEstimate = stagePhaseType.phaseTypeEstimate;
          phaseTypeConfidence = stagePhaseType.phaseTypeConfidence;
          phaseTypeEvidence = stagePhaseType.phaseTypeEvidence;
        }

        startTime = currentStage?.startTimeText || startTime;
        endTime = currentStage?.endTimeText || endTime;
        mintConfidence = mintMetadata.confidence;
        warnings.push(...(mintMetadata.warnings || []));
      }
    } else {
      warnings.push("OpenSea public mint page metadata was not detected.");
    }
  }

  const supportedChain = toSupportedMintChain(chainName);
  const evidenceTexts = [
    input,
    collectionName || "",
    collectionSlug || "",
    parsed.sourceUrl || "",
    openSeaMint?.mintStatusText || "",
    openSeaMint?.currentStageName || "",
    ...(openSeaMint?.mintSchedule.map((stage) => stage.stageName || "") || [])
  ];

  if (contractAddress && supportedChain) {
    const functionResult = await detectMintFunctions({
      contractAddress,
      chain: supportedChain
    });
    candidateFunctions = functionResult.candidateFunctions;
    warnings.push(...functionResult.warnings);

    try {
      const phase = await detectMintPhase({
        contractAddress,
        chain: supportedChain,
        evidenceTexts
      });
      phaseStatus = phaseStatus !== "unknown" ? phaseStatus : phase.phaseStatus;

      if (phaseTypeEstimate === "unknown") {
        phaseTypeEstimate = phase.phaseTypeEstimate;
        phaseTypeConfidence = phase.phaseTypeConfidence;
        phaseTypeEvidence = phase.phaseTypeEvidence;
      }

      priceEth = priceEth || phase.detectedPrices[0]?.eth;
      startTime = startTime || getFirstPhaseTime(phase.detectedTimes, "start");
      endTime = endTime || getFirstPhaseTime(phase.detectedTimes, "end");
      mintConfidence =
        mintConfidence !== "unknown"
          ? mintConfidence
          : candidateFunctions.some((candidate) => candidate.foundInBytecode) ||
              phase.confidence !== "unknown"
            ? "medium"
            : "unknown";
      warnings.push(...phase.warnings);
    } catch (error) {
      warnings.push(`Phase detection failed: ${getMintSafeErrorReason(error)}`);
    }
  } else {
    const phaseType = estimatePhaseTypeFromTexts(evidenceTexts, "low");
    phaseTypeEstimate = phaseType.phaseTypeEstimate;
    phaseTypeConfidence = phaseType.phaseTypeConfidence;
    phaseTypeEvidence = phaseType.phaseTypeEvidence;

    if (contractAddress && !supportedChain) {
      warnings.push("Read-only function and phase detection currently supports mainnet and sepolia only.");
    }
  }

  return {
    input,
    detectedAt: new Date().toISOString(),
    warnings,
    source: {
      platform: parsed.platform,
      ...(parsed.sourceUrl ? { sourceUrl: parsed.sourceUrl } : {}),
      confidence: parsed.platform === "unknown" ? "unknown" : "medium"
    },
    chain: {
      name: chainName,
      ...(chainId ? { chainId } : {}),
      confidence: chainConfidence
    },
    contract: {
      ...(contractAddress ? { address: contractAddress } : {}),
      ...(collectionSlug ? { collectionSlug } : {}),
      ...(collectionName ? { collectionName } : {}),
      ...(tokenStandard ? { tokenStandard } : {}),
      ...(parsed.tokenId ? { tokenId: parsed.tokenId } : {}),
      confidence: contractConfidence
    },
    mint: {
      candidateFunctions,
      ...(priceEth ? { priceEth } : {}),
      phaseStatus,
      phaseTypeEstimate,
      phaseTypeConfidence,
      phaseTypeEvidence,
      ...(startTime ? { startTime } : {}),
      ...(endTime ? { endTime } : {}),
      ...(openSeaMint ? { openSeaMint } : {}),
      confidence: mintConfidence
    },
    ...(walletAddress && ethers.isAddress(walletAddress)
      ? {
          eligibility: {
            walletAddress: ethers.getAddress(walletAddress),
            estimate: "not_checked",
            reason:
              "Wallet supplied, but eligibility requires a complete target and gas-estimation check."
          }
        }
      : {})
  };
}
