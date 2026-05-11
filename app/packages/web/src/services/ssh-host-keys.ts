/**
 * Trust-on-first-use (TOFU) SSH host-key pinning.
 *
 * On the first connection to a given (organization, host, port) we record the
 * server's host-key fingerprint in the `ssh_host_keys` Postgres table. On
 * subsequent connections we reject the handshake if the fingerprint has
 * changed — which would indicate a man-in-the-middle or a rebuilt host that
 * has not been re-pinned.
 *
 * Pins are persisted across process restarts so a swapped key forces the
 * operator to acknowledge the change (by deleting the row) rather than being
 * silently re-trusted on the next deploy.
 */
import * as crypto from "node:crypto";
import { v4 as uuid } from "uuid";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { sshHostKeys } from "../db/schema";

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

export function fingerprint(hostKey: Buffer): string {
  return (
    "SHA256:" + crypto.createHash("sha256").update(hostKey).digest("base64").replace(/=+$/, "")
  );
}

/**
 * Verify a presented host key for `(orgId, host, port)` against the persisted
 * pin. If no pin exists, record one (TOFU) and return the new fingerprint.
 * Throws `HostKeyMismatchError` on a mismatch.
 */
export async function verifyOrPinHostKey(
  orgId: string,
  host: string,
  port: number,
  hostKey: Buffer,
): Promise<string> {
  const fp = fingerprint(hostKey);

  const [existing] = await db
    .select({ id: sshHostKeys.id, fingerprint: sshHostKeys.fingerprint })
    .from(sshHostKeys)
    .where(
      and(
        eq(sshHostKeys.organizationId, orgId),
        eq(sshHostKeys.host, host),
        eq(sshHostKeys.port, port),
      ),
    )
    .limit(1);

  if (!existing) {
    try {
      await db.insert(sshHostKeys).values({
        id: uuid(),
        organizationId: orgId,
        host,
        port,
        fingerprint: fp,
      });
    } catch {
      // A concurrent connection may have inserted the same pin first. Re-read
      // and treat as if we found it on the first lookup.
      const [raced] = await db
        .select({ fingerprint: sshHostKeys.fingerprint })
        .from(sshHostKeys)
        .where(
          and(
            eq(sshHostKeys.organizationId, orgId),
            eq(sshHostKeys.host, host),
            eq(sshHostKeys.port, port),
          ),
        )
        .limit(1);
      if (raced && raced.fingerprint !== fp) {
        throw new HostKeyMismatchError(host, port, raced.fingerprint, fp);
      }
    }
    return fp;
  }

  if (existing.fingerprint !== fp) {
    throw new HostKeyMismatchError(host, port, existing.fingerprint, fp);
  }
  return existing.fingerprint;
}
