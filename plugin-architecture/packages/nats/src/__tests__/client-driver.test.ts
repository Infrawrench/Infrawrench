import { describe, expect, it } from "vitest";
import { NatsClient } from "../client.js";
import { AUTH_PREFIX, decodeAuthArgs } from "../connection.js";
import { COMMANDS } from "../render.js";

const ACCOUNT = "acct";

interface Sent {
  cmd: string;
  auth: Record<string, string>;
  args: string[];
}

const STREAM = {
  name: "ORDERS",
  created: "2026-09-07T00:12:57Z",
  config: {
    name: "ORDERS",
    subjects: ["orders.>"],
    retention: "limits",
    storage: "file",
    num_replicas: 1,
    max_age: 0,
    max_msgs: -1,
  },
  state: { messages: 2, bytes: 100, first_seq: 1, last_seq: 2, consumer_count: 1 },
};
const KV_STREAM = {
  name: "KV_config",
  config: {
    name: "KV_config",
    max_msgs_per_subject: 5,
    max_age: 60e9,
    num_replicas: 1,
    storage: "file",
  },
  state: { messages: 7, num_subjects: 3, bytes: 300 },
};
const OBJ_STREAM = {
  name: "OBJ_assets",
  config: { name: "OBJ_assets", storage: "file" },
  state: { bytes: 10 },
};

/** A fake host kv service: records each command and answers from `route`. */
function client(
  route: (cmd: string, args: string[]) => unknown,
  creds: Record<string, string> = {},
) {
  const sent: Sent[] = [];
  const kv = {
    async command(cmd: string, ...args: (string | number)[]) {
      expect(String(args[0]).startsWith(AUTH_PREFIX)).toBe(true);
      const { auth, rest } = decodeAuthArgs(args);
      sent.push({ cmd, auth: auth as Record<string, string>, args: rest });
      if (cmd === "info")
        return {
          server: { server_name: "n1", version: "2.11.0", jetstream: true },
          account: "APP",
          jetstream: { storage: 400, memory: 0, streams: 3, consumers: 1 },
        };
      return route(cmd, rest);
    },
  };
  const c = new NatsClient(
    { servers: "nats://nats.internal:4222", natsUser: "alice", natsPassword: "pw", ...creds },
    { kv } as never,
  );
  return { c, sent };
}

describe("driver-backed listing", () => {
  it("lists streams, buckets and object stores from the JetStream API in the user's account", async () => {
    const { c, sent } = client((cmd) => (cmd === "streams" ? [STREAM, KV_STREAM, OBJ_STREAM] : []));
    const streams = await c.listResources("nats-stream", ACCOUNT);
    expect(streams.map((s) => s.id)).toEqual([
      "acct:nats-stream:APP/ORDERS",
      "acct:nats-stream:APP/KV_config",
      "acct:nats-stream:APP/OBJ_assets",
    ]);
    const [bucket] = await c.listResources("nats-kv-bucket", ACCOUNT);
    expect(bucket!.id).toBe("acct:nats-kv-bucket:APP/config");
    expect(bucket!.fields).toMatchObject({ history: 5, ttlSeconds: 60, keys: 3, values: 7 });
    const [store] = await c.listResources("nats-object-store", ACCOUNT);
    expect(store!.id).toBe("acct:nats-object-store:APP/assets");
    expect(sent[0]!.auth).toEqual({ user: "alice", pass: "pw" });
    // One streams call serves all three listings.
    expect(sent.filter((s) => s.cmd === "streams")).toHaveLength(1);
  });

  it("builds the server from INFO when there is no monitoring URL", async () => {
    const { c } = client(() => []);
    const [s] = await c.listResources("nats-server", ACCOUNT);
    expect(s!.fields).toMatchObject({ serverName: "n1", jetstream: true, jsStorage: 400 });
    expect(s!.resolvedOutputs["clientUrl"]).toBe("nats://nats.internal:4222");
    expect(await c.listResources("nats-connection", ACCOUNT)).toEqual([]);
  });

  it("lists consumers per stream", async () => {
    const { c } = client((cmd, args) =>
      cmd === "streams"
        ? [STREAM]
        : cmd === "consumers" && args[0] === "ORDERS"
          ? [
              {
                name: "billing",
                config: { durable_name: "billing", ack_policy: "explicit" },
                num_pending: 2,
                paused: true,
              },
            ]
          : [],
    );
    const [cons] = await c.listResources("nats-consumer", ACCOUNT);
    expect(cons!.id).toBe("acct:nats-consumer:APP/ORDERS/billing");
    expect(cons!.fields).toMatchObject({ pending: 2, paused: true, mode: "pull" });
  });
});

