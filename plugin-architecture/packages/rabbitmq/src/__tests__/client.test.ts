import { describe, expect, it } from "vitest";
import { normaliseUrl, RabbitApiError } from "../api.js";
import { RabbitClient } from "../client.js";
import { bindingId, redactUri } from "../mappers.js";
import { counterRate, sampleQuery } from "../metrics.js";
import { rabbitTerraformExport } from "../terraform.js";
import type { Call } from "./helpers.js";
import { makeHttp } from "./helpers.js";

const ACCOUNT = "acct";

function client(route: (call: Call) => unknown, creds: Record<string, string> = {}) {
  const { http, calls } = makeHttp(route);
  return {
    c: new RabbitClient(
      { url: "mq.example.com:15672/api/", username: "admin", password: "pw", ...creds },
      { http } as never,
    ),
    calls,
  };
}

describe("helpers", () => {
  it("normalises the management URL", () => {
    expect(normaliseUrl("mq.example.com:15672/api/")).toBe("http://mq.example.com:15672");
    expect(normaliseUrl("mq.example.com:15671")).toBe("https://mq.example.com:15671");
    expect(normaliseUrl("https://proxy.example.com/rabbitmq/")).toBe(
      "https://proxy.example.com/rabbitmq",
    );
  });

  it("redacts credentials in AMQP URIs", () => {
    expect(redactUri("amqps://user:s3cr3t@host/%2F")).toBe("amqps://user:•••@host/%2F");
    expect(redactUri("amqp://")).toBe("amqp://");
  });

  it("builds unambiguous binding ids for the default vhost", () => {
    expect(
      bindingId({
        vhost: "/",
        source: "x",
        destination_type: "queue",
        destination: "q/1",
        properties_key: "a.b",
      }),
    ).toBe("%2F/x/q/q%2F1/a.b");
  });

  it("turns cumulative samples into rates and skips counter resets", () => {
    const s = counterRate("Published", {
      samples: [
        { sample: 300, timestamp: 3000 },
        { sample: 100, timestamp: 1000 },
        { sample: 200, timestamp: 2000 },
        { sample: 5, timestamp: 4000 },
      ],
    });
    expect(s?.points).toEqual([
      { timestamp: 2000, value: 100 },
      { timestamp: 3000, value: 100 },
    ]);
  });

  it("picks a sample increment the default retention keeps", () => {
    const now = Date.now();
    expect(sampleQuery({ startMs: now - 3_600_000, endMs: now }, ["lengths"])).toEqual({
      lengths_age: 3600,
      lengths_incr: 60,
    });
    expect(sampleQuery({ startMs: now - 7 * 86_400_000, endMs: now }, ["msg_rates"])).toEqual({
      msg_rates_age: 86_400,
      msg_rates_incr: 1800,
    });
  });
});

