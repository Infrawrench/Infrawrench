import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DigitalOceanClient } from "../client.js";
import { manifest } from "../plugin.js";

const ACC = "acc1";

interface HostRequest {
  url: string;
  method: string;
  caCert?: string;
}

const answering = (body: string, status = 200) =>
  vi.fn(async (_request: HostRequest) => ({ status, headers: {}, body }));

function hosted(
  request: ReturnType<typeof answering>,
  credentials: Record<string, string> = {},
  requestStream?: (request: HostRequest) => Promise<{
    status: number;
    headers: Record<string, string>;
    body: ReadableStream<Uint8Array>;
  }>,
) {
  return hostClient(
    new DigitalOceanClient({ apiToken: "tok", ...credentials }, [], {
      http: { request, ...(requestStream ? { requestStream } : {}) },
    }),
  );
}

describe("every provider call goes through the host's HTTP service (#370)", () => {
  const unexpected = vi.fn(async () => {
    throw new Error("reached the global fetch");
  });

  beforeEach(() => {
    unexpected.mockClear();
    vi.stubGlobal("fetch", unexpected);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends a typed call there, with no CA of its own", async () => {
    const request = answering(JSON.stringify({ load_balancers: [] }));
    await hosted(request).listResources("load-balancer", ACC);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![0].url).toContain(
      "https://api.digitalocean.com/v2/load_balancers",
    );
    expect(request.mock.calls[0]![0]).not.toHaveProperty("caCert");
    expect(unexpected).not.toHaveBeenCalled();
  });

  it("sends every Spaces storage browser call there", async () => {
    const request = answering("<ListBucketResult></ListBucketResult>");
    const spaces = hosted(request, { spacesAccessKeyId: "AK", spacesSecretAccessKey: "SK" });
    await spaces.listStorageObjects("b", "");
    await spaces.uploadStorageObject("b", "k", new File(["x"], "x"));
    await spaces.makeStorageFolder("b", "f/");
    await spaces.deleteStorageObject("b", "k");
    await spaces.getManifest(`${ACC}:spaces-bucket:b`, ACC);
    await spaces.applyManifest(`${ACC}:spaces-bucket:b`, ACC, "{}");
    const methods = request.mock.calls.map(([call]) => call.method);
    expect(methods).toEqual(expect.arrayContaining(["GET", "PUT", "DELETE"]));
    for (const [call] of request.mock.calls) {
      expect(call.url).toContain("digitaloceanspaces.com");
    }
    expect(unexpected).not.toHaveBeenCalled();
  });

  it("sends a written call there", async () => {
    const request = answering(JSON.stringify({ usage: {} }));
    await hosted(request).fetchMetricSeries("gen-ai-agent", `${ACC}:gen-ai-agent:a-1`, ACC);
    expect(request.mock.calls[0]![0].url).toContain("/gen-ai/agents/a-1/usage");
    expect(unexpected).not.toHaveBeenCalled();
  });

  it("reads a kubeconfig there", async () => {
    const request = answering("apiVersion: v1\n");
    await expect(
      hosted(request).resolveOutput("doks-cluster", `${ACC}:doks-cluster:c-1`, "kubeconfig", ACC),
    ).resolves.toBe("apiVersion: v1\n");
    expect(request.mock.calls[0]![0].url).toContain("/kubernetes/clusters/c-1/kubeconfig");
    expect(unexpected).not.toHaveBeenCalled();
  });

  it("lists inference batches and cancels one there", async () => {
    const request = answering(JSON.stringify({ data: [{ batch_id: "b-1", status: "running" }] }));
    const client = hosted(request);
    const [batch] = await client.listResources("inference-batch", ACC);
    expect(batch!.externalId).toBe("b-1");
    await client.deleteResource("inference-batch", `${ACC}:inference-batch:b-1`, ACC);
    expect(request.mock.calls.map(([r]) => `${r.method} ${r.url}`)).toEqual([
      "GET https://inference.do-ai.run/v1/batches?limit=100",
      "POST https://inference.do-ai.run/v1/batches/b-1/cancel",
    ]);
    expect(unexpected).not.toHaveBeenCalled();
  });

  it("lists Spaces buckets there", async () => {
    const request = vi.fn(async (r: HostRequest) =>
      r.url.includes("digitaloceanspaces.com")
        ? { status: 200, headers: {}, body: "<ListAllMyBucketsResult/>" }
        : { status: 200, headers: {}, body: JSON.stringify({ projects: [] }) },
    );
    await hosted(request, {
      spacesAccessKeyId: "key",
      spacesSecretAccessKey: "secret",
    }).listResources("spaces-bucket", ACC);
    expect(request.mock.calls.some(([r]) => r.url.endsWith(".digitaloceanspaces.com/"))).toBe(true);
    expect(unexpected).not.toHaveBeenCalled();
  });

  it("streams the agent playground there", async () => {
    const request = vi.fn(async (r: HostRequest) => {
      if (r.url.includes("/api_keys"))
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ api_key_info: { secret_key: "s" } }),
        };
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          agent: { uuid: "a-1", deployment: { url: "https://a.agents.do-ai.run" } },
        }),
      };
    });
    const requestStream = vi.fn(async (_request: HostRequest) => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n')
        .body as ReadableStream<Uint8Array>,
    }));
    const events = [];
    for await (const event of hosted(request, {}, requestStream).streamChatMessage(
      "gen-ai-agent",
      `${ACC}:gen-ai-agent:a-1`,
      ACC,
      [{ role: "user", content: "hello" }],
    )) {
      events.push(event);
    }
    expect(requestStream.mock.calls[0]![0].url).toBe(
      "https://a.agents.do-ai.run/api/v1/chat/completions",
    );
    expect(events.length).toBeGreaterThan(0);
    expect(unexpected).not.toHaveBeenCalled();
  });

  it("names every host it calls, so a bastion's allowlist lets them through", () => {
    expect(manifest.egressHosts).toEqual(
      expect.arrayContaining(["api.digitalocean.com", "*.digitaloceanspaces.com", "*.do-ai.run"]),
    );
  });
});

