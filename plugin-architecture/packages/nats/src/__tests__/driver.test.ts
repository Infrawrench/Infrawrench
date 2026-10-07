import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The NATS.js client is mocked: these tests pin what the driver asks of it.
const h = vi.hoisted(() => {
  const state = {
    connectCalls: [] as Array<Record<string, unknown>>,
    connectError: undefined as Error | undefined,
    published: [] as Array<{ subject: string; data: string; headers?: unknown }>,
    requests: [] as string[],
    streams: {
      info: vi.fn(),
      list: vi.fn(),
      add: vi.fn(),
      update: vi.fn(),
      purge: vi.fn(),
      delete: vi.fn(),
      getMessage: vi.fn(),
      deleteMessage: vi.fn(),
    },
    consumers: {
      list: vi.fn(),
      info: vi.fn(),
      add: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    },
    kv: {
      keys: vi.fn(),
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      purge: vi.fn(),
      history: vi.fn(),
      destroy: vi.fn(),
    },
    jsPublish: vi.fn(),
    closed: 0,
  };
  return state;
});

function lister<T>(rows: T[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const r of rows) yield r;
    },
  };
}

vi.mock("@nats-io/transport-node", () => {
  class Hdrs {
    private m = new Map<string, string[]>();
    append(k: string, v: string) {
      this.m.set(k, [...(this.m.get(k) ?? []), v]);
    }
    *[Symbol.iterator]() {
      yield* this.m.entries();
    }
  }
  return {
    connect: vi.fn(async (opts: Record<string, unknown>) => {
      h.connectCalls.push(opts);
      if (h.connectError) throw h.connectError;
      return {
        info: { server_name: "n1", version: "2.11.0", jetstream: true },
        isClosed: () => false,
        close: async () => {
          h.closed++;
        },
        flush: async () => {},
        publish: (subject: string, data: Uint8Array, o?: { headers?: unknown }) =>
          h.published.push({ subject, data: new TextDecoder().decode(data), headers: o?.headers }),
        request: async (subject: string) => {
          h.requests.push(subject);
          if (subject === "$SYS.REQ.USER.INFO")
            return { json: () => ({ data: { account: "APP" } }), data: new Uint8Array() };
          return { data: new TextEncoder().encode("pong"), headers: undefined };
        },
      };
    }),
    credsAuthenticator: (b: Uint8Array) => ({ kind: "creds", text: new TextDecoder().decode(b) }),
    nkeyAuthenticator: (b: Uint8Array) => ({ kind: "nkey", text: new TextDecoder().decode(b) }),
    headers: () => new Hdrs(),
  };
});

vi.mock("@nats-io/jetstream", () => ({
  jetstreamManager: async () => ({
    streams: h.streams,
    consumers: h.consumers,
    getAccountInfo: async () => ({ memory: 0, storage: 10, streams: 1, consumers: 0 }),
  }),
  jetstream: () => ({ publish: h.jsPublish }),
}));

vi.mock("@nats-io/kv", () => ({
  Kvm: class {
    async open() {
      return h.kv;
    }
    async create() {
      return h.kv;
    }
  },
}));

vi.mock("@nats-io/obj", () => ({
  Objm: class {
    async open() {
      return {};
    }
  },
}));

const { buildConnectOptions, closeAll, describeFailure, dialTargets, driver, encodeData } =
  await import("../driver.js");
const { encodeAuth, decodeAuthArgs, parseServers } = await import("../connection.js");

beforeEach(() => {
  h.connectCalls.length = 0;
  h.connectError = undefined;
  h.published.length = 0;
  h.requests.length = 0;
  vi.clearAllMocks();
});

afterEach(async () => {
  await closeAll();
});

