import "dotenv/config";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { Telegraf, Markup } from "telegraf";
import { ethers } from "ethers";
import { listWallets, getWalletByLabel } from "./vault";
import { getTelegramUserId, requireAdmin } from "./auth";
import { extractOpenSeaSlug, getOpenSeaCollectionStats, getOpenSeaBestOffer, getOpenSeaBestListing, getOpenSeaNft, getOpenSeaNftsByAccount } from "./opensea";
import { checkErc721Ownership, createOpenSeaListing, getMainnetProvider, acceptOpenSeaBestOffer } from "./openseaTrading";

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN in .env");
}

const bot = new Telegraf(token);

function getProvider() {
  const rpcUrl = process.env.RPC_URL_SEPOLIA;

  if (rpcUrl) {
    return new ethers.JsonRpcProvider(rpcUrl);
  }

  return ethers.getDefaultProvider("sepolia");
}

const provider = getProvider();

function loadTestNftContract() {
  const filePath = path.join(process.cwd(), "data", "testNft.json");

  if (!fs.existsSync(filePath)) {
    throw new Error("Missing data/testNft.json. Deploy the test NFT contract first.");
  }

  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

type MintRecord = {
  walletLabel: string;
  walletAddress: string;
  contractAddress: string;
  tokenIds: string[];
  txHash: string;
  quantity: number;
  paidEth: string;
  network: string;
  mintedAt: string;
};

const MINTS_PATH = path.join(process.cwd(), "data", "mints.json");

function loadMints(): MintRecord[] {
  if (!fs.existsSync(MINTS_PATH)) {
    return [];
  }

  const raw = fs.readFileSync(MINTS_PATH, "utf8");

  if (!raw.trim()) {
    return [];
  }

  const parsed = JSON.parse(raw);
  return parsed.mints || [];
}

function saveMint(record: MintRecord) {
  const mints = loadMints();
  mints.push(record);

  const dir = path.dirname(MINTS_PATH);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(
    MINTS_PATH,
    JSON.stringify({ mints }, null, 2),
    "utf8"
  );
}

function getMintedTokenIdsFromReceipt(
  receipt: ethers.TransactionReceipt,
  contractInterface: ethers.Interface,
  walletAddress: string
): string[] {
  const tokenIds: string[] = [];

  for (const log of receipt.logs) {
    try {
      const parsed = contractInterface.parseLog({
        topics: log.topics as string[],
        data: log.data
      });

      if (!parsed) {
        continue;
      }

      if (parsed.name !== "Transfer") {
        continue;
      }

      const from = String(parsed.args[0]).toLowerCase();
      const to = String(parsed.args[1]).toLowerCase();
      const tokenId = parsed.args[2].toString();

      const zeroAddress = "0x0000000000000000000000000000000000000000";

      if (from === zeroAddress && to === walletAddress.toLowerCase()) {
        tokenIds.push(tokenId);
      }
    } catch {
      continue;
    }
  }

  return tokenIds;
}


type PostMintActionSession = {
  id: string;
  walletLabel: string;
  collectionSlug: string;
  contractAddress: string;
  tokenId: string;
  network: "ethereum" | "sepolia";
  createdAt: string;
};

const POST_MINT_ACTIONS_PATH = path.join(
  process.cwd(),
  "data",
  "postMintActions.json"
);

function loadPostMintActions(): PostMintActionSession[] {
  if (!fs.existsSync(POST_MINT_ACTIONS_PATH)) {
    return [];
  }

  const raw = fs.readFileSync(POST_MINT_ACTIONS_PATH, "utf8");

  if (!raw.trim()) {
    return [];
  }

  const parsed = JSON.parse(raw);
  return parsed.actions || [];
}

function savePostMintAction(action: PostMintActionSession) {
  const actions = loadPostMintActions();
  actions.push(action);

  const dir = path.dirname(POST_MINT_ACTIONS_PATH);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(
    POST_MINT_ACTIONS_PATH,
    JSON.stringify({ actions }, null, 2),
    "utf8"
  );
}

function createPostMintActionSession(params: {
  walletLabel: string;
  collectionSlug: string;
  contractAddress: string;
  tokenId: string;
  network?: "ethereum" | "sepolia";
}) {
  const action: PostMintActionSession = {
    id: randomUUID(),
    walletLabel: params.walletLabel,
    collectionSlug: params.collectionSlug,
    contractAddress: params.contractAddress,
    tokenId: params.tokenId,
    network: params.network || "ethereum",
    createdAt: new Date().toISOString()
  };

  savePostMintAction(action);
  return action;
}

function getPostMintActionSession(id: string) {
  const actions = loadPostMintActions();
  return actions.find((action) => action.id === id) || null;
}

async function sendPostMintActionMenu(ctx: any, action: PostMintActionSession) {
  await ctx.reply(
    `🎉 Post-Mint Actions

Wallet: ${action.walletLabel}
Collection: ${action.collectionSlug}
Contract: ${action.contractAddress}
Token ID: ${action.tokenId}
Network: ${action.network}

Choose what you want to do next:`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🖼 View NFT", `pm:view:${action.id}`)],
      [Markup.button.callback("📊 Floor / Best Listing", `pm:floor:${action.id}`)],
      [Markup.button.callback("💰 Top Offer", `pm:offer:${action.id}`)],
      [Markup.button.callback("🚨 Accept Top Offer", `pm:acceptofferpreview:${action.id}`)],
      [Markup.button.callback("🏷 List at Floor Preview", `pm:listfloor:${action.id}`)],
      [Markup.button.callback("✅ Confirm Floor Listing", `pm:floorconfirmpreview:${action.id}`)],
      [Markup.button.callback("✍️ Custom List Preview", `pm:custom:${action.id}`)],
      [Markup.button.callback("🧊 Hold", `pm:hold:${action.id}`)]
    ])
  );
}

bot.command("whoami", async (ctx) => {
  const userId = getTelegramUserId(ctx);

  await ctx.reply(
    `Your Telegram user ID is:

${userId}

Add this to your .env:

ADMIN_TELEGRAM_ID=${userId}`
  );
});

bot.start(async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.reply(
    `🔥 Welcome to the NFT Mint Bot MVP

What can this bot do?
• Store burner wallets in encrypted vault
• Check wallet balances
• Mint test NFTs on Sepolia
• Detect minted token IDs
• Track mint transactions

Choose an option below:`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🧾 Subscribe", "subscribe")],
      [Markup.button.callback("🎟 I have a code", "code")],
      [Markup.button.callback("⚙️ Wallet Status", "wallet_status")],
      [Markup.button.callback("🚀 Test Mint", "test_mint")],
      [Markup.button.callback("🖼 My NFTs", "my_nfts")],
      [Markup.button.callback("📦 OpenSea Portfolio", "os_portfolio_help")],
      [Markup.button.callback("✅ Approval", "approval_help")],
      [Markup.button.callback("🌊 OpenSea Floor", "opensea_help")]
    ])
  );
});

bot.action("subscribe", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();
  await ctx.reply(
    `🔒 Subscribe to unlock Mint Bot

MVP tiers:
• Daily — test only
• 2 Weeks — test only
• Monthly — test only

Payment system comes later. For now, we’ll use manual access codes.`
  );
});

