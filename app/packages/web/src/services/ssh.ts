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

export interface SshExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Caps for fan-out style captures — bound memory when many hosts stream at once. */
const CAPTURE_MAX_BYTES = 256 * 1024;
const CAPTURE_READY_TIMEOUT_MS = 30_000;
const CAPTURE_COMMAND_TIMEOUT_MS = 120_000;

/**
 * Execute a single command over SSH and capture stdout, stderr, and the exit
 * code. Unlike {@link sshExec}, a non-zero exit resolves normally — the caller
 * (fan-out) surfaces per-host exit codes instead of treating them as
 * transport errors. Still throws on SSH/connection failures, including
 * {@link HostKeyTrustRequiredError}. Output is capped at 256 KiB per stream
 * and the command is abandoned after 2 minutes.
 */
export function sshExecCapture(
  organizationId: string,
  config: SshConfig,
  command: string,
): Promise<SshExecResult> {
  return new Promise((resolve, reject) => {
    const client = new SshClient();
    const hostKeyErrorRef = { value: null as HostKeyTrustRequiredError | null };
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.end();
      reject(new Error(`Command timed out after ${CAPTURE_COMMAND_TIMEOUT_MS / 1000}s`));
    }, CAPTURE_COMMAND_TIMEOUT_MS);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    client.once("ready", () => {
      client.exec(command, (err, stream) => {
        if (err) {
          client.end();
          finish(() => reject(err));
          return;
        }
        let stdout = "";
        let stderr = "";
        stream.on("data", (data: Buffer) => {
          if (stdout.length < CAPTURE_MAX_BYTES) stdout += data.toString();
        });
        stream.stderr.on("data", (data: Buffer) => {
          if (stderr.length < CAPTURE_MAX_BYTES) stderr += data.toString();
        });
        stream.on("close", (code: number | null) => {
          client.end();
          finish(() => resolve({ stdout, stderr, exitCode: code ?? 0 }));
        });
      });
    });
    client.once("error", (err) => {
      if (hostKeyErrorRef.value) {
        finish(() => reject(hostKeyErrorRef.value));
        return;
      }
      finish(() => reject(new Error(`SSH error: ${err.message}`)));
    });
    client.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      privateKey: config.privateKey,
      readyTimeout: CAPTURE_READY_TIMEOUT_MS,
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
