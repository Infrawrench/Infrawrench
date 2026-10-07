import { describe, expect, it } from "vitest";
import { NatsApiError, normaliseUrl } from "../api.js";
import { NatsClient } from "../client.js";
import { streamKind } from "../mappers.js";
import { natsTerraformExport } from "../terraform.js";
import type { Call } from "./helpers.js";
import { makeHttp } from "./helpers.js";

const ACCOUNT = "acct";

// Shapes taken from live demo.nats.io responses (nats-server 2.15), trimmed.
const JSZ = {
  memory: 0,
  storage: 2732,
  streams: 1,
  consumers: 1,
  config: { max_memory: 1000, max_storage: 10000 },
  account_details: [
    {
      name: "default",
      id: "default",
      memory: 0,
      storage: 2732,
      stream_detail: [
        {
          name: "ORDERS",
          created: "2026-09-07T00:12:57Z",
          cluster: { leader: "n1" },
          config: {
            name: "ORDERS",
            subjects: ["orders.>"],
            retention: "limits",
            storage: "file",
            num_replicas: 3,
            max_age: 86_400_000_000_000,
            duplicate_window: 120_000_000_000,
            max_msgs: -1,
            compression: "none",
          },
          state: { messages: 6, bytes: 2732, first_seq: 1, last_seq: 7, consumer_count: 1 },
          consumer_detail: [
            {
              stream_name: "ORDERS",
              name: "billing",
              config: {
                durable_name: "billing",
                ack_policy: "explicit",
                deliver_policy: "all",
                ack_wait: 30_000_000_000,
                max_deliver: 5,
                filter_subject: "orders.created",
              },
              num_pending: 3,
              num_ack_pending: 1,
              num_redelivered: 0,
              delivered: { stream_seq: 4 },
              ack_floor: { stream_seq: 3 },
            },
          ],
        },
      ],
    },
  ],
};

function client(route: (call: Call) => unknown) {
  const { http, calls } = makeHttp(route);
  return { c: new NatsClient({ url: "nats.internal:8222/varz" }, { http } as never), calls };
}

describe("helpers", () => {
  it("normalises the monitoring URL", () => {
    expect(normaliseUrl("nats.internal:8222/varz")).toBe("http://nats.internal:8222");
    expect(normaliseUrl("https://proxy.example.com/nats/")).toBe("https://proxy.example.com/nats");
  });

  it("tells key-value buckets and object stores from streams", () => {
    expect(streamKind("KV_config")).toBe("key-value bucket");
    expect(streamKind("OBJ_assets")).toBe("object store");
    expect(streamKind("ORDERS")).toBe("stream");
  });
});

describe("requests", () => {
  it("reads streams and consumers from /jsz with configs", async () => {
    const { c, calls } = client(() => JSZ);
    const streams = await c.listResources("nats-stream", ACCOUNT);
    expect(calls[0]!.url.toString()).toBe(
      "http://nats.internal:8222/jsz?accounts=true&streams=true&consumers=true&config=true&limit=1024",
    );
    expect(streams[0]!.id).toBe("acct:nats-stream:default/ORDERS");
    expect(streams[0]!.parentResourceId).toBe("acct:nats-account:default");
    expect(streams[0]!.fields).toMatchObject({
      replicas: 3,
      maxAgeSeconds: 86400,
      duplicateWindowSeconds: 120,
      messages: 6,
    });
    expect(streams[0]!.fields["maxMsgs"]).toBeUndefined();
    const [cons] = await c.listResources("nats-consumer", ACCOUNT);
    expect(cons!.parentResourceId).toBe("acct:nats-stream:default/ORDERS");
    expect(cons!.fields).toMatchObject({
      mode: "pull",
      durable: true,
      pending: 3,
      ackWaitSeconds: 30,
    });
  });

  it("builds the server from /varz, /jsz and /healthz", async () => {
    const { c } = client((call) => {
      if (call.url.pathname === "/healthz")
        return { status: 503, body: { status: "unavailable", error: "JetStream has not current" } };
      if (call.url.pathname === "/jsz") return JSZ;
      return {
        server_name: "n1",
        version: "2.15.0",
        port: 4222,
        connections: 5,
        max_connections: 100,
        jetstream: { config: {} },
      };
    });
    const [s] = await c.listResources("nats-server", ACCOUNT);
    expect(s!.fields).toMatchObject({
      serverName: "n1",
      jsStorage: 2732,
      jsMaxStorage: 10000,
      jetstream: true,
    });
    expect(s!.fields["health"]).toContain("JetStream");
    expect(s!.resolvedOutputs["clientUrl"]).toBe("nats://nats.internal:4222");
  });

  it("reports the server's limits as quotas", async () => {
    const { c } = client((call) =>
      call.url.pathname === "/jsz"
        ? JSZ
        : { server_name: "n1", connections: 5, max_connections: 100 },
    );
    const q = await c.fetchQuotas(ACCOUNT);
    expect(q.map((x) => [x.id, x.used, x.limit])).toEqual([
      ["n1/connections", 5, 100],
      ["n1/js-storage", 2732, 10000],
      ["n1/js-memory", 0, 1000],
    ]);
  });

  it("explains a non-JSON answer from the client port", async () => {
    const { c } = client(() => ({ text: "INFO {...}" }));
    const err = await c.listResources("nats-server", ACCOUNT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NatsApiError);
    expect((err as Error).message).toContain("monitoring port");
  });
});

describe("terraform", () => {
  it("exports streams in seconds and consumers by their stream id", async () => {
    const { c } = client(() => JSZ);
    const [stream] = await c.listResources("nats-stream", ACCOUNT);
    const s = natsTerraformExport.mapResource(stream!);
    expect(s?.resource.importId).toBe("JETSTREAM_STREAM_ORDERS");
    expect(s?.resource.attributes["max_age"]).toEqual({ kind: "number", value: 86400 });
    expect(s?.resource.attributes["compression"]).toBeUndefined();
    const [cons] = await c.listResources("nats-consumer", ACCOUNT);
    const t = natsTerraformExport.mapResource(cons!);
    expect(t?.resource.attributes["stream_id"]).toEqual({
      kind: "string",
      value: "JETSTREAM_STREAM_ORDERS",
    });
    expect(t?.resource.importId).toBe("JETSTREAM_STREAM_ORDERS_CONSUMER_billing");
  });
});
