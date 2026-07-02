import fs from "fs/promises";
import path from "path";

type WalletAuditEvent = {
  walletLabel: string;
  walletAddress: string;
  ownerTelegramId: string | null;
  action: string;
  timestamp: string;
  encryptionVersion: string;
};

type WalletAuditLog = {
  events: WalletAuditEvent[];
};

const KMS_AUDIT_LOG_PATH = path.join(process.cwd(), "data", "kmsAuditLog.json");

async function loadAuditLog(): Promise<WalletAuditLog> {
  try {
    const raw = await fs.readFile(KMS_AUDIT_LOG_PATH, "utf8");

    if (!raw.trim()) {
      return { events: [] };
    }

    const parsed = JSON.parse(raw);

    return {
      events: Array.isArray(parsed.events) ? parsed.events : []
    };
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return { events: [] };
    }

    throw error;
  }
}

export async function appendWalletAuditLog(
  event: Omit<WalletAuditEvent, "timestamp">
) {
  const auditLog = await loadAuditLog();

  auditLog.events.push({
    ...event,
    timestamp: new Date().toISOString()
  });

  await fs.mkdir(path.dirname(KMS_AUDIT_LOG_PATH), { recursive: true });
  await fs.writeFile(
    KMS_AUDIT_LOG_PATH,
    JSON.stringify(auditLog, null, 2),
    "utf8"
  );
}
