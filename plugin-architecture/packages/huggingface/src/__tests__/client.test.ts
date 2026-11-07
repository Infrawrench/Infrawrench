import { hostClient, hostPlugin } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpHostServices } from "@infrawrench/plugin-base";
import { HuggingFaceClient, jobSpecFrom } from "../client.js";
import { endpointMetricSeries } from "../metrics.js";
import { inferenceUsageRows, jobsUsageRows } from "../cost.js";
import { parseStatusFeed } from "../status-feed.js";
import { plugin } from "../plugin.js";

const ACCOUNT = "acct";

type Handler = (req: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
}) => { status?: number; body?: unknown; headers?: Record<string, string> };

function host(handler: Handler) {
  const calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }> = [];
  const http: HttpHostServices = {
    request: vi.fn(async (req) => {
      calls.push({
        url: req.url,
        method: req.method,
        headers: req.headers,
        ...(typeof req.body === "string" ? { body: req.body } : {}),
      });
      const res = handler(req);
      return {
        status: res.status ?? 200,
        headers: res.headers ?? {},
        body:
          res.body === undefined
            ? ""
            : typeof res.body === "string"
              ? res.body
              : JSON.stringify(res.body),
      };
    }),
  };
  return { http, calls };
}

const VENDORS = {
  vendors: [
    {
      name: "aws",
      status: "available",
      regions: [
        {
          name: "us-east-1",
          label: "N. Virginia",
          status: "available",
          computes: [
            {
              id: "aws-us-east-1-nvidia-t4-x1",
              accelerator: "gpu",
              numAccelerators: 1,
              memoryGb: 15,
              numCpus: 4,
              instanceType: "nvidia-t4",
              instanceSize: "x1",
              architecture: "NVIDIA T4",
              status: "available",
              pricePerHour: 0.5,
            },
          ],
        },
      ],
    },
  ],
};