bot.action("code", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();
  await ctx.reply("Send your access code like this:\n\n/code YOUR-CODE-HERE");
});

bot.command("code", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const code = ctx.message.text.split(" ")[1];

  if (!code) {
    await ctx.reply("Please send a code like this:\n\n/code YOUR-CODE-HERE");
    return;
  }

  if (code === "TEST123") {
    await ctx.reply("✅ Access unlocked. You can now use the bot MVP.");
  } else {
    await ctx.reply("❌ Invalid code.");
  }
});

bot.action("wallet_status", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  try {
    const wallets = listWallets();

    if (wallets.length === 0) {
      await ctx.reply(
        `❌ No wallets found.

Add one first from Terminal:

npm run wallet:add`
      );
      return;
    }

    let message = `⚙️ Wallet Status\n\nNetwork: Sepolia Testnet\n\n`;

    for (const savedWallet of wallets) {
      const wallet = getWalletByLabel(savedWallet.label, provider);
      const balanceWei = await provider.getBalance(wallet.address);
      const balanceEth = ethers.formatEther(balanceWei);

      message += `👛 ${savedWallet.label}\n`;
      message += `Address: ${wallet.address}\n`;
      message += `Balance: ${balanceEth} ETH\n\n`;
    }

    message += `✅ Wallet vault loaded.`;

    await ctx.reply(message);
  } catch (error) {
    console.error(error);
    await ctx.reply("❌ Could not load wallet status. Check Terminal for the error.");
  }
});

bot.command("wallets", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  try {
    const wallets = listWallets();

    if (wallets.length === 0) {
      await ctx.reply("No wallets found. Add one with:\n\nnpm run wallet:add");
      return;
    }

    const message = wallets
      .map((wallet) => `👛 ${wallet.label}\n${wallet.address}`)
      .join("\n\n");

    await ctx.reply(`Saved wallets:\n\n${message}`);
  } catch (error) {
    console.error(error);
    await ctx.reply("❌ Could not list wallets.");
  }
});

bot.action("test_mint", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();
  await ctx.reply(
    `🚀 Test Mint

Use this command:

/minttest wallet1 1

Format:
/minttest walletLabel quantity

Example:
/minttest wallet1 1`
  );
});

bot.command("minttest", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = ctx.message.text.split(" ");

  if (parts.length < 3) {
    await ctx.reply(
      `Invalid format.

Use:
/minttest wallet1 1`
    );
    return;
  }

  const [, walletLabel, quantityRaw] = parts;
  const quantity = Number(quantityRaw);

  if (!Number.isInteger(quantity) || quantity <= 0) {
    await ctx.reply("❌ Quantity must be a whole number greater than 0.");
    return;
  }

  if (quantity > 5) {
    await ctx.reply("❌ This test contract allows max 5 NFTs per transaction.");
    return;
  }

  try {
    const testNft = loadTestNftContract();
    const wallet = getWalletByLabel(walletLabel, provider);

    const contract = new ethers.Contract(
      testNft.contractAddress,
      testNft.abi,
      wallet
    );

    const priceWei: bigint = await contract.PRICE();
    const totalCostWei = priceWei * BigInt(quantity);
    const totalCostEth = ethers.formatEther(totalCostWei);

    await ctx.reply(
      `🔥 Prepping mint...

Network: Sepolia
Wallet: ${walletLabel}
Address: ${wallet.address}
Contract: ${testNft.contractAddress}
Qty: ${quantity}
Mint cost: ${totalCostEth} ETH

Estimating gas...`
    );

    const gasEstimate = await contract.publicMint.estimateGas(quantity, {
      value: totalCostWei
    });

    await ctx.reply(
      `⛽ Gas estimated: ${gasEstimate.toString()}

⚡ Sending mint transaction now...`
    );

    const tx = await contract.publicMint(quantity, {
      value: totalCostWei
    });

    await ctx.reply(
      `⏳ Mint transaction sent.

Tx:
${tx.hash}

Waiting for confirmation...`
    );

    const receipt = await tx.wait();

    if (receipt?.status === 1) {
      const contractInterface = new ethers.Interface(testNft.abi);

      const tokenIds = getMintedTokenIdsFromReceipt(
        receipt,
        contractInterface,
        wallet.address
      );

      saveMint({
        walletLabel,
        walletAddress: wallet.address,
        contractAddress: testNft.contractAddress,
        tokenIds,
        txHash: tx.hash,
        quantity,
        paidEth: totalCostEth,
        network: "sepolia",
        mintedAt: new Date().toISOString()
      });

      const tokenText =
        tokenIds.length > 0
          ? tokenIds.map((id) => `#${id}`).join(", ")
          : "Could not detect token ID";

      await ctx.reply(
        `✅ Minted successfully!

Wallet: ${walletLabel}
Qty: ${quantity}
Token ID(s): ${tokenText}
Paid: ${totalCostEth} ETH
Tx:
${tx.hash}

Saved to local mint history.

Next command:
/nfts ${walletLabel}`
      );
    } else {
      await ctx.reply(
        `❌ Transaction failed.

Tx:
${tx.hash}`
      );
    }
  } catch (error: any) {
    console.error(error);

    const errorMessage =
      error?.shortMessage ||
      error?.reason ||
      error?.message ||
      "Unknown mint error";

    await ctx.reply(
      `❌ Mint failed.

Reason:
${errorMessage}`
    );
  }
});

bot.action("my_nfts", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();
  await ctx.reply(
    `🖼 My NFTs

Use this command:

/nfts wallet1

Example:
/nfts wallet1`
  );
});

bot.command("nfts", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = ctx.message.text.split(" ");
  const walletLabel = parts[1]?.trim().toLowerCase();

  if (!walletLabel) {
    await ctx.reply(
      `Invalid format.

Use:
/nfts wallet1`
    );
    return;
  }

  const mints = loadMints().filter(
    (mint) => mint.walletLabel.toLowerCase() === walletLabel
  );

  if (mints.length === 0) {
    await ctx.reply(`No minted NFTs found for "${walletLabel}" yet.`);
    return;
  }

  let message = `🖼 NFTs for ${walletLabel}\n\n`;

  for (const mint of mints) {
    const tokenText =
      mint.tokenIds.length > 0
        ? mint.tokenIds.map((id) => `#${id}`).join(", ")
        : "Unknown token ID";

    message += `Contract: ${mint.contractAddress}\n`;
    message += `Token ID(s): ${tokenText}\n`;
    message += `Qty: ${mint.quantity}\n`;
    message += `Paid: ${mint.paidEth} ETH\n`;
    message += `Tx: ${mint.txHash}\n\n`;
  }

  await ctx.reply(message);
});


bot.action("approval_help", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();
  await ctx.reply(
    `✅ Approval Module

Approval lets another contract/operator move NFTs from your wallet.

For testnet, use:

/approvalstatus wallet1 0xOperatorAddress

/approveall wallet1 0xOperatorAddress

/revokeall wallet1 0xOperatorAddress

Example test operator:
/approveall wallet1 0x0000000000000000000000000000000000000001

Important:
Only approve trusted marketplace/operator contracts on mainnet.`
  );
});

