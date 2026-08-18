/**
 * The cloud as an SSH agent.
 *
 * A cloud-held org key's private half never reaches this machine, so the main
 * process authenticates with a `RemoteKeyAgent` whose backend asks Infrawrench
 * Cloud to sign each publickey-auth challenge (`POST /ssh-keys/:id/sign`).
 * The SSH connection itself — and everything streamed over it — stays between
 * this machine and the host; only signatures cross the cloud.
 */
import {
  buildRemoteKeyAgent,
  type RemoteKeyAgent,
  type SshSignAlgorithm,
} from "@infrawrench/ssh-tunnel-core";
import { cloudFetch } from "./cloud-data/shared";

/** Names the cloud key an SSH config authenticates with. */
export interface CloudKeyRef {
  orgId: string;
  sshKeyId: string;
}

interface CloudSshKeyRow {
  id: string;
  name: string;
  publicKey: string;
  isImported?: boolean;
}

/** Where the signature is being used, recorded in the org's audit log. */
export interface CloudKeySignContext {
  host?: string;
  username?: string;
}

export function buildCloudKeyAgent(
  ref: CloudKeyRef,
  context: CloudKeySignContext = {},
): RemoteKeyAgent {
  return buildRemoteKeyAgent({
    async fetchPublicKey(): Promise<string> {
      const keys = (await cloudFetch<CloudSshKeyRow[]>(ref.orgId, "/ssh-keys")) ?? [];
      const key = keys.find((k) => k.id === ref.sshKeyId);
      if (!key) {
        throw new Error("The selected cloud SSH key no longer exists in this organization");
      }
      if (key.isImported) {
        throw new Error(
          `The cloud key "${key.name}" was imported — Infrawrench Cloud holds only its public half and cannot sign with it`,
        );
      }
      return key.publicKey;
    },
    async sign(data: Buffer, algorithm: SshSignAlgorithm): Promise<Buffer> {
      const result = await cloudFetch<{ signature: string }>(
        ref.orgId,
        `/ssh-keys/${encodeURIComponent(ref.sshKeyId)}/sign`,
        {
          method: "POST",
          body: JSON.stringify({
            data: data.toString("base64"),
            algorithm,
            ...(context.host || context.username
              ? {
                  context: {
                    ...(context.host ? { host: context.host } : {}),
                    ...(context.username ? { username: context.username } : {}),
                  },
                }
              : {}),
          }),
        },
      );
      if (!result?.signature) throw new Error("Cloud signing returned no signature");
      return Buffer.from(result.signature, "base64");
    },
  });
}
