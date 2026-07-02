import { ethers } from "ethers";
import type { MintChain } from "./mintEngine.js";
import { getMintProvider, getMintSafeErrorReason } from "./mintEngine.js";

export type Confidence = "high" | "medium" | "low" | "unknown";

export type MintPhaseStatus =
  | "live"
  | "not_live_yet"
  | "ended"
  | "paused"
  | "unknown";

export type MintPhaseTypeEstimate =
  | "team_phase"
  | "holder_phase"
  | "gtd_phase"
  | "fcfs_phase"
  | "public_phase"
  | "unknown";

export type DetectedBooleanField = {
  name: string;
  value: boolean;
};

export type DetectedTimeField = {
  name: string;
  value: string;
  iso?: string;
};

export type DetectedPriceField = {
  name: string;
  wei: string;
  eth: string;
};

export type DetectedSupplyField = {
  name: string;
  value: string;
};

export type PhaseTypeEstimateResult = {
  phaseTypeEstimate: MintPhaseTypeEstimate;
  phaseTypeConfidence: Confidence;
  phaseTypeEvidence: string;
};

export type MintPhaseDetectionResult = {
  contractAddress: string;
  chain: MintChain;
  detectedBooleans: DetectedBooleanField[];
  detectedTimes: DetectedTimeField[];
  detectedPrices: DetectedPriceField[];
  detectedSupply: DetectedSupplyField[];
  currentTime: string;
  phaseStatus: MintPhaseStatus;
  phaseTypeEstimate: MintPhaseTypeEstimate;
  phaseTypeConfidence: Confidence;
  phaseTypeEvidence: string;
  summary: string;
  confidence: Confidence;
  warnings: string[];
};

type PhaseAliasConfig = {
  estimate: MintPhaseTypeEstimate;
  aliases: string[];
  defaultEvidence: string;
};

const BOOLEAN_PHASE_FUNCTIONS = [
  "saleIsActive",
  "publicSaleActive",
  "publicSaleIsActive",
  "isPublicSaleActive",
  "mintOpen",
  "mintingOpen",
  "publicMintOpen",
  "paused",
  "mintPaused"
];

const TIME_PHASE_FUNCTIONS = [
  "startTime",
  "saleStartTime",
  "publicSaleStartTime",
  "publicMintStartTime",
  "mintStartTime",
  "endTime",
  "saleEndTime",
  "publicSaleEndTime",
  "publicMintEndTime"
];

const PRICE_PHASE_FUNCTIONS = [
  "price",
  "mintPrice",
  "publicMintPrice",
  "publicPrice",
  "cost",
  "mintCost"
];

const SUPPLY_PHASE_FUNCTIONS = [
  "totalSupply",
  "maxSupply",
  "maxMintSupply",
  "collectionSize"
];

const PHASE_ALIAS_CONFIGS: PhaseAliasConfig[] = [
  {
    estimate: "team_phase",
    aliases: [
      "team",
      "team mint",
      "team phase",
      "reserved",
      "reserve",
      "treasury",
      "founder",
      "founders",
      "partner",
      "partners",
      "collab",
      "collaborators",
      "internal",
      "allocation",
      "team allocation"
    ],
    defaultEvidence: "Likely team/reserved allocation phase. Normal users may not be eligible."
  },
  {
    estimate: "holder_phase",
    aliases: [
      "holder",
      "holders",
      "holder mint",
      "holder phase",
      "token gated",
      "token-gated",
      "nft gated",
      "nft-gated",
      "gated",
      "collection holders",
      "holders only",
      "bayc holders",
      "brain rot holders",
      "mutant holders",
      "ape holders",
      "allow holders",
      "eligible holders",
      "snapshot holders"
    ],
    defaultEvidence: "Likely holder-gated phase, but holder eligibility must be checked separately."
  },
  {
    estimate: "gtd_phase",
    aliases: [
      "gtd",
      "guaranteed",
      "guaranteed mint",
      "allowlist",
      "whitelist",
      "wl",
      "premint",
      "pre-mint",
      "vip",
      "og",
      "early access",
      "presale",
      "pre sale",
      "phase1",
      "phase 1"
    ],
    defaultEvidence: "Likely GTD/allowlist-style phase, but not guaranteed."
  },
  {
    estimate: "fcfs_phase",
    aliases: [
      "fcfs",
      "first come",
      "first-come",
      "first come first served",
      "first-come-first-served",
      "limited allowlist",
      "limited spots",
      "fcfs allowlist",
      "fcfs wl",
      "phase2",
      "phase 2"
    ],
    defaultEvidence: "Likely FCFS-style phase, but not guaranteed."
  },
  {
    estimate: "public_phase",
    aliases: [
      "public",
      "public sale",
      "public mint",
      "open mint",
      "open sale",
      "general",
      "general sale",
      "free for all",
      "free-for-all",
      "phase3",
      "phase 3"
    ],
    defaultEvidence: "Likely public/open mint phase, but not guaranteed."
  }
];