bot.command("approvalstatus", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = ctx.message.text.split(" ");

  if (parts.length < 3) {
    await ctx.reply(
      `Invalid format.

Use:
/approvalstatus wallet1 0xOperatorAddress`
    );
    return;
  }

  const [, walletLabel, operator] = parts;

  if (!ethers.isAddress(operator)) {
    await ctx.reply("❌ Invalid operator address.");
    return;
  }

  try {
    const testNft = loadTestNftContract();
    const wallet = getWalletByLabel(walletLabel, provider);

    const contract = new ethers.Contract(
      testNft.contractAddress,
      testNft.abi,
      wallet
    );

    const approved: boolean = await contract.isApprovedForAll(
      wallet.address,
      operator
    );

    await ctx.reply(
      `✅ Approval Status

Network: Sepolia
Wallet: ${walletLabel}
Wallet Address: ${wallet.address}
NFT Contract: ${testNft.contractAddress}
Operator: ${operator}

Approved: ${approved ? "YES ✅" : "NO ❌"}`
    );
  } catch (error: any) {
    console.error(error);

    await ctx.reply(
      `❌ Could not check approval.

Reason:
${error?.shortMessage || error?.message || "Unknown error"}`
    );
  }
});

bot.command("approveall", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = ctx.message.text.split(" ");

  if (parts.length < 3) {
    await ctx.reply(
      `Invalid format.

Use:
/approveall wallet1 0xOperatorAddress`
    );
    return;
  }

  const [, walletLabel, operator] = parts;

  if (!ethers.isAddress(operator)) {
    await ctx.reply("❌ Invalid operator address.");
    return;
  }

  if (operator.toLowerCase() === ethers.ZeroAddress.toLowerCase()) {
    await ctx.reply("❌ Operator cannot be the zero address.");
    return;
  }

  try {
    const testNft = loadTestNftContract();
    const wallet = getWalletByLabel(walletLabel, provider);

    const contract = new ethers.Contract(
      testNft.contractAddress,
      testNft.abi,
      wallet
    );

    const alreadyApproved: boolean = await contract.isApprovedForAll(
      wallet.address,
      operator
    );

    if (alreadyApproved) {
      await ctx.reply(
        `✅ Already approved.

Wallet: ${walletLabel}
Operator: ${operator}`
      );
      return;
    }

    await ctx.reply(
      `✅ Prepping approval...

Network: Sepolia
Wallet: ${walletLabel}
Wallet Address: ${wallet.address}
NFT Contract: ${testNft.contractAddress}
Operator: ${operator}

Estimating gas...`
    );

    const gasEstimate = await contract.setApprovalForAll.estimateGas(
      operator,
      true
    );

    await ctx.reply(
      `⛽ Gas estimated: ${gasEstimate.toString()}

⚡ Sending approval transaction...`
    );

    const tx = await contract.setApprovalForAll(operator, true);

    await ctx.reply(
      `⏳ Approval transaction sent.

Tx:
${tx.hash}

Waiting for confirmation...`
    );

    const receipt = await tx.wait();

    if (receipt?.status === 1) {
      await ctx.reply(
        `✅ Approval successful!

Wallet: ${walletLabel}
NFT Contract: ${testNft.contractAddress}
Operator: ${operator}

Tx:
${tx.hash}

Next command:
/approvalstatus ${walletLabel} ${operator}`
      );
    } else {
      await ctx.reply(
        `❌ Approval transaction failed.

Tx:
${tx.hash}`
      );
    }
  } catch (error: any) {
    console.error(error);

    await ctx.reply(
      `❌ Approval failed.

Reason:
${error?.shortMessage || error?.reason || error?.message || "Unknown error"}`
    );
  }
});

bot.command("revokeall", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = ctx.message.text.split(" ");

  if (parts.length < 3) {
    await ctx.reply(
      `Invalid format.

Use:
/revokeall wallet1 0xOperatorAddress`
    );
    return;
  }

  const [, walletLabel, operator] = parts;

  if (!ethers.isAddress(operator)) {
    await ctx.reply("❌ Invalid operator address.");
    return;
  }

  try {
    const testNft = loadTestNftContract();
    const wallet = getWalletByLabel(walletLabel, provider);

    const contract = new ethers.Contract(
      testNft.contractAddress,
      testNft.abi,
      wallet
    );

    await ctx.reply(
      `🧹 Prepping approval revoke...

Network: Sepolia
Wallet: ${walletLabel}
NFT Contract: ${testNft.contractAddress}
Operator: ${operator}

Sending revoke transaction...`
    );

    const tx = await contract.setApprovalForAll(operator, false);

    await ctx.reply(
      `⏳ Revoke transaction sent.

Tx:
${tx.hash}

Waiting for confirmation...`
    );

    const receipt = await tx.wait();

    if (receipt?.status === 1) {
      await ctx.reply(
        `✅ Approval revoked!

Wallet: ${walletLabel}
Operator: ${operator}

Tx:
${tx.hash}`
      );
    } else {
      await ctx.reply(
        `❌ Revoke transaction failed.

Tx:
${tx.hash}`
      );
    }
  } catch (error: any) {
    console.error(error);

    await ctx.reply(
      `❌ Revoke failed.

Reason:
${error?.shortMessage || error?.reason || error?.message || "Unknown error"}`
    );
  }
});



bot.action("opensea_help", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();
  await ctx.reply(
    `🌊 OpenSea Module

Check collection floor/stats:

/osfloor collection-slug

Or paste an OpenSea collection URL:

/osfloor https://opensea.io/collection/example/overview

Example:
/osfloor doodles-official`
  );
});

bot.command("osfloor", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const input = ctx.message.text.replace("/osfloor", "").trim();

  if (!input) {
    await ctx.reply(
      `Invalid format.

Use:
/osfloor collection-slug

Or:
/osfloor https://opensea.io/collection/example/overview`
    );
    return;
  }

  try {
    const slug = extractOpenSeaSlug(input);

    await ctx.reply(
      `🌊 Checking OpenSea stats...

Collection slug: ${slug}`
    );

    const stats = await getOpenSeaCollectionStats(slug);

    const floorText =
      stats.floorPrice === null
        ? "Not available"
        : `${stats.floorPrice} ${stats.floorSymbol || "ETH"}`;

    const volumeText =
      stats.volume === null ? "Not available" : String(stats.volume);

    const salesText =
      stats.sales === null ? "Not available" : String(stats.sales);

    const ownersText =
      stats.owners === null ? "Not available" : String(stats.owners);

    const averageText =
      stats.averagePrice === null ? "Not available" : String(stats.averagePrice);

    await ctx.reply(
      `🌊 OpenSea Collection Stats

Slug: ${stats.slug}
Floor: ${floorText}
Volume: ${volumeText}
Sales: ${salesText}
Owners: ${ownersText}
Average Price: ${averageText}

Next later:
• Detect top offer
• List NFT at floor
• Custom listing price
• Accept top offer`
    );
  } catch (error: any) {
    console.error(error);

    await ctx.reply(
      `❌ Could not fetch OpenSea floor.

Reason:
${error?.message || "Unknown OpenSea error"}`
    );
  }
});



