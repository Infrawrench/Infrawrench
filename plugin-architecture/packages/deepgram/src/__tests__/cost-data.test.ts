import { describe, expect, it } from "vitest";
import { CostSetupError } from "@infrawrench/plugin-base";
import { fetchDeepgramCostData } from "../cost-data.js";

const PROJECT_A = "11111111-2222-3333-4444-555555555555";
const PROJECT_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const RANGE = { fromDate: "2026-08-01", toDate: "2026-08-31" };

interface Reply {
  status?: number;
  body?: unknown;
}

interface Recorded {
  url: string;
  headers: Record<string, string>;
}

/**
 * Fake host HTTP service. `jsonRestFetch` always prefers it when present, so
 * the collector is exercised end to end (URL building, auth header, error
 * message shape) without touching the network or the plugin client.
 */
function makeHttp(route: (url: string) => Reply) {
  const calls: Recorded[] = [];
  const http = {
    async request(req: { url: string; method: string; headers: Record<string, string> }) {
      calls.push({ url: req.url, headers: req.headers });
      const reply = route(req.url);
      const body = reply.body === undefined ? "" : JSON.stringify(reply.body);
      return { status: reply.status ?? 200, headers: {}, body };
    },
  };
  return { http, calls };
}

function projectList(...ids: string[]) {
  return { projects: ids.map((id) => ({ project_id: id, name: `p-${id.slice(0, 4)}` })) };
}

function bucket(over: Record<string, unknown> = {}) {
  const { line_item, tags, start, ...rest } = {
    dollars: 1.25,
    start: "2026-08-01",
    line_item: "streaming::nova-3" as string | null,
    tags: null as string[] | null,
    ...over,
  };
  return {
    ...rest,
    grouping: { start, end: "2026-08-02", line_item, tags },
  };
}

function breakdown(results: unknown[]) {
  return {
    start: "2026-08-01",
    end: "2026-09-01",
    resolution: { units: "day", amount: 1 },
    results,
  };
}

/** Routes the project list to `ids` and every breakdown call to `results`. */
function singleProject(results: unknown[], ids: string[] = [PROJECT_A]) {
  return makeHttp((url) =>
    url.endsWith("/v1/projects") ? { body: projectList(...ids) } : { body: breakdown(results) },
  );
}

const ctx = { apiKey: "dg-test-key" };

