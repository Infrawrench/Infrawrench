/**
 * The main process's local-host operations over Effect RPC, end to end: the
 * renderer's real client talks through the fake IPC transport to the real
 * server, handlers and services, over a real in-memory SQLite database with
 * the app's migrations. Only Electron, node-pty, `kubectl`'s process and the
 * binary lookup are fakes, so every payload and answer is encoded and
 * decoded against its schema exactly as in the app.
 *
 * Groups: the renderer's SQLite access (and the `db-guard` boundary in front
 * of it), local credentials, stored secrets, the app shell, and local
 * Kubernetes (terminals, port-forwards and cluster requests).
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Fiber, Stream } from "effect";
import type { K8sApiRequest } from "../../shared/rpc/groups/k8s-local";

const h = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");

  /** node-pty's `IPty`, recording what the PTY was told. */
  class FakePty {
    static readonly instances: FakePty[] = [];
    readonly written: string[] = [];
    readonly sizes: { cols: number; rows: number }[] = [];
    killed = false;
    private dataListener: ((data: string) => void) | undefined;
    private exitListener: (() => void) | undefined;
    constructor(
      readonly file: string,
      readonly args: string[],
    ) {
      FakePty.instances.push(this);
    }
    onData(listener: (data: string) => void) {
      this.dataListener = listener;
    }
    onExit(listener: () => void) {
      this.exitListener = listener;
    }
    write(data: string) {
      this.written.push(data);
    }
    resize(cols: number, rows: number) {
      this.sizes.push({ cols, rows });
    }
    kill() {
      this.killed = true;
      setTimeout(() => this.exit(), 0);
    }
    emitData(data: string) {
      this.dataListener?.(data);
    }
    exit() {
      this.exitListener?.();
    }
    /** The kubeconfig path the process was given. */
    kubeconfigPath(): string {
      const i = this.args.indexOf("--kubeconfig");
      return this.args[i + 1] ?? "";
    }
  }

  /** `kubectl port-forward`'s child process. */
  class FakeChild extends EventEmitter {
    static readonly instances: FakeChild[] = [];
    readonly stdout = new EventEmitter();
    readonly stderr = new EventEmitter();
    killed = false;
    constructor(readonly args: string[]) {
      super();
      FakeChild.instances.push(this);
    }
    kill() {
      this.killed = true;
      setTimeout(() => this.emit("exit", null), 0);
      return true;
    }
  }

  return {
    EventEmitter,
    FakePty,
    FakeChild,
    sqlite: undefined as import("sql.js").Database | undefined,
    persisted: 0,
    binaries: new Set(["kubectl", "k9s"]),
    consent: true,
    openedUrls: [] as string[],
    notifications: [] as { title: string; body: string }[],
    dialogPaths: [] as string[],
    clipboardPng: null as Buffer | null,
  };
});

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class Notification extends EventEmitter {
    static isSupported = () => true;
    constructor(private readonly options: { title: string; body: string }) {
      super();
    }
    show() {
      h.notifications.push(this.options);
    }
  }
  return {
    ipcMain: new EventEmitter(),
    app: {
      getPath: () => "/nonexistent",
      getAppPath: () => "",
      getVersion: () => "0.0.0",
      isPackaged: false,
      on: () => undefined,
    },
    BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
    Notification,
    clipboard: {
      readImage: () => ({
        isEmpty: () => h.clipboardPng === null,
        toPNG: () => h.clipboardPng ?? Buffer.alloc(0),
      }),
    },
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: h.dialogPaths }),
      // The local-exec consent prompt: button 1 is "Allow".
      showMessageBox: async () => ({ response: h.consent ? 1 : 0 }),
    },
    shell: {
      openExternal: async (url: string) => {
        h.openedUrls.push(url);
      },
    },
    safeStorage: { isEncryptionAvailable: () => false },
  };
});
vi.mock("node-pty", () => ({
  spawn: (file: string, args: string[]) => new h.FakePty(file, args),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const spawn = (_file: string, args: string[]) => new h.FakeChild(args);
  return { ...actual, spawn, default: { ...actual, spawn } };
});
vi.mock("../pty", () => ({
  resolveBinaryPath: (command: string) => {
    if (!h.binaries.has(command)) throw new Error(`Command not found: ${command}`);
    return `/usr/local/bin/${command}`;
  },
  ensureNodePtySpawnHelperExecutable: () => undefined,
  buildPtyEnv: () => ({}),
}));
vi.mock("../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db")>()),
  getSqlite: async () => {
    if (!h.sqlite) throw new Error("no database");
    return h.sqlite;
  },
  persist: () => {
    h.persisted += 1;
  },
}));
vi.mock("../main-utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../main-utils")>()),
  getEncryptionKey: () => Buffer.alloc(32, 7),
}));
vi.mock("../../src/plugins/loader", () => ({
  loadPlugins: async () => [],
  getPlugin: async () => undefined,
}));

