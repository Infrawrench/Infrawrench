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
 * That cache is *in this process*, and the session it holds cannot be moved:
 * it is an SSH channel to a compositor that exits the moment the channel
 * closes. With more than one replica behind round-robin routing, a call for a
 * session another pod holds used to start a second compositor on the same
 * host, which fails to bind the session's socket and dies — surfacing as an
 * intermittent "the app server closed before greeting" for about half of all
 * calls. So every operation goes through {@link runOnOwner}: `services/
 * replica-relay.ts` leases the session to one pod, and calls arriving anywhere
 * else are forwarded to it rather than duplicating it.
 *
 * The operations are therefore written once, as {@link runLocally}, and
 * reached two ways — directly on the owning pod, or over the relay from
 * another. `api/routes/internal-relay.ts` is the receiving end.
 *
 * Host resolution reuses `resolveSshConfig` — the one `ssh_exec` uses — so a
 * plugin-native host (Fly, Hetzner) needs no key and a VM (`sshEndpoint`) uses
 * the org's own key against the address that cleared `resolveSafeHost`.
 */

import ssh2 from "ssh2";
import { and, eq, isNull } from "drizzle-orm";
import { HeadlessAppClient, startHeadlessAppSession } from "@infrawrench/appstream-host";
import type { A11yTreeResult, AppEntry, WindowInfo } from "@infrawrench/appstream-core";
import type { SshConfig } from "@infrawrench/plugin-base";

import {
  RelayUnreachableError,
  claimSession,
  forwardToOwner,
  releaseSession,
  releaseUnreachable,
  touchSession,
} from "@/services/replica-relay";

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

/** This feature's namespace in the cross-replica session registry. */
const RELAY_KIND = "linux-app";

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

/**
 * Name a start failure the caller can actually act on.
 *
 * The compositor is a single process on the customer's host, and the session
 * driving it lives in whichever replica of this service started it. A call
 * routed elsewhere tries to start a second compositor, which refuses to take a
 * socket name the first one holds. Nothing about that is visible from the
 * outside — the tool call just fails, intermittently, for what looks like no
 * reason — so say what happened and what to do about it.
 */
