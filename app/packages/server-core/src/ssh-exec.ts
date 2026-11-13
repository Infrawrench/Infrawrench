/**
 * `HostServices.ssh` on the server: run a script on an account's own SSH
 * host (accounts of plugins that declare `jumpHost`), connecting the way the
 * terminal does.
 *
 * - **Host keys are the organization's pins** (`ssh_host_keys`), checked
 *   read-only: an unknown or changed key refuses the connection with the
 *   fingerprint, and nothing here pins anything (the terminal's explicit
 *   consent is how a key gets trusted). That is stricter than workflows'
 *   trust-on-first-use, because a CI job runs code on the host unattended.
 * - **Jump hosts** come from the account's `accountReference` field (the
 *   "connect through" chain), each hop dialled through the previous one
 *   with `forwardOut`, as `@infrawrench/ssh-tunnel-core/chain` does for the
 *   terminal and the SSH installer. The first hop's address is vetted by the
 *   egress guard (`resolveSafeHost`) and the socket goes to the address that
 *   cleared.
 * - One connection per call, closed when the script ends.
 *
 * ssh2 is a socket driver: this runs only where plugin code does (the
 * gateway). `host-services.ts` loads it lazily, so the edge never imports it.
 */
import type { Readable } from "node:stream";
import ssh2 from "ssh2";
import { and, eq } from "drizzle-orm";
import type { SshConfig } from "@infrawrench/plugin-base";
import { execSshScript, sha256Fingerprint } from "@infrawrench/ssh-tunnel-core";
import { forwardOutHop, resolveSshChain, type SshHop } from "@infrawrench/ssh-tunnel-core/chain";

import { db } from "./db/client";
import { sshHostKeys } from "./db/schema";
import { resolveSafeHost } from "./egress-guard";

type Client = InstanceType<typeof ssh2.Client>;

/** A host key that is not the one the organization pinned, or none is pinned. */
export class SshHostKeyRefusedError extends Error {
  constructor(host: string, port: number, presented: string, pinned: string | null) {
    super(
      pinned
        ? `The host key of ${host}:${port} changed (pinned ${pinned}, presented ${presented}). If the change is expected, trust the new key from the terminal.`
        : `No host key is pinned for ${host}:${port} (presented ${presented}). Open a terminal to it from Infrawrench once to trust it.`,
    );
    this.name = "SshHostKeyRefusedError";
  }
}

/** The fingerprint the organization pinned for a host, or null. */
export type PinLookup = (host: string, port: number) => Promise<string | null>;

function databasePins(organizationId: string): PinLookup {
  return async (host, port) => {
    const [row] = await db
      .select({ fingerprint: sshHostKeys.fingerprint })
      .from(sshHostKeys)
      .where(
        and(
          eq(sshHostKeys.organizationId, organizationId),
          eq(sshHostKeys.host, host),
          eq(sshHostKeys.port, port),
        ),
      )
      .limit(1);
    return row?.fingerprint ?? null;
  };
}

function pinnedKeyVerifier(
  pins: PinLookup,
  host: string,
  port: number,
  refused: { value: Error | null },
): (key: Buffer, verify: (valid: boolean) => void) => void {
  return (key, verify) => {
    const presented = sha256Fingerprint(key);
    pins(host, port).then(
      (pinned) => {
        if (pinned === presented) {
          verify(true);
          return;
        }
        refused.value = new SshHostKeyRefusedError(host, port, presented, pinned);
        verify(false);
      },
      (err: unknown) => {
        refused.value = err instanceof Error ? err : new Error(String(err));
        verify(false);
      },
    );
  };
}

/** What a hop needs from its account: its SSH config and the account it goes through. */
export type SshAccountResolver = (
  accountId: string,
) => Promise<{ config: SshConfig; throughAccountId?: string }>;

/**
 * Connects to `config` through the chain starting at `throughAccountId`,
 * verifying every hop's pinned key, and answers the last client and a close.
 */
export async function connectPinned(
  organizationId: string,
  config: SshConfig,
  throughAccountId: string | undefined,
  resolve: SshAccountResolver,
  pins: PinLookup = databasePins(organizationId),
): Promise<{ client: Client; close: () => void }> {
  const upstream: SshHop[] = throughAccountId
    ? await resolveSshChain(throughAccountId, async (accountId) => {
        const hop = await resolve(accountId);
        return {
          ...hop.config,
          ...(hop.throughAccountId ? { connectThroughAccountId: hop.throughAccountId } : {}),
        };
      })
    : [];
  const clients: Client[] = [];
  const close = () => {
    for (const client of [...clients].reverse()) client.end();
  };
  try {
    for (const hop of [...upstream, config]) {
      const previous = clients.at(-1);
      const sock = previous
        ? ((await forwardOutHop(previous, hop.host, hop.port)) as Readable)
        : undefined;
      const dialAddress = sock ? undefined : await resolveSafeHost(hop.host);
      const client = new ssh2.Client();
      clients.push(client);
      const refused = { value: null as Error | null };
      await new Promise<void>((ready, fail) => {
        client.once("ready", ready);
        client.on("error", (error) => fail(refused.value ?? error));
        client.once("close", () =>
          fail(refused.value ?? new Error("SSH connection closed before it was ready.")),
        );
        client.connect({
          host: dialAddress ?? hop.host,
          port: hop.port,
          username: hop.username,
          privateKey: hop.privateKey,
          ...(sock ? { sock } : {}),
          readyTimeout: 30_000,
          hostVerifier: pinnedKeyVerifier(pins, hop.host, hop.port, refused),
        });
      });
    }
    return { client: clients.at(-1)!, close };
  } catch (error) {
    close();
    throw error;
  }
}

/** Runs `script` with `sh -s` on the account's host. */
export async function execOnAccountHost(
  organizationId: string,
  accountId: string,
  script: string,
  timeoutMs: number,
  resolve: SshAccountResolver,
  pins: PinLookup = databasePins(organizationId),
): Promise<string> {
  const target = await resolve(accountId);
  const { client, close } = await connectPinned(
    organizationId,
    target.config,
    target.throughAccountId,
    resolve,
    pins,
  );
  try {
    return await execSshScript(client, script, timeoutMs);
  } finally {
    close();
  }
}

/**
 * The resolver the server uses: an account of a `jumpHost` plugin, its
 * `getSshConfig()`, and the account its `accountReference` field names.
 */
export function accountResolver(organizationId: string): SshAccountResolver {
  return async (accountId) => {
    const { getOrgAccountClient } = await import("./org-accounts");
    const ctx = await getOrgAccountClient(accountId, organizationId);
    if (!ctx || !ctx.plugin.manifest.jumpHost) throw new Error("No such SSH connection.");
    const config = ctx.client.getSshConfig?.();
    if (!config) throw new Error("The SSH connection has no host to connect to.");
    const field = ctx.plugin.manifest.credentialFields.find((f) => f.accountReference);
    const through = field ? ctx.credentials[field.key] : undefined;
    return through ? { config, throughAccountId: through } : { config };
  };
}
