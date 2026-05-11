/**
 * Trust-on-first-use (TOFU) SSH host-key pinning for the desktop app.
 *
 * Pins are persisted in the local sql.js DB (`ssh_host_keys` table). On the
 * first connection to a (host, port) we record the server's host-key
 * fingerprint. On subsequent connections we reject the handshake if the
 * fingerprint has changed.
 *
 * In-flight handshakes happen synchronously inside ssh2's `hostVerifier`
 * callback, so this module keeps an in-memory mirror of the table and
 * refreshes it asynchronously around each connect.
 */
import * as crypto from "node:crypto";
import { getDb } from "./main-utils";
import { promptHostKeyDecision } from "./ssh-host-key-prompt";

export class HostKeyMismatchError extends Error {
  readonly host: string;
  readonly port: number;
  readonly storedFingerprint: string;
  readonly presentedFingerprint: string;

  constructor(host: string, port: number, stored: string, presented: string) {
    super(
      `SSH host key for ${host}:${port} changed (stored=${stored}, presented=${presented}). ` +
        `Refusing to connect — delete the pin in ssh_host_keys to accept the new key.`,
    );
    this.name = "HostKeyMismatchError";
    this.host = host;
    this.port = port;
    this.storedFingerprint = stored;
    this.presentedFingerprint = presented;
  }
}

type HostKeyRow = { id: string; host: string; port: number; fingerprint: string };

const cache = new Map<string, string>();
let cacheLoaded = false;

function cacheKey(host: string, port: number): string {
  return `${host}:${port}`;
}

export function fingerprint(hostKey: Buffer): string {
  return (
    "SHA256:" + crypto.createHash("sha256").update(hostKey).digest("base64").replace(/=+$/, "")
  );
}

/** Hydrate the in-memory cache from sql.js. Safe to call repeatedly. */
export async function loadHostKeyPins(): Promise<void> {
  const db = await getDb();
  const rows = await db.select<HostKeyRow[]>(
    `SELECT id, host, port, fingerprint FROM ssh_host_keys`,
  );
  cache.clear();
  for (const row of rows) {
    cache.set(cacheKey(row.host, row.port), row.fingerprint);
  }
  cacheLoaded = true;
}

async function ensureCacheLoaded(): Promise<void> {
  if (!cacheLoaded) await loadHostKeyPins();
}

async function persistPin(host: string, port: number, fp: string): Promise<void> {
  const db = await getDb();
  // sql.js doesn't expose ON CONFLICT cleanly through normalizeSql, so do
  // delete-then-insert (UNIQUE(host, port) keeps it consistent).
  await db.execute(`DELETE FROM ssh_host_keys WHERE host = ? AND port = ?`, [host, port]);
  await db.execute(`INSERT INTO ssh_host_keys (id, host, port, fingerprint) VALUES (?, ?, ?, ?)`, [
    crypto.randomUUID(),
    host,
    port,
    fp,
  ]);
}

/** Call before initiating an SSH handshake so the verifier can run. */
export async function ensureHostKeyCacheLoaded(): Promise<void> {
  await ensureCacheLoaded();
}

/**
 * Async verifier suitable for ssh2's HostVerifier callback form. Prompts the
 * user (via the renderer) when the host is unknown or the key changed.
 *
 * - Match → ok (no prompt).
 * - Unknown host → prompt; on accept persist the pin, on deny reject.
 * - Mismatch → prompt with both fingerprints; on accept replace the pin,
 *   on deny reject and bubble a `HostKeyMismatchError`.
 */
export async function verifyOrPinHostKeyInteractive(
  host: string,
  port: number,
  hostKey: Buffer,
): Promise<{ ok: true; fingerprint: string } | { ok: false; error: HostKeyMismatchError }> {
  await ensureCacheLoaded();
  const fp = fingerprint(hostKey);
  const existing = cache.get(cacheKey(host, port));

  if (existing === fp) {
    return { ok: true, fingerprint: fp };
  }

  if (existing === undefined) {
    const accepted = await promptHostKeyDecision({
      host,
      port,
      kind: "first-connect",
      presentedFingerprint: fp,
    });
    if (!accepted) {
      // Synthesize a mismatch-style error so the connecting code can surface
      // a useful message ("connection denied by user") instead of the
      // generic ssh2 auth-failed message.
      return {
        ok: false,
        error: new HostKeyMismatchError(host, port, "(none)", fp),
      };
    }
    cache.set(cacheKey(host, port), fp);
    void persistPin(host, port, fp).catch((e) => {
      console.warn("[ssh] failed to persist host-key pin:", e);
    });
    return { ok: true, fingerprint: fp };
  }

  // Mismatch — prompt with both fingerprints so the user can compare.
  const accepted = await promptHostKeyDecision({
    host,
    port,
    kind: "mismatch",
    presentedFingerprint: fp,
    storedFingerprint: existing,
  });
  if (!accepted) {
    return {
      ok: false,
      error: new HostKeyMismatchError(host, port, existing, fp),
    };
  }
  cache.set(cacheKey(host, port), fp);
  void persistPin(host, port, fp).catch((e) => {
    console.warn("[ssh] failed to persist replacement host-key pin:", e);
  });
  return { ok: true, fingerprint: fp };
}
