/**
 * SSH command execution via ssh2 — used by the connect/env-deploy API.
 */
import ssh2 from "ssh2";
import { eq, and } from "drizzle-orm";

const { Client: SshClient } = ssh2;
// Re-establish the class's dual value/type nature lost by destructuring.
type SshClient = InstanceType<typeof SshClient>;
import type { PluginClient, SshConfig } from "@infrawrench/plugin-base";
import { db } from "../db/client";
import { sshKeys } from "../db/schema";
import { decrypt, buildAad } from "./encryption";
import { HostKeyTrustRequiredError, makeHostKeyVerifier } from "./ssh-host-keys";

/**
 * Resolve an SSH config for an SFTP/SSH-exec request:
 * - if the plugin natively exposes `getSshConfig()` (e.g. Fly, Hetzner), use that
 * - otherwise fall back to the org SSH key + host (sshEndpoint-based resources like EC2)
 */
export async function resolveSshConfig(
  client: PluginClient,
  organizationId: string,
  input: { sshKeyId?: string; sshHost?: string; sshUsername?: string },
): Promise<SshConfig> {
  const pluginConfig = client.getSshConfig?.();
  if (pluginConfig) return pluginConfig;

  if (!input.sshKeyId || !input.sshHost) {
    throw new Error("Plugin does not support SSH and no SSH key/host provided");
  }

  const [keyRow] = await db
    .select({
      encryptedPrivateKey: sshKeys.encryptedPrivateKey,
      privateKeyIv: sshKeys.privateKeyIv,
    })
    .from(sshKeys)
    .where(and(eq(sshKeys.id, input.sshKeyId), eq(sshKeys.organizationId, organizationId)))
    .limit(1);
  if (!keyRow) throw new Error("SSH key not found");
  if (!keyRow.encryptedPrivateKey || !keyRow.privateKeyIv) {
    throw new Error("SSH key has no private key data");
  }
  const privateKey = await decrypt(
    keyRow.encryptedPrivateKey,
    keyRow.privateKeyIv,
    buildAad("sshKey", input.sshKeyId, "privateKey"),
  );
  return {
    host: input.sshHost,
    port: 22,
    username: input.sshUsername ?? "root",
    privateKey,
  };
}

/** Execute a single command over SSH and return stdout. Throws on non-zero exit or SSH error. */
export function sshExec(
  organizationId: string,
  config: SshConfig,
  command: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new SshClient();
    const hostKeyErrorRef = { value: null as HostKeyTrustRequiredError | null };
    client.once("ready", () => {
      client.exec(command, (err, stream) => {
        if (err) {
          client.end();
          reject(err);
          return;
        }
        let stdout = "";
        let stderr = "";
        stream.on("data", (data: Buffer) => {
          stdout += data.toString();
        });
        stream.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });
        stream.on("close", (code: number) => {
          client.end();
          if (code !== 0) {
            reject(new Error(`Command exited with code ${code}: ${stderr || stdout}`));
          } else {
            resolve(stdout);
          }
        });
      });
    });
    client.once("error", (err) => {
      // If the connection was aborted because of a host-key mismatch, report
      // that error rather than the generic ssh2 "All configured ..." message.
      if (hostKeyErrorRef.value) {
        reject(hostKeyErrorRef.value);
        return;
      }
      reject(new Error(`SSH error: ${err.message}`));
    });
    client.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      privateKey: config.privateKey,
      hostVerifier: makeHostKeyVerifier(
        organizationId,
        config.host,
        config.port,
        hostKeyErrorRef,
        "ssh",
      ),
    });
  });
}