bot.command("topoffer", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const raw = ctx.message.text.replace("/topoffer", "").trim();
  const parts = raw.split(" ").filter(Boolean);

  if (parts.length < 2) {
    await ctx.reply(
      `Invalid format.

Use:
/topoffer collection-slug tokenId

Or:
/topoffer https://opensea.io/collection/example/overview tokenId

Example:
/topoffer doodles-official 1234`
    );
    return;
  }

  const collectionInput = parts[0];
  const tokenId = parts[1];

  try {
    const slug = extractOpenSeaSlug(collectionInput);

    await ctx.reply(
      `🔎 Checking best OpenSea offer...

Collection: ${slug}
Token ID: ${tokenId}`
    );

    const bestOffer = await getOpenSeaBestOffer(slug, tokenId);

    if (!bestOffer.hasOffer) {
      await ctx.reply(
        `❌ No top offer found.

Collection: ${slug}
Token ID: ${tokenId}

Reason:
${bestOffer.reason}`
      );
      return;
    }

    await ctx.reply(
      `💰 Top Offer Found

Collection: ${bestOffer.slug}
Token ID: ${bestOffer.tokenId}
Offer: ${bestOffer.amount} ${bestOffer.symbol}

Order Hash:
${bestOffer.orderHash}

Protocol:
${bestOffer.protocolAddress}

Next later:
• Ask if you want to accept offer
• Generate fulfillment data
• Send accept-offer transaction`
    );
  } catch (error: any) {
    console.error(error);

    await ctx.reply(
      `❌ Could not fetch top offer.

Reason:
${error?.message || "Unknown OpenSea error"}`
    );
  }
});



bot.command("bestlisting", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const raw = ctx.message.text.replace("/bestlisting", "").trim();
  const parts = raw.split(" ").filter(Boolean);

  if (parts.length < 2) {
    await ctx.reply(
      `Invalid format.

Use:
/bestlisting collection-slug tokenId

Or:
/bestlisting https://opensea.io/collection/example/overview tokenId

Example:
/bestlisting doodles-official 1`
    );
    return;
  }

  const collectionInput = parts[0];
  const tokenId = parts[1];

  try {
    const slug = extractOpenSeaSlug(collectionInput);

    await ctx.reply(
      `🔎 Checking best OpenSea listing...

Collection: ${slug}
Token ID: ${tokenId}`
    );

    const bestListing = await getOpenSeaBestListing(slug, tokenId);

    if (!bestListing.hasListing) {
      await ctx.reply(
        `❌ No active listing found.

Collection: ${slug}
Token ID: ${tokenId}

Reason:
${bestListing.reason}`
      );
      return;
    }

    await ctx.reply(
      `🏷 Best Listing Found

Collection: ${bestListing.slug}
Token ID: ${bestListing.tokenId}
Price: ${bestListing.amount} ${bestListing.symbol}

Order Hash:
${bestListing.orderHash}

Protocol:
${bestListing.protocolAddress}

Next:
• Create listing command
• List at floor
• List at custom price`
    );
  } catch (error: any) {
    console.error(error);

    await ctx.reply(
      `❌ Could not fetch best listing.

Reason:
${error?.message || "Unknown OpenSea error"}`
    );
  }
});



bot.command("oslistpreview", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = ctx.message.text.split(" ");

  if (parts.length < 5) {
    await ctx.reply(
      `Invalid format.

Use:
/oslistpreview wallet1 0xContractAddress tokenId priceETH

Example:
/oslistpreview wallet1 0x1234... 1 0.05`
    );
    return;
  }

  const [, walletLabel, contractAddress, tokenId, priceRaw] = parts;
  const priceEth = Number(priceRaw);

  if (!ethers.isAddress(contractAddress)) {
    await ctx.reply("❌ Invalid contract address.");
    return;
  }

  if (!Number.isFinite(priceEth) || priceEth <= 0) {
    await ctx.reply("❌ Price must be a number greater than 0.");
    return;
  }

  try {
    await ctx.reply(
      `🏷 Preparing OpenSea listing preview...

Wallet: ${walletLabel}
Contract: ${contractAddress}
Token ID: ${tokenId}
Price: ${priceEth} ETH

Checking ownership on Ethereum mainnet...`
    );

    const ownership = await checkErc721Ownership({
      walletLabel,
      contractAddress,
      tokenId
    });

    await ctx.reply(
      `🏷 Listing Preview

Network: Ethereum Mainnet
Wallet: ${walletLabel}
Wallet Address: ${ownership.walletAddress}
Contract: ${contractAddress}
Token ID: ${tokenId}
Owner Onchain: ${ownership.owner}
Wallet Owns Token: ${ownership.ownsToken ? "YES ✅" : "NO ❌"}
Listing Price: ${priceEth} ETH

Live listing is currently locked by:

ALLOW_MAINNET_TRADING=false

When ready, use:
/oslist ${walletLabel} ${contractAddress} ${tokenId} ${priceEth}`
    );
  } catch (error: any) {
    console.error(error);

    await ctx.reply(
      `❌ Listing preview failed.

Reason:
${error?.message || "Unknown error"}`
    );
  }
});

bot.command("oslist", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = ctx.message.text.split(" ");

  if (parts.length < 5) {
    await ctx.reply(
      `Invalid format.

Use:
/oslist wallet1 0xContractAddress tokenId priceETH

Example:
/oslist wallet1 0x1234... 1 0.05`
    );
    return;
  }

  const [, walletLabel, contractAddress, tokenId, priceRaw] = parts;
  const priceEth = Number(priceRaw);

  if (!ethers.isAddress(contractAddress)) {
    await ctx.reply("❌ Invalid contract address.");
    return;
  }

  if (!Number.isFinite(priceEth) || priceEth <= 0) {
    await ctx.reply("❌ Price must be a number greater than 0.");
    return;
  }

  try {
    await ctx.reply(
      `⚠️ Live OpenSea Listing Request

Wallet: ${walletLabel}
Contract: ${contractAddress}
Token ID: ${tokenId}
Price: ${priceEth} ETH

Submitting to OpenSea...`
    );

    const result = await createOpenSeaListing({
      walletLabel,
      contractAddress,
      tokenId,
      priceEth
    });

    await ctx.reply(
      `✅ OpenSea listing created!

Wallet: ${result.wallet}
Contract: ${result.contractAddress}
Token ID: ${result.tokenId}
Price: ${result.priceEth} ETH

OpenSea SDK response:
${JSON.stringify(result.listing, null, 2).slice(0, 2500)}`
    );
  } catch (error: any) {
    console.error(error);

    await ctx.reply(
      `❌ OpenSea listing failed.

Reason:
${error?.message || "Unknown error"}

For safety, live trading stays disabled until:
ALLOW_MAINNET_TRADING=true`
    );
  }
});



