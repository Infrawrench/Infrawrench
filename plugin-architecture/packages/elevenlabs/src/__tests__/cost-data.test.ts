import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CostSetupError } from "@infrawrench/plugin-base";
import type { HttpHostServices } from "@infrawrench/plugin-base";
import { fetchElevenLabsCostData } from "../cost-data.js";
import type { ElevenLabsCostContext } from "../cost-data.js";

const ANALYTICS = "/v1/workspace/analytics/query/usage-by-product-over-time";
const CHARACTER_STATS = "/v1/usage/character-stats";
const SUBSCRIPTION = "/v1/user/subscription";

const range = { fromDate: "2026-08-01", toDate: "2026-08-03" };

interface Call {
  url: string;
  method: string;
  body: string | undefined;
}

let calls: Call[] = [];

/** Status + body keyed by the path prefix the request starts with. */
type Route = { status?: number; body: unknown };
type Routes = Record<string, Route | Route[]>;

function routeFor(routes: Routes, url: string): Route {
  const path = url.replace("https://api.elevenlabs.io", "");
  for (const [prefix, route] of Object.entries(routes)) {
    if (!path.startsWith(prefix)) continue;
    if (Array.isArray(route)) {
      // Successive calls to the same path walk the list, repeating the last.
      const seen = calls.filter((c) =>
        c.url.replace("https://api.elevenlabs.io", "").startsWith(prefix),
      ).length;
      return route[Math.min(seen - 1, route.length - 1)] ?? { status: 500, body: {} };
    }
    return route;
  }
  return { status: 404, body: { detail: "not found" } };
}

function installFetch(routes: Routes) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((async (
    url: string,
    init?: RequestInit,
  ) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const route = routeFor(routes, String(url));
    const status = route.status ?? 200;
    const text = typeof route.body === "string" ? route.body : JSON.stringify(route.body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      json: async () => JSON.parse(text) as unknown,
    } as unknown as Response;
  }) as unknown as typeof fetch);
}

function ctx(over: Partial<ElevenLabsCostContext> = {}): ElevenLabsCostContext {
  return { apiKey: "sk_test_key", caCert: "", http: undefined, ...over };
}

/** A well-formed successor response with the columns we expect to see. */
function analyticsBody(rows: Array<Array<string | number | null>>, over: object = {}) {
  return {
    columns: ["time", "product_type", "region", "fiat_currency", "fiat_units_spent", "credits"],
    column_types: ["DateTime", "String", "String", "String", "Float", "Float"],
    column_units: [null, null, null, null, "usd", "credits"],
    rows,
    ...over,
  };
}

