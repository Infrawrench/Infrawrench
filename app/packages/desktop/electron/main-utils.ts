import { app, safeStorage } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

let _encryptionKey: Buffer | null = null;

// master.key       — legacy plaintext base64 (older installs)
// master.key.enc   — base64 of safeStorage.encryptString(rawKeyB64)
// Reads prefer .enc and opportunistically upgrade a legacy plaintext file.
const LEGACY_KEY_FILENAME = "master.key";
const ENCRYPTED_KEY_FILENAME = "master.key.enc";

function readKeyFromDisk(): Buffer | null {
  const userData = app.getPath("userData");
  const encPath = path.join(userData, ENCRYPTED_KEY_FILENAME);
  const legacyPath = path.join(userData, LEGACY_KEY_FILENAME);

  if (fs.existsSync(encPath) && safeStorage.isEncryptionAvailable()) {
    try {
      const blob = Buffer.from(fs.readFileSync(encPath, "utf8"), "base64");
      const rawB64 = safeStorage.decryptString(blob);
      return Buffer.from(rawB64, "base64");
    } catch (e) {
      console.warn("[main-utils] Failed to decrypt master.key.enc; falling back:", e);
    }
  }

  if (fs.existsSync(legacyPath)) {
    const raw = Buffer.from(fs.readFileSync(legacyPath, "utf8"), "base64");
    if (safeStorage.isEncryptionAvailable()) {
      try {
        writeKeyToDisk(raw);
        try {
          fs.unlinkSync(legacyPath);
        } catch {
          /* best-effort cleanup */
        }
      } catch (e) {
        console.warn("[main-utils] Failed to upgrade master.key to safeStorage:", e);
      }
    } else {
      // No safeStorage available — tighten perms on the plaintext file in place.
      try {
        fs.chmodSync(legacyPath, 0o600);
      } catch {
        /* ignore */
      }
    }
    return raw;
  }

  return null;
}

