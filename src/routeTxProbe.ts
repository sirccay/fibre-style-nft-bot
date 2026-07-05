import "dotenv/config";
import { ethers } from "ethers";
import { getMintProvider } from "./mintEngine.js";

type Chain = "mainnet" | "sepolia";

const ZERO = "0x0000000000000000000000000000000000000000";
const SEADROP_MINT_PUBLIC_SELECTOR = "0x4b61cd6f";

function getChainId(chain: Chain) {
  return chain === "sepolia" ? "11155111" : "1";
}

function getEtherscanBase() {
  return "https://api.etherscan.io/v2/api";
}

async function fetchJson(url: string) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const text = await res.text();

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response: ${text.slice(0, 200)}`);
  }
}

async function fetchRecentMintTransferTxHashes(chain: Chain, tokenContract: string) {
  const key = process.env.ETHERSCAN_API_KEY?.trim();

  if (!key) {
    throw new Error("Missing ETHERSCAN_API_KEY");
  }

  const url =
    `${getEtherscanBase()}?chainid=${getChainId(chain)}` +
    `&module=account&action=tokennfttx&contractaddress=${tokenContract}` +
    `&page=1&offset=50&sort=desc&apikey=${encodeURIComponent(key)}`;

  const json = await fetchJson(url);

  if (!Array.isArray(json.result)) {
    throw new Error(`NFT transfer fetch failed: ${json.result || json.message}`);
  }

  const hashes: string[] = [];

  for (const row of json.result) {
    const from = String(row.from || "").toLowerCase();
    const hash = String(row.hash || row.transactionHash || "");

    if (from === ZERO && hash.startsWith("0x") && !hashes.includes(hash)) {
      hashes.push(hash);
    }
  }

  return hashes.slice(0, 12);
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
      signature: "mintPublic(address,address,address,uint256)",
      nftContract: ethers.getAddress(decoded[0]),
      feeRecipient: ethers.getAddress(decoded[1]),
      minterIfNotPayer: ethers.getAddress(decoded[2]),
      quantity: decoded[3].toString()
    };
  } catch {
    return null;
  }
}

async function main() {
  const chain = (process.argv[2] || "mainnet") as Chain;
  const tokenContractRaw = process.argv[3];

  if (!tokenContractRaw || !ethers.isAddress(tokenContractRaw)) {
    throw new Error("Usage: npx tsx src/routeTxProbe.ts mainnet 0xTOKEN_CONTRACT");
  }

  const tokenContract = ethers.getAddress(tokenContractRaw);
  const provider = getMintProvider(chain);

  console.log("Route Tx Probe");
  console.log("");
  console.log(`Chain: ${chain}`);
  console.log(`Token Contract: ${tokenContract}`);
  console.log("");

  const hashes = await fetchRecentMintTransferTxHashes(chain, tokenContract);

  if (hashes.length === 0) {
    console.log("No recent mint transfer tx hashes found from zero address.");
    return;
  }

  console.log(`Recent mint tx hashes found: ${hashes.length}`);
  console.log("");

  const seenTo = new Map<string, number>();
  const seaDropRoutes: Array<{
    to: string;
    nftContract: string;
    feeRecipient: string;
    minterIfNotPayer: string;
    quantity: string;
    valueEth: string;
    txHash: string;
  }> = [];

  for (const hash of hashes) {
    const tx = await provider.getTransaction(hash);

    if (!tx) {
      console.log(`Tx not found: ${hash}`);
      continue;
    }

    const to = tx.to ? ethers.getAddress(tx.to) : "contract_creation";
    const selector = getFunctionSelector(tx.data);
    const valueEth = ethers.formatEther(tx.value);

    seenTo.set(to, (seenTo.get(to) || 0) + 1);

    console.log("--------------------------------------------------");
    console.log(`Tx: ${hash}`);
    console.log(`To: ${to}`);
    console.log(`Selector: ${selector}`);
    console.log(`Value: ${valueEth} ETH`);

    const seaDrop = decodeSeaDropMintPublic(tx.data);

    if (seaDrop) {
      console.log(`Decoded Function: ${seaDrop.signature}`);
      console.log(`NFT Contract: ${seaDrop.nftContract}`);
      console.log(`Fee Recipient: ${seaDrop.feeRecipient}`);
      console.log(`Minter If Not Payer: ${seaDrop.minterIfNotPayer}`);
      console.log(`Quantity: ${seaDrop.quantity}`);

      seaDropRoutes.push({
        to,
        nftContract: seaDrop.nftContract,
        feeRecipient: seaDrop.feeRecipient,
        minterIfNotPayer: seaDrop.minterIfNotPayer,
        quantity: seaDrop.quantity,
        valueEth,
        txHash: hash
      });
    } else {
      console.log("Decoded Function: unavailable");
    }
  }

  console.log("");
  console.log("Mint Contract Candidates by tx.to frequency:");
  for (const [to, count] of [...seenTo.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`- ${to}: ${count} tx(s)`);
  }

  console.log("");
  console.log("SeaDrop Route Candidates:");
  if (seaDropRoutes.length === 0) {
    console.log("- None");
  } else {
    for (const route of seaDropRoutes) {
      console.log("");
      console.log(`Mint Contract: ${route.to}`);
      console.log("Function: mintPublic(address,address,address,uint256)");
      console.log(`NFT Contract Arg: ${route.nftContract}`);
      console.log(`Fee Recipient Arg: ${route.feeRecipient}`);
      console.log(`Minter If Not Payer Arg: ${route.minterIfNotPayer}`);
      console.log(`Quantity Arg: ${route.quantity}`);
      console.log(`Value Sent: ${route.valueEth} ETH`);
      console.log(`Example Tx: ${route.txHash}`);
    }
  }

  console.log("");
  console.log("Bot Patch Hint:");
  console.log("If SeaDrop route exists, bot should call:");
  console.log("to = Mint Contract");
  console.log("function = mintPublic(address,address,address,uint256)");
  console.log("args = [NFT Contract, Fee Recipient, walletAddress, quantity]");
  console.log("value = priceEth * quantity");
}

main().catch((err) => {
  console.error("Probe failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
