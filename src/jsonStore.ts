import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

type JsonUpdater<T> = (current: T) => T | Promise<T>;

const fileQueues = new Map<string, Promise<void>>();

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getSafeJsonError(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message
      .replace(/0x[a-fA-F0-9]{64}/g, "[REDACTED_HEX_SECRET]")
      .slice(0, 240);
  }

  return "Unknown JSON error";
}

function getCorruptBackupPath(filePath: string) {
  const dir = path.dirname(filePath);
  const parsed = path.parse(filePath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const candidate = path.join(
    dir,
    `${parsed.name}.corrupt-${timestamp}${parsed.ext || ".json"}`
  );

  if (!fs.existsSync(candidate)) {
    return candidate;
  }

  return path.join(
    dir,
    `${parsed.name}.corrupt-${timestamp}-${randomUUID()}${parsed.ext || ".json"}`
  );
}

function logJsonStoreWarning(message: string) {
  console.warn(`JSON store warning: ${message}`);
}

function backupCorruptJsonFile(filePath: string, reason: string) {
  const backupPath = getCorruptBackupPath(filePath);

  try {
    fs.renameSync(filePath, backupPath);
    logJsonStoreWarning(
      `moved malformed ${path.basename(filePath)} to ${path.basename(backupPath)} (${reason})`
    );
    return backupPath;
  } catch (error) {
    logJsonStoreWarning(
      `could not move malformed ${path.basename(filePath)} (${getSafeJsonError(error)})`
    );
    return null;
  }
}

function extractFirstJsonDocument(raw: string): string | null {
  const start = raw.search(/[{\[]/);

  if (start < 0) {
    return null;
  }

  const opener = raw[start];
  const closer = opener === "{" ? "}" : "]";
  const stack = [closer];
  let inString = false;
  let escaped = false;

  for (let index = start + 1; index < raw.length; index++) {
    const char = raw[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === "\"") {
        inString = false;
      }

      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }

    if (char === "}" || char === "]") {
      const expected = stack.pop();

      if (char !== expected) {
        return null;
      }

      if (stack.length === 0) {
        const candidate = raw.slice(start, index + 1);
        const rest = raw.slice(index + 1);
        return rest.trim() ? candidate : null;
      }
    }
  }

  return null;
}

function recoverFirstJsonDocument<T>(filePath: string, raw: string): T | null {
  const firstDocument = extractFirstJsonDocument(raw);

  if (!firstDocument) {
    return null;
  }

  try {
    return JSON.parse(firstDocument) as T;
  } catch {
    return null;
  }
}

export function safeJsonParse<T>(
  raw: string,
  fallback: T,
  options: { filePath?: string } = {}
): T {
  if (!raw.trim()) {
    return cloneJson(fallback);
  }

  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    if (options.filePath) {
      const recovered = recoverFirstJsonDocument<T>(options.filePath, raw);

      if (recovered) {
        backupCorruptJsonFile(options.filePath, getSafeJsonError(error));
        saveJsonFileAtomic(options.filePath, recovered);
        logJsonStoreWarning(
          `recovered first valid JSON document for ${path.basename(options.filePath)}`
        );
        return recovered;
      }

      backupCorruptJsonFile(options.filePath, getSafeJsonError(error));
      saveJsonFileAtomic(options.filePath, fallback);
      return cloneJson(fallback);
    }

    throw new Error(`Invalid JSON: ${getSafeJsonError(error)}`);
  }
}

export function loadJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) {
      return cloneJson(fallback);
    }

    const raw = fs.readFileSync(filePath, "utf8");
    return safeJsonParse(raw, fallback, { filePath });
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return cloneJson(fallback);
    }

    logJsonStoreWarning(
      `could not load ${path.basename(filePath)} (${getSafeJsonError(error)})`
    );
    return cloneJson(fallback);
  }
}

function fsyncDirectory(dir: string) {
  try {
    const dirFd = fs.openSync(dir, "r");

    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    // Directory fsync is best-effort and unsupported on some platforms.
  }
}

export function saveJsonFileAtomic<T>(filePath: string, data: T) {
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  const fd = fs.openSync(tmpPath, "w", 0o600);

  try {
    fs.writeFileSync(fd, serialized, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  fs.renameSync(tmpPath, filePath);
  fsyncDirectory(dir);
}

export function updateJsonFileSync<T>(
  filePath: string,
  fallback: T,
  updater: (current: T) => T
) {
  const current = loadJsonFile(filePath, fallback);
  const updated = updater(current);
  saveJsonFileAtomic(filePath, updated);
  return updated;
}

export async function updateJsonFile<T>(
  filePath: string,
  fallback: T,
  updater: JsonUpdater<T>
) {
  const resolvedPath = path.resolve(filePath);
  const previous = fileQueues.get(resolvedPath) || Promise.resolve();
  let result: T;

  const next = previous
    .catch(() => {
      // Keep the queue alive even if a previous update failed.
    })
    .then(async () => {
      const current = loadJsonFile(filePath, fallback);
      result = await updater(current);
      saveJsonFileAtomic(filePath, result);
    });

  const queued = next.finally(() => {
    if (fileQueues.get(resolvedPath) === queued) {
      fileQueues.delete(resolvedPath);
    }
  });

  fileQueues.set(resolvedPath, queued);

  await next;
  return result!;
}
