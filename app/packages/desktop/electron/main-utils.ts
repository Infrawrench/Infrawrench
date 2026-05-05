/**
 * Shared utilities for the Electron main process.
 * These functions are used by cloud-auth.ts and cloud-sync.ts.
 */
import { app } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

let _encryptionKey: Buffer | null = null;

export function getEncryptionKey(): Buffer {
  if (_encryptionKey) return _encryptionKey;
  const keyPath = path.join(app.getPath("userData"), "master.key");
  if (fs.existsSync(keyPath)) {
    _encryptionKey = Buffer.from(fs.readFileSync(keyPath, "utf8"), "base64");
  } else {
    _encryptionKey = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, _encryptionKey.toString("base64"), "utf8");
  }
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
