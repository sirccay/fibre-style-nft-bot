import "dotenv/config";
import fs from "fs";
import path from "path";
import {
  randomBytes,
  randomUUID,
  createCipheriv,
  createDecipheriv,
  scryptSync
} from "crypto";
import {
  KMSClient,
  GenerateDataKeyCommand,
  DecryptCommand
} from "@aws-sdk/client-kms";
import { ethers } from "ethers";
import { appendWalletAuditLog } from "./audit.js";

const KMS_ENVELOPE_VERSION = "kms-envelope-v1";
const LEGACY_LOCAL_VERSION = "legacy-local-v1";

type EncryptionVersion =
  | typeof KMS_ENVELOPE_VERSION
  | typeof LEGACY_LOCAL_VERSION;

type EncryptedPrivateKey = {
  iv: string;
  authTag: string;
  ciphertext: string;
};

type WalletRecord = {
  id: string;
  label: string;
  address: string;
  ownerTelegramId?: string;
  encryptedPrivateKey: EncryptedPrivateKey;
  wrappedDek?: string;
  encryptionVersion?: EncryptionVersion;
  createdAt: string;
};

type WalletSummary = {
  label: string;
  address: string;
  ownerTelegramId?: string;
  encryptionVersion: EncryptionVersion;
  createdAt: string;
};

const VAULT_PATH = path.join(process.cwd(), "data", "vault.json");

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

function normalizeOwnerTelegramId(ownerTelegramId?: string | null): string | undefined {
  const normalized = ownerTelegramId?.trim();
  return normalized || undefined;
}

function getRecordEncryptionVersion(record: WalletRecord): EncryptionVersion {
  return record.encryptionVersion || LEGACY_LOCAL_VERSION;
}

function getKmsClient() {
  const region = process.env.AWS_REGION;

  if (!region) {
    throw new Error("Missing AWS_REGION in .env.");
  }

  return new KMSClient({ region });
}

function getKmsKeyId(): string {
  const keyId = process.env.KMS_KEY_ID;

  if (!keyId) {
    throw new Error("Missing KMS_KEY_ID in .env.");
  }

  return keyId;
}

function getLegacyVaultKey(): Buffer {
  const secret = process.env.VAULT_SECRET;

  if (!secret || secret.length < 32) {
    throw new Error(
      "Missing VAULT_SECRET in .env. It is required only to read legacy local vault records."
    );
  }

  return scryptSync(secret, "nft-mint-bot-vault-v1", 32);
}

function encryptPrivateKeyWithDek(privateKey: string, dek: Buffer): EncryptedPrivateKey {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);

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

function decryptPrivateKeyWithDek(encrypted: EncryptedPrivateKey, dek: Buffer): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    dek,
    Buffer.from(encrypted.iv, "hex")
  );

  decipher.setAuthTag(Buffer.from(encrypted.authTag, "hex"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "hex")),
    decipher.final()
  ]);

  return decrypted.toString("utf8");
}

function decryptLegacyPrivateKey(encrypted: EncryptedPrivateKey): string {
  const key = getLegacyVaultKey();

  try {
    return decryptPrivateKeyWithDek(encrypted, key);
  } finally {
    key.fill(0);
  }
}

async function createEncryptedPrivateKey(privateKey: string) {
  const kms = getKmsClient();
  const response = await kms.send(
    new GenerateDataKeyCommand({
      KeyId: getKmsKeyId(),
      KeySpec: "AES_256"
    })
  );

  if (!response.Plaintext || !response.CiphertextBlob) {
    throw new Error("AWS KMS did not return a usable data key.");
  }

  const dek = Buffer.from(response.Plaintext);

  try {
    return {
      encryptedPrivateKey: encryptPrivateKeyWithDek(privateKey, dek),
      wrappedDek: Buffer.from(response.CiphertextBlob).toString("base64")
    };
  } finally {
    dek.fill(0);
  }
}

async function unwrapDek(wrappedDek: string): Promise<Buffer> {
  const kms = getKmsClient();
  const response = await kms.send(
    new DecryptCommand({
      CiphertextBlob: Buffer.from(wrappedDek, "base64")
    })
  );

  if (!response.Plaintext) {
    throw new Error("AWS KMS did not return a usable plaintext data key.");
  }

  return Buffer.from(response.Plaintext);
}

