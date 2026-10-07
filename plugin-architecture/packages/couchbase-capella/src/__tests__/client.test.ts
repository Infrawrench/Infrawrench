import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostServices } from "@infrawrench/plugin-base";
import { createMockResource } from "@infrawrench/plugin-base/test-harness";
import { CapellaClient, monthChunks } from "../client.js";
import { CapellaApiError, joinId, splitId } from "../api.js";
import { plugin } from "../plugin.js";
import { mapComponent } from "../status-feed.js";
import { capellaTerraformExport } from "../terraform.js";
import { RESOURCE_TYPES, T } from "../resource-types.js";
import { mockFetch } from "./helpers.js";

const O = "/v4/organizations/org-1";
const P = `${O}/projects/p1`;
const page = (data: unknown[], last = 1, pageNo = 1) => ({
  data,
  cursor: { pages: { page: pageNo, last, perPage: 100, totalItems: data.length } },
});

const CLUSTER = {
  id: "c1",
  name: "prod",
  cloudProvider: { type: "aws", region: "us-east-1", cidr: "10.0.0.0/23" },
  couchbaseServer: { version: "7.6.2" },
  serviceGroups: [
    {
      node: { compute: { cpu: 4, ram: 16 }, disk: { type: "gp3", storage: 50, iops: 3000 } },
      numOfNodes: 3,
      services: ["data", "query"],
    },
    { node: { compute: { cpu: 8, ram: 32 } }, numOfNodes: 2, services: ["index"] },
  ],
  availability: { type: "multi" },
  support: { plan: "developer pro", timezone: "ET" },
  currentState: "healthy",
  deletionProtection: false,
  connectionString: "cb.abc.cloud.couchbase.com",
};
const FREE = { ...CLUSTER, id: "f1", name: "free", support: { plan: "free" }, serviceGroups: [] };

function secretsStore() {
  const store = new Map<string, string>();
  const secrets: NonNullable<HostServices["secrets"]> = {
    getPlaintext: async (id, key) => store.get(`${id}|${key}`) ?? null,
    setPlaintext: async (id, key, value) => {
      store.set(`${id}|${key}`, value);
    },
  };
  return { store, secrets };
}

afterEach(() => vi.unstubAllGlobals());

