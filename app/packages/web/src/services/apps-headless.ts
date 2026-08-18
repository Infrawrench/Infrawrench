/**
 * Driving a resource's Linux applications with no browser attached.
 *
 * This is the agent-facing half of the app-streaming feature. Where the viewer
 * (`apps-proxy.ts`) relays frames to a canvas a person is looking at, this
 * launches an application, keeps the same per-window canvas in Node, and lets
 * a caller take screenshots, read the accessibility tree, and synthesise input
 * — everything `@infrawrench/appstream-host`'s `HeadlessAppClient` exposes.
 *
 * Sessions are cached per (org, resource) and reused: staging the binary and
 * starting a compositor takes seconds, and an agent's screenshot-click-repeat
 * loop should pay that once. An idle session is torn down after a few minutes,
 * the same idle timeout the host itself enforces, so nothing lingers on a
 * customer's machine.
 *
 * Host resolution reuses `resolveSshConfig` — the one `ssh_exec` uses — so a
 * plugin-native host (Fly, Hetzner) needs no key and a VM (`sshEndpoint`) uses
 * the org's own key against the address that cleared `resolveSafeHost`.
 */

import ssh2 from "ssh2";
import { and, eq, isNull } from "drizzle-orm";
import { HeadlessAppClient, startHeadlessAppSession } from "@infrawrench/appstream-host";
import type { SshConfig } from "@infrawrench/plugin-base";

import { db } from "@/db/client";
import { resources } from "@/db/schema";
import { getClientForAccount } from "@/services/plugin-clients";
import { getPlugin } from "@/plugins/loader";
import { resolveSshConfig } from "@/services/ssh";
import { resolveSafeHost } from "@/services/host-validation";
import { HostKeyTrustRequiredError, makeHostKeyVerifier } from "@/services/ssh-host-keys";
import { getArm64GzBinary, getx86_64GzBinary } from "@/services/iwappd-binaries";
import { logAudit } from "@/services/audit";

const { Client } = ssh2;
type SshClient = InstanceType<typeof Client>;

const binaryForArch = (arch: "x86_64" | "aarch64") =>
  arch === "x86_64" ? getx86_64GzBinary() : getArm64GzBinary();

/** How long an unused headless session is kept before it is torn down. */
const IDLE_TTL_MS = 5 * 60_000;

export class AppsHostError extends Error {
  constructor(
    message: string,
    /** True when a caller could fix it by passing an sshKeyId. */
    readonly needsKey = false,
  ) {
    super(message);
    this.name = "AppsHostError";
  }
}

interface CachedSession {
  client: HeadlessAppClient;
  ssh: SshClient;
  lastUsed: number;
  timer: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, CachedSession>();
/** In-flight connects, so two tool calls for one resource share a session. */
const pending = new Map<string, Promise<CachedSession>>();

function key(organizationId: string, resourceId: string): string {
  return `${organizationId}:${resourceId}`;
}

function touch(cacheKey: string, entry: CachedSession): void {
  entry.lastUsed = Date.now();
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => teardown(cacheKey), IDLE_TTL_MS);
  // A cached session outlives one request, so its idle timer must not hold the
  // process open on its own.
  entry.timer.unref?.();
}

function teardown(cacheKey: string): void {
  const entry = sessions.get(cacheKey);
  if (!entry) return;
  sessions.delete(cacheKey);
  clearTimeout(entry.timer);
  try {
    entry.client.close();
  } catch {
    /* already gone */
  }
  try {
    entry.ssh.end();
  } catch {
    /* already gone */
  }
}