function pathsHit(): string[] {
  return calls.map((c) => c.url.replace("https://api.elevenlabs.io", "").split("?")[0] ?? "");
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchElevenLabsCostData — successor endpoint", () => {
  it("maps tabular rows to daily cost rows keyed on the full dimension tuple", async () => {
    installFetch({
      [ANALYTICS]: {
        body: analyticsBody([
          ["2026-08-01 00:00:00", "text_to_speech", "us-east", "usd", 1.25, 5000],
          ["2026-08-01 00:00:00", "speech_to_text", "us-east", "usd", 0.5, 200],
          ["2026-08-02 00:00:00", "text_to_speech", "eu-west", "usd", 2, 8000],
        ]),
      },
    });

    const rows = await fetchElevenLabsCostData(ctx(), range);

    expect(rows).toEqual([
      {
        date: "2026-08-01",
        service: "speech_to_text",
        region: "us-east",
        currency: "USD",
        amount: 0.5,
        usageAmount: 200,
        usageUnit: "credits",
      },
      {
        date: "2026-08-01",
        service: "text_to_speech",
        region: "us-east",
        currency: "USD",
        amount: 1.25,
        usageAmount: 5000,
        usageUnit: "credits",
      },
      {
        date: "2026-08-02",
        service: "text_to_speech",
        region: "eu-west",
        currency: "USD",
        amount: 2,
        usageAmount: 8000,
        usageUnit: "credits",
      },
    ]);
  });

  it("POSTs the documented body: ms timestamps, daily interval_seconds, multi-valued group_by", async () => {
    installFetch({ [ANALYTICS]: { body: analyticsBody([]) } });

    await fetchElevenLabsCostData(ctx(), range);

    expect(calls[0]?.method).toBe("POST");
    const payload = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(payload).toEqual({
      start_time: Date.parse("2026-08-01T00:00:00.000Z"),
      end_time: Date.parse("2026-08-03T00:00:00.000Z") + 86_400_000 - 1,
      interval_seconds: 86_400,
      group_by: ["product_type", "region", "fiat_currency"],
      time_zone: "UTC",
    });
  });

  it("sums repeated dimension tuples into one row so a re-fetch reproduces identical keys", async () => {
    installFetch({
      [ANALYTICS]: {
        body: analyticsBody([
          ["2026-08-01 00:00:00", "text_to_speech", "us-east", "usd", 1, 10],
          ["2026-08-01 00:00:00", "text_to_speech", "us-east", "usd", 2.5, 25],
        ]),
      },
    });

    const rows = await fetchElevenLabsCostData(ctx(), range);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: 3.5, usageAmount: 35 });
  });

  it("drops buckets outside the requested window and zero-spend buckets", async () => {
    installFetch({
      [ANALYTICS]: {
        body: analyticsBody([
          ["2026-07-31 00:00:00", "text_to_speech", "us-east", "usd", 9, 1],
          ["2026-08-04 00:00:00", "text_to_speech", "us-east", "usd", 9, 1],
          ["2026-08-02 00:00:00", "text_to_speech", "us-east", "usd", 0, 0],
          ["2026-08-02 00:00:00", "speech_to_text", "us-east", "usd", 4, 0],
        ]),
      },
    });

    const rows = await fetchElevenLabsCostData(ctx(), range);
    expect(rows).toEqual([
      {
        date: "2026-08-02",
        service: "speech_to_text",
        region: "us-east",
        currency: "USD",
        amount: 4,
      },
    ]);
  });

  it("accepts ISO and epoch time columns", async () => {
    installFetch({
      [ANALYTICS]: {
        body: analyticsBody(
          [
            [Date.parse("2026-08-01T00:00:00.000Z"), "tts", "", "usd", 1, 0],
            [Math.floor(Date.parse("2026-08-02T00:00:00.000Z") / 1000), "tts", "", "usd", 2, 0],
            ["2026-08-03T00:00:00Z", "tts", "", "usd", 3, 0],
          ],
          { column_types: ["Int", "String", "String", "String", "Float", "Float"] },
        ),
      },
    });

    const rows = await fetchElevenLabsCostData(ctx(), range);
    expect(rows.map((r) => r.date)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
  });

  it("returns nothing for an empty window without falling back", async () => {
    installFetch({ [ANALYTICS]: { body: analyticsBody([]) } });

    expect(await fetchElevenLabsCostData(ctx(), range)).toEqual([]);
    expect(pathsHit()).toEqual([ANALYTICS]);
  });

  it("routes through the host HTTP service and threads the caCert", async () => {
    type HostRequest = Parameters<HttpHostServices["request"]>[0];
    const seen: HostRequest[] = [];
    const request = vi.fn(async (req: HostRequest) => {
      seen.push(req);
      return { status: 200, headers: {}, body: JSON.stringify(analyticsBody([])) };
    });
    const fetchSpy = installFetch({});

    await fetchElevenLabsCostData(
      ctx({ caCert: "-----BEGIN CERTIFICATE-----", http: { request } }),
      range,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      url: `https://api.elevenlabs.io${ANALYTICS}`,
      method: "POST",
      caCert: "-----BEGIN CERTIFICATE-----",
      headers: expect.objectContaining({ "xi-api-key": "sk_test_key" }),
    });
  });

  it("propagates a server error rather than masking it with the deprecated endpoint", async () => {
    installFetch({ [ANALYTICS]: { status: 500, body: { detail: "boom" } } });

    await expect(fetchElevenLabsCostData(ctx(), range)).rejects.toThrow(/error 500/);
    expect(pathsHit()).toEqual([ANALYTICS]);
  });
});

