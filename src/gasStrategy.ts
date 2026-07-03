import { ethers } from "ethers";

export type GasStrategyMode = "auto" | "standard" | "fast" | "custom";

export type GasStrategy = {
  mode: GasStrategyMode;
  maxFeeGwei?: string;
  maxPriorityFeeGwei?: string;
  gasLimitMultiplier: number;
  createdAt: string;
  updatedAt: string;
};

export type MintGasTransactionLike = {
  to: string;
  data: string;
  value: bigint;
};

export type ResolvedGasOverrides = {
  gasLimit: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
  estimatedGasUnits: bigint;
  gasLimitMultiplier: number;
};

export type GasPreviewResult = {
  mode: GasStrategyMode;
  estimatedGasUnits: string;
  gasLimit: string;
  maxFeeGwei?: string;
  maxPriorityFeeGwei?: string;
  gasPriceGwei?: string;
  estimatedGasCostWei: bigint;
  estimatedGasCostEth: string;
  mintCostWei: bigint;
  mintCostEth: string;
  estimatedTotalCostWei: bigint;
  estimatedTotalCostEth: string;
  walletBalanceWei?: bigint;
  walletBalanceEth?: string;
  fundedEnough?: boolean;
};

const DEFAULT_GAS_LIMIT_MULTIPLIER = 1.15;
const MAX_GAS_LIMIT_MULTIPLIER = 2;
const MIN_GAS_LIMIT_MULTIPLIER = 1;
const MAX_CUSTOM_MAX_FEE_GWEI = 300;
const MAX_CUSTOM_PRIORITY_FEE_GWEI = 50;

export function createDefaultGasStrategy(now = new Date().toISOString()): GasStrategy {
  return {
    mode: "auto",
    gasLimitMultiplier: DEFAULT_GAS_LIMIT_MULTIPLIER,
    createdAt: now,
    updatedAt: now
  };
}

function normalizeGasMode(rawMode: string): GasStrategyMode {
  const mode = rawMode.trim().toLowerCase();

  if (mode === "auto" || mode === "standard" || mode === "fast" || mode === "custom") {
    return mode;
  }

  throw new Error("Gas mode must be auto, standard, fast, or custom.");
}

function normalizeDecimalGwei(rawValue: string, label: string, maxValue: number) {
  const normalized = rawValue.trim();

  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized)) {
    throw new Error(`${label} must be a positive decimal gwei value.`);
  }

  const numeric = Number(normalized);

  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`${label} must be greater than 0.`);
  }

  if (numeric > maxValue) {
    throw new Error(`${label} is above the safety cap of ${maxValue} gwei.`);
  }

  ethers.parseUnits(normalized, "gwei");
  return normalized;
}

function normalizeGasLimitMultiplier(rawValue: unknown) {
  const numeric = Number(rawValue ?? DEFAULT_GAS_LIMIT_MULTIPLIER);

  if (!Number.isFinite(numeric)) {
    return DEFAULT_GAS_LIMIT_MULTIPLIER;
  }

  return Math.min(Math.max(numeric, MIN_GAS_LIMIT_MULTIPLIER), MAX_GAS_LIMIT_MULTIPLIER);
}

export function normalizeGasStrategy(raw: unknown): GasStrategy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return createDefaultGasStrategy();
  }

  const source = raw as Record<string, unknown>;
  const mode =
    typeof source.mode === "string" ? normalizeGasMode(source.mode) : "auto";
  const now = new Date().toISOString();
  const createdAt =
    typeof source.createdAt === "string" ? source.createdAt : now;
  const updatedAt =
    typeof source.updatedAt === "string" ? source.updatedAt : createdAt;
  const gasLimitMultiplier = normalizeGasLimitMultiplier(source.gasLimitMultiplier);

  if (mode !== "custom") {
    return {
      mode,
      gasLimitMultiplier,
      createdAt,
      updatedAt
    };
  }

  if (typeof source.maxFeeGwei !== "string" || typeof source.maxPriorityFeeGwei !== "string") {
    return createDefaultGasStrategy();
  }

  const maxFeeGwei = normalizeDecimalGwei(
    source.maxFeeGwei,
    "maxFeeGwei",
    MAX_CUSTOM_MAX_FEE_GWEI
  );
  const maxPriorityFeeGwei = normalizeDecimalGwei(
    source.maxPriorityFeeGwei,
    "maxPriorityFeeGwei",
    MAX_CUSTOM_PRIORITY_FEE_GWEI
  );

  if (ethers.parseUnits(maxFeeGwei, "gwei") < ethers.parseUnits(maxPriorityFeeGwei, "gwei")) {
    return createDefaultGasStrategy();
  }

  return {
    mode,
    maxFeeGwei,
    maxPriorityFeeGwei,
    gasLimitMultiplier,
    createdAt,
    updatedAt
  };
}

