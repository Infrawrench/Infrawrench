import { describe, expect, it, vi } from "vitest";
import type { HttpHostServices } from "@infrawrench/plugin-base";
import { HuggingFaceClient, jobSpecFrom } from "../client.js";
import { parseNextLink } from "../http.js";
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

describe("http", () => {
  it("parses the next link out of an RFC 8288 header", () => {
    expect(
      parseNextLink('<https://huggingface.co/api/models?cursor=abc>; rel="next", <x>; rel="prev"'),
    ).toBe("https://huggingface.co/api/models?cursor=abc");
    expect(parseNextLink(undefined)).toBeUndefined();
  });
});

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
    const client = new HuggingFaceClient({ apiToken: "hf_x", namespace: "acme" }, { http });
    const items = await client.listResources("hf-model", ACCOUNT);
    expect(items.map((i) => i.externalId)).toEqual(["acme/a", "acme/b"]);
    expect(items[0]?.fields["visibility"]).toBe("private");
    expect(items[0]?.fields["gated"]).toBe("manual");
    expect(items[1]?.fields["pipelineTag"]).toBe("text-generation");
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer hf_x");
    expect(calls[0]?.url).toContain("expand[]=usedStorage");
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
    const client = new HuggingFaceClient({ apiToken: "hf_x", namespace: "acme" }, { http });
    const [ep] = await client.listResources("hf-inference-endpoint", ACCOUNT);
    expect(ep?.fields["pricePerHour"]).toBe(0.5);
    expect(ep?.fields["container"]).toBe("Text Generation Inference");
    expect(ep?.resolvedOutputs["chatCompletionsUrl"]).toBe(
      "https://x.endpoints.huggingface.cloud/v1/chat/completions",
    );
  });

  it("reads a namespace without endpoint billing as no endpoints", async () => {
    const { http } = host(() => ({ status: 401, body: { error: "no billing" } }));
    const client = new HuggingFaceClient({ apiToken: "hf_x", namespace: "acme" }, { http });
    expect(await client.listResources("hf-inference-endpoint", ACCOUNT)).toEqual([]);
  });

  it("attaches the HTTP status to thrown errors", async () => {
    const { http } = host(() => ({ status: 500, body: { error: "boom" } }));
    const client = new HuggingFaceClient({ apiToken: "hf_x", namespace: "acme" }, { http });
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
    const client = new HuggingFaceClient({ apiToken: "hf_x" }, { http });
    await client.listResources("hf-space", ACCOUNT);
    expect(calls[1]?.url).toContain("/api/spaces?author=alice");
    // A user namespace has no service accounts and makes no org call.
    expect(await client.listResources("hf-service-account", ACCOUNT)).toEqual([]);
  });
});

describe("mutations", () => {
  it("creates a custom endpoint from the picked compute", async () => {
    const { http, calls } = host((req) => {
      if (req.url.includes("/v2/provider/acme")) return { body: VENDORS };
      if (req.method === "POST") return { body: { name: "chat", status: { state: "pending" } } };
      return { body: {} };
    });
    const client = new HuggingFaceClient({ apiToken: "hf_x", namespace: "acme" }, { http });
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
    const client = new HuggingFaceClient({ apiToken: "hf_x", namespace: "acme" }, { http });
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
    const client = new HuggingFaceClient({ apiToken: "hf_x", namespace: "acme" }, { http });
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
    const client = new HuggingFaceClient({ apiToken: "hf_x", namespace: "acme" }, { http });
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
    const options = await plugin.listCredentialOptions!(
      "namespace",
      { apiToken: "hf_x" },
      { http },
    );
    expect(options.map((o) => o.id)).toEqual(["alice", "acme"]);
  });
});
