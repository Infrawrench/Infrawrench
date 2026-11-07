import { ListTruncatedError } from "@infrawrench/plugin-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as listers from "../resource-listers.js";
import { type ListerContext } from "../resource-listers/shared.js";

const ACCT = "acct1";
const PROJ = "proj1";

/** The transport's error: a status on the error and Google's body in the message. */
function apiError(status: number, body = ""): Error {
  return Object.assign(new Error(`GCP API ${status} for https://x: ${body}`), { status });
}

const THROTTLED_403 = '{"error":{"code":403,"errors":[{"reason":"rateLimitExceeded"}]}}';

function makeCtx(paginate: (url: string) => unknown[]): ListerContext {
  return {
    get: vi.fn(async () => ({})) as ListerContext["get"],
    paginate: vi.fn(async (url: string) => paginate(url)) as ListerContext["paginate"],
    id: (a, t, e) => `${a}:${t}:${e}`,
    now: () => "2026-01-01T00:00:00.000Z",
  };
}

const unreadHook = Symbol.for("infrawrench.unreadListPart");
let unread: ReturnType<typeof vi.fn>;

beforeEach(() => {
  unread = vi.fn();
  Reflect.set(globalThis, unreadHook, unread);
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, unreadHook);
});

/**
 * Each list that reads children per parent the API named. `children` answers for
 * one parent, or throws what that parent answered; the first parent's rows are what
 * survive when the second refuses.
 */
const PARENT_LISTS: Array<{
  name: string;
  run: (ctx: ListerContext) => Promise<Array<{ externalId?: string }>>;
  parents: (url: string) => unknown[] | undefined;
  isChild: (url: string) => boolean;
  second: string;
  child: unknown;
  survivor: string;
  unreadParent: string;
}> = [
  {
    name: "BigQuery tables",
    run: (ctx) => listers.listBigQueryTables(ctx, ACCT, PROJ),
    parents: (url) =>
      url.endsWith("/datasets")
        ? [{ datasetReference: { datasetId: "one" } }, { datasetReference: { datasetId: "two" } }]
        : undefined,
    isChild: (url) => url.endsWith("/tables"),
    second: "/datasets/two/",
    child: { tableReference: { tableId: "t" } },
    survivor: `${PROJ}:one/t`,
    unreadParent: `${ACCT}:bigquery-dataset:${PROJ}:two`,
  },
  {
    name: "Spanner databases",
    run: (ctx) => listers.listSpannerDatabases(ctx, ACCT, PROJ),
    parents: (url) =>
      url.endsWith("/instances")
        ? [{ name: `projects/${PROJ}/instances/one` }, { name: `projects/${PROJ}/instances/two` }]
        : undefined,
    isChild: (url) => url.endsWith("/databases"),
    second: "/instances/two/",
    child: { name: "x/databases/d" },
    survivor: "one/d",
    unreadParent: `${ACCT}:spanner-instance:two`,
  },
  {
    name: "Spanner backups",
    run: (ctx) => listers.listSpannerBackups(ctx, ACCT, PROJ),
    parents: (url) =>
      url.endsWith("/instances")
        ? [{ name: `projects/${PROJ}/instances/one` }, { name: `projects/${PROJ}/instances/two` }]
        : undefined,
    isChild: (url) => url.endsWith("/backups"),
    second: "/instances/two/",
    child: { name: "x/backups/b" },
    survivor: "one/b",
    unreadParent: `${ACCT}:spanner-instance:two`,
  },
  {
    name: "AlloyDB instances",
    run: (ctx) => listers.listAlloyDbInstances(ctx, ACCT, PROJ),
    parents: (url) =>
      url.endsWith("/clusters") ? [{ name: "clusters/one" }, { name: "clusters/two" }] : undefined,
    isChild: (url) => url.endsWith("/instances"),
    second: "clusters/two/",
    child: { name: "x/instances/i" },
    survivor: "x/instances/i",
    unreadParent: `${ACCT}:alloydb-cluster:clusters/two`,
  },
  {
    name: "Cloud DNS record sets",
    run: (ctx) => listers.listCloudDnsRecordSets(ctx, ACCT, PROJ),
    parents: (url) =>
      url.endsWith("/managedZones")
        ? [
            { name: "one", dnsName: "one.example." },
            { name: "two", dnsName: "two.example." },
          ]
        : undefined,
    isChild: (url) => url.endsWith("/rrsets"),
    second: "/managedZones/two/",
    child: { type: "A", name: "a.one.example." },
    survivor: "one/A:a.one.example.",
    unreadParent: `${ACCT}:cloud-dns-zone:two`,
  },
  {
    name: "KMS keys, per key ring",
    run: (ctx) => listers.listKmsKeys(ctx, ACCT, PROJ),
    parents: (url) => {
      if (url.endsWith("/locations")) return [{ name: "loc/us", locationId: "us" }];
      return url.endsWith("/keyRings")
        ? [{ name: "loc/us/keyRings/one" }, { name: "loc/us/keyRings/two" }]
        : undefined;
    },
    isChild: (url) => url.endsWith("/cryptoKeys"),
    second: "/keyRings/two/",
    child: { name: "x/cryptoKeys/k" },
    survivor: "x/cryptoKeys/k",
    unreadParent: `${ACCT}:kms-key-ring:loc/us/keyRings/two`,
  },
];