bot.command("osnft", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = ctx.message.text.split(" ");

  if (parts.length < 3) {
    await ctx.reply(
      `Invalid format.

Use:
/osnft 0xContractAddress tokenId

Example:
/osnft 0x9c890D7e4d9beCb20f7b612D5Df3c4157a0837dC 9455`
    );
    return;
  }

  const [, contractAddress, tokenId] = parts;

  if (!ethers.isAddress(contractAddress)) {
    await ctx.reply("❌ Invalid contract address.");
    return;
  }

  try {
    await ctx.reply(
      `🔎 Fetching NFT from OpenSea...

Chain: Ethereum
Contract: ${contractAddress}
Token ID: ${tokenId}`
    );

    const nft = await getOpenSeaNft({
      chain: "ethereum",
      contractAddress,
      tokenId
    });

    let onchainOwner = "Could not read ownerOf";

    try {
      const mainnetProvider = getMainnetProvider();
      const erc721 = new ethers.Contract(
        contractAddress,
        ["function ownerOf(uint256 tokenId) view returns (address)"],
        mainnetProvider
      );

      onchainOwner = await erc721.ownerOf(tokenId);
    } catch {
      onchainOwner = "Could not read ownerOf. It may be ERC1155 or a custom contract.";
    }

    const slugText = nft.collectionSlug || "Could not detect slug";

    await ctx.reply(
      `🖼 NFT Lookup Result

Name: ${nft.name}
Collection Slug: ${slugText}
Contract: ${nft.contractAddress}
Token ID: ${nft.tokenId}
Standard: ${nft.tokenStandard}
Owner Onchain: ${onchainOwner}

Useful next commands:

/bestlisting ${slugText} ${tokenId}

/topoffer ${slugText} ${tokenId}

/oslistpreview wallet1 ${contractAddress} ${tokenId} 0.01`
    );
  } catch (error: any) {
    console.error(error);

    await ctx.reply(
      `❌ NFT lookup failed.

Reason:
${error?.message || "Unknown OpenSea error"}`
    );
  }
});



bot.command("listfloorpreview", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = ctx.message.text.split(" ");

  if (parts.length < 5) {
    await ctx.reply(
      `Invalid format.

Use:
/listfloorpreview wallet1 collectionSlug contractAddress tokenId

Example:
/listfloorpreview wallet1 whackywhales 0x9c890D7e4d9beCb20f7b612D5Df3c4157a0837dC 9455`
    );
    return;
  }

  const [, walletLabel, collectionInput, contractAddress, tokenId] = parts;

  if (!ethers.isAddress(contractAddress)) {
    await ctx.reply("❌ Invalid contract address.");
    return;
  }

  try {
    const slug = extractOpenSeaSlug(collectionInput);

    await ctx.reply(
      `🏷 Preparing floor listing preview...

Wallet: ${walletLabel}
Collection: ${slug}
Contract: ${contractAddress}
Token ID: ${tokenId}

Fetching floor price and checking ownership...`
    );

    const stats = await getOpenSeaCollectionStats(slug);

    if (stats.floorPrice === null) {
      await ctx.reply(
        `❌ Could not detect floor price for ${slug}.

Try:
/osfloor ${slug}`
      );
      return;
    }

    const ownership = await checkErc721Ownership({
      walletLabel,
      contractAddress,
      tokenId
    });

    await ctx.reply(
      `🏷 Floor Listing Preview

Network: Ethereum Mainnet
Collection: ${slug}
Floor Price: ${stats.floorPrice} ${stats.floorSymbol || "ETH"}

Wallet: ${walletLabel}
Wallet Address: ${ownership.walletAddress}
Contract: ${contractAddress}
Token ID: ${tokenId}
Owner Onchain: ${ownership.owner}
Wallet Owns Token: ${ownership.ownsToken ? "YES ✅" : "NO ❌"}

Suggested Listing Price:
${stats.floorPrice} ETH

Live listing is still locked by:
ALLOW_MAINNET_TRADING=false

When ready, use:
/listfloor ${walletLabel} ${slug} ${contractAddress} ${tokenId}`
    );
  } catch (error: any) {
    console.error(error);

    await ctx.reply(
      `❌ Floor listing preview failed.

Reason:
${error?.message || "Unknown error"}`
    );
  }
});

bot.command("listfloor", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = ctx.message.text.split(" ");

  if (parts.length < 5) {
    await ctx.reply(
      `Invalid format.

Use:
/listfloor wallet1 collectionSlug contractAddress tokenId

Example:
/listfloor wallet1 whackywhales 0x9c890D7e4d9beCb20f7b612D5Df3c4157a0837dC 9455`
    );
    return;
  }

  const [, walletLabel, collectionInput, contractAddress, tokenId] = parts;

  if (!ethers.isAddress(contractAddress)) {
    await ctx.reply("❌ Invalid contract address.");
    return;
  }

  try {
    const slug = extractOpenSeaSlug(collectionInput);

    await ctx.reply(
      `⚠️ Live floor listing request

Wallet: ${walletLabel}
Collection: ${slug}
Contract: ${contractAddress}
Token ID: ${tokenId}

Fetching current floor price...`
    );

    const stats = await getOpenSeaCollectionStats(slug);

    if (stats.floorPrice === null) {
      await ctx.reply(
        `❌ Could not detect floor price for ${slug}. Listing cancelled.`
      );
      return;
    }

    await ctx.reply(
      `🏷 Current Floor: ${stats.floorPrice} ${stats.floorSymbol || "ETH"}

Checking ownership before listing...`
    );

    const ownership = await checkErc721Ownership({
      walletLabel,
      contractAddress,
      tokenId
    });

    if (!ownership.ownsToken) {
      await ctx.reply(
        `❌ Listing cancelled.

Wallet does not own this NFT.

Wallet: ${ownership.walletAddress}
Owner Onchain: ${ownership.owner}`
      );
      return;
    }

    await ctx.reply(
      `✅ Ownership confirmed.

Submitting OpenSea listing at floor price:
${stats.floorPrice} ETH`
    );

    const result = await createOpenSeaListing({
      walletLabel,
      contractAddress,
      tokenId,
      priceEth: Number(stats.floorPrice)
    });

    await ctx.reply(
      `✅ OpenSea floor listing created!

Wallet: ${result.wallet}
Contract: ${result.contractAddress}
Token ID: ${result.tokenId}
Price: ${result.priceEth} ETH

OpenSea SDK response:
${JSON.stringify(result.listing, null, 2).slice(0, 2500)}`
    );
  } catch (error: any) {
    console.error(error);

    await ctx.reply(
      `❌ Floor listing failed.

Reason:
${error?.message || "Unknown error"}

Live trading is locked unless:
ALLOW_MAINNET_TRADING=true`
    );
  }
});



bot.command("postmint", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = ctx.message.text.split(" ");

  if (parts.length < 5) {
    await ctx.reply(
      `Invalid format.

Use:
/postmint wallet1 collectionSlug contractAddress tokenId

Example:
/postmint wallet1 whackywhales 0x9c890D7e4d9beCb20f7b612D5Df3c4157a0837dC 9455`
    );
    return;
  }

  const [, walletLabel, collectionInput, contractAddress, tokenId] = parts;

  if (!ethers.isAddress(contractAddress)) {
    await ctx.reply("❌ Invalid contract address.");
    return;
  }

  try {
    const collectionSlug = extractOpenSeaSlug(collectionInput);

    const action = createPostMintActionSession({
      walletLabel,
      collectionSlug,
      contractAddress,
      tokenId,
      network: "ethereum"
    });

    await sendPostMintActionMenu(ctx, action);
  } catch (error: any) {
    console.error(error);

    await ctx.reply(
      `❌ Could not create post-mint menu.

Reason:
${error?.message || "Unknown error"}`
    );
  }
});