describe("connection options", () => {
  it("parses server lists, schemes and URL userinfo", () => {
    expect(parseServers("nats://a:4222, tls://u:p%40w@b , c")).toEqual([
      { hostPort: "a:4222", host: "a", port: 4222, tls: false },
      { hostPort: "b:4222", host: "b", port: 4222, tls: true, user: "u", pass: "p@w" },
      { hostPort: "c:4222", host: "c", port: 4222, tls: false },
    ]);
  });

  it("maps every auth method to nats.js options", () => {
    expect(buildConnectOptions("nats://a", { user: "alice", pass: "pw" })).toMatchObject({
      servers: ["a:4222"],
      user: "alice",
      pass: "pw",
      ignoreClusterUpdates: true,
    });
    expect(buildConnectOptions("nats://a", { token: "<token>" }).token).toBe("<token>");
    expect(buildConnectOptions("nats://a", { nkeySeed: "SU..." }).authenticator).toEqual([
      { kind: "nkey", text: "SU..." },
    ]);
    expect(buildConnectOptions("nats://a", { creds: "creds-file" }).authenticator).toEqual([
      { kind: "creds", text: "creds-file" },
    ]);
    // URL auth is used only when no field is set: user:pass, or a bare token.
    expect(buildConnectOptions("nats://bob:pw@a", {})).toMatchObject({ user: "bob", pass: "pw" });
    expect(buildConnectOptions("nats://tok@a", {}).token).toBe("tok");
  });

  it("asks for TLS for tls:// and client certificates, and passes CA material as content", () => {
    expect(buildConnectOptions("nats://a", {}).tls).toBeUndefined();
    expect(buildConnectOptions("tls://a", {}).tls).toEqual({});
    expect(
      buildConnectOptions("nats://a", {
        ca: "CA",
        cert: "C",
        key: "K",
        servername: "nats.internal",
      }).tls,
    ).toEqual({ ca: "CA", cert: "C", key: "K", servername: "nats.internal" });
    expect(buildConnectOptions("nats://a", { ca: "CA" }, false).tls).toBeUndefined();
  });

  it("reports every server as a dial target and refuses other schemes", () => {
    expect(dialTargets("nats://a:4222,tls://u:p@10.0.0.5:7422,[::1]")).toEqual([
      { kind: "host", host: "a", port: 4222 },
      { kind: "host", host: "10.0.0.5", port: 7422 },
      { kind: "host", host: "::1", port: 4222 },
    ]);
    expect(dialTargets("ws://a:8080")[0]!.kind).toBe("local");
  });

  it("round-trips the auth envelope and drops unknown keys", () => {
    const env = encodeAuth({ user: "u", pass: "p" });
    const { auth, rest } = decodeAuthArgs([env, "ORDERS", 3]);
    expect(auth).toEqual({ user: "u", pass: "p" });
    expect(rest).toEqual(["ORDERS", "3"]);
    expect(decodeAuthArgs(['natsauth:{"caFile":"/etc/passwd"}']).auth).toEqual({});
    expect(decodeAuthArgs(["streams"]).auth).toEqual({});
  });

  it("explains auth and connection failures", () => {
    expect(describeFailure(new Error("Authorization Violation"), "nats://a").message).toContain(
      "rejected the credentials",
    );
    expect(describeFailure(new Error("connection refused"), "nats://u:p@a").message).not.toContain(
      "u:p",
    );
  });

  it("keeps binary payloads intact as base64", () => {
    expect(encodeData(new TextEncoder().encode("hi"))).toEqual({ data: "hi", encoding: "utf8" });
    expect(encodeData(new Uint8Array([0xff, 0xfe]))).toEqual({ data: "//4=", encoding: "base64" });
  });
});

