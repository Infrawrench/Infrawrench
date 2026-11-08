/**
 * The cloud, driver, workflow and Linux-app operations over Effect RPC, end
 * to end: the renderer's real client against the main process's real
 * handlers and services, joined through a fake `ipcMain`/`webContents`. Only
 * the edges are fakes (the token store, `cloudFetch`, the driver maps, the
 * workflow sandbox, the app server and its SSH connection), so every payload
 * and answer is encoded and decoded against its schema as in the app.
 */
import * as net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Effect as EffectTypes } from "effect";
import type { DesktopRpcClient as DesktopRpcClientService } from "../../src/lib/rpc/desktop-client";

import type { HostPreflight } from "@infrawrench/appstream-core";

type RendererEffect<A, E> = EffectTypes.Effect<A, E, DesktopRpcClientService>;

const h = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");
  const plugins: unknown[] = [];
  const db: { current?: unknown } = {};
  return {
    EventEmitter,
    ipcMain: new EventEmitter(),
    openExternal: vi.fn(async (_url: string) => {}),
    pricingQuery: vi.fn(),
    authStatus: vi.fn(),
    cloudOrgs: vi.fn(),
    cloudFetch: vi.fn(),
    sqlQuery: vi.fn(),
    assertDockerHost: vi.fn(async (_host: string) => {}),
    runWorkflow: vi.fn(),
    startAppServer: vi.fn(),
    listApps: vi.fn(),
    chainsReleased: 0,
    plugins,
    db,
  };
});

vi.mock("electron", () => ({
  ipcMain: h.ipcMain,
  shell: { openExternal: h.openExternal },
  app: { getPath: () => "/tmp", isPackaged: false, getAppPath: () => "" },
}));
vi.mock("../instance-pricing-client", () => ({
  mainInstancePricing: { query: h.pricingQuery },
}));
vi.mock("../cloud-tokens", () => ({
  getAuthStatus: h.authStatus,
  fetchCloudOrgs: h.cloudOrgs,
  getAccessToken: async () => "access",
  forceRefreshAccessToken: async () => null,
  exchangeAuthorizationCode: async () => {},
  createPkceChallenge: () => ({ codeVerifier: "v", codeChallenge: "c", state: "s" }),
  buildAuthorizeUrl: () => "https://auth.test/authorize",
  setAuthErrorNotifier: () => {},
}));
vi.mock("../cloud-data/shared", () => ({ cloudFetch: h.cloudFetch }));
vi.mock("../drivers", () => ({
  sqlDrivers: new Map([["pg", { query: h.sqlQuery }]]),
  kvDrivers: new Map(),
  dockerDrivers: new Map([["docker", { command: async () => ({ ok: true }) }]]),
  k8sDrivers: new Map(),
  storageDrivers: new Map(),
}));
vi.mock("../local-exec-consent", () => ({
  localExecGuard: { assertDockerHost: h.assertDockerHost, assertKubeconfig: async () => {} },
}));
vi.mock("../plugin-runtime", () => ({ getDesktopHttpHostServices: () => ({}) }));
vi.mock("../db", () => ({ getSqlite: async () => h.db.current, persist: () => {} }));
vi.mock("../main-utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../main-utils")>()),
  getEncryptionKey: () => Buffer.alloc(32, 7),
}));
vi.mock("../infrafile/plugins", () => ({
  loadPlugins: async () => h.plugins,
  getPlugin: async () => undefined,
}));
vi.mock("@infrawrench/workflow-runtime", () => ({ runWorkflow: h.runWorkflow }));
vi.mock("@infrawrench/appstream-host", () => ({
  startAppServer: h.startAppServer,
  listApps: h.listApps,
  checkHost: async () => ({ preflight: preflightFixture(), plan: null }),
  probeHost: async () => preflightFixture(),
  planInstall: () => null,
  installRequirements: async () => ({ log: [], failed: [], preflight: preflightFixture() }),
}));
vi.mock("../iwappd-archive", () => ({
  getx86_64GzBinary: async () => Buffer.alloc(0),
  getArm64GzBinary: async () => Buffer.alloc(0),
}));
vi.mock("../ssh-shell", async () => {
  const { Effect } = await import("effect");
  return {
    acquireSshChain: () =>
      Effect.acquireRelease(Effect.succeed({ client: {}, intermediates: [] }), () =>
        Effect.sync(() => {
          h.chainsReleased += 1;
        }),
      ),
  };
});