describe("ids go on the wire encoded (#417)", () => {
  const seen: string[] = [];
  const answer = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const client = () => hostClient(new DigitalOceanClient({ apiToken: "tok" }));

  beforeEach(() => {
    seen.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        seen.push(String(input).replace("https://api.digitalocean.com/v2", ""));
        return answer({
          data: { result: [] },
          droplet: { id: "1&evil=1", name: "d" },
          projects: [],
        });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps a `/` or `?` in an id from changing the route a delete reaches", async () => {
    await client().deleteResource("droplet", `${ACC}:droplet:1/../2?force=1`, ACC);
    expect(seen).toEqual(["/droplets/1%2F..%2F2%3Fforce%3D1"]);
  });

  it("encodes the halves of a composite id on their own", async () => {
    await client().deleteResource("dns-record", `${ACC}:dns-record:a.example/7?x`, ACC);
    expect(seen).toEqual(["/domains/a.example/records/7%3Fx"]);
  });

  it("keeps a `&` in an id from adding a query parameter", async () => {
    await client().fetchMetricSeries("droplet", `${ACC}:droplet:1&evil=1`, ACC, {
      startMs: 1_000,
      endMs: 2_000,
    });
    const cpu = seen.find((path) => path.startsWith("/monitoring/metrics/droplet/cpu"));
    expect(cpu).toContain("host_id=1%26evil%3D1");
    expect(seen.every((path) => !path.includes("&evil="))).toBe(true);
  });

  it.each([
    ["droplet", `${ACC}:droplet:`],
    ["dns-record", `${ACC}:dns-record:a.example/`],
    ["agent-api-key", `${ACC}:agent-api-key:/key-1`],
  ])("refuses to delete a %s with a blank id", async (typeId, resourceId) => {
    await expect(client().deleteResource(typeId, resourceId, ACC)).rejects.toThrow();
    expect(seen).toEqual([]);
  });
});