describe("requests", () => {
  it("sends basic auth and encodes the default vhost", async () => {
    const { c, calls } = client((call) =>
      call.url.pathname === "/api/vhosts"
        ? [{ name: "/" }]
        : {
            items: [{ name: "orders", vhost: "/", messages: 3, consumers: 0 }],
            page: 1,
            page_count: 1,
          },
    );
    const qs = await c.listResources("rabbitmq-queue", ACCOUNT);
    expect(calls[0]!.headers["Authorization"]).toBe(`Basic ${btoa("admin:pw")}`);
    expect(calls[1]!.url.toString()).toBe(
      "http://mq.example.com:15672/api/queues/%2F?page=1&page_size=500&pagination=true",
    );
    expect(qs[0]!.id).toBe("acct:rabbitmq-queue:%2F/orders");
    expect(qs[0]!.parentResourceId).toBe("acct:rabbitmq-vhost:%2F");
  });

  it("follows pagination", async () => {
    const { c, calls } = client((call) => {
      const page = Number(call.url.searchParams.get("page"));
      return { items: [{ name: `x${page}`, vhost: "/" }], page, page_count: 3 };
    });
    const xs = await c.listResources("rabbitmq-exchange", ACCOUNT);
    expect(xs.map((x) => x.displayName)).toEqual(["x1", "x2", "x3"]);
    expect(calls).toHaveLength(3);
  });

  it("reads a missing tag as an empty list but keeps real failures", async () => {
    const { c } = client((call) =>
      call.url.pathname === "/api/users"
        ? { status: 401, body: { error: "not_authorised", reason: "Not administrator user" } }
        : { status: 401, body: { error: "not_authorized", reason: "Not_Authorized" } },
    );
    expect(
      await c.listResources("rabbitmq-policy", ACCOUNT).catch((e: unknown) => e),
    ).toBeInstanceOf(RabbitApiError);
    const { c: c2 } = client(() => ({
      status: 401,
      body: { error: "not_authorised", reason: "Not administrator user" },
    }));
    expect(await c2.listResources("rabbitmq-permission", ACCOUNT)).toEqual([]);
  });

  it("keeps the password hash when only the tags change", async () => {
    const { c, calls } = client((call) => {
      if (call.method === "GET" && call.url.pathname === "/api/users/app")
        return {
          name: "app",
          tags: ["management"],
          password_hash: "HASH",
          hashing_algorithm: "rabbit_password_hashing_sha256",
        };
      return call.method === "GET" ? [] : undefined;
    });
    await c.updateResource("rabbitmq-user", "acct:rabbitmq-user:app", ACCOUNT, {
      tags: "monitoring, management",
    });
    const put = calls.find((x) => x.method === "PUT")!;
    expect(put.url.pathname).toBe("/api/users/app");
    expect(put.body).toEqual({
      tags: "monitoring,management",
      password_hash: "HASH",
      hashing_algorithm: "rabbit_password_hashing_sha256",
    });
  });

  it("deletes one topic permission by clearing and re-granting the others", async () => {
    const { c, calls } = client((call) =>
      call.method === "GET"
        ? [
            { user: "app", vhost: "/", exchange: "amq.topic", write: ".*", read: ".*" },
            { user: "app", vhost: "/", exchange: "events", write: "^a", read: "" },
          ]
        : undefined,
    );
    await c.deleteResource(
      "rabbitmq-topic-permission",
      "acct:rabbitmq-topic-permission:%2F/app/amq.topic",
      ACCOUNT,
    );
    expect(calls.map((x) => x.method)).toEqual(["GET", "DELETE", "PUT"]);
    expect(calls[2]!.body).toEqual({ exchange: "events", write: "^a", read: "" });
  });

  it("publishes to a queue through amq.default with POST", async () => {
    const { c, calls } = client(() => ({ routed: true }));
    const res = await c.publishMessage(
      "rabbitmq-queue",
      "acct:rabbitmq-queue:%2F/orders",
      ACCOUNT,
      {
        body: '{"a":1}',
        extras: { contentType: "application/json", deliveryMode: "2", headers: { trace: "1" } },
      },
    );
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.pathname).toBe("/api/exchanges/%2F/amq.default/publish");
    expect(calls[0]!.body).toEqual({
      properties: { delivery_mode: 2, content_type: "application/json", headers: { trace: "1" } },
      routing_key: "orders",
      payload: '{"a":1}',
      payload_encoding: "string",
    });
    expect(res.summary).toContain("Routed");
  });

  it("peeks with requeue", async () => {
    const { c, calls } = client((call) =>
      call.method === "POST"
        ? [
            {
              payload: "hi",
              payload_encoding: "string",
              payload_bytes: 2,
              exchange: "",
              routing_key: "orders",
            },
          ]
        : { name: "orders", type: "quorum", messages: 1, messages_ready: 1 },
    );
    const text = await c.describeResource(
      "rabbitmq-queue",
      "acct:rabbitmq-queue:%2F/orders",
      ACCOUNT,
    );
    expect(calls[1]!.body).toMatchObject({ ackmode: "ack_requeue_true", count: 10 });
    expect(text).toContain("payload (string): hi");
  });

  it("creates a binding and reads it back by its properties key", async () => {
    const { c, calls } = client((call) =>
      call.method === "POST"
        ? undefined
        : [
            {
              source: "events",
              vhost: "/",
              destination: "orders",
              destination_type: "queue",
              routing_key: "o.*",
              arguments: {},
              properties_key: "o.*",
            },
          ],
    );
    const b = await c.createResource("rabbitmq-binding", ACCOUNT, {
      source: "%2F/events",
      destination: "q/%2F/orders",
      routingKey: "o.*",
      arguments: "{}",
    });
    expect(calls[0]!.url.pathname).toBe("/api/bindings/%2F/e/events/q/orders");
    expect(b.externalId).toBe("%2F/events/q/orders/o.*");
  });

  it("refuses to delete the user it signs in as", async () => {
    const { c } = client(() => undefined);
    const err = await c
      .deleteResource("rabbitmq-user", "acct:rabbitmq-user:admin", ACCOUNT)
      .catch((e: unknown) => e);
    expect((err as RabbitApiError).status).toBe(400);
  });
});

describe("terraform", () => {
  it("maps a queue with JSON arguments and a name@vhost import id", () => {
    const out = rabbitTerraformExport.mapResource({
      id: "acct:rabbitmq-queue:%2F/orders",
      pluginId: "rabbitmq",
      resourceTypeId: "rabbitmq-queue",
      accountId: ACCOUNT,
      displayName: "orders",
      fields: {
        vhost: "/",
        name: "orders",
        durable: true,
        autoDelete: false,
        arguments: '{"x-queue-type":"quorum"}',
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    });
    expect(out?.resource.type).toBe("rabbitmq_queue");
    expect(out?.resource.importId).toBe("orders@/");
  });
});
