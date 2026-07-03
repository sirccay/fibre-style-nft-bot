import "dotenv/config";
import { ethers } from "ethers";
import {
  getWalletSignerByLabelForOwner,
  getWalletSummaryByLabelForOwner
} from "./vault.js";

export type MintChain = "mainnet" | "sepolia";

export type SupportedMintFunctionSignature =
  | "mint(uint256)"
  | "publicMint(uint256)"
  | "mintPublic(uint256)"
  | "mintTo(address,uint256)"
  | "publicMint(address,uint256)";

export type MintPreviewResult = {
  walletLabel: string;
  walletAddress: string;
  chain: MintChain;
  contractAddress: string;
  functionSignature: SupportedMintFunctionSignature;
  quantity: number;
  priceEth: string;
  totalCostWei: bigint;
  totalCostEth: string;
  gasEstimate: string | null;
  gasEstimateFailed: boolean;
  gasEstimateError?: string;
};

export type MintSubmitResult = {
  txHash: string;
  walletAddress: string;
  chain: MintChain;
  gasEstimate: string;
};

export type MintConfirmationResult = {
  status: "confirmed" | "failed" | "timeout";
  blockNumber?: number;
};

type BuildMintTransactionParams = {
  contractAddress: string;
  functionSignature: SupportedMintFunctionSignature;
  quantity: number;
  priceEth: string;
  walletAddress: string;
};

type MintActionParams = {
  ownerTelegramId: string;
  walletLabel: string;
  contractAddress: string;
  functionSignature: SupportedMintFunctionSignature;
  quantity: number;
  priceEth: string;
  chain: MintChain;
};

type BuiltMintTransaction = {
  to: string;
  data: string;
  value: bigint;
  totalCostEth: string;
};

export const SUPPORTED_MINT_FUNCTION_SIGNATURES: SupportedMintFunctionSignature[] = [
  "mint(uint256)",
  "publicMint(uint256)",
  "mintPublic(uint256)",
  "mintTo(address,uint256)",
  "publicMint(address,uint256)"
];

export const MAINNET_MINTING_DISABLED_MESSAGE =
  "Mainnet minting is disabled. Set ALLOW_MAINNET_MINTING=true only when you are ready for live minting.";

export function isMainnetMintingEnabled(): boolean {
  return process.env.ALLOW_MAINNET_MINTING === "true";
}

export function normalizeMintChain(rawChain?: string): MintChain {
  const normalized = rawChain?.trim().toLowerCase();

  if (!normalized || normalized === "mainnet") {
    return "mainnet";
  }

  if (normalized === "sepolia") {
    return "sepolia";
  }

  throw new Error("Chain must be mainnet or sepolia.");
}

export function normalizeMintFunctionSignature(
  rawSignature: string
): SupportedMintFunctionSignature {
  const normalized = rawSignature.trim().replace(/\s+/g, "");

  if (SUPPORTED_MINT_FUNCTION_SIGNATURES.includes(normalized as SupportedMintFunctionSignature)) {
    return normalized as SupportedMintFunctionSignature;
  }

  throw new Error(
    "This mint function is not supported yet. Manual ABI/proof support will be added later."
  );
}

export function validateMintQuantity(rawQuantity: string): number {
  if (!/^[1-9]\d*$/.test(rawQuantity.trim())) {
    throw new Error("Quantity must be a positive whole number.");
  }

  const quantity = Number(rawQuantity);

  if (!Number.isSafeInteger(quantity)) {
    throw new Error("Quantity is too large.");
  }

  return quantity;
}

export function validateMintPriceEth(rawPriceEth: string): string {
  const normalized = rawPriceEth.trim();

  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized)) {
    throw new Error("Mint price must be a non-negative decimal ETH amount.");
  }

  ethers.parseEther(normalized);
  return normalized;
}

export function getMintRpcStatus() {
  return {
    mainnetRpcConfigured: Boolean(process.env.ETH_MAINNET_RPC_URL?.trim()),
    sepoliaRpcConfigured: Boolean(
      process.env.SEPOLIA_RPC_URL?.trim() ||
        process.env.ETH_SEPOLIA_RPC_URL?.trim()
    )
  };
}

export function getMintProvider(chain: MintChain) {
  if (chain === "mainnet") {
    const rpcUrl = process.env.ETH_MAINNET_RPC_URL;

    if (!rpcUrl) {
      throw new Error("Missing ETH_MAINNET_RPC_URL");
    }

    return new ethers.JsonRpcProvider(rpcUrl);
  }

  const rpcUrl = process.env.SEPOLIA_RPC_URL || process.env.ETH_SEPOLIA_RPC_URL;

  if (!rpcUrl) {
    throw new Error("Missing SEPOLIA_RPC_URL or ETH_SEPOLIA_RPC_URL");
  }

  return new ethers.JsonRpcProvider(rpcUrl);
}

