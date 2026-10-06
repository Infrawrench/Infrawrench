import { describe, expect, it } from "vitest";
import type { HostServices } from "@infrawrench/plugin-base";
import { statusOf, XataApiError } from "../api.js";
import { hostOf, pgDescriptor, projectPatch, withSsl, XataClient } from "../client.js";
import { coveredMonthStart, fetchXataCostData } from "../cost-data.js";
import { mapComponent } from "../status-feed.js";
import type { XProject } from "../api.js";

const ACCOUNT = "acct";
const API = "https://api.xata.tech";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
}
type Route = (call: Call) => { status: number; body: unknown } | undefined;

function fake(routes: Route[]) {
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
        return { status: 404, headers: {}, body: JSON.stringify({ message: "not found" }) };
      },
    },
  };
  return { client: new XataClient({ apiKey: "xau_k" }, services), calls };
}

const on =
  (method: string, url: string, body: unknown, status = 200): Route =>
  (call) => {
    const u = new URL(call.url);
    return call.method === method && `${u.origin}${u.pathname}` === url
      ? { status, body }
      : undefined;
  };

const org = {
  id: "org1",
  name: "Acme",
  status: {
    status: "enabled",
    disabled_by_admin: false,
    billing_status: "ok",
    usage_tier: "t2",
    last_updated: "",
  },
};
const project: XProject = {
  id: "p1",
  name: "app",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  configuration: {
    scaleToZero: {
      baseBranches: { enabled: false, inactivityPeriodMinutes: 30 },
      childBranches: { enabled: true, inactivityPeriodMinutes: 15 },
    },
    ipFiltering: { enabled: false, cidr: [] },
  },
};
const branch = {
  id: "b1",
  name: "main",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  region: "us-east-1",
  publicAccess: true,
  backupsEnabled: true,
  status: {
    status: "Cluster in healthy state",
    statusType: "STATUS_TYPE_HEALTHY",
    instanceCount: 1,
    instanceReadyCount: 1,
    instances: [],
  },
  connectionString: "postgresql://xata:secret@b1.us-east-1.xata.tech/xata",
  scaleToZero: { enabled: false, inactivityPeriodMinutes: 30 },
  configuration: {
    region: "us-east-1",
    instanceType: "xata.small",
    image: "postgres:17",
    replicas: 0,
    storage: 10,
  },
};
const B = `${API}/organizations/org1/projects/p1/branches/b1`;

describe("XataClient", () => {
  it("lists branches with detail, Bearer auth and composite ids", async () => {
    const { client, calls } = fake([
      on("GET", `${API}/organizations`, { organizations: [org] }),
      on("GET", `${API}/organizations/org1/projects`, { projects: [project] }),
      on("GET", `${API}/organizations/org1/projects/p1/branches`, { branches: [branch] }),
      on("GET", B, branch),
    ]);
    const [b] = await client.listResources("xata-branch", ACCOUNT);
    expect(b!.externalId).toBe("org1/p1/b1");
    expect(b!.fields).toMatchObject({
      instanceType: "xata.small",
      host: "b1.us-east-1.xata.tech",
      statusType: "STATUS_TYPE_HEALTHY",
    });
    expect(JSON.stringify(b!.fields)).not.toContain("secret");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer xau_k");
  });

  it("maps errors to a status", async () => {
    const { client } = fake([on("GET", `${API}/organizations`, { message: "denied" }, 403)]);
    const err = await client.listResources("xata-project", ACCOUNT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(XataApiError);
    expect(statusOf(err)).toBe(403);
  });

  it("runs SQL on the branch gateway with the connection string header", async () => {
    const creds = {
      username: "xata",
      password: "pw",
      hostname: "b1.us-east-1.xata.tech",
      port: 5432,
      dbname: "xata",
      connectionString: "postgresql://xata:pw@b1.us-east-1.xata.tech/xata",
    };
    const { client, calls } = fake([
      on("GET", `${B}/credentials`, creds),
      on("POST", "https://b1.us-east-1.xata.tech/sql", {
        rows: [{ n: 1 }],
        fields: [],
        command: "SELECT",
        rowCount: 1,
        rowAsArray: false,
      }),
    ]);
    const res = await client.executeQuery(
      `${ACCOUNT}:xata-branch:org1/p1/b1`,
      ACCOUNT,
      "select 1 as n",
    );
    expect(res.rows).toEqual([{ n: 1 }]);
    const sqlCall = calls.at(-1)!;
    expect(sqlCall.headers["Connection-String"]).toBe(creds.connectionString);
    expect(sqlCall.headers["Authorization"]).toBeUndefined();
    expect(
      await client.resolveOutput(
        "xata-branch",
        `${ACCOUNT}:xata-branch:org1/p1/b1`,
        "connectionString",
        ACCOUNT,
      ),
    ).toBe(`${creds.connectionString}?sslmode=require`);
  });

  it("hibernates by patching the branch", async () => {
    const { client, calls } = fake([on("PATCH", B, branch)]);
    await client.invokeAction(
      "xata-branch",
      `${ACCOUNT}:xata-branch:org1/p1/b1`,
      "hibernate",
      ACCOUNT,
    );
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ hibernate: true });
  });

  it("merges Postgres settings into the existing parameters", async () => {
    const { client, calls } = fake([
      on("GET", B, {
        ...branch,
        configuration: {
          ...branch.configuration,
          postgresConfigurationParameters: { work_mem: "4MB" },
        },
      }),
      on("PATCH", B, branch),
    ]);
    await client.applyManifest(
      `${ACCOUNT}:xata-branch:org1/p1/b1`,
      ACCOUNT,
      JSON.stringify([
        { id: "max_connections", value: "200" },
        { id: "work_mem", value: "" },
      ]),
    );
    expect(JSON.parse(String(calls.at(-1)!.body))).toEqual({
      postgresConfigurationParameters: { max_connections: "200" },
    });
  });
});

