import { ethers } from "ethers";
import type { MintChain } from "./mintEngine.js";

type ResolverConfidence = "high" | "medium" | "low" | "unknown";

export type OpenSeaResolvedContractCandidate = {
  address: string;
  chainName: string;
  supportedMintChain?: MintChain;
  tokenStandard?: string;
  source: string;
  confidence: ResolverConfidence;
};

export type OpenSeaCollectionSuggestion = {
  slug: string;
  name?: string;
  source: string;
};

export type OpenSeaContractResolverResult =
  | {
      status: "resolved";
      slug: string;
      candidate: OpenSeaResolvedContractCandidate;
      candidates: OpenSeaResolvedContractCandidate[];
    }
  | {
      status: "multiple_candidates";
      slug: string;
      candidates: OpenSeaResolvedContractCandidate[];
    }
  | {
      status: "slug_suggestions";
      slug: string;
      suggestions: OpenSeaCollectionSuggestion[];
    }
  | {
      status:
        | "missing_api_key"
        | "auth_error"
        | "not_found"
        | "rate_limited"
        | "network_error"
        | "no_contracts"
        | "invalid_input";
      slug?: string;
      message: string;
      httpStatus?: number;
    };

const OPEN_SEA_API_BASE = "https://api.opensea.io/api/v2";
const OPEN_SEA_RESOLVER_TIMEOUT_MS = 12_000;

function normalizeOpenSeaApiKey(raw?: string) {
  if (!raw) return null;

  const trimmed = raw.trim();
  const unquoted = trimmed.replace(/^["']|["']$/g, "").trim();

  return unquoted || null;
}

function getOpenSeaApiKeyDiagnostics() {
  const raw = process.env.OPENSEA_API_KEY;

  return {
    present: Boolean(raw),
    hadWhitespace: Boolean(raw && raw !== raw.trim()),
    hadWrappingQuotes: Boolean(raw && /^["'].*["']$/.test(raw.trim())),
    normalizedLength: normalizeOpenSeaApiKey(raw)?.length || 0
  };
}

function logResolver(event: string, details: Record<string, unknown>) {
  console.log(`[opensea-contract-resolver] ${event} ${JSON.stringify(details)}`);
}

function getResponseSnippet(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

export function extractOpenSeaCollectionSlug(input: string): string | null {
  const trimmed = input.trim();

  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);

    if (!/(^|\.)opensea\.io$/i.test(url.hostname)) {
      return null;
    }

    const parts = url.pathname.split("/").filter(Boolean);
    const collectionIndex = parts.findIndex((part) => part.toLowerCase() === "collection");

    if (collectionIndex === -1 || !parts[collectionIndex + 1]) {
      return null;
    }

    return decodeURIComponent(parts[collectionIndex + 1]!).trim() || null;
  } catch {
    const withoutQuery = trimmed.split("?")[0]!.split("#")[0]!.replace(/^\/+|\/+$/g, "");

    if (/^[a-z0-9][a-z0-9_-]{1,120}$/i.test(withoutQuery)) {
      return withoutQuery;
    }

    return null;
  }
}

function mapOpenSeaChainToMintChain(rawChain?: string): {
  chainName: string;
  supportedMintChain?: MintChain;
} {
  const normalized = rawChain?.trim().toLowerCase().replace(/\s+/g, "_") || "unknown";

  if (
    normalized === "ethereum" ||
    normalized === "eth" ||
    normalized === "mainnet" ||
    normalized === "ethereum_mainnet"
  ) {
    return { chainName: "mainnet", supportedMintChain: "mainnet" };
  }

  if (normalized === "sepolia" || normalized === "ethereum_sepolia") {
    return { chainName: "sepolia", supportedMintChain: "sepolia" };
  }

  return { chainName: normalized };
}

function getStringField(source: any, names: string[]) {
  if (!source || typeof source !== "object") return undefined;

  for (const name of names) {
    const value = source[name];

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }

    if (value && typeof value === "object") {
      if (typeof value.address === "string" && value.address.trim()) {
        return value.address.trim();
      }

      if (typeof value.slug === "string" && value.slug.trim()) {
        return value.slug.trim();
      }

      if (typeof value.name === "string" && value.name.trim()) {
        return value.name.trim();
      }
    }
  }

  return undefined;
}

function getChainField(source: any) {
  return getStringField(source, [
    "chain",
    "chain_name",
    "chainName",
    "chain_identifier",
    "chainIdentifier",
    "network",
    "network_name",
    "blockchain"
  ]);
}

function getTokenStandard(source: any) {
  return getStringField(source, [
    "token_standard",
    "tokenStandard",
    "schema_name",
    "schemaName",
    "standard"
  ]);
}

function collectCandidatesFromJson(
  value: unknown,
  options: {
    path?: string;
    chainHint?: string;
    sourceHint?: string;
    seenObjects?: WeakSet<object>;
  } = {}
): OpenSeaResolvedContractCandidate[] {
  const candidates: OpenSeaResolvedContractCandidate[] = [];
  const path = options.path || "$";
  const seenObjects = options.seenObjects || new WeakSet<object>();

  if (!value || typeof value !== "object") {
    return candidates;
  }

  if (seenObjects.has(value)) {
    return candidates;
  }

  seenObjects.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      candidates.push(
        ...collectCandidatesFromJson(item, {
          path: `${path}[${index}]`,
          ...(options.chainHint ? { chainHint: options.chainHint } : {}),
          ...(options.sourceHint ? { sourceHint: options.sourceHint } : {}),
          seenObjects
        })
      );
    });
    return candidates;
  }

  const objectValue = value as Record<string, unknown>;
  const address = getStringField(objectValue, [
    "address",
    "contract_address",
    "contractAddress",
    "contract",
    "primary_asset_contract"
  ]);

  const chainRaw = getChainField(objectValue) || options.chainHint;
  const mappedChain = mapOpenSeaChainToMintChain(chainRaw);
  const tokenStandard = getTokenStandard(objectValue);

  if (address && ethers.isAddress(address)) {
    candidates.push({
      address: ethers.getAddress(address),
      chainName: mappedChain.chainName,
      ...(mappedChain.supportedMintChain ? { supportedMintChain: mappedChain.supportedMintChain } : {}),
      ...(tokenStandard ? { tokenStandard } : {}),
      source: options.sourceHint || path,
      confidence: mappedChain.supportedMintChain ? "high" : "medium"
    });
  }

  for (const [key, child] of Object.entries(objectValue)) {
    const nextChainHint = /chain|network|blockchain/i.test(key)
      ? typeof child === "string"
        ? child
        : chainRaw
      : chainRaw;

    candidates.push(
      ...collectCandidatesFromJson(child, {
        path: `${path}.${key}`,
        chainHint: nextChainHint,
        sourceHint: key,
        seenObjects
      })
    );
  }

  return candidates;
}

