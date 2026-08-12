import "dotenv/config";
import { ethers } from "ethers";

export type DetectorConfidence = "high" | "medium" | "low" | "unknown";
export type DetectorTokenStandard = "ERC721" | "ERC721A" | "ERC1155" | "unknown";
export type DetectorPlatform =
  | "seadrop"
  | "manifold"
  | "thirdweb"
  | "zora"
  | "foundation"
  | "reservoir-detected"
  | "custom"
  | "unknown";
export type DetectorPhaseStatus =
  | "not-started"
  | "allowlist"
  | "public"
  | "paused"
  | "ended"
  | "unknown";

export type DetectorStage = {
  name: string | null;
  kind: string | null;
  status: DetectorPhaseStatus;
  startTime: string | null;
  endTime: string | null;
  priceWei: string | null;
  priceEth: string | null;
  priceText: string | null;
  currency: "ETH" | "ERC20" | "unknown";
  currencyAddress: string | null;
  maxPerWallet: number | null;
  eligibilityText: string | null;
  source: "reservoir" | "opensea" | "contract-read" | "page" | "unknown";
  confidence: DetectorConfidence;
};

export type StructuredMintDetectionResult = {
  input: { rawLink: string; walletChecked: string | null };
  chain: { name: string | null; chainId: number | null; confidence: DetectorConfidence };
  contract: {
    address: string | null;
    collectionSlug: string | null;
    tokenStandard: DetectorTokenStandard;
    platform: DetectorPlatform;
    verifiedSource: boolean;
  };
  mint: {
    function: {
      name: string | null;
      signature?: string | null;
      selector: string | null;
      confidence: DetectorConfidence;
      source?: "reservoir" | "abi" | "bytecode-4byte" | "supported-selector" | "unknown";
    };
    price: {
      wei: string | null;
      eth: string | null;
      currency: "ETH" | "ERC20" | "unknown";
      currencyAddress: string | null;
      source: "reservoir" | "contract-read" | "opensea_page" | "tx-history-inference" | "unavailable";
      confidence: DetectorConfidence;
    };
    phase: {
      status: DetectorPhaseStatus;
      startTime: string | null;
      endTime: string | null;
      confidence: DetectorConfidence;
    };
    stages: DetectorStage[];
  };
  eligibility: {
    allowlistDetected: boolean;
    walletOnAllowlist: "yes" | "no" | "unknown";
    walletAlreadyMinted: number | null;
    maxPerWallet: number | null;
    estimate: "eligible" | "not-eligible" | "unknown";
  } | null;
  warnings: string[];
  detectedAt: string;
};

type DetectorChainConfig = {
  name: string;
  chainId: number;
  aliases: string[];
  rpcEnvNames: string[];
  reservoirBaseUrl: string;
  explorerHosts: string[];
};

type ResolvedMintLink = {
  platform: "opensea" | "zora" | "manifold" | "magiceden" | "blur" | "explorer" | "raw_address" | "generic" | "unknown";
  sourceUrl?: string;
  chainName: string | null;
  chainId: number | null;
  chainConfidence: DetectorConfidence;
  contractAddress: string | null;
  contractConfidence: DetectorConfidence;
  collectionSlug: string | null;
  warnings: string[];
};

type AbiFunction = {
  type: "function";
  name: string;
  inputs?: Array<{ name?: string; type: string }>;
  outputs?: Array<{ name?: string; type: string }>;
  stateMutability?: "pure" | "view" | "nonpayable" | "payable";
};

type FunctionCandidate = {
  name: string;
  signature: string;
  selector: string;
  confidence: DetectorConfidence;
  source: "reservoir" | "abi" | "bytecode-4byte" | "supported-selector" | "unknown";
  score: number;
};

const HTTP_TIMEOUT_MS = 8_000;
const RPC_TIMEOUT_MS = 8_000;
const LIVE_CACHE_TTL_MS = 30_000;
const IDENTITY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const DETECTOR_CHAINS: DetectorChainConfig[] = [
  {
    name: "mainnet",
    chainId: 1,
    aliases: ["ethereum", "eth", "mainnet"],
    rpcEnvNames: ["ETH_MAINNET_RPC_URL"],
    reservoirBaseUrl: "https://api.reservoir.tools",
    explorerHosts: ["etherscan.io"]
  },
  {
    name: "base",
    chainId: 8453,
    aliases: ["base"],
    rpcEnvNames: ["BASE_RPC_URL", "ETH_BASE_RPC_URL"],
    reservoirBaseUrl: "https://api-base.reservoir.tools",
    explorerHosts: ["basescan.org"]
  },
  {
    name: "arbitrum",
    chainId: 42161,
    aliases: ["arbitrum", "arb", "arbitrum-one"],
    rpcEnvNames: ["ARBITRUM_RPC_URL", "ETH_ARBITRUM_RPC_URL"],
    reservoirBaseUrl: "https://api-arbitrum.reservoir.tools",
    explorerHosts: ["arbiscan.io"]
  },
  {
    name: "polygon",
    chainId: 137,
    aliases: ["polygon", "matic"],
    rpcEnvNames: ["POLYGON_RPC_URL", "ETH_POLYGON_RPC_URL"],
    reservoirBaseUrl: "https://api-polygon.reservoir.tools",
    explorerHosts: ["polygonscan.com"]
  },
  {
    name: "sepolia",
    chainId: 11155111,
    aliases: ["sepolia"],
    rpcEnvNames: ["SEPOLIA_RPC_URL", "ETH_SEPOLIA_RPC_URL"],
    reservoirBaseUrl: "https://api-sepolia.reservoir.tools",
    explorerHosts: ["sepolia.etherscan.io"]
  },
{
name: "robinhood",
chainId: 4663,
aliases: ["robinhood", "robinhood_chain", "robinhood-chain"],
rpcEnvNames: ["ROBINHOOD_MAINNET_RPC_URL"],
reservoirBaseUrl: "https://api.robinhood.com",
explorerHosts: ["robinhoodchain.blockscout.com"]
}
];

const MINT_NAME_PATTERNS = [
  "mint",
  "publicmint",
  "mintpublic",
  "claim",
  "purchase",
  "buy",
  "mintto",
  "claimto",
  "allowlistmint",
  "whitelistmint",
  "presalemint"
];

const EXCLUDED_FUNCTION_NAME_PATTERNS = [
  "burn",
  "withdraw",
  "owner",
  "admin",
  "pause",
  "unpause",
  "airdrop",
  "reserve",
  "set",
  "update",
  "grant",
  "revoke"
];

const COMMON_MINT_SIGNATURES = [
  "mint(uint256)",
  "publicMint(uint256)",
  "mintPublic(uint256)",
  "mintTo(address,uint256)",
  "publicMint(address,uint256)",
  "claim(uint256)",
  "purchase(uint256)",
  "buy(uint256)",
  "mint()",
  "publicMint()"
];