describe("helpers", () => {
  it("parses hosts and adds sslmode once", () => {
    expect(hostOf("postgresql://u:p@h.xata.tech:5432/db")).toBe("h.xata.tech");
    expect(withSsl("postgresql://h/db?sslmode=verify-full")).toBe(
      "postgresql://h/db?sslmode=verify-full",
    );
  });

  it("only sends the project settings that changed", () => {
    expect(projectPatch(project, { allowedCidrs: "10.0.0.0/8, 1.2.3.4" })).toEqual({
      configuration: {
        ipFiltering: { enabled: false, cidr: [{ cidr: "10.0.0.0/8" }, { cidr: "1.2.3.4" }] },
      },
    });
    expect(projectPatch(project, { name: "new" })).toEqual({ name: "new" });
  });

  it("dates invoices to the month they cover", () => {
    expect(coveredMonthStart("2026-10-01T00:00:00Z")).toBe("2026-09-01");
    const rows = fetchXataCostData(
      org as never,
      [
        {
          id: "1",
          invoice_number: "1",
          amount_due: 12.5,
          currency: "usd",
          invoice_date: "2026-09-01T00:00:00Z",
          status: "paid",
        },
        {
          id: "2",
          invoice_number: "2",
          amount_due: 99,
          currency: "usd",
          invoice_date: "2026-08-01T00:00:00Z",
          status: "void",
        },
      ],
      { total: 3.25, currency: "usd", target_date: "2026-11-01T00:00:00Z" },
      { fromDate: "2026-08-01", toDate: "2026-10-31" },
    );
    expect(rows.map((r) => [r.date, r.amount])).toEqual([
      ["2026-08-01", 12.5],
      ["2026-10-01", 3.25],
    ]);
  });

  it("renders Postgres parameters as settings rows", () => {
    expect(
      pgDescriptor({
        name: "log_lock_waits",
        type: "boolean",
        description: "Log long lock waits.",
        section: "Logging",
        defaultValue: "off",
        currentValue: "on",
      }),
    ).toMatchObject({ id: "log_lock_waits", control: "toggle", value: "on" });
  });

  it("maps connectivity components to both region spellings", () => {
    expect(mapComponent("Database connectivity (AWS us-east-1)")).toMatchObject({
      regions: ["us-east-1", "aws-us-east-1"],
    });
    expect(mapComponent("Management APIs")).toMatchObject({ providerWide: true });
  });
});
