import "dotenv/config";
import fs from "fs";
import path from "path";
import { appendWalletAuditLog } from "./audit.js";

type EncryptedPrivateKey = {
  iv: string;
  authTag: string;
  ciphertext: string;
};

type WalletRecord = {
  id?: string;
  label: string;
  address: string;
  ownerTelegramId?: string;
  encryptedPrivateKey?: EncryptedPrivateKey;
  wrappedDek?: string;
  kmsProvider?: string;
  kmsKeyRef?: string;
  encryptionVersion?: string;
  createdAt?: string;
  [key: string]: unknown;
};

type VaultFile = {
  wallets?: WalletRecord[];
  [key: string]: unknown;
};

const VAULT_PATH = path.join(process.cwd(), "data", "vault.json");

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

function parseArgs() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const positional = args.filter((arg) => arg !== "--force");
  const label = positional[0]?.trim();
  const ownerTelegramId = positional[1]?.trim();

  if (!label || !ownerTelegramId) {
    throw new Error(
      "Usage: npm run wallet:claim -- walletLabel ownerTelegramId [--force]"
    );
  }

  if (!/^\d+$/.test(ownerTelegramId)) {
    throw new Error("ownerTelegramId must be a numeric Telegram user ID.");
  }

  return {
    label: normalizeLabel(label),
    ownerTelegramId,
    force
  };
}

function loadVault(): VaultFile {
  if (!fs.existsSync(VAULT_PATH)) {
    throw new Error("Missing data/vault.json. No wallet vault was found.");
  }

  const raw = fs.readFileSync(VAULT_PATH, "utf8");

  if (!raw.trim()) {
    throw new Error("data/vault.json is empty.");
  }

  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed.wallets)) {
    throw new Error("data/vault.json does not contain a wallets array.");
  }

  return parsed;
}

function saveVaultSafely(vault: VaultFile) {
  const dir = path.dirname(VAULT_PATH);
  const tempPath = path.join(
    dir,
    `.vault.${process.pid}.${Date.now()}.tmp`
  );

  fs.writeFileSync(tempPath, JSON.stringify(vault, null, 2), "utf8");
  fs.renameSync(tempPath, VAULT_PATH);
}

async function main() {
  const { label, ownerTelegramId, force } = parseArgs();
  const vault = loadVault();
  const wallets = vault.wallets || [];
  const matches = wallets.filter(
    (wallet) => normalizeLabel(wallet.label) === label
  );

  if (matches.length === 0) {
    throw new Error(`Wallet "${label}" not found in data/vault.json.`);
  }

  if (matches.length > 1) {
    throw new Error(
      `Multiple wallet records found for "${label}". Refusing to guess which wallet to claim.`
    );
  }

  const wallet = matches[0];

  if (!wallet) {
    throw new Error(`Wallet "${label}" not found in data/vault.json.`);
  }

  const currentOwner = wallet.ownerTelegramId?.trim();

  if (currentOwner && !force) {
    throw new Error(
      `Wallet "${label}" already has ownerTelegramId ${currentOwner}. Re-run with --force to replace it.`
    );
  }

  wallet.ownerTelegramId = ownerTelegramId;
  saveVaultSafely(vault);

  await appendWalletAuditLog({
    walletLabel: wallet.label,
    walletAddress: wallet.address,
    ownerTelegramId,
    action: "wallet_owner_claimed",
    encryptionVersion: wallet.encryptionVersion || "legacy-local-v1"
  });

  console.log("\n✅ Wallet owner claimed.");
  console.log(`Label: ${wallet.label}`);
  console.log(`Address: ${wallet.address}`);
  console.log(`Owner Telegram ID: ${ownerTelegramId}`);
  console.log("\nEncrypted wallet fields were not decrypted or re-encrypted.");
}

main().catch((error) => {
  console.error("\n❌ Wallet claim failed:");
  console.error(error instanceof Error ? error.message : "Unknown error");
  process.exit(1);
});