export function parseGasStrategyInput(parts: string[], startIndex = 2): GasStrategy {
  const rawMode = parts[startIndex]?.trim();

  if (!rawMode) {
    throw new Error("Gas mode is required.");
  }

  const mode = normalizeGasMode(rawMode);
  const now = new Date().toISOString();

  if (mode !== "custom") {
    return {
      mode,
      gasLimitMultiplier: DEFAULT_GAS_LIMIT_MULTIPLIER,
      createdAt: now,
      updatedAt: now
    };
  }

  const rawMaxFee = parts[startIndex + 1]?.trim();
  const rawPriorityFee = parts[startIndex + 2]?.trim();

  if (!rawMaxFee || !rawPriorityFee) {
    throw new Error("Custom gas requires maxFeeGwei and maxPriorityFeeGwei.");
  }

  const maxFeeGwei = normalizeDecimalGwei(
    rawMaxFee,
    "maxFeeGwei",
    MAX_CUSTOM_MAX_FEE_GWEI
  );
  const maxPriorityFeeGwei = normalizeDecimalGwei(
    rawPriorityFee,
    "maxPriorityFeeGwei",
    MAX_CUSTOM_PRIORITY_FEE_GWEI
  );

  if (ethers.parseUnits(maxFeeGwei, "gwei") < ethers.parseUnits(maxPriorityFeeGwei, "gwei")) {
    throw new Error("maxFeeGwei must be greater than or equal to maxPriorityFeeGwei.");
  }

  return {
    mode,
    maxFeeGwei,
    maxPriorityFeeGwei,
    gasLimitMultiplier: DEFAULT_GAS_LIMIT_MULTIPLIER,
    createdAt: now,
    updatedAt: now
  };
}

function multiplyBigIntByDecimal(value: bigint, multiplier: number) {
  const basisPoints = BigInt(Math.ceil(multiplier * 10_000));
  return (value * basisPoints + 9_999n) / 10_000n;
}

function increaseFee(value: bigint, multiplier: number) {
  return multiplyBigIntByDecimal(value, multiplier);
}

function formatGwei(value?: bigint) {
  return value === undefined ? undefined : ethers.formatUnits(value, "gwei");
}

function getFeeCostWei(overrides: ResolvedGasOverrides) {
  const feePerGas =
    overrides.maxFeePerGas ?? overrides.gasPrice ?? overrides.maxPriorityFeePerGas ?? 0n;
  return overrides.gasLimit * feePerGas;
}

export async function resolveGasOverrides(params: {
  provider: ethers.Provider;
  signer: ethers.Signer;
  tx: MintGasTransactionLike;
  gasStrategy?: GasStrategy;
}): Promise<ResolvedGasOverrides> {
  const gasStrategy = normalizeGasStrategy(params.gasStrategy);
  const estimatedGasUnits = await params.signer.estimateGas({
    to: params.tx.to,
    data: params.tx.data,
    value: params.tx.value
  });
  const gasLimit = multiplyBigIntByDecimal(
    estimatedGasUnits,
    gasStrategy.gasLimitMultiplier
  );

  if (gasStrategy.mode === "custom") {
    const maxFeePerGas = ethers.parseUnits(gasStrategy.maxFeeGwei!, "gwei");
    const maxPriorityFeePerGas = ethers.parseUnits(
      gasStrategy.maxPriorityFeeGwei!,
      "gwei"
    );

    return {
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
      estimatedGasUnits,
      gasLimitMultiplier: gasStrategy.gasLimitMultiplier
    };
  }

  const feeData = await params.provider.getFeeData();
  let maxFeePerGas = feeData.maxFeePerGas ?? undefined;
  let maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? undefined;
  let gasPrice = feeData.gasPrice ?? undefined;

  if (gasStrategy.mode === "fast") {
    if (maxPriorityFeePerGas !== undefined) {
      maxPriorityFeePerGas = increaseFee(maxPriorityFeePerGas, 1.2);
    }

    if (maxFeePerGas !== undefined) {
      maxFeePerGas = increaseFee(maxFeePerGas, 1.15);

      if (maxPriorityFeePerGas !== undefined && maxFeePerGas < maxPriorityFeePerGas) {
        maxFeePerGas = maxPriorityFeePerGas;
      }
    }

    if (gasPrice !== undefined && maxFeePerGas === undefined) {
      gasPrice = increaseFee(gasPrice, 1.15);
    }
  }

  if (maxFeePerGas !== undefined && maxPriorityFeePerGas !== undefined) {
    return {
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
      estimatedGasUnits,
      gasLimitMultiplier: gasStrategy.gasLimitMultiplier
    };
  }

  if (gasPrice !== undefined) {
    return {
      gasLimit,
      gasPrice,
      estimatedGasUnits,
      gasLimitMultiplier: gasStrategy.gasLimitMultiplier
    };
  }

  return {
    gasLimit,
    estimatedGasUnits,
    gasLimitMultiplier: gasStrategy.gasLimitMultiplier
  };
}