describe("writes", () => {
  it("creates a stream from the form, with blank limits unlimited and durations in nanoseconds", async () => {
    const { c, sent } = client((cmd, args) =>
      cmd === "stream-add" ? { ...STREAM, config: JSON.parse(args[0]!) } : null,
    );
    await c.createResource("nats-stream", ACCOUNT, {
      name: "ORDERS",
      subjects: "orders.>, refunds.*",
      retention: "workqueue",
      storage: "memory",
      replicas: "3",
      maxAgeSeconds: "3600",
      maxBytes: "",
    });
    const cfg = JSON.parse(sent.find((s) => s.cmd === "stream-add")!.args[0]!);
    expect(cfg).toMatchObject({
      name: "ORDERS",
      subjects: ["orders.>", "refunds.*"],
      retention: "workqueue",
      storage: "memory",
      num_replicas: 3,
      max_age: 3600e9,
      max_bytes: -1,
    });
    await expect(
      c.createResource("nats-stream", ACCOUNT, { name: "bad.name", subjects: "x" }),
    ).rejects.toThrow("may not contain");
  });

  it("sends only changed fields on an edit", async () => {
    const { c, sent } = client((cmd) => (cmd === "stream-update" ? STREAM : null));
    await c.updateResource("nats-stream", "acct:nats-stream:APP/ORDERS", ACCOUNT, {
      maxMsgs: "1000",
      description: "orders",
    });
    const u = sent.find((s) => s.cmd === "stream-update")!;
    expect(u.args[0]).toBe("ORDERS");
    expect(JSON.parse(u.args[1]!)).toEqual({ max_msgs: 1000, description: "orders" });
  });

  it("creates a consumer under the stream it was opened from", async () => {
    const { c, sent } = client((cmd) =>
      cmd === "consumer-add" ? { name: "billing", stream_name: "ORDERS", config: {} } : null,
    );
    const r = await c.createResource(
      "nats-consumer",
      ACCOUNT,
      {
        name: "billing",
        deliverPolicy: "by_start_sequence",
        optStartSeq: "10",
        ackWaitSeconds: "45",
        filterSubjects: "orders.created",
      },
      "acct:nats-stream:APP/ORDERS",
    );
    const add = sent.find((s) => s.cmd === "consumer-add")!;
    expect(add.args[0]).toBe("ORDERS");
    expect(JSON.parse(add.args[1]!)).toMatchObject({
      durable_name: "billing",
      deliver_policy: "by_start_sequence",
      opt_start_seq: 10,
      ack_wait: 45e9,
      filter_subject: "orders.created",
    });
    expect(r.parentResourceId).toBe("acct:nats-stream:APP/ORDERS");
  });

  it("refuses a write into an account the credentials do not reach", async () => {
    const { c } = client(() => null);
    await expect(
      c.deleteResource("nats-stream", "acct:nats-stream:OTHER/ORDERS", ACCOUNT),
    ).rejects.toThrow('connect to "APP"');
  });

  it("creates buckets with their own option units", async () => {
    const { c, sent } = client((cmd) => (cmd === "kv-create" ? KV_STREAM : OBJ_STREAM));
    await c.createResource("nats-kv-bucket", ACCOUNT, {
      name: "config",
      history: "5",
      ttlSeconds: "60",
    });
    expect(JSON.parse(sent.find((s) => s.cmd === "kv-create")!.args[1]!)).toMatchObject({
      history: 5,
      ttl: 60000,
    });
    await c.createResource("nats-object-store", ACCOUNT, { name: "assets", ttlSeconds: "60" });
    expect(JSON.parse(sent.find((s) => s.cmd === "obj-create")!.args[1]!)).toMatchObject({
      ttl: 60e9,
    });
  });

  it("runs the stream and consumer prompt commands", async () => {
    const { c, sent } = client(() => ({ purged: 1 }));
    await c.executeNoSqlCommand(
      "nats-stream",
      "acct:nats-stream:APP/ORDERS",
      ACCOUNT,
      COMMANDS.purge,
      [JSON.stringify({ subject: "orders.cancelled", keep: "2" })],
    );
    expect(sent.at(-1)).toMatchObject({
      cmd: "stream-purge",
      args: ["ORDERS", '{"filter":"orders.cancelled","keep":2}'],
    });
    await c.executeNoSqlCommand(
      "nats-consumer",
      "acct:nats-consumer:APP/ORDERS/billing",
      ACCOUNT,
      COMMANDS.pause,
      [JSON.stringify({ until: "2030-01-01T00:00:00Z" })],
    );
    expect(sent.at(-1)).toMatchObject({
      cmd: "consumer-pause",
      args: ["ORDERS", "billing", "2030-01-01T00:00:00Z"],
    });
    await c.invokeAction(
      "nats-stream",
      "acct:nats-stream:APP/ORDERS",
      "delete-message:12",
      ACCOUNT,
    );
    expect(sent.at(-1)).toMatchObject({ cmd: "message-delete", args: ["ORDERS", "12", "0"] });
  });
});