const initSqlJs = (await import("sql.js")).default;
const { MIGRATIONS } = await import("../../src/db/schema");
const { callDesktopRpc, failureOf, fakeRenderer, withSharedServer } = await import("./rpc-harness");
const { DesktopRpcClient } = await import("../../src/lib/rpc/desktop-client");
const { MAX_PARAMS } = await import("../db-guard");
const { hasBackgroundWork } = await import("../app-shell");
const { isDialogBlessedPath } = await import("../main-utils");
const { generateEd25519OpenSshKeyPair } = await import("@infrawrench/ssh-tunnel-core");

const SQL = await initSqlJs();

beforeEach(() => {
  const db = new SQL.Database();
  db.run("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) {
    for (const stmt of migration.split(";").flatMap((s) => (s.trim() ? [s.trim()] : []))) {
      try {
        db.run(stmt);
      } catch (err) {
        if (!String(err).includes("duplicate column name")) throw err;
      }
    }
  }
  h.sqlite = db;
  h.persisted = 0;
  h.consent = true;
  h.binaries = new Set(["kubectl", "k9s"]);
  h.openedUrls = [];
  h.notifications = [];
  h.FakePty.instances.length = 0;
  h.FakeChild.instances.length = 0;
});

const waitFor = (check: () => void) => Effect.promise(() => vi.waitFor(check));

const tableNames = () =>
  (h.sqlite?.exec("SELECT name FROM sqlite_master WHERE type = 'table'")[0]?.values ?? []).map(
    ([name]) => String(name),
  );

describe("LocalDbSelect / LocalDbExecute", () => {
  it("runs a guarded statement and reads the rows back", async () => {
    const result = await callDesktopRpc(
      Effect.gen(function* () {
        const rpc = yield* DesktopRpcClient;
        const written = yield* rpc.LocalDbExecute({
          sql: "INSERT INTO dashboards (id, name, is_default) VALUES ($1, $2, $3)",
          params: ["d1", "Main", true],
        });
        const rows = yield* rpc.LocalDbSelect({
          sql: "SELECT id, name, is_default FROM dashboards WHERE id = $1",
          params: ["d1"],
        });
        return { written, rows };
      }),
    );
    expect(result.written).toEqual({ rowsAffected: 1, lastInsertId: 0 });
    // A boolean binds as 1, as sql.js binds it.
    expect(result.rows).toEqual([{ id: "d1", name: "Main", is_default: 1 }]);
    expect(h.persisted).toBe(1);
  });

  it.each([
    ["a PRAGMA", "PRAGMA foreign_keys = OFF", [], 'statement type "PRAGMA" is not allowed'],
    ["an ATTACH", "ATTACH DATABASE '/tmp/x.db' AS x", [], 'statement type "ATTACH" is not allowed'],
    ["two statements", "SELECT 1; DROP TABLE accounts", [], "multi-statement SQL is not allowed"],
    ["an empty statement", "", [], "sql is empty"],
    ["an object parameter", "SELECT ?", [{ id: 1 }], "params[0] has unsupported type"],
    ["an array parameter", "SELECT ?, ?", ["ok", [1]], "params[1] has unsupported type"],
    [
      "too many parameters",
      "SELECT 1",
      Array.from({ length: MAX_PARAMS + 1 }, () => 1),
      `params exceeds ${MAX_PARAMS} entries (${MAX_PARAMS + 1})`,
    ],
  ])("refuses %s before the database sees it", async (_case, sql, params, refusal) => {
    const select = await failureOf(
      DesktopRpcClient.use((rpc) => rpc.LocalDbSelect({ sql, params })),
    );
    const execute = await failureOf(
      DesktopRpcClient.use((rpc) => rpc.LocalDbExecute({ sql, params })),
    );
    for (const error of [select, execute]) {
      expect(error._tag).toBe("LocalDatabaseError");
      expect(error.message).toBe(`db guard: ${refusal}`);
    }
    expect(tableNames()).toContain("accounts");
    expect(h.persisted).toBe(0);
  });

  it("answers the database's own error as its sentence", async () => {
    const error = await failureOf(
      DesktopRpcClient.use((rpc) =>
        rpc.LocalDbSelect({ sql: "SELECT * FROM no_such_table", params: [] }),
      ),
    );
    expect(error._tag).toBe("LocalDatabaseError");
    expect(error.message).toContain("no such table: no_such_table");
  });
});

