import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostServices } from "@infrawrench/plugin-base";
import { CC_VERSION, CrdbApiError, statusOf } from "../api.js";
import type { CCluster, CInvoice } from "../api.js";
import {
  clusterCreateBody,
  CockroachClient,
  durationHours,
  hoursDuration,
  parseCidr,
  portable,
  withPassword,
} from "../client.js";
import { invoicesToCostRows } from "../cost-data.js";
import { cockroachTerraformExport } from "../terraform.js";

const ACCOUNT = "acct";
const API = "https://cockroachlabs.cloud";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
}
type Route = (call: Call) => { status: number; body: unknown; raw?: string } | undefined;

function fake(routes: Route[], secrets: Record<string, string> = {}) {
  const calls: Call[] = [];
  const services: HostServices = {
    http: {
      async request(req) {
        const call: Call = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          ...(req.body !== undefined ? { body: req.body } : {}),
        };
        calls.push(call);
        for (const r of routes) {
          const res = r(call);
          if (res) {
            return { status: res.status, headers: {}, body: res.raw ?? JSON.stringify(res.body) };
          }
        }
        return {
          status: 404,
          headers: {},
          body: JSON.stringify({ code: 5, message: "not found" }),
        };
      },
    },
    secrets: {
      async getPlaintext(id, field) {
        return secrets[`${id}|${field}`] ?? null;
      },
      async setPlaintext(id, field, value) {
        secrets[`${id}|${field}`] = value;
      },
    },
  };
  return {
    client: hostClient(new CockroachClient({ apiKey: "CCDB1_k" }, services)),
    calls,
    secrets,
  };
}

const on =
  (method: string, path: string, body: unknown, status = 200): Route =>
  (call) => {
    const u = new URL(call.url);
    return call.method === method && u.pathname === path ? { status, body } : undefined;
  };

const cluster: CCluster = {
  id: "c1",
  name: "prod-db",
  cloud_provider: "AWS",
  cockroach_version: "v25.2.1",
  plan: "ADVANCED",
  state: "CREATED",
  operation_status: "UNSPECIFIED",
  upgrade_status: "FINALIZED",
  delete_protection: "DISABLED",
  sql_dns: "prod-db.aws-us-east-1.cockroachlabs.cloud",
  cidr_range: "172.28.0.0/14",
  creator_id: "u1",
  labels: {},
  regions: [
    {
      name: "us-east-1",
      node_count: 3,
      sql_dns: "x",
      ui_dns: "y",
      internal_dns: "z",
      private_endpoint_dns: "p",
    },
  ],
  config: {
    dedicated: {
      machine_type: "m6i.xlarge",
      num_virtual_cpus: 4,
      storage_gib: 150,
      memory_gib: 16,
      disk_iops: 3000,
    },
  },
};