/** Resolve a resource to the SSH target its applications run over. */
async function resolveTarget(
  organizationId: string,
  resourceId: string,
  options: { sshKeyId?: string; username?: string },
): Promise<{ accountId: string; config: SshConfig; dialAddress: string }> {
  const [row] = await db
    .select({
      id: resources.id,
      accountId: resources.accountId,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      fieldsJson: resources.fieldsJson,
      outputsJson: resources.outputsJson,
    })
    .from(resources)
    .where(
      and(
        eq(resources.id, resourceId),
        eq(resources.organizationId, organizationId),
        isNull(resources.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new AppsHostError(`Resource ${resourceId} not found`);

  const ctx = await getClientForAccount(row.accountId, organizationId);
  if (!ctx) throw new AppsHostError("Account for this resource not found");

  // A plugin that speaks SSH natively (Fly, Hetzner) carries host, user and key
  // in its own config; a VM declares an `sshEndpoint` whose host comes from the
  // resource's outputs and whose key is the org's.
  const nativeConfig = ctx.client.getSshConfig?.();
  let host: string | undefined;
  let username = options.username;
  if (!nativeConfig) {
    const loaded = await getPlugin(row.pluginId);
    const endpoint = loaded?.plugin.resourceTypes.find(
      (t) => t.id === row.resourceTypeId,
    )?.sshEndpoint;
    if (!endpoint) {
      throw new AppsHostError(
        `${row.resourceTypeId} has no SSH endpoint — applications run over the same connection as the terminal, and this resource type exposes none`,
      );
    }
    const fields = (row.fieldsJson ?? {}) as Record<string, unknown>;
    const outputs = (row.outputsJson ?? {}) as Record<string, unknown>;
    if (endpoint.runningWhen) {
      const value = String(fields[endpoint.runningWhen.fieldKey] ?? "").toLowerCase();
      if (value !== endpoint.runningWhen.value.toLowerCase()) {
        throw new AppsHostError("This host is not running");
      }
    }
    host = String(outputs[endpoint.hostOutputKey] ?? fields[endpoint.hostOutputKey] ?? "");
    if (!host) {
      throw new AppsHostError(
        "This resource has no reachable address yet — it may be provisioning",
      );
    }
    if (!username && endpoint.usernameFieldKey) {
      username = String(fields[endpoint.usernameFieldKey] ?? "") || undefined;
    }
    username ??= endpoint.defaultUsername ?? "root";
    if (!options.sshKeyId) {
      throw new AppsHostError(
        "This host needs an SSH key. Pass sshKeyId (see list_ssh_keys) — the same key the terminal uses.",
        true,
      );
    }
  }

  const config = await resolveSshConfig(ctx.client, organizationId, {
    ...(options.sshKeyId ? { sshKeyId: options.sshKeyId } : {}),
    ...(host ? { sshHost: host } : {}),
    ...(username ? { sshUsername: username } : {}),
  });

  // SSRF: only the host the resource named is untrusted input — a plugin-native
  // endpoint is org configuration, dialed unguarded like every SQL/Docker host.
  // Dial the address that cleared; the name keeps the host-key identity.
  let dialAddress = config.host;
  if (host && config.host === host) {
    dialAddress = await resolveSafeHost(config.host);
  }
  return { accountId: row.accountId, config, dialAddress };
}

function connectSsh(
  organizationId: string,
  config: SshConfig,
  dialAddress: string,
): Promise<SshClient> {
  const hostKeyError: { value: HostKeyTrustRequiredError | null } = { value: null };
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.once("ready", () => resolve(client));
    client.once("error", (error) => reject(hostKeyError.value ?? error));
    client.connect({
      host: dialAddress,
      port: config.port,
      username: config.username,
      privateKey: config.privateKey,
      hostVerifier: makeHostKeyVerifier(
        organizationId,
        config.host,
        config.port,
        hostKeyError,
        "apps",
      ),
      readyTimeout: 30_000,
    });
  });
}

export interface AppsSessionRef {
  organizationId: string;
  resourceId: string;
  userId?: string;
  sshKeyId?: string;
  username?: string;
}

/**
 * The driveable session for a resource, connecting and launching a compositor
 * on first use and reusing it after. The caller drives it through the returned
 * {@link HeadlessAppClient}.
 */
export async function getHeadlessSession(ref: AppsSessionRef): Promise<HeadlessAppClient> {
  const cacheKey = key(ref.organizationId, ref.resourceId);
  const existing = sessions.get(cacheKey);
  if (existing) {
    touch(cacheKey, existing);
    return existing.client;
  }
  const inFlight = pending.get(cacheKey);
  if (inFlight) return (await inFlight).client;

  const connect = (async (): Promise<CachedSession> => {
    const { config, dialAddress } = await resolveTarget(ref.organizationId, ref.resourceId, {
      ...(ref.sshKeyId ? { sshKeyId: ref.sshKeyId } : {}),
      ...(ref.username ? { username: ref.username } : {}),
    });
    let ssh: SshClient;
    try {
      ssh = await connectSsh(ref.organizationId, config, dialAddress);
    } catch (error) {
      if (error instanceof HostKeyTrustRequiredError) {
        throw new AppsHostError(
          `The host key for ${error.host} is untrusted. Verify it out of band and trust it (trust_ssh_host) before driving applications there.`,
        );
      }
      throw error;
    }

    let client: HeadlessAppClient;
    try {
      client = await startHeadlessAppSession(ssh, {
        sessionId: `${ref.organizationId}-${ref.resourceId}`.slice(0, 48),
        binaryForArch,
        idleTimeoutSecs: 5 * 60,
        onStderr: (line) => console.warn(`[apps-headless ${ref.resourceId}] ${line}`),
      });
    } catch (error) {
      try {
        ssh.end();
      } catch {
        /* already gone */
      }
      throw error;
    }

    // A graphical session is not captured by SSH recording, so the audit entry
    // is the only record it happened.
    void logAudit({
      organizationId: ref.organizationId,
      ...(ref.userId ? { userId: ref.userId } : {}),
      action: "linux_app.headless_session_start",
      entityType: "resource",
      entityId: ref.resourceId,
      metadata: { source: "agent" },
    });

    const entry: CachedSession = {
      client,
      ssh,
      lastUsed: Date.now(),
      timer: setTimeout(() => teardown(cacheKey), IDLE_TTL_MS),
    };
    entry.timer.unref?.();
    // A host that exits (idle timeout, crash) must not leave a dead cache entry
    // that later calls reuse.
    client.session.addWindowCloseListener(() => {});
    ssh.once("close", () => {
      if (sessions.get(cacheKey) === entry) teardown(cacheKey);
    });
    sessions.set(cacheKey, entry);
    return entry;
  })();

  pending.set(cacheKey, connect);
  try {
    return (await connect).client;
  } finally {
    pending.delete(cacheKey);
  }
}

/** Tear down a resource's session, if any (an explicit end_session tool). */
export function endHeadlessSession(organizationId: string, resourceId: string): boolean {
  const cacheKey = key(organizationId, resourceId);
  const had = sessions.has(cacheKey);
  teardown(cacheKey);
  return had;
}
