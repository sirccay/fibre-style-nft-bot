import { ethers } from "ethers";
import type { MintChain, SupportedMintFunctionSignature } from "./mintEngine.js";
import {
  getMintProvider,
  getMintSafeErrorReason
} from "./mintEngine.js";
import type { MintTarget } from "./mintTargets.js";
import { getWalletSignerByLabelForOwner } from "./vault.js";

type RouteConfidence = "verified" | "high" | "medium" | "low";

export type MintRouteCandidate = {
  mintContractAddress: string;
  functionSignature: string;
  functionSelector: string;
  payable: boolean;
  argsPreview: string;
  valueEth: string;
  pricePerTokenEth: string;
  gasEstimate: string | null;
  gasEstimateSuccess: boolean;
  safeErrorReason?: string;
  confidence: RouteConfidence;
  source: string;
  warnings: string[];
};

export type MintRouteResolverResult = {
  targetId: string;
  targetName: string;
  chain: MintChain;
  walletLabel: string;
  walletAddress: string;
  contractAddress: string;
  quantity: number;
  priceEth: string;
  candidates: MintRouteCandidate[];
  warnings: string[];
};

const ZERO = "0x0000000000000000000000000000000000000000";
const SEADROP_CONTROLLER = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
const SEADROP_FEE_RECIPIENT = "0x0000a26b00c1F0DF003000390027140000fAa719";
const SEADROP_MINT_PUBLIC_SELECTOR = "0x4b61cd6f";
const ETHERSCAN_TIMEOUT_MS = 12_000;

const SUPPORTED_ROUTE_SIGNATURES = new Set<string>([
  "mint(uint256)",
  "publicMint(uint256)",
  "mintPublic(uint256)",
  "mintPublicSale(uint256)",
  "claim(uint256)",
  "purchase(uint256)",
  "mintPublic(address,address,address,uint256)",
  "mintTo(address,uint256)",
  "mint(address,uint256)",
  "publicMint(address,uint256)",
  "mintPublic(address,uint256)",
  "mintPublicSale(address,uint256)",
  "claim(address,uint256)",
  "purchase(address,uint256)"
]);

const MINT_LIKE_NAMES = [
  "mint",
  "publicmint",
  "mintpublic",
  "mintpublicsale",
  "claim",
  "purchase"
];

function getEtherscanChainId(chain: MintChain) {
  return chain === "sepolia" ? "11155111" : "1";
}

function getEtherscanApiBase() {
  return "https://api.etherscan.io/v2/api";
}

function withAbortTimeout(ms: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return { controller, timeout };
}

async function fetchEtherscanJson(url: string) {
  const { controller, timeout } = withAbortTimeout(ETHERSCAN_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { accept: "application/json" }
    });

    const text = await response.text();

    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Etherscan returned non-JSON response.");
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchVerifiedAbi(chain: MintChain, address: string) {
  const apiKey = process.env.ETHERSCAN_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("ETHERSCAN_API_KEY is missing.");
  }

  const url =
    `${getEtherscanApiBase()}?chainid=${getEtherscanChainId(chain)}` +
    `&module=contract&action=getabi&address=${encodeURIComponent(address)}` +
    `&apikey=${encodeURIComponent(apiKey)}`;

  const json = await fetchEtherscanJson(url);

  if (json.status !== "1" || typeof json.result !== "string") {
    throw new Error(
      typeof json.result === "string"
        ? json.result.slice(0, 180)
        : "Could not fetch verified contract ABI."
    );
  }

  try {
    return JSON.parse(json.result);
  } catch {
    throw new Error("Verified ABI could not be parsed.");
  }
}

