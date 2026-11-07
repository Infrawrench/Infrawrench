import { hostClient } from "@infrawrench/plugin-base/effect";
import { describe, expect, it, vi } from "vitest";
import type { HttpHostServices } from "@infrawrench/plugin-base";
import { FalClient, analyticsSeries, modelUsageRows, serverlessUsageRows } from "../client.js";
import type { ModelUsagePage, ServerlessUsagePage } from "../api.js";
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
    const [m] = await hostClient(new FalClient({ apiKey: "id:secret" }, { http })).listResources(
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
    const client = hostClient(new FalClient({ apiKey: "k" }, { http }));
    expect(await client.listResources("fal-api-key", ACCOUNT)).toEqual([]);
    expect(await client.listResources("fal-model", ACCOUNT)).toEqual([]);
  });

  it("follows next_cursor and attaches status to errors", async () => {
    const { http, calls } = host((url) => {
      if (url.includes("cursor=c2"))
        return { body: { instances: [{ id: "i2", status: "ready" }], next_cursor: null } };
      return { body: { instances: [{ id: "i1", status: "init" }], next_cursor: "c2" } };
    });
    const items = await hostClient(new FalClient({ apiKey: "k" }, { http })).listResources(
      "fal-compute-instance",
      ACCOUNT,
    );
    expect(items.map((i) => i.externalId)).toEqual(["i1", "i2"]);
    expect(calls[1]?.url).toContain("cursor=c2");
    const failing = host(() => ({ status: 500, body: {} }));
    await expect(
      hostClient(new FalClient({ apiKey: "k" }, { http: failing.http })).listResources(
        "fal-workflow",
        ACCOUNT,
      ),
    ).rejects.toMatchObject({ status: 500 });
  });

  it("mints a replacement key and returns the secret once", async () => {
    const { http, calls } = host((url, method) => {
      if (method === "POST")
        return { body: { key_id: "new", key_secret: "s3cret", key: "new:s3cret" } };
      return { body: { keys: [{ key_id: "old", alias: "ci" }], next_cursor: null } };
    });
    const res = await hostClient(new FalClient({ apiKey: "k" }, { http })).exportCredential(
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

  it("asks for creator_info, which is what fills Created By on an API key", async () => {
    const { http, calls } = host(() => ({
      body: { keys: [{ key_id: "a", creator_nickname: "ada" }], next_cursor: null },
    }));
    const [key] = await hostClient(new FalClient({ apiKey: "k" }, { http })).listResources(
      "fal-api-key",
      ACCOUNT,
    );
    expect(new URL(calls[0]?.url ?? "").searchParams.get("expand")).toBe("creator_info");
    expect(key?.fields["creator"]).toBe("ada");
  });

  it("reads the credit balance", async () => {
    const { http } = host(() => ({
      body: { username: "me", credits: { current_balance: 12.5, currency: "usd" } },
    }));
    expect(
      await hostClient(new FalClient({ apiKey: "k" }, { http })).fetchCreditBalance(ACCOUNT),
    ).toEqual([{ key: "USD", label: "fal credits", remaining: 12.5, currency: "USD" }]);
  });
});

describe("reading every row of a list", () => {
  const client = (http: HttpHostServices) => hostClient(new FalClient({ apiKey: "k" }, { http }));
  const COST_RANGE = { fromDate: "2026-10-01", toDate: "2026-10-31" };

  it.each([
    ["fal-compute-instance", "instances", { id: "i" }, 100],
    ["fal-api-key", "keys", { key_id: "k" }, 100],
    ["fal-workflow", "workflows", { name: "w" }, 100],
  ])("throws when %s never ends, after its cap", async (type, key, row, pages) => {
    const { http, calls } = host(() => ({ body: { [key]: [row], next_cursor: "more" } }));
    await expect(client(http).listResources(type, ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(pages);
  });

  it("throws when the model usage summary never ends, past the 403 catch", async () => {
    const { http, calls } = host(() => ({
      body: { summary: [{ endpoint_id: "a/b" }], next_cursor: "more" },
    }));
    await expect(client(http).listResources("fal-model", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(200);
  });

  it("throws when either usage report never ends, past the serverless catch", async () => {
    const endless = (never: string) =>
      host((url) => ({
        body: { time_series: [], next_cursor: url.includes(never) ? "more" : null, apps: [] },
      }));
    const models = endless("/models/usage");
    await expect(client(models.http).fetchCostData(ACCOUNT, COST_RANGE)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(models.calls.filter((c) => c.url.includes("/models/usage"))).toHaveLength(50);
    const serverless = endless("/serverless/usage");
    await expect(client(serverless.http).fetchCostData(ACCOUNT, COST_RANGE)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(serverless.calls.filter((c) => c.url.includes("/serverless/usage"))).toHaveLength(50);
  });

  it("keeps what it read of a chart window instead of failing at the cap", async () => {
    const { http, calls } = host(() => ({
      body: {
        time_series: [
          { bucket: "2026-10-01T00:00:00Z", results: [{ endpoint_id: "a/b", request_count: 1 }] },
        ],
        next_cursor: "more",
      },
    }));
    const series = await client(http).fetchMetricSeries(
      "fal-model",
      `${ACCOUNT}:fal-model:a/b`,
      ACCOUNT,
    );
    expect(series.map((x) => x.label)).toEqual(["Request"]);
    expect(calls).toHaveLength(10);
  });

  it.each([
    ["fal-compute-instance", { instances: [{ id: "i" }], next_cursor: "2" }],
    ["fal-api-key", { keys: [{ key_id: "k" }], next_cursor: "2" }],
    ["fal-workflow", { workflows: [{ name: "w" }], next_cursor: "2" }],
    ["fal-model", { summary: [], next_cursor: "2" }],
  ])("refuses a renamed list for %s, on the first page and a later one", async (type, first) => {
    const renamed = { rows: [], next_cursor: null };
    const atOnce = host(() => ({ body: renamed }));
    await expect(client(atOnce.http).listResources(type, ACCOUNT)).rejects.toThrow("is not a list");
    const later = host((url) => ({ body: url.includes("cursor=2") ? renamed : first }));
    await expect(client(later.http).listResources(type, ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("refuses a Serverless app list and a usage report that are not lists", async () => {
    const apps = host(() => ({ body: { items: [] } }));
    await expect(client(apps.http).listResources("fal-app", ACCOUNT)).rejects.toThrow(
      "is not a list",
    );
    const usage = host((url) => ({
      body: url.includes("/serverless/usage")
        ? { rows: [], next_cursor: null }
        : { time_series: [], next_cursor: null, apps: [] },
    }));
    await expect(client(usage.http).fetchCostData(ACCOUNT, COST_RANGE)).rejects.toThrow(
      "is not a list",
    );
  });

  it("goes on past an empty page that names a next cursor", async () => {
    const { http } = host((url) =>
      url.includes("cursor=2")
        ? { body: { keys: [{ key_id: "k" }], next_cursor: null } }
        : { body: { keys: [], next_cursor: "2" } },
    );
    const keys = await client(http).listResources("fal-api-key", ACCOUNT);
    expect(keys.map((k) => k.externalId)).toEqual(["k"]);
  });

  it("goes through the host and never fetch", async () => {
    const stub = vi.fn(async () => {
      throw new Error("fetch must not be called");
    });
    vi.stubGlobal("fetch", stub);
    try {
      const { http } = host(() => ({ body: { instances: [], next_cursor: null } }));
      await client(http).listResources("fal-compute-instance", ACCOUNT);
      expect(http.request).toHaveBeenCalled();
      expect(vi.mocked(http.request).mock.calls[0]?.[0]).not.toHaveProperty("caCert");
      expect(stub).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

type ModelLine = NonNullable<ModelUsagePage["time_series"]>[number]["results"][number];
type ServerlessLine = NonNullable<ServerlessUsagePage["time_series"]>[number]["results"][number];

/** The money fields the document requires and these cases do not read. */
const unread = {
  unit: "",
  quantity: 0,
  unit_price: 0,
  percent_discount: null,
  cost_subtotal: 0,
  cost_discount: 0,
  cost_total: 0,
  cost: 0,
  currency: "",
};

const modelLine = (line: Partial<ModelLine>): ModelLine => ({
  ...unread,
  endpoint_id: "",
  ...line,
});

const serverlessLine = (line: Partial<ServerlessLine>): ServerlessLine => ({
  ...unread,
  app: null,
  environment: null,
  machine_type: "",
  net_unit_price: 0,
  is_surge: false,
  ...line,
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
                modelLine({
                  endpoint_id: "a/b",
                  unit: "images",
                  quantity: 4,
                  cost_total: 0.2,
                  currency: "USD",
                  auth_method: "Key ci",
                }),
              ],
            },
            {
              bucket: "2026-09-30T00:00:00+00:00",
              results: [modelLine({ endpoint_id: "a/b", cost_total: 1 })],
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
                serverlessLine({
                  app: "me/app",
                  machine_type: "GPU-H100",
                  environment: "main",
                  is_surge: true,
                  unit: "seconds",
                  quantity: 60,
                  cost_total: 0.1,
                }),
              ],
            },
          ],
        },
      ],
      range,
      [],
    );
    expect(row?.tags).toEqual({ machineType: "GPU-H100", environment: "main", surge: "true" });
  });

  it("attaches serverless spend to the app whose name the usage line carries", () => {
    const apps = [
      { name: "my-app", endpoint_id: "user_1/my-app" },
      { name: "my-app-eu", endpoint_id: "user_1/my-app-eu" },
    ];
    const rows = serverlessUsageRows(
      [
        {
          time_series: [
            {
              bucket: "2026-10-05T00:00:00Z",
              results: [
                serverlessLine({ app: "my-app", cost_total: 1 }),
                serverlessLine({ app: "user_1/my-app", cost_total: 2 }),
                serverlessLine({ app: "my-app-prod", cost_total: 3 }),
                serverlessLine({ app: "my-app-eu", cost_total: 4 }),
                serverlessLine({ app: "my-app-eu-dev", cost_total: 5 }),
                serverlessLine({ app: "my-application", cost_total: 6 }),
                serverlessLine({ app: null, cost_total: 7 }),
              ],
            },
          ],
        },
      ],
      range,
      apps,
    );
    expect(rows.map((r) => [r.resourceId, r.tags?.["app"]])).toEqual([
      ["user_1/my-app", undefined],
      ["user_1/my-app", undefined],
      ["user_1/my-app", "my-app-prod"],
      ["user_1/my-app-eu", undefined],
      ["user_1/my-app-eu", "my-app-eu-dev"],
      ["my-application", undefined],
      [undefined, undefined],
    ]);
  });

  it("gives a cost row the external id of the app the same sync lists", async () => {
    const { http } = host((url) => {
      if (url.includes("/serverless/apps"))
        return { body: { apps: [{ name: "my-app", endpoint_id: "user_1/my-app" }] } };
      if (url.includes("/serverless/usage"))
        return {
          body: {
            time_series: [
              {
                bucket: "2026-10-05T00:00:00Z",
                results: [serverlessLine({ app: "my-app", cost_total: 1 })],
              },
            ],
            next_cursor: null,
          },
        };
      return { body: { time_series: [], next_cursor: null } };
    });
    const client = hostClient(new FalClient({ apiKey: "k" }, { http }));
    const [row] = await client.fetchCostData(ACCOUNT, range);
    const [app] = await client.listResources("fal-app", ACCOUNT);
    expect(row?.resourceId).toBe(app?.externalId);
  });

  it("keeps the usage line's name when the key cannot list apps", async () => {
    const { http } = host((url) => {
      if (url.includes("/serverless/apps")) return { status: 403 };
      if (url.includes("/serverless/usage"))
        return {
          body: {
            time_series: [
              {
                bucket: "2026-10-05T00:00:00Z",
                results: [serverlessLine({ app: "my-app", cost_total: 1 })],
              },
            ],
            next_cursor: null,
          },
        };
      return { body: { time_series: [], next_cursor: null } };
    });
    const [row] = await hostClient(new FalClient({ apiKey: "k" }, { http })).fetchCostData(
      ACCOUNT,
      range,
    );
    expect(row?.resourceId).toBe("my-app");
  });

  it("fails the cost read rather than store unattached rows when apps cannot be read", async () => {
    const { http } = host((url) => {
      if (url.includes("/serverless/apps")) return { status: 500 };
      return { body: { time_series: [], next_cursor: null } };
    });
    await expect(
      hostClient(new FalClient({ apiKey: "k" }, { http })).fetchCostData(ACCOUNT, range),
    ).rejects.toMatchObject({ status: 500 });
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
