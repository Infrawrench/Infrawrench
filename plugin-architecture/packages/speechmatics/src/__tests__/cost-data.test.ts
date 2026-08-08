import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CostSetupError } from "@infrawrench/plugin-base";
import { fetchSpeechmaticsCostData, type SpeechmaticsCostContext } from "../cost-data.js";

/** Fixed "now" — every test asserts against closed UTC days relative to this. */
const NOW = new Date("2026-07-10T09:30:00.000Z");

interface Call {
  url: string;
  headers: Record<string, string>;
}

let calls: Call[] = [];
let sleeps: number[] = [];

/** Minimal `Response` stand-in with iterable headers. */
function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      forEach(fn: (value: string, key: string) => void) {
        for (const [key, value] of Object.entries(headers)) fn(value, key);
      },
    },
    text: async () => text,
  } as unknown as Response;
}

function installFetch(handler: (url: string, attempt: number) => Response) {
  const perUrl = new Map<string, number>();
  return vi.spyOn(globalThis, "fetch").mockImplementation((async (
    url: string,
    init?: RequestInit,
  ) => {
    const key = String(url);
    const attempt = (perUrl.get(key) ?? 0) + 1;
    perUrl.set(key, attempt);
    calls.push({ url: key, headers: (init?.headers ?? {}) as Record<string, string> });
    return handler(key, attempt);
  }) as unknown as typeof fetch);
}

function ctx(overrides: Partial<SpeechmaticsCostContext> = {}): SpeechmaticsCostContext {
  return {
    region: "eu1",
    apiKey: "sm-key",
    now: () => NOW,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    ...overrides,
  };
}

/** A `details` entry as the usage endpoint returns it. */
function detail(mode: string, operatingPoint: string | undefined, hours: number, language = "en") {
  return {
    mode,
    type: "transcription",
    language,
    ...(operatingPoint !== undefined ? { operating_point: operatingPoint } : {}),
    count: 1,
    duration_hrs: hours,
  };
}

function usage(details: unknown[]) {
  return { since: "", until: "", summary: [], details };
}

/** `?since=…&until=…` of a request, for asserting the per-day fan-out. */
function dayOf(url: string): string {
  const params = new URL(url).searchParams;
  const since = params.get("since") ?? "";
  const until = params.get("until") ?? "";
  expect(since).toBe(until); // one request must cover exactly one day
  return since;
}

beforeEach(() => {
  calls = [];
  sleeps = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("per-day fan-out", () => {
  it("issues one request per day of the range, each a single-day window", async () => {
    installFetch(() => response(usage([])));

    await fetchSpeechmaticsCostData(ctx(), { fromDate: "2026-07-01", toDate: "2026-07-05" });

    expect(calls.map((c) => dayOf(c.url))).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
      "2026-07-04",
      "2026-07-05",
    ]);
    expect(calls[0]?.url).toBe(
      "https://eu1.asr.api.speechmatics.com/v2/usage?since=2026-07-01&until=2026-07-01",
    );
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer sm-key");
  });

  it("paces consecutive days, but does not sleep before the first", async () => {
    installFetch(() => response(usage([])));

    await fetchSpeechmaticsCostData(ctx(), { fromDate: "2026-07-01", toDate: "2026-07-03" });

    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([250, 250]);
  });

  it("uses the account's region for the endpoint host", async () => {
    installFetch(() => response(usage([])));

    await fetchSpeechmaticsCostData(ctx({ region: "au1" }), {
      fromDate: "2026-07-01",
      toDate: "2026-07-01",
    });

    expect(calls[0]?.url).toContain("https://au1.asr.api.speechmatics.com/v2/usage");
  });

  it("routes through the host HTTP service with the custom CA when there is one", async () => {
    const request = vi.fn(async (_req: { url: string; method: string; caCert?: string }) => ({
      status: 200,
      headers: {} as Record<string, string>,
      body: JSON.stringify(usage([])),
    }));
    const fetchSpy = installFetch(() => response(usage([])));

    await fetchSpeechmaticsCostData(ctx({ http: { request }, caCert: "-----BEGIN CERT-----" }), {
      fromDate: "2026-07-01",
      toDate: "2026-07-02",
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      method: "GET",
      caCert: "-----BEGIN CERT-----",
    });
  });
});