async function fetchRecentSuccessfulSelectors(chain: MintChain, address: string) {
  const apiKey = process.env.ETHERSCAN_API_KEY?.trim();

  if (!apiKey) {
    return new Set<string>();
  }

  const url =
    `${getEtherscanApiBase()}?chainid=${getEtherscanChainId(chain)}` +
    `&module=account&action=txlist&address=${encodeURIComponent(address)}` +
    `&page=1&offset=50&sort=desc&apikey=${encodeURIComponent(apiKey)}`;

  try {
    const json = await fetchEtherscanJson(url);
    const selectors = new Set<string>();

    if (!Array.isArray(json.result)) {
      return selectors;
    }

    for (const tx of json.result) {
      const input = typeof tx.input === "string" ? tx.input : "";
      const isSuccess = tx.isError === "0" || tx.txreceipt_status === "1";

      if (isSuccess && input.startsWith("0x") && input.length >= 10) {
        selectors.add(input.slice(0, 10).toLowerCase());
      }
    }

    return selectors;
  } catch {
    return new Set<string>();
  }
}

async function fetchRecentMintTransferTxHashes(chain: MintChain, tokenContract: string) {
  const apiKey = process.env.ETHERSCAN_API_KEY?.trim();

  if (!apiKey) {
    return [];
  }

  const url =
    `${getEtherscanApiBase()}?chainid=${getEtherscanChainId(chain)}` +
    `&module=account&action=tokennfttx&contractaddress=${encodeURIComponent(tokenContract)}` +
    `&page=1&offset=25&sort=desc&apikey=${encodeURIComponent(apiKey)}`;

  try {
    const json = await fetchEtherscanJson(url);

    if (!Array.isArray(json.result)) {
      return [];
    }

    const hashes: string[] = [];

    for (const row of json.result) {
      const from = String(row.from || "").toLowerCase();
      const hash = String(row.hash || row.transactionHash || "");

      if (from === ZERO && hash.startsWith("0x") && !hashes.includes(hash)) {
        hashes.push(hash);
      }
    }

    return hashes.slice(0, 8);
  } catch {
    return [];
  }
}

function getFunctionSelector(input: string) {
  return input && input.startsWith("0x") && input.length >= 10
    ? input.slice(0, 10).toLowerCase()
    : "0x";
}

function decodeSeaDropMintPublic(data: string) {
  const selector = getFunctionSelector(data);

  if (selector !== SEADROP_MINT_PUBLIC_SELECTOR) {
    return null;
  }

  const payload = `0x${data.slice(10)}`;
  const coder = ethers.AbiCoder.defaultAbiCoder();

  try {
    const decoded = coder.decode(
      ["address", "address", "address", "uint256"],
      payload
    );

    return {
      nftContract: ethers.getAddress(decoded[0]),
      feeRecipient: ethers.getAddress(decoded[1]),
      minterIfNotPayer: ethers.getAddress(decoded[2]),
      quantity: decoded[3].toString()
    };
  } catch {
    return null;
  }
}

function fragmentSignature(fragment: ethers.FunctionFragment) {
  return fragment.format("sighash");
}

function isMintLikeFragment(fragment: ethers.FunctionFragment) {
  const name = fragment.name.toLowerCase();
  return MINT_LIKE_NAMES.some((mintName) => name.includes(mintName));
}

function hasProofOrSignatureShape(fragment: ethers.FunctionFragment) {
  const joined = fragment.inputs
    .map((input) => `${input.name || ""}:${input.type}`.toLowerCase())
    .join("|");

  return /proof|signature|merkle|allowlist|whitelist|signed|auth|captcha|bytes|tuple/.test(
    joined
  );
}

function buildArgsForFragment(params: {
  fragment: ethers.FunctionFragment;
  walletAddress: string;
  quantity: number;
}) {
  const inputs = params.fragment.inputs;

  if (inputs.length === 0) {
    return { args: [], argsPreview: "[]" };
  }

  if (inputs.length === 1 && /^uint/.test(inputs[0]!.type)) {
    return {
      args: [BigInt(params.quantity)],
      argsPreview: `[quantity=${params.quantity}]`
    };
  }

  if (inputs.length === 2) {
    const first = inputs[0]!;
    const second = inputs[1]!;

    if (first.type === "address" && /^uint/.test(second.type)) {
      return {
        args: [params.walletAddress, BigInt(params.quantity)],
        argsPreview: `[recipient=${params.walletAddress}, quantity=${params.quantity}]`
      };
    }

    if (/^uint/.test(first.type) && second.type === "address") {
      return {
        args: [BigInt(params.quantity), params.walletAddress],
        argsPreview: `[quantity=${params.quantity}, recipient=${params.walletAddress}]`
      };
    }
  }

  return null;
}