describe("CockroachClient", () => {
  it("pages with pagination.page and pins Cc-Version", async () => {
    const { client, calls } = fake([
      (call) => {
        const u = new URL(call.url);
        if (u.pathname !== "/api/v1/clusters") return undefined;
        return u.searchParams.get("pagination.page") === "p2"
          ? { status: 200, body: { clusters: [{ ...cluster, id: "c2", name: "second" }] } }
          : { status: 200, body: { clusters: [cluster], pagination: { next_page: "p2" } } };
      },
    ]);
    const clusters = await client.clusters();
    expect(clusters.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer CCDB1_k");
    expect(calls[0]!.headers["Cc-Version"]).toBe(CC_VERSION);
  });

  it("maps errors to a status", async () => {
    const { client } = fake([on("GET", "/api/v1/clusters", { code: 7, message: "denied" }, 403)]);
    const err = await client.listResources("crdb-cluster", ACCOUNT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrdbApiError);
    expect(statusOf(err)).toBe(403);
  });

  it("enriches clusters with backups, deferral, maintenance and allowlist", async () => {
    const { client } = fake([
      on("GET", "/api/v1/clusters", { clusters: [cluster] }),
      on("GET", "/api/v1/clusters/c1/backups-config", {
        enabled: true,
        frequency_minutes: 60,
        retention_days: 30,
      }),
      on("GET", "/api/v1/clusters/c1/version-deferral", { deferral_policy: "DEFERRAL_30_DAYS" }),
      on("GET", "/api/v1/clusters/c1/maintenance-window", {
        offset_duration: "172800s",
        window_duration: "21600s",
      }),
      on("GET", "/api/v1/clusters/c1/cmek", { status: "DISABLED" }),
      on("GET", "/api/v1/clusters/c1/networking/allowlist", {
        allowlist: [{ cidr_ip: "0.0.0.0", cidr_mask: 0, sql: true, ui: false }],
        propagating: false,
      }),
    ]);
    const [c] = await client.listResources("crdb-cluster", ACCOUNT);
    expect(c!.fields).toMatchObject({
      plan: "ADVANCED",
      vcpus: 4,
      nodeCount: 3,
      backupsEnabled: true,
      backupFrequencyMinutes: "60",
      deferralPolicy: "DEFERRAL_30_DAYS",
      maintenanceOffsetHours: 48,
      maintenanceDurationHours: 6,
      allowlistOpen: true,
      deleteProtection: false,
    });
  });

  it("creates a SQL user, stores the password, and builds its connection string", async () => {
    const { client, secrets } = fake([
      on("POST", "/api/v1/clusters/c1/sql-users", { name: "app" }),
      on("GET", "/api/v1/clusters/c1/connection-string", {
        connection_string:
          "postgresql://app@prod-db.aws-us-east-1.cockroachlabs.cloud:26257/defaultdb?sslmode=verify-full&sslrootcert=$HOME/.postgresql/root.crt",
        params: {},
      }),
    ]);
    const created = await client.createResource(
      "crdb-sql-user",
      ACCOUNT,
      { name: "app", password: "p w" },
      `${ACCOUNT}:crdb-cluster:c1`,
    );
    const resource = "resource" in created ? created.resource : created;
    expect(secrets[`${resource.id}|password`]).toBe("p w");
    expect(
      await client.resolveOutput("crdb-sql-user", resource.id, "connectionString", ACCOUNT),
    ).toBe(
      "postgresql://app:p%20w@prod-db.aws-us-east-1.cockroachlabs.cloud:26257/defaultdb?sslmode=require",
    );
  });

  it("scales an Advanced cluster through dedicated hardware and region nodes", async () => {
    const { client, calls } = fake([
      on("GET", "/api/v1/clusters/c1", cluster),
      on("PATCH", "/api/v1/clusters/c1", cluster),
      on("GET", "/api/v1/clusters", { clusters: [cluster] }),
    ]);
    await client
      .updateResource("crdb-cluster", `${ACCOUNT}:crdb-cluster:c1`, ACCOUNT, {
        vcpus: "8",
        nodeCount: "5",
      })
      .catch(() => undefined);
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(JSON.parse(String(patch.body))).toEqual({
      dedicated: {
        hardware: { machine_spec: { num_virtual_cpus: 8 } },
        region_nodes: { "us-east-1": 5 },
      },
    });
  });

  it("encodes the cluster id in the credential check", async () => {
    const { client, calls } = fake([
      on("GET", "/api/v1/clusters", { clusters: [{ ...cluster, id: "c/1?x" }] }),
    ]);
    await client.verifyCredentials();
    const probe = calls.find((c) => c.url.includes("sql-users"))!;
    expect(new URL(probe.url).pathname).toBe("/api/v1/clusters/c%2F1%3Fx/sql-users");
  });

  it("scales a host cluster through its own part of the update", async () => {
    const hosted: CCluster = { ...cluster, config: { host: cluster.config.dedicated! } };
    const { client, calls } = fake([
      on("GET", "/api/v1/clusters/c1", hosted),
      on("PATCH", "/api/v1/clusters/c1", hosted),
    ]);
    await client
      .updateResource("crdb-cluster", `${ACCOUNT}:crdb-cluster:c1`, ACCOUNT, {
        vcpus: "8",
        storageGib: "300",
        diskIops: "6000",
        nodeCount: "5",
      })
      .catch(() => undefined);
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(JSON.parse(String(patch.body))).toEqual({
      host: {
        hardware: {
          machine_spec: { num_virtual_cpus: 8 },
          storage_gib: 300,
          disk_iops: 6000,
        },
        region_nodes: { "us-east-1": 5 },
      },
    });
  });

  describe("the lists whose key the document does not require", () => {
    const blackout = (id: string) => ({
      id,
      start_time: "2026-12-01T00:00:00Z",
      end_time: "2026-12-05T00:00:00Z",
    });
    const rule = (id: string) => ({
      id,
      name: id,
      type: "FQDN",
      destination: "example.com",
      state: "ACTIVE",
    });
    const paged =
      (path: string, key: string, row: (id: string) => object): Route =>
      (call) => {
        const u = new URL(call.url);
        if (u.pathname !== path) return undefined;
        return u.searchParams.get("pagination.page") === "p2"
          ? { status: 200, body: { [key]: [row("second")] } }
          : { status: 200, body: { [key]: [row("first")], pagination: { next_page: "p2" } } };
      };

    it.each([
      ["crdb-blackout-window", "blackout-windows", "blackout_windows", blackout],
      ["crdb-egress-rule", "networking/egress-rules", "rules", rule],
    ] as const)("%s walks every page", async (typeId, route, key, row) => {
      const { client, calls } = fake([
        on("GET", "/api/v1/clusters", { clusters: [cluster] }),
        paged(`/api/v1/clusters/c1/${route}`, key, row),
      ]);
      const rows = await client.listResources(typeId, ACCOUNT);
      expect(rows.map((r) => r.externalId)).toEqual(["c1/first", "c1/second"]);
      const first = calls.find((c) => c.url.includes(route))!;
      expect(new URL(first.url).searchParams.get("pagination.limit")).toBe("200");
    });

    it.each([
      ["crdb-blackout-window", "blackout-windows"],
      ["crdb-egress-rule", "networking/egress-rules"],
    ] as const)("%s reads a left out key as none", async (typeId, route) => {
      const { client } = fake([
        on("GET", "/api/v1/clusters", { clusters: [cluster] }),
        on("GET", `/api/v1/clusters/c1/${route}`, {}),
      ]);
      expect(await client.listResources(typeId, ACCOUNT)).toEqual([]);
    });
  });

  describe("invoices", () => {
    const invoice: CInvoice = {
      invoice_id: "i1",
      period_start: "2026-09-01T00:00:00Z",
      period_end: "2026-10-01T00:00:00Z",
      status: "FINALIZED",
      totals: [],
      balances: [],
      adjustments: [{ name: "Credit", amount: { amount: -5, currency: "USD" } }],
      invoice_items: [],
    };
    const range = { fromDate: "2026-09-15", toDate: "2026-09-30" };

    it("sends cost sync only the documented filters", async () => {
      const { client, calls } = fake([on("GET", "/api/v1/invoices", { invoices: [invoice] })]);
      const rows = await client.fetchCostData(ACCOUNT, range);
      expect(rows.map((r) => r.amount)).toEqual([-5]);
      expect(calls).toHaveLength(1);
      expect([...new URL(calls[0]!.url).searchParams.keys()]).toEqual(["start_time"]);
      expect(new URL(calls[0]!.url).searchParams.get("start_time")).toBe("2026-09-01T00:00:00Z");
    });

    it("sends the organization detail no paging either", async () => {
      const { client, calls } = fake([on("GET", "/api/v1/invoices", { invoices: [invoice] })]);
      const org = {
        id: "o",
        pluginId: "cockroachdb-cloud",
        resourceTypeId: "crdb-organization",
        accountId: ACCOUNT,
        displayName: "o",
        fields: {},
        resolvedOutputs: {},
        secretStates: [],
        createdAt: "",
        updatedAt: "",
      };
      const enriched = await client.enrichDetail(org);
      expect(String(enriched.fields["_latestInvoice"])).toContain("2026-09-01");
      expect(new URL(calls[0]!.url).search).toBe("");
    });

    it("fails rather than read one page as all of them, if the route ever pages", async () => {
      const { client, calls } = fake([
        on("GET", "/api/v1/invoices", {
          invoices: [invoice],
          pagination: { next_page: "p2" },
        }),
      ]);
      await expect(client.fetchCostData(ACCOUNT, range)).rejects.toThrow(
        "has more than Infrawrench reads",
      );
      expect(calls).toHaveLength(1);
    });

    it("fails a cost read whose body has no invoices", async () => {
      const { client } = fake([on("GET", "/api/v1/invoices", { items: [] })]);
      await expect(client.fetchCostData(ACCOUNT, range)).rejects.toThrow("is not a list");
    });

    it("tests billing access with a bounded read and no paging", async () => {
      const { client, calls } = fake([
        on("GET", "/api/v1/clusters", { clusters: [] }),
        on("GET", "/api/v1/invoices", { invoices: [] }),
        on("GET", "/api/v1/service-accounts", { service_accounts: [] }),
      ]);
      const { checks } = await client.verifyCredentials();
      expect(checks.find((c) => c.capabilityId === "costs")?.status).toBe("ok");
      const query = new URL(calls.find((c) => c.url.includes("invoices"))!.url).searchParams;
      expect([...query.keys()]).toEqual(["start_time"]);
      expect(query.get("start_time")).toMatch(/^\d{4}-\d{2}-01T00:00:00Z$/);
    });
  });

  describe("pages that are not lists", () => {
    const raw =
      (path: string, text: string, status = 200): Route =>
      (call) =>
        new URL(call.url).pathname === path ? { status, body: null, raw: text } : undefined;

    it.each([
      ["a renamed key", '{"cluster_list":[]}'],
      ["a key left out", "{}"],
      ["a null key", '{"clusters":null}'],
    ])("fails on %s", async (_name, text) => {
      const { client } = fake([raw("/api/v1/clusters", text)]);
      await expect(client.listResources("crdb-cluster", ACCOUNT)).rejects.toThrow("is not a list");
    });

    it("fails on a later page too", async () => {
      const { client } = fake([
        (call) => {
          const u = new URL(call.url);
          if (u.pathname !== "/api/v1/folders") return undefined;
          return u.searchParams.get("pagination.page") === "p2"
            ? { status: 200, body: { renamed: [] } }
            : { status: 200, body: { folders: [], pagination: { next_page: "p2" } } };
        },
      ]);
      await expect(client.listResources("crdb-folder", ACCOUNT)).rejects.toThrow("is not a list");
    });

    it("fails on an empty body", async () => {
      const { client } = fake([raw("/api/v1/folders", "")]);
      await expect(client.listResources("crdb-folder", ACCOUNT)).rejects.toThrow("is not a list");
    });

    it("fails on a body that is not JSON, even where a left out key reads as none", async () => {
      const folders = fake([raw("/api/v1/folders", "<html>upstream</html>")]);
      await expect(folders.client.listResources("crdb-folder", ACCOUNT)).rejects.toThrow(
        "not JSON",
      );
      const rules = fake([
        on("GET", "/api/v1/clusters", { clusters: [cluster] }),
        raw("/api/v1/clusters/c1/networking/egress-rules", "<html>upstream</html>"),
      ]);
      await expect(rules.client.listResources("crdb-egress-rule", ACCOUNT)).rejects.toThrow(
        "not JSON",
      );
    });

    it("still takes a write answered with something that is not JSON", async () => {
      const { client } = fake([raw("/api/v1/clusters/c1/metricexport/prometheus", "accepted")]);
      await expect(
        client.invokeAction(
          "crdb-cluster",
          `${ACCOUNT}:crdb-cluster:c1`,
          "enable-prometheus",
          ACCOUNT,
        ),
      ).resolves.toBeUndefined();
    });
  });

  it("keeps walking past an empty page that names another", async () => {
    const { client } = fake([
      (call) => {
        const u = new URL(call.url);
        if (u.pathname !== "/api/v1/folders") return undefined;
        return u.searchParams.get("pagination.page") === "p2"
          ? { status: 200, body: { folders: [{ resource_id: "f", name: "f", parent_id: "root" }] } }
          : { status: 200, body: { folders: [], pagination: { next_page: "p2" } } };
      },
    ]);
    const rows = await client.listResources("crdb-folder", ACCOUNT);
    expect(rows.map((r) => r.externalId)).toEqual(["f"]);
  });

  describe("metric exports", () => {
    const type = "crdb-metric-export";
    const datadog = "/api/v1/clusters/c1/metricexport/datadog";
    const prometheus = "/api/v1/clusters/c1/metricexport/prometheus";
    const clusters = on("GET", "/api/v1/clusters", { clusters: [cluster] });

    it.each([429, 500, 401])("fails the type when a read answers %i", async (status) => {
      const { client } = fake([
        clusters,
        on("GET", datadog, { code: 8, message: "no" }, status),
        on("GET", prometheus, { status: "ENABLED", targets: {} }),
      ]);
      await expect(client.listResources(type, ACCOUNT)).rejects.toThrow(CrdbApiError);
    });

    it.each([400, 403, 404])("reads %i as no export of that kind", async (status) => {
      const { client } = fake([
        clusters,
        on("GET", datadog, { code: 5, message: "no" }, status),
        on("GET", prometheus, { status: "ENABLED", targets: {} }),
      ]);
      const rows = await client.listResources(type, ACCOUNT);
      expect(rows.map((r) => r.externalId)).toEqual(["c1/prometheus"]);
    });
  });

  describe("lists that cannot say they are complete", () => {
    const endless: Route = (call) =>
      new URL(call.url).pathname === "/api/v1/clusters/c1/databases"
        ? { status: 200, body: { databases: [], pagination: { next_page: "more" } } }
        : undefined;

    it("rejects a list that never ends, after exactly the page cap", async () => {
      const { client, calls } = fake([
        on("GET", "/api/v1/clusters", { clusters: [cluster] }),
        endless,
      ]);
      await expect(client.listResources("crdb-database", ACCOUNT)).rejects.toThrow(
        "has more than Infrawrench reads",
      );
      expect(calls.filter((c) => c.url.includes("/databases"))).toHaveLength(100);
    });

    it("reaches the caller through the service account lookup on API keys", async () => {
      const { client } = fake([
        on("GET", "/api/v1/api-keys", { api_keys: [] }),
        on("GET", "/api/v1/service-accounts", { renamed: [] }),
      ]);
      await expect(client.listResources("crdb-api-key", ACCOUNT)).rejects.toThrow("is not a list");
    });

    it("still lists API keys when the service accounts are off limits", async () => {
      const { client } = fake([
        on("GET", "/api/v1/api-keys", {
          api_keys: [{ id: "k", name: "k", service_account_id: "s", created_at: "" }],
        }),
        on("GET", "/api/v1/service-accounts", { code: 7, message: "denied" }, 403),
      ]);
      const rows = await client.listResources("crdb-api-key", ACCOUNT);
      expect(rows.map((r) => r.externalId)).toEqual(["k"]);
    });

    it("reaches the caller through the allowlist read on a cluster", async () => {
      const { client } = fake([
        on("GET", "/api/v1/clusters", { clusters: [cluster] }),
        on("GET", "/api/v1/clusters/c1/networking/allowlist", { renamed: [] }),
      ]);
      await expect(client.listResources("crdb-cluster", ACCOUNT)).rejects.toThrow("is not a list");
    });

    it("still lists a cluster when its allowlist is off limits", async () => {
      const { client } = fake([
        on("GET", "/api/v1/clusters", { clusters: [cluster] }),
        on("GET", "/api/v1/clusters/c1/networking/allowlist", { code: 7, message: "no" }, 403),
      ]);
      const [row] = await client.listResources("crdb-cluster", ACCOUNT);
      expect(row!.fields["allowlistOpen"]).toBeUndefined();
    });
  });

  describe("transport", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const noFetch = () => {
      const stub = vi.fn(() => {
        throw new Error("unexpected fetch");
      });
      vi.stubGlobal("fetch", stub);
      return stub;
    };

    const hostAnswering = () =>
      vi.fn<NonNullable<HostServices["http"]>["request"]>(async () => ({
        status: 200,
        headers: {},
        body: JSON.stringify({ folders: [] }),
      }));

    it("goes through the host with no CA, and never fetch", async () => {
      const stub = noFetch();
      const request = hostAnswering();
      const client = hostClient(new CockroachClient({ apiKey: "CCDB1_k" }, { http: { request } }));
      await client.listResources("crdb-folder", ACCOUNT);
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0]![0]).not.toHaveProperty("caCert");
      expect(stub).not.toHaveBeenCalled();
    });

    it("hands the host a CA when one is set", async () => {
      noFetch();
      const request = hostAnswering();
      const client = hostClient(
        new CockroachClient({ apiKey: "CCDB1_k", caCert: "PEM" }, { http: { request } }),
      );
      await client.listResources("crdb-folder", ACCOUNT);
      expect(request.mock.calls[0]![0]).toHaveProperty("caCert", "PEM");
    });

    it("uses fetch only with no host", async () => {
      const stub = vi.fn(async () => new Response(JSON.stringify({ folders: [] })));
      vi.stubGlobal("fetch", stub);
      const client = hostClient(new CockroachClient({ apiKey: "CCDB1_k" }));
      await client.listResources("crdb-folder", ACCOUNT);
      expect(stub).toHaveBeenCalledTimes(1);
    });
  });
});