describe("LocalAccountCredentials / Save / Create", () => {
  const storedRow = (id: string) =>
    h.sqlite?.exec("SELECT encrypted_credentials, oauth_status FROM accounts WHERE id = ?", [id])[0]
      ?.values[0];

  it("stores credentials encrypted and hands the plaintext back", async () => {
    const credentials = await callDesktopRpc(
      Effect.gen(function* () {
        const rpc = yield* DesktopRpcClient;
        yield* rpc.LocalAccountCreate({
          accountId: "acc-1",
          pluginId: "fake",
          displayName: "Fake",
          credentials: { token: "secret-token" },
        });
        yield* rpc.LocalAccountSaveCredentials({
          accountId: "acc-1",
          credentials: { token: "rotated-token" },
        });
        return yield* rpc.LocalAccountCredentials({ accountId: "acc-1", refresh: false });
      }),
    );
    expect(credentials).toEqual({ token: "rotated-token" });
    const [ciphertext] = storedRow("acc-1") ?? [];
    expect(String(ciphertext)).toMatch(/^v2:/);
    expect(String(ciphertext)).not.toContain("rotated-token");
  });

  it("fails with the sentence for an account that is not there", async () => {
    const read = await failureOf(
      DesktopRpcClient.use((rpc) => rpc.LocalAccountCredentials({ accountId: "missing" })),
    );
    expect(read).toMatchObject({ _tag: "LocalCredentialsError", message: "Account not found" });
    const save = await failureOf(
      DesktopRpcClient.use((rpc) =>
        rpc.LocalAccountSaveCredentials({ accountId: "missing", credentials: { a: "b" } }),
      ),
    );
    expect(save).toMatchObject({ _tag: "LocalCredentialsError", message: "Account not found" });
  });

  it("refuses an account id the old IPC schema refused", async () => {
    await expect(
      callDesktopRpc(DesktopRpcClient.use((rpc) => rpc.LocalAccountCredentials({ accountId: "" }))),
    ).rejects.toThrow();
  });
});

