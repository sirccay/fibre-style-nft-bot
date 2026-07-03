import fs from "fs/promises";
import path from "path";

type WalletAuditEvent = {
  walletLabel?: string;
  walletAddress?: string;
  ownerTelegramId: string | null;
  action: string;
  timestamp: string;
  encryptionVersion?: string;
  importedCount?: number;
  skippedCount?: number;
  network?: string;
  newWalletLabel?: string;
  sessionId?: string;
  status?: string;
  collectionSlug?: string;
  contractAddress?: string;
  tokenId?: string;
  priceEth?: number;
  targetId?: string;
  jobId?: string;
  runId?: string;
  chain?: string;
  functionSignature?: string;
  quantity?: number;
  mintType?: string;
  candidateFunctions?: string[];
  phaseStatus?: string;
  phaseTypeEstimate?: string;
  phaseTypeConfidence?: string;
  txHash?: string;
  reason?: string;
};

type WalletAuditLog = {
  events: WalletAuditEvent[];
};

type SessionAuditEvent = {
  sessionId: string;
  ownerTelegramId: string | null;
  actorTelegramId: string | null;
  walletLabel?: string;
  walletAddress?: string;
  collectionSlug?: string;
  contractAddress?: string;
  tokenId?: string;
  priceEth?: number;
  targetId?: string;
  jobId?: string;
  runId?: string;
  chain?: string;
  functionSignature?: string;
  quantity?: number;
  mintType?: string;
  candidateFunctions?: string[];
  phaseStatus?: string;
  phaseTypeEstimate?: string;
  phaseTypeConfidence?: string;
  txHash?: string;
  action: string;
  status?: string;
  reason?: string;
  timestamp: string;
};

type SessionAuditLog = {
  events: SessionAuditEvent[];
};

const KMS_AUDIT_LOG_PATH = path.join(process.cwd(), "data", "kmsAuditLog.json");
const SESSION_AUDIT_LOG_PATH = path.join(
  process.cwd(),
  "data",
  "sessionAuditLog.json"
);

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

async function loadSessionAuditLog(): Promise<SessionAuditLog> {
  try {
    const raw = await fs.readFile(SESSION_AUDIT_LOG_PATH, "utf8");

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

export async function appendSessionAuditLog(
  event: Omit<SessionAuditEvent, "timestamp">
) {
  const auditLog = await loadSessionAuditLog();

  auditLog.events.push({
    ...event,
    timestamp: new Date().toISOString()
  });

  await fs.mkdir(path.dirname(SESSION_AUDIT_LOG_PATH), { recursive: true });
  await fs.writeFile(
    SESSION_AUDIT_LOG_PATH,
    JSON.stringify(auditLog, null, 2),
    "utf8"
  );
}