bot.action(/^pm:view:(.+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const id = (ctx as any).match[1];
  const action = getPostMintActionSession(id);

  if (!action) {
    await ctx.reply("❌ This post-mint session was not found.");
    return;
  }

  try {
    if (action.network !== "ethereum") {
      await ctx.reply("This action is only available for Ethereum mainnet NFTs for now.");
      return;
    }

    const nft = await getOpenSeaNft({
      chain: "ethereum",
      contractAddress: action.contractAddress,
      tokenId: action.tokenId
    });

    await ctx.reply(
      `🖼 NFT

Name: ${nft.name}
Collection: ${nft.collectionSlug || action.collectionSlug}
Contract: ${action.contractAddress}
Token ID: ${action.tokenId}
Standard: ${nft.tokenStandard}
OpenSea URL: ${nft.openseaUrl || "Not available"}`
    );
  } catch (error: any) {
    console.error(error);

    await ctx.reply(
      `❌ Could not view NFT.

Reason:
${error?.message || "Unknown error"}`
    );
  }
});

bot.action(/^pm:floor:(.+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const id = (ctx as any).match[1];
  const action = getPostMintActionSession(id);

  if (!action) {
    await ctx.reply("❌ This post-mint session was not found.");
    return;
  }

  try {
    await ctx.reply(
      `📊 Checking floor and best listing...

Collection: ${action.collectionSlug}
Token ID: ${action.tokenId}`
    );

    const stats = await getOpenSeaCollectionStats(action.collectionSlug);
    const bestListing = await getOpenSeaBestListing(
      action.collectionSlug,
      action.tokenId
    );

    const floorText =
      stats.floorPrice === null
        ? "Not available"
        : `${stats.floorPrice} ${stats.floorSymbol || "ETH"}`;

    const listingText = bestListing.hasListing
      ? `${bestListing.amount} ${bestListing.symbol}`
      : "No active listing found for this NFT";

    await ctx.reply(
      `📊 Market Snapshot

Collection: ${action.collectionSlug}
Token ID: ${action.tokenId}

Collection Floor:
${floorText}

Best Listing For This NFT:
${listingText}

Useful:
• Use "List at Floor Preview" to prepare a floor listing.
• Use "Top Offer" to check if there is an offer to accept.`
    );
  } catch (error: any) {
    console.error(error);

    await ctx.reply(
      `❌ Could not fetch market snapshot.

Reason:
${error?.message || "Unknown error"}`
    );
  }
});

bot.action(/^pm:offer:(.+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const id = (ctx as any).match[1];
  const action = getPostMintActionSession(id);

  if (!action) {
    await ctx.reply("❌ This post-mint session was not found.");
    return;
  }

  try {
    await ctx.reply(
      `💰 Checking top offer...

Collection: ${action.collectionSlug}
Token ID: ${action.tokenId}`
    );

    const bestOffer = await getOpenSeaBestOffer(
      action.collectionSlug,
      action.tokenId
    );

    if (!bestOffer.hasOffer) {
      await ctx.reply(
        `❌ No top offer found.

Collection: ${action.collectionSlug}
Token ID: ${action.tokenId}`
      );
      return;
    }

    await ctx.reply(
      `💰 Top Offer

Collection: ${action.collectionSlug}
Token ID: ${action.tokenId}
Offer: ${bestOffer.amount} ${bestOffer.symbol}

Order Hash:
${bestOffer.orderHash}

Next module:
[Accept Top Offer] with confirmation before sending the transaction.`
    );
  } catch (error: any) {
    console.error(error);

    await ctx.reply(
      `❌ Could not fetch top offer.

Reason:
${error?.message || "Unknown error"}`
    );
  }
});

bot.action(/^pm:listfloor:(.+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const id = (ctx as any).match[1];
  const action = getPostMintActionSession(id);

  if (!action) {
    await ctx.reply("❌ This post-mint session was not found.");
    return;
  }

  try {
    await ctx.reply(
      `🏷 Preparing list-at-floor preview...

Wallet: ${action.walletLabel}
Collection: ${action.collectionSlug}
Token ID: ${action.tokenId}`
    );

    const stats = await getOpenSeaCollectionStats(action.collectionSlug);

    if (stats.floorPrice === null) {
      await ctx.reply("❌ Could not detect collection floor price.");
      return;
    }

    const ownership = await checkErc721Ownership({
      walletLabel: action.walletLabel,
      contractAddress: action.contractAddress,
      tokenId: action.tokenId
    });

    await ctx.reply(
      `🏷 List at Floor Preview

Collection: ${action.collectionSlug}
Floor Price: ${stats.floorPrice} ${stats.floorSymbol || "ETH"}

Wallet: ${action.walletLabel}
Wallet Address: ${ownership.walletAddress}
Contract: ${action.contractAddress}
Token ID: ${action.tokenId}
Owner Onchain: ${ownership.owner}
Wallet Owns Token: ${ownership.ownsToken ? "YES ✅" : "NO ❌"}

Suggested command:
/listfloor ${action.walletLabel} ${action.collectionSlug} ${action.contractAddress} ${action.tokenId}

Live listing lock:
ALLOW_MAINNET_TRADING=${process.env.ALLOW_MAINNET_TRADING || "false"}`
    );
  } catch (error: any) {
    console.error(error);

    await ctx.reply(
      `❌ List-at-floor preview failed.

Reason:
${error?.message || "Unknown error"}`
    );
  }
});

bot.action(/^pm:custom:(.+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const id = (ctx as any).match[1];
  const action = getPostMintActionSession(id);

  if (!action) {
    await ctx.reply("❌ This post-mint session was not found.");
    return;
  }

  await ctx.reply(
    `✍️ Custom Listing

NFT:
${action.collectionSlug} #${action.tokenId}

Send your custom price like this:

/customprice ${id} PRICE_ETH

Example:
/customprice ${id} 0.03

The bot will check ownership and then show a final confirmation button before listing.`
  );
});

bot.action(/^pm:hold:(.+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const id = (ctx as any).match[1];
  const action = getPostMintActionSession(id);

  if (!action) {
    await ctx.reply("❌ This post-mint session was not found.");
    return;
  }

  await ctx.reply(
    `🧊 Holding NFT.

Collection: ${action.collectionSlug}
Token ID: ${action.tokenId}

No listing or offer action taken.`
  );
});