describe("listing", () => {
  it("follows Link pagination for models and sends the bearer token", async () => {
    const { http, calls } = host((req) => {
      if (req.url.startsWith("https://huggingface.co/api/models?author=acme")) {
        return {
          body: [{ id: "acme/a", private: true, downloads: 3, gated: "manual" }],
          headers: { Link: '<https://huggingface.co/api/models?page=2>; rel="next"' },
        };
      }
      if (req.url === "https://huggingface.co/api/models?page=2") {
        return { body: [{ id: "acme/b", pipeline_tag: "text-generation" }] };
      }
      throw new Error(`unrouted ${req.url}`);
    });
    const client = hostClient(
      new HuggingFaceClient({ apiToken: "hf_x", namespace: "acme" }, { http }),
    );
    const items = await client.listResources("hf-model", ACCOUNT);
    expect(items.map((i) => i.externalId)).toEqual(["acme/a", "acme/b"]);
    expect(items[0]?.fields["visibility"]).toBe("private");
    expect(items[0]?.fields["gated"]).toBe("manual");
    expect(items[1]?.fields["pipelineTag"]).toBe("text-generation");
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer hf_x");
    expect(calls[0]?.url).toContain("expand[]=usedStorage");
  });

  it("follows a next link holding a comma, rather than end the list on it", async () => {
    const { http } = host((req) => {
      if (req.url.includes("/api/models?author=acme")) {
        return {
          body: [{ id: "acme/a" }],
          headers: {
            Link: '<https://huggingface.co/api/models?filter=a,b&page=2>; rel="next", <https://huggingface.co/api/models?filter=a,b&page=9>; rel="last"',
          },
        };
      }
      if (req.url === "https://huggingface.co/api/models?filter=a,b&page=2") {
        return { body: [{ id: "acme/b" }] };
      }
      throw new Error(`unrouted ${req.url}`);
    });
    const client = hostClient(
      new HuggingFaceClient({ apiToken: "hf_x", namespace: "acme" }, { http }),
    );
    const items = await client.listResources("hf-model", ACCOUNT);
    expect(items.map((i) => i.externalId)).toEqual(["acme/a", "acme/b"]);
  });

  it("pages endpoints by cursor and prices them from the provider catalogue", async () => {
    const { http } = host((req) => {
      if (req.url.includes("/v2/provider/acme")) return { body: VENDORS };
      if (req.url.includes("/v2/endpoint/acme?") && !req.url.includes("cursor=")) {
        return {
          body: {
            items: [
              {
                name: "one",
                type: "authenticated",
                provider: { vendor: "aws", region: "us-east-1" },
                compute: {
                  accelerator: "gpu",
                  instanceType: "nvidia-t4",
                  instanceSize: "x1",
                  scaling: { minReplica: 0, maxReplica: 2, scaleToZeroTimeout: 15 },
                },
                model: { repository: "acme/a", task: "text-generation", image: { tgi: {} } },
                status: {
                  state: "running",
                  url: "https://x.endpoints.huggingface.cloud",
                  targetReplica: 1,
                },
              },
            ],
            nextCursor: "2",
          },
        };
      }
      if (req.url.includes("cursor=2")) return { body: { items: [], nextCursor: null } };
      throw new Error(`unrouted ${req.url}`);
    });
    const client = hostClient(
      new HuggingFaceClient({ apiToken: "hf_x", namespace: "acme" }, { http }),
    );
    const [ep] = await client.listResources("hf-inference-endpoint", ACCOUNT);
    expect(ep?.fields["pricePerHour"]).toBe(0.5);
    expect(ep?.fields["container"]).toBe("Text Generation Inference");
    expect(ep?.resolvedOutputs["chatCompletionsUrl"]).toBe(
      "https://x.endpoints.huggingface.cloud/v1/chat/completions",
    );
  });

  it("reads a namespace without endpoint billing as no endpoints", async () => {
    const { http } = host((req) => {
      if (req.url.endsWith("/api/whoami-v2")) return { body: { name: "alice", orgs: [] } };
      return { status: 401, body: { error: "no billing" } };
    });
    const client = hostClient(
      new HuggingFaceClient({ apiToken: "hf_x", namespace: "acme" }, { http }),
    );
    expect(await client.listResources("hf-inference-endpoint", ACCOUNT)).toEqual([]);
  });

  it("attaches the HTTP status to thrown errors", async () => {
    const { http } = host(() => ({ status: 500, body: { error: "boom" } }));
    const client = hostClient(
      new HuggingFaceClient({ apiToken: "hf_x", namespace: "acme" }, { http }),
    );
    await expect(client.listResources("hf-model", ACCOUNT)).rejects.toMatchObject({
      status: 500,
      message: expect.stringContaining("boom"),
    });
  });

  it("defaults the namespace to the token's user", async () => {
    const { http, calls } = host((req) => {
      if (req.url.endsWith("/api/whoami-v2")) return { body: { name: "alice", orgs: [] } };
      return { body: [] };
    });
    const client = hostClient(new HuggingFaceClient({ apiToken: "hf_x" }, { http }));
    await client.listResources("hf-space", ACCOUNT);
    expect(calls[1]?.url).toContain("/api/spaces?author=alice");
    // A user namespace has no service accounts and makes no org call.
    expect(await client.listResources("hf-service-account", ACCOUNT)).toEqual([]);
  });
});

function org(http: HttpHostServices) {
  return hostClient(new HuggingFaceClient({ apiToken: "hf_x", namespace: "acme" }, { http }));
}

/** An answer for the token's identity, so `acme` reads as an organization. */
const WHOAMI = { name: "alice", orgs: [{ name: "acme" }] };

