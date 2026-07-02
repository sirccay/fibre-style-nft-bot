import "dotenv/config";
import { input, password } from "@inquirer/prompts";
import { addWallet } from "./vault.js";

async function main() {
  console.log("\n🔐 Add wallet to encrypted vault");
  console.log("Use only a fresh burner wallet for this bot.\n");

  const label = await input({
    message: "Wallet label/name, example wallet1:"
  });

  const privateKey = await password({
    message: "Paste private key. It will be hidden while typing:",
    mask: "*"
  });

  const saved = await addWallet(label, privateKey);

  console.log("\n✅ Wallet added successfully.");
  console.log(`Label: ${saved.label}`);
  console.log(`Address: ${saved.address}`);
  console.log("\nPrivate key was encrypted with AWS KMS envelope encryption into data/vault.json");
}

main().catch((error) => {
  console.error("\n❌ Failed to add wallet:");
  console.error(error instanceof Error ? error.message : "Unknown error");
  process.exit(1);
});