describe("helpers", () => {
  it("parses CIDRs and durations", () => {
    expect(parseCidr("10.0.0.0/8")).toEqual(["10.0.0.0", 8]);
    expect(parseCidr("1.2.3.4")).toEqual(["1.2.3.4", 32]);
    expect(() => parseCidr("1.2.3.4/40")).toThrow();
    expect(durationHours("21600s")).toBe(6);
    expect(hoursDuration(1.5)).toBe("5400s");
  });

  it("makes connection strings portable and inserts passwords", () => {
    expect(portable("postgresql://u@h:26257/db?sslmode=verify-full")).toBe(
      "postgresql://u@h:26257/db?sslmode=verify-full",
    );
    expect(withPassword("postgresql://h:26257/db", "u", "x")).toBe("postgresql://u:x@h:26257/db");
  });

  it("builds create bodies per plan", () => {
    expect(
      clusterCreateBody({
        name: "my-basic",
        plan: "BASIC",
        regions: '["us-east-1"]',
        closedAllowlist: "true",
      }),
    ).toEqual({
      name: "my-basic",
      provider: "AWS",
      spec: {
        plan: "BASIC",
        serverless: { regions: ["us-east-1"], with_empty_ip_allowlist: true },
      },
    });
    expect(
      clusterCreateBody({
        name: "my-adv",
        plan: "ADVANCED",
        regions: "us-east-1",
        vcpus: "8",
        nodeCount: "3",
        provider: "GCP",
      }).spec,
    ).toMatchObject({
      dedicated: {
        region_nodes: { "us-east-1": 3 },
        hardware: { machine_spec: { num_virtual_cpus: 8 }, storage_gib: 0 },
      },
    });
  });

  it("turns invoice line items into period-native rows and skips credits currency", () => {
    const invoice: CInvoice = {
      invoice_id: "i1",
      period_start: "2026-09-01T00:00:00Z",
      period_end: "2026-10-01T00:00:00Z",
      status: "FINALIZED",
      totals: [],
      balances: [],
      adjustments: [{ name: "Free credit", amount: { amount: -15, currency: "USD" } }],
      invoice_items: [
        {
          cluster,
          totals: [],
          line_items: [
            {
              description: "Compute",
              quantity: 720,
              quantity_unit: "HOURS",
              unit_cost: 0.5,
              total: { amount: 360, currency: "USD" },
            },
            {
              description: "Storage",
              quantity: 100,
              quantity_unit: "GIB",
              unit_cost: 1,
              total: { amount: 100, currency: "CRDB_CLOUD_CREDITS" },
            },
          ],
        },
      ],
    };
    const rows = invoicesToCostRows([invoice], { fromDate: "2026-09-01", toDate: "2026-09-30" });
    expect(rows.map((r) => [r.date, r.service, r.amount, r.chargeType])).toEqual([
      ["2026-09-01", "Compute", 360, "usage"],
      ["2026-09-01", "Free credit", -15, "credit"],
    ]);
  });

  it("exports clusters and allowlists to the cockroach provider", () => {
    const base = {
      pluginId: "cockroachdb-cloud",
      accountId: ACCOUNT,
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    };
    const c = cockroachTerraformExport.mapResource({
      ...base,
      id: "x",
      resourceTypeId: "crdb-cluster",
      displayName: "prod-db",
      externalId: "c1",
      fields: {
        name: "prod-db",
        plan: "ADVANCED",
        cloudProvider: "AWS",
        regions: "us-east-1",
        nodeCount: 3,
        vcpus: 4,
      },
    });
    expect(c?.resource.type).toBe("cockroach_cluster");
    expect(c?.resource.importId).toBe("c1");
    const a = cockroachTerraformExport.mapResource({
      ...base,
      id: "y",
      resourceTypeId: "crdb-allowlist-entry",
      displayName: "office",
      externalId: "c1/1.2.3.4/32",
      fields: { cidr: "1.2.3.4/32", clusterId: "c1", sql: true, ui: false, name: "office" },
    });
    expect(a?.resource.importId).toBe("c1:1.2.3.4/32");
  });
});