function redactMintErrorText(text: string): string {
  const sensitiveEnvNames = [
    "AZURE_CLIENT_SECRET",
    "TELEGRAM_BOT_TOKEN",
    "SEPOLIA_RPC_URL",
    "ETH_SEPOLIA_RPC_URL",
    "ETH_MAINNET_RPC_URL",
    "BASE_RPC_URL",
    "ETH_BASE_RPC_URL",
    "OPENSEA_API_KEY",
    "RESERVOIR_API_KEY",
    "ETHERSCAN_API_KEY",
    "VAULT_SECRET"
  ];

  let redacted = text;

  for (const name of sensitiveEnvNames) {
    const value = process.env[name];

    if (value && value.length >= 8) {
      redacted = redacted.split(value).join("[REDACTED]");
    }
  }

  return redacted
    .replace(/0x[a-fA-F0-9]{64}/g, "[REDACTED_HEX_SECRET]")
    .replace(
      /([?&](?:api[_-]?key|key|token|secret)=)[^&\s]+/gi,
      "$1[REDACTED]"
    )
    .slice(0, 300);
}

export function getMintSafeErrorReason(error: unknown): string {
  const anyError = error as any;
  const candidates = [
    anyError?.shortMessage,
    anyError?.reason,
    anyError?.revert?.args?.[0],
    anyError?.info?.error?.message,
    anyError?.error?.message,
    anyError?.message
  ];

  const reason = candidates.find(
    (candidate) => typeof candidate === "string" && candidate.trim()
  );

  return redactMintErrorText(
    (reason || "Unknown mint error").split("\n")[0] || "Unknown mint error"
  );
}

export function buildMintTransaction(
  params: BuildMintTransactionParams
): BuiltMintTransaction {
  if (!ethers.isAddress(params.contractAddress)) {
    throw new Error("Invalid contract address.");
  }

  const contractAddress = ethers.getAddress(params.contractAddress);
  const contractInterface = new ethers.Interface([
    `function ${params.functionSignature} payable`
  ]);
  const priceWei = ethers.parseEther(params.priceEth);
  const totalCostWei = priceWei * BigInt(params.quantity);
  const args = params.functionSignature.includes("address,uint256")
    ? [params.walletAddress, BigInt(params.quantity)]
    : [BigInt(params.quantity)];

  return {
    to: contractAddress,
    data: contractInterface.encodeFunctionData(params.functionSignature, args),
    value: totalCostWei,
    totalCostEth: ethers.formatEther(totalCostWei)
  };
}

export async function estimateMintGas(
  signer: ethers.Signer,
  tx: BuiltMintTransaction
) {
  return signer.estimateGas({
    to: tx.to,
    data: tx.data,
    value: tx.value
  });
}

export async function previewMint(params: MintActionParams): Promise<MintPreviewResult> {
  const provider = getMintProvider(params.chain);
  const walletSummary = await getWalletSummaryByLabelForOwner(
    params.walletLabel,
    params.ownerTelegramId
  );
  const wallet = await getWalletSignerByLabelForOwner(
    params.walletLabel,
    params.ownerTelegramId,
    provider,
    "mainmintpreview"
  );

  if (wallet.address.toLowerCase() !== walletSummary.address.toLowerCase()) {
    throw new Error("Wallet signer no longer matches the saved wallet.");
  }

  const tx = buildMintTransaction({
    contractAddress: params.contractAddress,
    functionSignature: params.functionSignature,
    quantity: params.quantity,
    priceEth: params.priceEth,
    walletAddress: wallet.address
  });

  let gasEstimate: string | null = null;
  let gasEstimateError: string | undefined;

  try {
    const estimated = await estimateMintGas(wallet, tx);
    gasEstimate = estimated.toString();
  } catch (error) {
    gasEstimateError = getMintSafeErrorReason(error);
  }

  return {
    walletLabel: walletSummary.label,
    walletAddress: wallet.address,
    chain: params.chain,
    contractAddress: tx.to,
    functionSignature: params.functionSignature,
    quantity: params.quantity,
    priceEth: params.priceEth,
    totalCostWei: tx.value,
    totalCostEth: tx.totalCostEth,
    gasEstimate,
    gasEstimateFailed: gasEstimate === null,
    ...(gasEstimateError ? { gasEstimateError } : {})
  };
}

export async function submitMintTransaction(
  params: MintActionParams
): Promise<MintSubmitResult> {
  if (params.chain === "mainnet" && !isMainnetMintingEnabled()) {
    throw new Error(MAINNET_MINTING_DISABLED_MESSAGE);
  }

  const provider = getMintProvider(params.chain);
  const wallet = await getWalletSignerByLabelForOwner(
    params.walletLabel,
    params.ownerTelegramId,
    provider,
    "mainmint"
  );
  const tx = buildMintTransaction({
    contractAddress: params.contractAddress,
    functionSignature: params.functionSignature,
    quantity: params.quantity,
    priceEth: params.priceEth,
    walletAddress: wallet.address
  });

  const gasEstimate = await estimateMintGas(wallet, tx);

  const response = await wallet.sendTransaction({
    to: tx.to,
    data: tx.data,
    value: tx.value,
    gasLimit: gasEstimate
  });

  return {
    txHash: response.hash,
    walletAddress: wallet.address,
    chain: params.chain,
    gasEstimate: gasEstimate.toString()
  };
}

export async function waitForMintConfirmation(
  chain: MintChain,
  txHash: string,
  timeoutMs = 120_000
): Promise<MintConfirmationResult> {
  const provider = getMintProvider(chain);
  const receipt = await provider.waitForTransaction(txHash, 1, timeoutMs);

  if (!receipt) {
    return { status: "timeout" };
  }

  if (receipt.status === 1) {
    return {
      status: "confirmed",
      blockNumber: receipt.blockNumber
    };
  }

  return {
    status: "failed",
    blockNumber: receipt.blockNumber
  };
}
