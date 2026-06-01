/**
 * Workflow SSH host deps (shared by the cloud web server and the poller).
 *
 * Backs `resource.ssh(cmd, opts)` and `resource.waitUntilReachable()` inside a
 * workflow. Resolving how to reach a resource mirrors the interactive
 * SSH/SFTP path (`web/src/services/ssh.ts`): prefer a plugin's native
 * `getSshConfig()` (Fly, Hetzner), otherwise build a config from the resource
 * type's `sshEndpoint` host output plus an org SSH key's private half.
 *
 * Host-key policy here is **trust-on-first-use**: a workflow that just created a
 * droplet has no chance to interactively accept its key, so we auto-pin unknown
 * hosts (recording the fingerprint in `ssh_host_keys`) and reject only when a
 * previously-pinned key changes. This is deliberately more permissive than the
 * interactive terminal's explicit-consent model.
 */
import { Buffer } from "node:buffer";
import * as crypto from "node:crypto";
import * as net from "node:net";

import type {
  SshExecParamsLite,
  SshExecResultLite,
  SshProbeParamsLite,
  SshStreamChunkLite,
} from "@infrawrench/workflow-runtime";
import type { PluginClient, SshConfig } from "@infrawrench/plugin-base";
import { and, eq } from "drizzle-orm";
import { Client as SshClient } from "ssh2";

import { db } from "../db/client";
import { sshHostKeys, sshKeys } from "../db/schema";
import { decrypt, buildAad } from "../encryption";
import { getOrgAccountClient } from "./runner";

const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
const DEFAULT_PROBE_TIMEOUT_MS = 180_000;
const PROBE_INTERVAL_MS = 4_000;

/** Resolve the org SSH key (by id, then by name) and decrypt its private half. */
async function loadPrivateKey(organizationId: string, sshKeyId: string): Promise<string> {
  const [keyRow] = await db
    .select({
      id: sshKeys.id,
      encryptedPrivateKey: sshKeys.encryptedPrivateKey,
      privateKeyIv: sshKeys.privateKeyIv,
    })
    .from(sshKeys)
    .where(
      and(
        eq(sshKeys.organizationId, organizationId),
        // Allow referencing a key by id or by its display name.
        sshKeyId.includes("-") ? eq(sshKeys.id, sshKeyId) : eq(sshKeys.name, sshKeyId),
      ),
    )
    .limit(1);
  if (!keyRow) throw new Error(`SSH key "${sshKeyId}" not found in this organization.`);
  if (!keyRow.encryptedPrivateKey || !keyRow.privateKeyIv) {
    throw new Error(
      `SSH key "${sshKeyId}" has no private key data (imported public-only keys cannot authenticate).`,
    );
  }
  return decrypt(
    keyRow.encryptedPrivateKey,
    keyRow.privateKeyIv,
    buildAad("sshKey", keyRow.id, "privateKey"),
  );
}

/**
 * Read a resource's SSH host from its live instance. The address lives in the
 * resource's `resolvedOutputs` (e.g. a droplet's `ipv4`), populated by
 * `getResource` — NOT via `resolveOutput` (which most plugins don't implement
 * for these output keys). Falls back to a same-named `fields` value. Mirrors the
 * interactive SSH/tunnel path (see web `tunnel-ssh-attach.ts`).
 */
async function resolveHostFromResource(
  client: PluginClient,
  hostOutputKey: string,
  params: { accountId: string; typeId: string; resourceId: string },
): Promise<string | null> {
  const instance = await client.getResource(params.typeId, params.resourceId, params.accountId);
  const value =
    instance.resolvedOutputs?.[hostOutputKey] ??
    (instance.fields?.[hostOutputKey] as string | undefined);
  return value ? String(value) : null;
}

/**
 * Resolve a usable {@link SshConfig} for a workflow resource. Uses the plugin's
 * native SSH config when available; otherwise resolves the host from the
 * resource type's `sshEndpoint` output and authenticates with an org SSH key.
 */
async function resolveResourceSshConfig(
  organizationId: string,
  client: PluginClient,
  sshEndpoint: { hostOutputKey: string; defaultUsername?: string } | undefined,
  params: {
    accountId: string;
    typeId: string;
    resourceId: string;
    sshKeyId?: string;
    username?: string;
  },
): Promise<SshConfig> {
  const native = client.getSshConfig?.();
  if (native) {
    return {
      ...native,
      ...(params.username ? { username: params.username } : {}),
    };
  }

  if (!sshEndpoint) {
    throw new Error(
      `Resource type "${params.typeId}" does not expose an SSH endpoint, and its plugin has no native SSH support.`,
    );
  }
  if (!params.sshKeyId) {
    throw new Error(
      'ssh() needs an org SSH key to authenticate — pass { sshKey: "<key id or name>" }.',
    );
  }

  const host = await resolveHostFromResource(client, sshEndpoint.hostOutputKey, params);
  if (!host) {
    throw new Error(
      `Could not resolve the SSH host (output "${sshEndpoint.hostOutputKey}") for this resource — is it running yet?`,
    );
  }

  const privateKey = await loadPrivateKey(organizationId, params.sshKeyId);
  return {
    host,
    port: 22,
    username: params.username ?? sshEndpoint.defaultUsername ?? "root",
    privateKey,
  };
}

