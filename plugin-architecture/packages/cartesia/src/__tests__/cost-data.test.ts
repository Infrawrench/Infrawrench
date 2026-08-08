import { describe, expect, it } from "vitest";
import { CostSetupError } from "@infrawrench/plugin-base";
import type { HttpHostServices } from "@infrawrench/plugin-base";
import { USD_PER_CREDIT, chunkRange, fetchCartesiaCostData } from "../cost-data.js";

interface Request {
  url: string;
  headers: Record<string, string>;
  caCert?: string;
}

/**
 * Stand-in for the host's HTTP service. Recording requests through it (rather
 * than the global fetch) also proves cost collection goes through the path
 * that carries bastion routing and a custom CA.
 */
function stubHttp(bodies: unknown[]): { http: HttpHostServices; requests: Request[] } {
  const requests: Request[] = [];
  let call = 0;
  const http: HttpHostServices = {
    request: (req) => {
      requests.push({
        url: req.url,
        headers: req.headers,
        ...(req.caCert !== undefined && { caCert: req.caCert }),
      });
      const body = bodies[Math.min(call, bodies.length - 1)];
      call += 1;
      return Promise.resolve({ status: 200, headers: {}, body: JSON.stringify(body) });
    },
  };
  return { http, requests };
}

function ctx(http: HttpHostServices, extra: Record<string, string> = {}) {
  return {
    adminApiKey: "sk_car_admin_test",
    apiVersion: "2026-03-01",
    baseUrl: "https://api.cartesia.ai",
    http,
    ...extra,
  };
}

/** A grouped `interval=day` response, as documented for group_by=capability. */
const GROUPED = {
  group_by: "capability",
  data: [
    {
      id: "tts",
      label: "Text to Speech",
      buckets: [
        { start_ts: "2026-07-01T00:00:00.000Z", end_ts: "2026-07-02T00:00:00.000Z", credits: 1200 },
        { start_ts: "2026-07-02T00:00:00.000Z", end_ts: "2026-07-03T00:00:00.000Z", credits: 800 },
      ],
    },
    {
      id: "stt",
      label: "Speech to Text",
      buckets: [
        { start_ts: "2026-07-01T00:00:00.000Z", end_ts: "2026-07-02T00:00:00.000Z", credits: 400 },
        { start_ts: "2026-07-02T00:00:00.000Z", end_ts: "2026-07-03T00:00:00.000Z", credits: 0 },
      ],
    },
  ],
};