describe("LocalSecretRpcs", () => {
  it("round-trips SSH keys, tunnel config keys and secret fields under their AADs", async () => {
    const { privateKey } = await generateEd25519OpenSshKeyPair("test");
    const result = await callDesktopRpc(
      Effect.gen(function* () {
        const rpc = yield* DesktopRpcClient;
        yield* rpc.LocalSshKeySave({ keyId: "k1", name: "mine", privateKey });
        const readBack = yield* rpc.LocalSshKeyPrivateKey({ keyId: "k1" });
        const publicKey = yield* rpc.LocalSshKeyPublicKey({ keyId: "k1" });
        const agent = yield* rpc.LocalSshKeyEnsureAgentKey();
        const agentAgain = yield* rpc.LocalSshKeyEnsureAgentKey();
        const tunnel = yield* rpc.LocalTunnelConfigKeyEncrypt({
          tunnelConfigId: "t1",
          privateKey: "tunnel-key",
        });
        const tunnelKey = yield* rpc.LocalTunnelConfigKeyDecrypt({
          tunnelConfigId: "t1",
          ...tunnel,
        });
        const field = yield* rpc.LocalSecretFieldEncrypt({
          resourceId: "r1",
          fieldKey: "password",
          plaintext: "hunter2",
        });
        const fieldValue = yield* rpc.LocalSecretFieldDecrypt({
          resourceId: "r1",
          fieldKey: "password",
          ...field,
        });
        return { readBack, publicKey, agent, agentAgain, tunnel, tunnelKey, field, fieldValue };
      }),
    );
    expect(result.readBack).toBe(privateKey);
    expect(result.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+$/);
    expect(result.agent).toMatchObject({ name: "infrawrench-agent" });
    expect(result.agent.publicKey).toMatch(/^ssh-ed25519 \S+ infrawrench-agent$/);
    // The agent key is made once and found by name after that.
    expect(result.agentAgain).toEqual(result.agent);
    expect(result.tunnelKey).toBe("tunnel-key");
    expect(result.tunnel.ciphertext).not.toContain("tunnel-key");
    expect(result.fieldValue).toBe("hunter2");
    expect(result.field.ciphertext).toMatch(/^v2:/);
  });

  it("refuses a missing key and a ciphertext moved to another field", async () => {
    const missing = await failureOf(
      DesktopRpcClient.use((rpc) => rpc.LocalSshKeyPrivateKey({ keyId: "nope" })),
    );
    expect(missing).toMatchObject({ _tag: "LocalSecretError", message: "SSH key not found" });

    const swapped = await failureOf(
      Effect.gen(function* () {
        const rpc = yield* DesktopRpcClient;
        const field = yield* rpc.LocalSecretFieldEncrypt({
          resourceId: "r1",
          fieldKey: "password",
          plaintext: "hunter2",
        });
        // The AAD binds the ciphertext to (r1, password): another field cannot read it.
        return yield* rpc.LocalSecretFieldDecrypt({
          resourceId: "r1",
          fieldKey: "apiKey",
          ...field,
        });
      }),
    );
    expect(swapped._tag).toBe("LocalSecretError");
  });
});

describe("AppShellRpcs", () => {
  it("opens web URLs, notifies, blesses picked paths, reads the clipboard and counts background work", async () => {
    h.dialogPaths = ["/Users/me/Downloads"];
    h.clipboardPng = Buffer.from([0x89, 0x50]);
    const result = await callDesktopRpc(
      Effect.gen(function* () {
        const rpc = yield* DesktopRpcClient;
        yield* rpc.AppOpenExternalUrl({ url: "https://infrawrench.com/docs" });
        yield* rpc.AppShowNotification({ title: "CPU above range", body: "95%" });
        const picked = yield* rpc.AppShowOpenDialog({
          properties: ["openDirectory"],
          title: "Choose download destination",
        });
        const image = yield* rpc.AppReadClipboardImage();
        yield* rpc.AppSetPingsActive({ count: 2.7 });
        const busy = hasBackgroundWork();
        yield* rpc.AppSetPingsActive({ count: -1 });
        yield* rpc.AppSetCronsActive({ count: 0 });
        return { picked, image, busy, idle: !hasBackgroundWork() };
      }),
    );
    expect(h.openedUrls).toEqual(["https://infrawrench.com/docs"]);
    expect(h.notifications).toEqual([{ title: "CPU above range", body: "95%" }]);
    expect(result.picked).toEqual({ canceled: false, filePaths: ["/Users/me/Downloads"] });
    expect(isDialogBlessedPath("/Users/me/Downloads/file.txt")).toBe(true);
    expect(result.image).toEqual({ pngBase64: "iVA=", mime: "image/png" });
    expect(result).toMatchObject({ busy: true, idle: true });
  });

  it("refuses to hand the system anything but http(s) and mailto", async () => {
    const scheme = await failureOf(
      DesktopRpcClient.use((rpc) => rpc.AppOpenExternalUrl({ url: "file:///etc/passwd" })),
    );
    expect(scheme).toMatchObject({
      _tag: "ExternalUrlRefused",
      message: 'open_external_url: scheme "file:" is not permitted',
    });
    const invalid = await failureOf(
      DesktopRpcClient.use((rpc) => rpc.AppOpenExternalUrl({ url: "not a url" })),
    );
    expect(invalid.message).toBe("open_external_url: invalid URL");
    expect(h.openedUrls).toEqual([]);
  });
});

