import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CloudflareClient } from "../client.js";
import { CloudflareApi } from "../clients/shared.js";
import { runBasinSql } from "../clients/basin-catalog-client.js";
import { runAnalyticsEngineSql } from "../clients/analytics-engine-client.js";
import { getKVValue, putKVValue, listKVKeys } from "../clients/kv-client.js";
import { fetchMetricSeries } from "../metric-series.js";
import { fetchPipelineMetrics } from "../basin-metrics.js";
import { runCloudflarePreflight } from "../preflight.js";
import { createWorker } from "../clients/worker-client.js";
import { manifest, plugin } from "../plugin.js";

// The real SDK, unlike the other suites: what is under test is how its requests leave.
type HostRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  responseEncoding?: "utf8" | "binary";
};

const ZONE = { id: "z1", name: "example.test", account: { id: "acc1" } };

function answer(status: number, value: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  return {
    status,
    headers,
    body: "",
    rawBody: new TextEncoder().encode(JSON.stringify(value)),
  };
}

const ok = (result: unknown) =>
  answer(200, {
    success: true,
    errors: [],
    messages: [],
    result,
    result_info: { page: 1, per_page: 50, total_pages: 1, count: 1, total_count: 1 },
  });

function hostHttp(route?: (req: HostRequest, path: string) => ReturnType<typeof answer> | null) {
  return vi.fn(async (req: HostRequest) => {
    const url = new URL(req.url);
    const path = url.pathname;
    const routed = route?.(req, path);
    if (routed) return routed;
    // The SDK's pages end on an empty one.
    if (path === "/client/v4/zones" && Number(url.searchParams.get("page") ?? 1) === 1) {
      return ok([ZONE]);
    }
    return ok([]);
  });
}

