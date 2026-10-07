import { describe, expect, it, vi } from "vitest";
import type { HttpHostServices } from "@infrawrench/plugin-base";
import { FalClient, analyticsSeries, modelUsageRows, serverlessUsageRows } from "../client.js";
import { parseStatusFeed } from "../status-feed.js";

const ACCOUNT = "acct";

function host(handler: (url: string, method: string) => { status?: number; body?: unknown }) {
  const calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }> = [];
  const http: HttpHostServices = {
    request: vi.fn(async (req) => {
      const body = typeof req.body === "string" ? req.body : undefined;
      calls.push({
        url: req.url,
        method: req.method,
        headers: req.headers,
        ...(body !== undefined ? { body } : {}),
      });
      const res = handler(req.url, req.method);
      return { status: res.status ?? 200, headers: {}, body: JSON.stringify(res.body ?? {}) };
    }),
  };
  return { http, calls };
}

describe("fal client", () => {
  it("authenticates with the Key scheme and builds models from 30-day usage", async () => {
    const { http, calls } = host((url) => {
      if (url.includes("/models/usage")) {
        return {
          body: {
            summary: [
              {
                endpoint_id: "fal-ai/flux/dev",
                unit: "megapixels",
                quantity: 10,
                cost_total: 0.25,
              },
              {
                endpoint_id: "fal-ai/flux/dev",
                unit: "megapixels",
                quantity: 5,
                cost_total: 0.125,
              },
            ],
            next_cursor: null,
          },
        };
      }
      if (url.includes("/models/pricing"))
        return {
          body: {
            prices: [{ endpoint_id: "fal-ai/flux/dev", unit_price: 0.025, unit: "megapixels" }],
          },
        };
      if (url.includes("/models?"))
        return {
          body: {
            models: [
              {
                endpoint_id: "fal-ai/flux/dev",
                metadata: { display_name: "FLUX.1 [dev]", category: "text-to-image" },
              },
            ],
          },
        };
      throw new Error(url);
    });
    const [m] = await new FalClient({ apiKey: "id:secret" }, { http }).listResources(
      "fal-model",
      ACCOUNT,
    );
    expect(calls[0]?.headers["Authorization"]).toBe("Key id:secret");
    expect(m?.fields["quantity30d"]).toBe(15);
    expect(m?.fields["cost30d"]).toBe(0.38);
    expect(m?.fields["unitPrice"]).toBe(0.025);
    expect(m?.displayName).toBe("FLUX.1 [dev] (fal-ai/flux/dev)");
    expect(m?.resolvedOutputs["queueUrl"]).toBe("https://queue.fal.run/fal-ai/flux/dev");
  });

  it("reads a non-admin key as no admin-only resources", async () => {
    const { http } = host(() => ({ status: 403, body: { error: { message: "admin required" } } }));
    const client = new FalClient({ apiKey: "k" }, { http });
    expect(await client.listResources("fal-api-key", ACCOUNT)).toEqual([]);
    expect(await client.listResources("fal-model", ACCOUNT)).toEqual([]);
  });

  it("follows next_cursor and attaches status to errors", async () => {
    const { http, calls } = host((url) => {
      if (url.includes("cursor=c2"))
        return { body: { instances: [{ id: "i2", status: "ready" }], next_cursor: null } };
      return { body: { instances: [{ id: "i1", status: "init" }], next_cursor: "c2" } };
    });
    const items = await new FalClient({ apiKey: "k" }, { http }).listResources(
      "fal-compute-instance",
      ACCOUNT,
    );
    expect(items.map((i) => i.externalId)).toEqual(["i1", "i2"]);
    expect(calls[1]?.url).toContain("cursor=c2");
    const failing = host(() => ({ status: 500, body: {} }));
    await expect(
      new FalClient({ apiKey: "k" }, { http: failing.http }).listResources("fal-workflow", ACCOUNT),
    ).rejects.toMatchObject({ status: 500 });
  });

  it("mints a replacement key and returns the secret once", async () => {
    const { http, calls } = host((url, method) => {
      if (method === "POST")
        return { body: { key_id: "new", key_secret: "s3cret", key: "new:s3cret" } };
      return { body: { keys: [{ key_id: "old", alias: "ci" }], next_cursor: null } };
    });
    const res = await new FalClient({ apiKey: "k" }, { http }).exportCredential(
      "fal-api-key",
      `${ACCOUNT}:fal-api-key:old`,
      ACCOUNT,
      "replacement-key",
    );
    expect(res.content).toBe("new:s3cret");
    expect(JSON.parse(calls.find((c) => c.method === "POST")?.body ?? "{}")).toEqual({
      alias: "ci",
    });
  });

  it("reads the credit balance", async () => {
    const { http } = host(() => ({
      body: { username: "me", credits: { current_balance: 12.5, currency: "usd" } },
    }));
    expect(await new FalClient({ apiKey: "k" }, { http }).fetchCreditBalance(ACCOUNT)).toEqual([
      { key: "USD", label: "fal credits", remaining: 12.5, currency: "USD" },
    ]);
  });
});