describe("fetchElevenLabsCostData — currency", () => {
  it("prefers the per-row fiat_currency column over the column unit", async () => {
    installFetch({
      [ANALYTICS]: {
        body: analyticsBody([
          ["2026-08-01 00:00:00", "tts", "", "eur", 1, 0],
          ["2026-08-01 00:00:00", "stt", "", "pln", 2, 0],
        ]),
      },
    });

    const rows = await fetchElevenLabsCostData(ctx(), range);
    expect(rows.map((r) => r.currency).sort()).toEqual(["EUR", "PLN"]);
  });

  it("falls back to the money column's unit when no fiat_currency column is grouped", async () => {
    installFetch({
      [ANALYTICS]: {
        body: {
          columns: ["time", "product_type", "fiat_units_spent"],
          column_types: ["DateTime", "String", "Float"],
          column_units: [null, null, "inr"],
          rows: [["2026-08-01 00:00:00", "tts", 42]],
        },
      },
    });

    const rows = await fetchElevenLabsCostData(ctx(), range);
    expect(rows[0]?.currency).toBe("INR");
    // The unit settled it, so no subscription lookup was needed.
    expect(pathsHit()).toEqual([ANALYTICS]);
  });

  it("reads the subscription currency when neither the row nor the unit states one", async () => {
    installFetch({
      [ANALYTICS]: {
        body: {
          columns: ["time", "product_type", "cost"],
          column_types: ["DateTime", "String", "Float"],
          column_units: [null, null, null],
          rows: [["2026-08-01 00:00:00", "tts", 7]],
        },
      },
      [SUBSCRIPTION]: { body: { currency: "eur" } },
    });

    const rows = await fetchElevenLabsCostData(ctx(), range);
    expect(rows[0]?.currency).toBe("EUR");
    expect(pathsHit()).toEqual([ANALYTICS, SUBSCRIPTION]);
  });

  it("assumes USD only when every other source is unavailable", async () => {
    installFetch({
      [ANALYTICS]: {
        body: {
          columns: ["time", "product_type", "cost"],
          column_types: ["DateTime", "String", "Float"],
          column_units: [null, null, null],
          rows: [["2026-08-01 00:00:00", "tts", 7]],
        },
      },
      [SUBSCRIPTION]: { status: 403, body: { detail: "missing scope" } },
    });

    const rows = await fetchElevenLabsCostData(ctx(), range);
    expect(rows[0]?.currency).toBe("USD");
  });

  it("treats fiat_units_spent as major units, not minor ones", async () => {
    installFetch({
      [ANALYTICS]: {
        body: analyticsBody([["2026-08-01 00:00:00", "tts", "", "usd", 1.25, 0]]),
      },
    });

    const rows = await fetchElevenLabsCostData(ctx(), range);
    // 1.25 is $1.25, not 1.25 cents — the amount passes through unscaled.
    expect(rows[0]?.amount).toBe(1.25);
  });
});