describe("lists that page by Link header", () => {
  const next = (url: string) => ({ Link: `<${url}>; rel="next"` });

  it("reads every page of a namespace's Jobs", async () => {
    const { http } = host((req) => {
      if (req.url === "https://huggingface.co/api/jobs/acme") {
        return {
          body: [{ id: "a" }],
          headers: next("https://huggingface.co/api/jobs/acme?cursor=two"),
        };
      }
      if (req.url === "https://huggingface.co/api/jobs/acme?cursor=two") {
        return { body: [{ id: "b" }] };
      }
      throw new Error(`unrouted ${req.url}`);
    });
    const items = await org(http).listResources("hf-job", ACCOUNT);
    expect(items.map((i) => i.externalId)).toEqual(["a", "b"]);
  });

  it("reads every page of member tokens, at the largest page size the document allows", async () => {
    const { http, calls } = host((req) => {
      if (req.url.endsWith("/api/whoami-v2")) return { body: WHOAMI };
      if (req.url === "https://huggingface.co/api/organizations/acme/settings/tokens?limit=100") {
        return {
          body: [{ _id: "t1" }],
          headers: next(
            "https://huggingface.co/api/organizations/acme/settings/tokens?limit=100&cursor=0123456789abcdef01234567",
          ),
        };
      }
      if (req.url.includes("cursor=0123456789abcdef01234567")) return { body: [{ _id: "t2" }] };
      throw new Error(`unrouted ${req.url}`);
    });
    const items = await org(http).listResources("hf-member-token", ACCOUNT);
    expect(items.map((i) => i.externalId)).toEqual(["t1", "t2"]);
    expect(calls.filter((c) => c.url.includes("/settings/tokens"))).toHaveLength(2);
  });

  it("finds a member token past the first page", async () => {
    const { http } = host((req) => {
      if (req.url.endsWith("/api/whoami-v2")) return { body: WHOAMI };
      if (req.url.includes("cursor=0123456789abcdef01234567")) return { body: [{ _id: "t2" }] };
      if (req.url.includes("/settings/tokens")) {
        return {
          body: [{ _id: "t1" }],
          headers: next(
            "https://huggingface.co/api/organizations/acme/settings/tokens?cursor=0123456789abcdef01234567",
          ),
        };
      }
      throw new Error(`unrouted ${req.url}`);
    });
    const found = await org(http).getResource(
      "hf-member-token",
      `${ACCOUNT}:hf-member-token:t2`,
      ACCOUNT,
    );
    expect(found.externalId).toBe("t2");
  });

  it.each([
    ["hf-job", "/api/jobs/acme", 500],
    ["hf-member-token", "/settings/tokens", 100],
    ["hf-model", "/api/models", 20],
  ])("throws when %s never ends, after its page cap", async (type, path, pages) => {
    let page = 0;
    const { http, calls } = host((req) => {
      if (req.url.endsWith("/api/whoami-v2")) return { body: WHOAMI };
      page += 1;
      return {
        body: [{ id: `r${page}`, _id: `r${page}` }],
        headers: next(`https://huggingface.co${path}?cursor=${page}`),
      };
    });
    await expect(org(http).listResources(type, ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls.filter((c) => c.url.includes(path))).toHaveLength(pages);
  });

  it.each([
    ["hf-job", "/api/jobs/acme"],
    ["hf-member-token", "/settings/tokens"],
    ["hf-model", "/api/models"],
  ])("refuses to send the token to another host from %s", async (type, path) => {
    const { http, calls } = host((req) => {
      if (req.url.endsWith("/api/whoami-v2")) return { body: WHOAMI };
      if (req.url.includes("evil.example")) throw new Error("reached the other host");
      if (req.url.includes(path)) {
        return { body: [{ id: "a", _id: "a" }], headers: next("https://evil.example/steal") };
      }
      throw new Error(`unrouted ${req.url}`);
    });
    await expect(org(http).listResources(type, ACCOUNT)).rejects.toThrow(
      "Refusing to send the account's credentials there",
    );
    expect(calls.some((c) => c.url.includes("evil.example"))).toBe(false);
  });

  it("resolves a relative next link on the host it came from", async () => {
    const { http } = host((req) => {
      if (req.url === "https://huggingface.co/api/jobs/acme") {
        return { body: [{ id: "a" }], headers: next("/api/jobs/acme?cursor=two") };
      }
      if (req.url === "https://huggingface.co/api/jobs/acme?cursor=two") {
        return { body: [{ id: "b" }] };
      }
      throw new Error(`unrouted ${req.url}`);
    });
    const items = await org(http).listResources("hf-job", ACCOUNT);
    expect(items.map((i) => i.externalId)).toEqual(["a", "b"]);
  });

  it("keeps reading past an empty page that names another", async () => {
    const { http } = host((req) => {
      if (req.url === "https://huggingface.co/api/jobs/acme") {
        return { body: [], headers: next("https://huggingface.co/api/jobs/acme?cursor=two") };
      }
      if (req.url.endsWith("cursor=two")) return { body: [{ id: "b" }] };
      throw new Error(`unrouted ${req.url}`);
    });
    const items = await org(http).listResources("hf-job", ACCOUNT);
    expect(items.map((i) => i.externalId)).toEqual(["b"]);
  });
});

describe("answers that are not a list", () => {
  it.each([
    ["hf-job"],
    ["hf-scheduled-job"],
    ["hf-service-account"],
    ["hf-member-token"],
    ["hf-webhook"],
    ["hf-model"],
  ])("throws on %s answered with no body, rather than read it as empty", async (type) => {
    const { http } = host((req) => {
      if (req.url.endsWith("/api/whoami-v2")) return { body: WHOAMI };
      return { body: "" };
    });
    await expect(org(http).listResources(type, ACCOUNT)).rejects.toThrow("is not a list");
  });

  it.each([
    ["hf-job"],
    ["hf-scheduled-job"],
    ["hf-service-account"],
    ["hf-member-token"],
    ["hf-webhook"],
  ])("throws on %s answered with null", async (type) => {
    const { http } = host((req) => {
      if (req.url.endsWith("/api/whoami-v2")) return { body: WHOAMI };
      return { body: "null" };
    });
    await expect(org(http).listResources(type, ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("throws on a later Jobs page that is not a list", async () => {
    const { http } = host((req) => {
      if (req.url === "https://huggingface.co/api/jobs/acme") {
        return {
          body: [{ id: "a" }],
          headers: { Link: '<https://huggingface.co/api/jobs/acme?cursor=2>; rel="next"' },
        };
      }
      return { body: { renamed: [] } };
    });
    await expect(org(http).listResources("hf-job", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("throws when the router's model list loses its key", async () => {
    const { http } = host(() => ({ body: { models: [] } }));
    await expect(org(http).listResources("hf-provider-model", ACCOUNT)).rejects.toThrow(
      "is not a list",
    );
  });

  it("throws when the endpoint list loses its key, on the first page or a later one", async () => {
    const first = host((req) => {
      if (req.url.includes("/v2/endpoint/acme")) return { body: { endpoints: [] } };
      return { body: VENDORS };
    });
    await expect(org(first.http).listResources("hf-inference-endpoint", ACCOUNT)).rejects.toThrow(
      "is not a list",
    );
    const later = host((req) => {
      if (req.url.includes("cursor=2")) return { body: { endpoints: [] } };
      if (req.url.includes("/v2/endpoint/acme")) {
        return { body: { items: [{ name: "one" }], nextCursor: "2" } };
      }
      return { body: VENDORS };
    });
    await expect(org(later.http).listResources("hf-inference-endpoint", ACCOUNT)).rejects.toThrow(
      "is not a list",
    );
  });

  it("throws when the Jobs usage answer has no job list", async () => {
    const { http } = host((req) => {
      if (req.url.endsWith("/api/whoami-v2")) return { body: { name: "alice", orgs: [] } };
      return { body: { hasAccess: true, usage: { totalMinutes: 3 } } };
    });
    const client = hostClient(new HuggingFaceClient({ apiToken: "hf_x" }, { http }));
    await expect(
      client.fetchCostData!(ACCOUNT, { fromDate: "2026-11-01", toDate: "2026-11-07" }),
    ).rejects.toThrow("is not a list");
  });

  it("reads a user without Jobs access as no usage", async () => {
    const { http } = host((req) => {
      if (req.url.endsWith("/api/whoami-v2")) return { body: { name: "alice", orgs: [] } };
      return { body: { hasAccess: false } };
    });
    const client = hostClient(new HuggingFaceClient({ apiToken: "hf_x" }, { http }));
    expect(
      await client.fetchCostData!(ACCOUNT, { fromDate: "2026-11-01", toDate: "2026-11-07" }),
    ).toEqual([]);
  });
});

describe("the endpoint list", () => {
  it("reads 10,000 rows, then throws rather than stop short", async () => {
    let page = 0;
    const { http, calls } = host((req) => {
      if (req.url.includes("/v2/provider/")) return { body: VENDORS };
      page += 1;
      return { body: { items: [{ name: `e${page}` }], nextCursor: String(page) } };
    });
    await expect(org(http).listResources("hf-inference-endpoint", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls.filter((c) => c.url.includes("/v2/endpoint/"))).toHaveLength(100);
    expect(calls[0]?.url).toContain("limit=100");
  });
});

describe("a token the API rejects", () => {
  it.each([["hf-inference-endpoint"], ["hf-service-account"], ["hf-member-token"]])(
    "fails %s rather than read a dead token as nothing there",
    async (type) => {
      let whoamis = 0;
      const { http } = host((req) => {
        if (req.url.endsWith("/api/whoami-v2")) {
          whoamis += 1;
          // The first read is cached, which is how a token dies inside the cache window.
          return whoamis === 1 ? { body: WHOAMI } : { status: 401, body: { error: "revoked" } };
        }
        return { status: 401, body: { error: "revoked" } };
      });
      const client = new HuggingFaceClient({ apiToken: "hf_x", namespace: "acme" }, { http });
      await client.whoami();
      await expect(hostClient(client).listResources(type, ACCOUNT)).rejects.toMatchObject({
        status: 401,
      });
    },
  );
});

describe("endpoint logs", () => {
  const logs = (entries: Array<{ timestamp: string; line: string }>) =>
    host((req) => {
      if (req.url.includes("/replica")) return { body: { items: [] } };
      if (req.url.includes("/logs")) return { body: entries };
      throw new Error(`unrouted ${req.url}`);
    });
  const read = (http: HttpHostServices) =>
    org(http).getLogs!("hf-inference-endpoint", `${ACCOUNT}:hf-inference-endpoint:chat`, ACCOUNT, {
      tailLines: 10,
    });
  const older = { timestamp: "2026-11-07T10:00:00.000Z", line: "older" };
  const same = { timestamp: "2026-11-07T10:00:00.000Z", line: "same ms" };
  const newer = { timestamp: "2026-11-07T10:00:01.000Z", line: "newer" };

  it("keeps the chronological order the document promises, and asks for the newest", async () => {
    const { http, calls } = logs([older, same, newer]);
    const { text } = await read(http);
    expect(
      text
        .trim()
        .split("\n")
        .map((l) => l.split(" ").slice(1).join(" ")),
    ).toEqual(["older", "same ms", "newer"]);
    expect(calls.find((c) => c.url.includes("/logs"))?.url).toContain("order=desc");
  });

  it("still reads oldest first if an answer comes newest first", async () => {
    const { http } = logs([newer, same, older]);
    const { text } = await read(http);
    expect(
      text
        .trim()
        .split("\n")
        .map((l) => l.split(" ").slice(1).join(" ")),
    ).toEqual(["older", "same ms", "newer"]);
  });
});

describe("the Playground stream", () => {
  const CHUNKS = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
  const sse = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(CHUNKS));
        controller.close();
      },
    });
  const noFetch = () => {
    const stub = vi.fn(async () => {
      throw new Error("the global fetch was called");
    });
    vi.stubGlobal("fetch", stub);
    return stub;
  };
  const chat = async (client: HuggingFaceClient) => {
    const events = [];
    for await (const event of hostClient(client).streamChatMessage!(
      "hf-provider-model",
      `${ACCOUNT}:hf-provider-model:org/model`,
      ACCOUNT,
      [{ role: "user", content: "hello" }],
    )) {
      events.push(event);
    }
    return events;
  };

  afterEach(() => vi.unstubAllGlobals());

  it("goes through the host's stream, so a bastion carries it", async () => {
    const stub = noFetch();
    const requestStream = vi.fn(async () => ({ status: 200, headers: {}, body: sse() }));
    const request = vi.fn(async () => {
      throw new Error("buffered a stream");
    });
    const events = await chat(
      new HuggingFaceClient({ apiToken: "hf_x" }, { http: { request, requestStream } }),
    );
    expect(events).toContainEqual(expect.objectContaining({ text: "hi" }));
    expect(stub).not.toHaveBeenCalled();
    const [call] = requestStream.mock.calls[0] as unknown as [
      { url: string; caCert?: string; headers: Record<string, string> },
    ];
    expect(call.url).toBe("https://router.huggingface.co/v1/chat/completions");
    expect(call.headers["authorization"]).toBe("Bearer hf_x");
    expect(call).not.toHaveProperty("caCert");
  });

  it("gives the host the account's CA", async () => {
    const stub = noFetch();
    const requestStream = vi.fn(async () => ({ status: 200, headers: {}, body: sse() }));
    const request = vi.fn(async () => {
      throw new Error("buffered a stream");
    });
    await chat(
      new HuggingFaceClient(
        { apiToken: "hf_x", caCert: "PEM" },
        { http: { request, requestStream } },
      ),
    );
    expect(stub).not.toHaveBeenCalled();
    expect(requestStream.mock.calls[0]).toEqual([expect.objectContaining({ caCert: "PEM" })]);
  });

  it("turns a refused answer into a chat error", async () => {
    noFetch();
    const requestStream = vi.fn(async () => ({
      status: 402,
      headers: {},
      body: new Response("out of credits").body,
    }));
    const request = vi.fn(async () => {
      throw new Error("buffered a stream");
    });
    const events = await chat(
      new HuggingFaceClient({ apiToken: "hf_x" }, { http: { request, requestStream } }),
    );
    expect(events).toEqual([
      expect.objectContaining({ kind: "error", message: expect.stringContaining("credits") }),
    ]);
  });
});

describe("mutations", () => {
  it("creates a custom endpoint from the picked compute", async () => {
    const { http, calls } = host((req) => {
      if (req.url.includes("/v2/provider/acme")) return { body: VENDORS };
      if (req.method === "POST") return { body: { name: "chat", status: { state: "pending" } } };
      return { body: {} };
    });
    const client = hostClient(
      new HuggingFaceClient({ apiToken: "hf_x", namespace: "acme" }, { http }),
    );
    await client.createResource("hf-inference-endpoint", ACCOUNT, {
      name: "chat",
      source: "custom",
      repository: "__other__",
      repositoryOther: "meta-llama/Llama-3.1-8B-Instruct",
      task: "text-generation",
      compute: "aws-us-east-1-nvidia-t4-x1",
      minReplica: "0",
      maxReplica: "2",
      scaleToZeroTimeout: "30",
      type: "authenticated",
    });
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("https://api.endpoints.huggingface.cloud/v2/endpoint/acme");
    const body = JSON.parse(post?.body ?? "{}");
    expect(body.provider).toEqual({ vendor: "aws", region: "us-east-1" });
    expect(body.compute.instanceType).toBe("nvidia-t4");
    expect(body.compute.scaling).toEqual({ minReplica: 0, maxReplica: 2, scaleToZeroTimeout: 30 });
    expect(body.model.repository).toBe("meta-llama/Llama-3.1-8B-Instruct");
    expect(body.model.image).toEqual({ huggingface: {} });
  });

  it("rejects an invalid endpoint name before calling the API", async () => {
    const { http, calls } = host(() => ({ body: {} }));
    const client = hostClient(
      new HuggingFaceClient({ apiToken: "hf_x", namespace: "acme" }, { http }),
    );
    await expect(
      client.createResource("hf-inference-endpoint", ACCOUNT, {
        name: "Bad_Name",
        source: "catalog",
      }),
    ).rejects.toThrow(/lowercase/);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("deletes a repository through /api/repos/delete with its owner", async () => {
    const { http, calls } = host(() => ({ body: {} }));
    const client = hostClient(
      new HuggingFaceClient({ apiToken: "hf_x", namespace: "acme" }, { http }),
    );
    await client.deleteResource("hf-dataset", `${ACCOUNT}:hf-dataset:acme/data`, ACCOUNT);
    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.url).toBe("https://huggingface.co/api/repos/delete");
    expect(JSON.parse(del?.body ?? "{}")).toEqual({
      name: "data",
      organization: "acme",
      type: "dataset",
    });
  });

  it("removes a Space secret from a table-row action", async () => {
    const { http, calls } = host(() => ({ body: {} }));
    const client = hostClient(
      new HuggingFaceClient({ apiToken: "hf_x", namespace: "acme" }, { http }),
    );
    await client.invokeAction(
      "hf-space",
      `${ACCOUNT}:hf-space:acme/app`,
      "delete-secret:HF_TOKEN",
      ACCOUNT,
    );
    expect(calls[0]?.url).toBe("https://huggingface.co/api/spaces/acme/app/secrets");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ key: "HF_TOKEN" });
  });

  it("builds a job spec that runs a shell line", () => {
    expect(
      jobSpecFrom({
        spaceId: "__none__",
        image: "python:3.12",
        command: "echo hi",
        flavor: "t4-small",
        environment: "A=1\nB=two=2",
        timeoutSeconds: "60",
      }),
    ).toEqual({
      dockerImage: "python:3.12",
      command: ["/bin/sh", "-c", "echo hi"],
      flavor: "t4-small",
      environment: { A: "1", B: "two=2" },
      timeoutSeconds: 60,
    });
  });
});

describe("metrics, cost and status", () => {
  it("flattens the all-graphs response", () => {
    const series = endpointMetricSeries({
      responseStatusCodeGrouped: {
        series: [{ statusCode: "2xx", data: [{ x: "2026-10-01T00:00:00Z", y: 5 }] }],
      },
      hardwareGpu: {
        series: [
          {
            replicaId: "ep-abc-12345-xyz",
            deviceId: 0,
            data: [{ x: "2026-10-01T00:00:00Z", y: 40 }],
          },
        ],
      },
    });
    expect(series.map((s) => s.label)).toEqual(["Requests (2xx)", "GPU (12345-xyz GPU 0)"]);
  });

  it("maps org inference usage to daily rows in dollars", () => {
    const rows = inferenceUsageRows(
      [
        {
          period: "2026-09-02T00:00:00.000Z",
          usage: [
            { user: "bob", model: "m/x", provider: "groq", requestCount: 10, costCents: 125 },
          ],
        },
        {
          period: "2026-08-01T00:00:00.000Z",
          usage: [{ provider: "groq", requestCount: 1, costCents: 1 }],
        },
      ],
      { fromDate: "2026-09-01", toDate: "2026-09-30" },
    );
    expect(rows).toEqual([
      {
        date: "2026-09-02",
        service: "Inference Providers",
        resourceId: "m/x",
        tags: { provider: "groq", member: "bob" },
        currency: "USD",
        amount: 1.25,
        usageAmount: 10,
        usageUnit: "requests",
      },
    ]);
  });

  it("maps Jobs usage from micro-dollars", () => {
    const rows = jobsUsageRows(
      {
        usage: {
          jobDetails: [
            {
              jobId: "j1",
              hardwareFlavor: "a10g-small",
              totalMinutes: 30,
              totalCostMicroUsd: 500000,
              startedAt: "2026-10-03T10:00:00Z",
            },
          ],
        },
      },
      { fromDate: "2026-10-01", toDate: "2026-10-31" },
    );
    expect(rows[0]).toMatchObject({
      date: "2026-10-03",
      amount: 0.5,
      resourceId: "j1",
      tags: { hardware: "a10g-small" },
    });
  });

  it("parses active Better Stack reports and maps components to types", () => {
    const body = JSON.stringify({
      included: [
        {
          id: "1",
          type: "status_page_resource",
          attributes: { public_name: "Inference Endpoints API" },
        },
        {
          id: "u1",
          type: "status_update",
          attributes: { message: "<p>Looking</p>", published_at: "2026-10-01T10:00:00Z" },
        },
        {
          id: "r1",
          type: "status_report",
          attributes: {
            title: "Endpoints failing",
            aggregate_state: "downtime",
            starts_at: "2026-10-01T09:00:00Z",
            affected_resources: [{ status_page_resource_id: "1", status: "downtime" }],
          },
          relationships: { status_updates: { data: [{ id: "u1" }] } },
        },
        {
          id: "r2",
          type: "status_report",
          attributes: { title: "Old", aggregate_state: "resolved" },
        },
      ],
    });
    const incidents = parseStatusFeed(body);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      externalId: "r1",
      impact: "major",
      resourceTypes: ["hf-inference-endpoint"],
      lastUpdateText: "Looking",
    });
  });
});

describe("namespace picker", () => {
  it("offers the user and each organization", async () => {
    const { http } = host(() => ({
      body: {
        name: "alice",
        fullname: "Alice",
        isPro: true,
        orgs: [{ name: "acme", plan: "team", roleInOrg: "admin" }],
      },
    }));
    const options = await hostPlugin(plugin).listCredentialOptions!(
      "namespace",
      { apiToken: "hf_x" },
      { http },
    );
    expect(options.map((o) => o.id)).toEqual(["alice", "acme"]);
  });
});