describe("fetchDeepgramCostData", () => {
  it("maps daily billing buckets to cost rows", async () => {
    const { http } = singleProject([
      bucket(),
      bucket({ start: "2026-08-02", dollars: 0.5, line_item: "prerecorded::nova-3" }),
    ]);

    const rows = await fetchDeepgramCostData({ ...ctx, http }, RANGE);

    expect(rows).toEqual([
      {
        date: "2026-08-01",
        service: "streaming::nova-3",
        currency: "USD",
        amount: 1.25,
        tags: { project: PROJECT_A },
      },
      {
        date: "2026-08-02",
        service: "prerecorded::nova-3",
        currency: "USD",
        amount: 0.5,
        tags: { project: PROJECT_A },
      },
    ]);
  });

  it("requests one breakdown per project with an exploded grouping and a bumped end date", async () => {
    const { http, calls } = singleProject([bucket()]);

    await fetchDeepgramCostData({ ...ctx, http }, RANGE);

    expect(calls).toHaveLength(2); // project list + one breakdown; the endpoint has no pagination
    expect(calls[0]?.url).toBe("https://api.deepgram.com/v1/projects");
    expect(calls[0]?.headers["Authorization"]).toBe("Token dg-test-key");

    const url = new URL(calls[1]!.url);
    expect(url.pathname).toBe(`/v1/projects/${PROJECT_A}/billing/breakdown`);
    expect(url.searchParams.get("start")).toBe("2026-08-01");
    // `end` is over-asked by a day; rows are filtered back to the range.
    expect(url.searchParams.get("end")).toBe("2026-09-01");
    expect(url.searchParams.getAll("grouping")).toEqual(["line_item", "tags"]);
    expect(calls[1]?.headers["Authorization"]).toBe("Token dg-test-key");
  });

  it("returns nothing for a project with no billing activity", async () => {
    const { http } = singleProject([]);
    await expect(fetchDeepgramCostData({ ...ctx, http }, RANGE)).resolves.toEqual([]);
  });

  it("returns nothing when the key can see no projects", async () => {
    const { http, calls } = makeHttp(() => ({ body: { projects: [] } }));
    await expect(fetchDeepgramCostData({ ...ctx, http }, RANGE)).resolves.toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("reports nothing rather than zero when dollars are absent everywhere", async () => {
    const { http } = singleProject([
      { grouping: { start: "2026-08-01", line_item: "streaming::nova-3", tags: null } },
      { dollars: null, grouping: { start: "2026-08-02", line_item: "tts::aura-2", tags: null } },
    ]);

    const err = await fetchDeepgramCostData({ ...ctx, http }, RANGE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CostSetupError);
    expect((err as CostSetupError).message).toContain("no dollar amounts");
    expect((err as CostSetupError).helpLink?.url).toBe("https://console.deepgram.com/");
  });

  it("skips individual buckets missing dollars without discarding the rest", async () => {
    const { http } = singleProject([
      { grouping: { start: "2026-08-01", line_item: "streaming::nova-3", tags: null } },
      bucket({ start: "2026-08-03", dollars: 2 }),
    ]);

    const rows = await fetchDeepgramCostData({ ...ctx, http }, RANGE);
    expect(rows).toEqual([
      {
        date: "2026-08-03",
        service: "streaming::nova-3",
        currency: "USD",
        amount: 2,
        tags: { project: PROJECT_A },
      },
    ]);
  });

  it("drops zero-dollar buckets but does not treat them as missing data", async () => {
    const { http } = singleProject([bucket({ dollars: 0 })]);
    await expect(fetchDeepgramCostData({ ...ctx, http }, RANGE)).resolves.toEqual([]);
  });

  it("aggregates repeated dimension tuples into one row", async () => {
    const { http } = singleProject([
      bucket({ dollars: 1 }),
      bucket({ dollars: 0.5 }),
      bucket({ dollars: 0.25, tags: ["prod"] }),
    ]);

    const rows = await fetchDeepgramCostData({ ...ctx, http }, RANGE);
    expect(rows).toEqual([
      {
        date: "2026-08-01",
        service: "streaming::nova-3",
        currency: "USD",
        amount: 1.5,
        tags: { project: PROJECT_A },
      },
      {
        date: "2026-08-01",
        service: "streaming::nova-3",
        currency: "USD",
        amount: 0.25,
        tags: { project: PROJECT_A, tags: "prod" },
      },
    ]);
  });

  it("joins a bucket's tag list in a stable order", async () => {
    const { http } = singleProject([
      bucket({ tags: ["prod", "customer-a"] }),
      bucket({ tags: ["customer-a", "prod"], dollars: 1 }),
    ]);

    const rows = await fetchDeepgramCostData({ ...ctx, http }, RANGE);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tags).toEqual({ project: PROJECT_A, tags: "customer-a,prod" });
    expect(rows[0]?.amount).toBe(2.25);
  });

  it("filters out buckets outside the requested range", async () => {
    const { http } = singleProject([
      bucket({ start: "2026-07-31" }),
      bucket({ start: "2026-09-01" }), // the over-asked end day
      bucket({ start: "2026-08-31", dollars: 3 }),
    ]);

    const rows = await fetchDeepgramCostData({ ...ctx, http }, RANGE);
    expect(rows.map((r) => r.date)).toEqual(["2026-08-31"]);
  });

  it("keeps multi-project accounts separate", async () => {
    const { http, calls } = makeHttp((url) => {
      if (url.endsWith("/v1/projects")) return { body: projectList(PROJECT_A, PROJECT_B) };
      if (url.includes(PROJECT_B)) return { body: breakdown([bucket({ dollars: 4 })]) };
      return { body: breakdown([bucket()]) };
    });

    const rows = await fetchDeepgramCostData({ ...ctx, http }, RANGE);
    expect(calls).toHaveLength(3);
    expect(rows).toEqual([
      {
        date: "2026-08-01",
        service: "streaming::nova-3",
        currency: "USD",
        amount: 1.25,
        tags: { project: PROJECT_A },
      },
      {
        date: "2026-08-01",
        service: "streaming::nova-3",
        currency: "USD",
        amount: 4,
        tags: { project: PROJECT_B },
      },
    ]);
  });

  it("keeps collecting when one project of several refuses billing", async () => {
    const { http } = makeHttp((url) => {
      if (url.endsWith("/v1/projects")) return { body: projectList(PROJECT_A, PROJECT_B) };
      if (url.includes(PROJECT_B)) return { status: 403, body: { err_msg: "insufficient scope" } };
      return { body: breakdown([bucket()]) };
    });

    const rows = await fetchDeepgramCostData({ ...ctx, http }, RANGE);
    expect(rows.map((r) => r.tags?.["project"])).toEqual([PROJECT_A]);
  });

  it("explains a member-scope key when every project refuses billing", async () => {
    const { http } = makeHttp((url) =>
      url.endsWith("/v1/projects")
        ? { body: projectList(PROJECT_A) }
        : { status: 403, body: { err_msg: "insufficient scope" } },
    );

    const err = await fetchDeepgramCostData({ ...ctx, http }, RANGE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CostSetupError);
    expect((err as CostSetupError).message).toContain("admin");
  });

  it("surfaces a non-scope failure as-is", async () => {
    const { http } = makeHttp((url) =>
      url.endsWith("/v1/projects")
        ? { body: projectList(PROJECT_A) }
        : { status: 500, body: { err_msg: "boom" } },
    );

    const err = await fetchDeepgramCostData({ ...ctx, http }, RANGE).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(CostSetupError);
    expect((err as Error).message).toContain("Deepgram API error 500");
  });

  it("refuses to guess a day when amounts arrive without a bucket start", async () => {
    const { http } = singleProject([{ dollars: 5, grouping: { line_item: "streaming::nova-3" } }]);

    const err = await fetchDeepgramCostData({ ...ctx, http }, RANGE).catch((e: unknown) => e);
    expect((err as Error).message).toContain("no bucket start date");
  });

  it("passes a custom CA through to the host HTTP service", async () => {
    let sawCaCert: string | undefined;
    const http = {
      async request(req: { url: string; caCert?: string }) {
        sawCaCert = req.caCert;
        return {
          status: 200,
          headers: {},
          body: JSON.stringify(
            req.url.endsWith("/v1/projects") ? projectList(PROJECT_A) : breakdown([bucket()]),
          ),
        };
      },
    };

    await fetchDeepgramCostData({ ...ctx, http, caCert: "-----BEGIN CERTIFICATE-----" }, RANGE);
    expect(sawCaCert).toBe("-----BEGIN CERTIFICATE-----");
  });
});