function preflightFixture(): HostPreflight {
  return {
    arch: "x86_64",
    osId: "debian",
    osName: "Debian 13",
    packageManager: "apt-get",
    privilege: "root",
    requirements: [],
    staging: true,
    appCount: 1,
    ready: true,
  };
}

const { Effect, Exit, Fiber, Layer, Stream } = await import("effect");
const { RpcSerialization, RpcServer } = await import("effect/rpc");
const initSqlJs = (await import("sql.js")).default;
const { RPC_CONNECT, RPC_FRAME } = await import("../../shared/rpc/channels");
const { layerIpcSocketServer } = await import("../rpc/ipc-socket-server");
const { DesktopRpcClient } = await import("../../src/lib/rpc/desktop-client");
const { CloudAuthRpcs } = await import("../../shared/rpc/groups/cloud-auth");
const { CloudSshKeyRpcs } = await import("../../shared/rpc/groups/cloud-ssh-keys");
const { DeepLinkRpcs } = await import("../../shared/rpc/groups/deep-links");
const { InstancePricingRpcs } = await import("../../shared/rpc/groups/instance-pricing");
const { K8sPfCloudRpcs } = await import("../../shared/rpc/groups/k8s-pf-cloud");
const { LinuxAppsRpcs } = await import("../../shared/rpc/groups/linux-apps");
const { PluginDriverRpcs } = await import("../../shared/rpc/groups/plugin-drivers");
const { ProviderOAuthRpcs } = await import("../../shared/rpc/groups/provider-oauth");
const { WorkflowRpcs } = await import("../../shared/rpc/groups/workflows");
const { CloudAuthHandlers, CloudSshKeyHandlers } = await import("../rpc/handlers/cloud-auth");
const { DeepLinkHandlers } = await import("../rpc/handlers/deep-links");
const { InstancePricingHandlers } = await import("../rpc/handlers/instance-pricing");
const { K8sPfCloudHandlers } = await import("../rpc/handlers/k8s-pf-cloud");
const { LinuxAppsHandlers } = await import("../rpc/handlers/linux-apps");
const { PluginDriverHandlers } = await import("../rpc/handlers/plugin-drivers");
const { ProviderOAuthHandlers } = await import("../rpc/handlers/provider-oauth");
const { WorkflowHandlers } = await import("../rpc/handlers/workflows");
const { deliverDeepLink } = await import("../deep-links");
const { handleOAuthCallback } = await import("../cloud-auth-flow");
const { publishOAuthStatus } = await import("../provider-oauth/connect");
const { shutdownIwappdSessions } = await import("../iwappd-host");

class TestRpcs extends CloudAuthRpcs.merge(
  CloudSshKeyRpcs,
  DeepLinkRpcs,
  InstancePricingRpcs,
  K8sPfCloudRpcs,
  LinuxAppsRpcs,
  PluginDriverRpcs,
  ProviderOAuthRpcs,
  WorkflowRpcs,
) {}

const ServerLive = RpcServer.layer(TestRpcs).pipe(
  Layer.provide(
    Layer.mergeAll(
      CloudAuthHandlers,
      CloudSshKeyHandlers,
      DeepLinkHandlers,
      InstancePricingHandlers,
      K8sPfCloudHandlers,
      LinuxAppsHandlers,
      PluginDriverHandlers,
      ProviderOAuthHandlers,
      WorkflowHandlers,
    ),
  ),
  Layer.provide(RpcServer.layerProtocolSocketServer),
  Layer.provide(layerIpcSocketServer),
  Layer.provide(RpcSerialization.layerJson),
);

let nextRendererId = 500;