describe.each(PARENT_LISTS)("$name when one parent's children fail", (list) => {
  const whenSecondAnswers = (err: Error) =>
    makeCtx((url) => {
      const parents = list.parents(url);
      if (parents) return parents;
      if (!list.isChild(url)) return [];
      if (url.includes(list.second)) throw err;
      return [list.child];
    });

  it.each([
    ["a 429", apiError(429)],
    ["a 500", apiError(500)],
    ["a 503", apiError(503)],
    ["a 401", apiError(401)],
    ["a throttle sent as a 403", apiError(403, THROTTLED_403)],
    ["an error with no status", new Error("socket hang up")],
    ["a list refused at its cap", new ListTruncatedError({ vendor: "x", path: "/x", items: 1 })],
  ])("fails the whole type on %s, so stored rows stay", async (_, err) => {
    await expect(list.run(whenSecondAnswers(err))).rejects.toBe(err);
  });

  it("reads a 404 as a parent gone since it was listed: its children go too", async () => {
    const rows = await list.run(whenSecondAnswers(apiError(404)));
    expect(rows.map((r) => r.externalId)).toEqual([list.survivor]);
    expect(unread).not.toHaveBeenCalled();
  });

  it("keeps the rest on a 403 and leaves that parent's rows out of the prune", async () => {
    const rows = await list.run(whenSecondAnswers(apiError(403, "PERMISSION_DENIED")));
    expect(rows.map((r) => r.externalId)).toEqual([list.survivor]);
    expect(unread).toHaveBeenCalledWith({ parentResourceIds: [list.unreadParent] });
  });

  it("fails on a parent's 403 where nobody keeps its rows", async () => {
    Reflect.set(globalThis, unreadHook, () => false);
    const err = apiError(403, "PERMISSION_DENIED");
    await expect(list.run(whenSecondAnswers(err))).rejects.toBe(err);
  });

  const everyParentRefuses = (err: Error) =>
    makeCtx((url) => {
      const parents = list.parents(url);
      if (parents) return parents;
      throw err;
    });

  it("keeps every stored row without an error when every parent refuses", async () => {
    const rows = await list.run(everyParentRefuses(apiError(403, "PERMISSION_DENIED")));
    expect(rows).toEqual([]);
    expect(unread).toHaveBeenCalledWith({ idPrefixes: [""] });
  });

  it("says so when every parent refuses and nobody keeps the rows", async () => {
    Reflect.set(globalThis, unreadHook, () => false);
    const err = apiError(403, "PERMISSION_DENIED");
    await expect(list.run(everyParentRefuses(err))).rejects.toBe(err);
  });
});

const LOCATIONS = [
  { name: `projects/${PROJ}/locations/us-a`, locationId: "us-a" },
  { name: `projects/${PROJ}/locations/us-b`, locationId: "us-b" },
];

/** What Vertex AI's `locations.list` names, `global` and a multi-region among them. */
const VERTEX_LOCATIONS = [
  { name: `projects/${PROJ}/locations/us-central1`, locationId: "us-central1" },
  { name: `projects/${PROJ}/locations/us-east1`, locationId: "us-east1" },
  { name: `projects/${PROJ}/locations/me-central2`, locationId: "me-central2" },
  { name: `projects/${PROJ}/locations/global`, locationId: "global" },
  { name: `projects/${PROJ}/locations/us`, locationId: "us" },
];

