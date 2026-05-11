/**
 * Trust-on-first-use (TOFU) SSH host-key pinning.
 *
 * On the first connection to a given (host, port) we record the server's
 * host-key fingerprint. On subsequent connections we reject the handshake if
 * the fingerprint has changed — which would indicate a man-in-the-middle or
 * a rebuilt host that has not been re-pinned.
 *
 * TODO(security): pins are kept in an in-memory `Map` and reset every time
 * the process restarts (e.g. on deploy, crash, or instance autoscale). That
 * effectively reduces this to "trust any key after each restart" — a real
 * persistent store keyed by `(organization_id, host, port)` should be added
 * (e.g. an `ssh_host_keys` table) so a swapped key forces the operator to
 * acknowledge the change. See ssh.ts:hostVerifier for the call site.
 */
import * as crypto from "node:crypto";

export class HostKeyMismatchError extends Error {
  readonly host: string;
  readonly port: number;
  readonly storedFingerprint: string;
  readonly presentedFingerprint: string;

  constructor(host: string, port: number, stored: string, presented: string) {
    super(
      `SSH host key for ${host}:${port} changed (stored=${stored}, presented=${presented}). ` +
        `Refusing to connect — remove the pin to accept the new key.`,
    );
    this.name = "HostKeyMismatchError";
    this.host = host;
    this.port = port;
    this.storedFingerprint = stored;
    this.presentedFingerprint = presented;
  }
}

const pins = new Map<string, string>();

let warnedAboutVolatility = false;

function key(host: string, port: number): string {
  return `${host}:${port}`;
}

export function fingerprint(hostKey: Buffer): string {
  return (
    "SHA256:" + crypto.createHash("sha256").update(hostKey).digest("base64").replace(/=+$/, "")
  );
}

/**
 * Verify a presented host key for `(host, port)` against the in-memory pin.
 * Returns the (possibly new) stored fingerprint. Throws `HostKeyMismatchError`
 * on a mismatch.
 */
export function verifyOrPinHostKey(host: string, port: number, hostKey: Buffer): string {
  if (!warnedAboutVolatility) {
    warnedAboutVolatility = true;
    console.warn(
      "[ssh] SSH host-key pins are stored in memory and will be lost on process restart. " +
        "See app/packages/web/src/services/ssh-host-keys.ts for the TODO.",
    );
  }

  const fp = fingerprint(hostKey);
  const k = key(host, port);
  const existing = pins.get(k);
  if (existing === undefined) {
    pins.set(k, fp);
    return fp;
  }
  if (existing !== fp) {
    throw new HostKeyMismatchError(host, port, existing, fp);
  }
  return existing;
}

/** Test/debug helper — clears the in-memory pin store. */
export function _resetHostKeyPinsForTests(): void {
  pins.clear();
}