const KUBECONFIG = "apiVersion: v1\nkind: Config\nclusters: []\n";
const EXEC_KUBECONFIG = [
  "apiVersion: v1",
  "kind: Config",
  "users:",
  "- name: u",
  "  user:",
  "    exec:",
  "      apiVersion: client.authentication.k8s.io/v1beta1",
  "      command: /tmp/evil",
  "",
].join("\n");

const execConfig = (kubeconfig = KUBECONFIG) => ({
  kubeconfig,
  namespace: "default",
  podName: "web-0",
  containerName: "app",
  cols: 80,
  rows: 24,
});

/** Open `kubectl exec` and collect its output until the test is done with it. */
const openExec = (kubeconfig?: string) =>
  Effect.gen(function* () {
    const rpc = yield* DesktopRpcClient;
    const output: string[] = [];
    let sessionId: string | undefined;
    const fiber = yield* Stream.runForEach(rpc.K8sExecOpen(execConfig(kubeconfig)), (event) =>
      Effect.sync(() => {
        if (event._tag === "Opened") sessionId = event.sessionId;
        else output.push(Buffer.from(event.data).toString("utf8"));
      }),
    ).pipe(Effect.forkChild);
    yield* waitFor(() => expect(sessionId).toBeDefined());
    const pty = h.FakePty.instances.at(-1);
    if (!pty) throw new Error("no PTY was spawned");
    return { fiber, output, sessionId: sessionId ?? "", pty };
  });