const PRICE_GETTERS = [
  "price",
  "mintPrice",
  "publicMintPrice",
  "publicPrice",
  "cost",
  "mintCost",
  "PUBLIC_SALE_PRICE",
  "publicSalePrice"
];

const START_TIME_GETTERS = [
  "startTime",
  "saleStartTime",
  "publicSaleStartTime",
  "publicMintStartTime",
  "mintStartTime"
];

const END_TIME_GETTERS = [
  "endTime",
  "saleEndTime",
  "publicSaleEndTime",
  "publicMintEndTime"
];

const ACTIVE_GETTERS = [
  "saleIsActive",
  "publicSaleActive",
  "publicSaleIsActive",
  "isPublicSaleActive",
  "mintOpen",
  "mintingOpen",
  "publicMintOpen"
];

const PAUSED_GETTERS = ["paused", "mintPaused"];
const MAX_PER_WALLET_GETTERS = [
  "maxPerWallet",
  "maxMintPerWallet",
  "maxMintsPerWallet",
  "walletLimit",
  "mintLimit"
];
const WALLET_MINT_COUNT_GETTERS = [
  "numberMinted",
  "minted",
  "mintedCount",
  "walletMints",
  "mintedPerWallet"
];
const MERKLE_ROOT_GETTERS = ["merkleRoot", "allowlistMerkleRoot", "whitelistMerkleRoot"];

const ADDRESS_PATTERN = /0x[a-fA-F0-9]{40}/;
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;

const identityCache = new Map<string, { expiresAt: number; value: unknown }>();
const liveCache = new Map<string, { expiresAt: number; value: unknown }>();

function makeUnknownResult(link: string, walletAddress?: string): StructuredMintDetectionResult {
  return {
    input: {
      rawLink: link,
      walletChecked: walletAddress && ethers.isAddress(walletAddress)
        ? ethers.getAddress(walletAddress)
        : null
    },
    chain: { name: null, chainId: null, confidence: "unknown" },
    contract: {
      address: null,
      collectionSlug: null,
      tokenStandard: "unknown",
      platform: "unknown",
      verifiedSource: false
    },
    mint: {
      function: { name: null, selector: null, confidence: "unknown", source: "unknown" },
      price: {
        wei: null,
        eth: null,
        currency: "unknown",
        currencyAddress: null,
        source: "unavailable",
        confidence: "unknown"
      },
      phase: {
        status: "unknown",
        startTime: null,
        endTime: null,
        confidence: "unknown"
      },
      stages: []
    },
    eligibility: walletAddress && ethers.isAddress(walletAddress)
      ? {
          allowlistDetected: false,
          walletOnAllowlist: "unknown",
          walletAlreadyMinted: null,
          maxPerWallet: null,
          estimate: "unknown"
        }
      : null,
    warnings: [],
    detectedAt: new Date().toISOString()
  };
}

function getCache<T>(cache: Map<string, { expiresAt: number; value: unknown }>, key: string): T | null {
  const entry = cache.get(key);

  if (!entry || entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }

  return entry.value as T;
}

function setCache(cache: Map<string, { expiresAt: number; value: unknown }>, key: string, value: unknown, ttlMs: number) {
  cache.set(key, {
    expiresAt: Date.now() + ttlMs,
    value
  });
}

function normalizeChain(rawChain?: string | null): DetectorChainConfig | null {
  const normalized = rawChain?.trim().toLowerCase();

  if (!normalized) return null;

  return DETECTOR_CHAINS.find((chain) =>
    chain.aliases.includes(normalized) || chain.name === normalized
  ) || null;
}

function getChainById(chainId: number | null | undefined) {
  if (!chainId) return null;
  return DETECTOR_CHAINS.find((chain) => chain.chainId === chainId) || null;
}

function getConfiguredRpcUrl(chain: DetectorChainConfig) {
  for (const envName of chain.rpcEnvNames) {
    const value = process.env[envName]?.trim();

    if (value) return value;
  }

  return null;
}

function getProvider(chain: DetectorChainConfig): ethers.JsonRpcProvider | null {
  const rpcUrl = getConfiguredRpcUrl(chain);
  return rpcUrl ? new ethers.JsonRpcProvider(rpcUrl) : null;
}

function redactDetectorText(text: string) {
  const envNames = [
    "AZURE_CLIENT_SECRET",
    "TELEGRAM_BOT_TOKEN",
    "SEPOLIA_RPC_URL",
    "ETH_SEPOLIA_RPC_URL",
    "ETH_MAINNET_RPC_URL",
    "BASE_RPC_URL",
    "ETH_BASE_RPC_URL",
    "ARBITRUM_RPC_URL",
    "POLYGON_RPC_URL",
    "OPENSEA_API_KEY",
    "RESERVOIR_API_KEY",
    "ETHERSCAN_API_KEY"
  ];
  let redacted = text;

  for (const envName of envNames) {
    const value = process.env[envName];

    if (value && value.length >= 8) {
      redacted = redacted.split(value).join("[REDACTED]");
    }
  }

  return redacted
    .replace(/0x[a-fA-F0-9]{64}/g, "[REDACTED_HEX_SECRET]")
    .replace(/([?&](?:api[_-]?key|apikey|key|token|secret)=)[^&\s]+/gi, "$1[REDACTED]")
    .slice(0, 300);
}