/** Each list that fans out over regions or locations. */
const REGION_LISTS: Array<{
  name: string;
  run: (ctx: ListerContext) => Promise<Array<{ externalId?: string }>>;
  ctx: (read: (url: string) => unknown[]) => ListerContext;
  refusing: string;
  child: unknown;
  survivors: number;
  unreadPrefix: string;
}> = [
  {
    name: "Vertex AI endpoints",
    run: (ctx) => listers.listVertexAiEndpoints(ctx, ACCT, PROJ),
    ctx: (read) =>
      makeCtx((url) =>
        url.endsWith(`/projects/${PROJ}/locations`) ? VERTEX_LOCATIONS : read(url),
      ),
    refusing: "/locations/us-east1/",
    child: { name: "projects/123/locations/x/endpoints/e" },
    survivors: 2,
    // Google writes a project number into these names, so no region prefix can match.
    unreadPrefix: `${ACCT}:vertex-ai-endpoint:`,
  },
  {
    name: "Cloud Build triggers",
    run: (ctx) => listers.listCloudBuildTriggers(ctx, ACCT, PROJ),
    ctx: (read) => makeCtx(read),
    refusing: "/locations/us-east1/",
    child: { id: "t" },
    survivors: 15,
    unreadPrefix: `${ACCT}:cloud-build-trigger:us-east1/`,
  },
  {
    name: "Cloud Tasks queues",
    run: (ctx) => listers.listCloudTasksQueues(ctx, ACCT, PROJ),
    ctx: (read) => withLocations(read),
    refusing: "/locations/us-b/",
    child: { name: "x/queues/q" },
    survivors: 1,
    unreadPrefix: `${ACCT}:cloud-tasks-queue:projects/${PROJ}/locations/us-b/`,
  },
  {
    name: "Cloud Scheduler jobs",
    run: (ctx) => listers.listCloudSchedulerJobs(ctx, ACCT, PROJ),
    ctx: (read) => withLocations(read),
    refusing: "/locations/us-b/",
    child: { name: "x/jobs/j" },
    survivors: 1,
    unreadPrefix: `${ACCT}:cloud-scheduler-job:projects/${PROJ}/locations/us-b/`,
  },
  {
    name: "KMS key rings",
    run: (ctx) => listers.listKmsKeyRings(ctx, ACCT, PROJ),
    ctx: (read) => withLocations(read),
    refusing: "/locations/us-b/",
    child: { name: "x/keyRings/r" },
    survivors: 1,
    unreadPrefix: `${ACCT}:kms-key-ring:projects/${PROJ}/locations/us-b/`,
  },
];

function withLocations(read: (url: string) => unknown[]): ListerContext {
  return makeCtx((url) => (url.endsWith("/locations") ? LOCATIONS : read(url)));
}

describe.each(REGION_LISTS)("$name when one region's read fails", (list) => {
  const whenRefusingAnswers = (err: Error) =>
    list.ctx((url) => {
      if (url.includes(list.refusing)) throw err;
      return [list.child];
    });

  it.each([
    ["a 429", apiError(429)],
    ["a 503", apiError(503)],
    ["a 401", apiError(401)],
    ["a throttle sent as a 403", apiError(403, THROTTLED_403)],
    ["an error with no status", new Error("fetch failed")],
    ["a list refused at its cap", new ListTruncatedError({ vendor: "x", path: "/x", items: 1 })],
  ])("fails the whole type on %s, so stored rows stay", async (_, err) => {
    await expect(list.run(whenRefusingAnswers(err))).rejects.toBe(err);
  });

  it.each([
    ["a 403", apiError(403, "PERMISSION_DENIED")],
    ["a 404", apiError(404)],
    ["a 400", apiError(400, "location is not supported")],
    ["a 501", apiError(501)],
  ])("reads %s as a region not available here, keeping the rest", async (_, err) => {
    const rows = await list.run(whenRefusingAnswers(err));
    expect(rows).toHaveLength(list.survivors);
    expect(unread).toHaveBeenCalledWith({ idPrefixes: [list.unreadPrefix] });
  });

  it("fails on a region's 403 where nobody keeps its rows", async () => {
    Reflect.set(globalThis, unreadHook, () => false);
    const err = apiError(403, "PERMISSION_DENIED");
    await expect(list.run(whenRefusingAnswers(err))).rejects.toBe(err);
  });

  it("still reads a region without the service as none where nobody keeps rows", async () => {
    Reflect.set(globalThis, unreadHook, () => false);
    const rows = await list.run(whenRefusingAnswers(apiError(400, "location is not supported")));
    expect(rows).toHaveLength(list.survivors);
  });

  const everyRegionRefuses = (err: Error) =>
    list.ctx(() => {
      throw err;
    });

  it("keeps every stored row without an error when every region refuses", async () => {
    const rows = await list.run(everyRegionRefuses(apiError(403, "PERMISSION_DENIED")));
    expect(rows).toEqual([]);
    expect(unread).toHaveBeenCalledWith({ idPrefixes: [""] });
  });

  it("says so when every region refuses and nobody keeps the rows", async () => {
    Reflect.set(globalThis, unreadHook, () => false);
    const err = apiError(403, "PERMISSION_DENIED");
    await expect(list.run(everyRegionRefuses(err))).rejects.toBe(err);
  });
});