describe("pricing", () => {
  it("prices each operating point at its published per-hour rate", async () => {
    installFetch((url) => {
      const day = dayOf(url);
      if (day === "2026-07-01") return response(usage([detail("batch", "enhanced", 2)]));
      if (day === "2026-07-02") return response(usage([detail("batch", "standard", 4)]));
      if (day === "2026-07-03") return response(usage([detail("batch", "melia-1", 10)]));
      if (day === "2026-07-04") return response(usage([detail("real-time", "standard", 3)]));
      return response(usage([detail("real-time", "enhanced", 5)]));
    });

    const rows = await fetchSpeechmaticsCostData(ctx(), {
      fromDate: "2026-07-01",
      toDate: "2026-07-05",
    });

    expect(rows).toEqual([
      {
        date: "2026-07-01",
        service: "Batch Enhanced",
        currency: "USD",
        amount: 1.5, // 2 h × $0.75
        usageAmount: 2,
        usageUnit: "Hours",
      },
      {
        date: "2026-07-02",
        service: "Batch Standard",
        currency: "USD",
        amount: 1.8, // 4 h × $0.45
        usageAmount: 4,
        usageUnit: "Hours",
      },
      {
        date: "2026-07-03",
        service: "Batch Melia 1",
        currency: "USD",
        amount: 2.4, // 10 h × $0.24
        usageAmount: 10,
        usageUnit: "Hours",
      },
      {
        date: "2026-07-04",
        service: "Real-time Standard",
        currency: "USD",
        amount: 1.35, // 3 h × $0.45
        usageAmount: 3,
        usageUnit: "Hours",
      },
      {
        date: "2026-07-05",
        service: "Real-time Enhanced",
        currency: "USD",
        amount: 4, // 5 h × $0.80
        usageAmount: 5,
        usageUnit: "Hours",
      },
    ]);
  });

  it("collapses per-language entries for one model into a single day row", async () => {
    installFetch(() =>
      response(
        usage([
          detail("batch", "enhanced", 1, "en"),
          detail("batch", "enhanced", 3, "de"),
          detail("batch", "standard", 2, "en"),
        ]),
      ),
    );

    const rows = await fetchSpeechmaticsCostData(ctx(), {
      fromDate: "2026-07-01",
      toDate: "2026-07-01",
    });

    expect(rows).toEqual([
      {
        date: "2026-07-01",
        service: "Batch Enhanced",
        currency: "USD",
        amount: 3, // (1 + 3) h × $0.75
        usageAmount: 4,
        usageUnit: "Hours",
      },
      {
        date: "2026-07-01",
        service: "Batch Standard",
        currency: "USD",
        amount: 0.9,
        usageAmount: 2,
        usageUnit: "Hours",
      },
    ]);
  });

  it("reads the older `model` spelling and the `realtime`/`real_time` mode spellings", async () => {
    installFetch(() =>
      response(
        usage([
          { mode: "batch", type: "transcription", model: "enhanced", count: 1, duration_hrs: 2 },
          {
            mode: "real_time",
            type: "transcription",
            model: "enhanced",
            count: 1,
            duration_hrs: 1,
          },
          { mode: "realtime", type: "transcription", model: "standard", count: 1, duration_hrs: 1 },
        ]),
      ),
    );

    const rows = await fetchSpeechmaticsCostData(ctx(), {
      fromDate: "2026-07-01",
      toDate: "2026-07-01",
    });

    expect(rows.map((r) => [r.service, r.amount])).toEqual([
      ["Batch Enhanced", 1.5],
      ["Real-time Enhanced", 0.8],
      ["Real-time Standard", 0.45],
    ]);
  });

  it("omits consumption with no entry on the public rate card rather than guessing", async () => {
    installFetch(() =>
      response(
        usage([
          { mode: "batch", type: "alignment", language: "en", count: 1, duration_hrs: 4 },
          detail("batch", "some-future-model", 9),
          detail("batch", "enhanced", 1),
        ]),
      ),
    );

    const rows = await fetchSpeechmaticsCostData(ctx(), {
      fromDate: "2026-07-01",
      toDate: "2026-07-01",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ service: "Batch Enhanced", amount: 0.75 });
  });

  it("ignores `summary`, which has aggregated the operating point away", async () => {
    installFetch(() =>
      response({
        since: "",
        until: "",
        summary: [{ mode: "batch", type: "transcription", count: 9, duration_hrs: 40 }],
        details: [],
      }),
    );

    const rows = await fetchSpeechmaticsCostData(ctx(), {
      fromDate: "2026-07-01",
      toDate: "2026-07-01",
    });

    expect(rows).toEqual([]);
  });

  it("reproduces identical dimension keys when a day is re-fetched", async () => {
    const body = usage([
      detail("batch", "enhanced", 1, "en"),
      detail("batch", "enhanced", 2, "fr"),
    ]);
    installFetch(() => response(body));

    const range = { fromDate: "2026-07-01", toDate: "2026-07-02" };
    const first = await fetchSpeechmaticsCostData(ctx(), range);
    const second = await fetchSpeechmaticsCostData(ctx(), range);

    expect(second).toEqual(first);
    expect(first.map((r) => `${r.date}|${r.service}`)).toEqual([
      "2026-07-01|Batch Enhanced",
      "2026-07-02|Batch Enhanced",
    ]);
  });
});