/** A renderer: its `webContents` as the main process sees it, and its preload bridge. */
function fakeRenderer() {
  let destroyed = false;
  const listeners = new Set<(frame: string) => void>();
  const contents = Object.assign(new h.EventEmitter(), {
    id: nextRendererId++,
    isDestroyed: () => destroyed,
    send: (channel: string, frame: string) => {
      if (channel === RPC_FRAME) for (const l of listeners) queueMicrotask(() => l(frame));
    },
  });
  return {
    bridge: {
      connect: () => h.ipcMain.emit(RPC_CONNECT, { sender: contents }),
      send: (frame: string) => h.ipcMain.emit(RPC_FRAME, { sender: contents }, frame),
      onFrame: (listener: (frame: string) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    destroy: () => {
      destroyed = true;
      contents.emit("destroyed");
    },
  };
}

type Renderer = ReturnType<typeof fakeRenderer>;

/** Run `effect` as `renderer` (a fresh one by default), with the main process serving. */
function run<A, E>(effect: RendererEffect<A, E>, renderer: Renderer = fakeRenderer()): Promise<A> {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(DesktopRpcClient.layer(renderer.bridge).pipe(Layer.provide(ServerLive))),
      Effect.scoped,
    ),
  );
}

const failureOf = <A, E>(effect: RendererEffect<A, E>) => run(Effect.flip(effect));
const waitFor = (check: () => void) => Effect.promise(() => vi.waitFor(check));

afterEach(() => {
  vi.clearAllMocks();
});

describe("InstancePricingQuery", () => {
  it("answers with the warehouse's result", async () => {
    const result = {
      columns: [{ name: "price", type: "Float64" }],
      rows: [[0.42]],
      truncated: false,
      elapsedMs: 3,
    };
    h.pricingQuery.mockResolvedValue(result);
    const answer = await run(
      DesktopRpcClient.use((rpc) => rpc.InstancePricingQuery({ sql: "SELECT 1", maxRows: 10 })),
    );
    expect(answer).toEqual(result);
    expect(h.pricingQuery).toHaveBeenCalledWith("SELECT 1", 10);
  });

  it("fails with the warehouse's sentence", async () => {
    h.pricingQuery.mockRejectedValue(new Error("Only SELECT statements are allowed"));
    const error = await failureOf(
      DesktopRpcClient.use((rpc) => rpc.InstancePricingQuery({ sql: "DROP", maxRows: 10 })),
    );
    expect(error).toMatchObject({
      _tag: "InstancePricingError",
      message: "Only SELECT statements are allowed",
    });
  });
});

describe("DeepLinks", () => {
  it("hands a link held from before the subscription first, then each new one", async () => {
    deliverDeepLink("infrawrench://open/resource?org=o1&held=1");
    const links = await run(
      Effect.gen(function* () {
        const rpc = yield* DesktopRpcClient;
        const seen: string[] = [];
        const fiber = yield* Stream.runForEach(rpc.DeepLinks(), (url) =>
          Effect.sync(() => seen.push(url)),
        ).pipe(Effect.forkChild);
        yield* waitFor(() => expect(seen).toHaveLength(1));
        deliverDeepLink("infrawrench://open/incident?org=o1&id=2");
        yield* waitFor(() => expect(seen).toHaveLength(2));
        yield* Fiber.interrupt(fiber);
        return seen;
      }),
    );
    expect(links).toEqual([
      "infrawrench://open/resource?org=o1&held=1",
      "infrawrench://open/incident?org=o1&id=2",
    ]);
  });

  it("holds a link again once the renderer that subscribed goes away", async () => {
    const renderer = fakeRenderer();
    await run(
      Effect.gen(function* () {
        const rpc = yield* DesktopRpcClient;
        const seen: string[] = [];
        yield* Stream.runForEach(rpc.DeepLinks(), (url) => Effect.sync(() => seen.push(url))).pipe(
          Effect.forkChild,
        );
        deliverDeepLink("infrawrench://open/services?org=o1&first=1");
        yield* waitFor(() => expect(seen).toHaveLength(1));
        renderer.destroy();
      }),
      renderer,
    );
    // Nothing subscribed: the next link is held for the next subscriber.
    await vi.waitFor(() => {
      deliverDeepLink("infrawrench://open/services?org=o1&later=1");
      return run(
        Effect.gen(function* () {
          const rpc = yield* DesktopRpcClient;
          const first = yield* Stream.runHead(rpc.DeepLinks());
          expect(first._tag === "Some" ? first.value : null).toBe(
            "infrawrench://open/services?org=o1&later=1",
          );
        }),
      );
    });
  });
});

