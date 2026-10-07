import { describe, expect, it, vi } from "vitest";
import type { HttpHostServices } from "@infrawrench/plugin-base";
import { CerebrasClient, parseVersionName } from "../client.js";
import { parsePrometheus } from "../prometheus.js";
import { parseStatusFeed } from "../status-feed.js";

const ACCOUNT = "acct";

function host(
  handler: (
    url: string,
    method: string,
    headers: Record<string, string>,
  ) => { status?: number; body?: unknown },
) {
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
      const res = handler(req.url, req.method, req.headers);
      return {
        status: res.status ?? 200,
        headers: {},
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

describe("models", () => {
  it("joins the key's models with the public catalogue and converts prices per million", async () => {
    const { http, calls } = host((url) => {
      if (url === "https://api.cerebras.ai/v1/models")
        return { body: { data: [{ id: "gpt-oss-120b", owned_by: "OpenAI" }] } };
      if (url.endsWith("/public/v1/models")) {
        return {
          body: {
            data: [
              {
                id: "gpt-oss-120b",
                name: "OpenAI GPT OSS",
                pricing: { prompt: "0.00000035", completion: "0.00000075" },
                limits: { max_context_length: 131072 },
                capabilities: { tools: true, vision: false },
              },
            ],
          },
        };
      }
      throw new Error(url);
    });
    const [m] = await new CerebrasClient({ apiKey: "csk-x" }, { http }).listResources(
      "cerebras-model",
      ACCOUNT,
    );
    expect(m?.fields["inputPricePerMillion"]).toBe(0.35);
    expect(m?.fields["outputPricePerMillion"]).toBe(0.75);
    expect(m?.fields["capabilities"]).toBe("tools");
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer csk-x");
    // The public catalogue is called without credentials.
    expect(calls[1]?.headers["Authorization"]).toBeUndefined();
  });
});

describe("batches and files", () => {
  it("pages batches with the last id as the after cursor", async () => {
    const { http, calls } = host((url) => {
      if (!url.includes("after="))
        return { body: { data: [{ id: "batch_1", status: "in_progress" }], has_more: true } };
      return { body: { data: [{ id: "batch_2", status: "completed" }], has_more: false } };
    });
    const items = await new CerebrasClient({ apiKey: "csk-x" }, { http }).listResources(
      "cerebras-batch",
      ACCOUNT,
    );
    expect(items.map((i) => i.externalId)).toEqual(["batch_1", "batch_2"]);
    expect(calls[1]?.url).toContain("after=batch_1");
  });

  it("reads a Private Preview 403 as an empty list and keeps the status elsewhere", async () => {
    const { http } = host(() => ({ status: 403, body: { message: "not enabled" } }));
    const client = new CerebrasClient({ apiKey: "csk-x" }, { http });
    expect(await client.listResources("cerebras-file", ACCOUNT)).toEqual([]);
    await expect(client.listResources("cerebras-model", ACCOUNT)).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe("dedicated inference", () => {
  it("skips management listings without a management key", async () => {
    const { http, calls } = host(() => ({ body: {} }));
    const client = new CerebrasClient({ apiKey: "csk-x" }, { http });
    expect(await client.listResources("cerebras-endpoint", ACCOUNT)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("lists versions per architecture with the management key", async () => {
    const { http, calls } = host((url) => {
      if (url.endsWith("/orgs/acme/models"))
        return { body: { model_architectures: ["gpt-oss-120b"] } };
      return {
        body: {
          model_versions: [
            {
              name: "orgs/acme/models/gpt-oss-120b/versions/2",
              response: { version_aliases: ["prod"], sync_status: "done" },
            },
          ],
        },
      };
    });
    const client = new CerebrasClient(
      { apiKey: "csk-x", managementKey: "mk", orgName: "acme" },
      { http },
    );
    const [v] = await client.listResources("cerebras-model-version", ACCOUNT);
    expect(v?.externalId).toBe("gpt-oss-120b/2");
    expect(v?.fields["aliases"]).toBe("prod");
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer mk");
    expect(calls[0]?.url).toBe("https://api.cerebras.ai/management/v1/orgs/acme/models");
  });

  it("turns this endpoint's Prometheus samples into one-point series", async () => {
    const text = [
      "# HELP ttft_seconds x",
      'ttft_seconds{endpoint="acme-gpt",organization_id="org_1",statistic="p50"} 0.25',
      'ttft_seconds{endpoint="other",organization_id="org_1",statistic="p50"} 9',
      'requests_count_total{endpoint="acme-gpt",organization_id="org_1"} 12.0',
    ].join("\n");
    const { http, calls } = host(() => ({ body: text }));
    const client = new CerebrasClient({ apiKey: "csk-x", organizationId: "org_1" }, { http });
    const series = await client.fetchMetricSeries(
      "cerebras-endpoint",
      `${ACCOUNT}:cerebras-endpoint:acme-gpt`,
      ACCOUNT,
    );
    expect(series.map((s) => [s.label, s.points[0]?.value, s.unit])).toEqual([
      ["ttft_seconds p50", 0.25, "s"],
      ["requests_count_total", 12, undefined],
    ]);
    expect(calls[0]?.url).toBe("https://cloud.cerebras.ai/api/v1/metrics/organizations/org_1");
  });
});

describe("helpers", () => {
  it("parses version resource names", () => {
    expect(parseVersionName("orgs/a/models/b/versions/3")).toEqual({
      org: "a",
      arch: "b",
      version: "3",
    });
  });

  it("parses Prometheus labels with escapes", () => {
    expect(parsePrometheus('m{a="x\\"y"} 1')[0]?.labels).toEqual({ a: 'x"y' });
  });

  it("maps model components and ignores the console", () => {
    const body = JSON.stringify({
      incidents: [
        {
          id: "i1",
          name: "Slow",
          status: "investigating",
          impact: "minor",
          created_at: "2026-10-01T00:00:00Z",
          components: [{ name: "GPT-OSS-120B" }],
          incident_updates: [],
        },
      ],
    });
    const [incident] = parseStatusFeed(body);
    expect(incident?.services).toEqual(["GPT-OSS-120B"]);
    expect(incident?.resourceTypes).toContain("cerebras-model");
  });
});
