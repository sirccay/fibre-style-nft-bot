import "dotenv/config";
import { ClientSecretCredential } from "@azure/identity";
import {
  CryptographyClient,
  type KeyWrapAlgorithm
} from "@azure/keyvault-keys";

export const KMS_PROVIDER = "azure-key-vault" as const;

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing ${name} in .env.`);
  }

  return value;
}

function getAzureKeyVaultUrl(): string {
  return getRequiredEnv("AZURE_KEY_VAULT_URL").replace(/\/+$/, "");
}

function getAzureKeyName(): string {
  return getRequiredEnv("AZURE_KEY_NAME");
}

function getAzureWrapAlgorithm(): KeyWrapAlgorithm {
  return (process.env.AZURE_KEY_WRAP_ALGORITHM?.trim() ||
    "RSA-OAEP-256") as KeyWrapAlgorithm;
}

function getAzureCredential() {
  return new ClientSecretCredential(
    getRequiredEnv("AZURE_TENANT_ID"),
    getRequiredEnv("AZURE_CLIENT_ID"),
    getRequiredEnv("AZURE_CLIENT_SECRET")
  );
}

function getAzureCryptographyClient() {
  return new CryptographyClient(getKmsKeyRef(), getAzureCredential());
}

export function getKmsKeyRef(): string {
  return `${getAzureKeyVaultUrl()}/keys/${getAzureKeyName()}`;
}

export async function wrapDek(plaintextDek: Buffer): Promise<string> {
  const client = getAzureCryptographyClient();
  const result = await client.wrapKey(getAzureWrapAlgorithm(), plaintextDek);

  return Buffer.from(result.result).toString("base64");
}

export async function unwrapDek(wrappedDek: string): Promise<Buffer> {
  const client = getAzureCryptographyClient();
  const result = await client.unwrapKey(
    getAzureWrapAlgorithm(),
    Buffer.from(wrappedDek, "base64")
  );

  return Buffer.from(result.result);
}
