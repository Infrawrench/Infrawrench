import { describe, expect, it } from "vitest";
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
type Route = (call: Call) => { status: number; body: unknown } | undefined;

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
          if (res) return { status: res.status, headers: {}, body: JSON.stringify(res.body) };
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
  return { client: new CockroachClient({ apiKey: "CCDB1_k" }, services), calls, secrets };
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
  regions: [{ name: "us-east-1", node_count: 3, sql_dns: "x", ui_dns: "y", internal_dns: "z" }],
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
          cluster: {
            id: "c1",
            name: "prod-db",
            regions: cluster.regions,
            cloud_provider: "AWS",
            plan: "ADVANCED",
          },
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