describe("the current UTC day", () => {
  it("never requests today, because the endpoint excludes it", async () => {
    installFetch(() => response(usage([detail("batch", "enhanced", 1)])));

    const rows = await fetchSpeechmaticsCostData(ctx(), {
      fromDate: "2026-07-08",
      toDate: "2026-07-10", // NOW's UTC day
    });

    expect(calls.map((c) => dayOf(c.url))).toEqual(["2026-07-08", "2026-07-09"]);
    expect(rows.map((r) => r.date)).toEqual(["2026-07-08", "2026-07-09"]);
  });

  it("spends no requests at all on a window that is entirely today or later", async () => {
    installFetch(() => response(usage([detail("batch", "enhanced", 1)])));

    const rows = await fetchSpeechmaticsCostData(ctx(), {
      fromDate: "2026-07-10",
      toDate: "2026-07-12",
    });

    expect(calls).toHaveLength(0);
    expect(rows).toEqual([]);
  });
});

describe("empty windows", () => {
  it("returns no rows for days with no usage", async () => {
    installFetch(() => response(usage([])));

    const rows = await fetchSpeechmaticsCostData(ctx(), {
      fromDate: "2026-07-01",
      toDate: "2026-07-03",
    });

    expect(calls).toHaveLength(3);
    expect(rows).toEqual([]);
  });

  it("tolerates a response with neither summary nor details", async () => {
    installFetch(() => response({}));

    const rows = await fetchSpeechmaticsCostData(ctx(), {
      fromDate: "2026-07-01",
      toDate: "2026-07-01",
    });

    expect(rows).toEqual([]);
  });

  it("drops zero-hour entries instead of writing $0 rows", async () => {
    installFetch(() => response(usage([detail("batch", "enhanced", 0)])));

    const rows = await fetchSpeechmaticsCostData(ctx(), {
      fromDate: "2026-07-01",
      toDate: "2026-07-01",
    });

    expect(rows).toEqual([]);
  });
});

describe("403 — temporary key with a client_ref", () => {
  it("raises a setup error naming the credential to change", async () => {
    installFetch(() => response({ code: 403, error: "Forbidden" }, 403));

    const promise = fetchSpeechmaticsCostData(ctx(), {
      fromDate: "2026-07-01",
      toDate: "2026-07-03",
    });

    await expect(promise).rejects.toBeInstanceOf(CostSetupError);
    await expect(promise).rejects.toThrow(/client_ref/);
    await expect(promise).rejects.toThrow(/long-lived batch API key/);
  });

  it("carries a help link and does not retry or continue the fan-out", async () => {
    installFetch(() => response({ code: 403, error: "Forbidden" }, 403));

    let error: unknown;
    try {
      await fetchSpeechmaticsCostData(ctx(), { fromDate: "2026-07-01", toDate: "2026-07-05" });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(CostSetupError);
    expect((error as CostSetupError).helpLink?.url).toBe(
      "https://docs.speechmatics.com/introduction/authentication",
    );
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });
});

describe("rate limiting", () => {
  it("retries a 429 and honours Retry-After in seconds", async () => {
    installFetch((_url, attempt) =>
      attempt === 1
        ? response("slow down", 429, { "Retry-After": "7" })
        : response(usage([detail("batch", "enhanced", 2)])),
    );

    const rows = await fetchSpeechmaticsCostData(ctx(), {
      fromDate: "2026-07-01",
      toDate: "2026-07-01",
    });

    expect(sleeps).toEqual([7_000]);
    expect(rows[0]?.amount).toBe(1.5);
  });

  it("accepts an HTTP-date Retry-After and clamps it to the backoff ceiling", async () => {
    installFetch((_url, attempt) =>
      attempt === 1
        ? response("slow down", 429, {
            "retry-after": new Date(NOW.getTime() + 10 * 60_000).toUTCString(),
          })
        : response(usage([])),
    );

    await fetchSpeechmaticsCostData(ctx(), { fromDate: "2026-07-01", toDate: "2026-07-01" });

    expect(sleeps).toEqual([30_000]);
  });

  it("backs off exponentially when the server sends no Retry-After", async () => {
    installFetch((_url, attempt) =>
      attempt < 4 ? response("boom", 503) : response(usage([detail("batch", "standard", 1)])),
    );

    const rows = await fetchSpeechmaticsCostData(ctx(), {
      fromDate: "2026-07-01",
      toDate: "2026-07-01",
    });

    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
    expect(rows[0]?.amount).toBe(0.45);
  });

  it("gives up after the attempt budget rather than reporting a short window", async () => {
    installFetch(() => response("still limited", 429));

    await expect(
      fetchSpeechmaticsCostData(ctx(), { fromDate: "2026-07-01", toDate: "2026-07-03" }),
    ).rejects.toThrow(/Speechmatics API error 429 for \/usage\?since=2026-07-01/);

    expect(calls).toHaveLength(4);
  });

  it("does not retry a client error such as 401", async () => {
    installFetch(() => response({ code: 401, error: "Unauthorized" }, 401));

    await expect(
      fetchSpeechmaticsCostData(ctx(), { fromDate: "2026-07-01", toDate: "2026-07-01" }),
    ).rejects.toThrow(/Speechmatics API error 401/);

    expect(calls).toHaveLength(1);
  });
});
