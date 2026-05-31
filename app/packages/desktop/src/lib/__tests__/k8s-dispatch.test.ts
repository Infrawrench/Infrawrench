import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const getCloudWsUrl = vi.fn();

vi.mock("../invoke", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("../cloud-ws", () => ({ getCloudWsUrl: () => getCloudWsUrl() }));

import { openK8sExec, openK9s, startPortForward } from "../k8s-dispatch";

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
  invoke.mockReset();
  getCloudWsUrl.mockReset();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openK8sExec local", () => {
  it("spawns via k8s_exec_spawn and binds a local pty", async () => {
    const api = makeElectronApi();
    vi.stubGlobal("window", { electronAPI: api });
    invoke.mockResolvedValueOnce("sess-1");

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
    expect(invoke.mock.calls[0]![0]).toBe("k8s_exec_spawn");
    expect(invoke.mock.calls[0]![1]).toMatchObject({ containerName: "c", podName: "pod" });

    const data: Uint8Array[] = [];
    handle.onData((d) => data.push(d));
    api.emit("k8s_exec_data_sess-1", new Uint8Array([9]));
    expect(data[0]).toEqual(new Uint8Array([9]));

    handle.write("cmd");
    expect(invoke).toHaveBeenCalledWith("k8s_exec_write", { sessionId: "sess-1", data: "cmd" });
    handle.resize(10, 20);
    expect(invoke).toHaveBeenCalledWith("k8s_exec_resize", {
      sessionId: "sess-1",
      cols: 10,
      rows: 20,
    });

    const exits: number[] = [];
    handle.onExit(() => exits.push(1));
    api.emit("k8s_exec_exit_sess-1");
    expect(exits).toHaveLength(1);

    handle.kill();
    expect(api.offAllCalls).toContain("k8s_exec_data_sess-1");
    expect(invoke).toHaveBeenCalledWith("k8s_exec_kill", { sessionId: "sess-1" });
  });
});

describe("openK8sExec cloud", () => {
  it("opens a ws with k8s:exec:open and decodes data", async () => {
    vi.stubGlobal("window", { electronAPI: makeElectronApi() });
    invoke.mockResolvedValueOnce("tok");
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
    invoke.mockResolvedValueOnce(null);
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
  it("local spawns via k9s_spawn", async () => {
    const api = makeElectronApi();
    vi.stubGlobal("window", { electronAPI: api });
    invoke.mockResolvedValueOnce("k9s-1");
    const handle = await openK9s({
      mode: "local",
      kubeconfig: "kc",
      namespace: "ns",
      cols: 80,
      rows: 24,
    });
    expect(handle.kind).toBe("local");
    expect(invoke.mock.calls[0]![0]).toBe("k9s_spawn");
  });

  it("cloud opens ws with k9s:open", async () => {
    vi.stubGlobal("window", { electronAPI: makeElectronApi() });
    invoke.mockResolvedValueOnce("tok");
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
  it("local returns a handle and wires exit/stop", async () => {
    const api = makeElectronApi();
    vi.stubGlobal("window", { electronAPI: api });
    invoke.mockResolvedValueOnce({ sessionId: "pf-1", localPort: 15432 });
    const handle = await startPortForward({
      mode: "local",
      kubeconfig: "kc",
      namespace: "ns",
      resourceType: "svc",
      resourceName: "db",
      remotePort: 5432,
    });
    expect(handle).toMatchObject({ kind: "local", sessionId: "pf-1", localPort: 15432 });
    expect(invoke.mock.calls[0]![1]).toMatchObject({ localPort: 0 });

    const exits: number[] = [];
    handle.onExit(() => exits.push(1));
    api.emit("k8s_pf_exit_pf-1");
    expect(exits).toHaveLength(1);

    handle.stop();
    expect(invoke).toHaveBeenCalledWith("k8s_pf_stop", { sessionId: "pf-1" });
    expect(api.offAllCalls).toContain("k8s_pf_exit_pf-1");
  });

  it("cloud returns a handle and wires cloud exit/stop", async () => {
    const api = makeElectronApi();
    vi.stubGlobal("window", { electronAPI: api });
    invoke.mockResolvedValueOnce({ sessionId: "cpf-1", localPort: 16000 });
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
    expect(handle.kind).toBe("cloud");
    expect(invoke.mock.calls[0]![0]).toBe("k8s_pf_cloud_start");
    expect(invoke.mock.calls[0]![1]).toMatchObject({ localPort: 16000 });

    const exits: number[] = [];
    handle.onExit(() => exits.push(1));
    api.emit("k8s_pf_cloud_exit_cpf-1");
    expect(exits).toHaveLength(1);

    handle.stop();
    expect(invoke).toHaveBeenCalledWith("k8s_pf_cloud_stop", { sessionId: "cpf-1" });
  });
});