const IGNORED_OPEN_SEA_CONTRACT_ADDRESSES = new Set([
  "0x0000000000000000000000000000000000000000",
  // WETH mainnet. OpenSea responses often include this as payment/currency metadata.
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
]);

function isLikelyPaymentOrCurrencyCandidate(candidate: OpenSeaResolvedContractCandidate) {
  const address = candidate.address.toLowerCase();

  if (IGNORED_OPEN_SEA_CONTRACT_ADDRESSES.has(address)) {
    return true;
  }

  const source = candidate.source.toLowerCase();

  return /payment|currency|fee|fees|price|token/i.test(source);
}

function dedupeCandidates(candidates: OpenSeaResolvedContractCandidate[]) {
  const byKey = new Map<string, OpenSeaResolvedContractCandidate>();

  for (const candidate of candidates) {
    if (isLikelyPaymentOrCurrencyCandidate(candidate)) {
      continue;
    }

    const key = `${candidate.chainName}:${candidate.address.toLowerCase()}`;
    const existing = byKey.get(key);

    if (!existing || existing.confidence === "medium") {
      byKey.set(key, candidate);
    }
  }

  return [...byKey.values()].sort((a, b) => {
    const rank = (candidate: OpenSeaResolvedContractCandidate) => {
      if (candidate.supportedMintChain === "mainnet") return 0;
      if (candidate.supportedMintChain === "sepolia") return 1;
      return 2;
    };

    return rank(a) - rank(b);
  });
}

