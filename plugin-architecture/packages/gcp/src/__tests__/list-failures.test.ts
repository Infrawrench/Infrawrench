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

  it("says so when every parent refuses, rather than listing nothing", async () => {
    const err = apiError(403, "PERMISSION_DENIED");
    const ctx = makeCtx((url) => {
      const parents = list.parents(url);
      if (parents) return parents;
      throw err;
    });
    await expect(list.run(ctx)).rejects.toBe(err);
  });
});

const LOCATIONS = [
  { name: `projects/${PROJ}/locations/us-a`, locationId: "us-a" },
  { name: `projects/${PROJ}/locations/us-b`, locationId: "us-b" },
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
    ctx: (read) => makeCtx(read),
    refusing: "/locations/us-east1/",
    child: { name: "projects/123/locations/x/endpoints/e" },
    survivors: 6,
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

  it("says so when every region refuses, rather than listing nothing", async () => {
    const err = apiError(403, "PERMISSION_DENIED");
    const ctx = list.ctx(() => {
      throw err;
    });
    await expect(list.run(ctx)).rejects.toBe(err);
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