function normalizeEvidenceText(text: string) {
  return text
    .toLowerCase()
    .replace(/[_/:-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textContainsAlias(text: string, alias: string) {
  const normalizedText = normalizeEvidenceText(text);
  const normalizedAlias = normalizeEvidenceText(alias);
  const escaped = normalizedAlias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`, "i").test(normalizedText);
}

export function estimatePhaseTypeFromTexts(
  evidenceTexts: string[],
  confidence: Confidence = "low"
): PhaseTypeEstimateResult {
  const safeTexts = evidenceTexts
    .filter((text) => typeof text === "string" && text.trim())
    .slice(0, 20);

  for (const config of PHASE_ALIAS_CONFIGS) {
    for (const text of safeTexts) {
      const alias = config.aliases.find((candidate) =>
        textContainsAlias(text, candidate)
      );

      if (alias) {
        return {
          phaseTypeEstimate: config.estimate,
          phaseTypeConfidence: confidence,
          phaseTypeEvidence: `${config.defaultEvidence} Evidence: "${alias}".`
        };
      }
    }
  }

  return {
    phaseTypeEstimate: "unknown",
    phaseTypeConfidence: "unknown",
    phaseTypeEvidence:
      "GTD/FCFS/Public phase type could not be safely detected. The project may use custom phase naming or off-chain mint logic."
  };
}

function formatTimestamp(value: bigint): string | undefined {
  const timestamp = Number(value);

  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    return undefined;
  }

  const timestampMs = timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
  return new Date(timestampMs).toISOString();
}

async function callReadFunction<T>(
  provider: ethers.Provider,
  contractAddress: string,
  functionName: string,
  returnType: string
): Promise<T | null> {
  const iface = new ethers.Interface([
    `function ${functionName}() view returns (${returnType})`
  ]);
  const data = iface.encodeFunctionData(functionName, []);

  try {
    const result = await provider.call({
      to: contractAddress,
      data
    });
    const decoded = iface.decodeFunctionResult(functionName, result);
    return decoded[0] as T;
  } catch {
    return null;
  }
}

function classifyPhaseStatus(params: {
  booleans: DetectedBooleanField[];
  times: DetectedTimeField[];
  currentTimeSeconds: number;
}): MintPhaseStatus {
  const paused = params.booleans.find(
    (field) =>
      (field.name === "paused" || field.name === "mintPaused") && field.value
  );

  if (paused) {
    return "paused";
  }

  const activeSale = params.booleans.find(
    (field) =>
      !field.name.toLowerCase().includes("paused") &&
      field.value
  );

  if (activeSale) {
    return "live";
  }

  const startTimes = params.times
    .filter((field) => field.name.toLowerCase().includes("start"))
    .map((field) => Number(field.value))
    .filter((value) => Number.isFinite(value) && value > 0);

  if (startTimes.some((value) => value > params.currentTimeSeconds)) {
    return "not_live_yet";
  }

  const endTimes = params.times
    .filter((field) => field.name.toLowerCase().includes("end"))
    .map((field) => Number(field.value))
    .filter((value) => Number.isFinite(value) && value > 0);

  if (endTimes.some((value) => value <= params.currentTimeSeconds)) {
    return "ended";
  }

  return "unknown";
}

function getPhaseSummary(
  phaseStatus: MintPhaseStatus,
  hasDetectedFields: boolean
) {
  if (!hasDetectedFields) {
    return "No standard phase fields were detected. The project may use custom mint logic or off-chain allowlist APIs.";
  }

  if (phaseStatus === "live") {
    return "A standard public sale/open mint boolean appears active. This is not a guarantee of wallet eligibility.";
  }

  if (phaseStatus === "not_live_yet") {
    return "A standard start time appears to be in the future.";
  }

  if (phaseStatus === "ended") {
    return "A standard end time appears to have passed.";
  }

  if (phaseStatus === "paused") {
    return "A standard pause flag appears enabled.";
  }

  return "Some standard phase fields were detected, but the live status could not be safely classified.";
}

export async function detectMintPhase(params: {
  contractAddress: string;
  chain: MintChain;
  evidenceTexts?: string[];
}): Promise<MintPhaseDetectionResult> {
  const warnings: string[] = [];
  const contractAddress = ethers.getAddress(params.contractAddress);
  const provider = getMintProvider(params.chain);
  const currentTimeSeconds = Math.floor(Date.now() / 1000);
  const detectedBooleans: DetectedBooleanField[] = [];
  const detectedTimes: DetectedTimeField[] = [];
  const detectedPrices: DetectedPriceField[] = [];
  const detectedSupply: DetectedSupplyField[] = [];

  try {
    const code = await provider.getCode(contractAddress);

    if (code === "0x") {
      warnings.push("No contract code found at this address on the selected chain.");
    }
  } catch (error) {
    warnings.push(`Could not verify contract code: ${getMintSafeErrorReason(error)}`);
  }

  for (const functionName of BOOLEAN_PHASE_FUNCTIONS) {
    const value = await callReadFunction<boolean>(
      provider,
      contractAddress,
      functionName,
      "bool"
    );

    if (typeof value === "boolean") {
      detectedBooleans.push({ name: functionName, value });
    }
  }

  for (const functionName of TIME_PHASE_FUNCTIONS) {
    const value = await callReadFunction<bigint>(
      provider,
      contractAddress,
      functionName,
      "uint256"
    );

    if (typeof value === "bigint") {
      const iso = formatTimestamp(value);
      detectedTimes.push({
        name: functionName,
        value: value.toString(),
        ...(iso ? { iso } : {})
      });
    }
  }

  for (const functionName of PRICE_PHASE_FUNCTIONS) {
    const value = await callReadFunction<bigint>(
      provider,
      contractAddress,
      functionName,
      "uint256"
    );

    if (typeof value === "bigint") {
      detectedPrices.push({
        name: functionName,
        wei: value.toString(),
        eth: ethers.formatEther(value)
      });
    }
  }

  for (const functionName of SUPPLY_PHASE_FUNCTIONS) {
    const value = await callReadFunction<bigint>(
      provider,
      contractAddress,
      functionName,
      "uint256"
    );

    if (typeof value === "bigint") {
      detectedSupply.push({
        name: functionName,
        value: value.toString()
      });
    }
  }

  const phaseStatus = classifyPhaseStatus({
    booleans: detectedBooleans,
    times: detectedTimes,
    currentTimeSeconds
  });
  const hasDetectedFields =
    detectedBooleans.length > 0 ||
    detectedTimes.length > 0 ||
    detectedPrices.length > 0 ||
    detectedSupply.length > 0;
  const phaseType = estimatePhaseTypeFromTexts(params.evidenceTexts || [], "low");

  return {
    contractAddress,
    chain: params.chain,
    detectedBooleans,
    detectedTimes,
    detectedPrices,
    detectedSupply,
    currentTime: new Date(currentTimeSeconds * 1000).toISOString(),
    phaseStatus,
    phaseTypeEstimate: phaseType.phaseTypeEstimate,
    phaseTypeConfidence: phaseType.phaseTypeConfidence,
    phaseTypeEvidence: phaseType.phaseTypeEvidence,
    summary: getPhaseSummary(phaseStatus, hasDetectedFields),
    confidence: hasDetectedFields ? "medium" : "unknown",
    warnings
  };
}