export async function previewGasForMint(params: {
  provider: ethers.Provider;
  signer: ethers.Signer;
  tx: MintGasTransactionLike;
  gasStrategy?: GasStrategy;
  walletAddress?: string;
}): Promise<GasPreviewResult> {
  const gasStrategy = normalizeGasStrategy(params.gasStrategy);
  const overrides = await resolveGasOverrides({
    provider: params.provider,
    signer: params.signer,
    tx: params.tx,
    gasStrategy
  });
  const estimatedGasCostWei = getFeeCostWei(overrides);
  const estimatedTotalCostWei = params.tx.value + estimatedGasCostWei;
  let walletBalanceWei: bigint | undefined;

  if (params.walletAddress) {
    walletBalanceWei = await params.provider.getBalance(params.walletAddress);
  }
  const maxFeeGwei = formatGwei(overrides.maxFeePerGas);
  const maxPriorityFeeGwei = formatGwei(overrides.maxPriorityFeePerGas);
  const gasPriceGwei = formatGwei(overrides.gasPrice);

  return {
    mode: gasStrategy.mode,
    estimatedGasUnits: overrides.estimatedGasUnits.toString(),
    gasLimit: overrides.gasLimit.toString(),
    ...(maxFeeGwei ? { maxFeeGwei } : {}),
    ...(maxPriorityFeeGwei ? { maxPriorityFeeGwei } : {}),
    ...(gasPriceGwei ? { gasPriceGwei } : {}),
    estimatedGasCostWei,
    estimatedGasCostEth: ethers.formatEther(estimatedGasCostWei),
    mintCostWei: params.tx.value,
    mintCostEth: ethers.formatEther(params.tx.value),
    estimatedTotalCostWei,
    estimatedTotalCostEth: ethers.formatEther(estimatedTotalCostWei),
    ...(walletBalanceWei === undefined
      ? {}
      : {
          walletBalanceWei,
          walletBalanceEth: ethers.formatEther(walletBalanceWei),
          fundedEnough: walletBalanceWei >= estimatedTotalCostWei
        })
  };
}

export function formatGasStrategy(gasStrategy?: GasStrategy) {
  const normalized = normalizeGasStrategy(gasStrategy);

  if (normalized.mode !== "custom") {
    return `${normalized.mode} (gas limit x${normalized.gasLimitMultiplier})`;
  }

  return `custom max ${normalized.maxFeeGwei} gwei / priority ${normalized.maxPriorityFeeGwei} gwei (gas limit x${normalized.gasLimitMultiplier})`;
}

export function formatGasPreview(preview: GasPreviewResult) {
  return [
    `Gas Strategy: ${preview.mode}`,
    `Estimated Gas Units: ${preview.estimatedGasUnits}`,
    `Gas Limit: ${preview.gasLimit}`,
    ...(preview.maxFeeGwei ? [`Max Fee: ${preview.maxFeeGwei} gwei`] : []),
    ...(preview.maxPriorityFeeGwei
      ? [`Priority Fee: ${preview.maxPriorityFeeGwei} gwei`]
      : []),
    ...(preview.gasPriceGwei ? [`Gas Price: ${preview.gasPriceGwei} gwei`] : []),
    `Estimated Gas Cost: ${preview.estimatedGasCostEth} ETH`,
    `Mint Cost: ${preview.mintCostEth} ETH`,
    `Estimated Total Cost: ${preview.estimatedTotalCostEth} ETH`,
    ...(preview.walletBalanceEth
      ? [
          `Wallet Balance: ${preview.walletBalanceEth} ETH`,
          `Funded Enough: ${preview.fundedEnough ? "yes" : "no"}`
        ]
      : [])
  ].join("\n");
}
