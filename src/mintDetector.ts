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

    return {
      ...(typeof collection.name === "string" ? { name: collection.name } : {}),
      collectionSlug: slug,
      ...(contract && ethers.isAddress(contract)
        ? { contractAddress: ethers.getAddress(contract) }
        : {}),
      ...(chain.name !== "unknown" ? { chainName: chain.name } : {})
    };
  } catch {
    return null;
  }
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
  let chainName = parsed.chainName;
  let chainId = parsed.chainId;
  let chainConfidence = parsed.chainConfidence;
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
    } else {
      warnings.push("OpenSea collection details could not be fetched or API key is not configured.");
    }
  }

  const supportedChain = toSupportedMintChain(chainName);
  const evidenceTexts = [
    input,
    collectionName || "",
    collectionSlug || "",
    parsed.sourceUrl || ""
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
      phaseStatus = phase.phaseStatus;
      phaseTypeEstimate = phase.phaseTypeEstimate;
      phaseTypeConfidence = phase.phaseTypeConfidence;
      phaseTypeEvidence = phase.phaseTypeEvidence;
      priceEth = phase.detectedPrices[0]?.eth;
      startTime = getFirstPhaseTime(phase.detectedTimes, "start");
      endTime = getFirstPhaseTime(phase.detectedTimes, "end");
      mintConfidence =
        candidateFunctions.some((candidate) => candidate.foundInBytecode) ||
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