function uniqueFragments(abi: any[]) {
  const iface = new ethers.Interface(abi);
  const bySignature = new Map<string, ethers.FunctionFragment>();

  for (const fragment of iface.fragments) {
    if (fragment.type !== "function") {
      continue;
    }

    const fn = fragment as ethers.FunctionFragment;
    const signature = fragmentSignature(fn);

    if (!bySignature.has(signature)) {
      bySignature.set(signature, fn);
    }
  }

  return [...bySignature.values()];
}

function isSupportedRouteSignature(signature: string): signature is SupportedMintFunctionSignature {
  return SUPPORTED_ROUTE_SIGNATURES.has(signature);
}

export function pickBestSupportedRoute(candidates: MintRouteCandidate[]) {
  return (
    candidates.find(
      (candidate) =>
        candidate.gasEstimateSuccess &&
        isSupportedRouteSignature(candidate.functionSignature)
    ) || null
  );
}

async function resolveSeaDropPublicRoute(params: {
  chain: MintChain;
  tokenContract: string;
  wallet: ethers.Signer;
  walletAddress: string;
  quantity: number;
  priceEth: string;
}): Promise<MintRouteCandidate[]> {
  if (params.chain !== "mainnet") {
    return [];
  }

  const provider = getMintProvider(params.chain);
  const hashes = await fetchRecentMintTransferTxHashes(params.chain, params.tokenContract);
  const candidates: MintRouteCandidate[] = [];
  const seenRoutes = new Set<string>();
  const walletBalanceWei = await provider.getBalance(params.walletAddress);
  const totalValueWei = ethers.parseEther(params.priceEth) * BigInt(params.quantity);
  const totalValueEth = ethers.formatEther(totalValueWei);
  const gasBufferWei = ethers.parseEther("0.0005");
  const minimumNeededWei = totalValueWei + gasBufferWei;
  const iface = new ethers.Interface([
    "function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity) payable"
  ]);

  for (const hash of hashes) {
    const tx = await provider.getTransaction(hash);

    if (!tx || !tx.to || getFunctionSelector(tx.data) !== SEADROP_MINT_PUBLIC_SELECTOR) {
      continue;
    }

    const decoded = decodeSeaDropMintPublic(tx.data);

    if (!decoded) {
      continue;
    }

    if (decoded.nftContract.toLowerCase() !== params.tokenContract.toLowerCase()) {
      continue;
    }

    const seaDropTo = ethers.getAddress(tx.to);
    const feeRecipient = decoded.feeRecipient || SEADROP_FEE_RECIPIENT;
    const routeKey = `${seaDropTo.toLowerCase()}:${params.tokenContract.toLowerCase()}:${feeRecipient.toLowerCase()}`;

    if (seenRoutes.has(routeKey)) {
      continue;
    }

    seenRoutes.add(routeKey);

    if (walletBalanceWei < minimumNeededWei) {
      candidates.push({
        mintContractAddress: params.tokenContract,
        functionSignature: "mintPublic(address,address,address,uint256)",
        functionSelector: SEADROP_MINT_PUBLIC_SELECTOR,
        payable: true,
        argsPreview: `[SeaDrop=${seaDropTo}, nftContract=${params.tokenContract}, feeRecipient=${feeRecipient}, minterIfNotPayer=0x0000..., quantity=${params.quantity}]`,
        valueEth: totalValueEth,
        pricePerTokenEth: params.priceEth,
        gasEstimate: null,
        gasEstimateSuccess: false,
        safeErrorReason: `low balance: wallet has ${ethers.formatEther(walletBalanceWei)} ETH, mint cost is ${totalValueEth} ETH, recommended minimum with gas buffer is ${ethers.formatEther(minimumNeededWei)} ETH`,
        confidence: "high",
        source: "seadrop_successful_tx_low_balance",
        warnings: [
          "OpenSea SeaDrop public mint route was detected from successful mint tx.",
          "Gas estimation was skipped because the wallet balance is too low for mint cost plus gas buffer.",
          "Top up this wallet or use another wallet, then run /resolveroute again."
        ]
      });
      break;
    }

    const data = iface.encodeFunctionData("mintPublic", [
      params.tokenContract,
      feeRecipient,
      ethers.ZeroAddress,
      BigInt(params.quantity)
    ]);

    try {
      const gasEstimate = await params.wallet.estimateGas({
        to: seaDropTo,
        data,
        value: totalValueWei
      });

      candidates.push({
        mintContractAddress: params.tokenContract,
        functionSignature: "mintPublic(address,address,address,uint256)",
        functionSelector: SEADROP_MINT_PUBLIC_SELECTOR,
        payable: true,
        argsPreview: `[SeaDrop=${seaDropTo}, nftContract=${params.tokenContract}, feeRecipient=${feeRecipient}, minterIfNotPayer=0x0000..., quantity=${params.quantity}]`,
        valueEth: totalValueEth,
        pricePerTokenEth: params.priceEth,
        gasEstimate: gasEstimate.toString(),
        gasEstimateSuccess: true,
        confidence: "verified",
        source: "seadrop_successful_tx_and_gas_estimate",
        warnings: [
          "OpenSea SeaDrop public mint route detected from successful mint tx.",
          "Target contract remains the NFT contract; mint engine routes this function through the SeaDrop controller."
        ]
      });
      break;
    } catch (error) {
      candidates.push({
        mintContractAddress: params.tokenContract,
        functionSignature: "mintPublic(address,address,address,uint256)",
        functionSelector: SEADROP_MINT_PUBLIC_SELECTOR,
        payable: true,
        argsPreview: `[SeaDrop=${seaDropTo}, nftContract=${params.tokenContract}, feeRecipient=${feeRecipient}, minterIfNotPayer=0x0000..., quantity=${params.quantity}]`,
        valueEth: totalValueEth,
        pricePerTokenEth: params.priceEth,
        gasEstimate: null,
        gasEstimateSuccess: false,
        safeErrorReason: getMintSafeErrorReason(error),
        confidence: "medium",
        source: "seadrop_successful_tx_but_estimate_failed",
        warnings: [
          "SeaDrop route was detected from successful txs, but this wallet/quantity/value failed estimation."
        ]
      });
    }
  }

  return candidates;
}

