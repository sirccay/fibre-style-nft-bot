import path from "path";
import { updateJsonFile } from "./jsonStore.js";

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
  multiMintJobId?: string;
  runId?: string;
  chain?: string;
  functionSignature?: string;
  quantity?: number;
  mintType?: string;
  gasStrategyMode?: string;
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
  multiMintJobId?: string;
  runId?: string;
  chain?: string;
  functionSignature?: string;
  quantity?: number;
  mintType?: string;
  gasStrategyMode?: string;
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
const EMPTY_WALLET_AUDIT_LOG: WalletAuditLog = { events: [] };
const EMPTY_SESSION_AUDIT_LOG: SessionAuditLog = { events: [] };

export async function appendWalletAuditLog(
  event: Omit<WalletAuditEvent, "timestamp">
) {
  await updateJsonFile<WalletAuditLog>(
    KMS_AUDIT_LOG_PATH,
    EMPTY_WALLET_AUDIT_LOG,
    (auditLog) => ({
      events: [
        ...(Array.isArray(auditLog.events) ? auditLog.events : []),
        {
          ...event,
          timestamp: new Date().toISOString()
        }
      ]
    })
  );
}

export async function appendSessionAuditLog(
  event: Omit<SessionAuditEvent, "timestamp">
) {
  await updateJsonFile<SessionAuditLog>(
    SESSION_AUDIT_LOG_PATH,
    EMPTY_SESSION_AUDIT_LOG,
    (auditLog) => ({
      events: [
        ...(Array.isArray(auditLog.events) ? auditLog.events : []),
        {
          ...event,
          timestamp: new Date().toISOString()
        }
      ]
    })
  );
}