describe("CloudAuth", () => {
  it("reports the session and starts the browser flow", async () => {
    h.authStatus.mockResolvedValue({
      authenticated: true,
      email: "a@b.c",
      organizationId: undefined,
    });
    const status = await run(DesktopRpcClient.use((rpc) => rpc.CloudAuthStatus()));
    expect(status).toEqual({ authenticated: true, email: "a@b.c" });
    await run(DesktopRpcClient.use((rpc) => rpc.CloudAuthStart()));
    expect(h.openExternal).toHaveBeenCalledWith("https://auth.test/authorize");
  });

  it("fails CloudAuthOrgs with the request's sentence, not an empty list", async () => {
    h.cloudOrgs.mockRejectedValue(new Error("Loading organizations failed: HTTP 502"));
    const error = await failureOf(DesktopRpcClient.use((rpc) => rpc.CloudAuthOrgs()));
    expect(error).toMatchObject({
      _tag: "CloudRequestError",
      message: "Loading organizations failed: HTTP 502",
    });
  });

  it("streams a callback that failed to every subscribed window", async () => {
    const failures = await run(
      Effect.gen(function* () {
        const rpc = yield* DesktopRpcClient;
        const seen: unknown[] = [];
        const fiber = yield* Stream.runForEach(rpc.CloudAuthErrors(), (failure) =>
          Effect.sync(() => seen.push(failure)),
        ).pipe(Effect.forkChild);
        // A callback with no flow in progress: there is no verifier to use.
        yield* Effect.promise(async () => {
          await vi.waitFor(async () => {
            await handleOAuthCallback("infrawrench://callback?code=c&state=s");
            expect(seen.length).toBeGreaterThan(0);
          });
        });
        yield* Fiber.interrupt(fiber);
        return seen;
      }),
    );
    expect(failures[0]).toEqual({
      code: "missing-code",
      message: "Sign-in callback missing code or verifier",
    });
  });
});

describe("CloudSshKeys", () => {
  const key = {
    id: "k1",
    name: "deploy",
    keyType: "ssh-ed25519",
    isImported: false,
    fingerprint: "SHA256:x",
    publicKey: "ssh-ed25519 AAAA",
    userId: "u1",
    ownerEmail: "a@b.c",
    ownerName: "A",
    createdAt: "2026-11-01T00:00:00.000Z",
  };

  it("lists the org's keys", async () => {
    h.cloudFetch.mockResolvedValue([key]);
    const keys = await run(DesktopRpcClient.use((rpc) => rpc.CloudSshKeysList({ orgId: "o1" })));
    expect(keys).toEqual([key]);
    expect(h.cloudFetch).toHaveBeenCalledWith("o1", "/ssh-keys", undefined);
  });

  it("fails on an answer of the wrong shape instead of passing it on", async () => {
    h.cloudFetch.mockResolvedValue({ id: "k2" });
    const error = await failureOf(
      DesktopRpcClient.use((rpc) => rpc.CloudSshKeysCreate({ orgId: "o1", name: "x" })),
    );
    expect(error).toMatchObject({ _tag: "CloudRequestError" });
    expect(error.message).toMatch(/unexpected shape/);
  });
});

describe("PluginDrivers", () => {
  it("carries a driver's rows with their Dates and Buffers intact", async () => {
    const at = new Date("2026-11-08T12:00:00.000Z");
    h.sqlQuery.mockResolvedValue([{ id: 1n, at, blob: Buffer.from([1, 2]), note: null }]);
    const rows = await run(
      DesktopRpcClient.use((rpc) =>
        rpc.PluginSqlQuery({ driverId: "pg", connectionString: "postgres://x", sql: "SELECT" }),
      ),
    );
    expect(rows).toEqual([{ id: 1n, at, blob: new Uint8Array([1, 2]), note: null }]);
    expect(h.sqlQuery).toHaveBeenCalledWith("postgres://x", "SELECT", undefined);
  });

  it("fails with the driver's sentence, and refuses a Docker host the guard refuses", async () => {
    const missing = await failureOf(
      DesktopRpcClient.use((rpc) =>
        rpc.PluginSqlQuery({ driverId: "nope", connectionString: "", sql: "SELECT" }),
      ),
    );
    expect(missing).toMatchObject({
      _tag: "PluginDriverError",
      message: 'No SQL driver registered for "nope"',
    });
    h.assertDockerHost.mockRejectedValueOnce(new Error("Docker host was not approved"));
    const refused = await failureOf(
      DesktopRpcClient.use((rpc) =>
        rpc.PluginDockerCommand({ driverId: "docker", dockerHost: "tcp://evil", op: "ps" }),
      ),
    );
    expect(refused).toMatchObject({ message: "Docker host was not approved" });
  });
});