describe("commands", () => {
  const auth = encodeAuth({ user: "alice", pass: "pw" });

  it("pools one connection per server list and auth", async () => {
    h.streams.list.mockReturnValue(lister([{ name: "ORDERS" }]));
    await driver.command("nats://a", "streams", [auth]);
    await driver.command("nats://a", "streams", [auth]);
    expect(h.connectCalls).toHaveLength(1);
    expect(h.connectCalls[0]).toMatchObject({ user: "alice", pass: "pw" });
    await driver.command("nats://a", "streams", [encodeAuth({ token: "<token>" })]);
    expect(h.connectCalls).toHaveLength(2);
  });

  it("reports the user's account and JetStream usage", async () => {
    const info = (await driver.command("nats://a", "info", [auth])) as Record<string, unknown>;
    expect(info).toMatchObject({ account: "APP", server: { server_name: "n1" } });
    expect(h.requests).toContain("$SYS.REQ.USER.INFO");
  });

  it("creates, updates and purges streams with the JSON it is given", async () => {
    h.streams.add.mockResolvedValue({ config: { name: "ORDERS" } });
    h.streams.update.mockResolvedValue({ config: { name: "ORDERS" } });
    h.streams.purge.mockResolvedValue({ success: true, purged: 4 });
    await driver.command("nats://a", "stream-add", [auth, '{"name":"ORDERS","subjects":["o.>"]}']);
    expect(h.streams.add).toHaveBeenCalledWith({ name: "ORDERS", subjects: ["o.>"] });
    await driver.command("nats://a", "stream-update", [auth, "ORDERS", '{"max_msgs":10}']);
    expect(h.streams.update).toHaveBeenCalledWith("ORDERS", { max_msgs: 10 });
    expect(
      await driver.command("nats://a", "stream-purge", [auth, "ORDERS", '{"filter":"o.x"}']),
    ).toEqual({ purged: 4 });
    expect(h.streams.purge).toHaveBeenCalledWith("ORDERS", { filter: "o.x" });
  });

  it("pages messages newest first and skips deleted sequences", async () => {
    h.streams.info.mockResolvedValue({ state: { messages: 3, first_seq: 1, last_seq: 4 } });
    h.streams.getMessage.mockImplementation(async (_s: string, q: { seq: number }) =>
      q.seq === 3
        ? null
        : { seq: q.seq, subject: `o.${q.seq}`, time: new Date(0), data: new Uint8Array(2) },
    );
    const page = (await driver.command("nats://a", "messages", [
      auth,
      "ORDERS",
      '{"limit":2}',
    ])) as { items: Array<{ seq: number }>; nextCursor?: number };
    expect(page.items.map((m) => m.seq)).toEqual([4, 2]);
    expect(page.nextCursor).toBe(1);
  });

  it("reads one message with headers and deletes by sequence", async () => {
    const hdr = new Map([["Nats-Msg-Id", ["x1"]]]);
    h.streams.getMessage.mockResolvedValue({
      seq: 7,
      subject: "o.created",
      time: new Date("2026-10-01T00:00:00Z"),
      data: new TextEncoder().encode('{"id":1}'),
      header: hdr,
    });
    expect(await driver.command("nats://a", "message", [auth, "ORDERS", "7"])).toEqual({
      seq: 7,
      subject: "o.created",
      time: "2026-10-01T00:00:00.000Z",
      size: 8,
      headers: { "Nats-Msg-Id": "x1" },
      data: '{"id":1}',
      encoding: "utf8",
    });
    h.streams.deleteMessage.mockResolvedValue(true);
    await driver.command("nats://a", "message-delete", [auth, "ORDERS", "7", "1"]);
    expect(h.streams.deleteMessage).toHaveBeenCalledWith("ORDERS", 7, true);
    await expect(driver.command("nats://a", "message", [auth, "ORDERS", "x"])).rejects.toThrow(
      "sequence",
    );
  });

  it("pauses and resumes consumers", async () => {
    h.consumers.pause.mockResolvedValue({ paused: true });
    await driver.command("nats://a", "consumer-pause", [
      auth,
      "ORDERS",
      "billing",
      "2030-01-01T00:00:00Z",
    ]);
    expect(h.consumers.pause).toHaveBeenCalledWith(
      "ORDERS",
      "billing",
      new Date("2030-01-01T00:00:00Z"),
    );
    await expect(
      driver.command("nats://a", "consumer-pause", [auth, "ORDERS", "billing", "soon"]),
    ).rejects.toThrow("not a date");
  });

  it("reads, writes and walks the history of KV keys", async () => {
    h.kv.keys.mockResolvedValue(lister(["b", "a"]));
    expect(await driver.command("nats://a", "kv-keys", [auth, "config"])).toEqual(["a", "b"]);
    h.kv.put.mockResolvedValue(5);
    expect(await driver.command("nats://a", "kv-put", [auth, "config", "a", "1"])).toEqual({
      revision: 5,
    });
    const entry = (rev: number, op: string) => ({
      key: "a",
      revision: rev,
      operation: op,
      created: new Date(0),
      length: 1,
      value: new TextEncoder().encode("v"),
    });
    h.kv.history.mockResolvedValue(lister([entry(1, "PUT"), entry(2, "DEL")]));
    const hist = (await driver.command("nats://a", "kv-history", [auth, "config", "a"])) as Array<{
      revision: number;
      data?: string;
    }>;
    expect(hist.map((e) => e.revision)).toEqual([2, 1]);
    expect(hist[0]!.data).toBeUndefined();
    expect(hist[1]!.data).toBe("v");
  });

  it("publishes core, JetStream and request messages", async () => {
    await driver.command("nats://a", "publish", [auth, "o.x", "hi", '{"X-A":"1"}', "core"]);
    expect(h.published[0]).toMatchObject({ subject: "o.x", data: "hi" });
    h.jsPublish.mockResolvedValue({ stream: "ORDERS", seq: 9, duplicate: false });
    expect(
      await driver.command("nats://a", "publish", [
        auth,
        "o.x",
        "hi",
        "",
        "jetstream",
        "1000",
        "id-1",
      ]),
    ).toEqual({ stream: "ORDERS", seq: 9, duplicate: false });
    expect(h.jsPublish.mock.calls[0]![2]).toEqual({ msgID: "id-1" });
    expect(
      await driver.command("nats://a", "publish", [auth, "svc.ping", "", "", "request"]),
    ).toEqual({
      reply: { data: "pong", encoding: "utf8" },
    });
  });

  it("drops a connection that failed so the next call reconnects", async () => {
    h.connectError = new Error("Authorization Violation");
    await expect(driver.command("nats://a", "streams", [auth])).rejects.toThrow(
      "rejected the credentials",
    );
    h.connectError = undefined;
    h.streams.list.mockReturnValue(lister([]));
    await driver.command("nats://a", "streams", [auth]);
    expect(h.connectCalls).toHaveLength(2);
  });

  it("refuses an unknown command", async () => {
    await expect(driver.command("nats://a", "flushall", [auth])).rejects.toThrow("unknown command");
  });
});