async function decryptPrivateKeyForRecord(record: WalletRecord): Promise<string> {
  const encryptionVersion = getRecordEncryptionVersion(record);

  if (encryptionVersion === LEGACY_LOCAL_VERSION) {
    return decryptLegacyPrivateKey(record.encryptedPrivateKey);
  }

  if (!record.wrappedDek) {
    throw new Error(`Wallet "${record.label}" is missing its wrapped DEK.`);
  }

  const dek = await unwrapDek(record.wrappedDek);

  try {
    return decryptPrivateKeyWithDek(record.encryptedPrivateKey, dek);
  } finally {
    dek.fill(0);
  }
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

function recordMatchesOwner(record: WalletRecord, ownerTelegramId?: string) {
  if (!ownerTelegramId) {
    return true;
  }

  return record.ownerTelegramId === ownerTelegramId || !record.ownerTelegramId;
}

function findWalletRecordByLabel(
  label: string,
  ownerTelegramId?: string
): WalletRecord {
  const normalizedLabel = normalizeLabel(label);

  if (!normalizedLabel) {
    throw new Error("Wallet label is required.");
  }

  const wallets = loadVault();

  const ownerScopedRecord = ownerTelegramId
    ? wallets.find(
        (wallet) =>
          wallet.label === normalizedLabel &&
          wallet.ownerTelegramId === ownerTelegramId
      )
    : null;

  const fallbackRecord = wallets.find(
    (wallet) =>
      wallet.label === normalizedLabel &&
      recordMatchesOwner(wallet, ownerTelegramId)
  );

  const record = ownerScopedRecord || fallbackRecord;

  if (!record) {
    throw new Error(`Wallet "${normalizedLabel}" not found.`);
  }

  return record;
}

function toWalletSummary(wallet: WalletRecord): WalletSummary {
  return {
    label: wallet.label,
    address: wallet.address,
    ...(wallet.ownerTelegramId ? { ownerTelegramId: wallet.ownerTelegramId } : {}),
    encryptionVersion: getRecordEncryptionVersion(wallet),
    createdAt: wallet.createdAt
  };
}

export async function addWallet(
  label: string,
  privateKey: string,
  ownerTelegramId?: string
) {
  const normalizedLabel = normalizeLabel(label);
  const normalizedOwnerTelegramId = normalizeOwnerTelegramId(ownerTelegramId);

  if (!normalizedLabel) {
    throw new Error("Wallet label is required.");
  }

  const wallet = new ethers.Wallet(privateKey);
  const wallets = loadVault();

  const labelExists = wallets.some((savedWallet) => {
    if (savedWallet.label !== normalizedLabel) {
      return false;
    }

    if (!normalizedOwnerTelegramId) {
      return true;
    }

    return (
      savedWallet.ownerTelegramId === normalizedOwnerTelegramId ||
      !savedWallet.ownerTelegramId
    );
  });

  if (labelExists) {
    throw new Error(`A wallet with label "${normalizedLabel}" already exists.`);
  }

  const addressExists = wallets.some(
    (savedWallet) =>
      savedWallet.address.toLowerCase() === wallet.address.toLowerCase()
  );

  if (addressExists) {
    throw new Error("This wallet address already exists in the vault.");
  }

  const encrypted = await createEncryptedPrivateKey(privateKey);

  const record: WalletRecord = {
    id: randomUUID(),
    label: normalizedLabel,
    address: wallet.address,
    ...(normalizedOwnerTelegramId
      ? { ownerTelegramId: normalizedOwnerTelegramId }
      : {}),
    encryptedPrivateKey: encrypted.encryptedPrivateKey,
    wrappedDek: encrypted.wrappedDek,
    encryptionVersion: KMS_ENVELOPE_VERSION,
    createdAt: new Date().toISOString()
  };

  wallets.push(record);
  saveVault(wallets);

  return {
    label: record.label,
    address: record.address,
    ...(record.ownerTelegramId ? { ownerTelegramId: record.ownerTelegramId } : {}),
    encryptionVersion: record.encryptionVersion
  };
}

export async function listWallets(ownerTelegramId?: string) {
  const normalizedOwnerTelegramId = normalizeOwnerTelegramId(ownerTelegramId);

  return loadVault()
    .filter((wallet) => recordMatchesOwner(wallet, normalizedOwnerTelegramId))
    .map(toWalletSummary);
}

export async function listWalletsForOwner(ownerTelegramId: string) {
  const normalizedOwnerTelegramId = normalizeOwnerTelegramId(ownerTelegramId);

  if (!normalizedOwnerTelegramId) {
    throw new Error("Owner Telegram ID is required.");
  }

  return listWallets(normalizedOwnerTelegramId);
}

export async function getWalletAddressByLabelForOwner(
  label: string,
  ownerTelegramId: string
) {
  const normalizedOwnerTelegramId = normalizeOwnerTelegramId(ownerTelegramId);

  if (!normalizedOwnerTelegramId) {
    throw new Error("Owner Telegram ID is required.");
  }

  const record = findWalletRecordByLabel(label, normalizedOwnerTelegramId);
  return record.address;
}

export async function getWalletAddressByLabel(label: string) {
  const record = findWalletRecordByLabel(label);
  return record.address;
}

export async function getWalletSignerByLabelForOwner(
  label: string,
  ownerTelegramId: string,
  provider: ethers.Provider,
  action: string
) {
  const normalizedOwnerTelegramId = normalizeOwnerTelegramId(ownerTelegramId);

  if (!normalizedOwnerTelegramId) {
    throw new Error("Owner Telegram ID is required.");
  }

  const record = findWalletRecordByLabel(label, normalizedOwnerTelegramId);
  const encryptionVersion = getRecordEncryptionVersion(record);

  await appendWalletAuditLog({
    walletLabel: record.label,
    walletAddress: record.address,
    ownerTelegramId: record.ownerTelegramId || normalizedOwnerTelegramId,
    action,
    encryptionVersion
  });

  const privateKey = await decryptPrivateKeyForRecord(record);

  return new ethers.Wallet(privateKey, provider);
}

export async function getWalletSignerByLabel(
  label: string,
  provider: ethers.Provider,
  action: string
) {
  const record = findWalletRecordByLabel(label);
  const encryptionVersion = getRecordEncryptionVersion(record);

  await appendWalletAuditLog({
    walletLabel: record.label,
    walletAddress: record.address,
    ownerTelegramId: record.ownerTelegramId || null,
    action,
    encryptionVersion
  });

  const privateKey = await decryptPrivateKeyForRecord(record);

  return new ethers.Wallet(privateKey, provider);
}