describe("CapellaClient", () => {
  it("walks pages and sends the bearer key", async () => {
    const { calls } = mockFetch({
      [`GET ${O}/projects`]: (url: URL) =>
        url.searchParams.get("page") === "1"
          ? page([{ id: "p1", name: "One" }], 2, 1)
          : page([{ id: "p2", name: "Two" }], 2, 2),
    });
    const client = new CapellaClient({ apiKey: "k", organizationId: "org-1" });
    const projects = await client.listResources(T.project, "acc");
    expect(projects.map((p) => p.externalId)).toEqual(["p1", "p2"]);
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer k");
    expect(projects[0]!.fields["organizationId"]).toBe("org-1");
  });

  it("maps clusters, totals nodes across service groups and spots the free tier", async () => {
    mockFetch({
      [`GET ${O}/projects`]: page([{ id: "p1" }]),
      [`GET ${P}/clusters`]: page([CLUSTER, FREE]),
    });
    const client = new CapellaClient({ apiKey: "k", organizationId: "org-1" });
    const [prod, free] = await client.listResources(T.cluster, "acc");
    expect(prod!.fields).toMatchObject({
      compute: "4/16",
      nodes: 3,
      totalNodes: 5,
      vcpus: 4,
      freeTier: false,
      region: "us-east-1",
    });
    expect(free!.fields["freeTier"]).toBe(true);
  });

  it("uses the freeTier paths for a free cluster's buckets and turn-off", async () => {
    const { calls } = mockFetch({
      [`GET ${O}/projects`]: page([{ id: "p1" }]),
      [`GET ${P}/clusters`]: page([FREE]),
      [`GET ${P}/clusters/f1/buckets/freeTier`]: {
        data: [{ id: "YjE=", name: "b1", stats: { itemCount: 0 } }],
      },
      [`DELETE ${P}/clusters/freeTier/f1/activationState`]: null,
    });
    const client = new CapellaClient({ apiKey: "k", organizationId: "org-1" });
    const buckets = await client.listResources(T.bucket, "acc");
    expect(buckets[0]!.externalId).toBe("p1/f1/YjE%3D");
    expect(splitId(buckets[0]!.externalId!, 3)[2]).toBe("YjE=");
    await client.invokeAction(
      T.cluster,
      `acc:${T.cluster}:${joinId("p1", "f1")}`,
      "turn-off",
      "acc",
    );
    expect(calls.at(-1)!.url.pathname).toBe(`${P}/clusters/freeTier/f1/activationState`);
  });

  it("keeps a new credential's password and builds a couchbases:// URI", async () => {
    const { store, secrets } = secretsStore();
    mockFetch({
      [`GET ${O}/projects`]: page([{ id: "p1" }]),
      [`GET ${P}/clusters`]: page([CLUSTER]),
      [`GET ${P}/clusters/c1`]: CLUSTER,
      [`POST ${P}/clusters/c1/users`]: { id: "u1", password: "Gen3rated!" },
      [`GET ${P}/clusters/c1/users`]: page([
        { id: "u1", name: "app", access: [{ privileges: ["data_reader"] }] },
      ]),
    });
    const client = new CapellaClient({ apiKey: "k", organizationId: "org-1" }, { secrets });
    const r = await client.createResource(T.credential, "acc", {
      cluster: joinId("p1", "c1"),
      name: "app",
      access: "read",
      buckets: "",
    });
    const id = "resource" in r ? r.resource.id : r.id;
    expect([...store.values()]).toEqual(["Gen3rated!"]);
    expect(await client.resolveOutput(T.credential, id, "connectionString", "acc")).toBe(
      "couchbases://app:Gen3rated!@cb.abc.cloud.couchbase.com",
    );
  });

  it("puts the schedule and falls back to POST when none exists", async () => {
    const { calls } = mockFetch({
      [`PUT ${P}/clusters/c1/onOffSchedule`]: new Response('{"message":"not found"}', {
        status: 404,
      }),
      [`POST ${P}/clusters/c1/onOffSchedule`]: null,
    });
    const client = new CapellaClient({ apiKey: "k", organizationId: "org-1" });
    await client.executeNoSqlCommand(T.cluster, `acc:${T.cluster}:p1/c1`, "acc", "set-schedule", [
      JSON.stringify({
        timezone: "US/Eastern",
        days: '["monday","tuesday"]',
        fromHour: "8",
        toHour: "20",
      }),
    ]);
    const body = calls.at(-1)!.body as { days: Array<{ day: string; state: string }> };
    expect(calls.at(-1)!.method).toBe("POST");
    expect(body.days.find((d) => d.day === "monday")).toMatchObject({
      state: "custom",
      from: { hour: 8 },
      to: { hour: 20 },
    });
    expect(body.days.find((d) => d.day === "sunday")).toEqual({ day: "sunday", state: "off" });
  });

  it("attributes cost to clusters and leaves only the remainder unattributed", async () => {
    mockFetch({
      [`GET ${O}/projects`]: page([{ id: "p1" }]),
      [`GET ${P}/clusters`]: page([CLUSTER, FREE]),
      [`POST ${P}/clusters/c1/billing`]: {
        data: {
          billingCurrency: "USD",
          periods: [
            {
              startDate: "2026-09-01",
              endDate: "2026-09-01",
              categories: [{ category: "operationalComputeAndStorage", currencySpend: 10 }],
            },
          ],
        },
      },
      [`POST ${O}/billing`]: {
        data: {
          billingCurrency: "USD",
          periods: [
            {
              startDate: "2026-09-01",
              endDate: "2026-09-01",
              categories: [
                { category: "operationalComputeAndStorage", currencySpend: 10 },
                { category: "appServicesComputeAndStorage", currencySpend: 2.5 },
              ],
            },
          ],
        },
      },
    });
    const client = new CapellaClient({ apiKey: "k", organizationId: "org-1" });
    const rows = await client.fetchCostData("acc", {
      fromDate: "2026-09-01",
      toDate: "2026-09-01",
    });
    expect(rows).toEqual([
      {
        date: "2026-09-01",
        service: "Operational compute and storage",
        region: "us-east-1",
        resourceId: "c1",
        tags: { project: "p1", cluster: "prod" },
        currency: "USD",
        amount: 10,
      },
      { date: "2026-09-01", service: "App Services", currency: "USD", amount: 2.5 },
    ]);
  });

  it("splits ranges into calendar months", () => {
    expect(monthChunks("2026-08-30", "2026-10-02")).toEqual([
      { start: "2026-08-30", end: "2026-08-31" },
      { start: "2026-09-01", end: "2026-09-30" },
      { start: "2026-10-01", end: "2026-10-02" },
    ]);
  });

  it("reads prepaid credits and surfaces a 403 as an access error", async () => {
    mockFetch({
      [`GET ${O}/billing/prePaidCredits`]: {
        data: [
          {
            id: "cr1",
            creditName: "Annual",
            total: 1000,
            remaining: 400,
            expirationDate: "2027-01-01T00:00:00Z",
          },
        ],
      },
    });
    const client = new CapellaClient({ apiKey: "k", organizationId: "org-1" });
    expect(await client.fetchCreditBalance("acc")).toEqual([
      {
        key: "cr1",
        label: "Annual",
        remaining: 400,
        currency: "USD",
        granted: 1000,
        expiresAt: "2027-01-01T00:00:00Z",
      },
    ]);
    mockFetch({
      [`GET ${O}/billing/prePaidCredits`]: new Response('{"message":"forbidden"}', { status: 403 }),
    });
    await expect(client.fetchCreditBalance("acc")).rejects.toThrow(/Organization Owner/);
  });

  it("maps 401 to a status-carrying error", async () => {
    mockFetch({ [`GET ${O}/projects`]: new Response('{"message":"bad key"}', { status: 401 }) });
    const err = await new CapellaClient({ apiKey: "k", organizationId: "org-1" })
      .listResources(T.project, "acc")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CapellaApiError);
    expect((err as CapellaApiError).status).toBe(401);
  });

  it("lists organizations for the credential picker", async () => {
    mockFetch({ "GET /v4/organizations": { data: [{ id: "org-1", name: "Acme" }] } });
    expect(await plugin.listCredentialOptions!("organizationId", { apiKey: "k" })).toEqual([
      { id: "org-1", label: "Acme", description: "org-1" },
    ]);
  });
});

describe("status and terraform", () => {
  it("maps AWS components to regions and products to types", () => {
    expect(mapComponent("AWS ec2-us-east-1")).toMatchObject({ regions: ["us-east-1"] });
    expect(mapComponent("Couchbase Capella Management API")).toMatchObject({ providerWide: true });
    expect(mapComponent("Couchbase Capella App Services")!.resourceTypes).toEqual([T.appService]);
    expect(mapComponent("Capella Notifications")).toBeNull();
  });

  it("exports a bucket with the provider's key=value import id", () => {
    const r = createMockResource(
      "couchbase-capella",
      RESOURCE_TYPES.find((t) => t.id === T.bucket)!,
    );
    r.externalId = joinId("p1", "c1", "YjE=");
    r.fields = { name: "b1", memoryAllocationInMb: 100, replicas: "1", organizationId: "org-1" };
    const out = capellaTerraformExport.mapResource(r)!;
    expect(out.resource.importId).toBe("id=YjE=,cluster_id=c1,project_id=p1,organization_id=org-1");
    expect(out.resource.attributes["memory_allocation_in_mb"]).toEqual({
      kind: "number",
      value: 100,
    });
  });
});
