import { hostClient } from "@infrawrench/plugin-base/effect";
import { describe, expect, it } from "vitest";
import type { HostServices } from "@infrawrench/plugin-base";
import { statusOf, XataApiError } from "../api.js";
import { hostOf, pgDescriptor, projectPatch, withSsl, XataClient } from "../client.js";
import { coveredMonthStart, fetchXataCostData } from "../cost-data.js";
import { renderDetail } from "../render.js";
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
  return { client: hostClient(new XataClient({ apiKey: "xau_k" }, services)), calls };
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
          invoice_pdf: null,
        },
        {
          id: "2",
          invoice_number: "2",
          amount_due: 99,
          currency: "usd",
          invoice_date: "2026-08-01T00:00:00Z",
          status: "void",
          invoice_pdf: null,
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
        defaultValueSource: "postgres",
        documentationLink: "https://example.test/log_lock_waits",
        recommendation: "",
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

describe("verifyCredentials", () => {
  it("encodes every id it writes into a path", async () => {
    const O = `${API}/organizations/o%2F1`;
    const P = `${O}/projects/p%3F1`;
    const credentials = `${P}/branches/b%231/credentials`;
    const { client, calls } = fake([
      on("GET", `${API}/organizations`, { organizations: [{ ...org, id: "o/1" }] }),
      on("GET", `${O}/projects`, { projects: [{ ...project, id: "p?1" }] }),
      on("GET", `${P}/branches`, { branches: [{ ...branch, id: "b#1" }] }),
      on("GET", credentials, {}),
      on("POST", `${P}/branches/b%231/metrics`, {}),
      on("GET", `${O}/api-keys`, { keys: [] }),
    ]);
    const { checks } = await client.verifyCredentials();
    expect(checks.map((c) => c.status)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(calls.map((c) => new URL(c.url).pathname + new URL(c.url).search)).toEqual(
      expect.arrayContaining([
        "/organizations/o%2F1/api-keys",
        "/organizations/o%2F1/projects/p%3F1/branches/b%231/credentials",
        "/organizations/o%2F1/projects/p%3F1/branches/b%231/metrics",
      ]),
    );
  });
});

describe("renderDetail", () => {
  it("encodes the ids in the console link", () => {
    const schema = renderDetail({
      id: `${ACCOUNT}:xata-branch:o 1/p?1/b#1`,
      pluginId: "xata",
      resourceTypeId: "xata-branch",
      accountId: ACCOUNT,
      displayName: "main",
      fields: {},
      resolvedOutputs: {},
      secretStates: [],
      externalId: "o 1/p?1/b#1",
      createdAt: "",
      updatedAt: "",
    });
    const open = schema.headerActions?.find(
      (a) => a.kind === "action" && a.label === "Open in Xata",
    );
    expect(open).toMatchObject({
      action: {
        type: "open-url",
        url: "https://console.xata.io/organizations/o%201/projects/p%3F1/branches/b%231",
      },
    });
  });
});

describe("getLogs", () => {
  const resource = `${ACCOUNT}:xata-branch:org1/p1/b1`;
  const line = (i: number) => ({
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    instanceID: "i1",
    level: "info",
    message: `line ${i}`,
  });

  function logRoute(pages: Array<{ count: number; next: string | null }>): {
    route: Route;
    bodies: Array<{ limit?: number; cursor?: string; filters?: unknown }>;
  } {
    const bodies: Array<{ limit?: number; cursor?: string; filters?: unknown }> = [];
    let served = 0;
    return {
      bodies,
      route: (call) => {
        if (call.method !== "POST" || new URL(call.url).pathname.split("/").at(-1) !== "logs") {
          return undefined;
        }
        const body: { limit?: number; cursor?: string; filters?: unknown } = JSON.parse(
          String(call.body),
        );
        bodies.push(body);
        const page = pages[bodies.length - 1]!;
        const logs = Array.from({ length: page.count }, (_, i) => line(served + i));
        served += page.count;
        return { status: 200, body: { logs, nextCursor: page.next, start: "", end: "" } };
      },
    };
  }

  it("never asks for more than the document's 200 and follows nextCursor to the tail", async () => {
    const { route, bodies } = logRoute([
      { count: 200, next: "c1" },
      { count: 200, next: "c2" },
      { count: 100, next: "c3" },
    ]);
    const { client } = fake([route]);
    const res = await client.getLogs("xata-branch", resource, ACCOUNT, { tailLines: 500 });
    expect(bodies.map((b) => [b.limit, b.cursor])).toEqual([
      [200, undefined],
      [200, "c1"],
      [100, "c2"],
    ]);
    expect(res.text.trim().split("\n")).toHaveLength(500);
  });

  it("stops when there is no next page, and keeps the filter on every page", async () => {
    const { route, bodies } = logRoute([
      { count: 200, next: "c1" },
      { count: 3, next: null },
    ]);
    const { client } = fake([route]);
    const res = await client.getLogs("xata-branch", resource, ACCOUNT, {
      tailLines: 1000,
      container: "warnings and errors",
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.filters).toEqual(bodies[0]!.filters);
    expect(bodies[0]!.filters).toBeDefined();
    expect(res.text.trim().split("\n")).toHaveLength(203);
  });

  it("returns what it read when short pages keep promising more", async () => {
    const pages = Array.from({ length: 50 }, (_, i) => ({ count: 1, next: `c${i}` }));
    const { route, bodies } = logRoute(pages);
    const { client } = fake([route]);
    const res = await client.getLogs("xata-branch", resource, ACCOUNT, { tailLines: 1000 });
    expect(bodies.length).toBeLessThan(50);
    expect(res.text.trim().split("\n")).toHaveLength(bodies.length);
  });
});

describe("xata-organization", () => {
  it("fills Billed Through from the single-organization answer", async () => {
    const { client } = fake([
      on("GET", `${API}/organizations`, { organizations: [org] }),
      on("GET", `${API}/organizations/org1`, { ...org, marketplace: "aws" }),
      on("GET", `${API}/organizations/org1/members`, { members: [] }),
    ]);
    const [o] = await client.listResources("xata-organization", ACCOUNT);
    expect(o!.fields["marketplace"]).toBe("aws");
    expect(o!.fields["memberCount"]).toBe(0);
  });

  it("still lists an organization whose detail cannot be read", async () => {
    const { client } = fake([
      on("GET", `${API}/organizations`, { organizations: [org] }),
      on("GET", `${API}/organizations/org1`, { message: "denied" }, 403),
      on("GET", `${API}/organizations/org1/members`, { members: [] }),
    ]);
    const [o] = await client.listResources("xata-organization", ACCOUNT);
    expect(o).toMatchObject({ externalId: "org1", displayName: "Acme" });
    expect(o!.fields["marketplace"]).toBe("");
  });
});

describe("branch Host field", () => {
  const deprecated = {
    ...branch,
    connectionString: "postgresql://xata:secret@b1-deprecated.us-east-1.xata.tech/xata",
  };
  const credentials = { hostname: "b1.us-east-1.xata.tech", password: "pw" };
  const listing = [
    on("GET", `${API}/organizations`, { organizations: [org] }),
    on("GET", `${API}/organizations/org1/projects`, { projects: [project] }),
    on("GET", `${API}/organizations/org1/projects/p1/branches`, { branches: [branch] }),
  ];

  it("comes from the credentials endpoint, in the listing and on one branch", async () => {
    const { client } = fake([
      ...listing,
      on("GET", `${B}/credentials`, credentials),
      on("GET", B, deprecated),
    ]);
    const [listed] = await client.listResources("xata-branch", ACCOUNT);
    expect(listed!.fields["host"]).toBe("b1.us-east-1.xata.tech");
    const one = await client.getResource(
      "xata-branch",
      `${ACCOUNT}:xata-branch:org1/p1/b1`,
      ACCOUNT,
    );
    expect(one.fields["host"]).toBe("b1.us-east-1.xata.tech");
    expect(JSON.stringify(listed!.fields)).not.toContain("pw");
    expect(JSON.stringify(listed!.fields)).not.toContain("secret");
  });

  it("stays filled when the connection string is gone", async () => {
    const { client } = fake([
      ...listing,
      on("GET", `${B}/credentials`, credentials),
      on("GET", B, { ...branch, connectionString: null }),
    ]);
    const [listed] = await client.listResources("xata-branch", ACCOUNT);
    expect(listed!.fields["host"]).toBe("b1.us-east-1.xata.tech");
  });

  it("falls back to the deprecated string for a key without credentials:read", async () => {
    const { client } = fake([
      ...listing,
      on("GET", `${B}/credentials`, { message: "denied" }, 403),
      on("GET", B, deprecated),
    ]);
    const [listed] = await client.listResources("xata-branch", ACCOUNT);
    expect(listed!.fields["host"]).toBe("b1-deprecated.us-east-1.xata.tech");
    expect(listed!.fields["instanceType"]).toBe("xata.small");
  });
});

describe("long lists", () => {
  const invitation = (i: number) => ({
    id: `inv${i}`,
    email: `u${i}@example.test`,
    organization_id: "org1",
    role: "editor",
    status: "pending",
    created_at: "2026-01-01T00:00:00Z",
    expires_at: "2026-02-01T00:00:00Z",
  });
  const invoice = (i: number) => ({
    id: `i${i}`,
    invoice_number: String(i),
    amount_due: 1,
    currency: "usd",
    invoice_date: "2026-09-01T00:00:00Z",
    status: "paid",
    invoice_pdf: null,
  });
  const orgs = on("GET", `${API}/organizations`, { organizations: [org] });
  const range = { fromDate: "2026-08-01", toDate: "2026-10-31" };

  /** Every invitation request, answered from `total` rows honouring `first` and `max`. */
  function invitations(total: number): Route {
    return (call) => {
      const u = new URL(call.url);
      if (u.pathname !== "/organizations/org1/invitations") return undefined;
      const first = Number(u.searchParams.get("first") ?? 0);
      const max = Number(u.searchParams.get("max") ?? 100);
      const rows = Array.from({ length: Math.max(total - first, 0) }, (_, i) =>
        invitation(first + i),
      );
      return { status: 200, body: { invitations: rows.slice(0, max) } };
    };
  }

  it("reads every invitation, past the first 100", async () => {
    const { client, calls } = fake([orgs, invitations(250)]);
    const rows = await client.listResources("xata-invitation", ACCOUNT);
    expect(rows).toHaveLength(250);
    expect(new Set(rows.map((r) => r.externalId)).size).toBe(250);
    const asked = calls.slice(1).map((c) => new URL(c.url).searchParams);
    expect(asked.map((q) => q.get("max"))).toEqual(asked.map(() => "100"));
    expect(asked.map((q) => q.get("first") ?? "0").slice(0, 3)).toEqual(["0", "100", "200"]);
  });

  it("counts every pending invitation against the quota", async () => {
    const { client, calls } = fake([
      orgs,
      invitations(120),
      on("GET", `${API}/organizations/org1/limits`, {}),
      on("GET", `${API}/organizations/org1/membership-limits`, { maxInvites: 500 }),
      on("GET", `${API}/organizations/org1/projects`, { projects: [] }),
      on("GET", `${API}/organizations/org1/members`, { members: [] }),
    ]);
    const quotas = await client.fetchQuotas(ACCOUNT);
    expect(quotas.find((q) => q.id === "org1/invites")?.used).toBe(120);
    const invites = calls.filter((c) => c.url.includes("/invitations"));
    expect(invites.every((c) => c.url.includes("status=pending"))).toBe(true);
  });

  it("refuses to call an invitation list complete at its cap", async () => {
    let requests = 0;
    const { client } = fake([
      orgs,
      (call) => {
        if (!call.url.includes("/invitations")) return undefined;
        requests++;
        const first = Number(new URL(call.url).searchParams.get("first") ?? 0);
        const rows = Array.from({ length: 100 }, (_, i) => invitation(first + i));
        return { status: 200, body: { invitations: rows } };
      },
    ]);
    await expect(client.listResources("xata-invitation", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(requests).toBe(100);
  });

  it("reads every invoice, and sends the document's largest page size", async () => {
    let served = 0;
    const { client, calls } = fake([
      orgs,
      on("GET", `${API}/organizations/org1/billing/invoices/upcoming`, {}, 404),
      (call) => {
        if (new URL(call.url).pathname !== "/organizations/org1/billing/invoices") return undefined;
        served++;
        return {
          status: 200,
          body: {
            data: [invoice(served)],
            pagination_metadata: {
              has_more: served < 60,
              next_cursor: served < 60 ? `c${served}` : null,
            },
          },
        };
      },
    ]);
    const rows = await client.fetchCostData(ACCOUNT, range);
    expect(rows.map((r) => r.amount)).toEqual([60]);
    expect(served).toBe(60);
    const pages = calls.filter((c) => c.url.includes("/billing/invoices?"));
    expect(new URL(pages[1]!.url).searchParams.get("cursor")).toBe("c1");
    expect(new URL(pages[0]!.url).searchParams.get("limit")).toBe("100");
  });

  it("refuses partial cost data at the invoice cap", async () => {
    let served = 0;
    const { client } = fake([
      orgs,
      (call) => {
        if (new URL(call.url).pathname !== "/organizations/org1/billing/invoices") return undefined;
        served++;
        return {
          status: 200,
          body: {
            data: [invoice(served)],
            pagination_metadata: { has_more: true, next_cursor: `c${served}` },
          },
        };
      },
    ]);
    await expect(client.fetchCostData(ACCOUNT, range)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(served).toBe(100);
  });
});

describe("a 2xx that holds no list", () => {
  const O = `${API}/organizations/org1`;
  const orgs = on("GET", `${API}/organizations`, { organizations: [org] });
  const projects = on("GET", `${O}/projects`, { projects: [project] });

  const cases: Array<[string, string, Route[]]> = [
    ["organizations", "xata-organization", [on("GET", `${API}/organizations`, { orgs: [org] })]],
    ["projects", "xata-project", [orgs, on("GET", `${O}/projects`, { items: [project] })]],
    [
      "branches",
      "xata-branch",
      [orgs, projects, on("GET", `${O}/projects/p1/branches`, { message: "wrapped error" })],
    ],
    [
      "branches under a project's count",
      "xata-project",
      [orgs, projects, on("GET", `${O}/projects/p1/branches`, { message: "wrapped error" })],
    ],
    ["backups", "xata-backup", [orgs, projects, on("GET", `${O}/projects/p1/backups`, {})]],
    ["api keys", "xata-api-key", [orgs, on("GET", `${O}/api-keys`, { key: [] })]],
    ["members", "xata-member", [orgs, on("GET", `${O}/members`, { members: "none" })]],
    ["invitations", "xata-invitation", [orgs, on("GET", `${O}/invitations`, {})]],
  ];

  it.each(cases)("rejects a bad %s page", async (_what, typeId, routes) => {
    const { client } = fake(routes);
    await expect(client.listResources(typeId, ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("rejects an empty body", async () => {
    const services: HostServices = {
      http: { request: async () => ({ status: 200, headers: {}, body: "" }) },
    };
    const client = hostClient(new XataClient({ apiKey: "xau_k" }, services));
    await expect(client.listResources("xata-project", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("rejects a body that is not JSON", async () => {
    const services: HostServices = {
      http: { request: async () => ({ status: 200, headers: {}, body: "<html>" }) },
    };
    const client = hostClient(new XataClient({ apiKey: "xau_k" }, services));
    await expect(client.listResources("xata-project", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("rejects a bad invoice page rather than reporting no cost", async () => {
    const { client } = fake([orgs, on("GET", `${O}/billing/invoices`, { invoices: [] })]);
    await expect(
      client.fetchCostData(ACCOUNT, { fromDate: "2026-08-01", toDate: "2026-10-31" }),
    ).rejects.toThrow("is not a list");
  });

  it("reads an empty array as none", async () => {
    const { client } = fake([
      orgs,
      projects,
      on("GET", `${O}/projects/p1/branches`, { branches: [] }),
      on("GET", `${O}/projects/p1/backups`, { backups: [] }),
    ]);
    expect(await client.listResources("xata-branch", ACCOUNT)).toEqual([]);
    expect(await client.listResources("xata-backup", ACCOUNT)).toEqual([]);
  });

  it("does not read a bad page as an empty quota count", async () => {
    const { client } = fake([
      orgs,
      on("GET", `${O}/projects`, { projects: [] }),
      on("GET", `${O}/limits`, {}),
      on("GET", `${O}/membership-limits`, {}),
      on("GET", `${O}/invitations`, { invitations: [] }),
      on("GET", `${O}/members`, { people: [] }),
    ]);
    await expect(client.fetchQuotas(ACCOUNT)).rejects.toThrow("is not a list");
  });
});

describe("an id with a part missing", () => {
  it.each([
    ["xata-project", "org1"],
    ["xata-project", "org1/"],
    ["xata-branch", "org1/p1"],
    ["xata-branch", "org1/p1/"],
    ["xata-api-key", "org1"],
    ["xata-api-key", "org1/"],
    ["xata-member", "org1"],
    ["xata-invitation", "org1/"],
  ])("refuses to delete %s %s and sends nothing", async (typeId, externalId) => {
    const { client, calls } = fake([]);
    await expect(
      client.deleteResource(typeId, `${ACCOUNT}:${typeId}:${externalId}`, ACCOUNT),
    ).rejects.toThrow("incomplete");
    expect(calls).toEqual([]);
  });

  it("refuses an action or an update on one", async () => {
    const { client, calls } = fake([]);
    await expect(
      client.invokeAction("xata-branch", `${ACCOUNT}:xata-branch:org1/p1`, "hibernate", ACCOUNT),
    ).rejects.toThrow("incomplete");
    await expect(
      client.updateResource("xata-member", `${ACCOUNT}:xata-member:org1`, ACCOUNT, {
        role: "admin",
      }),
    ).rejects.toThrow("incomplete");
    expect(calls).toEqual([]);
  });
});
