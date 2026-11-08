import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const getCloudWsUrl = vi.fn();

vi.mock("../invoke", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("../cloud-ws", () => ({ getCloudWsUrl: () => getCloudWsUrl() }));
vi.mock("../rpc/client", async () => (await import("./fake-rpc")).fakeRpcClientModule);

import { type Cause, Effect, Predicate, Queue, Stream } from "effect";
import {
  K8sLocalError,
  type K8sPortForwardEvent,
  type K8sTerminalEvent,
} from "../../../shared/rpc/groups/k8s-local";
import { checkK9sInstalled, openK8sExec, openK9s, startPortForward } from "../k8s-dispatch";
import { K8sPfCloudError } from "../../../shared/rpc/groups/k8s-pf-cloud";
import { fakeRpc, resetFakeRpc } from "./fake-rpc";

/**
 * A main process that answers `open` with a stream the test drives: `emit`
 * pushes an event, `end` is the process exiting, and `isInterrupted` says
 * whether the renderer interrupted the stream (what kills the process).
 */
function fakeStream<A>(tag: string, first?: A) {
  const opened: unknown[] = [];
  let interrupted = false;
  let output: Queue.Queue<A, Cause.Done> | undefined;
  fakeRpc[tag] = (config: unknown) => {
    opened.push(config);
    return Stream.callback<A>((queue) =>
      Effect.gen(function* () {
        output = queue;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            interrupted = true;
          }),
        );
        if (first !== undefined) yield* Queue.offer(queue, first);
      }),
    );
  };
  return {
    opened,
    emit: (event: A) => {
      if (output) Queue.offerUnsafe(output, event);
    },
    end: () => {
      if (output) Queue.endUnsafe(output);
    },
    isInterrupted: () => interrupted,
  };
}

/** Record each call of `tag` and answer it with nothing. */
function recordCalls(tag: string) {
  const calls: unknown[] = [];
  fakeRpc[tag] = (payload: unknown) =>
    Effect.sync(() => {
      calls.push(payload);
    });
  return calls;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeElectronApi() {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const api = {
    offAllCalls: [] as string[],
    on(channel: string, cb: (...args: unknown[]) => void) {
      const list = handlers.get(channel) ?? [];
      list.push(cb);
      handlers.set(channel, list);
    },
    offAll(channel: string) {
      api.offAllCalls.push(channel);
      handlers.delete(channel);
    },
    emit(channel: string, ...args: unknown[]) {
      for (const cb of handlers.get(channel) ?? []) cb(...args);
    },
  };
  return api;
}

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  url: string;
  binaryType = "";
  readyState = 1;
  sent: string[] = [];
  closed = false;
  private listeners = new Map<string, Array<(ev: { data: unknown }) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, cb: (ev: { data: unknown }) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }
  dispatch(type: string, ev: { data: unknown } = { data: "" }) {
    for (const cb of this.listeners.get(type) ?? []) cb(ev);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.dispatch("close");
  }
}