describe("K8sLocalRpcs terminals", () => {
  it("streams kubectl exec, takes input, and removes the kubeconfig when the process exits", async () => {
    const result = await callDesktopRpc(
      Effect.gen(function* () {
        const rpc = yield* DesktopRpcClient;
        const { fiber, output, sessionId, pty } = yield* openExec();
        const kubeconfigPath = pty.kubeconfigPath();
        const mode = fs.statSync(kubeconfigPath).mode & 0o777;
        const kubeconfig = fs.readFileSync(kubeconfigPath, "utf8");
        pty.emitData("$ ");
        yield* waitFor(() => expect(output).toEqual(["$ "]));
        yield* rpc.K8sExecWrite({ sessionId, data: "ls\n" });
        yield* rpc.K8sExecResize({ sessionId, cols: 120, rows: 40 });
        pty.exit();
        const exit = yield* Fiber.await(fiber);
        return { exit, pty, kubeconfigPath, mode, kubeconfig };
      }),
    );
    expect(result.pty.file).toBe("/usr/local/bin/kubectl");
    expect(result.pty.args.slice(0, 7)).toEqual([
      "exec",
      "-it",
      "web-0",
      "-c",
      "app",
      "-n",
      "default",
    ]);
    expect(result.mode).toBe(0o600);
    expect(result.kubeconfig).toBe(KUBECONFIG);
    expect(result.pty.written).toEqual(["ls\n"]);
    expect(result.pty.sizes).toEqual([{ cols: 120, rows: 40 }]);
    expect(result.exit._tag).toBe("Success");
    expect(fs.existsSync(result.kubeconfigPath)).toBe(false);
  });

  it("interrupting the stream kills the process and removes its kubeconfig", async () => {
    const pty = await callDesktopRpc(
      Effect.gen(function* () {
        const rpc = yield* DesktopRpcClient;
        const { fiber, sessionId, pty } = yield* openExec();
        yield* Fiber.interrupt(fiber);
        yield* waitFor(() => expect(pty.killed).toBe(true));
        // A session that is gone takes no more input.
        yield* rpc.K8sExecWrite({ sessionId, data: "late\n" });
        return pty;
      }),
    );
    expect(pty.written).toEqual([]);
    expect(fs.existsSync(pty.kubeconfigPath())).toBe(false);
  });

  it("a renderer that goes away kills its terminals", async () => {
    const renderer = fakeRenderer();
    const pty = await callDesktopRpc(
      Effect.gen(function* () {
        const { pty } = yield* openExec();
        renderer.destroy();
        yield* waitFor(() => expect(pty.killed).toBe(true));
        return pty;
      }),
      renderer,
    );
    await vi.waitFor(() => expect(fs.existsSync(pty.kubeconfigPath())).toBe(false));
  });

  it("another renderer cannot type into or resize a session it did not open", async () => {
    const owner = fakeRenderer();
    const other = fakeRenderer();
    const pty = await withSharedServer((as) =>
      as(
        owner,
        Effect.gen(function* () {
          const { sessionId, pty } = yield* openExec();
          yield* as(
            other,
            DesktopRpcClient.use((rpc) =>
              Effect.andThen(
                rpc.K8sExecWrite({ sessionId, data: "rm -rf /\n" }),
                rpc.K8sExecResize({ sessionId, cols: 1, rows: 1 }),
              ),
            ),
          );
          // The owner still can.
          yield* DesktopRpcClient.use((rpc) => rpc.K8sExecWrite({ sessionId, data: "ls\n" }));
          yield* waitFor(() => expect(pty.written).toEqual(["ls\n"]));
          return pty;
        }),
      ),
    );
    expect(pty.sizes).toEqual([]);
  });

  it("fails before spawning when consent is declined or the binary is missing", async () => {
    h.consent = false;
    const declined = await failureOf(
      Effect.gen(function* () {
        const rpc = yield* DesktopRpcClient;
        return yield* Stream.runDrain(rpc.K8sExecOpen(execConfig(EXEC_KUBECONFIG)));
      }),
    );
    expect(declined._tag).toBe("K8sLocalError");
    expect(h.FakePty.instances).toEqual([]);

    h.binaries = new Set();
    const missing = await failureOf(
      Effect.gen(function* () {
        const rpc = yield* DesktopRpcClient;
        return yield* Stream.runDrain(rpc.K9sOpen({ kubeconfig: KUBECONFIG, cols: 80, rows: 24 }));
      }),
    );
    expect(missing).toMatchObject({
      _tag: "K8sLocalError",
      message: "Failed to launch k9s: Command not found: k9s",
    });
    const installed = await callDesktopRpc(DesktopRpcClient.use((rpc) => rpc.K9sCheck()));
    expect(installed).toBe(false);
  });
});

/** Open a port-forward; resolves with the stream's fiber, its first event and kubectl's process. */
const openForward = Effect.gen(function* () {
  const rpc = yield* DesktopRpcClient;
  const events: number[] = [];
  const fiber = yield* Stream.runForEach(
    rpc.K8sPortForwardOpen({
      kubeconfig: KUBECONFIG,
      namespace: "default",
      resourceType: "svc",
      resourceName: "db",
      remotePort: 5432,
    }),
    (event) => Effect.sync(() => events.push(event.localPort)),
  ).pipe(Effect.forkChild);
  yield* waitFor(() => expect(h.FakeChild.instances).toHaveLength(1));
  const child = h.FakeChild.instances[0];
  if (!child) throw new Error("kubectl was not spawned");
  return { fiber, events, child };
});

