import "dotenv/config";
import { input, password } from "@inquirer/prompts";
import { addWallet } from "./vault.js";

function getSafeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  const secret = process.env.AZURE_CLIENT_SECRET;

  if (secret && secret.length >= 8) {
    return message
      .split(secret)
      .join("[REDACTED]")
      .replace(/0x[a-fA-F0-9]{64}/g, "[REDACTED_HEX_SECRET]");
  }

  return message.replace(/0x[a-fA-F0-9]{64}/g, "[REDACTED_HEX_SECRET]");
}

async function main() {
  console.log("\n🔐 Add wallet to encrypted vault");
  console.log("Use only a fresh burner wallet for this bot.\n");

  const label = await input({
    message: "Wallet label/name, example wallet1:"
  });

  const ownerTelegramId = await input({
    message: "Owner Telegram user ID:",
    default: process.env.ADMIN_TELEGRAM_ID,
    validate: (value) =>
      value.trim() ? true : "Owner Telegram user ID is required."
  });

  const privateKey = await password({
    message: "Paste private key. It will be hidden while typing:",
    mask: "*"
  });

  const saved = await addWallet(label, privateKey, ownerTelegramId);

  console.log("\n✅ Wallet added successfully.");
  console.log(`Label: ${saved.label}`);
  console.log(`Address: ${saved.address}`);
  console.log(`Owner Telegram ID: ${saved.ownerTelegramId}`);
  console.log("\nPrivate key was encrypted with Azure Key Vault envelope encryption into data/vault.json");
}

main().catch((error) => {
  console.error("\n❌ Failed to add wallet:");
  console.error(getSafeErrorMessage(error));
  process.exit(1);
});