beforeEach(() => {
  resetFakeRpc();
  invoke.mockReset();
  getCloudWsUrl.mockReset();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openK8sExec local", () => {
  it("opens a K8sExecOpen stream and binds it to a local handle", async () => {
    const shell = fakeStream<K8sTerminalEvent>("K8sExecOpen", {
      _tag: "Opened",
      sessionId: "sess-1",
    });
    const writes = recordCalls("K8sExecWrite");
    const resizes = recordCalls("K8sExecResize");

    const handle = await openK8sExec({
      mode: "local",
      kubeconfig: "kc",
      namespace: "default",
      podName: "pod",
      containerName: "c",
      cols: 80,
      rows: 24,
    });
    expect(handle.kind).toBe("local");
    expect(shell.opened).toEqual([
      {
        kubeconfig: "kc",
        namespace: "default",
        podName: "pod",
        containerName: "c",
        cols: 80,
        rows: 24,
      },
    ]);

    const data: Uint8Array[] = [];
    handle.onData((d) => data.push(d));
    shell.emit({ _tag: "Data", data: new Uint8Array([9]) });
    await vi.waitFor(() => expect(data[0]).toEqual(new Uint8Array([9])));

    handle.write("c");
    handle.write("md");
    await vi.waitFor(() =>
      expect(
        writes.map((w) => (Predicate.hasProperty(w, "data") ? w.data : undefined)).join(""),
      ).toBe("cmd"),
    );
    expect(writes[0]).toMatchObject({ sessionId: "sess-1" });
    handle.resize(10, 20);
    await vi.waitFor(() => expect(resizes).toEqual([{ sessionId: "sess-1", cols: 10, rows: 20 }]));

    const exits: number[] = [];
    handle.onExit(() => exits.push(1));
    // The process exits: the stream ends and the handle reports it.
    shell.end();
    await vi.waitFor(() => expect(exits).toHaveLength(1));
  });

  it("kill interrupts the stream, which is what kills the process", async () => {
    const shell = fakeStream<K8sTerminalEvent>("K8sExecOpen", {
      _tag: "Opened",
      sessionId: "sess-2",
    });
    const writes = recordCalls("K8sExecWrite");
    const handle = await openK8sExec({
      mode: "local",
      kubeconfig: "kc",
      namespace: "default",
      podName: "pod",
      cols: 80,
      rows: 24,
    });
    const exits: number[] = [];
    handle.onExit(() => exits.push(1));
    handle.kill();
    await vi.waitFor(() => expect(shell.isInterrupted()).toBe(true));
    handle.write("late");
    handle.kill(); // idempotent
    await settle();
    expect(writes).toEqual([]);
    // A kill is not an exit the caller has to be told about.
    expect(exits).toEqual([]);
  });

  it("rejects with the main process's sentence when it never opens", async () => {
    fakeRpc["K8sExecOpen"] = () =>
      Stream.fail(new K8sLocalError({ message: "Failed to launch kubectl exec: not found" }));
    await expect(
      openK8sExec({
        mode: "local",
        kubeconfig: "kc",
        namespace: "default",
        podName: "pod",
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow("Failed to launch kubectl exec: not found");
  });
});

describe("openK8sExec cloud", () => {
  it("opens a ws with k8s:exec:open and decodes data", async () => {
    vi.stubGlobal("window", { electronAPI: makeElectronApi() });
    fakeRpc["CloudWsToken"] = () => Effect.succeed("tok");
    getCloudWsUrl.mockResolvedValue("wss://c");

    const handle = await openK8sExec({
      mode: "cloud",
      orgId: "org",
      accountId: "a",
      resourceId: "r",
      peerPluginId: "pp",
      namespace: "ns",
      podName: "pod",
      cols: 80,
      rows: 24,
    });
    expect(handle.kind).toBe("cloud");
    const ws = FakeWebSocket.instances[0]!;
    ws.dispatch("open");
    const msg = JSON.parse(ws.sent[0]!) as Record<string, unknown>;
    expect(msg.type).toBe("k8s:exec:open");
    expect(msg).toMatchObject({ accountId: "a", podName: "pod", namespace: "ns" });

    const data: Uint8Array[] = [];
    handle.onData((d) => data.push(d));
    ws.dispatch("message", {
      data: JSON.stringify({ type: "k8s:exec:data", data: btoa("X") }),
    });
    expect(new TextDecoder().decode(data[0])).toBe("X");

    handle.write("ab");
    const w = JSON.parse(ws.sent.at(-1)!) as { type: string; data: string };
    expect(w.type).toBe("k8s:exec:data");
    expect(atob(w.data)).toBe("ab");

    // resize sends a resize frame
    handle.resize(120, 50);
    const r = JSON.parse(ws.sent.at(-1)!) as Record<string, unknown>;
    expect(r).toMatchObject({ type: "k8s:exec:resize", cols: 120, rows: 50 });

    // error frame surfaces via onError
    const errs: string[] = [];
    handle.onError((e) => errs.push(e));
    ws.dispatch("message", {
      data: JSON.stringify({ type: "k8s:exec:error", error: "boom" }),
    });
    expect(errs[0]).toBe("boom");

    // error frame without a message falls back to "Error"
    ws.dispatch("message", { data: JSON.stringify({ type: "k8s:exec:error" }) });
    expect(errs[1]).toBe("Error");

    // malformed message is ignored
    ws.dispatch("message", { data: "not-json" });

    // closed frame surfaces via onExit
    const exits: number[] = [];
    handle.onExit(() => exits.push(1));
    ws.dispatch("message", { data: JSON.stringify({ type: "k8s:exec:closed" }) });
    expect(exits).toHaveLength(1);

    // socket close also surfaces an exit
    ws.dispatch("close");
    expect(exits).toHaveLength(2);

    // kill closes the socket and makes write/resize no-ops
    handle.kill();
    expect(ws.closed).toBe(true);
    const sentBefore = ws.sent.length;
    handle.write("x");
    handle.resize(1, 1);
    handle.kill(); // idempotent
    expect(ws.sent.length).toBe(sentBefore);
  });

  it("throws without a token", async () => {
    vi.stubGlobal("window", { electronAPI: makeElectronApi() });
    fakeRpc["CloudWsToken"] = () => Effect.succeed(null);
    await expect(
      openK8sExec({
        mode: "cloud",
        orgId: "org",
        accountId: "a",
        resourceId: "r",
        peerPluginId: "pp",
        namespace: "ns",
        podName: "pod",
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow(/Not authenticated/);
  });
});

describe("openK9s", () => {
  it("local opens a K9sOpen stream and writes through K9sWrite", async () => {
    const k9s = fakeStream<K8sTerminalEvent>("K9sOpen", { _tag: "Opened", sessionId: "k9s-1" });
    const writes = recordCalls("K9sWrite");
    const handle = await openK9s({
      mode: "local",
      kubeconfig: "kc",
      namespace: "ns",
      cols: 80,
      rows: 24,
    });
    expect(handle.kind).toBe("local");
    expect(k9s.opened).toEqual([{ kubeconfig: "kc", namespace: "ns", cols: 80, rows: 24 }]);
    handle.write(":pods");
    await vi.waitFor(() => expect(writes).toEqual([{ sessionId: "k9s-1", data: ":pods" }]));
  });

  it("checks whether k9s is installed", async () => {
    fakeRpc["K9sCheck"] = () => Effect.succeed(true);
    await expect(checkK9sInstalled()).resolves.toBe(true);
  });

  it("cloud opens ws with k9s:open", async () => {
    vi.stubGlobal("window", { electronAPI: makeElectronApi() });
    fakeRpc["CloudWsToken"] = () => Effect.succeed("tok");
    getCloudWsUrl.mockResolvedValue("wss://c");
    const handle = await openK9s({
      mode: "cloud",
      orgId: "org",
      accountId: "a",
      resourceId: "r",
      peerPluginId: "pp",
      cols: 80,
      rows: 24,
    });
    const ws = FakeWebSocket.instances[0]!;
    ws.dispatch("open");
    expect((JSON.parse(ws.sent[0]!) as { type: string }).type).toBe("k9s:open");
    expect(handle.kind).toBe("cloud");
  });
});

describe("startPortForward", () => {
  it("local resolves with the bound port, reports kubectl exiting, and stops", async () => {
    const pf = fakeStream<K8sPortForwardEvent>("K8sPortForwardOpen", {
      _tag: "Forwarding",
      localPort: 15432,
    });
    const handle = await startPortForward({
      mode: "local",
      kubeconfig: "kc",
      namespace: "ns",
      resourceType: "svc",
      resourceName: "db",
      remotePort: 5432,
    });
    expect(handle).toMatchObject({ kind: "local", localPort: 15432 });
    expect(pf.opened).toEqual([
      {
        kubeconfig: "kc",
        namespace: "ns",
        resourceType: "svc",
        resourceName: "db",
        remotePort: 5432,
        localPort: 0,
      },
    ]);

    const exits: number[] = [];
    handle.onExit(() => exits.push(1));
    pf.end();
    await vi.waitFor(() => expect(exits).toHaveLength(1));
  });

  it("local stop interrupts the stream, which is what kills kubectl", async () => {
    const pf = fakeStream<K8sPortForwardEvent>("K8sPortForwardOpen", {
      _tag: "Forwarding",
      localPort: 15433,
    });
    const handle = await startPortForward({
      mode: "local",
      kubeconfig: "kc",
      namespace: "ns",
      resourceType: "pod",
      resourceName: "db-0",
      remotePort: 5432,
      localPort: 15433,
    });
    const exits: number[] = [];
    handle.onExit(() => exits.push(1));
    handle.stop();
    await vi.waitFor(() => expect(pf.isInterrupted()).toBe(true));
    await settle();
    expect(exits).toEqual([]);
  });

  it("local rejects with kubectl's failure before it forwards", async () => {
    fakeRpc["K8sPortForwardOpen"] = () =>
      Stream.fail(
        new K8sLocalError({ message: "kubectl port-forward exited with code 1: no such svc" }),
      );
    await expect(
      startPortForward({
        mode: "local",
        kubeconfig: "kc",
        namespace: "ns",
        resourceType: "svc",
        resourceName: "nope",
        remotePort: 80,
      }),
    ).rejects.toThrow("kubectl port-forward exited with code 1: no such svc");
  });

  it("cloud resolves with the bound port and reports the listener closing", async () => {
    const pf = fakeStream("K8sPfCloudStart", {
      _tag: "Started",
      sessionId: "cpf-1",
      localPort: 16000,
    });
    const handle = await startPortForward({
      mode: "cloud",
      orgId: "org",
      accountId: "a",
      resourceId: "r",
      peerPluginId: "pp",
      namespace: "ns",
      resourceType: "svc",
      resourceName: "db",
      remotePort: 5432,
      localPort: 16000,
    });
    expect(handle).toMatchObject({ kind: "cloud", sessionId: "cpf-1", localPort: 16000 });
    expect(pf.opened).toEqual([
      {
        orgId: "org",
        accountId: "a",
        resourceId: "r",
        peerPluginId: "pp",
        namespace: "ns",
        resourceType: "svc",
        resourceName: "db",
        remotePort: 5432,
        localPort: 16000,
      },
    ]);

    const exits: number[] = [];
    handle.onExit(() => exits.push(1));
    pf.end();
    await vi.waitFor(() => expect(exits).toHaveLength(1));
  });

  it("cloud stop interrupts the stream, which is what closes the listener", async () => {
    const pf = fakeStream("K8sPfCloudStart", {
      _tag: "Started",
      sessionId: "cpf-2",
      localPort: 16001,
    });
    const handle = await startPortForward({
      mode: "cloud",
      orgId: "org",
      accountId: "a",
      resourceId: "r",
      peerPluginId: "pp",
      namespace: "ns",
      resourceType: "svc",
      resourceName: "db",
      remotePort: 5432,
    });
    const exits: number[] = [];
    handle.onExit(() => exits.push(1));
    handle.stop();
    await vi.waitFor(() => expect(pf.isInterrupted()).toBe(true));
    await settle();
    expect(exits).toEqual([]);
  });

  it("cloud rejects when the listener cannot bind", async () => {
    fakeRpc["K8sPfCloudStart"] = () =>
      Stream.fail(new K8sPfCloudError({ message: "listen EADDRINUSE: 127.0.0.1:16000" }));
    await expect(
      startPortForward({
        mode: "cloud",
        orgId: "org",
        accountId: "a",
        resourceId: "r",
        peerPluginId: "pp",
        namespace: "ns",
        resourceType: "svc",
        resourceName: "db",
        remotePort: 5432,
        localPort: 16000,
      }),
    ).rejects.toThrow("listen EADDRINUSE: 127.0.0.1:16000");
  });
});