describe("KMS keys, per location", () => {
  const whenUsBAnswers = (err: Error) =>
    makeCtx((url) => {
      if (url.endsWith("/locations")) return LOCATIONS;
      if (url.includes("/locations/us-b/")) throw err;
      if (url.endsWith("/keyRings")) return [{ name: `${LOCATIONS[0]!.name}/keyRings/r` }];
      return [{ name: "x/cryptoKeys/k" }];
    });

  it("fails the whole type on a 503", async () => {
    const err = apiError(503);
    await expect(listers.listKmsKeys(whenUsBAnswers(err), ACCT, PROJ)).rejects.toBe(err);
  });

  it("keeps the rest on a 403, leaving that location's rows out of the prune", async () => {
    const rows = await listers.listKmsKeys(whenUsBAnswers(apiError(403)), ACCT, PROJ);
    expect(rows).toHaveLength(1);
    expect(unread).toHaveBeenCalledWith({
      idPrefixes: [`${ACCT}:kms-key:projects/${PROJ}/locations/us-b/`],
    });
  });
});

describe.each([
  ["KMS key rings", listers.listKmsKeyRings],
  ["KMS keys", listers.listKmsKeys],
])("%s when the location list itself fails", (_, list) => {
  it.each([
    ["a 503", apiError(503)],
    ["a 429", apiError(429)],
    ["a permission 403", apiError(403, "PERMISSION_DENIED")],
    ["a list refused at its cap", new ListTruncatedError({ vendor: "x", path: "/x", items: 1 })],
  ])("fails on %s instead of listing none", async (_status, err) => {
    const ctx = makeCtx(() => {
      throw err;
    });
    await expect(list(ctx, ACCT, PROJ)).rejects.toBe(err);
  });
});

describe("BigQuery hydration when a dataset's or table's GET fails", () => {
  const DATASET = {
    datasetReference: { datasetId: "d" },
    friendlyName: "Dataset",
    location: "US",
    labels: { team: "data" },
  };
  const TABLE = {
    tableReference: { tableId: "t" },
    friendlyName: "Table",
    type: "TABLE",
    labels: { team: "data" },
    creationTime: "1700000000000",
    clustering: { fields: ["a"] },
  };

  function bqCtx(get: (url: string) => Promise<unknown>): ListerContext {
    const ctx = makeCtx((url) => (url.endsWith("/datasets") ? [DATASET] : [TABLE]));
    ctx.get = vi.fn(get) as ListerContext["get"];
    return ctx;
  }

  it.each([
    ["a 429", apiError(429)],
    ["a 503", apiError(503)],
    ["a 403", apiError(403, "PERMISSION_DENIED")],
  ])("leaves a dataset's detail fields out on %s, so the stored ones stay", async (_, err) => {
    const rows = await listers.listBigQueryDatasets(
      bqCtx(async () => {
        throw err;
      }),
      ACCT,
      PROJ,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fields).toEqual({
      name: "d",
      friendlyName: "Dataset",
      location: "US",
      labels: "team=data",
    });
  });

  it("writes every field of a dataset that hydrated", async () => {
    const rows = await listers.listBigQueryDatasets(
      bqCtx(async () => ({ ...DATASET, description: "about", maxTimeTravelHours: "168" })),
      ACCT,
      PROJ,
    );
    expect(rows[0]!.fields).toMatchObject({ description: "about", maxTimeTravelHours: 168 });
  });

  it.each([
    ["a 429", apiError(429)],
    ["a 503", apiError(503)],
    ["a 404", apiError(404)],
  ])("leaves a table's detail fields out on %s, so the stored ones stay", async (_, err) => {
    const rows = await listers.listBigQueryTables(
      bqCtx(async () => {
        throw err;
      }),
      ACCT,
      PROJ,
      "d",
    );
    expect(rows).toHaveLength(1);
    const fields = rows[0]!.fields;
    for (const key of ["numRows", "numBytes", "schemaJson", "description", "location"]) {
      expect(fields).not.toHaveProperty(key);
    }
    expect(fields).toMatchObject({
      name: "t",
      datasetId: `${PROJ}:d`,
      type: "TABLE",
      labels: "team=data",
      clusteringFields: "a",
      expirationTime: "NEVER",
    });
  });

  it("writes a table's storage fields when it hydrated", async () => {
    const rows = await listers.listBigQueryTables(
      bqCtx(async () => ({ ...TABLE, numRows: "5", location: "US" })),
      ACCT,
      PROJ,
      "d",
    );
    expect(rows[0]!.fields).toMatchObject({ numRows: "5", location: "US" });
  });

  it("hydrates a large dataset's tables a few at a time", async () => {
    const ctx = makeCtx(() =>
      Array.from({ length: 40 }, (_, i) => ({ tableReference: { tableId: `t${i}` } })),
    );
    let inFlight = 0;
    let most = 0;
    ctx.get = vi.fn(async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return {};
    }) as ListerContext["get"];
    const rows = await listers.listBigQueryTables(ctx, ACCT, PROJ, "d");
    expect(rows.map((r) => r.externalId)).toEqual(
      Array.from({ length: 40 }, (_, i) => `${PROJ}:d/t${i}`),
    );
    expect(most).toBeLessThanOrEqual(8);
  });
});

