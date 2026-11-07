import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { HttpHostServices, UnreadListPart } from "@infrawrench/plugin-base";
import { FalClient, analyticsSeries, modelUsageRows, serverlessUsageRows } from "../client.js";
import type { ModelUsagePage, ServerlessUsagePage } from "../api.js";
import { manifest } from "../plugin.js";
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

  it.each([
    [{ mode: "preset", preset: "BILLING" }, { preset: "BILLING" }],
    [
      { mode: "custom", permissions: ["models:requests:read"] },
      { permissions: ["models:requests:read"] },
    ],
    [{ mode: "legacy", scope: "ADMIN" }, { preset: "FULL" }],
    [{ mode: "legacy", scope: "API" }, {}],
  ])("gives a replacement key the access of %j", async (access, sent) => {
    const { http, calls } = host((_url, method) =>
      method === "POST"
        ? { body: { key_id: "new", key_secret: "s", key: "new:s" } }
        : {
            body: {
              keys: [{ key_id: "old", alias: "ci", description: "CI", ...access }],
              next_cursor: null,
            },
          },
    );
    await hostClient(new FalClient({ apiKey: "k" }, { http })).exportCredential(
      "fal-api-key",
      `${ACCOUNT}:fal-api-key:old`,
      ACCOUNT,
      "replacement-key",
    );
    expect(JSON.parse(calls.find((c) => c.method === "POST")?.body ?? "{}")).toEqual({
      alias: "ci",
      description: "CI",
      ...sent,
    });
  });

  it("refuses to replace a key it cannot find, and creates nothing", async () => {
    const { http, calls } = host(() => ({ body: { keys: [], next_cursor: null } }));
    await expect(
      hostClient(new FalClient({ apiKey: "k" }, { http })).exportCredential(
        "fal-api-key",
        `${ACCOUNT}:fal-api-key:gone`,
        ACCOUNT,
        "replacement-key",
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("reports a key without the permission rather than a missing key", async () => {
    const { http, calls } = host(() => ({ status: 403, body: {} }));
    await expect(
      hostClient(new FalClient({ apiKey: "k" }, { http })).exportCredential(
        "fal-api-key",
        `${ACCOUNT}:fal-api-key:old`,
        ACCOUNT,
        "replacement-key",
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("names presets, not the ADMIN scope, when a key is refused", async () => {
    const { http } = host(() => ({ status: 403, body: {} }));
    const refused = hostClient(new FalClient({ apiKey: "k" }, { http })).fetchCreditBalance(
      ACCOUNT,
    );
    await expect(refused).rejects.toThrow(/FULL preset/);
    await expect(refused).rejects.not.toThrow(/ADMIN-scope/);
  });

  it.each([
    [{ mode: "preset", preset: "BILLING" }, "BILLING preset"],
    [{ mode: "custom", permissions: ["a:b:read", "c:d:read"] }, "Custom permissions"],
    [{ mode: "legacy", scope: "ADMIN" }, "Legacy ADMIN scope"],
    [{ scope: "API" }, "Legacy API scope"],
    [{ mode: "legacy" }, "Legacy scope"],
    [{}, ""],
  ])("describes the access of %j", async (access, shown) => {
    const { http } = host(() => ({
      body: { keys: [{ key_id: "a", ...access }], next_cursor: null },
    }));
    const client = new FalClient({ apiKey: "k" }, { http });
    const [key] = await hostClient(client).listResources("fal-api-key", ACCOUNT);
    expect(key?.fields["access"]).toBe(shown);
    if (!key) throw new Error("the key was not listed");
    expect(JSON.stringify(client.renderDetail(key))).toContain(shown);
  });

  it("carries a key's permissions, description and expiry onto the resource", async () => {
    const { http } = host(() => ({
      body: {
        keys: [
          {
            key_id: "a",
            mode: "custom",
            description: "CI",
            permissions: ["a:b:read", "c:d:read"],
            expires_at: "2027-01-01T00:00:00Z",
          },
        ],
        next_cursor: null,
      },
    }));
    const [key] = await hostClient(new FalClient({ apiKey: "k" }, { http })).listResources(
      "fal-api-key",
      ACCOUNT,
    );
    expect(key?.fields).toMatchObject({
      permissions: "a:b:read, c:d:read",
      description: "CI",
      expiresAt: "2027-01-01T00:00:00Z",
    });
  });

  it("tells the user which preset to create, and no longer asks for ADMIN", () => {
    const field = manifest.credentialFields.find((c) => c.key === "apiKey");
    expect(field?.label).toBe("API Key");
    expect(field?.description).toContain("FULL preset");
    expect(field?.description).not.toContain("with the ADMIN scope");
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
    const apps = host((url) => ({
      body: url.includes("/serverless/usage")
        ? { time_series: [], next_cursor: null }
        : { items: [] },
    }));
    await expect(client(apps.http).listResources("fal-app", ACCOUNT)).rejects.toThrow(
      "is not a list",
    );
    expect(apps.calls.some((c) => c.url.includes("/serverless/apps"))).toBe(true);
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

describe("Serverless apps outside the main environment", () => {
  const client = (http: HttpHostServices) => hostClient(new FalClient({ apiKey: "k" }, { http }));
  const app = (name: string, environment: string, endpointId = `me/${name}`) => ({
    name,
    environment,
    endpoint_id: endpointId,
  });
  const usage = (...lines: Array<{ environment: string | null; app?: string }>) => ({
    time_series: [
      {
        bucket: "2026-10-05T00:00:00Z",
        results: lines.map((line) => serverlessLine({ app: "my-app", cost_total: 1, ...line })),
      },
    ],
    next_cursor: null,
  });
  const environmentOf = (url: string) => new URL(url).searchParams.get("environment");

  /** An account with my-app in main and in every environment `apps` has. */
  function account(
    lines: ReturnType<typeof usage>,
    apps: Record<string, Array<ReturnType<typeof app>>> = {},
  ) {
    return host((url) => {
      if (url.includes("/serverless/usage")) return { body: lines };
      if (url.includes("/serverless/apps")) {
        const environment = environmentOf(url);
        return {
          body: {
            apps: environment ? (apps[environment] ?? []) : [app("my-app", "main")],
          },
        };
      }
      return { body: { time_series: [], next_cursor: null } };
    });
  }

  it("lists the apps of every environment recent usage names, once each", async () => {
    const { http, calls } = account(
      usage(
        { environment: "staging" },
        { environment: "staging" },
        { environment: "main" },
        {
          environment: null,
        },
      ),
      { staging: [app("my-app", "staging"), app("beta-only", "staging")] },
    );
    const apps = await client(http).listResources("fal-app", ACCOUNT);
    expect(apps.map((a) => [a.externalId, a.fields["environment"]])).toEqual([
      ["me/my-app", "main"],
      ["@staging/me/my-app--staging", "staging"],
      ["@staging/me/beta-only--staging", "staging"],
    ]);
    expect(apps[1]?.id).toBe(`${ACCOUNT}:fal-app:@staging/me/my-app--staging`);
    expect(apps[1]?.displayName).toBe("me/my-app--staging");
    expect(apps[1]?.resolvedOutputs["queueUrl"]).toBe("https://queue.fal.run/me/my-app--staging");
    const reads = calls.filter((c) => c.url.includes("/serverless/apps"));
    expect(reads.map((c) => environmentOf(c.url))).toEqual([null, "staging"]);
  });

  it("keeps an id fal already gave its environment suffix", async () => {
    const { http } = account(usage({ environment: "staging" }), {
      staging: [app("my-app", "staging", "me/my-app--staging")],
    });
    const apps = await client(http).listResources("fal-app", ACCOUNT);
    expect(apps.map((a) => a.externalId)).toEqual(["me/my-app", "@staging/me/my-app--staging"]);
  });

  it("drops rows of another environment when fal ignores the one asked for", async () => {
    const { http } = account(usage({ environment: "production" }), {
      production: [app("my-app", "main")],
    });
    const apps = await client(http).listResources("fal-app", ACCOUNT);
    expect(apps.map((a) => a.externalId)).toEqual(["me/my-app"]);
  });

  it("flushes a staging app's queue by its own id, never main's", async () => {
    const { http, calls } = host(() => ({ status: 204 }));
    await client(http).invokeAction(
      "fal-app",
      `${ACCOUNT}:fal-app:@staging/me/my-app--staging`,
      "flush-queue",
      ACCOUNT,
    );
    expect(calls.map((c) => [c.method, new URL(c.url).pathname])).toEqual([
      ["DELETE", "/v1/serverless/apps/me/my-app--staging/queue"],
    ]);
  });

  it("reads a staging app's metrics and logs by its fal id", async () => {
    const { http, calls } = host((url) =>
      url.includes("/logs/")
        ? { body: { items: [] } }
        : { body: { time_series: [], next_cursor: null } },
    );
    const resourceId = `${ACCOUNT}:fal-app:@staging/me/my-app--staging`;
    await client(http).fetchMetricSeries("fal-app", resourceId, ACCOUNT);
    await client(http).getLogs("fal-app", resourceId, ACCOUNT, {});
    expect(
      calls.map(
        (c) =>
          new URL(c.url).searchParams.get("endpoint_id") ??
          new URL(c.url).searchParams.get("app_id"),
      ),
    ).toEqual(["me/my-app--staging", "me/my-app--staging"]);
  });

  it.each([400, 404, 422])("reads a %d for one environment as no apps there", async (status) => {
    const { http } = host((url) => {
      if (url.includes("/serverless/usage")) return { body: usage({ environment: "production" }) };
      if (environmentOf(url)) return { status };
      return { body: { apps: [app("my-app", "main")] } };
    });
    const apps = await client(http).listResources("fal-app", ACCOUNT);
    expect(apps.map((a) => a.externalId)).toEqual(["me/my-app"]);
  });

  it.each([429, 500])("fails the type when an environment answers %d", async (status) => {
    const { http } = host((url) => {
      if (url.includes("/serverless/usage")) return { body: usage({ environment: "staging" }) };
      if (environmentOf(url)) return { status };
      return { body: { apps: [app("my-app", "main")] } };
    });
    await expect(client(http).listResources("fal-app", ACCOUNT)).rejects.toMatchObject({ status });
  });

  it.each([429, 500, 401])("fails the type when usage answers %d", async (status) => {
    const { http } = host((url) =>
      url.includes("/serverless/usage") ? { status } : { body: { apps: [app("my-app", "main")] } },
    );
    await expect(client(http).listResources("fal-app", ACCOUNT)).rejects.toMatchObject({ status });
  });

  it("throws when the usage it discovers environments from never ends", async () => {
    const { http, calls } = host((url) =>
      url.includes("/serverless/usage")
        ? { body: { time_series: [], next_cursor: "more" } }
        : { body: { apps: [app("my-app", "main")] } },
    );
    await expect(client(http).listResources("fal-app", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls.filter((c) => c.url.includes("/serverless/usage"))).toHaveLength(50);
  });

  describe("when the environments cannot be read", () => {
    const HOOK = Symbol.for("infrawrench.unreadListPart");
    afterEach(() => {
      Reflect.deleteProperty(globalThis, HOOK);
    });

    it.each([400, 403, 404, 422])(
      "lists main and keeps the stored rows when usage answers %d",
      async (status) => {
        const note = vi.fn();
        Reflect.set(globalThis, HOOK, note);
        const { http } = host((url) =>
          url.includes("/serverless/usage")
            ? { status }
            : { body: { apps: [app("my-app", "main")] } },
        );
        const apps = await client(http).listResources("fal-app", ACCOUNT);
        expect(apps.map((a) => a.externalId)).toEqual(["me/my-app"]);
        // Every environment's rows, and not main's, which were read.
        expect(note).toHaveBeenCalledWith({ idPrefixes: [`${ACCOUNT}:fal-app:@`] });
      },
    );

    it("keeps the stored rows when one environment refuses the key", async () => {
      const note = vi.fn();
      Reflect.set(globalThis, HOOK, note);
      const { http } = host((url) => {
        if (url.includes("/serverless/usage")) return { body: usage({ environment: "staging" }) };
        if (environmentOf(url)) return { status: 403 };
        return { body: { apps: [app("my-app", "main")] } };
      });
      const apps = await client(http).listResources("fal-app", ACCOUNT);
      expect(apps.map((a) => a.externalId)).toEqual(["me/my-app"]);
      expect(note).toHaveBeenCalledWith({ idPrefixes: [`${ACCOUNT}:fal-app:@`] });
    });

    it("shows the refusal where the host keeps no track", async () => {
      const usageRefused = host((url) =>
        url.includes("/serverless/usage")
          ? { status: 403 }
          : { body: { apps: [app("my-app", "main")] } },
      );
      await expect(
        client(usageRefused.http).listResources("fal-app", ACCOUNT),
      ).rejects.toMatchObject({ status: 403 });
      const environmentRefused = host((url) => {
        if (url.includes("/serverless/usage")) return { body: usage({ environment: "staging" }) };
        if (environmentOf(url)) return { status: 403 };
        return { body: { apps: [app("my-app", "main")] } };
      });
      await expect(
        client(environmentRefused.http).listResources("fal-app", ACCOUNT),
      ).rejects.toMatchObject({ status: 403 });
    });

    it("keeps the stored rows when main's apps are refused, rather than read them as none", async () => {
      const note = vi.fn();
      Reflect.set(globalThis, HOOK, note);
      const { http } = host((url) =>
        url.includes("/serverless/usage")
          ? { body: usage({ environment: "main" }) }
          : { status: 403 },
      );
      expect(await client(http).listResources("fal-app", ACCOUNT)).toEqual([]);
      expect(note).toHaveBeenCalledWith({ idPrefixes: [""] });
      Reflect.deleteProperty(globalThis, HOOK);
      await expect(client(http).listResources("fal-app", ACCOUNT)).rejects.toMatchObject({
        status: 403,
      });
    });

    /** The stored ids a sync keeps after this list, as the host matches them. */
    function keptOf(note: Mock<(part: UnreadListPart) => void>, stored: string[]): string[] {
      const prefixes = note.mock.calls.flatMap(([part]) => part.idPrefixes ?? []);
      return stored.filter((id) => prefixes.some((prefix) => id.startsWith(prefix)));
    }

    it("keeps an idle environment's rows, and prunes what it read", async () => {
      const note = vi.fn<(part: UnreadListPart) => void>();
      Reflect.set(globalThis, HOOK, note);
      const { http } = account(usage({ environment: "staging" }), {
        staging: [app("my-app", "staging")],
      });
      const apps = await client(http).listResources("fal-app", ACCOUNT);
      const id = (externalId: string) => `${ACCOUNT}:fal-app:${externalId}`;
      const idle = [
        id("@dev/me/my-app--dev"),
        id("@stag/me/my-app--stag"),
        id("@staging2/me/my-app--staging2"),
        id("@stagingx/me/my-app--stagingx"),
        id("@qa%20team/me/my-app--qa team"),
        id("@s/me/my-app--s"),
      ];
      const read = [
        ...apps.map((a) => a.id),
        id("@staging/me/deleted--staging"),
        id("me/deleted"),
        `${ACCOUNT}:fal-model:@dev/x`,
      ];
      expect(keptOf(note, [...idle, ...read])).toEqual(idle);
    });

    it("lists what it read where the host keeps no track", async () => {
      const { http } = account(usage({ environment: "staging" }), {
        staging: [app("my-app", "staging")],
      });
      const apps = await client(http).listResources("fal-app", ACCOUNT);
      expect(apps.map((a) => a.externalId)).toEqual(["me/my-app", "@staging/me/my-app--staging"]);
    });

    it("keeps an environment's rows when the key is refused only that one", async () => {
      const note = vi.fn<(part: UnreadListPart) => void>();
      Reflect.set(globalThis, HOOK, note);
      const { http } = host((url) => {
        if (url.includes("/serverless/usage")) {
          return { body: usage({ environment: "staging" }, { environment: "dev" }) };
        }
        if (environmentOf(url) === "staging") return { status: 403 };
        if (environmentOf(url) === "dev") return { body: { apps: [] } };
        return { body: { apps: [app("my-app", "main")] } };
      });
      await client(http).listResources("fal-app", ACCOUNT);
      const id = (externalId: string) => `${ACCOUNT}:fal-app:${externalId}`;
      expect(
        keptOf(note, [id("@staging/me/a--staging"), id("@dev/me/a--dev"), id("me/a")]),
      ).toEqual([id("@staging/me/a--staging")]);
    });
  });

  it("attaches a cost line to the app in the line's environment", async () => {
    const { http } = account(
      usage({ environment: "staging" }, { environment: "main" }, { environment: null }),
      { staging: [app("my-app", "staging")] },
    );
    const rows = await client(http).fetchCostData(ACCOUNT, {
      fromDate: "2026-10-01",
      toDate: "2026-10-31",
    });
    expect(rows.map((r) => [r.resourceId, r.tags?.["environment"]])).toEqual([
      ["@staging/me/my-app--staging", "staging"],
      ["me/my-app", "main"],
      ["me/my-app", undefined],
    ]);
    const listed = await client(http).listResources("fal-app", ACCOUNT);
    expect(listed.map((a) => a.externalId)).toContain(rows[0]?.resourceId);
  });

  it("keeps a line's environment tag on the main app when that environment has no apps", async () => {
    const { http } = account(usage({ environment: "production" }));
    const [row] = await client(http).fetchCostData(ACCOUNT, {
      fromDate: "2026-10-01",
      toDate: "2026-10-31",
    });
    expect([row?.resourceId, row?.tags?.["environment"]]).toEqual(["me/my-app", "production"]);
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
    const series = analyticsSeries(
      [
        {
          time_series: [
            {
              bucket: "2026-10-01T00:00:00Z",
              results: [{ endpoint_id: "a", request_count: 3, p50_duration: 1.5 }],
            },
          ],
        },
      ],
      "a",
    );
    expect(series.map((x) => [x.label, x.unit])).toEqual([
      ["Request", "requests"],
      ["Execution time p50", "s"],
    ]);
  });

  it("gives each route of a multi-route app its own series, not two points on one time", () => {
    const series = analyticsSeries(
      [
        {
          time_series: [
            {
              bucket: "2026-10-01T00:00:00Z",
              results: [
                { endpoint_id: "me/app/turbo", request_count: 3, p50_duration: 1.5 },
                { endpoint_id: "me/app", request_count: 7, p50_duration: 9 },
              ],
            },
            {
              bucket: "2026-10-01T01:00:00Z",
              results: [{ endpoint_id: "me/app/turbo", request_count: 4 }],
            },
          ],
        },
      ],
      "me/app",
    );
    expect(series.map((x) => [x.label, x.points.map((p) => p.value)])).toEqual([
      ["Request", [7]],
      ["Request · turbo", [3, 4]],
      ["Execution time p50", [9]],
      ["Execution time p50 · turbo", [1.5]],
    ]);
  });

  it("names the route in full when it is not under the id that was asked for", () => {
    const series = analyticsSeries(
      [
        {
          time_series: [
            {
              bucket: "2026-10-01T00:00:00Z",
              results: [{ endpoint_id: "other/app/turbo", request_count: 1 }],
            },
          ],
        },
      ],
      "me/app",
    );
    expect(series.map((x) => x.label)).toEqual(["Request · other/app/turbo"]);
  });

  it("asks for a multi-route app by its bare id, which fal widens to its routes", async () => {
    const { http, calls } = host(() => ({
      body: {
        time_series: [
          {
            bucket: "2026-10-01T00:00:00Z",
            results: [
              { endpoint_id: "me/app/turbo", request_count: 3 },
              { endpoint_id: "me/app/slow", request_count: 1 },
            ],
          },
        ],
        next_cursor: null,
      },
    }));
    const series = await hostClient(new FalClient({ apiKey: "k" }, { http })).fetchMetricSeries(
      "fal-app",
      `${ACCOUNT}:fal-app:me/app`,
      ACCOUNT,
    );
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]?.url ?? "").searchParams.getAll("endpoint_id")).toEqual(["me/app"]);
    expect(series.map((x) => x.label)).toEqual(["Request · slow", "Request · turbo"]);
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