export async function resolveMintRoutesForTarget(params: {
  ownerTelegramId: string;
  target: MintTarget;
  walletLabel: string;
}): Promise<MintRouteResolverResult> {
  if (!params.target.contractAddress || !ethers.isAddress(params.target.contractAddress)) {
    throw new Error("Target has no valid contract address.");
  }

  if (!params.target.priceEth) {
    throw new Error("Target has no mint price.");
  }

  const provider = getMintProvider(params.target.chain);
  const wallet = await getWalletSignerByLabelForOwner(
    params.walletLabel,
    params.ownerTelegramId,
    provider,
    "resolveroute"
  );

  const contractAddress = ethers.getAddress(params.target.contractAddress);
  const priceWei = ethers.parseEther(params.target.priceEth);
  const totalValueWei = priceWei * BigInt(params.target.quantity);
  const totalValueEth = ethers.formatEther(totalValueWei);
  const warnings: string[] = [];
  const candidates: MintRouteCandidate[] = [];

  candidates.push(
    ...(await resolveSeaDropPublicRoute({
      chain: params.target.chain,
      tokenContract: contractAddress,
      wallet,
      walletAddress: wallet.address,
      quantity: params.target.quantity,
      priceEth: params.target.priceEth
    }))
  );

  let abi: any[];

  try {
    abi = await fetchVerifiedAbi(params.target.chain, contractAddress);
  } catch (error) {
    return {
      targetId: params.target.targetId,
      targetName: params.target.name,
      chain: params.target.chain,
      walletLabel: params.walletLabel,
      walletAddress: wallet.address,
      contractAddress,
      quantity: params.target.quantity,
      priceEth: params.target.priceEth,
      candidates,
      warnings: [
        ...warnings,
        `Could not fetch verified ABI: ${getMintSafeErrorReason(error)}`,
        "Paste the exact mint function manually if the contract is not verified."
      ]
    };
  }

  const recentSuccessfulSelectors = await fetchRecentSuccessfulSelectors(
    params.target.chain,
    contractAddress
  );

  const fragments = uniqueFragments(abi).filter(isMintLikeFragment);

  if (fragments.length === 0) {
    warnings.push("No mint-like functions were found in the verified ABI.");
  }

  for (const fragment of fragments) {
    const signature = fragmentSignature(fragment);
    const selector = ethers.id(signature).slice(0, 10).toLowerCase();
    const payable = fragment.payable;
    const routeWarnings: string[] = [];

    if (hasProofOrSignatureShape(fragment)) {
      candidates.push({
        mintContractAddress: contractAddress,
        functionSignature: signature,
        functionSelector: selector,
        payable,
        argsPreview: "requires proof/signature/complex args",
        valueEth: totalValueEth,
        pricePerTokenEth: params.target.priceEth,
        gasEstimate: null,
        gasEstimateSuccess: false,
        safeErrorReason:
          "This route has proof/signature/bytes/tuple-style inputs and cannot be auto-built safely.",
        confidence: recentSuccessfulSelectors.has(selector) ? "high" : "low",
        source: recentSuccessfulSelectors.has(selector)
          ? "etherscan_successful_tx_selector"
          : "verified_abi_complex_args",
        warnings: [
          "This may be a real mint route, but it needs official proof/signature/complex params.",
          "The bot will not generate or bypass proofs/signatures."
        ]
      });
      continue;
    }

    const builtArgs = buildArgsForFragment({
      fragment,
      walletAddress: wallet.address,
      quantity: params.target.quantity
    });

    if (!builtArgs) {
      candidates.push({
        mintContractAddress: contractAddress,
        functionSignature: signature,
        functionSelector: selector,
        payable,
        argsPreview: "unsupported args",
        valueEth: totalValueEth,
        pricePerTokenEth: params.target.priceEth,
        gasEstimate: null,
        gasEstimateSuccess: false,
        safeErrorReason:
          "Function args are not supported by the current auto-builder.",
        confidence: recentSuccessfulSelectors.has(selector) ? "medium" : "low",
        source: "verified_abi_unsupported_args",
        warnings: ["Manual route support may be needed for this function."]
      });
      continue;
    }

    if (!payable && totalValueWei > 0n) {
      routeWarnings.push("Function is nonpayable but target price is above zero.");
    }

    try {
      const iface = new ethers.Interface([`function ${signature} ${payable ? "payable" : ""}`]);
      const data = iface.encodeFunctionData(signature, builtArgs.args);
      const gasEstimate = await wallet.estimateGas({
        to: contractAddress,
        data,
        value: payable ? totalValueWei : 0n
      });

      candidates.push({
        mintContractAddress: contractAddress,
        functionSignature: signature,
        functionSelector: selector,
        payable,
        argsPreview: builtArgs.argsPreview,
        valueEth: payable ? totalValueEth : "0",
        pricePerTokenEth: params.target.priceEth,
        gasEstimate: gasEstimate.toString(),
        gasEstimateSuccess: true,
        confidence: recentSuccessfulSelectors.has(selector) ? "verified" : "high",
        source: recentSuccessfulSelectors.has(selector)
          ? "etherscan_successful_tx_and_gas_estimate"
          : "verified_abi_gas_estimate",
        warnings: routeWarnings
      });
    } catch (error) {
      candidates.push({
        mintContractAddress: contractAddress,
        functionSignature: signature,
        functionSelector: selector,
        payable,
        argsPreview: builtArgs.argsPreview,
        valueEth: payable ? totalValueEth : "0",
        pricePerTokenEth: params.target.priceEth,
        gasEstimate: null,
        gasEstimateSuccess: false,
        safeErrorReason: getMintSafeErrorReason(error),
        confidence: recentSuccessfulSelectors.has(selector) ? "medium" : "low",
        source: recentSuccessfulSelectors.has(selector)
          ? "etherscan_successful_tx_selector_but_estimate_failed"
          : "verified_abi_estimate_failed",
        warnings: routeWarnings
      });
    }
  }

  candidates.sort((a, b) => {
    const score = (candidate: MintRouteCandidate) => {
      if (candidate.gasEstimateSuccess && candidate.confidence === "verified") return 0;
      if (candidate.gasEstimateSuccess) return 1;
      if (candidate.confidence === "medium") return 2;
      return 3;
    };

    return score(a) - score(b);
  });

  return {
    targetId: params.target.targetId,
    targetName: params.target.name,
    chain: params.target.chain,
    walletLabel: params.walletLabel,
    walletAddress: wallet.address,
    contractAddress,
    quantity: params.target.quantity,
    priceEth: params.target.priceEth,
    candidates,
    warnings
  };
}

