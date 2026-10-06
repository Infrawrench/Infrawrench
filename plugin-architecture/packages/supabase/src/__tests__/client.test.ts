import { describe, expect, it } from "vitest";
import type { HostServices } from "@infrawrench/plugin-base";
import { SupabaseApiError, statusOf } from "../api.js";
import { poolerUrl, SupabaseClient } from "../client.js";
import { fetchSupabaseCostData } from "../cost-data.js";
import { networkIsOpen } from "../listers.js";
import { intervalFor, parsePrometheus } from "../observability.js";
import { authChangesBody, groupProjectChanges } from "../settings.js";
import { parseStatusFeed } from "../status-feed.js";
import { supabaseTerraformExport } from "../terraform.js";
import type { SbPooler } from "../types.js";

const REF = "abcdefghijklmnopqrst";
const ACCOUNT = "acct";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
}

type Route = (call: Call) => { status: number; body: unknown } | undefined;

function fakeServices(routes: Route[], secrets: Record<string, string> = {}) {
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
        for (const route of routes) {
          const res = route(call);
          if (res) {
            return {
              status: res.status,
              headers: {},
              body: typeof res.body === "string" ? res.body : JSON.stringify(res.body),
            };
          }
        }
        return { status: 404, headers: {}, body: JSON.stringify({ message: "not found" }) };
      },
    },
    secrets: {
      async getPlaintext(resourceId, field) {
        return secrets[`${resourceId}|${field}`] ?? null;
      },
      async setPlaintext(resourceId, field, value) {
        secrets[`${resourceId}|${field}`] = value;
      },
    },
  };
  return { services, calls, secrets };
}

const on =
  (method: string, path: string | RegExp, body: unknown, status = 200): Route =>
  (call) => {
    const url = new URL(call.url);
    const matches = typeof path === "string" ? url.pathname === path : path.test(url.pathname);
    return call.method === method && matches ? { status, body } : undefined;
  };

const project = {
  id: REF,
  ref: REF,
  organization_id: "org",
  organization_slug: "acme",
  name: "Prod",
  region: "eu-west-1",
  created_at: "2026-01-01T00:00:00Z",
  status: "ACTIVE_HEALTHY",
  database: {
    host: `db.${REF}.supabase.co`,
    version: "17.4",
    postgres_engine: "17",
    release_channel: "ga",
  },
};

function client(routes: Route[], secrets?: Record<string, string>) {
  const fake = fakeServices(routes, secrets);
  return { c: new SupabaseClient({ accessToken: "sbp_x" }, fake.services), ...fake };
}