function getSafeDetectorError(error: unknown) {
  const anyError = error as any;
  const candidate =
    anyError?.shortMessage ||
    anyError?.reason ||
    anyError?.info?.error?.message ||
    anyError?.error?.message ||
    anyError?.message ||
    "Unknown detector error";

  return redactDetectorText(String(candidate).split("\n")[0] || "Unknown detector error");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

async function fetchJsonWithTimeout(url: string, headers: Record<string, string>, timeoutMs = HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal
    });

    if (response.status === 429) {
      return { data: null, warning: `HTTP 429 rate limited for ${new URL(url).hostname}.`, status: response.status };
    }

    if (!response.ok) {
      return { data: null, warning: `HTTP ${response.status} from ${new URL(url).hostname}.`, status: response.status };
    }

    return { data: await response.json(), warning: null, status: response.status };
  } catch (error) {
    return {
      data: null,
      warning: `HTTP fetch failed for ${new URL(url).hostname}: ${getSafeDetectorError(error)}`,
      status: null
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchTextWithTimeout(url: string, timeoutMs = HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "text/html,text/plain,*/*",
        "user-agent": "Mozilla/5.0 (compatible; FibreStyleMintDetector/2.0)"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      return { text: null, warning: `HTTP ${response.status} from ${new URL(url).hostname}.` };
    }

    return { text: await response.text(), warning: null };
  } catch (error) {
    return {
      text: null,
      warning: `Page fetch failed for ${new URL(url).hostname}: ${getSafeDetectorError(error)}`
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function getFirstAddress(input: string): string | null {
  const match = input.match(ADDRESS_PATTERN);
  return match ? ethers.getAddress(match[0]) : null;
}

function getChainFromExplorerHost(host: string): DetectorChainConfig | null {
  const lowerHost = host.toLowerCase();
  return DETECTOR_CHAINS.find((chain) =>
    chain.explorerHosts.some((explorerHost) => lowerHost.includes(explorerHost))
  ) || null;
}

async function probeRawAddressChains(address: string, warnings: string[]) {
  const configuredChains = DETECTOR_CHAINS.filter((chain) => getProvider(chain));

  if (configuredChains.length === 0) {
    warnings.push("No detector RPC URLs are configured for raw address chain probing.");
    return [];
  }

  const probes = await Promise.all(
    configuredChains.map(async (chain) => {
      const provider = getProvider(chain);

      if (!provider) return null;

      try {
        const code = await withTimeout(
          provider.getCode(address),
          RPC_TIMEOUT_MS,
          `${chain.name} getCode timed out`
        );
        return code !== "0x" ? chain : null;
      } catch (error) {
        warnings.push(`Raw address probe failed on ${chain.name}: ${getSafeDetectorError(error)}`);
        return null;
      }
    })
  );

  return probes.filter((chain): chain is DetectorChainConfig => Boolean(chain));
}

async function fetchOpenSeaCollection(slug: string, warnings: string[]) {
  const apiKey = process.env.OPENSEA_API_KEY?.trim();

  if (!apiKey) {
    warnings.push("OPENSEA_API_KEY is not configured; OpenSea slug resolution is limited.");
    return null;
  }

  const cacheKey = `opensea-collection:${slug}`;
  const cached = getCache<any>(identityCache, cacheKey);

  if (cached) return cached;

  const { data, warning } = await fetchJsonWithTimeout(
    `https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}`,
    {
      accept: "application/json",
      "x-api-key": apiKey
    }
  );

  if (warning) warnings.push(warning);
  if (!data) return null;

  const collection = data.collection ?? data;
  setCache(identityCache, cacheKey, collection, IDENTITY_CACHE_TTL_MS);
  return collection;
}

function extractOpenSeaContract(collection: any) {
  const contract =
    collection?.contracts?.[0]?.address ??
    collection?.primary_asset_contracts?.[0]?.address ??
    collection?.primary_asset_contract?.address ??
    collection?.contract_address ??
    null;
  const chainRaw =
    collection?.contracts?.[0]?.chain ??
    collection?.chain ??
    collection?.network ??
    null;
  const tokenStandard =
    collection?.contracts?.[0]?.token_standard ??
    collection?.primary_asset_contracts?.[0]?.schema_name ??
    collection?.primary_asset_contract?.schema_name ??
    collection?.token_standard ??
    null;

  return {
    contractAddress: contract && ethers.isAddress(contract) ? ethers.getAddress(contract) : null,
    chain: normalizeChain(chainRaw),
    tokenStandard: normalizeTokenStandard(tokenStandard)
  };
}

async function resolveMintLink(link: string): Promise<ResolvedMintLink> {
  const trimmed = link.trim();
  const warnings: string[] = [];

  if (!trimmed) {
    return {
      platform: "unknown",
      chainName: null,
      chainId: null,
      chainConfidence: "unknown",
      contractAddress: null,
      contractConfidence: "unknown",
      collectionSlug: null,
      warnings: ["No mint link or address was provided."]
    };
  }

  const cached = getCache<ResolvedMintLink>(identityCache, `resolve:${trimmed}`);
  if (cached) return { ...cached, warnings: [...cached.warnings] };

  if (ethers.isAddress(trimmed)) {
    const address = ethers.getAddress(trimmed);
    const matches = await probeRawAddressChains(address, warnings);
    const chain = matches[0] || null;
    const resolved: ResolvedMintLink = {
      platform: "raw_address",
      chainName: chain?.name ?? null,
      chainId: chain?.chainId ?? null,
      chainConfidence: matches.length === 1 ? "medium" : matches.length > 1 ? "low" : "unknown",
      contractAddress: address,
      contractConfidence: "high",
      collectionSlug: null,
      warnings: [
        ...warnings,
        ...(matches.length > 1
          ? ["Raw address has code on multiple configured chains; chain confidence is low."]
          : [])
      ]
    };

    setCache(identityCache, `resolve:${trimmed}`, resolved, IDENTITY_CACHE_TTL_MS);
    return resolved;
  }

  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();
    const parts = url.pathname
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean);
    const address = getFirstAddress(url.toString());

    if (host.includes("opensea.io")) {
      const collectionIndex = parts.indexOf("collection");
      const assetIndex = parts.indexOf("assets");

      if (collectionIndex !== -1 && parts[collectionIndex + 1]) {
        const slug = parts[collectionIndex + 1]!;
        const collection = await fetchOpenSeaCollection(slug, warnings);
        const collectionDetails = collection ? extractOpenSeaContract(collection) : null;
        const resolved: ResolvedMintLink = {
          platform: "opensea",
          sourceUrl: url.toString(),
          chainName: collectionDetails?.chain?.name ?? "mainnet",
          chainId: collectionDetails?.chain?.chainId ?? 1,
          chainConfidence: collectionDetails?.chain ? "medium" : "low",
          contractAddress: collectionDetails?.contractAddress ?? null,
          contractConfidence: collectionDetails?.contractAddress ? "medium" : "unknown",
          collectionSlug: slug,
          warnings
        };

        setCache(identityCache, `resolve:${trimmed}`, resolved, IDENTITY_CACHE_TTL_MS);
        return resolved;
      }

      if (assetIndex !== -1) {
        const chain = normalizeChain(parts[assetIndex + 1]);
        const maybeAddress = parts[assetIndex + 2];

        if (maybeAddress && ethers.isAddress(maybeAddress)) {
          return {
            platform: "opensea",
            sourceUrl: url.toString(),
            chainName: chain?.name ?? null,
            chainId: chain?.chainId ?? null,
            chainConfidence: chain ? "medium" : "unknown",
            contractAddress: ethers.getAddress(maybeAddress),
            contractConfidence: "high",
            collectionSlug: null,
            warnings
          };
        }
      }
    }

    if (host.includes("zora.co")) {
      const collectIndex = parts.indexOf("collect");
      const collectValue = collectIndex === -1 ? null : parts[collectIndex + 1];

      if (collectValue) {
        const [chainRaw, addressRaw] = collectValue.split(":");
        const chain = normalizeChain(chainRaw);

        if (addressRaw && ethers.isAddress(addressRaw)) {
          return {
            platform: "zora",
            sourceUrl: url.toString(),
            chainName: chain?.name ?? null,
            chainId: chain?.chainId ?? null,
            chainConfidence: chain ? "medium" : "unknown",
            contractAddress: ethers.getAddress(addressRaw),
            contractConfidence: "high",
            collectionSlug: null,
            warnings
          };
        }
      }
    }

    const explorerChain = getChainFromExplorerHost(host);
    if (explorerChain) {
      return {
        platform: "explorer",
        sourceUrl: url.toString(),
        chainName: explorerChain.name,
        chainId: explorerChain.chainId,
        chainConfidence: "medium",
        contractAddress: address,
        contractConfidence: address ? "high" : "unknown",
        collectionSlug: null,
        warnings: address ? warnings : [...warnings, "Explorer link did not include a contract address."]
      };
    }

    if (host.includes("manifold") || host.includes("gallery")) {
      return {
        platform: "manifold",
        sourceUrl: url.toString(),
        chainName: null,
        chainId: null,
        chainConfidence: "unknown",
        contractAddress: address,
        contractConfidence: address ? "medium" : "unknown",
        collectionSlug: null,
        warnings: address ? warnings : [...warnings, "Manifold/gallery link did not expose a contract address."]
      };
    }

    if (host.includes("magiceden") || host.includes("blur.io")) {
      return {
        platform: host.includes("magiceden") ? "magiceden" : "blur",
        sourceUrl: url.toString(),
        chainName: null,
        chainId: null,
        chainConfidence: "unknown",
        contractAddress: address,
        contractConfidence: address ? "medium" : "unknown",
        collectionSlug: null,
        warnings: address ? warnings : [...warnings, "Marketplace link did not expose a contract address."]
      };
    }

    if (address) {
      return {
        platform: "generic",
        sourceUrl: url.toString(),
        chainName: null,
        chainId: null,
        chainConfidence: "unknown",
        contractAddress: address,
        contractConfidence: "low",
        collectionSlug: null,
        warnings: [...warnings, "Generic URL parsed by visible contract address only."]
      };
    }

    const { text, warning } = await fetchTextWithTimeout(url.toString());
    if (warning) warnings.push(warning);
    const pageAddress = text ? getFirstAddress(text) : null;

    return {
      platform: pageAddress ? "generic" : "unknown",
      sourceUrl: url.toString(),
      chainName: null,
      chainId: null,
      chainConfidence: "unknown",
      contractAddress: pageAddress,
      contractConfidence: pageAddress ? "low" : "unknown",
      collectionSlug: null,
      warnings: pageAddress
        ? [...warnings, "Generic mint page parsed by visible contract address only."]
        : [...warnings, "No supported mint link pattern or contract address was detected."]
    };
  } catch {
    const address = getFirstAddress(trimmed);

    return {
      platform: address ? "generic" : "unknown",
      chainName: null,
      chainId: null,
      chainConfidence: "unknown",
      contractAddress: address,
      contractConfidence: address ? "low" : "unknown",
      collectionSlug: null,
      warnings: address
        ? ["Text parsed by visible contract address only."]
        : ["No supported mint link pattern or contract address was detected."]
    };
  }
}

function normalizeTokenStandard(rawValue?: string | null): DetectorTokenStandard {
  const normalized = rawValue?.replace(/[-_\s]/g, "").toUpperCase();

  if (normalized === "ERC721") return "ERC721";
  if (normalized === "ERC721A") return "ERC721A";
  if (normalized === "ERC1155") return "ERC1155";
  return "unknown";
}

function functionSignature(fragment: AbiFunction) {
  const inputs = (fragment.inputs || []).map((input) => input.type).join(",");
  return `${fragment.name}(${inputs})`;
}

function selectorForSignature(signature: string) {
  return ethers.id(signature).slice(0, 10);
}

function isLikelyMintFunctionName(name: string) {
  const normalized = name.toLowerCase();

  if (EXCLUDED_FUNCTION_NAME_PATTERNS.some((pattern) => normalized.startsWith(pattern))) {
    return false;
  }

  return MINT_NAME_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function scoreAbiMintFunction(fragment: AbiFunction) {
  if (!isLikelyMintFunctionName(fragment.name)) return 0;

  let score = 20;
  const normalized = fragment.name.toLowerCase();
  const inputs = fragment.inputs || [];

  if (fragment.stateMutability === "payable") score += 30;
  if (["mint", "publicmint", "mintpublic", "claim"].includes(normalized)) score += 20;
  if (inputs.length <= 2) score += 10;
  if (inputs.some((input) => input.type.includes("bytes32") || input.type.includes("bytes"))) score -= 8;
  if (inputs.some((input) => input.type.includes("tuple"))) score -= 10;

  return score;
}

function scanAbiForMintFunctions(abi: any[]): FunctionCandidate[] {
  return abi
    .filter((item): item is AbiFunction => item?.type === "function" && typeof item.name === "string")
    .map((fragment) => {
      const score = scoreAbiMintFunction(fragment);
      const signature = functionSignature(fragment);

      return {
        name: fragment.name,
        signature,
        selector: selectorForSignature(signature),
        confidence: (score >= 50 ? "high" : score > 0 ? "medium" : "unknown") as DetectorConfidence,
        source: "abi" as const,
        score
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

function inferPlatformFromAbi(abi: any[]): DetectorPlatform {
  const names = abi
    .filter((item) => item?.type === "function" && typeof item.name === "string")
    .map((item) => item.name.toLowerCase());
  const joined = names.join(" ");

  if (joined.includes("seadrop") || joined.includes("getpublicdrop")) return "seadrop";
  if (joined.includes("claimcondition") || joined.includes("lazyminter")) return "thirdweb";
  if (joined.includes("manifold") || joined.includes("extension")) return "manifold";
  if (joined.includes("zoramint") || joined.includes("mintwithrewards")) return "zora";
  return "custom";
}

async function fetchEtherscanAbi(chain: DetectorChainConfig, address: string, warnings: string[]) {
  const apiKey = process.env.ETHERSCAN_API_KEY?.trim();

  if (!apiKey) {
    warnings.push("ETHERSCAN_API_KEY is not configured; verified ABI fallback is unavailable.");
    return null;
  }

  const cacheKey = `etherscan-abi:${chain.chainId}:${address}`;
  const cached = getCache<any[]>(identityCache, cacheKey);
  if (cached) return cached;

  const url = new URL("https://api.etherscan.io/v2/api");
  url.searchParams.set("chainid", String(chain.chainId));
  url.searchParams.set("module", "contract");
  url.searchParams.set("action", "getabi");
  url.searchParams.set("address", address);
  url.searchParams.set("apikey", apiKey);
  const { data, warning } = await fetchJsonWithTimeout(url.toString(), {
    accept: "application/json"
  });

  if (warning) warnings.push(warning);
  if (!data || data.status !== "1" || typeof data.result !== "string") {
    if (data?.result) warnings.push(`Etherscan ABI unavailable: ${String(data.result).slice(0, 120)}`);
    return null;
  }

  try {
    const abi = JSON.parse(data.result);
    setCache(identityCache, cacheKey, abi, IDENTITY_CACHE_TTL_MS);
    return Array.isArray(abi) ? abi : null;
  } catch {
    warnings.push("Etherscan ABI response could not be parsed.");
    return null;
  }
}

async function fetchRecentEtherscanTransactions(
  chain: DetectorChainConfig,
  address: string,
  warnings: string[]
) {
  const apiKey = process.env.ETHERSCAN_API_KEY?.trim();

  if (!apiKey) return [];

  const url = new URL("https://api.etherscan.io/v2/api");
  url.searchParams.set("chainid", String(chain.chainId));
  url.searchParams.set("module", "account");
  url.searchParams.set("action", "txlist");
  url.searchParams.set("address", address);
  url.searchParams.set("startblock", "0");
  url.searchParams.set("endblock", "99999999");
  url.searchParams.set("page", "1");
  url.searchParams.set("offset", "20");
  url.searchParams.set("sort", "desc");
  url.searchParams.set("apikey", apiKey);
  const { data, warning } = await fetchJsonWithTimeout(url.toString(), {
    accept: "application/json"
  });

  if (warning) warnings.push(warning);
  return Array.isArray(data?.result) ? data.result : [];
}

async function lookup4ByteSelector(selector: string, warnings: string[]) {
  const cacheKey = `4byte:${selector}`;
  const cached = getCache<string[]>(identityCache, cacheKey);
  if (cached) return cached;

  const url = new URL("https://www.4byte.directory/api/v1/signatures/");
  url.searchParams.set("hex_signature", selector);
  const { data, warning } = await fetchJsonWithTimeout(url.toString(), {
    accept: "application/json"
  });

  if (warning) warnings.push(warning);
  const signatures = Array.isArray(data?.results)
    ? data.results
        .map((result: any) => result?.text_signature)
        .filter((value: unknown): value is string => typeof value === "string")
        .slice(0, 10)
    : [];

  setCache(identityCache, cacheKey, signatures, IDENTITY_CACHE_TTL_MS);
  return signatures;
}

function extractSelectorsFromBytecode(bytecode: string) {
  const selectors = new Set<string>();

  for (const match of bytecode.matchAll(/63([0-9a-fA-F]{8})/g)) {
    selectors.add(`0x${match[1]!.toLowerCase()}`);
  }

  return [...selectors];
}

async function scanBytecodeForMintFunctions(bytecode: string, warnings: string[]) {
  const bytecodeLower = bytecode.toLowerCase();
  const common = COMMON_MINT_SIGNATURES.map((signature) => ({
    name: signature.split("(")[0] || signature,
    signature,
    selector: selectorForSignature(signature),
    confidence: bytecodeLower.includes(selectorForSignature(signature).slice(2)) ? "medium" : "unknown" as DetectorConfidence,
    source: "supported-selector" as const,
    score: bytecodeLower.includes(selectorForSignature(signature).slice(2)) ? 25 : 0
  })).filter((candidate) => candidate.score > 0);

  if (common.length > 0) {
    return common;
  }

  const selectors = extractSelectorsFromBytecode(bytecode).slice(0, 20);
  const candidates: FunctionCandidate[] = [];

  for (const selector of selectors) {
    const signatures = await lookup4ByteSelector(selector, warnings);

    for (const signature of signatures) {
      const name = signature.split("(")[0] || signature;

      if (!isLikelyMintFunctionName(name)) continue;

      candidates.push({
        name,
        signature,
        selector,
        confidence: "low",
        source: "bytecode-4byte",
        score: 10
      });
    }
  }

  return candidates.slice(0, 10);
}

async function callGetter(
  provider: ethers.Provider,
  address: string,
  functionName: string,
  returnType: "uint256" | "bool" | "bytes32",
  args: unknown[] = []
) {
  const argTypes = args.map((arg) => ethers.isAddress(String(arg)) ? "address" : "uint256");
  const iface = new ethers.Interface([
    `function ${functionName}(${argTypes.join(",")}) view returns (${returnType})`
  ]);

  try {
    const result = await withTimeout(
      provider.call({
        to: address,
        data: iface.encodeFunctionData(functionName, args)
      }),
      RPC_TIMEOUT_MS,
      `${functionName} call timed out`
    );
    const decoded = iface.decodeFunctionResult(functionName, result);
    return decoded[0] as bigint | boolean | string;
  } catch {
    return null;
  }
}

async function firstUintGetter(provider: ethers.Provider, address: string, names: string[]) {
  for (const name of names) {
    const value = await callGetter(provider, address, name, "uint256");

    if (typeof value === "bigint") {
      return { name, value };
    }
  }

  return null;
}

async function firstBoolGetter(provider: ethers.Provider, address: string, names: string[]) {
  for (const name of names) {
    const value = await callGetter(provider, address, name, "bool");

    if (typeof value === "boolean") {
      return { name, value };
    }
  }

  return null;
}

function timestampToIso(value: bigint | null | undefined) {
  if (typeof value !== "bigint") return null;
  const numeric = Number(value);

  if (!Number.isSafeInteger(numeric) || numeric <= 0) return null;

  const ms = numeric > 10_000_000_000 ? numeric : numeric * 1000;
  return new Date(ms).toISOString();
}

function classifyOnChainPhase(params: {
  active: boolean | null;
  paused: boolean | null;
  startTime: bigint | null;
  endTime: bigint | null;
}): { status: DetectorPhaseStatus; confidence: DetectorConfidence } {
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (params.paused === true) return { status: "paused", confidence: "medium" };
  if (params.active === true) return { status: "public", confidence: "medium" };

  if (params.startTime && Number(params.startTime) > nowSeconds) {
    return { status: "not-started", confidence: "medium" };
  }

  if (params.endTime && Number(params.endTime) > 0 && Number(params.endTime) <= nowSeconds) {
    return { status: "ended", confidence: "medium" };
  }

  return { status: "unknown", confidence: "unknown" };
}

function inferPriceFromTxHistory(params: {
  txs: any[];
  candidate: FunctionCandidate | null;
  abi: any[] | null;
}) {
  if (!params.candidate) return null;

  const tx = params.txs.find((candidateTx) => {
    const input = String(candidateTx.input || "").toLowerCase();
    const value = BigInt(candidateTx.value || "0");
    return (
      input.startsWith(params.candidate!.selector.toLowerCase()) &&
      value > 0n &&
      candidateTx.isError !== "1" &&
      candidateTx.txreceipt_status !== "0"
    );
  });

  if (!tx) return null;

  let quantity = 1n;
  const value = BigInt(tx.value || "0");

  if (params.abi) {
    try {
      const iface = new ethers.Interface(params.abi);
      const parsed = iface.parseTransaction({ data: tx.input, value });
      const numericArg = parsed?.args.find(
        (arg: unknown) => typeof arg === "bigint" && arg > 0n && arg < 10_000n
      );

      if (typeof numericArg === "bigint") {
        quantity = numericArg;
      }
    } catch {
      quantity = 1n;
    }
  }

  const priceWei = value / quantity;

  return priceWei > 0n
    ? {
        wei: priceWei.toString(),
        eth: ethers.formatEther(priceWei)
      }
    : null;
}

async function detectTokenStandard(provider: ethers.Provider, address: string, abi: any[] | null) {
  const abiNames = (abi || [])
    .filter((item) => item?.type === "function" && typeof item.name === "string")
    .map((item) => item.name.toLowerCase());

  if (abiNames.includes("explicitownershipof") || abiNames.includes("totalminted")) {
    return "ERC721A" as DetectorTokenStandard;
  }

  const iface = new ethers.Interface(["function supportsInterface(bytes4) view returns (bool)"]);

  async function supports(interfaceId: string) {
    try {
      const result = await withTimeout(
        provider.call({
          to: address,
          data: iface.encodeFunctionData("supportsInterface", [interfaceId])
        }),
        RPC_TIMEOUT_MS,
        "supportsInterface timed out"
      );
      const decoded = iface.decodeFunctionResult("supportsInterface", result);
      return decoded[0] === true;
    } catch {
      return false;
    }
  }

  if (await supports("0xd9b67a26")) return "ERC1155";
  if (await supports("0x80ac58cd")) return "ERC721";
  return "unknown";
}

function toNumber(value: bigint | null | undefined) {
  if (typeof value !== "bigint") return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : null;
}

async function detectEligibility(params: {
  provider: ethers.Provider | null;
  contractAddress: string | null;
  walletAddress: string | null;
  stages: DetectorStage[];
  maxPerWalletFromContract: number | null;
}) {
  if (!params.walletAddress) return null;

  let walletAlreadyMinted: number | null = null;
  let maxPerWallet = params.maxPerWalletFromContract;
  let allowlistDetected = params.stages.some((stage) =>
    ["allowlist", "presale", "whitelist", "gtd"].some((keyword) =>
      `${stage.name || ""} ${stage.kind || ""}`.toLowerCase().includes(keyword)
    )
  );

  for (const stage of params.stages) {
    if (stage.maxPerWallet !== null && maxPerWallet === null) {
      maxPerWallet = stage.maxPerWallet;
    }
  }

  if (params.provider && params.contractAddress) {
    for (const name of WALLET_MINT_COUNT_GETTERS) {
      const value = await callGetter(
        params.provider,
        params.contractAddress,
        name,
        "uint256",
        [params.walletAddress]
      );

      if (typeof value === "bigint") {
        walletAlreadyMinted = toNumber(value);
        break;
      }
    }

    for (const name of MERKLE_ROOT_GETTERS) {
      const value = await callGetter(params.provider, params.contractAddress, name, "bytes32");

      if (
        typeof value === "string" &&
        value !== ZERO_BYTES32
      ) {
        allowlistDetected = true;
        break;
      }
    }
  }

  const maxExceeded =
    maxPerWallet !== null &&
    walletAlreadyMinted !== null &&
    walletAlreadyMinted >= maxPerWallet;

  return {
    allowlistDetected,
    walletOnAllowlist: "unknown" as const,
    walletAlreadyMinted,
    maxPerWallet,
    estimate: maxExceeded ? "not-eligible" as const : "unknown" as const
  };
}

function extractObjectArrayByKey(value: unknown, keyNames: string[], depth = 0): any[] {
  if (depth > 8 || !value || typeof value !== "object") return [];
  const results: any[] = [];

  if (Array.isArray(value)) {
    for (const item of value) {
      results.push(...extractObjectArrayByKey(item, keyNames, depth + 1));
    }

    return results;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (keyNames.includes(key) && Array.isArray(child)) {
      results.push(...child.filter((item) => item && typeof item === "object"));
    }

    results.push(...extractObjectArrayByKey(child, keyNames, depth + 1));
  }

  return results;
}

function getNestedString(value: any, paths: string[]) {
  for (const path of paths) {
    const found = path.split(".").reduce((current, key) => current?.[key], value);

    if (typeof found === "string" && found.trim()) {
      return found.trim();
    }
  }

  return null;
}

function getNestedNumber(value: any, paths: string[]) {
  for (const path of paths) {
    const found = path.split(".").reduce((current, key) => current?.[key], value);
    const numeric = Number(found);

    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  return null;
}

function normalizeStageStatus(rawStage: any): DetectorPhaseStatus {
  const text = JSON.stringify(rawStage).toLowerCase();
  const now = Date.now();
  const startRaw = getNestedString(rawStage, ["startTime", "start", "startAt", "startsAt"]);
  const endRaw = getNestedString(rawStage, ["endTime", "end", "endAt", "endsAt"]);
  const startMs = startRaw ? Date.parse(startRaw) : NaN;
  const endMs = endRaw ? Date.parse(endRaw) : NaN;

  if (text.includes("paused")) return "paused";
  if (text.includes("allowlist") || text.includes("whitelist") || text.includes("presale")) {
    return "allowlist";
  }
  if (text.includes("active") || text.includes("live") || text.includes("public")) {
    return "public";
  }
  if (Number.isFinite(startMs) && startMs > now) return "not-started";
  if (Number.isFinite(endMs) && endMs <= now) return "ended";
  return "unknown";
}

function parsePriceWeiFromStage(rawStage: any): { wei: string | null; eth: string | null; text: string | null; currency: "ETH" | "ERC20" | "unknown"; currencyAddress: string | null } {
  const currencyAddress = getNestedString(rawStage, [
    "price.currency.address",
    "currency.address",
    "currencyAddress"
  ]);
  const native = getNestedNumber(rawStage, [
    "price.amount.native",
    "price.amount.decimal",
    "price.native",
    "price.decimal",
    "price"
  ]);
  const raw = getNestedString(rawStage, [
    "price.amount.raw",
    "price.raw",
    "priceWei",
    "weiPrice"
  ]);
  const text = getNestedString(rawStage, ["priceText", "priceDisplay", "displayPrice"]);

  if (raw && /^\d+$/.test(raw)) {
    return {
      wei: raw,
      eth: ethers.formatEther(BigInt(raw)),
      text,
      currency: currencyAddress ? "ERC20" : "ETH",
      currencyAddress
    };
  }

  if (native !== null && native >= 0) {
    try {
      const wei = ethers.parseEther(String(native));
      return {
        wei: wei.toString(),
        eth: ethers.formatEther(wei),
        text: text || `${native} ETH`,
        currency: currencyAddress ? "ERC20" : "ETH",
        currencyAddress
      };
    } catch {
      return { wei: null, eth: null, text, currency: currencyAddress ? "ERC20" : "unknown", currencyAddress };
    }
  }

  return { wei: null, eth: null, text, currency: currencyAddress ? "ERC20" : "unknown", currencyAddress };
}

function normalizeReservoirStage(rawStage: any): DetectorStage {
  const name = getNestedString(rawStage, ["name", "stage", "kind", "phase", "title"]);
  const kind = getNestedString(rawStage, ["kind", "stage", "type", "phase"]);
  const price = parsePriceWeiFromStage(rawStage);
  const startTime = getNestedString(rawStage, ["startTime", "start", "startAt", "startsAt"]);
  const endTime = getNestedString(rawStage, ["endTime", "end", "endAt", "endsAt"]);
  const maxPerWallet = getNestedNumber(rawStage, [
    "maxPerWallet",
    "maxMintsPerWallet",
    "maxMintablePerWallet",
    "limitPerWallet",
    "walletLimit"
  ]);
  const eligibilityText = getNestedString(rawStage, [
    "eligibility",
    "eligibilityText",
    "walletEligibility.status"
  ]);

  return {
    name,
    kind,
    status: normalizeStageStatus(rawStage),
    startTime,
    endTime,
    priceWei: price.wei,
    priceEth: price.eth,
    priceText: price.text,
    currency: price.currency,
    currencyAddress: price.currencyAddress,
    maxPerWallet: maxPerWallet === null ? null : Math.trunc(maxPerWallet),
    eligibilityText,
    source: "reservoir",
    confidence: "high"
  };
}

function pickCurrentStage(stages: DetectorStage[]) {
  return (
    stages.find((stage) => stage.status === "public") ||
    stages.find((stage) => stage.status === "allowlist") ||
    stages.find((stage) => stage.status === "not-started") ||
    stages[0] ||
    null
  );
}

function getFunctionCandidateFromReservoir(data: any): FunctionCandidate | null {
  const text = JSON.stringify(data);
  const signatureMatch = text.match(/\b([A-Za-z_][A-Za-z0-9_]*)\(([^)]*)\)/);

  if (!signatureMatch) return null;

  const signature = signatureMatch[0];
  const name = signatureMatch[1] || signature;

  if (!isLikelyMintFunctionName(name)) return null;

  return {
    name,
    signature,
    selector: selectorForSignature(signature),
    confidence: "medium",
    source: "reservoir",
    score: 40
  };
}

async function detectReservoir(params: {
  resolved: ResolvedMintLink;
  warnings: string[];
}) {
  const apiKey = process.env.RESERVOIR_API_KEY?.trim();

  if (!apiKey) {
    params.warnings.push("RESERVOIR_API_KEY is not configured; Reservoir mint-stage lookup skipped.");
    return null;
  }

  const chain =
    getChainById(params.resolved.chainId) ||
    normalizeChain(params.resolved.chainName) ||
    DETECTOR_CHAINS[0]!;
  const urls: string[] = [];

  if (params.resolved.contractAddress) {
    urls.push(
      `${chain.reservoirBaseUrl}/collections/v7?id=${encodeURIComponent(params.resolved.contractAddress)}&includeMintStages=true`
    );
  }

  if (params.resolved.collectionSlug) {
    urls.push(
      `${chain.reservoirBaseUrl}/collections/v7?slug=${encodeURIComponent(params.resolved.collectionSlug)}&includeMintStages=true`
    );
  }

  if (urls.length === 0) return null;

  for (const url of urls) {
    const cacheKey = `reservoir:${url}`;
    const cached = getCache<any>(liveCache, cacheKey);
    const data = cached || (await fetchJsonWithTimeout(url, {
      accept: "application/json",
      "x-api-key": apiKey
    })).data;

    if (!cached && data) {
      setCache(liveCache, cacheKey, data, LIVE_CACHE_TTL_MS);
    }

    if (!data) continue;

    const collections = Array.isArray(data.collections)
      ? data.collections
      : data.collection
        ? [data.collection]
        : [data];
    const collection = collections[0];
    const stages = extractObjectArrayByKey(data, ["mintStages", "stages"])
      .map(normalizeReservoirStage)
      .filter((stage) => stage.name || stage.kind || stage.priceWei || stage.startTime || stage.status !== "unknown");
    const candidate = getFunctionCandidateFromReservoir(data);
    const contractAddress =
      getNestedString(collection, ["id", "contract", "contractAddress", "primaryContract"]) ||
      params.resolved.contractAddress;

    return {
      chain,
      collection,
      contractAddress: contractAddress && ethers.isAddress(contractAddress)
        ? ethers.getAddress(contractAddress)
        : params.resolved.contractAddress,
      tokenStandard: normalizeTokenStandard(
        getNestedString(collection, ["tokenStandard", "kind", "contractKind"])
      ),
      platform: "reservoir-detected" as DetectorPlatform,
      stages,
      candidate
    };
  }

  return null;
}

async function detectOnChain(params: {
  chain: DetectorChainConfig | null;
  contractAddress: string | null;
  walletAddress: string | null;
  warnings: string[];
}) {
  if (!params.chain || !params.contractAddress) {
    return null;
  }

  const provider = getProvider(params.chain);

  if (!provider) {
    params.warnings.push(`No RPC URL configured for ${params.chain.name}; on-chain fallback skipped.`);
    return null;
  }

  let bytecode = "0x";

  try {
    bytecode = await withTimeout(
      provider.getCode(params.contractAddress),
      RPC_TIMEOUT_MS,
      `${params.chain.name} getCode timed out`
    );
  } catch (error) {
    params.warnings.push(`Could not read contract bytecode: ${getSafeDetectorError(error)}`);
  }

  if (bytecode === "0x") {
    params.warnings.push("No contract code was found on the selected chain.");
    return { provider, bytecode, abi: null, candidates: [], platform: "unknown" as DetectorPlatform };
  }

  const abi = await fetchEtherscanAbi(params.chain, params.contractAddress, params.warnings);
  const abiCandidates = abi ? scanAbiForMintFunctions(abi) : [];
  const bytecodeCandidates = abiCandidates.length > 0
    ? []
    : await scanBytecodeForMintFunctions(bytecode, params.warnings);
  const candidates = [...abiCandidates, ...bytecodeCandidates].sort((a, b) => b.score - a.score);
  const platform = abi ? inferPlatformFromAbi(abi) : "unknown";
  const price = await firstUintGetter(provider, params.contractAddress, PRICE_GETTERS);
  const start = await firstUintGetter(provider, params.contractAddress, START_TIME_GETTERS);
  const end = await firstUintGetter(provider, params.contractAddress, END_TIME_GETTERS);
  const active = await firstBoolGetter(provider, params.contractAddress, ACTIVE_GETTERS);
  const paused = await firstBoolGetter(provider, params.contractAddress, PAUSED_GETTERS);
  const maxPerWallet = await firstUintGetter(provider, params.contractAddress, MAX_PER_WALLET_GETTERS);
  const phase = classifyOnChainPhase({
    active: active?.value ?? null,
    paused: paused?.value ?? null,
    startTime: start?.value ?? null,
    endTime: end?.value ?? null
  });
  let txInferredPrice: { wei: string; eth: string } | null = null;

  if (!price && candidates[0]) {
    const txs = await fetchRecentEtherscanTransactions(
      params.chain,
      params.contractAddress,
      params.warnings
    );
    txInferredPrice = inferPriceFromTxHistory({
      txs,
      candidate: candidates[0] || null,
      abi
    });
  }

  return {
    provider,
    bytecode,
    abi,
    candidates,
    platform,
    tokenStandard: await detectTokenStandard(provider, params.contractAddress, abi),
    priceWei: price ? price.value.toString() : txInferredPrice?.wei ?? null,
    priceEth: price ? ethers.formatEther(price.value) : txInferredPrice?.eth ?? null,
    priceSource: price ? "contract-read" as const : txInferredPrice ? "tx-history-inference" as const : "unavailable" as const,
    startTime: timestampToIso(start?.value),
    endTime: timestampToIso(end?.value),
    phase,
    maxPerWallet: toNumber(maxPerWallet?.value ?? null)
  };
}

function mergeDetectorResult(params: {
  base: StructuredMintDetectionResult;
  resolved: ResolvedMintLink;
  reservoir: Awaited<ReturnType<typeof detectReservoir>>;
  onChain: Awaited<ReturnType<typeof detectOnChain>>;
}) {
  const result = params.base;
  const reservoir = params.reservoir;
  const onChain = params.onChain;
  const chain =
    reservoir?.chain ||
    getChainById(params.resolved.chainId) ||
    normalizeChain(params.resolved.chainName);
  const stages = reservoir?.stages || [];
  const currentStage = pickCurrentStage(stages);
  const candidate = reservoir?.candidate || onChain?.candidates?.[0] || null;
  const contractAddress =
    reservoir?.contractAddress ||
    params.resolved.contractAddress ||
    null;

  result.chain = {
    name: chain?.name ?? params.resolved.chainName,
    chainId: chain?.chainId ?? params.resolved.chainId,
    confidence: chain
      ? params.resolved.chainConfidence === "unknown" ? "medium" : params.resolved.chainConfidence
      : "unknown"
  };
  result.contract = {
    address: contractAddress,
    collectionSlug: params.resolved.collectionSlug,
    tokenStandard:
      reservoir?.tokenStandard !== "unknown"
        ? reservoir?.tokenStandard || "unknown"
        : onChain?.tokenStandard || "unknown",
    platform:
      onChain?.platform && onChain.platform !== "unknown"
        ? onChain.platform
        : reservoir?.platform || "unknown",
    verifiedSource: Boolean(onChain?.abi)
  };

  if (candidate) {
    result.mint.function = {
      name: candidate.name,
      signature: candidate.signature,
      selector: candidate.selector,
      confidence: candidate.confidence,
      source: candidate.source
    };
  }

  if (currentStage?.priceWei) {
    result.mint.price = {
      wei: currentStage.priceWei,
      eth: currentStage.priceEth,
      currency: currentStage.currency,
      currencyAddress: currentStage.currencyAddress,
      source: "reservoir",
      confidence: currentStage.confidence
    };
  } else if (onChain?.priceWei) {
    result.mint.price = {
      wei: onChain.priceWei,
      eth: onChain.priceEth,
      currency: "ETH",
      currencyAddress: null,
      source: onChain.priceSource,
      confidence: onChain.priceSource === "tx-history-inference" ? "low" : "medium"
    };
  }

  result.mint.phase = {
    status:
      currentStage?.status && currentStage.status !== "unknown"
        ? currentStage.status
        : onChain?.phase?.status || "unknown",
    startTime: currentStage?.startTime || onChain?.startTime || null,
    endTime: currentStage?.endTime || onChain?.endTime || null,
    confidence:
      currentStage?.status && currentStage.status !== "unknown"
        ? currentStage.confidence
        : onChain?.phase?.confidence || "unknown"
  };
  result.mint.stages = stages;

  return result;
}

export function getConfiguredDetectorRpcStatus() {
  return DETECTOR_CHAINS.map((chain) => ({
    name: chain.name,
    chainId: chain.chainId,
    configured: Boolean(getConfiguredRpcUrl(chain))
  }));
}

export async function detectMintStructured(
  link: string,
  walletAddress?: string
): Promise<StructuredMintDetectionResult> {
  const result = makeUnknownResult(link, walletAddress);

  try {
    const resolved = await resolveMintLink(link);
    result.warnings.push(...resolved.warnings);

    if (!resolved.contractAddress && !resolved.collectionSlug) {
      result.warnings.push("No contract address or collection slug was resolved.");
      return result;
    }

    const reservoir = await detectReservoir({
      resolved,
      warnings: result.warnings
    });
    const chain =
      reservoir?.chain ||
      getChainById(resolved.chainId) ||
      normalizeChain(resolved.chainName);
    const contractAddress =
      reservoir?.contractAddress ||
      resolved.contractAddress;
    const onChain = await detectOnChain({
      chain,
      contractAddress,
      walletAddress: result.input.walletChecked,
      warnings: result.warnings
    });
    mergeDetectorResult({
      base: result,
      resolved,
      reservoir,
      onChain
    });
    result.eligibility = await detectEligibility({
      provider: onChain?.provider || null,
      contractAddress: result.contract.address,
      walletAddress: result.input.walletChecked,
      stages: result.mint.stages,
      maxPerWalletFromContract: onChain?.maxPerWallet ?? null
    });
  } catch (error) {
    result.warnings.push(`Detector failed safely: ${getSafeDetectorError(error)}`);
  }

  return result;
}