function writeKeyToDisk(rawKey: Buffer): void {
  const userData = app.getPath("userData");
  fs.mkdirSync(userData, { recursive: true });

  if (safeStorage.isEncryptionAvailable()) {
    const encPath = path.join(userData, ENCRYPTED_KEY_FILENAME);
    const blob = safeStorage.encryptString(rawKey.toString("base64"));
    fs.writeFileSync(encPath, blob.toString("base64"), { encoding: "utf8", mode: 0o600 });
    try {
      fs.chmodSync(encPath, 0o600);
    } catch {
      /* windows: chmod is a no-op */
    }
    return;
  }

  // Linux without keyring: fall back to 0o600 plaintext.
  const legacyPath = path.join(userData, LEGACY_KEY_FILENAME);
  fs.writeFileSync(legacyPath, rawKey.toString("base64"), { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(legacyPath, 0o600);
  } catch {
    /* ignore */
  }
}

/**
 * When true, a missing or unreadable master key is a hard error instead of a
 * reason to mint a new one.
 *
 * Minting is only ever correct on a fresh install. Every other time the key
 * fails to load — a locked keychain, a headless session safeStorage can't
 * reach, a profile opened by a differently-signed build — the old key was
 * still there and a new one silently orphans every encrypted row: accounts,
 * secret fields, cloud tokens. The GUI runs after the keychain is unlocked
 * and owns first-run setup, so it keeps the minting behaviour; the CLI turns
 * this on (see electron/cli/main.ts) and reports the failure instead.
 */
let _requireExistingKey = false;

export function setRequireExistingEncryptionKey(required: boolean): void {
  _requireExistingKey = required;
}

/**
 * A failure the user caused and can fix — a typo'd flag, a locked keychain, an
 * account that isn't there. Hosts render `.message` on its own: the CLI prints
 * it without a stack trace, the GUI can put it straight in a toast. Anything
 * not marked this way is a bug and keeps its stack.
 */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

/** Thrown instead of minting a key. The CLI prints it without a stack trace. */
class MasterKeyUnavailableError extends UserFacingError {
  constructor() {
    super(
      "Could not read this workspace's master key. Nothing was changed — a new key would " +
        "make every stored credential unreadable. Unlock your login keychain (or open the " +
        "desktop app once) and try again.",
    );
    this.name = "MasterKeyUnavailableError";
  }
}

export function getEncryptionKey(): Buffer {
  if (_encryptionKey) return _encryptionKey;
  const existing = readKeyFromDisk();
  if (existing) {
    _encryptionKey = existing;
    return _encryptionKey;
  }
  if (_requireExistingKey) throw new MasterKeyUnavailableError();
  _encryptionKey = crypto.randomBytes(32);
  writeKeyToDisk(_encryptionKey);
  return _encryptionKey;
}

// Mirrors `server-core/src/encryption.ts` so desktop and web stay AAD-compatible.
export function buildAad(resourceType: string, resourceId: string, fieldName: string): string {
  return `${resourceType}:${resourceId}:${fieldName}`;
}

const V2_PREFIX = "v2:";

// With `aad`: emits `v2:<base64>`, AAD-bound (server-core wire format).
// Without `aad`: emits the legacy unprefixed v1 format (cloud-auth tokens,
// pre-existing rows).
export function encryptValue(
  plaintext: string,
  key: Buffer,
  aad?: string | Buffer,
): { ciphertext: string; iv: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  if (aad != null) {
    cipher.setAAD(Buffer.isBuffer(aad) ? aad : Buffer.from(aad, "utf8"));
  }
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([encrypted, tag]).toString("base64");
  return {
    ciphertext: aad != null ? V2_PREFIX + payload : payload,
    iv: iv.toString("base64"),
  };
}

// `v2:<base64>` requires the same AAD; bare `<base64>` (v1) ignores AAD for
// back-compat with rows written before AAD existed.
export function decryptValue(
  ciphertext: string,
  ivBase64: string,
  key: Buffer,
  aad?: string | Buffer,
): string {
  const iv = Buffer.from(ivBase64, "base64");
  let payload: Buffer;
  let isV2: boolean;
  if (ciphertext.startsWith(V2_PREFIX)) {
    payload = Buffer.from(ciphertext.slice(V2_PREFIX.length), "base64");
    isV2 = true;
  } else {
    payload = Buffer.from(ciphertext, "base64");
    isV2 = false;
  }
  const tag = payload.subarray(-16);
  const encrypted = payload.subarray(0, -16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  if (isV2) {
    if (aad == null) {
      throw new Error("AAD is required to decrypt v2 ciphertext");
    }
    decipher.setAAD(Buffer.isBuffer(aad) ? aad : Buffer.from(aad, "utf8"));
  }
  decipher.setAuthTag(tag);
  return decipher.update(encrypted).toString("utf8") + decipher.final("utf8");
}

// Lazy DB getter — main.ts sets this once the SQLite database is initialized,
// avoiding a circular import.
let _getDb:
  | (() => Promise<{
      select: <T>(sql: string, params?: unknown[]) => Promise<T>;
      execute: (sql: string, params?: unknown[]) => Promise<void>;
    }>)
  | null = null;

export function setDbGetter(fn: typeof _getDb): void {
  _getDb = fn;
}

export async function getDb() {
  if (!_getDb) throw new Error("DB getter not initialized");
  return _getDb();
}

// Dialog-blessed paths. Renderer-initiated file reads/writes (sftp_download,
// sftp_upload, storage_download_batch) must supply a path that the user just
// picked via showOpenDialog / showSaveDialog. main.ts registers returned paths
// here; consumers check `isDialogBlessedPath(p)` before touching the FS.

const BLESSED_PATHS = new Set<string>();
const BLESSED_TTL_MS = 60 * 60 * 1000;

interface BlessedEntry {
  path: string;
  expiresAt: number;
}
const BLESSED_LIST: BlessedEntry[] = [];

function pruneBlessed(): void {
  const now = Date.now();
  for (let i = BLESSED_LIST.length - 1; i >= 0; i--) {
    if (BLESSED_LIST[i]!.expiresAt < now) {
      BLESSED_PATHS.delete(BLESSED_LIST[i]!.path);
      BLESSED_LIST.splice(i, 1);
    }
  }
}

export function registerDialogBlessedPath(p: string): void {
  pruneBlessed();
  const resolved = path.resolve(p);
  BLESSED_PATHS.add(resolved);
  BLESSED_LIST.push({ path: resolved, expiresAt: Date.now() + BLESSED_TTL_MS });
}

// Matches an exact blessed path or one beneath a blessed directory.
export function isDialogBlessedPath(p: string): boolean {
  pruneBlessed();
  const resolved = path.resolve(p);
  if (BLESSED_PATHS.has(resolved)) return true;
  for (const blessed of BLESSED_PATHS) {
    const prefix = blessed.endsWith(path.sep) ? blessed : blessed + path.sep;
    if (resolved.startsWith(prefix)) return true;
  }
  return false;
}