let fetchStub: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  const { Socket } = await vi.importActual<{
    Socket: { prototype: { connect: () => void } };
  }>("node:net");
  fetchStub = vi.fn(async () => {
    throw new Error("global fetch must not be used");
  });
  vi.stubGlobal("fetch", fetchStub);
  vi.spyOn(Socket.prototype, "connect").mockImplementation(() => {
    throw new Error("a socket must not be opened");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const graphqlHost = () =>
  hostHttp((_req, path) => {
    if (path.endsWith("/graphql")) {
      return answer(200, { data: { viewer: { zones: [], accounts: [] } } });
    }
    return path.includes("/load_balancers/") ? ok({ name: "lb.example.test" }) : null;
  });

const paths = (request: ReturnType<typeof hostHttp>) =>
  request.mock.calls.map(([req]) => `${req.method} ${new URL(req.url).pathname}`);

describe("the Cloudflare SDK through the host's HTTP service", () => {
  it("sends a client's SDK reads through the host", async () => {
    const request = hostHttp();
    const client = hostClient(
      new CloudflareClient({ apiToken: "tok" }, plugin.resourceTypes, { http: { request } }),
    );

    await client.listResources("zone", "acct");

    expect(paths(request)).toContain("GET /client/v4/zones");
    const req = request.mock.calls[0]![0];
    expect(req.headers["authorization"]).toBe("Bearer tok");
    expect(req).not.toHaveProperty("caCert");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  describe("a failed zone read in the real SDK's error shape", () => {
    const zones = [ZONE, { id: "z2", name: "two.test", account: { id: "acc1" } }];
    const failingZoneTwo = (failure: ReturnType<typeof answer>) =>
      hostHttp((req, path) => {
        if (path === "/client/v4/zones") {
          return ok(new URL(req.url).searchParams.get("page") === "2" ? [] : zones);
        }
        return path === "/client/v4/zones/z2/dns_records" ? failure : null;
      });
    const listRecords = (request: ReturnType<typeof hostHttp>) =>
      hostClient(
        new CloudflareClient({ apiToken: "tok" }, plugin.resourceTypes, { http: { request } }),
      ).listResources("dns-record", "acct");

    it("fails the whole type on a 429 once the SDK has stopped retrying", async () => {
      const throttled = answer(429, {
        success: false,
        errors: [{ code: 10000, message: "Rate limited" }],
      });
      const request = failingZoneTwo({
        ...throttled,
        headers: { ...throttled.headers, "retry-after-ms": "1" },
      });
      await expect(listRecords(request)).rejects.toThrow("Rate limited");
    });

    it("does not read a 200 saying success: false as an empty zone", async () => {
      const request = failingZoneTwo(
        answer(200, {
          success: false,
          errors: [{ code: 1000, message: "Temporary failure" }],
          result: null,
        }),
      );
      await expect(listRecords(request)).rejects.toThrow("Temporary failure");
    });

    it("does the same with no host service", async () => {
      fetchStub.mockImplementation(
        async (url: string) =>
          new Response(
            JSON.stringify(
              new URL(url).pathname === "/client/v4/zones"
                ? { success: true, errors: [], result: url.includes("page=2") ? [] : [ZONE] }
                : { success: false, errors: [{ code: 1000, message: "Temporary" }], result: null },
            ),
            { headers: { "content-type": "application/json" } },
          ),
      );
      const client = hostClient(new CloudflareClient({ apiToken: "tok" }, plugin.resourceTypes));
      await expect(client.listResources("dns-record", "acct")).rejects.toThrow("Temporary");
    });

    it("reads a zone that is not entitled as none", async () => {
      const request = failingZoneTwo(
        answer(403, { success: false, errors: [{ code: 1034, message: "Zone not entitled" }] }),
      );
      await expect(listRecords(request)).resolves.toEqual([]);
    });
  });

  it("sends a multipart Worker upload through the host as bytes with its boundary", async () => {
    const request = hostHttp((req) => (req.method === "PUT" ? ok({ id: "w1" }) : null));
    const api = new CloudflareApi("tok", { request });

    await createWorker(api, "acct", { name: "w1", script: "export default {}" });

    const put = request.mock.calls.find(([req]) => req.method === "PUT")![0];
    expect(new URL(put.url).pathname).toBe("/client/v4/accounts/acc1/workers/scripts/w1");
    expect(put.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(put.body).toBeInstanceOf(Uint8Array);
    const sent = new TextDecoder().decode(put.body as Uint8Array);
    expect(sent).toContain("export default {}");
    expect(sent).toContain('name="metadata"');
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("carries the host's refusal as the cause of the SDK's error", async () => {
    class BastionDown extends Error {}
    const down = new BastionDown("bastion is not connected");
    const api = new CloudflareApi("tok", {
      request: vi.fn(async () => {
        throw down;
      }),
    });

    await expect(api.cf.zones.list({}, { maxRetries: 0 })).rejects.toMatchObject({ cause: down });
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("Cloudflare's direct calls through the host's HTTP service", () => {
  const api = (request: ReturnType<typeof hostHttp>) => new CloudflareApi("tok", { request });

  it("api.fetch", async () => {
    const request = hostHttp();
    await api(request).fetch("/accounts/acc1/thing");
    expect(paths(request)).toEqual(["GET /client/v4/accounts/acc1/thing"]);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("KV keys and values", async () => {
    const request = hostHttp((req, path) =>
      req.method === "GET" && path.includes("/values/")
        ? { ...answer(200, {}), rawBody: new TextEncoder().encode("hello") }
        : null,
    );
    const a = api(request);
    await listKVKeys(a, "ns", {});
    await getKVValue(a, "ns", "k");
    await putKVValue(a, "ns", "k", "v");
    expect(paths(request)).toEqual(
      expect.arrayContaining([
        "GET /client/v4/accounts/acc1/storage/kv/namespaces/ns/keys",
        "GET /client/v4/accounts/acc1/storage/kv/namespaces/ns/values/k",
        "PUT /client/v4/accounts/acc1/storage/kv/namespaces/ns/values/k",
      ]),
    );
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("R2 objects through a client", async () => {
    const request = hostHttp();
    const client = hostClient(
      new CloudflareClient({ apiToken: "tok" }, plugin.resourceTypes, { http: { request } }),
    );
    const file = new File([new Uint8Array([1, 2, 250])], "a.bin", { type: "image/png" });

    await client.uploadStorageObject!("bkt", "a.bin", file);
    await client.makeStorageFolder!("bkt", "dir");
    await client.listStorageObjects!("bkt", "");

    const puts = request.mock.calls.filter(([req]) => req.method === "PUT").map(([req]) => req);
    expect(puts.map((req) => new URL(req.url).pathname)).toEqual([
      "/client/v4/accounts/acc1/r2/buckets/bkt/objects/a.bin",
      "/client/v4/accounts/acc1/r2/buckets/bkt/objects/dir%2F",
    ]);
    expect(puts[0]!.body).toEqual(new Uint8Array([1, 2, 250]));
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("Analytics Engine SQL", async () => {
    const request = hostHttp((_req, path) =>
      path.endsWith("/analytics_engine/sql") ? ok({}) : null,
    );
    await runAnalyticsEngineSql(api(request), "SELECT 1");
    expect(request.mock.calls.at(-1)![0].body).toBe("SELECT 1");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("R2 SQL, on its own host", async () => {
    const request = hostHttp((_req, path) =>
      path.includes("/basin-sql/") ? ok({ schema: [], rows: [] }) : null,
    );
    await runBasinSql(api(request), "bkt", "SELECT 1");
    const url = new URL(request.mock.calls.at(-1)![0].url);
    expect(url.hostname).toBe("api.sql.cloudflarestorage.com");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it.each([
    "zone",
    "worker",
    "r2-bucket",
    "durable-object-namespace",
    "turnstile-widget",
    "d1-database",
    "kv-namespace",
    "queue",
    "hyperdrive",
    "ai-gateway",
    "load-balancer",
    "waiting-room",
    "workflow",
  ])("GraphQL metrics for %s", async (type) => {
    const request = graphqlHost();
    await fetchMetricSeries(api(request), type, `acct:${type}:id1/id2`, "acct");
    expect(paths(request)).toContain("POST /client/v4/graphql");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("GraphQL metrics for R2 Data Catalog and pipelines", async () => {
    const request = graphqlHost();
    await fetchPipelineMetrics(api(request), "p1", undefined);
    expect(paths(request)).toContain("POST /client/v4/graphql");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("preflight", async () => {
    const request = hostHttp((_req, path) => {
      if (path.endsWith("/graphql")) return answer(200, { data: { viewer: { budget: 1 } } });
      if (path.endsWith("/user/tokens/verify")) return ok({ status: "active" });
      return null;
    });
    await runCloudflarePreflight("tok", { oauth: false, http: { request } });
    expect(paths(request)).toEqual(
      expect.arrayContaining(["GET /client/v4/user/tokens/verify", "POST /client/v4/graphql"]),
    );
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("streams Workers AI chat through the host", async () => {
    const encoder = new TextEncoder();
    const requestStream = vi.fn(async (_req: HostRequest) => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'),
          );
          c.close();
        },
      }),
    }));
    const request = hostHttp();
    const client = new CloudflareClient({ apiToken: "tok" }, plugin.resourceTypes, {
      http: { request, requestStream },
    });
    const chunks: unknown[] = [];
    const hosted = hostClient(client);
    for await (const chunk of hosted.streamChatMessage!(
      "workers-ai-model",
      "acct:workers-ai-model:@cf/x/y",
      "acct",
      [{ role: "user", content: "hello" }],
    )) {
      chunks.push(chunk);
    }
    expect(requestStream).toHaveBeenCalledOnce();
    expect(new URL(requestStream.mock.calls[0]![0].url).pathname).toBe(
      "/client/v4/accounts/acc1/ai/v1/chat/completions",
    );
    expect(chunks.length).toBeGreaterThan(0);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("egress hosts", () => {
  const matches = (host: string) =>
    manifest.egressHosts.some((pattern) =>
      pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern,
    );

  it("names every host the plugin calls", () => {
    expect(matches("api.cloudflare.com")).toBe(true);
    expect(matches("api.sql.cloudflarestorage.com")).toBe(true);
  });
});
