import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnyscaleApi } from "../api.js";
import { AnyscaleClient } from "../client.js";
import { fetchAnyscaleCostData } from "../cost-data.js";
import { BREAKDOWN_KEY, SPEND_KEY } from "../render.js";
import { makeHttp } from "./helpers.js";
import type { Reply } from "./helpers.js";

const TRUNCATED = "has more than Infrawrench reads";
const NOT_A_LIST = "is not a list";
const RANGE = { fromDate: "2026-10-01", toDate: "2026-10-02" };

/** A list route that always has another page. Everything else lists empty. */
function endless(path: string, row: Record<string, string> = {}) {
  let served = 0;
  return (url: URL): Reply => {
    if (url.pathname !== path) return { body: { results: [] } };
    served += 1;
    return {
      body: {
        results: [{ id: `row_${served}`, ...row }],
        metadata: { next_paging_token: `after_${served}` },
      },
    };
  };
}

function clientWith(route: (url: URL) => Reply) {
  const { http, calls } = makeHttp(route);
  return {
    client: hostClient(new AnyscaleClient({ apiKey: "key" }, { http })),
    calls,
    callsTo: (path: string) => calls.filter((c) => c.url.pathname === path),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a list longer than Infrawrench reads", () => {
  it.each([
    ["cloud", "/api/v2/clouds/", 10, "1000"],
    ["project", "/api/v2/projects/", 200, "50"],
    ["workspace", "/api/v2/experimental_workspaces/", 200, "50"],
    ["service", "/api/v2/services-v2/", 200, "50"],
    ["compute-config", "/api/v2/compute_templates/search", 10, "1000"],
    ["budget", "/api/v2/instance_usage_budgets/", 200, "50"],
  ])(
    "%s throws after 10,000 rows instead of pruning the rest",
    async (type, path, pages, count) => {
      const { client, callsTo } = clientWith(endless(path));
      await expect(client.listResources(type, "acc")).rejects.toThrow(TRUNCATED);
      expect(callsTo(path)).toHaveLength(pages);
      expect(callsTo(path)[0]!.url.searchParams.get("count")).toBe(count);
    },
  );

  it.each([
    ["cloud", "/api/v2/decorated_sessions/"],
    ["project", "/api/v2/clouds/"],
    ["workspace", "/api/v2/decorated_sessions/"],
    ["workspace", "/api/v2/projects/"],
  ])("%s does not swallow a truncated %s behind its catch", async (type, path) => {
    const { client } = clientWith(endless(path));
    await expect(client.listResources(type, "acc")).rejects.toThrow(TRUNCATED);
  });

  it("cost data throws at its existing cap of 200 pages", async () => {
    const path = "/api/v2/aggregated_instance_usage/cluster";
    const { http, calls } = makeHttp(endless(path, { date: "2026-10-01", dollar_value: "1" }));
    await expect(
      fetchAnyscaleCostData(createAnyscaleApi({ apiKey: "k", http }), RANGE),
    ).rejects.toThrow(TRUNCATED);
    expect(calls.filter((c) => c.url.pathname === path)).toHaveLength(200);
  });

  it("cost data throws when the cloud directory behind it is truncated", async () => {
    const { http } = makeHttp(endless("/api/v2/clouds/"));
    await expect(
      fetchAnyscaleCostData(createAnyscaleApi({ apiKey: "k", http }), RANGE),
    ).rejects.toThrow(TRUNCATED);
  });
});

describe("jobs, a rolling window", () => {
  it("asks for newest first and keeps the newest 10,000 without failing the sync", async () => {
    const path = "/api/v2/decorated_ha_jobs/";
    const { client, callsTo } = clientWith(endless(path));
    const jobs = await client.listResources("job", "acc");
    expect(jobs).toHaveLength(10);
    expect(callsTo(path)).toHaveLength(10);
    const query = callsTo(path)[0]!.url.searchParams;
    expect(query.get("count")).toBe("1000");
    expect(query.get("sort_field")).toBe("CREATED_AT");
    expect(query.get("sort_order")).toBe("DESC");
    expect(query.get("type_filter")).toBe("BATCH_JOB");
  });

  it("still refuses a page that is not a list", async () => {
    const { client } = clientWith(() => ({ body: { jobs: [] } }));
    await expect(client.listResources("job", "acc")).rejects.toThrow(NOT_A_LIST);
  });
});

describe("a page that is not a list", () => {
  it.each([
    ["cloud", "/api/v2/clouds/"],
    ["project", "/api/v2/projects/"],
    ["workspace", "/api/v2/experimental_workspaces/"],
    ["service", "/api/v2/services-v2/"],
    ["compute-config", "/api/v2/compute_templates/search"],
    ["budget", "/api/v2/instance_usage_budgets/"],
  ])("%s rejects on the first page", async (type, path) => {
    const { client } = clientWith((url) =>
      url.pathname === path ? { body: { error: "busy" } } : { body: { results: [] } },
    );
    await expect(client.listResources(type, "acc")).rejects.toThrow(NOT_A_LIST);
  });

  it("rejects on a later page", async () => {
    const { client } = clientWith((url) =>
      url.searchParams.get("paging_token")
        ? { body: { renamed: [] } }
        : { body: { results: [{ id: "prj_1" }], metadata: { next_paging_token: "p2" } } },
    );
    await expect(client.listResources("project", "acc")).rejects.toThrow(NOT_A_LIST);
  });

  it("rejects cost data", async () => {
    const { http } = makeHttp(() => ({ body: { rows: [] } }));
    await expect(
      fetchAnyscaleCostData(createAnyscaleApi({ apiKey: "k", http }), RANGE),
    ).rejects.toThrow(NOT_A_LIST);
  });

  it("reads a null list as empty", async () => {
    const { client } = clientWith(() => ({ body: { results: null } }));
    await expect(client.listResources("project", "acc")).resolves.toEqual([]);
  });
});