describe("ProviderOAuth", () => {
  it("lists no local clients when no plugin declares one, and streams status changes", async () => {
    h.plugins.length = 0;
    const changes = await run(
      Effect.gen(function* () {
        const rpc = yield* DesktopRpcClient;
        expect(yield* rpc.ProviderOAuthLocalClients()).toEqual([]);
        const seen: unknown[] = [];
        const fiber = yield* Stream.runForEach(rpc.ProviderOAuthStatusChanges(), (change) =>
          Effect.sync(() => seen.push(change)),
        ).pipe(Effect.forkChild);
        yield* Effect.promise(() =>
          vi.waitFor(() => {
            publishOAuthStatus({ accountId: "a1", status: "reconnect_required" });
            expect(seen.length).toBeGreaterThan(0);
          }),
        );
        yield* Fiber.interrupt(fiber);
        return seen;
      }),
    );
    expect(changes[0]).toEqual({ accountId: "a1", status: "reconnect_required" });
  });

  it("fails a local connect for a plugin this build cannot connect", async () => {
    const error = await failureOf(
      DesktopRpcClient.use((rpc) =>
        rpc.ProviderOAuthConnect({ target: "local", pluginId: "github" }),
      ),
    );
    expect(error).toMatchObject({
      _tag: "ProviderOAuthError",
      message: "github cannot be connected from this app.",
    });
  });
});

describe("K8sPfCloudStart", () => {
  const config = {
    orgId: "o1",
    accountId: "a1",
    resourceId: "r1",
    peerPluginId: "kubernetes",
    namespace: "default",
    resourceType: "svc",
    resourceName: "db",
    remotePort: 5432,
  };

  const connects = (port: number) =>
    new Promise<boolean>((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });

  it("binds a local listener, and closes it when the renderer goes away", async () => {
    const renderer = fakeRenderer();
    const port = await run(
      Effect.gen(function* () {
        const rpc = yield* DesktopRpcClient;
        let bound: number | undefined;
        yield* Stream.runForEach(rpc.K8sPfCloudStart(config), (event) =>
          Effect.sync(() => {
            bound = event.localPort;
          }),
        ).pipe(Effect.forkChild);
        yield* waitFor(() => expect(bound).toBeDefined());
        return bound ?? 0;
      }),
      renderer,
    );
    expect(port).toBeGreaterThan(0);
    renderer.destroy();
    await vi.waitFor(async () => expect(await connects(port)).toBe(false));
  });

  it("fails when the port is taken", async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const address = blocker.address();
    const taken = typeof address === "object" && address ? address.port : 0;
    try {
      const error = await failureOf(
        Effect.gen(function* () {
          const rpc = yield* DesktopRpcClient;
          yield* Stream.runDrain(rpc.K8sPfCloudStart({ ...config, localPort: taken }));
        }),
      );
      expect(error).toMatchObject({ _tag: "K8sPfCloudError" });
      expect(error.message).toMatch(/EADDRINUSE/);
    } finally {
      blocker.close();
    }
  });
});

