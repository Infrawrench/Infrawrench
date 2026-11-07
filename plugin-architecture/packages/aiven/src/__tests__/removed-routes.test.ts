import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AivenClient } from "../client.js";
import { ENRICH } from "../render.js";

type Handler = () => Response;

/** Whatever is not listed answers 404, which is how a removed route answers. */
function mockFetch(routes: Record<string, object | Handler>) {
  const calls: Array<{ route: string; body: object | undefined }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.hostname !== "api.aiven.io") throw new Error(`Unexpected host ${url.hostname}`);
      const route = `${(init.method ?? "GET").toUpperCase()} ${url.pathname.replace(/^\/v1/, "")}`;
      calls.push({
        route,
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const handler = routes[route];
      if (handler === undefined) return status(404)();
      return typeof handler === "function"
        ? handler()
        : new Response(JSON.stringify(handler), { status: 200 });
    }),
  );
  return { calls, routes: () => calls.map((c) => c.route) };
}

const status = (code: number) => () =>
  new Response(JSON.stringify({ message: "no" }), { status: code });

afterEach(() => vi.unstubAllGlobals());

const ACC = "acc";
const client = () => hostClient(new AivenClient({ apiToken: "x" }));
const form = (fields: Record<string, string>) => [JSON.stringify(fields)];

const organizations = {
  "GET /organizations": {
    organizations: [{ organization_id: "org1", account_id: "acc1", organization_name: "Acme" }],
  },
};
const newGroup = {
  billing_group_id: "g1",
  billing_group_name: "Main",
  organization_id: "org1",
  billing_emails: [{ email: "pay@example.com" }],
  payment_method: { payment_method_id: "pm1", payment_method_type: "credit_card" },
};
const newProject = { project_id: "acme", billing_group_id: "g1", tags: { team: "core" } };