describe("mappers", () => {
  const range = { fromDate: "2026-10-01", toDate: "2026-10-31" };
  it("maps model usage buckets to UTC days", () => {
    const rows = modelUsageRows(
      [
        {
          time_series: [
            {
              bucket: "2026-10-02T00:00:00+00:00",
              results: [
                {
                  endpoint_id: "a/b",
                  unit: "images",
                  quantity: 4,
                  cost_total: 0.2,
                  currency: "USD",
                  auth_method: "Key ci",
                },
              ],
            },
            {
              bucket: "2026-09-30T00:00:00+00:00",
              results: [{ endpoint_id: "a/b", cost_total: 1 }],
            },
          ],
        },
      ],
      range,
    );
    expect(rows).toEqual([
      {
        date: "2026-10-02",
        service: "Model APIs",
        resourceId: "a/b",
        tags: { auth: "Key ci" },
        currency: "USD",
        amount: 0.2,
        usageAmount: 4,
        usageUnit: "images",
      },
    ]);
  });

  it("tags serverless usage with machine type and surge", () => {
    const [row] = serverlessUsageRows(
      [
        {
          time_series: [
            {
              bucket: "2026-10-05T00:00:00Z",
              results: [
                {
                  app: "me/app",
                  machine_type: "GPU-H100",
                  environment: "main",
                  is_surge: true,
                  unit: "seconds",
                  quantity: 60,
                  cost_total: 0.1,
                },
              ],
            },
          ],
        },
      ],
      range,
    );
    expect(row?.tags).toEqual({ machineType: "GPU-H100", environment: "main", surge: "true" });
  });

  it("builds analytics series with seconds for durations", () => {
    const series = analyticsSeries([
      {
        time_series: [
          {
            bucket: "2026-10-01T00:00:00Z",
            results: [{ endpoint_id: "a", request_count: 3, p50_duration: 1.5 }],
          },
        ],
      },
    ]);
    expect(series.map((x) => [x.label, x.unit])).toEqual([
      ["Request", "requests"],
      ["Execution time p50", "s"],
    ]);
  });

  it("parses Instatus summaries and skips maintenance that has not started", () => {
    const incidents = parseStatusFeed(
      JSON.stringify({
        page: { name: "fal", status: "HASISSUES" },
        activeIncidents: [
          {
            id: "i1",
            name: "Slow queue",
            started: "2026-10-01T10:00:00Z",
            status: "INVESTIGATING",
            impact: "PARTIALOUTAGE",
          },
        ],
        activeMaintenances: [
          { id: "m1", name: "DB", start: "2026-10-09T10:00:00Z", status: "NOTSTARTEDYET" },
        ],
      }),
    );
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ externalId: "i1", impact: "major", providerWide: true });
    expect(parseStatusFeed(JSON.stringify({ page: { status: "UP" } }))).toEqual([]);
  });
});
