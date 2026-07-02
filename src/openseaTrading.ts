import "dotenv/config";
import { ethers } from "ethers";
import { OpenSeaSDK, Chain } from "@opensea/sdk";
import {
  getWalletAddressByLabel,
  getWalletAddressByLabelForOwner,
  getWalletSignerByLabel,
  getWalletSignerByLabelForOwner
} from "./vault.js";
import { getOpenSeaBestOffer } from "./opensea.js";

const ERC721_READ_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)"
];

type Erc721ReadContract = ethers.Contract & {
  ownerOf: (tokenId: string) => Promise<string>;
};

export function getMainnetProvider() {
  const rpcUrl = process.env.ETH_MAINNET_RPC_URL;

  if (!rpcUrl) {
    throw new Error("Missing ETH_MAINNET_RPC_URL in .env");
  }

  return new ethers.JsonRpcProvider(rpcUrl);
}

export async function checkErc721Ownership(params: {
  walletLabel: string;
  ownerTelegramId?: string;
  contractAddress: string;
  tokenId: string;
}) {
  const provider = getMainnetProvider();
  const walletAddress = params.ownerTelegramId
    ? await getWalletAddressByLabelForOwner(
        params.walletLabel,
        params.ownerTelegramId
      )
    : await getWalletAddressByLabel(params.walletLabel);

  const contract = new ethers.Contract(
    params.contractAddress,
    ERC721_READ_ABI,
    provider
  ) as unknown as Erc721ReadContract;

  const owner: string = await contract.ownerOf(params.tokenId);
  const ownsToken = owner.toLowerCase() === walletAddress.toLowerCase();

  return {
    walletLabel: params.walletLabel,
    walletAddress,
    contractAddress: params.contractAddress,
    tokenId: params.tokenId,
    owner,
    ownsToken
  };
}

export async function createOpenSeaListing(params: {
  walletLabel: string;
  ownerTelegramId?: string;
  contractAddress: string;
  tokenId: string;
  priceEth: number;
}) {
  if (process.env.ALLOW_MAINNET_TRADING !== "true") {
    throw new Error(
      "Mainnet trading is locked. Set ALLOW_MAINNET_TRADING=true in .env only when you are ready."
    );
  }

  const apiKey = process.env.OPENSEA_API_KEY;

  if (!apiKey) {
    throw new Error("Missing OPENSEA_API_KEY in .env");
  }

  const provider = getMainnetProvider();
  const wallet = params.ownerTelegramId
    ? await getWalletSignerByLabelForOwner(
        params.walletLabel,
        params.ownerTelegramId,
        provider,
        "opensea-create-listing"
      )
    : await getWalletSignerByLabel(
        params.walletLabel,
        provider,
        "opensea-create-listing"
      );

  const ownership = await checkErc721Ownership({
    walletLabel: params.walletLabel,
    ...(params.ownerTelegramId ? { ownerTelegramId: params.ownerTelegramId } : {}),
    contractAddress: params.contractAddress,
    tokenId: params.tokenId
  });

  if (!ownership.ownsToken) {
    throw new Error(
      `Wallet does not own this token. Current owner is ${ownership.owner}`
    );
  }

  const sdk = new OpenSeaSDK(wallet as any, {
    chain: Chain.Mainnet,
    apiKey
  });

  const listing = await sdk.createListing({
    asset: {
      tokenAddress: params.contractAddress,
      tokenId: params.tokenId
    },
    accountAddress: wallet.address,
    amount: params.priceEth
  } as any);

  return {
    wallet: wallet.address,
    contractAddress: params.contractAddress,
    tokenId: params.tokenId,
    priceEth: params.priceEth,
    listing
  };
}


export async function acceptOpenSeaBestOffer(params: {
  walletLabel: string;
  ownerTelegramId?: string;
  collectionSlug: string;
  contractAddress: string;
  tokenId: string;
}) {
  if (process.env.ALLOW_MAINNET_TRADING !== "true") {
    throw new Error(
      "Mainnet trading is locked. Set ALLOW_MAINNET_TRADING=true in .env only when you are ready."
    );
  }

  const apiKey = process.env.OPENSEA_API_KEY;

  if (!apiKey) {
    throw new Error("Missing OPENSEA_API_KEY in .env");
  }

  const provider = getMainnetProvider();
  const wallet = params.ownerTelegramId
    ? await getWalletSignerByLabelForOwner(
        params.walletLabel,
        params.ownerTelegramId,
        provider,
        "opensea-accept-best-offer"
      )
    : await getWalletSignerByLabel(
        params.walletLabel,
        provider,
        "opensea-accept-best-offer"
      );

  const ownership = await checkErc721Ownership({
    walletLabel: params.walletLabel,
    ...(params.ownerTelegramId ? { ownerTelegramId: params.ownerTelegramId } : {}),
    contractAddress: params.contractAddress,
    tokenId: params.tokenId
  });

  if (!ownership.ownsToken) {
    throw new Error(
      `Wallet does not own this token. Current owner is ${ownership.owner}`
    );
  }

  const bestOffer: any = await getOpenSeaBestOffer(
    params.collectionSlug,
    params.tokenId
  );

  if (!bestOffer.hasOffer) {
    throw new Error("No top offer found for this NFT.");
  }

  const offerOrder = bestOffer.raw?.offer ?? bestOffer.raw;

  if (!offerOrder) {
    throw new Error("Could not read offer order data from OpenSea response.");
  }

  const sdk = new OpenSeaSDK(wallet as any, {
    chain: Chain.Mainnet,
    apiKey
  });

  const txHash = await sdk.fulfillOrder({
    accountAddress: wallet.address,
    order: offerOrder,
    assetContractAddress: params.contractAddress,
    tokenId: params.tokenId,
    unitsToFill: 1
  } as any);

  return {
    wallet: wallet.address,
    collectionSlug: params.collectionSlug,
    contractAddress: params.contractAddress,
    tokenId: params.tokenId,
    offerAmount: bestOffer.amount,
    offerSymbol: bestOffer.symbol,
    orderHash: bestOffer.orderHash,
    txHash
  };
}
