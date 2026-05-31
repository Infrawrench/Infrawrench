import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const getCloudWsUrl = vi.fn();

vi.mock("../invoke", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("../cloud-ws", () => ({ getCloudWsUrl: () => getCloudWsUrl() }));

import { openSshShell } from "../ssh-dispatch";

// ---- fakes ----------------------------------------------------------------

interface Listener {
  on: (channel: string, cb: (...args: unknown[]) => void) => void;
  offAll: (channel: string) => void;
}

function makeElectronApi() {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const api: Listener & {
    emit: (channel: string, ...args: unknown[]) => void;
    offAllCalls: string[];
  } = {
    on: (channel, cb) => {
      const list = handlers.get(channel) ?? [];
      list.push(cb);
      handlers.set(channel, list);
    },
    offAll: (channel) => {
      api.offAllCalls.push(channel);
      handlers.delete(channel);
    },
    emit: (channel, ...args) => {
      for (const cb of handlers.get(channel) ?? []) cb(...args);
    },
    offAllCalls: [],
  };
  return api;
}

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  static OPEN_VAL = 1;
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
// match the WebSocket.OPEN static referenced in source
(FakeWebSocket as unknown as { OPEN: number }).OPEN = 1;

beforeEach(() => {
  invoke.mockReset();
  getCloudWsUrl.mockReset();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openSshShell (local mode)", () => {
  it("spawns via ssh_shell_spawn and wires data/exit listeners", async () => {
    const api = makeElectronApi();
    vi.stubGlobal("window", { electronAPI: api });
    invoke.mockResolvedValueOnce("shell-1"); // ssh_shell_spawn

    const handle = await openSshShell({
      mode: "local",
      host: "h",
      port: 22,
      username: "u",
      privateKey: "k",
      cols: 80,
      rows: 24,
      agentForward: true,
      jumpHops: [{ host: "j", port: 22, username: "ju", privateKey: "jk" }],
    });

    expect(handle.kind).toBe("local");
    const spawnArgs = invoke.mock.calls[0]![1] as Record<string, unknown>;
    expect(spawnArgs).toMatchObject({
      host: "h",
      port: 22,
      username: "u",
      privateKey: "k",
      cols: 80,
      rows: 24,
      agentForward: true,
    });
    expect(spawnArgs.jumpHops).toHaveLength(1);

    // onError is a no-op for local shells (errors surface via exit)
    expect(() => handle.onError(() => {})).not.toThrow();

    // data callback fires
    const received: Uint8Array[] = [];
    handle.onData((d) => received.push(d));
    api.emit("ssh_shell_data_shell-1", new Uint8Array([1, 2, 3]));
    expect(received[0]).toEqual(new Uint8Array([1, 2, 3]));

    // exit callback fires
    const exits: number[] = [];
    handle.onExit(() => exits.push(1));
    api.emit("ssh_shell_exit_shell-1");
    expect(exits).toHaveLength(1);

    // write/resize route through invoke
    handle.write("ls\n");
    expect(invoke).toHaveBeenCalledWith("ssh_shell_write", { shellId: "shell-1", data: "ls\n" });
    handle.resize(100, 40);
    expect(invoke).toHaveBeenCalledWith("ssh_shell_resize", {
      shellId: "shell-1",
      cols: 100,
      rows: 40,
    });

    // kill deregisters listeners and is idempotent
    handle.kill();
    expect(api.offAllCalls).toContain("ssh_shell_data_shell-1");
    expect(api.offAllCalls).toContain("ssh_shell_exit_shell-1");
    expect(invoke).toHaveBeenCalledWith("ssh_shell_kill", { shellId: "shell-1" });

    const killInvokes = invoke.mock.calls.filter((c) => c[0] === "ssh_shell_kill").length;
    handle.write("x"); // no-op after kill
    handle.resize(1, 1); // no-op after kill
    handle.kill(); // idempotent
    expect(invoke.mock.calls.filter((c) => c[0] === "ssh_shell_kill").length).toBe(killInvokes);
  });

  it("omits jumpHops when none provided", async () => {
    const api = makeElectronApi();
    vi.stubGlobal("window", { electronAPI: api });
    invoke.mockResolvedValueOnce("shell-2");
    await openSshShell({
      mode: "local",
      host: "h",
      port: 22,
      username: "u",
      privateKey: "k",
      cols: 80,
      rows: 24,
    });
    const spawnArgs = invoke.mock.calls[0]![1] as Record<string, unknown>;
    expect(spawnArgs).not.toHaveProperty("jumpHops");
    expect(spawnArgs).not.toHaveProperty("agentForward");
  });
});

describe("openSshShell (cloud mode)", () => {
  it("throws when there is no ws token", async () => {
    vi.stubGlobal("window", { electronAPI: makeElectronApi() });
    invoke.mockResolvedValueOnce(null); // cloud_auth_get_ws_token
    await expect(
      openSshShell({
        mode: "cloud",
        orgId: "org1",
        keySource: { type: "cloud", sshKeyId: "key1", name: "k" },
        accountId: "acc",
        host: "h",
        username: "u",
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow(/Not authenticated/);
  });

  it("opens a websocket, sends ssh:open, and decodes ssh:data/closed/error", async () => {
    vi.stubGlobal("window", { electronAPI: makeElectronApi() });
    invoke.mockResolvedValueOnce("ws-token-abc"); // cloud_auth_get_ws_token
    getCloudWsUrl.mockResolvedValue("ws://localhost:3000");

    const handle = await openSshShell({
      mode: "cloud",
      orgId: "org1",
      keySource: { type: "cloud", sshKeyId: "key1", name: "k" },
      accountId: "acc",
      resourceId: "res",
      host: "h",
      username: "u",
      cols: 80,
      rows: 24,
      agentForward: true,
      connectThroughAccountId: "jump-acc",
    });
    expect(handle.kind).toBe("cloud");

    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toContain("ws://localhost:3000/api/ws?token=ws-token-abc");

    // open -> sends ssh:open with all fields
    ws.dispatch("open");
    const openMsg = JSON.parse(ws.sent[0]!) as Record<string, unknown>;
    expect(openMsg).toMatchObject({
      type: "ssh:open",
      accountId: "acc",
      resourceId: "res",
      sshKeyId: "key1",
      sshHost: "h",
      sshUsername: "u",
      agentForward: true,
      connectThroughAccountId: "jump-acc",
    });

    // data event -> base64 decoded to bytes
    const datas: Uint8Array[] = [];
    handle.onData((d) => datas.push(d));
    const payload = btoa("hi");
    ws.dispatch("message", { data: JSON.stringify({ type: "ssh:data", data: payload }) });
    expect(new TextDecoder().decode(datas[0])).toBe("hi");

    // error event
    const errs: string[] = [];
    handle.onError((e) => errs.push(e));
    ws.dispatch("message", { data: JSON.stringify({ type: "ssh:error", error: "boom" }) });
    expect(errs[0]).toBe("boom");

    // malformed message ignored
    ws.dispatch("message", { data: "not json" });

    // closed event -> exit
    const exits: number[] = [];
    handle.onExit(() => exits.push(1));
    ws.dispatch("message", { data: JSON.stringify({ type: "ssh:closed" }) });
    expect(exits).toHaveLength(1);

    // write -> base64 ssh:data
    handle.write("ab");
    const writeMsg = JSON.parse(ws.sent.at(-1)!) as { type: string; data: string };
    expect(writeMsg.type).toBe("ssh:data");
    expect(atob(writeMsg.data)).toBe("ab");

    // resize
    handle.resize(120, 50);
    const resizeMsg = JSON.parse(ws.sent.at(-1)!) as Record<string, unknown>;
    expect(resizeMsg).toMatchObject({ type: "ssh:resize", cols: 120, rows: 50 });

    // kill closes the socket; subsequent writes are no-ops
    handle.kill();
    expect(ws.closed).toBe(true);
    const sentBefore = ws.sent.length;
    handle.write("x");
    expect(ws.sent.length).toBe(sentBefore);
  });
});