describe("reads that only decorate a list", () => {
  it("still lists when an extra read simply fails", async () => {
    const { client } = clientWith((url) =>
      url.pathname === "/api/v2/experimental_workspaces/"
        ? { body: { results: [{ id: "expwrk_a", name: "w", state: "Running" }] } }
        : { status: 500 },
    );
    const list = await client.listResources("workspace", "acc");
    expect(list.map((w) => w.displayName)).toEqual(["w"]);
  });

  it("fails cost data on a cloud directory outage, rather than store rows with no region", async () => {
    const { http } = makeHttp((url) =>
      url.pathname === "/api/v2/clouds/"
        ? { status: 500 }
        : { body: { results: [{ date: "2026-10-01", dollar_value: 1, cloud_id: "cld_1" }] } },
    );
    await expect(
      fetchAnyscaleCostData(createAnyscaleApi({ apiKey: "k", http }), RANGE),
    ).rejects.toThrow("500");
  });

  it("keeps cost data when the key may not read clouds", async () => {
    const { http } = makeHttp((url) =>
      url.pathname === "/api/v2/clouds/"
        ? { status: 403 }
        : { body: { results: [{ date: "2026-10-01", dollar_value: 1, cloud_id: "cld_1" }] } },
    );
    const rows = await fetchAnyscaleCostData(createAnyscaleApi({ apiKey: "k", http }), RANGE);
    expect(rows.map((r) => r.amount)).toEqual([1]);
  });
});

describe("reads where part of a list is fine", () => {
  it("charts the first pages of daily spend and stops", async () => {
    const path = "/api/v2/aggregated_instance_usage/cluster_type";
    const { client, callsTo } = clientWith(
      endless(path, { date: "2026-10-01", cluster_type: "JOB" }),
    );
    const series = await client.fetchMetricSeries("organization", "acc:organization:o", "acc");
    expect(series.map((s) => s.label)).toEqual(["Spend: JOB"]);
    expect(callsTo(path)).toHaveLength(10);
  });

  it("offers the first pages in the budget scope picker", async () => {
    const path = "/api/v2/projects/";
    const { client, callsTo } = clientWith(endless(path, { parent_cloud_id: "cld_1" }));
    const config = await client.getCreateConfig("budget");
    const scope = config.fields.find((f) => f.key === "scope");
    expect(scope?.options?.some((o) => o.id === "project:cld_1:row_1")).toBe(true);
    expect(callsTo(path)).toHaveLength(200);
  });
});

describe("detail views never show a total summed from part of a list", () => {
  const organization = {
    id: "acc:organization:o",
    pluginId: "anyscale",
    resourceTypeId: "organization",
    accountId: "acc",
    displayName: "Org",
    fields: {},
    resolvedOutputs: {},
    secretStates: [],
    createdAt: "",
    updatedAt: "",
  };

  it("leaves the organization breakdown out when one grouping is truncated", async () => {
    const path = "/api/v2/aggregated_instance_usage/user";
    const { client, callsTo } = clientWith(
      endless(path, { user_email: "a@example.com", dollar_value: "1" }),
    );
    const detail = await client.enrichDetail!(organization);
    expect(detail.resolvedOutputs[BREAKDOWN_KEY]).toBeUndefined();
    expect(callsTo(path)).toHaveLength(10);
  });

  it("leaves a workload's spend out when its usage is truncated", async () => {
    const path = "/api/v2/aggregated_instance_usage/cluster";
    const { client, callsTo } = clientWith(endless(path, { job_id: "prodjob_1" }));
    const detail = await client.enrichDetail!({
      ...organization,
      id: "acc:job:prodjob_1",
      resourceTypeId: "job",
      externalId: "prodjob_1",
    });
    expect(detail.resolvedOutputs[SPEND_KEY]).toBeUndefined();
    expect(callsTo(path)).toHaveLength(10);
  });
});

describe("host HTTP", () => {
  it("sends every list through services.http, with no CA and no fetch", async () => {
    const fetchStub = vi.fn(() => {
      throw new Error("no fetch expected");
    });
    vi.stubGlobal("fetch", fetchStub);
    const request = vi.fn(async (_req: { url: string; caCert?: string }) => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ results: [] }),
    }));
    const client = hostClient(new AnyscaleClient({ apiKey: "key" }, { http: { request } }));
    await client.listResources("cloud", "acc");
    expect(request).toHaveBeenCalled();
    expect(request.mock.calls[0]![0].caCert).toBeUndefined();
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
