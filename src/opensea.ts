import { ethers } from "ethers";

type OpenSeaStatsResponse = {
  total?: {
    volume?: number;
    sales?: number;
    average_price?: number;
    num_owners?: number;
    market_cap?: number;
    floor_price?: number;
    floor_price_symbol?: string;
  };
};

export function extractOpenSeaSlug(input: string): string {
  const cleanInput = input.trim();

  if (!cleanInput) {
    throw new Error("OpenSea collection slug or URL is required.");
  }

  try {
    const url = new URL(cleanInput);

    const parts = url.pathname
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean);

    const collectionIndex = parts.indexOf("collection");

    if (collectionIndex === -1 || !parts[collectionIndex + 1]) {
      throw new Error("Could not find collection slug in OpenSea URL.");
    }

    return parts[collectionIndex + 1];
  } catch {
    return cleanInput
      .replace(/^\/+/, "")
      .replace(/\/+$/, "")
      .trim();
  }
}

function getOpenSeaApiKey() {
  const apiKey = process.env.OPENSEA_API_KEY;

  if (!apiKey) {
    throw new Error("Missing OPENSEA_API_KEY in .env");
  }

  return apiKey;
}

export async function getOpenSeaCollectionStats(slug: string) {
  const apiKey = getOpenSeaApiKey();

  const response = await fetch(
    `https://api.opensea.io/api/v2/collections/${slug}/stats`,
    {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-api-key": apiKey
      }
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenSea API error ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = (await response.json()) as OpenSeaStatsResponse;

  return {
    slug,
    floorPrice: data.total?.floor_price ?? null,
    floorSymbol: data.total?.floor_price_symbol ?? "ETH",
    volume: data.total?.volume ?? null,
    sales: data.total?.sales ?? null,
    owners: data.total?.num_owners ?? null,
    averagePrice: data.total?.average_price ?? null,
    marketCap: data.total?.market_cap ?? null
  };
}

function formatOpenSeaPrice(order: any) {
  const price = order?.price;

  if (!price) {
    return {
      amount: "Unknown",
      symbol: "Unknown",
      rawValue: null
    };
  }

  const rawValue = price.value;
  const decimals = Number(price.decimals ?? 18);
  const symbol = price.currency ?? price.symbol ?? "ETH";

  if (!rawValue) {
    return {
      amount: "Unknown",
      symbol,
      rawValue: null
    };
  }

  try {
    return {
      amount: ethers.formatUnits(rawValue, decimals),
      symbol,
      rawValue
    };
  } catch {
    return {
      amount: String(rawValue),
      symbol,
      rawValue
    };
  }
}

export async function getOpenSeaBestOffer(slug: string, tokenId: string) {
  const apiKey = getOpenSeaApiKey();

  const response = await fetch(
    `https://api.opensea.io/api/v2/offers/collection/${slug}/nfts/${tokenId}/best`,
    {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-api-key": apiKey
      }
    }
  );

  if (response.status === 404) {
    return {
      slug,
      tokenId,
      hasOffer: false,
      reason: "No best offer found for this NFT."
    };
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenSea API error ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  const offer = data.offer ?? data;
  const price = formatOpenSeaPrice(offer);

  return {
    slug,
    tokenId,
    hasOffer: true,
    orderHash: offer.order_hash ?? offer.orderHash ?? "Unknown",
    protocolAddress: offer.protocol_address ?? offer.protocolAddress ?? "Unknown",
    amount: price.amount,
    symbol: price.symbol,
    rawValue: price.rawValue,
    raw: data
  };
}

export async function getOpenSeaBestListing(slug: string, tokenId: string) {
  const apiKey = getOpenSeaApiKey();

  const response = await fetch(
    `https://api.opensea.io/api/v2/listings/collection/${slug}/nfts/${tokenId}/best`,
    {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-api-key": apiKey
      }
    }
  );

  if (response.status === 404) {
    return {
      slug,
      tokenId,
      hasListing: false,
      reason: "No active listing found for this NFT."
    };
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenSea API error ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  const listing = data.listing ?? data;
  const price = formatOpenSeaPrice(listing);

  return {
    slug,
    tokenId,
    hasListing: true,
    orderHash: listing.order_hash ?? listing.orderHash ?? "Unknown",
    protocolAddress: listing.protocol_address ?? listing.protocolAddress ?? "Unknown",
    amount: price.amount,
    symbol: price.symbol,
    rawValue: price.rawValue,
    raw: data
  };
}


export async function getOpenSeaNft(params: {
  chain: string;
  contractAddress: string;
  tokenId: string;
}) {
  const apiKey = getOpenSeaApiKey();

  const response = await fetch(
    `https://api.opensea.io/api/v2/chain/${params.chain}/contract/${params.contractAddress}/nfts/${params.tokenId}`,
    {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-api-key": apiKey
      }
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenSea API error ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  const nft = data.nft ?? data;

  const collectionSlug =
    typeof nft.collection === "string"
      ? nft.collection
      : nft.collection?.slug ?? nft.collection_slug ?? null;

  return {
    chain: params.chain,
    contractAddress: params.contractAddress,
    tokenId: params.tokenId,
    identifier: nft.identifier ?? params.tokenId,
    name: nft.name ?? "Unnamed NFT",
    collectionSlug,
    tokenStandard: nft.token_standard ?? "Unknown",
    imageUrl: nft.image_url ?? nft.display_image_url ?? null,
    openseaUrl: nft.opensea_url ?? null,
    raw: data
  };
}


export async function getOpenSeaNftsByAccount(params: {
  chain: string;
  address: string;
  limit?: number;
  next?: string;
}) {
  const apiKey = getOpenSeaApiKey();

  const limit = Math.min(Math.max(params.limit || 10, 1), 50);

  const url = new URL(
    `https://api.opensea.io/api/v2/chain/${params.chain}/account/${params.address}/nfts`
  );

  url.searchParams.set("limit", String(limit));

  if (params.next) {
    url.searchParams.set("next", params.next);
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      accept: "application/json",
      "x-api-key": apiKey
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenSea API error ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  const nfts = Array.isArray(data.nfts) ? data.nfts : [];

  return {
    chain: params.chain,
    address: params.address,
    next: data.next ?? null,
    nfts: nfts.map((nft: any) => {
      const contractValue =
        nft.contract?.address ||
        nft.contract ||
        nft.contract_address ||
        nft.asset_contract?.address ||
        "Unknown";

      const collectionSlug =
        typeof nft.collection === "string"
          ? nft.collection
          : nft.collection?.slug ?? nft.collection_slug ?? "unknown-collection";

      return {
        identifier: nft.identifier ?? nft.token_id ?? nft.tokenId ?? "Unknown",
        name: nft.name ?? `NFT #${nft.identifier ?? nft.token_id ?? "Unknown"}`,
        collectionSlug,
        contractAddress: contractValue,
        tokenStandard: nft.token_standard ?? "Unknown",
        imageUrl: nft.image_url ?? nft.display_image_url ?? null,
        openseaUrl: nft.opensea_url ?? null
      };
    })
  };
}