/** Look up the resource type's sshEndpoint + open a plugin client for the account. */
async function resourceConnection(
  organizationId: string,
  params: {
    accountId: string;
    typeId: string;
    resourceId: string;
    sshKeyId?: string;
    username?: string;
  },
): Promise<SshConfig> {
  const ctx = await getOrgAccountClient(params.accountId, organizationId);
  if (!ctx) throw new Error(`Account ${params.accountId} not found in this organization.`);
  const rt = ctx.plugin.resourceTypes.find((r) => r.id === params.typeId);
  return resolveResourceSshConfig(organizationId, ctx.client, rt?.sshEndpoint, params);
}

/**
 * Resolve just the host/port to probe — no SSH key required (unlike
 * {@link resourceConnection}). Returns null when the host isn't available yet
 * (e.g. a freshly-created VM that has no IP assigned), so the caller can retry.
 */
async function resolveResourceHost(
  organizationId: string,
  params: { accountId: string; typeId: string; resourceId: string },
): Promise<{ host: string; port: number } | null> {
  const ctx = await getOrgAccountClient(params.accountId, organizationId).catch(() => null);
  if (!ctx) return null;
  const native = ctx.client.getSshConfig?.();
  if (native?.host) return { host: native.host, port: native.port };
  const sshEndpoint = ctx.plugin.resourceTypes.find((r) => r.id === params.typeId)?.sshEndpoint;
  if (!sshEndpoint) return null;
  try {
    const host = await resolveHostFromResource(ctx.client, sshEndpoint.hostOutputKey, params);
    return host ? { host, port: 22 } : null;
  } catch {
    return null;
  }
}

function fingerprint(hostKey: Buffer): string {
  return (
    "SHA256:" + crypto.createHash("sha256").update(hostKey).digest("base64").replace(/=+$/, "")
  );
}

/**
 * Trust-on-first-use host verifier: auto-pins an unknown host's key, rejects a
 * changed key. Stores the typed reason on `errorRef` so the caller can surface
 * a clear message instead of the generic ssh2 connect failure.
 */
function makeTofuVerifier(
  organizationId: string,
  host: string,
  port: number,
  errorRef: { value: Error | null },
): (hostKey: Buffer, verify: (ok: boolean) => void) => void {
  return (hostKey, verify) => {
    const fp = fingerprint(hostKey);
    (async () => {
      const [existing] = await db
        .select({ id: sshHostKeys.id, fingerprint: sshHostKeys.fingerprint })
        .from(sshHostKeys)
        .where(
          and(
            eq(sshHostKeys.organizationId, organizationId),
            eq(sshHostKeys.host, host),
            eq(sshHostKeys.port, port),
          ),
        )
        .limit(1);
      if (existing) {
        if (existing.fingerprint !== fp) {
          errorRef.value = new Error(
            `SSH host key for ${host}:${port} changed (stored=${existing.fingerprint}, presented=${fp}). ` +
              `Re-pin it from SSH settings before connecting from a workflow.`,
          );
          return false;
        }
        return true;
      }
      // First use: pin it.
      try {
        await db.insert(sshHostKeys).values({
          id: crypto.randomUUID(),
          organizationId,
          host,
          port,
          fingerprint: fp,
        });
      } catch {
        // Concurrent insert — accept; a mismatch will be caught next time.
      }
      return true;
    })().then(
      (ok) => verify(ok),
      (e) => {
        errorRef.value = e instanceof Error ? e : new Error(String(e));
        verify(false);
      },
    );
  };
}

/** Open an ssh2 client and run `onReady(stream)` once connected. */
function connect(
  organizationId: string,
  config: SshConfig,
  onReady: (client: SshClient) => void,
  onError: (err: Error) => void,
  skipHostKeyCheck = false,
): SshClient {
  const client = new SshClient();
  const errorRef = { value: null as Error | null };
  client.once("ready", () => onReady(client));
  client.once("error", (err) => {
    onError(errorRef.value ?? new Error(`SSH error: ${err.message}`));
  });
  client.connect({
    host: config.host,
    port: config.port,
    username: config.username,
    privateKey: config.privateKey,
    readyTimeout: DEFAULT_EXEC_TIMEOUT_MS,
    // skipHostKeyCheck → accept any key without verifying/pinning it.
    hostVerifier: skipHostKeyCheck
      ? (_key: Buffer, verify: (ok: boolean) => void) => verify(true)
      : makeTofuVerifier(organizationId, config.host, config.port, errorRef),
  });
  return client;
}

// --- streaming registry --------------------------------------------------

interface StreamState {
  stdout: Buffer[];
  stderr: Buffer[];
  done: boolean;
  code: number | null;
  error: Error | null;
  /** Resolver waiting for the next chunk/terminal, if a read is pending. */
  waiter: (() => void) | null;
  client: SshClient;
}

const streams = new Map<string, StreamState>();

function wake(state: StreamState): void {
  const w = state.waiter;
  if (w) {
    state.waiter = null;
    w();
  }
}

