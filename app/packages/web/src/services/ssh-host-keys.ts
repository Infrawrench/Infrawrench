/**
 * SSH host-key pinning with explicit user consent.
 *
 * Pins are persisted per (organization, host, port) in the `ssh_host_keys`
 * Postgres table. Unlike the older TOFU-on-first-use behavior, we do NOT
 * auto-pin: connecting to an unknown host throws `HostKeyTrustRequiredError`,
 * which the API surfaces as a 409 so the caller can prompt the operator and
 * call `trustHostKey()` to record the decision before retrying.
 *
 * A swapped key on a known host throws `HostKeyMismatchError` (a subclass of
 * `HostKeyTrustRequiredError`) with both the stored and presented
 * fingerprints — the operator can compare them and explicitly accept the new
 * key.
 */
import * as crypto from "node:crypto";
import { v4 as uuid } from "uuid";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { sshHostKeys } from "../db/schema";

/**
 * Thrown when an SSH connection cannot proceed because the host's key has not
 * been trusted (or no longer matches a previously-trusted key). Routes
 * translate this to a 409 with a structured body so the client can prompt the
 * user and call the trust endpoint.
 */
export class HostKeyTrustRequiredError extends Error {
  readonly host: string;
  readonly port: number;
  readonly kind: "unknown" | "mismatch";
  readonly presentedFingerprint: string;
  readonly storedFingerprint: string | null;

  constructor(
    host: string,
    port: number,
    kind: "unknown" | "mismatch",
    presentedFingerprint: string,
    storedFingerprint: string | null,
  ) {
    super(
      kind === "unknown"
        ? `SSH host ${host}:${port} has not been trusted yet (fingerprint=${presentedFingerprint}).`
        : `SSH host key for ${host}:${port} changed (stored=${storedFingerprint}, presented=${presentedFingerprint}). Confirm the new key before connecting.`,
    );
    this.name = "HostKeyTrustRequiredError";
    this.host = host;
    this.port = port;
    this.kind = kind;
    this.presentedFingerprint = presentedFingerprint;
    this.storedFingerprint = storedFingerprint;
  }
}

/**
 * Kept as a subclass of `HostKeyTrustRequiredError` (kind="mismatch") so
 * existing handlers that branch on `instanceof HostKeyMismatchError` keep
 * working, while the new flow can treat both cases uniformly.
 */
export class HostKeyMismatchError extends HostKeyTrustRequiredError {
  constructor(host: string, port: number, stored: string, presented: string) {
    super(host, port, "mismatch", presented, stored);
    this.name = "HostKeyMismatchError";
  }
}

export function fingerprint(hostKey: Buffer): string {
  return (
    "SHA256:" + crypto.createHash("sha256").update(hostKey).digest("base64").replace(/=+$/, "")
  );
}

/**
 * Read-only check: compare a presented host key against the persisted pin.
 * Never writes. Throws `HostKeyTrustRequiredError` when the host is unknown
 * or when the key has changed.
 */
export async function verifyHostKey(
  orgId: string,
  host: string,
  port: number,
  hostKey: Buffer,
): Promise<string> {
  const fp = fingerprint(hostKey);

  const [existing] = await db
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

  if (!existing) {
    throw new HostKeyTrustRequiredError(host, port, "unknown", fp, null);
  }
  if (existing.fingerprint !== fp) {
    throw new HostKeyMismatchError(host, port, existing.fingerprint, fp);
  }
  return existing.fingerprint;
}

/**
 * Record (or replace) a pin after the user has explicitly accepted the
 * presented fingerprint. Idempotent — re-pinning the same fingerprint is a
 * no-op; pinning a different fingerprint replaces the existing row.
 */
export async function trustHostKey(
  orgId: string,
  host: string,
  port: number,
  presentedFingerprint: string,
): Promise<void> {
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
        fingerprint: presentedFingerprint,
      });
    } catch {
      // Concurrent insert — re-read and check fingerprint matches.
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
      if (raced && raced.fingerprint !== presentedFingerprint) {
        throw new HostKeyMismatchError(host, port, raced.fingerprint, presentedFingerprint);
      }
    }
    return;
  }

  if (existing.fingerprint === presentedFingerprint) return;
  await db
    .update(sshHostKeys)
    .set({ fingerprint: presentedFingerprint })
    .where(eq(sshHostKeys.id, existing.id));
}
