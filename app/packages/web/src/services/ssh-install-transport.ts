import ssh2 from "ssh2";
import type { Readable } from "node:stream";
import type { SshConfig } from "@infrawrench/plugin-base";
import { forwardOutHop, resolveSshChain } from "@infrawrench/plugin-ssh";
import { execSshScript } from "@infrawrench/ssh-tunnel-core";
import { getClientForAccount } from "./plugin-clients";
import { resolveSafeHost } from "./host-validation";
import { HostKeyTrustRequiredError, makeHostKeyVerifier } from "./ssh-host-keys";

/** One verified SSH connection for the whole installation, including saved jump hosts. */
export async function connectSshInstaller(
  organizationId: string,
  config: SshConfig,
  throughAccountId?: string,
) {
  const upstream = throughAccountId
    ? await resolveSshChain(throughAccountId, async (accountId) => {
        const ctx = await getClientForAccount(accountId, organizationId);
        const hop = ctx?.client.getSshConfig?.();
        if (!ctx || ctx.plugin.manifest.id !== "ssh" || !hop)
          throw new Error("SSH jump account not found.");
        return {
          ...hop,
          ...(ctx.credentials.connectThroughAccountId
            ? { connectThroughAccountId: ctx.credentials.connectThroughAccountId }
            : {}),
        };
      })
    : [];
  const clients: InstanceType<typeof ssh2.Client>[] = [];
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
      const trustError = { value: null as HostKeyTrustRequiredError | null };
      await new Promise<void>((resolve, reject) => {
        client.once("ready", resolve);
        client.on("error", (error) => reject(trustError.value ?? error));
        client.once("close", () => reject(new Error("SSH connection closed before it was ready.")));
        client.connect({
          ...hop,
          host: dialAddress ?? hop.host,
          ...(sock ? { sock } : {}),
          readyTimeout: 30_000,
          hostVerifier: makeHostKeyVerifier(organizationId, hop.host, hop.port, trustError, "ssh"),
        });
      });
    }
    return { exec: (script: string) => execSshScript(clients.at(-1)!, script), close };
  } catch (error) {
    close();
    throw error;
  }
}