bot.action(/^pm:floorconfirmpreview:(.+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const id = (ctx as any).match[1];
  const action = getPostMintActionSession(id);

  if (!action) {
    await ctx.reply("❌ This post-mint session was not found.");
    return;
  }

  try {
    await ctx.reply(
      `⚠️ Preparing final floor listing confirmation...

Wallet: ${action.walletLabel}
Collection: ${action.collectionSlug}
Contract: ${action.contractAddress}
Token ID: ${action.tokenId}

Checking floor price and ownership again...`
    );

    const stats = await getOpenSeaCollectionStats(action.collectionSlug);

    if (stats.floorPrice === null) {
      await ctx.reply("❌ Could not detect floor price. Listing cancelled.");
      return;
    }

    const ownership = await checkErc721Ownership({
      walletLabel: action.walletLabel,
      contractAddress: action.contractAddress,
      tokenId: action.tokenId
    });

    if (!ownership.ownsToken) {
      await ctx.reply(
        `❌ Cannot list this NFT.

Wallet does not own token.

Wallet: ${ownership.walletAddress}
Owner Onchain: ${ownership.owner}`
      );
      return;
    }

    await ctx.reply(
      `✅ Final Listing Confirmation

Network: Ethereum Mainnet
Collection: ${action.collectionSlug}
Wallet: ${action.walletLabel}
Wallet Address: ${ownership.walletAddress}
Contract: ${action.contractAddress}
Token ID: ${action.tokenId}

Current Floor Price:
${stats.floorPrice} ${stats.floorSymbol || "ETH"}

Live trading lock:
ALLOW_MAINNET_TRADING=${process.env.ALLOW_MAINNET_TRADING || "false"}

If live trading is false, the next button will NOT create a listing.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🚨 Confirm Live List at Floor", `pm:floorlistfinal:${action.id}`)],
        [Markup.button.callback("❌ Cancel", `pm:cancel:${action.id}`)]
      ])
    );
  } catch (error: any) {
    console.error(error);

    await ctx.reply(
      `❌ Final listing confirmation failed.

Reason:
${error?.message || "Unknown error"}`
    );
  }
});

bot.action(/^pm:floorlistfinal:(.+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const id = (ctx as any).match[1];
  const action = getPostMintActionSession(id);

  if (!action) {
    await ctx.reply("❌ This post-mint session was not found.");
    return;
  }

  try {
    await ctx.reply(
      `🚨 Final command received.

Re-checking current floor price and wallet ownership before listing...`
    );

    const stats = await getOpenSeaCollectionStats(action.collectionSlug);

    if (stats.floorPrice === null) {
      await ctx.reply("❌ Could not detect floor price. Listing cancelled.");
      return;
    }

    const ownership = await checkErc721Ownership({
      walletLabel: action.walletLabel,
      contractAddress: action.contractAddress,
      tokenId: action.tokenId
    });

    if (!ownership.ownsToken) {
      await ctx.reply(
        `❌ Listing cancelled.

Wallet does not own this NFT.

Wallet: ${ownership.walletAddress}
Owner Onchain: ${ownership.owner}`
      );
      return;
    }

    await ctx.reply(
      `🏷 Submitting OpenSea listing...

Wallet: ${action.walletLabel}
Contract: ${action.contractAddress}
Token ID: ${action.tokenId}
Price: ${stats.floorPrice} ETH`
    );

    const result = await createOpenSeaListing({
      walletLabel: action.walletLabel,
      contractAddress: action.contractAddress,
      tokenId: action.tokenId,
      priceEth: Number(stats.floorPrice)
    });

    await ctx.reply(
      `✅ OpenSea listing created!

Wallet: ${result.wallet}
Contract: ${result.contractAddress}
Token ID: ${result.tokenId}
Price: ${result.priceEth} ETH

OpenSea SDK response:
${JSON.stringify(result.listing, null, 2).slice(0, 2500)}`
    );
  } catch (error: any) {
    console.error(error);

    await ctx.reply(
      `❌ Live floor listing failed.

Reason:
${error?.message || "Unknown error"}

Safety lock status:
ALLOW_MAINNET_TRADING=${process.env.ALLOW_MAINNET_TRADING || "false"}`
    );
  }
});

bot.action(/^pm:cancel:(.+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const id = (ctx as any).match[1];
  const action = getPostMintActionSession(id);

  if (!action) {
    await ctx.reply("Cancelled.");
    return;
  }

  await ctx.reply(
    `❌ Action cancelled.

Collection: ${action.collectionSlug}
Token ID: ${action.tokenId}

No transaction was sent.`
  );
});



bot.command("customprice", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = ctx.message.text.split(" ");

  if (parts.length < 3) {
    await ctx.reply(
      `Invalid format.

Use:
/customprice POST_MINT_SESSION_ID priceETH

Example:
/customprice abc123 0.03

Tip:
Click "Custom List Preview" from the post-mint menu and it will show you the correct session ID.`
    );
    return;
  }

  const [, sessionId, priceRaw] = parts;
  const priceEth = Number(priceRaw);

  if (!Number.isFinite(priceEth) || priceEth <= 0) {
    await ctx.reply("❌ Price must be a number greater than 0.");
    return;
  }

  if (priceEth > 1000) {
    await ctx.reply("❌ Price looks too high. Please check and try again.");
    return;
  }

  const action = getPostMintActionSession(sessionId);

  if (!action) {
    await ctx.reply("❌ This post-mint session was not found.");
    return;
  }

  try {
    await ctx.reply(
      `✍️ Preparing custom listing confirmation...

Wallet: ${action.walletLabel}
Collection: ${action.collectionSlug}
Contract: ${action.contractAddress}
Token ID: ${action.tokenId}
Custom Price: ${priceEth} ETH

Checking ownership...`
    );

    const ownership = await checkErc721Ownership({
      walletLabel: action.walletLabel,
      contractAddress: action.contractAddress,
      tokenId: action.tokenId
    });

    if (!ownership.ownsToken) {
      await ctx.reply(
        `❌ Cannot list this NFT.

Wallet does not own token.

Wallet: ${ownership.walletAddress}
Owner Onchain: ${ownership.owner}`
      );
      return;
    }

    await ctx.reply(
      `✅ Custom Listing Confirmation

Network: Ethereum Mainnet
Collection: ${action.collectionSlug}
Wallet: ${action.walletLabel}
Wallet Address: ${ownership.walletAddress}
Contract: ${action.contractAddress}
Token ID: ${action.tokenId}

Listing Price:
${priceEth} ETH

Live trading lock:
ALLOW_MAINNET_TRADING=${process.env.ALLOW_MAINNET_TRADING || "false"}

If live trading is false, the confirm button will NOT create a listing.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🚨 Confirm Custom Listing", `pm:customlistfinal:${sessionId}:${priceEth}`)],
        [Markup.button.callback("❌ Cancel", `pm:cancel:${sessionId}`)]
      ])
    );
  } catch (error: any) {
    console.error(error);

    await ctx.reply(
      `❌ Custom listing confirmation failed.

Reason:
${error?.message || "Unknown error"}`
    );
  }
});

bot.action(/^pm:customlistfinal:([^:]+):(.+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const sessionId = (ctx as any).match[1];
  const priceRaw = (ctx as any).match[2];
  const priceEth = Number(priceRaw);

  if (!Number.isFinite(priceEth) || priceEth <= 0) {
    await ctx.reply("❌ Invalid custom listing price.");
    return;
  }

  const action = getPostMintActionSession(sessionId);

  if (!action) {
    await ctx.reply("❌ This post-mint session was not found.");
    return;
  }

  try {
    await ctx.reply(
      `🚨 Final custom listing command received.

Re-checking ownership before submitting...`
    );

    const ownership = await checkErc721Ownership({
      walletLabel: action.walletLabel,
      contractAddress: action.contractAddress,
      tokenId: action.tokenId
    });

    if (!ownership.ownsToken) {
      await ctx.reply(
        `❌ Listing cancelled.

Wallet does not own this NFT.

Wallet: ${ownership.walletAddress}
Owner Onchain: ${ownership.owner}`
      );
      return;
    }

    await ctx.reply(
      `🏷 Submitting custom OpenSea listing...

Wallet: ${action.walletLabel}
Contract: ${action.contractAddress}
Token ID: ${action.tokenId}
Price: ${priceEth} ETH`
    );

    const result = await createOpenSeaListing({
      walletLabel: action.walletLabel,
      contractAddress: action.contractAddress,
      tokenId: action.tokenId,
      priceEth
    });

    await ctx.reply(
      `✅ Custom OpenSea listing created!

Wallet: ${result.wallet}
Contract: ${result.contractAddress}
Token ID: ${result.tokenId}
Price: ${result.priceEth} ETH

OpenSea SDK response:
${JSON.stringify(result.listing, null, 2).slice(0, 2500)}`
    );
  } catch (error: any) {
    console.error(error);

    await ctx.reply(
      `❌ Custom listing failed.

Reason:
${error?.message || "Unknown error"}

Safety lock status:
ALLOW_MAINNET_TRADING=${process.env.ALLOW_MAINNET_TRADING || "false"}`
    );
  }
});



