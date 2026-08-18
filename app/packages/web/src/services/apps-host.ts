/**
 * Opening the SSH connection a Linux-application host is reached on.
 *
 * Extracted from `apps-proxy.ts` because the setup check needs the *same*
 * connection on the same terms — the org's own key, `resolveSafeHost` before
 * anything is dialled, and the trust-on-first-use host-key pin — and a second
 * implementation of that would be the one place a changed host key goes
 * unnoticed.
 */

import ssh2 from "ssh2";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { sshKeys } from "@/db/schema";
import { buildAad, decrypt } from "@/services/encryption";
import { resolveSafeHost } from "@/services/host-validation";
import { HostKeyTrustRequiredError, makeHostKeyVerifier } from "@/services/ssh-host-keys";

const { Client } = ssh2;
export type AppsClient = InstanceType<typeof Client>;

export interface AppsHostTarget {
  organizationId: string;
  /** Org-managed key the host trusts. Its private half never leaves the server. */
  sshKeyId: string;
  host: string;
  username: string;
  port?: number;
}

/** The key is missing, or holds no private half. Separate so callers can 404. */
export class AppsKeyMissingError extends Error {
  constructor() {
    super("ssh key not found");
    this.name = "AppsKeyMissingError";
  }
}

/**
 * Connect, or throw. The caller always owns `end()`.
 */
export async function connectAppsHost(target: AppsHostTarget): Promise<AppsClient> {
  const [key] = await db
    .select()
    .from(sshKeys)
    .where(and(eq(sshKeys.id, target.sshKeyId), eq(sshKeys.organizationId, target.organizationId)));
  if (!key?.encryptedPrivateKey || !key.privateKeyIv) throw new AppsKeyMissingError();

  // The host comes off the resource the caller named, but it is still a value
  // the provider reported, so it goes through the same check the terminal
  // uses. Dial the address that cleared rather than the name, or a
  // short-TTL record can answer the check and the connect differently.
  const dialAddress = await resolveSafeHost(target.host);
  const privateKey = await decrypt(
    key.encryptedPrivateKey,
    key.privateKeyIv,
    buildAad("sshKey", key.id, "privateKey"),
  );
  const port = target.port ?? 22;

  const hostKeyError: { value: HostKeyTrustRequiredError | null } = { value: null };
  return await new Promise<AppsClient>((resolve, reject) => {
    const client = new Client();
    client.once("ready", () => resolve(client));
    client.once("error", (error) =>
      // A changed host key surfaces as a generic handshake failure otherwise,
      // and "the key changed" is the one SSH error a user must actually read.
      reject(hostKeyError.value ?? error),
    );
    client.connect({
      host: dialAddress,
      port,
      username: target.username,
      privateKey,
      // Trust-on-first-use against the org's pin store, same as the terminal:
      // a session that skipped this would be the one place a changed host key
      // goes unnoticed.
      hostVerifier: makeHostKeyVerifier(
        target.organizationId,
        target.host,
        port,
        hostKeyError,
        "apps",
      ),
      readyTimeout: 30_000,
    });
  });
}