describe("fetchCartesiaCostData", () => {
  it("turns daily credit buckets into one row per day and capability", async () => {
    const { http, requests } = stubHttp([GROUPED]);
    const rows = await fetchCartesiaCostData(ctx(http), {
      fromDate: "2026-07-01",
      toDate: "2026-07-02",
    });

    expect(requests).toHaveLength(1);
    expect(rows).toHaveLength(3); // the zero-credit bucket is dropped
    expect(rows.map((r) => [r.date, r.service])).toEqual([
      ["2026-07-01", "Text to Speech"],
      ["2026-07-02", "Text to Speech"],
      ["2026-07-01", "Speech to Text"],
    ]);
    for (const row of rows) expect(row.currency).toBe("USD");
  });

  it("keeps the credit count as the usage quantity behind the money", async () => {
    const { http } = stubHttp([GROUPED]);
    const rows = await fetchCartesiaCostData(ctx(http), {
      fromDate: "2026-07-01",
      toDate: "2026-07-02",
    });

    const tts = rows.find((r) => r.date === "2026-07-01" && r.service === "Text to Speech");
    expect(tts?.usageAmount).toBe(1200);
    expect(tts?.usageUnit).toBe("Credits");
  });

  it("converts credits at the published Scale-plan rate of $299 per 8M credits", async () => {
    const { http } = stubHttp([GROUPED]);
    const rows = await fetchCartesiaCostData(ctx(http), {
      fromDate: "2026-07-01",
      toDate: "2026-07-02",
    });

    expect(USD_PER_CREDIT).toBeCloseTo(0.000037375, 12);
    const tts = rows.find((r) => r.date === "2026-07-01" && r.service === "Text to Speech");
    expect(tts?.amount).toBeCloseTo((1200 * 299) / 8_000_000, 12);
    expect(tts?.amount).toBeCloseTo(0.04485, 10);

    const stt = rows.find((r) => r.date === "2026-07-01" && r.service === "Speech to Text");
    expect(stt?.amount).toBeCloseTo(0.01495, 10);
  });

  it("asks for daily buckets grouped by capability, with the mandatory version header", async () => {
    const { http, requests } = stubHttp([GROUPED]);
    await fetchCartesiaCostData(ctx(http, { caCert: "-----BEGIN CERTIFICATE-----" }), {
      fromDate: "2026-07-01",
      toDate: "2026-07-02",
    });

    const url = new URL(requests[0]!.url);
    expect(url.origin + url.pathname).toBe("https://api.cartesia.ai/usage/credits");
    expect(url.searchParams.get("interval")).toBe("day");
    expect(url.searchParams.get("group_by")).toBe("capability");
    expect(url.searchParams.get("start_ts")).toBe("2026-07-01T00:00:00Z");
    // end_ts rounds up to the next UTC day, so this covers 07-02 inclusive.
    expect(url.searchParams.get("end_ts")).toBe("2026-07-02T23:59:59Z");
    expect(requests[0]!.headers["Cartesia-Version"]).toBe("2026-03-01");
    expect(requests[0]!.headers["Authorization"]).toBe("Bearer sk_car_admin_test");
    expect(requests[0]!.caCert).toBe("-----BEGIN CERTIFICATE-----");
  });

  it("sums repeated buckets for the same day and capability into one row", async () => {
    const { http } = stubHttp([
      {
        group_by: "capability",
        data: [
          {
            id: "tts",
            label: "Text to Speech",
            buckets: [
              { start_ts: "2026-07-01T00:00:00.000Z", credits: 100 },
              { start_ts: "2026-07-01T00:00:00.000Z", credits: 50 },
            ],
          },
        ],
      },
    ]);

    const rows = await fetchCartesiaCostData(ctx(http), {
      fromDate: "2026-07-01",
      toDate: "2026-07-01",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.usageAmount).toBe(150);
  });

  it("drops buckets outside the requested range", async () => {
    const { http } = stubHttp([GROUPED]);
    const rows = await fetchCartesiaCostData(ctx(http), {
      fromDate: "2026-07-02",
      toDate: "2026-07-02",
    });
    expect(rows.map((r) => r.date)).toEqual(["2026-07-02"]);
  });

  it("falls back to the capability id when the response carries no label", async () => {
    const { http } = stubHttp([
      {
        group_by: "capability",
        data: [
          { id: "voice_changer", buckets: [{ start_ts: "2026-07-01T00:00:00Z", credits: 90 }] },
        ],
      },
    ]);
    const rows = await fetchCartesiaCostData(ctx(http), {
      fromDate: "2026-07-01",
      toDate: "2026-07-01",
    });
    expect(rows[0]!.service).toBe("voice_changer");
  });

  it("still reads an ungrouped response, where buckets sit at the top level", async () => {
    const { http } = stubHttp([
      {
        data: [{ start_ts: "2026-07-01T00:00:00Z", end_ts: "2026-07-02T00:00:00Z", credits: 500 }],
      },
    ]);
    const rows = await fetchCartesiaCostData(ctx(http), {
      fromDate: "2026-07-01",
      toDate: "2026-07-01",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.service).toBe("Usage");
    expect(rows[0]!.usageAmount).toBe(500);
  });
});

describe("chunking a range longer than a year", () => {
  it("splits into 365-day windows the endpoint will accept", () => {
    const chunks = chunkRange({ fromDate: "2025-01-01", toDate: "2026-08-08" });
    expect(chunks).toEqual([
      { fromDate: "2025-01-01", toDate: "2025-12-31" },
      { fromDate: "2026-01-01", toDate: "2026-08-08" },
    ]);
  });

  it("leaves a range of exactly a year in one call", () => {
    expect(chunkRange({ fromDate: "2025-01-01", toDate: "2025-12-31" })).toEqual([
      { fromDate: "2025-01-01", toDate: "2025-12-31" },
    ]);
  });

  it("covers every day exactly once, with no gap at the seam", () => {
    const chunks = chunkRange({ fromDate: "2024-01-01", toDate: "2026-06-30" });
    expect(chunks[0]!.fromDate).toBe("2024-01-01");
    expect(chunks.at(-1)!.toDate).toBe("2026-06-30");
    for (let i = 1; i < chunks.length; i++) {
      const previousEnd = new Date(`${chunks[i - 1]!.toDate}T00:00:00Z`).valueOf();
      const nextStart = new Date(`${chunks[i]!.fromDate}T00:00:00Z`).valueOf();
      expect(nextStart - previousEnd).toBe(86_400_000);
    }
  });

  it("issues one request per chunk and merges the results", async () => {
    const { http, requests } = stubHttp([
      {
        group_by: "capability",
        data: [
          { id: "tts", label: "TTS", buckets: [{ start_ts: "2025-06-01T00:00:00Z", credits: 10 }] },
        ],
      },
      {
        group_by: "capability",
        data: [
          { id: "tts", label: "TTS", buckets: [{ start_ts: "2026-06-01T00:00:00Z", credits: 20 }] },
        ],
      },
    ]);

    const rows = await fetchCartesiaCostData(ctx(http), {
      fromDate: "2025-01-01",
      toDate: "2026-08-08",
    });

    expect(requests).toHaveLength(2);
    expect(new URL(requests[0]!.url).searchParams.get("start_ts")).toBe("2025-01-01T00:00:00Z");
    expect(new URL(requests[0]!.url).searchParams.get("end_ts")).toBe("2025-12-31T23:59:59Z");
    expect(new URL(requests[1]!.url).searchParams.get("start_ts")).toBe("2026-01-01T00:00:00Z");
    expect(rows.map((r) => r.date)).toEqual(["2025-06-01", "2026-06-01"]);
  });
});

describe("missing admin key", () => {
  const range = { fromDate: "2026-07-01", toDate: "2026-07-02" };

  function blankKeyCtx() {
    const { http } = stubHttp([GROUPED]);
    return { adminApiKey: "", apiVersion: "2026-03-01", baseUrl: "https://api.cartesia.ai", http };
  }

  it("throws a CostSetupError rather than silently reporting no spend", async () => {
    const err = await fetchCartesiaCostData(blankKeyCtx(), range).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CostSetupError);
    expect((err as CostSetupError).name).toBe("CostSetupError");
    expect((err as CostSetupError).message).toMatch(/admin API key/);
  });

  it("deep-links to the console page that creates an admin key, over https", async () => {
    const err = await fetchCartesiaCostData(blankKeyCtx(), range).catch((e: unknown) => e);
    const setup = err as CostSetupError;
    expect(setup.helpLink?.url).toBe("https://play.cartesia.ai/keys/admin");
    expect(setup.helpLink?.label).toBe("Create an admin key");
    expect(setup.helpLink?.url.startsWith("https:")).toBe(true);
  });

  it("never touches the API when the key is blank", async () => {
    const { http, requests } = stubHttp([GROUPED]);
    await fetchCartesiaCostData(
      { adminApiKey: "", apiVersion: "2026-03-01", baseUrl: "https://api.cartesia.ai", http },
      range,
    ).catch(() => undefined);
    expect(requests).toHaveLength(0);
  });
});