/**
 * Build the five SSH host-dep functions for an org's workflow run. They are
 * passed into `buildWorkflowHost` and surfaced to the sandbox as `resource.ssh`.
 */
export function buildWorkflowSshDeps(organizationId: string, opts: { signal?: AbortSignal } = {}) {
  const sshExec = (params: SshExecParamsLite): Promise<SshExecResultLite> =>
    resourceConnection(organizationId, params).then(
      (config) =>
        new Promise<SshExecResultLite>((resolve, reject) => {
          const client = connect(
            organizationId,
            config,
            (c) => {
              c.exec(params.command, (err, stream) => {
                if (err) {
                  c.end();
                  reject(err);
                  return;
                }
                const stdout: Buffer[] = [];
                const stderr: Buffer[] = [];
                stream.on("data", (d: Buffer) => stdout.push(d));
                stream.stderr.on("data", (d: Buffer) => stderr.push(d));
                stream.on("close", (code: number) => {
                  c.end();
                  resolve({
                    stdoutBase64: Buffer.concat(stdout).toString("base64"),
                    stderrBase64: Buffer.concat(stderr).toString("base64"),
                    code: code ?? 0,
                  });
                });
              });
            },
            reject,
            params.skipHostKeyCheck,
          );
          if (params.timeoutMs) {
            setTimeout(() => {
              client.end();
              reject(new Error(`SSH command timed out after ${params.timeoutMs}ms`));
            }, params.timeoutMs).unref?.();
          }
        }),
    );

  const sshStreamStart = async (params: SshExecParamsLite): Promise<{ streamId: string }> => {
    const config = await resourceConnection(organizationId, params);
    const streamId = crypto.randomUUID();
    await new Promise<void>((resolve, reject) => {
      const client = connect(
        organizationId,
        config,
        (c) => {
          c.exec(params.command, (err, stream) => {
            if (err) {
              c.end();
              reject(err);
              return;
            }
            const state: StreamState = {
              stdout: [],
              stderr: [],
              done: false,
              code: null,
              error: null,
              waiter: null,
              client: c,
            };
            streams.set(streamId, state);
            stream.on("data", (d: Buffer) => {
              state.stdout.push(d);
              wake(state);
            });
            stream.stderr.on("data", (d: Buffer) => {
              state.stderr.push(d);
              wake(state);
            });
            stream.on("close", (code: number) => {
              state.done = true;
              state.code = code ?? 0;
              wake(state);
              c.end();
            });
            resolve();
          });
        },
        reject,
        params.skipHostKeyCheck,
      );
    });
    return { streamId };
  };

  const sshStreamRead = (streamId: string): Promise<SshStreamChunkLite> => {
    const state = streams.get(streamId);
    if (!state) return Promise.resolve({ done: true });
    const take = (): SshStreamChunkLite | null => {
      if (state.error) {
        streams.delete(streamId);
        throw state.error;
      }
      if (state.stdout.length > 0 || state.stderr.length > 0) {
        const out: SshStreamChunkLite = { done: false };
        if (state.stdout.length > 0)
          out.stdoutBase64 = Buffer.concat(state.stdout.splice(0)).toString("base64");
        if (state.stderr.length > 0)
          out.stderrBase64 = Buffer.concat(state.stderr.splice(0)).toString("base64");
        return out;
      }
      if (state.done) {
        streams.delete(streamId);
        return { done: true, code: state.code ?? 0 };
      }
      return null;
    };
    let ready: SshStreamChunkLite | null;
    try {
      ready = take();
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    if (ready) return Promise.resolve(ready);
    return new Promise<SshStreamChunkLite>((resolve, reject) => {
      const onWake = () => {
        try {
          const next = take();
          if (next) resolve(next);
          // Spurious wake (no chunk yet) — wait for the next one.
          else state.waiter = onWake;
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      };
      state.waiter = onWake;
    });
  };

  const sshStreamClose = async (streamId: string): Promise<void> => {
    const state = streams.get(streamId);
    if (state) {
      streams.delete(streamId);
      try {
        state.client.end();
      } catch {
        // already closed
      }
    }
  };

  const tcpAttempt = (host: string, port: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port });
      const done = (ok: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(PROBE_INTERVAL_MS);
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      socket.once("timeout", () => done(false));
    });

  const sshProbe = async (params: SshProbeParamsLite): Promise<boolean> => {
    const deadline = Date.now() + (params.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
    // Resolve the host *inside* the loop: a just-created VM may not have an IP
    // yet, so keep re-resolving (and re-probing) until it's reachable or we time
    // out — rather than failing the instant the address isn't available.
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) return false; // bail out of waitUntilReachable on Stop
      const target = await resolveResourceHost(organizationId, params);
      if (target) {
        const port = params.port ?? target.port ?? 22;
        if (await tcpAttempt(target.host, port)) return true;
      }
      if (Date.now() + PROBE_INTERVAL_MS >= deadline) break;
      await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
    }
    return false;
  };

  return { sshExec, sshStreamStart, sshStreamRead, sshStreamClose, sshProbe };
}