describe("fetchElevenLabsCostData — fallback to the deprecated endpoint", () => {
  const statsBody = {
    time: [
      Date.parse("2026-08-01T00:00:00.000Z"),
      Date.parse("2026-08-02T00:00:00.000Z"),
      Date.parse("2026-08-03T00:00:00.000Z"),
    ],
    usage: {
      text_to_speech: [1.5, 0, 2],
      speech_to_text: [0.25, 0.75, 0],
    },
  };

  it("uses character-stats when the successor 404s", async () => {
    installFetch({
      [ANALYTICS]: { status: 404, body: { detail: "Not Found" } },
      [CHARACTER_STATS]: { body: statsBody },
      [SUBSCRIPTION]: { body: { currency: "usd" } },
    });

    const rows = await fetchElevenLabsCostData(ctx(), range);

    expect(pathsHit()).toEqual([ANALYTICS, CHARACTER_STATS, SUBSCRIPTION]);
    expect(rows).toEqual([
      { date: "2026-08-01", service: "speech_to_text", currency: "USD", amount: 0.25 },
      { date: "2026-08-01", service: "text_to_speech", currency: "USD", amount: 1.5 },
      { date: "2026-08-02", service: "speech_to_text", currency: "USD", amount: 0.75 },
      { date: "2026-08-03", service: "text_to_speech", currency: "USD", amount: 2 },
    ]);
  });

  it("asks for fiat_units_spent in daily buckets with a single-valued product_type breakdown", async () => {
    installFetch({
      [ANALYTICS]: { status: 404, body: {} },
      [CHARACTER_STATS]: { body: statsBody },
      [SUBSCRIPTION]: { body: { currency: "usd" } },
    });

    await fetchElevenLabsCostData(ctx(), range);

    const url = new URL(calls[1]?.url ?? "");
    expect(calls[1]?.method).toBe("GET");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      start_unix: String(Date.parse("2026-08-01T00:00:00.000Z")),
      end_unix: String(Date.parse("2026-08-03T00:00:00.000Z") + 86_400_000 - 1),
      aggregation_interval: "day",
      metric: "fiat_units_spent",
      breakdown_type: "product_type",
      include_workspace_metrics: "true",
    });
  });

  it("never emits a region on the fallback path — the breakdown cannot produce a tuple", async () => {
    installFetch({
      [ANALYTICS]: { status: 404, body: {} },
      [CHARACTER_STATS]: { body: statsBody },
      [SUBSCRIPTION]: { body: { currency: "usd" } },
    });

    const rows = await fetchElevenLabsCostData(ctx(), range);
    expect(rows.every((row) => row.region === undefined)).toBe(true);
  });

  it("falls back when the successor refuses this key", async () => {
    installFetch({
      [ANALYTICS]: { status: 403, body: { detail: "workspace analytics not permitted" } },
      [CHARACTER_STATS]: { body: statsBody },
      [SUBSCRIPTION]: { body: { currency: "usd" } },
    });

    const rows = await fetchElevenLabsCostData(ctx(), range);
    expect(pathsHit()[0]).toBe(ANALYTICS);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("falls back when the successor answers with an unreadable shape", async () => {
    installFetch({
      // 200, but no money column and no recognizable time column.
      [ANALYTICS]: {
        body: { columns: ["widgets"], column_types: ["Int"], column_units: [null], rows: [[1]] },
      },
      [CHARACTER_STATS]: { body: statsBody },
      [SUBSCRIPTION]: { body: { currency: "usd" } },
    });

    const rows = await fetchElevenLabsCostData(ctx(), range);
    expect(pathsHit()).toEqual([ANALYTICS, CHARACTER_STATS, SUBSCRIPTION]);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("retries without include_workspace_metrics when the key is refused workspace-wide totals", async () => {
    installFetch({
      [ANALYTICS]: { status: 404, body: {} },
      [CHARACTER_STATS]: [
        { status: 403, body: { detail: "admin key required" } },
        { body: statsBody },
      ],
      [SUBSCRIPTION]: { body: { currency: "usd" } },
    });

    const rows = await fetchElevenLabsCostData(ctx(), range);

    const first = new URL(calls[1]?.url ?? "");
    const second = new URL(calls[2]?.url ?? "");
    expect(first.searchParams.get("include_workspace_metrics")).toBe("true");
    expect(second.searchParams.has("include_workspace_metrics")).toBe(false);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("raises a CostSetupError when the key cannot read usage at all", async () => {
    installFetch({
      [ANALYTICS]: { status: 403, body: {} },
      [CHARACTER_STATS]: { status: 403, body: { detail: "missing scope" } },
    });

    await expect(fetchElevenLabsCostData(ctx(), range)).rejects.toBeInstanceOf(CostSetupError);
  });

  it("returns nothing for an empty window", async () => {
    installFetch({
      [ANALYTICS]: { status: 404, body: {} },
      [CHARACTER_STATS]: { body: { time: [], usage: {} } },
    });

    expect(await fetchElevenLabsCostData(ctx(), range)).toEqual([]);
  });
});