describe("Vertex AI endpoints, per location", () => {
  const endpointsIn = (url: string) => {
    const region = url.split("/locations/")[1]!.split("/")[0]!;
    return [{ name: `projects/123/locations/${region}/endpoints/e` }];
  };

  it("reads every regional location Vertex AI names, at that region's host", async () => {
    const ctx = makeCtx((url) =>
      url.endsWith(`/projects/${PROJ}/locations`) ? VERTEX_LOCATIONS : endpointsIn(url),
    );
    const rows = await listers.listVertexAiEndpoints(ctx, ACCT, PROJ);
    expect(rows.map((r) => r.fields["region"])).toEqual(["us-central1", "us-east1", "me-central2"]);
    const urls = vi.mocked(ctx.paginate).mock.calls.map(([url]) => url);
    expect(urls).toEqual([
      `https://aiplatform.googleapis.com/v1/projects/${PROJ}/locations`,
      `https://us-central1-aiplatform.googleapis.com/v1/projects/${PROJ}/locations/us-central1/endpoints`,
      `https://us-east1-aiplatform.googleapis.com/v1/projects/${PROJ}/locations/us-east1/endpoints`,
      `https://me-central2-aiplatform.googleapis.com/v1/projects/${PROJ}/locations/me-central2/endpoints`,
    ]);
  });

  it.each([
    ["a 503", apiError(503)],
    ["a 429", apiError(429)],
    ["a 401", apiError(401)],
    ["a throttle sent as a 403", apiError(403, THROTTLED_403)],
  ])("fails on %s from the location list instead of listing none", async (_, err) => {
    const ctx = makeCtx((url) => {
      if (url.endsWith(`/projects/${PROJ}/locations`)) throw err;
      return endpointsIn(url);
    });
    await expect(listers.listVertexAiEndpoints(ctx, ACCT, PROJ)).rejects.toBe(err);
  });

  it("reads the regions it always read when the location list names none", async () => {
    const ctx = makeCtx((url) =>
      url.endsWith(`/projects/${PROJ}/locations`) ? [] : endpointsIn(url),
    );
    await expect(listers.listVertexAiEndpoints(ctx, ACCT, PROJ)).resolves.toHaveLength(7);
  });

  it("reads the regions it always read when the location list is refused", async () => {
    const ctx = makeCtx((url) => {
      if (url.endsWith(`/projects/${PROJ}/locations`)) throw apiError(403, "PERMISSION_DENIED");
      return endpointsIn(url);
    });
    const rows = await listers.listVertexAiEndpoints(ctx, ACCT, PROJ);
    expect(rows).toHaveLength(7);
    expect(rows.map((r) => r.fields["region"])).toContain("asia-northeast1");
  });
});