describe("SupabaseClient", () => {
  it("sends the token as a Bearer header and maps errors to a status", async () => {
    const { c, calls } = client([on("GET", "/v1/projects", { message: "nope" }, 403)]);
    const err = await c.listResources("supabase-project", ACCOUNT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupabaseApiError);
    expect(statusOf(err)).toBe(403);
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer sbp_x");
    expect((err as Error).message).toContain("nope");
  });

  it("explains a rejected token", async () => {
    const { c } = client([on("GET", "/v1/projects", {}, 401)]);
    await expect(c.listResources("supabase-project", ACCOUNT)).rejects.toThrow(
      /access token was rejected/,
    );
  });

  it("lists projects enriched with security, pooler and org data", async () => {
    const { c } = client([
      on("GET", "/v1/projects", [project]),
      on("GET", "/v1/organizations/acme/projects", {
        projects: [
          {
            ref: REF,
            name: "Prod",
            cloud_provider: "AWS",
            region: "eu-west-1",
            is_branch: false,
            status: "ACTIVE_HEALTHY",
            inserted_at: "",
            databases: [
              {
                identifier: REF,
                type: "PRIMARY",
                region: "eu-west-1",
                status: "ACTIVE_HEALTHY",
                cloud_provider: "AWS",
                infra_compute_size: "small",
                disk_volume_size_gb: 8,
                disk_type: "gp3",
              },
              {
                identifier: `${REF}-rr-us-east-1-abc`,
                type: "READ_REPLICA",
                region: "us-east-1",
                status: "ACTIVE_HEALTHY",
                cloud_provider: "AWS",
              },
            ],
          },
        ],
        pagination: { count: 1, limit: 100, offset: 0 },
      }),
      on("GET", `/v1/projects/${REF}/ssl-enforcement`, {
        currentConfig: { database: false },
        appliedSuccessfully: true,
      }),
      on("GET", `/v1/projects/${REF}/network-restrictions`, {
        entitlement: "allowed",
        config: { dbAllowedCidrs: ["0.0.0.0/0"] },
        status: "applied",
      }),
      on("GET", `/v1/projects/${REF}/database/backups`, {
        region: "eu-west-1",
        walg_enabled: true,
        pitr_enabled: false,
        backups: [],
        physical_backup_data: {},
      }),
      on("GET", `/v1/projects/${REF}/config/database/pooler`, [
        {
          identifier: REF,
          database_type: "PRIMARY",
          pool_mode: "transaction",
          default_pool_size: 15,
        },
      ]),
      on("GET", `/v1/projects/${REF}/api-keys/legacy`, { enabled: true }),
      on("GET", `/v1/projects/${REF}/billing/addons`, {
        selected_addons: [{ type: "pitr", variant: { id: "pitr_7", name: "7 days" } }],
        available_addons: [],
      }),
    ]);
    const [p] = await c.listResources("supabase-project", ACCOUNT);
    expect(p!.id).toBe(`${ACCOUNT}:supabase-project:${REF}`);
    expect(p!.fields).toMatchObject({
      computeSize: "small",
      diskSizeGb: 8,
      sslEnforced: false,
      networkOpen: true,
      allowedCidrs: "0.0.0.0/0",
      poolMode: "transaction",
      poolSize: 15,
      legacyApiKeysEnabled: true,
      automatedBackups: true,
      pitrDays: "7",
      ipv4: false,
      readReplicaCount: 1,
    });

    const replicas = await c.listResources("supabase-read-replica", ACCOUNT);
    expect(replicas.map((r) => r.fields["region"])).toEqual(["us-east-1"]);
  });

  it("skips paused projects for service-backed child types", async () => {
    const { c, calls } = client([on("GET", "/v1/projects", [{ ...project, status: "INACTIVE" }])]);
    expect(await c.listResources("supabase-function", ACCOUNT)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("builds connection strings from the stored password and the pooler template", async () => {
    const id = `${ACCOUNT}:supabase-project:${REF}`;
    const { c } = client(
      [
        on("GET", `/v1/projects/${REF}`, project),
        on("GET", `/v1/projects/${REF}/config/database/pooler`, [
          {
            identifier: REF,
            database_type: "PRIMARY",
            connection_string: `postgresql://postgres.${REF}:[YOUR-PASSWORD]@aws-0-eu-west-1.pooler.supabase.com:6543/postgres`,
            db_user: `postgres.${REF}`,
            db_host: "aws-0-eu-west-1.pooler.supabase.com",
            db_port: 6543,
            db_name: "postgres",
          },
        ]),
      ],
      { [`${id}|dbPassword`]: "p@ss word" },
    );
    expect(await c.resolveOutput("supabase-project", id, "connectionString", ACCOUNT)).toBe(
      `postgresql://postgres:p%40ss%20word@db.${REF}.supabase.co:5432/postgres`,
    );
    expect(
      await c.resolveOutput("supabase-project", id, "sessionPoolerConnectionString", ACCOUNT),
    ).toBe(
      `postgresql://postgres.${REF}:p%40ss%20word@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`,
    );
  });

  it("explains the missing password and resets it on request", async () => {
    const id = `${ACCOUNT}:supabase-project:${REF}`;
    const { c, calls, secrets } = client([
      on("GET", `/v1/projects/${REF}`, project),
      on("PATCH", `/v1/projects/${REF}/database/password`, { message: "ok" }),
    ]);
    await expect(
      c.resolveOutput("supabase-project", id, "connectionString", ACCOUNT),
    ).rejects.toThrow(/Reset database password/);
    await c.invokeAction("supabase-project", id, "reset-db-password", ACCOUNT);
    const patch = calls.find((x) => x.method === "PATCH")!;
    const sent = JSON.parse(String(patch.body)) as { password: string };
    expect(sent.password).toHaveLength(32);
    expect(secrets[`${id}|dbPassword`]).toBe(sent.password);
  });

  it("deploys an Edge Function as multipart with the slug in the query", async () => {
    const { c, calls } = client([
      on("POST", `/v1/projects/${REF}/functions/deploy`, {
        id: "fn-1",
        slug: "hello",
        name: "hello",
        status: "ACTIVE",
        version: 1,
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
      }),
    ]);
    const created = await c.createResource(
      "supabase-function",
      ACCOUNT,
      { slug: "hello", code: "Deno.serve(() => new Response('hi'))", verifyJwt: "false" },
      `${ACCOUNT}:supabase-project:${REF}`,
    );
    const call = calls[0]!;
    expect(new URL(call.url).searchParams.get("slug")).toBe("hello");
    expect(call.headers["Content-Type"]).toMatch(/^multipart\/form-data; boundary=/);
    const text = new TextDecoder().decode(call.body as Uint8Array);
    expect(text).toContain('"verify_jwt":false');
    expect(text).toContain("Deno.serve");
    expect("resource" in created ? created.resource.id : created.id).toBe(
      `${ACCOUNT}:supabase-function:${REF}/hello`,
    );
  });

  it("talks to the Storage API with a secret key in the apikey header only", async () => {
    const { c, calls } = client([
      on("GET", `/v1/projects/${REF}/api-keys`, [
        { name: "default", type: "secret", api_key: "sb_secret_abc", id: "k1" },
      ]),
      (call) =>
        call.url === `https://${REF}.supabase.co/storage/v1/object/list/avatars`
          ? {
              status: 200,
              body: [
                { name: "folder", id: null },
                {
                  name: "a.png",
                  id: "1",
                  updated_at: "2026-01-01",
                  metadata: { size: 10, mimetype: "image/png" },
                },
                { name: ".emptyFolderPlaceholder", id: "2" },
              ],
            }
          : undefined,
    ]);
    const objects = await c.listStorageObjects(`${REF}/avatars`, "");
    expect(objects.map((o) => o.key)).toEqual(["folder/", "a.png"]);
    const storageCall = calls.find((x) => x.url.includes("/storage/v1/"))!;
    expect(storageCall.headers["apikey"]).toBe("sb_secret_abc");
    expect(storageCall.headers["Authorization"]).toBeUndefined();
  });

  it("routes settings-editor changes to the right config endpoints", async () => {
    const { c, calls } = client([
      on("PUT", `/v1/projects/${REF}/config/database/postgres`, {}),
      on("PATCH", `/v1/projects/${REF}/config/storage`, {}),
    ]);
    await c.applyManifest(
      `${ACCOUNT}:supabase-project:${REF}`,
      ACCOUNT,
      JSON.stringify([
        { id: "postgres.max_connections", value: "120" },
        { id: "storage.features.s3Protocol.enabled", value: "on" },
      ]),
    );
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ max_connections: 120 });
    expect(JSON.parse(String(calls[1]!.body))).toEqual({
      features: { s3Protocol: { enabled: true } },
    });
  });
});

describe("helpers", () => {
  it("groups settings and rejects unknown ids", () => {
    expect(
      groupProjectChanges([{ id: "pooler.pool_mode", value: "session" }]).get("pooler"),
    ).toEqual({
      pool_mode: "session",
    });
    expect(() => groupProjectChanges([{ id: "postgres.shared_buffers", value: "1" }])).toThrow();
    expect(authChangesBody([{ id: "disable_signup", value: "on" }])).toEqual({
      disable_signup: true,
    });
  });

  it("reads network restrictions", () => {
    expect(networkIsOpen({ entitlement: "allowed", config: {}, status: "applied" })).toBe(true);
    expect(
      networkIsOpen({
        entitlement: "allowed",
        config: { dbAllowedCidrs: ["10.0.0.0/8"] },
        status: "applied",
      }),
    ).toBe(false);
  });

  it("picks the smallest analytics window that covers the range", () => {
    expect(intervalFor(10 * 60_000)).toBe("15min");
    expect(intervalFor(24 * 3_600_000)).toBe("1day");
    expect(intervalFor(30 * 24 * 3_600_000)).toBe("7day");
  });

  it("parses Prometheus text", () => {
    const samples = parsePrometheus(
      '# HELP x\nnode_load1 0.5\npg_stat_database_num_backends{datname="postgres"} 7 1700000000\n',
    );
    expect(samples).toEqual([
      { name: "node_load1", labels: {}, value: 0.5 },
      { name: "pg_stat_database_num_backends", labels: { datname: "postgres" }, value: 7 },
    ]);
  });

  it("substitutes the pooler password placeholder", () => {
    const pooler = {
      connection_string: "postgresql://u:[YOUR-PASSWORD]@h:6543/postgres",
    } as SbPooler;
    expect(poolerUrl(pooler, "x/y", false)).toBe("postgresql://u:x%2Fy@h:6543/postgres");
  });

  it("estimates today's add-on spend only", async () => {
    const { services } = fakeServices([
      on("GET", `/v1/projects/${REF}/billing/addons`, {
        selected_addons: [
          {
            type: "compute_instance",
            variant: {
              id: "ci_small",
              name: "Small",
              price: { description: "", type: "fixed", interval: "hourly", amount: 0.0206 },
            },
          },
          {
            type: "pitr",
            variant: {
              id: "pitr_7",
              name: "7 days",
              price: { description: "", type: "fixed", interval: "monthly", amount: 100 },
            },
          },
        ],
        available_addons: [],
      }),
    ]);
    const ctx = { token: "t", http: services.http! };
    const now = new Date("2026-10-06T12:00:00Z");
    const rows = await fetchSupabaseCostData(
      ctx,
      [project],
      { fromDate: "2026-10-01", toDate: "2026-10-06" },
      now,
    );
    expect(rows.map((r) => [r.service, r.amount])).toEqual([
      ["Compute", 0.4944],
      ["Point-in-Time Recovery", Math.round((100 / 31) * 1e6) / 1e6],
    ]);
    expect(
      await fetchSupabaseCostData(
        ctx,
        [project],
        { fromDate: "2026-09-01", toDate: "2026-09-30" },
        now,
      ),
    ).toEqual([]);
  });

  it("maps region components of the status page onto project regions", () => {
    const incidents = parseStatusFeed(
      JSON.stringify({
        incidents: [
          {
            id: "i1",
            name: "Degraded database",
            status: "investigating",
            impact: "minor",
            created_at: "2026-10-06T00:00:00Z",
            updated_at: "2026-10-06T00:00:00Z",
            shortlink: "https://stspg.io/x",
            components: [{ name: "eu-west-1" }, { name: "Database" }],
            incident_updates: [],
          },
        ],
      }),
    );
    expect(incidents[0]!.regions).toEqual(["eu-west-1"]);
    expect(incidents[0]!.resourceTypes).toContain("supabase-project");
  });

  it("exports projects to Terraform with a password variable", () => {
    const result = supabaseTerraformExport.mapResource({
      id: `${ACCOUNT}:supabase-project:${REF}`,
      pluginId: "supabase",
      resourceTypeId: "supabase-project",
      accountId: ACCOUNT,
      displayName: "Prod",
      fields: {
        ref: REF,
        name: "Prod",
        organizationSlug: "acme",
        region: "eu-west-1",
        computeSize: "small",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: REF,
      createdAt: "",
      updatedAt: "",
    });
    expect(result?.resource.type).toBe("supabase_project");
    expect(result?.resource.importId).toBe(REF);
    expect(result?.variables?.[0]?.sensitive).toBe(true);
  });
});