describe("K8sLocalRpcs port-forward", () => {
  it("reports the bound port, ends when kubectl exits, and is killed with the renderer", async () => {
    const ended = await callDesktopRpc(
      Effect.gen(function* () {
        const { fiber, events, child } = yield* openForward;
        expect(child.args.slice(0, 3)).toEqual(["port-forward", "svc/db", "0:5432"]);
        child.stdout.emit("data", Buffer.from("Forwarding from 127.0.0.1:54321 -> 5432\n"));
        yield* waitFor(() => expect(events).toEqual([54321]));
        child.emit("exit", 0);
        return yield* Fiber.await(fiber);
      }),
    );
    expect(ended._tag).toBe("Success");

    h.FakeChild.instances.length = 0;
    const renderer = fakeRenderer();
    const child = await callDesktopRpc(
      Effect.gen(function* () {
        const { events, child } = yield* openForward;
        child.stdout.emit("data", Buffer.from("Forwarding from [::1]:54322 -> 5432\n"));
        yield* waitFor(() => expect(events).toEqual([54322]));
        renderer.destroy();
        yield* waitFor(() => expect(child.killed).toBe(true));
        return child;
      }),
      renderer,
    );
    expect(child.killed).toBe(true);
  });

  it("fails with kubectl's stderr when it exits before forwarding", async () => {
    const error = await failureOf(
      Effect.gen(function* () {
        const { fiber, child } = yield* openForward;
        child.stderr.emit("data", Buffer.from('error: services "db" not found\n'));
        child.emit("exit", 1);
        return yield* Fiber.join(fiber);
      }),
    );
    expect(error).toMatchObject({
      _tag: "K8sLocalError",
      message: 'kubectl port-forward exited with code 1: error: services "db" not found',
    });
  });
});

describe("K8sApiRequest", () => {
  const received: { method: string; body: Buffer }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ method: req.method ?? "", body: Buffer.concat(chunks) });
      res.setHeader("content-type", "application/octet-stream");
      res.end(Buffer.from([0, 255, 1]));
    });
  });
  const listening = new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address: AddressInfo | string | null = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  afterAll(() => {
    server.close();
  });

  it("refuses this machine until an account names it, then carries bytes both ways", async () => {
    const port = await listening;
    const url = `http://127.0.0.1:${port}/v1/objects`;
    const request: K8sApiRequest = {
      url,
      method: "POST",
      headers: {},
      bodyBytes: new Uint8Array([7, 8, 9]),
      responseEncoding: "binary",
    };

    // The SSRF guard: loopback is off limits to a renderer request...
    const refused = await failureOf(DesktopRpcClient.use((rpc) => rpc.K8sApiRequest(request)));
    expect(refused._tag).toBe("K8sLocalError");
    expect(refused.message).toMatch(/refused private\/loopback host "127\.0\.0\.1"/);
    expect(received).toEqual([]);

    // ...until a stored account's credentials name that endpoint.
    const response = await callDesktopRpc(
      Effect.gen(function* () {
        const rpc = yield* DesktopRpcClient;
        yield* rpc.LocalAccountCreate({
          accountId: "acc-local",
          pluginId: "fake",
          displayName: "Local service",
          credentials: { endpoint: `http://127.0.0.1:${port}` },
        });
        return yield* rpc.K8sApiRequest(request);
      }),
    );
    expect(received).toEqual([{ method: "POST", body: Buffer.from([7, 8, 9]) }]);
    expect(response.status).toBe(200);
    expect(response.body).toBe("");
    expect(response.rawBody).toEqual(new Uint8Array([0, 255, 1]));
  });

  it("refuses a scheme it does not speak", async () => {
    const error = await failureOf(
      DesktopRpcClient.use((rpc) =>
        rpc.K8sApiRequest({ url: "ftp://example.com/x", method: "GET", headers: {} }),
      ),
    );
    expect(error.message).toBe('k8s_api_request: scheme "ftp:" not permitted');
  });
});
