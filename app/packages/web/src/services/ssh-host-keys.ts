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
import { sha256Fingerprint } from "@infrawrench/ssh-tunnel-core";
import { v4 as uuid } from "uuid";
import { and, eq } from "drizzle-orm";
import type { ConnectConfig } from "ssh2";
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

/**
 * Read-only check: compare a presented host key against the persisted pin.
 * Never writes. Throws `HostKeyTrustRequiredError` when the host is unknown
 * or when the key has changed.
 */
async function verifyHostKey(
  orgId: string,
  host: string,
  port: number,
  hostKey: Buffer,
): Promise<string> {
  const fp = sha256Fingerprint(hostKey);

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

/**
 * Build an ssh2 `hostVerifier` that routes the presented key through
 * `verifyHostKey`. On a trust failure, stores the typed error on
 * `errorRef.value` so the caller can re-throw it instead of the generic ssh2
 * connect error. `tag` is the log prefix (e.g. `"ssh"`, `"sftp"`).
 */
export function makeHostKeyVerifier(
  organizationId: string,
  host: string,
  port: number,
  errorRef: { value: HostKeyTrustRequiredError | null },
  tag: string,
): (hostKey: Buffer, verify: (valid: boolean) => void) => void {
  return (hostKey, verify) => {
    verifyHostKey(organizationId, host, port, hostKey).then(
      () => verify(true),
      (e: unknown) => {
        if (e instanceof HostKeyTrustRequiredError) {
          console.warn(
            `[${tag}] host key ${e.kind} for ${e.host}:${e.port} ` +
              `(stored=${e.storedFingerprint ?? "(none)"}, presented=${e.presentedFingerprint})`,
          );
          errorRef.value = e;
        }
        verify(false);
      },
    );
  };
}

/**
 * `configureConnect` callback factory for use with `@infrawrench/ssh-tunnel-core`
 * and `@infrawrench/sftp-host`. Installs the `makeHostKeyVerifier` on top of
 * whatever options ssh2 was about to use.
 */
export function makeHostKeyConfigureConnect(
  organizationId: string,
  errorRef: { value: HostKeyTrustRequiredError | null },
  tag: string,
): (opts: ConnectConfig) => ConnectConfig {
  return (opts) => ({
    ...opts,
    hostVerifier: makeHostKeyVerifier(
      organizationId,
      opts.host ?? "localhost",
      opts.port ?? 22,
      errorRef,
      tag,
    ),
  });
}
