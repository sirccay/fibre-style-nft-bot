import "dotenv/config";
import fs from "fs";
import path from "path";
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  scryptSync
} from "crypto";
import { ethers } from "ethers";

type EncryptedPrivateKey = {
  iv: string;
  authTag: string;
  ciphertext: string;
};

type WalletRecord = {
  id: string;
  label: string;
  address: string;
  encryptedPrivateKey: EncryptedPrivateKey;
  createdAt: string;
};

const VAULT_PATH = path.join(process.cwd(), "data", "vault.json");

function getVaultKey(): Buffer {
  const secret = process.env.VAULT_SECRET;

  if (!secret || secret.length < 32) {
    throw new Error("Missing VAULT_SECRET in .env. It must be a strong secret.");
  }

  return scryptSync(secret, "nft-mint-bot-vault-v1", 32);
}

function encryptPrivateKey(privateKey: string): EncryptedPrivateKey {
  const key = getVaultKey();
  const iv = randomBytes(12);

  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(privateKey, "utf8"),
    cipher.final()
  ]);

  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
    ciphertext: ciphertext.toString("hex")
  };
}

function decryptPrivateKey(encrypted: EncryptedPrivateKey): string {
  const key = getVaultKey();

  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(encrypted.iv, "hex")
  );

  decipher.setAuthTag(Buffer.from(encrypted.authTag, "hex"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "hex")),
    decipher.final()
  ]);

  return decrypted.toString("utf8");
}

function loadVault(): WalletRecord[] {
  if (!fs.existsSync(VAULT_PATH)) {
    return [];
  }

  const raw = fs.readFileSync(VAULT_PATH, "utf8");

  if (!raw.trim()) {
    return [];
  }

  const parsed = JSON.parse(raw);

  return parsed.wallets || [];
}

function saveVault(wallets: WalletRecord[]) {
  const dir = path.dirname(VAULT_PATH);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(
    VAULT_PATH,
    JSON.stringify({ wallets }, null, 2),
    "utf8"
  );
}

export function addWallet(label: string, privateKey: string) {
  const normalizedLabel = label.trim().toLowerCase();

  if (!normalizedLabel) {
    throw new Error("Wallet label is required.");
  }

  const wallet = new ethers.Wallet(privateKey);
  const wallets = loadVault();

  const labelExists = wallets.some((w) => w.label === normalizedLabel);
  if (labelExists) {
    throw new Error(`A wallet with label "${normalizedLabel}" already exists.`);
  }

  const addressExists = wallets.some(
    (w) => w.address.toLowerCase() === wallet.address.toLowerCase()
  );

  if (addressExists) {
    throw new Error("This wallet address already exists in the vault.");
  }

  const record: WalletRecord = {
    id: crypto.randomUUID(),
    label: normalizedLabel,
    address: wallet.address,
    encryptedPrivateKey: encryptPrivateKey(privateKey),
    createdAt: new Date().toISOString()
  };

  wallets.push(record);
  saveVault(wallets);

  return {
    label: record.label,
    address: record.address
  };
}

export function listWallets() {
  return loadVault().map((wallet) => ({
    label: wallet.label,
    address: wallet.address,
    createdAt: wallet.createdAt
  }));
}

export function getWalletByLabel(label: string, provider: ethers.Provider) {
  const normalizedLabel = label.trim().toLowerCase();
  const wallets = loadVault();

  const record = wallets.find((wallet) => wallet.label === normalizedLabel);

  if (!record) {
    throw new Error(`Wallet "${normalizedLabel}" not found.`);
  }

  const privateKey = decryptPrivateKey(record.encryptedPrivateKey);

  return new ethers.Wallet(privateKey, provider);
}