describe("billing groups", () => {
  it("uses the old route while it answers", async () => {
    const f = mockFetch({
      "GET /billing-group": {
        billing_groups: [{ billing_group_id: "g1", billing_group_name: "Main" }],
      },
    });
    const [row] = await client().listResources("aiven-billing-group", ACC);
    expect(row!.externalId).toBe("g1");
    expect(f.routes()).toEqual(["GET /billing-group"]);
  });

  it("moves to the organization route once the old one is gone", async () => {
    mockFetch({
      ...organizations,
      "GET /organization/org1/billing-groups": { billing_groups: [newGroup] },
    });
    const [row] = await client().listResources("aiven-billing-group", ACC);
    expect(row!.externalId).toBe("g1");
    expect(row!.fields).toMatchObject({
      name: "Main",
      organization: "Acme",
      paymentMethod: "credit_card",
      billingEmails: "pay@example.com",
    });
  });

  it("does not take a failure of the old route for a removal", async () => {
    const f = mockFetch({ "GET /billing-group": status(500) });
    await expect(client().listResources("aiven-billing-group", ACC)).rejects.toThrow(/500/);
    expect(f.routes()).toEqual(["GET /billing-group"]);
  });

  it("skips an organization the token has no billing access to, while another answers", async () => {
    mockFetch({
      "GET /organizations": {
        organizations: [{ organization_id: "org1" }, { organization_id: "org2" }],
      },
      "GET /organization/org1/billing-groups": status(403),
      "GET /organization/org2/billing-groups": { billing_groups: [newGroup] },
    });
    await expect(client().listResources("aiven-billing-group", ACC)).resolves.toHaveLength(1);
  });

  it("fails when every organization refuses, rather than reading that as none", async () => {
    mockFetch({ ...organizations, "GET /organization/org1/billing-groups": status(403) });
    await expect(client().listResources("aiven-billing-group", ACC)).rejects.toThrow(/403/);
  });

  it("fails a page that says there is more", async () => {
    mockFetch({
      ...organizations,
      "GET /organization/org1/billing-groups": { billing_groups: [newGroup], next: "c2" },
    });
    await expect(client().listResources("aiven-billing-group", ACC)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
  });

  it("refuses a page with its key renamed", async () => {
    mockFetch({ ...organizations, "GET /organization/org1/billing-groups": { renamed: [] } });
    await expect(client().listResources("aiven-billing-group", ACC)).rejects.toThrow(
      "is not a list",
    );
    mockFetch({ "GET /organizations": { renamed: [] } });
    await expect(client().listResources("aiven-billing-group", ACC)).rejects.toThrow(
      "is not a list",
    );
  });
});

describe("projects", () => {
  it("moves to the organization route once the old one is gone", async () => {
    mockFetch({
      ...organizations,
      "GET /organization/org1/projects": { projects: [newProject] },
    });
    const [row] = await client().listResources("aiven-project", ACC);
    expect(row!.externalId).toBe("acme");
    expect(row!.fields).toMatchObject({
      name: "acme",
      organizationId: "org1",
      billingGroupId: "g1",
      tags: "team=core",
    });
  });

  const gone = {
    ...organizations,
    "GET /organization/org1/projects": { projects: [newProject] },
    "GET /organization/org1/billing-groups": { billing_groups: [newGroup] },
  };

  it("creates through the organization once the old route is gone", async () => {
    const f = mockFetch({
      ...gone,
      "POST /organization/org1/projects": { ...newProject, project_id: "new-one" },
    });
    const row = await client().createResource("aiven-project", ACC, {
      name: "new-one",
      billingGroupId: "g1",
    });
    expect(row.externalId).toBe("new-one");
    expect(f.calls.find((c) => c.route === "POST /organization/org1/projects")?.body).toEqual({
      project_id: "new-one",
      billing_group_id: "g1",
      tags: {},
    });
  });

  it("asks for the billing group the organization route requires", async () => {
    const f = mockFetch(gone);
    await expect(
      client().createResource("aiven-project", ACC, { name: "new-one" }),
    ).rejects.toThrow("Pick a billing group");
    expect(f.routes()).not.toContain("POST /organization/org1/projects");
  });

  it("edits contacts through the organization once the old route is gone", async () => {
    const f = mockFetch({
      ...gone,
      "PATCH /organization/org1/project/acme": { ...newProject },
    });
    await client().updateResource("aiven-project", `${ACC}:aiven-project:acme`, ACC, {
      techEmails: "a@example.com",
    });
    expect(f.calls.find((c) => c.route === "PATCH /organization/org1/project/acme")?.body).toEqual({
      tech_emails: [{ email: "a@example.com" }],
    });
  });

  it("deletes through the organization once the old route is gone", async () => {
    const f = mockFetch({ ...gone, "DELETE /organization/org1/project/acme": {} });
    await client().deleteResource("aiven-project", `${ACC}:aiven-project:acme`, ACC);
    expect(f.routes()).toContain("DELETE /organization/org1/project/acme");
  });

  it("deletes on the old route alone while it answers", async () => {
    const f = mockFetch({ "DELETE /project/acme": {} });
    await client().deleteResource("aiven-project", `${ACC}:aiven-project:acme`, ACC);
    expect(f.routes()).toEqual(["DELETE /project/acme"]);
  });

  it("reports a project it cannot find rather than deleting anything else", async () => {
    const f = mockFetch(gone);
    await expect(
      client().deleteResource("aiven-project", `${ACC}:aiven-project:other`, ACC),
    ).rejects.toThrow(/404/);
    expect(f.routes().filter((r) => r.startsWith("DELETE /organization"))).toEqual([]);
  });
});

describe("moving a project to a billing group", () => {
  const command = () =>
    client().executeNoSqlCommand(
      "aiven-project",
      `${ACC}:aiven-project:acme`,
      ACC,
      "set-billing-group",
      form({ billingGroupId: "g2" }),
    );

  it("uses the old route while it answers", async () => {
    const f = mockFetch({ "POST /billing-group/g2/project-assign/acme": {} });
    await command();
    expect(f.routes()).toEqual(["POST /billing-group/g2/project-assign/acme"]);
  });

  it("sends only the billing group to the organization route once the old one is gone", async () => {
    const f = mockFetch({
      "GET /project": { projects: [{ project_name: "acme", organization_id: "org1" }] },
      "PATCH /organization/org1/project/acme": { ...newProject, billing_group_id: "g2" },
    });
    await command();
    expect(f.calls.find((c) => c.route === "PATCH /organization/org1/project/acme")?.body).toEqual({
      billing_group_id: "g2",
    });
  });

  it("surfaces the removal when the project's organization is not known", async () => {
    mockFetch({ "GET /project": { projects: [{ project_name: "acme" }] } });
    await expect(command()).rejects.toThrow(/404/);
  });

  it("does not take a refusal of the old route for a removal", async () => {
    const f = mockFetch({ "POST /billing-group/g2/project-assign/acme": status(403) });
    await expect(command()).rejects.toThrow(/403/);
    expect(f.routes()).toEqual(["POST /billing-group/g2/project-assign/acme"]);
  });
});

describe("project credits", () => {
  const claim = () =>
    client().executeNoSqlCommand(
      "aiven-project",
      `${ACC}:aiven-project:acme`,
      ACC,
      "claim-credit",
      form({ code: "C1" }),
    );

  it("claims on the old route while it answers", async () => {
    const f = mockFetch({ "POST /project/acme/credits": { credit: {} } });
    await claim();
    expect(f.routes()).toEqual(["POST /project/acme/credits"]);
  });

  it("claims on the project's billing group once the old route is gone", async () => {
    const f = mockFetch({
      "GET /project": { projects: [{ project_name: "acme", billing_group_id: "g1" }] },
      "POST /billing-group/g1/credits": { credit: {} },
    });
    await claim();
    expect(f.calls.find((c) => c.route === "POST /billing-group/g1/credits")?.body).toEqual({
      code: "C1",
    });
  });

  it("surfaces the removal when the project has no billing group", async () => {
    mockFetch({ "GET /project": { projects: [{ project_name: "acme" }] } });
    await expect(claim()).rejects.toThrow(/404/);
  });

  it("shows the billing group's credits on the project once the old route is gone", async () => {
    mockFetch({
      "GET /billing-group/g1/credits": {
        credits: [{ code: "C1", type: "discount", remaining_value: "5" }],
      },
    });
    const out = await client().enrichDetail({
      id: `${ACC}:aiven-project:acme`,
      pluginId: "aiven",
      resourceTypeId: "aiven-project",
      accountId: ACC,
      displayName: "acme",
      fields: { name: "acme", billingGroupId: "g1" },
      resolvedOutputs: {},
      secretStates: [],
      externalId: "acme",
      createdAt: "",
      updatedAt: "",
    });
    expect(JSON.parse(out.resolvedOutputs[ENRICH.credits] ?? "[]")).toEqual([
      expect.objectContaining({ code: "C1", remaining: "5" }),
    ]);
  });
});

describe("costs", () => {
  const range = { fromDate: "2026-01-01", toDate: "2026-01-31" };
  const costs = () => client().fetchCostData(ACC, range);
  const invoice = {
    billing_group_id: "g1",
    organization_id: "org1",
    invoice_number: "n1",
    invoice_period: { begin_time: "2026-01-01T00:00:00Z", end_time: "2026-01-11T00:00:00Z" },
    state: "paid",
    currency: "USD",
    total: "10",
  };
  const line = {
    line_type: "service_charge",
    total_usd: "10",
    total: "9",
    begin_time: "2026-01-01T00:00:00Z",
    end_time: "2026-01-11T00:00:00Z",
    cloud: "aws-eu-west-1",
    plan: "startup-4",
    project_id: "acme",
    service_id: "pg-main",
    service_type: "pg",
  };
  const newRoutes = {
    "GET /organization/org1/invoices": {
      invoices: [invoice, { ...invoice, billing_group_id: "other", invoice_number: "n2" }],
    },
    "GET /organization/org1/invoice/n1/lines": { lines: [line] },
  };

  it("reads organization invoices and lines once the old routes are gone", async () => {
    const f = mockFetch({
      ...organizations,
      "GET /organization/org1/billing-groups": { billing_groups: [newGroup] },
      ...newRoutes,
    });
    const rows = await costs();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(10);
    expect(Array.isArray(rows) && rows[0]).toMatchObject({
      date: "2026-01-01",
      service: "PostgreSQL",
      region: "aws-eu-west-1",
      resourceId: "acme/pg-main",
      currency: "USD",
      amount: 1,
      chargeType: "usage",
      tags: { project: "acme", plan: "startup-4" },
    });
    expect(f.routes()).not.toContain("GET /organization/org1/invoice/n2/lines");
  });

  it("finds the organization of an old billing group row through its account", async () => {
    mockFetch({
      ...organizations,
      "GET /billing-group": { billing_groups: [{ billing_group_id: "g1", account_id: "acc1" }] },
      ...newRoutes,
    });
    await expect(costs()).resolves.toHaveLength(10);
  });

  it("reads old lines of an invoice list that still answers", async () => {
    const f = mockFetch({
      "GET /billing-group": { billing_groups: [{ billing_group_id: "g1" }] },
      "GET /billing-group/g1/invoice": {
        invoices: [
          {
            invoice_number: "n1",
            period_begin: "2026-01-01T00:00:00Z",
            period_end: "2026-01-02T00:00:00Z",
          },
        ],
      },
      "GET /billing-group/g1/invoice/n1/lines": {
        lines: [{ line_total_usd: "1", line_type: "service_charge", description: "x" }],
      },
    });
    await expect(costs()).resolves.toHaveLength(1);
    expect(f.routes().some((r) => r.includes("/organization"))).toBe(false);
  });

  it("refuses an organization invoice answer without its key", async () => {
    mockFetch({
      ...organizations,
      "GET /organization/org1/billing-groups": { billing_groups: [newGroup] },
      "GET /organization/org1/invoices": { renamed: [] },
    });
    await expect(costs()).rejects.toThrow("is not a list");
  });

  it("marks the pass degraded when an old group's organization cannot be found", async () => {
    mockFetch({
      ...organizations,
      "GET /billing-group": { billing_groups: [{ billing_group_id: "g1", account_id: "nope" }] },
    });
    await expect(costs()).resolves.toEqual({ rows: [], degraded: true });
  });
});

describe("billing group detail", () => {
  it("lists organization invoices once the old route is gone", async () => {
    mockFetch({
      "GET /billing-group": {
        billing_groups: [{ billing_group_id: "g1", account_id: "acc1" }],
      },
      ...organizations,
      "GET /organization/org1/invoices": {
        invoices: [
          {
            billing_group_id: "g1",
            invoice_number: "n1",
            invoice_period: {
              begin_time: "2026-01-01T00:00:00Z",
              end_time: "2026-02-01T00:00:00Z",
            },
            state: "paid",
            currency: "EUR",
            total: "12",
          },
        ],
      },
    });
    const out = await client().enrichDetail({
      id: `${ACC}:aiven-billing-group:g1`,
      pluginId: "aiven",
      resourceTypeId: "aiven-billing-group",
      accountId: ACC,
      displayName: "Main",
      fields: {},
      resolvedOutputs: {},
      secretStates: [],
      externalId: "g1",
      createdAt: "",
      updatedAt: "",
    });
    expect(JSON.parse(out.resolvedOutputs[ENRICH.invoices] ?? "[]")).toEqual([
      {
        number: "n1",
        period: "2026-01-01 to 2026-02-01",
        state: "paid",
        total: "12 EUR",
      },
    ]);
  });
});