function explainStartFailure(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (!/socket name is already in use/i.test(message)) return error;
  return new AppsHostError(
    "Another Infrawrench session is already driving applications on this host, and this request reached a different server from the one holding it. Run the call again — it will usually reach the right one. An idle session is released five minutes after its last use.",
  );
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
  // Hand the lease back rather than making the next caller wait it out. This
  // is fire-and-forget on purpose: teardown runs from timers and socket close
  // handlers, and a lease that outlives its session expires by itself.
  void releaseSession(RELAY_KIND, cacheKey);
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
 * The compositor connection **held by this process**, opening it on first use.
 *
 * Only ever called on the pod that owns the session's lease — everywhere else
 * goes through {@link runOnOwner}, which forwards. Starting one here without
 * holding the lease is the bug the relay exists to prevent.
 */
async function getLocalSession(ref: AppsSessionRef): Promise<HeadlessAppClient> {
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
      throw explainStartFailure(error);
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

/** Tear down a session held *by this process*, if any. */
function endLocalSession(organizationId: string, resourceId: string): boolean {
  const cacheKey = key(organizationId, resourceId);
  const had = sessions.has(cacheKey);
  teardown(cacheKey);
  return had;
}

/* -------------------------------------------------------------------------
 * Operations
 *
 * One implementation, two ways in: called directly by the pod that holds the
 * session's lease, or handed to it over the relay by a pod that does not. The
 * split below is what keeps those two paths from drifting — a new operation is
 * a case in `runLocally` and a method on {@link AppsSession}, and it works
 * across replicas without anything else being written.
 * ---------------------------------------------------------------------- */

/** Every operation a caller can perform on a resource's applications. */
export type AppsOp =
  | "listApps"
  | "launch"
  | "windows"
  | "screenshot"
  | "a11yTree"
  | "click"
  | "typeText"
  | "pressKeys"
  | "scroll"
  | "closeWindow"
  | "end";

/**
 * A session, wherever it actually lives.
 *
 * Every method is async even where the local implementation is synchronous:
 * on a pod that does not hold the session these are network calls, and a
 * signature that hid that would be a lie the first time it mattered.
 */
export interface AppsSession {
  listApps(): Promise<AppEntry[]>;
  launch(target: { appId?: string; exec?: string }): Promise<WindowInfo>;
  windows(): Promise<WindowInfo[]>;
  screenshot(windowId: number): Promise<{ png: Buffer; width: number; height: number }>;
  a11yTree(windowId: number): Promise<A11yTreeResult>;
  click(
    windowId: number,
    x: number,
    y: number,
    options?: { button?: "left" | "right" | "middle"; clicks?: number },
  ): Promise<void>;
  typeText(windowId: number, text: string): Promise<void>;
  pressKeys(windowId: number, combo: string): Promise<void>;
  scroll(
    windowId: number,
    x: number,
    y: number,
    notches: number,
    options?: { horizontal?: boolean },
  ): Promise<void>;
  closeWindow(windowId: number): Promise<void>;
}

type Payload = Record<string, unknown>;

const num = (payload: Payload, field: string): number => {
  const value = payload[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AppsHostError(`${field} must be a number`);
  }
  return value;
};

const str = (payload: Payload, field: string): string => {
  const value = payload[field];
  if (typeof value !== "string") throw new AppsHostError(`${field} must be a string`);
  return value;
};

/**
 * Run an operation against the session this process holds, opening it if this
 * is the first call. Never call it without the lease — see {@link runOnOwner}.
 */
export async function runLocally(
  ref: AppsSessionRef,
  op: AppsOp,
  payload: Payload,
): Promise<unknown> {
  if (op === "end") return endLocalSession(ref.organizationId, ref.resourceId);

  const client = await getLocalSession(ref);
  // The lease has to outlive the work, not just the lookup: a screenshot that
  // waits on a repaint can outlast the heartbeat interval on its own.
  void touchSession(RELAY_KIND, key(ref.organizationId, ref.resourceId));

  switch (op) {
    case "listApps":
      return client.listApps();
    case "launch":
      return client.launch({
        ...(typeof payload["appId"] === "string" ? { appId: payload["appId"] } : {}),
        ...(typeof payload["exec"] === "string" ? { exec: payload["exec"] } : {}),
      });
    case "windows":
      return client.windows();
    case "screenshot":
      return client.screenshot(num(payload, "windowId"));
    case "a11yTree":
      return client.a11yTree(num(payload, "windowId"));
    case "click":
      return client.click(num(payload, "windowId"), num(payload, "x"), num(payload, "y"), {
        ...(payload["button"] ? { button: payload["button"] as "left" | "right" | "middle" } : {}),
        ...(typeof payload["clicks"] === "number" ? { clicks: payload["clicks"] } : {}),
      });
    case "typeText":
      return client.typeText(num(payload, "windowId"), str(payload, "text"));
    case "pressKeys":
      return client.pressKeys(num(payload, "windowId"), str(payload, "combo"));
    case "scroll":
      return client.scroll(
        num(payload, "windowId"),
        num(payload, "x"),
        num(payload, "y"),
        num(payload, "notches"),
        { ...(payload["horizontal"] ? { horizontal: true } : {}) },
      );
    case "closeWindow":
      return client.closeWindow(num(payload, "windowId"));
  }
}

/**
 * A result as JSON, for the hop between pods.
 *
 * Only screenshots need anything: a PNG is a Buffer, which `JSON.stringify`
 * turns into a `{type:"Buffer",data:[…]}` array — several times the size and
 * not what the far side reconstructs. Base64 costs a third and round-trips.
 */
export function encodeOpResult(op: AppsOp, value: unknown): unknown {
  if (op !== "screenshot") return value ?? null;
  const shot = value as { png: Buffer; width: number; height: number };
  return { png: shot.png.toString("base64"), width: shot.width, height: shot.height };
}

function decodeOpResult(op: AppsOp, value: unknown): unknown {
  if (op !== "screenshot") return value;
  const shot = value as { png: string; width: number; height: number };
  return { png: Buffer.from(shot.png, "base64"), width: shot.width, height: shot.height };
}

/**
 * Run an operation where the session is, wherever that turns out to be.
 *
 * The lease decides. Holding it means running here; not holding it means
 * forwarding to whoever does. The one interesting case is an owner that has
 * gone away between the claim and the call — a rollout, a crash — which is why
 * an unreachable owner is not simply an error: the lease is dropped and the
 * work is retried, so a pod dying costs a caller some latency rather than a
 * failed request.
 */
async function runOnOwner(ref: AppsSessionRef, op: AppsOp, payload: Payload): Promise<unknown> {
  const sessionKey = key(ref.organizationId, ref.resourceId);
  const call = {
    kind: RELAY_KIND,
    key: sessionKey,
    op,
    payload: {
      ...payload,
      organizationId: ref.organizationId,
      resourceId: ref.resourceId,
      ...(ref.userId ? { userId: ref.userId } : {}),
      ...(ref.sshKeyId ? { sshKeyId: ref.sshKeyId } : {}),
      ...(ref.username ? { username: ref.username } : {}),
    },
  };

  const claim = await claimSession(RELAY_KIND, sessionKey);
  if (claim.owner === "self") return runLocally(ref, op, payload);

  try {
    return decodeOpResult(op, await forwardToOwner(claim.address, call));
  } catch (error) {
    if (!(error instanceof RelayUnreachableError)) throw error;
    await releaseUnreachable(RELAY_KIND, sessionKey, claim.address);
    const retry = await claimSession(RELAY_KIND, sessionKey);
    if (retry.owner === "self") return runLocally(ref, op, payload);
    return decodeOpResult(op, await forwardToOwner(retry.address, call));
  }
}

/**
 * The driveable session for a resource. Connects and launches a compositor on
 * first use, reuses it after, and reaches it across replicas when another one
 * got there first.
 */
export function getHeadlessSession(ref: AppsSessionRef): Promise<AppsSession> {
  const run = <T>(op: AppsOp, payload: Payload = {}): Promise<T> =>
    runOnOwner(ref, op, payload) as Promise<T>;

  return Promise.resolve({
    listApps: () => run<AppEntry[]>("listApps"),
    launch: (target) => run<WindowInfo>("launch", { ...target }),
    windows: () => run<WindowInfo[]>("windows"),
    screenshot: (windowId) =>
      run<{ png: Buffer; width: number; height: number }>("screenshot", { windowId }),
    a11yTree: (windowId) => run<A11yTreeResult>("a11yTree", { windowId }),
    click: (windowId, x, y, options) => run<void>("click", { windowId, x, y, ...(options ?? {}) }),
    typeText: (windowId, text) => run<void>("typeText", { windowId, text }),
    pressKeys: (windowId, combo) => run<void>("pressKeys", { windowId, combo }),
    scroll: (windowId, x, y, notches, options) =>
      run<void>("scroll", { windowId, x, y, notches, ...(options ?? {}) }),
    closeWindow: (windowId) => run<void>("closeWindow", { windowId }),
  });
}

/** Tear down a resource's session, wherever it is (the explicit end tool). */
export async function endHeadlessSession(
  organizationId: string,
  resourceId: string,
): Promise<boolean> {
  const had = await runOnOwner({ organizationId, resourceId }, "end", {});
  return Boolean(had);
}