bot.action(/^pm:acceptofferpreview:(.+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const id = (ctx as any).match[1];
  const action = getPostMintActionSession(id);

  if (!action) {
    await ctx.reply("❌ This post-mint session was not found.");
    return;
  }

  try {
    await ctx.reply(
      `💰 Preparing accept-offer confirmation...

Wallet: ${action.walletLabel}
Collection: ${action.collectionSlug}
Contract: ${action.contractAddress}
Token ID: ${action.tokenId}

Checking top offer and ownership...`
    );

    const bestOffer = await getOpenSeaBestOffer(
      action.collectionSlug,
      action.tokenId
    );

    if (!bestOffer.hasOffer) {
      await ctx.reply(
        `❌ No top offer found.

Collection: ${action.collectionSlug}
Token ID: ${action.tokenId}`
      );
      return;
    }

    const ownership = await checkErc721Ownership({
      walletLabel: action.walletLabel,
      contractAddress: action.contractAddress,
      tokenId: action.tokenId
    });

    if (!ownership.ownsToken) {
      await ctx.reply(
        `❌ Cannot accept offer.

Wallet does not own this NFT.

Wallet: ${ownership.walletAddress}
Owner Onchain: ${ownership.owner}`
      );
      return;
    }

    await ctx.reply(
      `⚠️ Accept Top Offer Confirmation

Network: Ethereum Mainnet
Collection: ${action.collectionSlug}
Wallet: ${action.walletLabel}
Wallet Address: ${ownership.walletAddress}
Contract: ${action.contractAddress}
Token ID: ${action.tokenId}

Top Offer:
${bestOffer.amount} ${bestOffer.symbol}

Order Hash:
${bestOffer.orderHash}

Live trading lock:
ALLOW_MAINNET_TRADING=${process.env.ALLOW_MAINNET_TRADING || "false"}

If you confirm, this will sell the NFT for the top offer when live trading is enabled.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🚨 Confirm Accept Top Offer", `pm:acceptofferfinal:${action.id}`)],
        [Markup.button.callback("❌ Cancel", `pm:cancel:${action.id}`)]
      ])
    );
  } catch (error: any) {
    console.error(error);

    await ctx.reply(
      `❌ Accept-offer preview failed.

Reason:
${error?.message || "Unknown error"}`
    );
  }
});

bot.action(/^pm:acceptofferfinal:(.+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const id = (ctx as any).match[1];
  const action = getPostMintActionSession(id);

  if (!action) {
    await ctx.reply("❌ This post-mint session was not found.");
    return;
  }

  try {
    await ctx.reply(
      `🚨 Final accept-offer command received.

Re-checking ownership and latest top offer before submitting...`
    );

    const result = await acceptOpenSeaBestOffer({
      walletLabel: action.walletLabel,
      collectionSlug: action.collectionSlug,
      contractAddress: action.contractAddress,
      tokenId: action.tokenId
    });

    await ctx.reply(
      `✅ Top offer accepted!

Wallet: ${result.wallet}
Collection: ${result.collectionSlug}
Contract: ${result.contractAddress}
Token ID: ${result.tokenId}
Offer: ${result.offerAmount} ${result.offerSymbol}

Order Hash:
${result.orderHash}

Tx:
${result.txHash}`
    );
  } catch (error: any) {
    console.error(error);

    await ctx.reply(
      `❌ Accept top offer failed.

Reason:
${error?.message || "Unknown error"}

Safety lock status:
ALLOW_MAINNET_TRADING=${process.env.ALLOW_MAINNET_TRADING || "false"}`
    );
  }
});



bot.action("os_portfolio_help", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  await ctx.reply(
    `📦 OpenSea Portfolio Scanner

Scan NFTs owned by a saved wallet:

/osportfolio wallet1

Optional limit:
/osportfolio wallet1 20

After scanning, click any NFT to open the post-mint action menu.`
  );
});

bot.command("osportfolio", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const parts = ctx.message.text.split(" ");
  const walletLabel = parts[1]?.trim().toLowerCase();
  const limitRaw = parts[2];

  if (!walletLabel) {
    await ctx.reply(
      `Invalid format.

Use:
/osportfolio wallet1

Or:
/osportfolio wallet1 20`
    );
    return;
  }

  const limit = limitRaw ? Number(limitRaw) : 10;

  if (!Number.isInteger(limit) || limit <= 0 || limit > 50) {
    await ctx.reply("❌ Limit must be a whole number from 1 to 50.");
    return;
  }

  try {
    const mainnetProvider = getMainnetProvider();
    const wallet = getWalletByLabel(walletLabel, mainnetProvider);

    await ctx.reply(
      `📦 Scanning OpenSea portfolio...

Wallet: ${walletLabel}
Address: ${wallet.address}
Chain: Ethereum
Limit: ${limit}`
    );

    const portfolio = await getOpenSeaNftsByAccount({
      chain: "ethereum",
      address: wallet.address,
      limit
    });

    if (portfolio.nfts.length === 0) {
      await ctx.reply(
        `No NFTs found for ${walletLabel} on OpenSea.

Wallet:
${wallet.address}`
      );
      return;
    }

    let message = `📦 OpenSea Portfolio\n\nWallet: ${walletLabel}\nAddress: ${wallet.address}\n\n`;

    const buttons: any[] = [];

    for (const nft of portfolio.nfts) {
      const action = createPostMintActionSession({
        walletLabel,
        collectionSlug: nft.collectionSlug,
        contractAddress: nft.contractAddress,
        tokenId: nft.identifier,
        network: "ethereum"
      });

      message += `• ${nft.name}\n`;
      message += `  Collection: ${nft.collectionSlug}\n`;
      message += `  Token ID: ${nft.identifier}\n\n`;

      const shortName =
        nft.name.length > 24 ? nft.name.slice(0, 21) + "..." : nft.name;

      buttons.push([
        Markup.button.callback(
          `🖼 ${shortName}`,
          `pf:open:${action.id}`
        )
      ]);
    }

    message += `Click an NFT below to open actions.`;

    await ctx.reply(message, Markup.inlineKeyboard(buttons));
  } catch (error: any) {
    console.error(error);

    await ctx.reply(
      `❌ Portfolio scan failed.

Reason:
${error?.message || "Unknown error"}`
    );
  }
});

bot.action(/^pf:open:(.+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await ctx.answerCbQuery();

  const id = (ctx as any).match[1];
  const action = getPostMintActionSession(id);

  if (!action) {
    await ctx.reply("❌ Portfolio session not found.");
    return;
  }

  await sendPostMintActionMenu(ctx, action);
});


bot.launch();

console.log("Bot is running...");
console.log("Admin lock + NFT mint module loaded.");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