describe("WorkflowRun", () => {
  const runPayload = {
    runToken: "run-1",
    source: "export default async () => {}",
    interactive: true,
    workflowId: "wf-1",
  };

  async function workflowDb() {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE workflows (id TEXT PRIMARY KEY, assigned_secret_ids TEXT NOT NULL DEFAULT '[]', deleted_at TEXT, updated_at TEXT);
      CREATE TABLE workflow_secrets (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, encrypted_value TEXT, value_iv TEXT, created_at TEXT, updated_at TEXT);
      INSERT INTO workflows (id) VALUES ('wf-1');`);
    return db;
  }

  it("streams host calls with their argument holes, logs, and the result", async () => {
    h.db.current = await workflowDb();
    const created = new Date("2026-11-08T00:00:00.000Z");
    h.runWorkflow.mockImplementation(
      async (options: {
        host: { listResources: (...args: unknown[]) => Promise<unknown> };
        onLog: (entry: unknown) => void;
      }) => {
        options.onLog({ at: 1, level: "info", message: "listing" });
        const resources = await options.host.listResources("acc", "vm", undefined);
        return {
          status: "success",
          logs: [],
          output: resources,
          startedAt: 0,
          finishedAt: 1,
          durationMs: 1,
        };
      },
    );
    const { calls, logs, result } = await run(
      Effect.gen(function* () {
        const rpc = yield* DesktopRpcClient;
        const calls: Array<{ method: string; args: readonly unknown[] }> = [];
        const logs: string[] = [];
        let result: unknown;
        yield* Stream.runForEach(rpc.WorkflowRun(runPayload), (event) => {
          if (event._tag === "HostCall") {
            calls.push({ method: event.method, args: event.args });
            return rpc.WorkflowHostReply({
              _tag: "Ok",
              callId: event.callId,
              value: [{ id: "r1", createdAt: created }],
            });
          }
          if (event._tag === "Log") return Effect.sync(() => logs.push(event.entry.message));
          return Effect.sync(() => {
            result = event.result;
          });
        });
        return { calls, logs, result };
      }),
    );
    expect(calls).toEqual([{ method: "listResources", args: ["acc", "vm", undefined] }]);
    expect(calls[0]?.args).toHaveLength(3);
    expect(logs).toEqual(["listing"]);
    expect(result).toMatchObject({ status: "success", output: [{ id: "r1", createdAt: created }] });
  });

  it("fails before it starts when the workflow is gone", async () => {
    h.db.current = await workflowDb();
    const error = await failureOf(
      Effect.gen(function* () {
        const rpc = yield* DesktopRpcClient;
        yield* Stream.runDrain(rpc.WorkflowRun({ ...runPayload, workflowId: "missing" }));
      }),
    );
    expect(error).toMatchObject({ _tag: "WorkflowRunError", message: "Workflow not found" });
    expect(h.runWorkflow).not.toHaveBeenCalled();
  });

  it("aborts the run and fails its waiting host calls when the renderer goes away", async () => {
    h.db.current = await workflowDb();
    let signal: AbortSignal | undefined;
    let promptOutcome: unknown;
    h.runWorkflow.mockImplementation(
      async (options: {
        host: { prompt: (spec: unknown) => Promise<unknown> };
        signal: AbortSignal;
      }) => {
        signal = options.signal;
        promptOutcome = await options.host.prompt({ kind: "text" }).catch((e: unknown) => e);
        return { status: "canceled", logs: [], startedAt: 0, finishedAt: 0, durationMs: 0 };
      },
    );
    const renderer = fakeRenderer();
    await run(
      Effect.gen(function* () {
        const rpc = yield* DesktopRpcClient;
        let asked = false;
        yield* Stream.runForEach(rpc.WorkflowRun({ ...runPayload, runToken: "run-2" }), (event) =>
          Effect.sync(() => {
            if (event._tag === "HostCall") asked = true;
          }),
        ).pipe(Effect.forkChild);
        yield* waitFor(() => expect(asked).toBe(true));
      }),
      renderer,
    );
    renderer.destroy();
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    await vi.waitFor(() =>
      expect(promptOutcome).toMatchObject({
        message: "The window was closed before the workflow finished.",
      }),
    );
  });

  it("stores a secret encrypted, lists it by name only, and refuses a conflicting name", async () => {
    h.db.current = await workflowDb();
    const saved = await run(
      DesktopRpcClient.use((rpc) =>
        rpc.WorkflowSecretUpsert({ name: "db.password", value: "hunter2" }),
      ),
    );
    expect(saved).toMatchObject({ name: "db.password", hasValue: true });
    const listed = await run(DesktopRpcClient.use((rpc) => rpc.WorkflowSecretsList()));
    expect(listed).toEqual([saved]);
    const conflict = await failureOf(
      DesktopRpcClient.use((rpc) => rpc.WorkflowSecretUpsert({ name: "db", value: "x" })),
    );
    expect(conflict).toMatchObject({
      _tag: "WorkflowSecretError",
      message: 'Workflow secret "db" conflicts with existing secret "db.password".',
    });
  });
});

describe("Linux apps", () => {
  const config = { host: "vm", port: 22, username: "root", privateKey: "KEY" };

  function fakeSession() {
    const handlers: { data?: (chunk: Buffer) => void; close?: (code: number | null) => void } = {};
    return {
      session: {
        onData: (handler: (chunk: Buffer) => void) => {
          handlers.data = handler;
        },
        onClose: (handler: (code: number | null) => void) => {
          handlers.close = handler;
        },
        write: vi.fn(),
        close: vi.fn(() => handlers.close?.(0)),
        arch: "x86_64",
      },
      handlers,
    };
  }

  it("opens a session, relays frames both ways, and closes it when interrupted", async () => {
    const fake = fakeSession();
    h.startAppServer.mockResolvedValue(fake.session);
    const released = h.chainsReleased;
    const received = await run(
      Effect.gen(function* () {
        const rpc = yield* DesktopRpcClient;
        const frames: number[][] = [];
        let sessionId: string | undefined;
        const fiber = yield* Stream.runForEach(rpc.AppsSessionOpen(config), (event) =>
          Effect.sync(() => {
            if (event._tag === "Opened") sessionId = event.sessionId;
            if (event._tag === "Data") frames.push([...event.data]);
          }),
        ).pipe(Effect.forkChild);
        yield* waitFor(() => expect(sessionId).toBeDefined());
        fake.handlers.data?.(Buffer.from([9, 8, 7]));
        yield* rpc.AppsSessionWrite({ sessionId: sessionId ?? "", data: new Uint8Array([1, 2]) });
        yield* waitFor(() => expect(frames).toEqual([[9, 8, 7]]));
        yield* waitFor(() => expect(fake.session.write).toHaveBeenCalledOnce());
        yield* Fiber.interrupt(fiber);
        return frames;
      }),
    );
    expect(received).toEqual([[9, 8, 7]]);
    expect([...fake.session.write.mock.calls[0]![0]]).toEqual([1, 2]);
    await vi.waitFor(() => expect(fake.session.close).toHaveBeenCalled());
    await vi.waitFor(() => expect(h.chainsReleased).toBe(released + 1));
  });

  it("ends the stream when the app server exits, as on quit", async () => {
    const fake = fakeSession();
    h.startAppServer.mockResolvedValue(fake.session);
    const exit = await run(
      Effect.gen(function* () {
        const rpc = yield* DesktopRpcClient;
        let opened = false;
        const fiber = yield* Stream.runForEach(rpc.AppsSessionOpen(config), (event) =>
          Effect.sync(() => {
            if (event._tag === "Opened") opened = true;
          }),
        ).pipe(Effect.forkChild);
        yield* waitFor(() => expect(opened).toBe(true));
        shutdownIwappdSessions();
        return yield* Fiber.await(fiber);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("fails the open with the app server's error", async () => {
    h.startAppServer.mockRejectedValue(new Error("no writable staging directory"));
    const error = await failureOf(
      Effect.gen(function* () {
        const rpc = yield* DesktopRpcClient;
        yield* Stream.runDrain(rpc.AppsSessionOpen(config));
      }),
    );
    expect(error).toMatchObject({
      _tag: "LinuxAppsError",
      message: "no writable staging directory",
    });
  });

  it("lists apps, and fails on a listing of the wrong shape", async () => {
    h.listApps.mockResolvedValueOnce([{ id: "org.gnome.Nautilus.desktop", name: "Files" }]);
    const apps = await run(DesktopRpcClient.use((rpc) => rpc.AppsList({ config, iconSize: 48 })));
    expect(apps).toEqual([{ id: "org.gnome.Nautilus.desktop", name: "Files" }]);
    h.listApps.mockResolvedValueOnce([{ id: 1 }]);
    const error = await failureOf(DesktopRpcClient.use((rpc) => rpc.AppsList({ config })));
    expect(error).toMatchObject({ _tag: "LinuxAppsError" });
  });
});