function collectCollectionSuggestions(value: unknown): OpenSeaCollectionSuggestion[] {
  const suggestions: OpenSeaCollectionSuggestion[] = [];
  const seenObjects = new WeakSet<object>();

  function visit(current: unknown, path: string) {
    if (!current || typeof current !== "object") return;

    if (seenObjects.has(current)) return;
    seenObjects.add(current);

    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }

    const objectValue = current as Record<string, unknown>;
    const slug = getStringField(objectValue, [
      "collection_slug",
      "collectionSlug",
      "slug",
      "identifier"
    ]);
    const name = getStringField(objectValue, ["name", "collection_name", "collectionName"]);
    const assetType = getStringField(objectValue, ["asset_type", "assetType", "type"]);

    if (
      slug &&
      /^[a-z0-9][a-z0-9_-]{1,120}$/i.test(slug) &&
      (!assetType || /collection/i.test(assetType))
    ) {
      suggestions.push({
        slug,
        ...(name ? { name } : {}),
        source: path
      });
    }

    for (const [key, child] of Object.entries(objectValue)) {
      visit(child, `${path}.${key}`);
    }
  }

  visit(value, "$");

  const bySlug = new Map<string, OpenSeaCollectionSuggestion>();

  for (const suggestion of suggestions) {
    if (!bySlug.has(suggestion.slug)) {
      bySlug.set(suggestion.slug, suggestion);
    }
  }

  return [...bySlug.values()].slice(0, 5);
}