describe("publish", () => {
  it("publishes core, request and JetStream messages", async () => {
    const { c, sent } = client((_cmd, args) =>
      args[3] === "request"
        ? { reply: { data: "pong", encoding: "utf8" } }
        : args[3] === "jetstream"
          ? { stream: "ORDERS", seq: 3 }
          : { ok: true },
    );
    const core = await c.publishMessage("nats-server", "acct:nats-server:server", ACCOUNT, {
      body: "hi",
      extras: { subject: "orders.x", mode: "core", headers: { "X-A": "1" } },
    });
    expect(core.summary).toBe("Published to orders.x");
    expect(sent.at(-1)!.args).toEqual(["orders.x", "hi", '{"X-A":"1"}', "core", "5000", ""]);
    const reply = await c.publishMessage("nats-server", "acct:nats-server:server", ACCOUNT, {
      body: "",
      extras: { subject: "svc.ping", mode: "request" },
    });
    expect(reply.summary).toBe("Reply: pong");
    const js = await c.publishMessage("nats-stream", "acct:nats-stream:APP/ORDERS", ACCOUNT, {
      body: "x",
      extras: { subject: "orders.created", msgId: "m1" },
    });
    expect(js.summary).toBe("Stored in ORDERS as message 3");
    await expect(
      c.publishMessage("nats-server", "acct:nats-server:server", ACCOUNT, {
        body: "",
        extras: { subject: "orders.>" },
      }),
    ).rejects.toThrow("concrete subject");
  });
});

describe("browsers", () => {
  it("pages KV keys with a prefix", async () => {
    const { c, sent } = client(() => ["app.a", "app.b", "db.x"]);
    const page = await c.listKvKeys("nats-kv-bucket", "acct:nats-kv-bucket:APP/config", ACCOUNT, {
      prefix: "app.",
      limit: 1,
    });
    expect(sent.at(-1)!.args).toEqual(["config", "app.>"]);
    expect(page).toEqual({ items: [{ name: "app.a" }], nextCursor: "1" });
  });

  it("lists a stream's messages as keys and reads one back", async () => {
    const { c, sent } = client((cmd) =>
      cmd === "messages"
        ? { items: [{ seq: 2, subject: "orders.x", time: "t", size: 1 }], nextCursor: 1 }
        : {
            seq: 2,
            subject: "orders.x",
            time: "t",
            size: 2,
            data: "hi",
            encoding: "utf8",
            headers: { A: "1" },
          },
    );
    const page = await c.listKvKeys("nats-stream", "acct:nats-stream:APP/ORDERS", ACCOUNT, {
      prefix: "orders.*",
    });
    expect(page).toEqual({ items: [{ name: "#2 orders.x" }], nextCursor: "1" });
    expect(JSON.parse(sent.at(-1)!.args[1]!)).toMatchObject({ subject: "orders.*" });
    const text = await c.getKvValue(
      "nats-stream",
      "acct:nats-stream:APP/ORDERS",
      ACCOUNT,
      "#2 orders.x",
    );
    expect(text).toContain("Subject: orders.x");
    expect(text).toContain("  A: 1");
    expect(text.endsWith("hi")).toBe(true);
    await expect(
      c.putKvValue("nats-stream", "acct:nats-stream:APP/ORDERS", ACCOUNT, "#2 orders.x", "new"),
    ).rejects.toThrow("cannot be changed");
  });

  it("lists object names with slashes as folders", async () => {
    const { c } = client(() => [
      { name: "img/a.png", size: 1, chunks: 1, digest: "d", mtime: "t" },
      { name: "readme.txt", size: 2, chunks: 1, digest: "d", mtime: "t" },
    ]);
    const root = await c.listStorageObjects("assets", "");
    expect(root.map((o) => [o.key, o.isDirectory])).toEqual([
      ["img/", true],
      ["readme.txt", false],
    ]);
    const img = await c.listStorageObjects("assets", "img/");
    expect(img.map((o) => o.name)).toEqual(["a.png"]);
  });
});

describe("without a server URL", () => {
  it("says what to add instead of failing obscurely", async () => {
    const c = new NatsClient({ url: "http://nats.internal:8222" }, {
      kv: { command: async () => null },
    } as never);
    await expect(
      c.createResource("nats-stream", ACCOUNT, { name: "X", subjects: "x" }),
    ).rejects.toThrow("add the server URL");
    const detail = c.renderDetail({
      id: "acct:nats-server:server",
      pluginId: "nats",
      resourceTypeId: "nats-server",
      accountId: ACCOUNT,
      displayName: "n1",
      fields: {},
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    });
    expect(detail.publishPanel?.disabledReason).toContain("server URL");
  });

  it("needs one of the two URLs", () => {
    expect(() => new NatsClient({})).toThrow("server URL");
  });
});