export function formatMintRouteResolverResult(result: MintRouteResolverResult) {
  const best = pickBestSupportedRoute(result.candidates);
  const lowBalanceCandidate = result.candidates.find((candidate) =>
    candidate.source.includes("low_balance") ||
    /low balance|insufficient/i.test(candidate.safeErrorReason || "")
  );
  const detectedRouteCandidate = result.candidates.find((candidate) =>
    candidate.source.startsWith("seadrop_successful_tx")
  );
  const statusLine = best
    ? "✅ Working supported mint route found."
    : lowBalanceCandidate
      ? "⚠️ SeaDrop mint route detected, but wallet balance is too low to estimate gas."
      : detectedRouteCandidate
        ? "⚠️ SeaDrop mint route detected, but gas estimation still failed."
        : "❌ No supported working mint route found yet.";

  const lines = [
    "Mint Route Resolver",
    "",
    `Target: ${result.targetName}`,
    `Target ID: ${result.targetId}`,
    `Wallet: ${result.walletLabel}`,
    `Address: ${result.walletAddress.slice(0, 6)}...${result.walletAddress.slice(-4)}`,
    `Chain: ${result.chain}`,
    `Contract Checked: ${result.contractAddress}`,
    `Quantity: ${result.quantity}`,
    `Price Each: ${result.priceEth} ETH`,
    "",
    statusLine,
    ...(best
      ? [
          `Best Function: ${best.functionSignature}`,
          `Selector: ${best.functionSelector}`,
          `Payable: ${best.payable ? "yes" : "no"}`,
          `Args: ${best.argsPreview}`,
          `Value: ${best.valueEth} ETH`,
          `Gas Estimate: ${best.gasEstimate}`,
          `Source: ${best.source}`,
          `Confidence: ${best.confidence}`
        ]
      : []),
    "",
    "Candidates:"
  ];

  if (result.candidates.length === 0) {
    lines.push("- None");
  }

  result.candidates.slice(0, 6).forEach((candidate, index) => {
    lines.push(
      "",
      `${index + 1}. ${candidate.functionSignature}`,
      `Contract: ${candidate.mintContractAddress}`,
      `Selector: ${candidate.functionSelector}`,
      `Payable: ${candidate.payable ? "yes" : "no"}`,
      `Args: ${candidate.argsPreview}`,
      `Value: ${candidate.valueEth} ETH`,
      `Gas: ${candidate.gasEstimate || "failed"}`,
      `Result: ${candidate.gasEstimateSuccess ? "works" : "failed"}`,
      `Confidence: ${candidate.confidence}`,
      `Source: ${candidate.source}`,
      ...(candidate.safeErrorReason ? [`Reason: ${candidate.safeErrorReason}`] : []),
      ...(candidate.warnings.length > 0
        ? ["Warnings:", ...candidate.warnings.map((warning) => `- ${warning}`)]
        : [])
    );
  });

  if (result.warnings.length > 0) {
    lines.push("", "Resolver Warnings:", ...result.warnings.map((warning) => `- ${warning}`));
  }

  lines.push(
    "",
    "Next:",
    best
      ? "Best route can be saved automatically by /resolveroute."
      : "If all candidates fail, the collection may use a separate mint controller, proof/signature, wrong contract, or custom args."
  );

  return lines.join("\n");
}