async function fetchOpenSeaJson(url: string, apiKey: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPEN_SEA_RESOLVER_TIMEOUT_MS);

  try {
    logResolver("request", {
      url,
      headers: { "x-api-key": "***" }
    });

    const response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-api-key": apiKey
      },
      signal: controller.signal
    });

    const bodyText = await response.text();

    logResolver("response", {
      url,
      status: response.status,
      ok: response.ok,
      responseSnippet: response.ok ? undefined : getResponseSnippet(bodyText)
    });

    if (!response.ok) {
      return {
        ok: false as const,
        status: response.status,
        responseSnippet: getResponseSnippet(bodyText)
      };
    }

    try {
      return {
        ok: true as const,
        status: response.status,
        data: bodyText ? JSON.parse(bodyText) : {}
      };
    } catch {
      return {
        ok: false as const,
        status: response.status,
        responseSnippet: "OpenSea returned non-JSON response."
      };
    }
  } catch (error) {
    logResolver("network_error", {
      url,
      reason: error instanceof Error ? error.message : "Unknown error"
    });

    return {
      ok: false as const,
      status: 0,
      responseSnippet: error instanceof Error ? error.message.slice(0, 300) : "Unknown network error"
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function searchOpenSeaCollections(slug: string, apiKey: string) {
  const url = `${OPEN_SEA_API_BASE}/search?query=${encodeURIComponent(slug)}&asset_types=collection&limit=5`;
  const result = await fetchOpenSeaJson(url, apiKey);

  if (!result.ok) {
    return [];
  }

  return collectCollectionSuggestions(result.data);
}

export function formatOpenSeaResolverCandidate(candidate: OpenSeaResolvedContractCandidate) {
  const standard = candidate.tokenStandard ? ` ${candidate.tokenStandard}` : "";
  return `${candidate.chainName}${standard}: ${candidate.address.slice(0, 6)}...${candidate.address.slice(-4)}`;
}

export async function resolveOpenSeaContractForMintFlow(
  input: string
): Promise<OpenSeaContractResolverResult> {
  const slug = extractOpenSeaCollectionSlug(input);

  logResolver("start", {
    inputKind: /^https?:\/\//i.test(input.trim()) ? "url" : "slug",
    extractedSlug: slug,
    apiKey: getOpenSeaApiKeyDiagnostics()
  });

  if (!slug) {
    return {
      status: "invalid_input",
      message: "This does not look like an OpenSea collection link or slug."
    };
  }

  const apiKey = normalizeOpenSeaApiKey(process.env.OPENSEA_API_KEY);

  if (!apiKey) {
    return {
      status: "missing_api_key",
      slug,
      message: "OPENSEA_API_KEY is missing in the running bot environment."
    };
  }

  const url = `${OPEN_SEA_API_BASE}/collections/${encodeURIComponent(slug)}`;
  const result = await fetchOpenSeaJson(url, apiKey);

  if (!result.ok) {
    if (result.status === 401 || result.status === 403) {
      return {
        status: "auth_error",
        slug,
        httpStatus: result.status,
        message: "OpenSea API authentication failed."
      };
    }

    if (result.status === 404) {
      const suggestions = await searchOpenSeaCollections(slug, apiKey);

      if (suggestions.length > 0) {
        return {
          status: "slug_suggestions",
          slug,
          suggestions
        };
      }

      return {
        status: "not_found",
        slug,
        httpStatus: result.status,
        message: "OpenSea did not find this collection slug."
      };
    }

    if (result.status === 429) {
      return {
        status: "rate_limited",
        slug,
        httpStatus: result.status,
        message: "OpenSea rate limit hit."
      };
    }

    return {
      status: "network_error",
      slug,
      ...(result.status ? { httpStatus: result.status } : {}),
      message: result.responseSnippet || "Could not reach OpenSea."
    };
  }

  const candidates = dedupeCandidates(collectCandidatesFromJson(result.data));

  logResolver("candidates", {
    slug,
    count: candidates.length,
    candidates: candidates.map((candidate) => ({
      chainName: candidate.chainName,
      supportedMintChain: candidate.supportedMintChain,
      address: `${candidate.address.slice(0, 6)}...${candidate.address.slice(-4)}`,
      source: candidate.source,
      confidence: candidate.confidence
    }))
  });

  if (candidates.length === 0) {
    return {
      status: "no_contracts",
      slug,
      message: "OpenSea returned the collection, but no contract address was found in the response."
    };
  }

  const supported = candidates.filter((candidate) => candidate.supportedMintChain);
  const mainnet = supported.filter((candidate) => candidate.supportedMintChain === "mainnet");

  if (mainnet.length === 1) {
    return {
      status: "resolved",
      slug,
      candidate: mainnet[0]!,
      candidates
    };
  }

  if (supported.length === 1) {
    return {
      status: "resolved",
      slug,
      candidate: supported[0]!,
      candidates
    };
  }

  if (candidates.length === 1) {
    return {
      status: candidates[0]!.supportedMintChain ? "resolved" : "multiple_candidates",
      slug,
      candidate: candidates[0]!,
      candidates
    } as OpenSeaContractResolverResult;
  }

  return {
    status: "multiple_candidates",
    slug,
    candidates
  };
}

export function formatOpenSeaResolverUserMessage(result: OpenSeaContractResolverResult) {
  if (result.status === "missing_api_key" || result.status === "auth_error") {
    return `OpenSea lookup is not configured correctly on this bot.

This is not something re-pasting the link will fix.

Paste the contract address directly for now.`;
  }

  if (result.status === "not_found") {
    return `Couldn't find a collection at that OpenSea link.

Check the slug, or paste the contract address directly.`;
  }

  if (result.status === "slug_suggestions") {
    return [
      "That collection slug may have moved or changed.",
      "",
      "Possible matches:",
      ...result.suggestions.map((suggestion) =>
        `• ${suggestion.name ? `${suggestion.name} — ` : ""}${suggestion.slug}`
      ),
      "",
      "Paste the correct OpenSea collection link/slug or paste the contract address directly."
    ].join("\n");
  }

  if (result.status === "rate_limited") {
    return `OpenSea lookup is rate-limited right now.

Try again in a minute, or paste the contract address directly.`;
  }

  if (result.status === "network_error") {
    return `Couldn't reach OpenSea to resolve that link right now.

Paste the contract address directly.`;
  }

  if (result.status === "no_contracts") {
    return `OpenSea found the collection, but did not return a contract address.

Paste the contract address directly to continue.`;
  }

  if (result.status === "multiple_candidates") {
    return [
      "This collection returned multiple contract candidates.",
      "",
      ...result.candidates.map((candidate, index) =>
        `${index + 1}. ${formatOpenSeaResolverCandidate(candidate)}`
      ),
      "",
      "For safety, paste the exact contract address you want to use."
    ].join("\n");
  }

  if (result.status === "invalid_input") {
    return `That does not look like an OpenSea collection link or slug.

Paste an OpenSea collection link or paste the contract address directly.`;
  }

  return "OpenSea contract resolved.";
}
