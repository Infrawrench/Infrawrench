/**
 * Shared utilities for the Electron main process.
 * These functions are used by main.ts, cloud-auth.ts and cloud-sync.ts.
 */
import { app, safeStorage } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

let _encryptionKey: Buffer | null = null;

// File names for the on-disk master key.
//   master.key       — legacy plaintext base64 (older installs)
//   master.key.enc   — base64 of safeStorage.encryptString(rawKeyB64)
//
// On read we prefer the encrypted form. If only the legacy plaintext key
// exists, we read it and (when safeStorage is available) re-write it as
// `master.key.enc` then unlink the plaintext file.
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
    // Upgrade to safeStorage-encrypted form when possible, then drop the plaintext file.
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
      // No safeStorage — at least tighten file perms in place.
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

  // safeStorage unavailable (Linux without keyring): fall back to 0o600 plaintext.
  const legacyPath = path.join(userData, LEGACY_KEY_FILENAME);
  fs.writeFileSync(legacyPath, rawKey.toString("base64"), { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(legacyPath, 0o600);
  } catch {
    /* ignore */
  }
}

export function getEncryptionKey(): Buffer {
  if (_encryptionKey) return _encryptionKey;
  const existing = readKeyFromDisk();
  if (existing) {
    _encryptionKey = existing;
    return _encryptionKey;
  }
  _encryptionKey = crypto.randomBytes(32);
  writeKeyToDisk(_encryptionKey);
  return _encryptionKey;
}

export function encryptValue(plaintext: string, key: Buffer): { ciphertext: string; iv: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([encrypted, tag]).toString("base64"),
    iv: iv.toString("base64"),
  };
}

export function decryptValue(ciphertext: string, ivBase64: string, key: Buffer): string {
  const data = Buffer.from(ciphertext, "base64");
  const iv = Buffer.from(ivBase64, "base64");
  const tag = data.subarray(-16);
  const encrypted = data.subarray(0, -16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted).toString("utf8") + decipher.final("utf8");
}

// Re-export getDb. This lazy-requires to avoid circular import issues since
// the DB is initialized in main.ts. At call time main.ts will have already set it up.
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

// ---------------------------------------------------------------------------
// Dialog-blessed paths. Local file reads/writes initiated by the renderer
// (sftp_download, sftp_upload, storage_download_batch destinations) must
// supply a path that the user just picked via showOpenDialog / showSaveDialog.
// main.ts registers paths returned from those dialogs here; consumers check
// `isDialogBlessedPath(p)` before touching the filesystem.
// ---------------------------------------------------------------------------

const BLESSED_PATHS = new Set<string>();
const BLESSED_TTL_MS = 60 * 60 * 1000; // one hour

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

/**
 * Returns true when the given local path either exactly matches a previously
 * dialog-returned path, or sits beneath a dialog-returned directory.
 */
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
