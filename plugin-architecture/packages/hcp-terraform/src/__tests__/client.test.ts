import { describe, expect, it } from "vitest";
import { cleanTerraformLog, normaliseHostname, statusOf, tfList } from "../api.js";
import { HcpTerraformClient, runAttributes, tailLines } from "../client.js";
import { fetchInvoiceCost } from "../cost.js";
import { runSeries } from "../metrics.js";
import { plugin } from "../plugin.js";
import { isTerraformIncident, parseStatusFeed } from "../status-feed.js";
import { tfeTerraformExport } from "../terraform.js";
import type { Call } from "./helpers.js";
import { makeHttp } from "./helpers.js";

const ACC = "acc";

function client(
  route: (call: Call) => unknown,
  creds: Record<string, string> = {},
  secrets?: Map<string, string>,
) {
  const { http, calls } = makeHttp(route);
  const services = {
    http,
    ...(secrets
      ? {
          secrets: {
            getPlaintext: async (r: string, k: string) => secrets.get(`${r}|${k}`) ?? null,
            setPlaintext: async (r: string, k: string, v: string) =>
              void secrets.set(`${r}|${k}`, v),
          },
        }
      : {}),
  };
  const c = new HcpTerraformClient(
    { apiToken: "tok", organization: "acme", ...creds },
    services as never,
  );
  c.setSleep(async () => {});
  return { c, calls };
}

const WS = {
  id: "ws-1",
  type: "workspaces",
  attributes: {
    name: "net-prod",
    "resource-count": 12,
    locked: false,
    "execution-mode": "remote",
    "terraform-version": "1.9.8",
  },
  relationships: {
    project: { data: { id: "prj-1", type: "projects" } },
    "current-run": { data: { id: "run-1", type: "runs" } },
  },
};

describe("api", () => {
  it("uses the configured host, a bearer token and the JSON:API media type, and pages", async () => {
    const { http, calls } = makeHttp((call) => {
      expect(call.url.host).toBe("tfe.example.com");
      expect(call.headers["Authorization"]).toBe("Bearer t");
      expect(call.headers["Accept"]).toBe("application/vnd.api+json");
      const page = Number(call.url.searchParams.get("page[number]"));
      return {
        data: [{ id: `o${page}`, type: "organizations", attributes: {} }],
        meta: { pagination: { "next-page": page < 2 ? 2 : null } },
      };
    });
    const res = await tfList({ token: "t", hostname: "tfe.example.com", http }, "/organizations");
    expect(res.data.map((d) => d.id)).toEqual(["o1", "o2"]);
    expect(calls[0]!.url.searchParams.get("page[size]")).toBe("100");
  });

  it("maps JSON:API errors and keeps the status", async () => {
    const { http } = makeHttp(() => ({
      status: 422,
      body: { errors: [{ title: "invalid", detail: "name has already been taken" }] },
    }));
    const err = await tfList({ token: "t", hostname: "app.terraform.io", http }, "/x").catch(
      (e: unknown) => e,
    );
    expect(statusOf(err)).toBe(422);
    expect(String((err as Error).message)).toContain("invalid: name has already been taken");
  });

  it("normalises hostnames and refuses junk", () => {
    expect(normaliseHostname("https://TFE.example.com/app/")).toBe("tfe.example.com");
    expect(normaliseHostname("")).toBe("app.terraform.io");
    expect(() => normaliseHostname("not a host")).toThrow(/not a hostname/);
  });

  it("refuses private hosts on the server", () => {
    expect(plugin.validateServerCredentials!({ hostname: "10.0.0.5" })).toMatch(/IP address/);
    expect(plugin.validateServerCredentials!({ hostname: "tfe.example.com" })).toBeNull();
  });

  it("turns structured and plain logs into text", () => {
    const raw =
      '{"@level":"info","@message":"Terraform 1.9.8"}\n\u0002\u001b[32mApply complete!\u001b[0m\u0003\n{"@level":"error","@message":"boom"}';
    expect(cleanTerraformLog(raw)).toBe("Terraform 1.9.8\nApply complete!\n[error] boom");
    expect(tailLines("a\nb\nc\n\n", 2)).toBe("b\nc\n");
  });
});

describe("listing", () => {
  it("lists workspaces with project, current run and explorer drift", async () => {
    const { c } = client((call) => {
      if (call.url.pathname === "/api/v2/organizations/acme/workspaces") {
        expect(call.url.searchParams.get("include")).toBe("current_run,project");
        return {
          data: [WS],
          included: [
            { id: "run-1", type: "runs", attributes: { status: "applied" } },
            { id: "prj-1", type: "projects", attributes: { name: "Networking" } },
          ],
          meta: { pagination: { "next-page": null, "total-count": 1 } },
        };
      }
      if (call.url.pathname === "/api/v2/organizations/acme/explorer") {
        expect(call.url.searchParams.get("type")).toBe("workspaces");
        return {
          data: [
            {
              id: "ws-1",
              type: "visibility-workspace",
              attributes: {
                "external-id": "ws-1",
                drifted: true,
                "resources-drifted": 2,
                "checks-failed": 1,
                "current-rum-count": 9,
              },
            },
          ],
        };
      }
      throw new Error(`unexpected ${call.url}`);
    });
    const [w] = await c.listResources("workspace", ACC);
    expect(w).toMatchObject({ externalId: "ws-1", parentResourceId: `${ACC}:project:prj-1` });
    expect(w!.fields).toMatchObject({
      projectName: "Networking",
      currentRunStatus: "applied",
      drifted: true,
      resourcesDrifted: 2,
      checksFailed: 1,
      rumCount: 9,
      resourceCount: 12,
    });
    expect(w!.resolvedOutputs["url"]).toBe("https://app.terraform.io/app/acme/workspaces/net-prod");
  });

  it("still lists workspaces when the explorer is off limits", async () => {
    const { c } = client((call) =>
      call.url.pathname.endsWith("/explorer")
        ? { status: 404, body: { errors: ["not found"] } }
        : { data: [WS], included: [] },
    );
    const [w] = await c.listResources("workspace", ACC);
    expect(w!.fields["drifted"]).toBeUndefined();
  });

  it("lists recent runs with their plan's resource counts", async () => {
    const { c } = client((call) => {
      if (call.url.pathname.endsWith("/workspaces")) return { data: [WS], included: [] };
      expect(call.url.pathname).toBe("/api/v2/organizations/acme/runs");
      return {
        data: [
          {
            id: "run-9",
            type: "runs",
            attributes: {
              status: "planned",
              message: "Add VPC",
              "created-at": "2026-10-01T00:00:00Z",
              actions: { "is-confirmable": true },
            },
            relationships: {
              workspace: { data: { id: "ws-1", type: "workspaces" } },
              plan: { data: { id: "plan-9", type: "plans" } },
            },
          },
        ],
        included: [
          {
            id: "plan-9",
            type: "plans",
            attributes: {
              "resource-additions": 3,
              "resource-changes": 1,
              "resource-destructions": 0,
            },
          },
        ],
      };
    });
    const [r] = await c.listResources("run", ACC);
    expect(r).toMatchObject({
      displayName: "net-prod: Add VPC",
      parentResourceId: `${ACC}:workspace:ws-1`,
    });
    expect(r!.fields).toMatchObject({ canApply: true, resourceAdditions: 3, resourceChanges: 1 });
  });

  it("returns nothing for features outside the plan", async () => {
    const { c } = client(() => ({ status: 404, body: { errors: ["not found"] } }));
    expect(await c.listResources("policy-set", ACC)).toEqual([]);
    expect(await c.listResources("agent-pool", ACC)).toEqual([]);
  });
});

describe("outputs", () => {
  it("reads a sensitive output's value from the single-output endpoint", async () => {
    const { c, calls } = client((call) => {
      if (call.url.pathname === "/api/v2/workspaces/ws-1/current-state-version-outputs") {
        return {
          data: [
            {
              id: "wsout-1",
              type: "state-version-outputs",
              attributes: { name: "db_password", sensitive: true, value: null },
            },
          ],
        };
      }
      expect(call.url.pathname).toBe("/api/v2/state-version-outputs/wsout-1");
      return {
        data: {
          id: "wsout-1",
          type: "state-version-outputs",
          attributes: { name: "db_password", sensitive: true, value: "hunter2" },
        },
      };
    });
    expect(
      await c.resolveOutput("state-output", `${ACC}:state-output:ws-1/db_password`, "value", ACC),
    ).toBe("hunter2");
    expect(calls).toHaveLength(2);
  });

  it("serialises structured outputs as JSON", async () => {
    const { c } = client(() => ({
      data: [
        {
          id: "o",
          type: "state-version-outputs",
          attributes: { name: "subnets", sensitive: false, value: ["a", "b"] },
        },
      ],
    }));
    expect(
      await c.resolveOutput("state-output", `${ACC}:state-output:ws-1/subnets`, "value", ACC),
    ).toBe('["a","b"]');
  });
});

describe("runs and logs", () => {
  it("builds run attributes from the form", () => {
    expect(runAttributes({ kind: "destroy", targets: "a.b, c.d", message: "" })).toEqual({
      message: "Queued from Infrawrench",
      "is-destroy": true,
      "target-addrs": ["a.b", "c.d"],
    });
    expect(runAttributes({ kind: "refresh-only" })).toMatchObject({ "refresh-only": true });
  });

  it("applies a run with a comment", async () => {
    const { c, calls } = client(() => ({ status: 202, body: "" }));
    await c.executeNoSqlCommand("run", `${ACC}:run:run-1`, ACC, "applyRun", [
      JSON.stringify({ comment: "LGTM" }),
    ]);
    expect(calls[0]).toMatchObject({ method: "POST", body: { comment: "LGTM" } });
    expect(calls[0]!.url.pathname).toBe("/api/v2/runs/run-1/actions/apply");
  });

  it("reads the apply log anonymously from its archivist URL", async () => {
    const { c, calls } = client((call) => {
      if (call.url.pathname === "/api/v2/runs/run-1") {
        return {
          data: {
            id: "run-1",
            type: "runs",
            attributes: { status: "applied" },
            relationships: {
              plan: { data: { id: "plan-1", type: "plans" } },
              apply: { data: { id: "apply-1", type: "applies" } },
            },
          },
        };
      }
      if (call.url.pathname === "/api/v2/applies/apply-1") {
        return {
          data: {
            id: "apply-1",
            type: "applies",
            attributes: { "log-read-url": "https://archivist.terraform.io/v1/object/secret" },
          },
        };
      }
      expect(call.url.host).toBe("archivist.terraform.io");
      expect(call.headers["Authorization"]).toBeUndefined();
      return "line1\nline2\nline3\n";
    });
    const out = await c.getLogs("run", `${ACC}:run:run-1`, ACC, { tailLines: 2 });
    expect(out).toMatchObject({
      containers: ["plan", "apply"],
      activeContainer: "apply",
      text: "line2\nline3\n",
    });
    expect(calls).toHaveLength(3);
  });
});

describe("create and update", () => {
  it("creates a VCS-connected workspace in a project", async () => {
    const { c, calls } = client(() => ({ status: 201, body: { data: { ...WS } } }));
    await c.createResource("workspace", ACC, {
      name: "net-prod",
      project: "prj-1",
      executionMode: "remote",
      oauthToken: "ot-1",
      repository: "acme/infra",
      branch: "main",
    });
    expect(calls[0]!.body).toMatchObject({
      data: {
        type: "workspaces",
        attributes: {
          name: "net-prod",
          "execution-mode": "remote",
          "vcs-repo": { "oauth-token-id": "ot-1", identifier: "acme/infra", branch: "main" },
        },
        relationships: { project: { data: { type: "projects", id: "prj-1" } } },
      },
    });
  });

  it("keeps a sensitive variable's value unless a new one is typed", async () => {
    const { c, calls } = client((call) =>
      call.method === "PATCH"
        ? { data: {} }
        : call.url.pathname.endsWith("/vars")
          ? { data: [{ id: "var-1", type: "vars", attributes: { key: "k", sensitive: true } }] }
          : { data: WS },
    );
    await c.updateResource("variable", `${ACC}:variable:ws-1/var-1`, ACC, {
      value: "",
      description: "d",
    });
    const patch = calls.find((x) => x.method === "PATCH")!;
    expect(patch.url.pathname).toBe("/api/v2/workspaces/ws-1/vars/var-1");
    expect(
      (patch.body as { data: { attributes: Record<string, unknown> } }).data.attributes,
    ).toEqual({ description: "d" });
  });

  it("deletes workspaces safely", async () => {
    const { c, calls } = client(() => ({ status: 204, body: "" }));
    await c.deleteResource("workspace", `${ACC}:workspace:ws-1`, ACC);
    expect(calls[0]!.url.pathname).toBe("/api/v2/workspaces/ws-1/actions/safe-delete");
  });

  it("keeps a new agent token as a secret output", async () => {
    const secrets = new Map<string, string>();
    const { c } = client(
      () => ({
        status: 201,
        body: {
          data: {
            id: "at-1",
            type: "authentication-tokens",
            attributes: { description: "k8s", token: "SECRET" },
          },
        },
      }),
      {},
      secrets,
    );
    const res = (await c.createResource(
      "agent-token",
      ACC,
      { description: "k8s" },
      `${ACC}:agent-pool:apool-1`,
    )) as {
      resource: { id: string };
    };
    expect(await c.resolveOutput("agent-token", res.resource.id, "token", ACC)).toBe("SECRET");
  });
});

describe("cost, quotas, metrics", () => {
  it("reads invoices as one row each, skipping drafts and paging with the continuation", async () => {
    let n = 0;
    const { http } = makeHttp((call) => {
      if (n++ === 0) {
        expect(call.url.searchParams.get("cursor")).toBeNull();
        return {
          data: [
            {
              id: "in_2",
              type: "billing-invoices",
              attributes: {
                "created-at": "2026-09-01T19:00:00Z",
                total: 21000,
                status: "paid",
                number: "A-2",
              },
            },
            {
              id: "in_d",
              type: "billing-invoices",
              attributes: { "created-at": "2026-08-15T19:00:00Z", total: 5, status: "draft" },
            },
          ],
          meta: { continuation: "in_d" },
        };
      }
      expect(call.url.searchParams.get("cursor")).toBe("in_d");
      return {
        data: [
          {
            id: "in_1",
            type: "billing-invoices",
            attributes: { "created-at": "2026-01-01T19:00:00Z", total: 100, status: "paid" },
          },
        ],
        meta: { continuation: null },
      };
    });
    const rows = await fetchInvoiceCost(
      { token: "t", hostname: "app.terraform.io", http },
      "acme",
      { fromDate: "2026-06-01", toDate: "2026-10-31" },
    );
    expect(rows).toEqual([
      {
        date: "2026-09-01",
        service: "HCP Terraform",
        resourceId: "acme",
        tags: { invoice: "A-2", status: "paid" },
        currency: "USD",
        amount: 210,
      },
    ]);
  });

  it("returns no cost where invoices do not exist", async () => {
    const { http } = makeHttp(() => ({ status: 404, body: { errors: ["not found"] } }));
    expect(
      await fetchInvoiceCost({ token: "t", hostname: "tfe.example.com", http }, "acme", {
        fromDate: "2026-01-01",
        toDate: "2026-02-01",
      }),
    ).toEqual([]);
  });

  it("reports only quotas the plan states", async () => {
    const { c } = client((call) => {
      if (call.url.pathname.endsWith("/entitlement-set")) {
        return {
          data: {
            id: "e",
            type: "entitlement-sets",
            attributes: { "user-limit": 5, "policy-set-limit": null, "run-task-limit": 1 },
          },
        };
      }
      return {
        data: [{ id: "x", type: "y", attributes: {} }],
        meta: { pagination: { "total-count": call.url.pathname.endsWith("/tasks") ? 1 : 3 } },
      };
    });
    const q = await c.fetchQuotas(ACC);
    expect(q.map((x) => [x.id, x.used, x.limit])).toEqual([
      ["user-limit", 3, 5],
      ["run-task-limit", 1, 1],
    ]);
  });

  it("folds runs into daily series", () => {
    const run = (status: string, created: string, end: string, plan?: string) => ({
      id: created,
      type: "runs",
      attributes: { status, "created-at": created, "status-timestamps": { "finished-at": end } },
      relationships: plan ? { plan: { data: { id: plan, type: "plans" } } } : {},
    });
    const series = runSeries(
      [
        run("applied", "2026-10-01T01:00:00Z", "2026-10-01T01:02:00Z", "p1"),
        run("errored", "2026-10-01T02:00:00Z", "2026-10-01T02:00:30Z"),
      ],
      new Map([
        ["p1", { "resource-additions": 2, "resource-changes": 1, "resource-destructions": 0 }],
      ]),
      86_400_000,
    );
    const by = Object.fromEntries(series.map((x) => [x.label, x.points[0]!.value]));
    expect(by).toMatchObject({
      Runs: 2,
      "Errored runs": 1,
      "Applied runs": 1,
      "Resources added": 2,
      "Run duration p95": 120,
    });
  });
});

describe("status feed", () => {
  it("keeps unresolved Terraform incidents only", () => {
    expect(isTerraformIncident("Delayed HCP Terraform Runs")).toBe(true);
    expect(isTerraformIncident("Terraform AWS Provider v6.59.0 errors")).toBe(false);
    expect(isTerraformIncident("Terraform Registry slow")).toBe(false);
    expect(isTerraformIncident("HCP Vault degraded")).toBe(false);
    const body = JSON.stringify({
      incidents: [
        {
          id: "1",
          name: "Delayed HCP Terraform Runs",
          status: "investigating",
          impact: "minor",
          created_at: "2026-10-01T00:00:00Z",
          components: [],
        },
        {
          id: "2",
          name: "HCP Terraform Returning 404s",
          status: "resolved",
          impact: "major",
          created_at: "2026-09-01T00:00:00Z",
          resolved_at: "2026-09-01T01:00:00Z",
          components: [],
        },
        {
          id: "3",
          name: "HCP Vault cluster updates",
          status: "monitoring",
          impact: "minor",
          created_at: "2026-10-01T00:00:00Z",
          components: [],
        },
      ],
    });
    const out = parseStatusFeed(body);
    expect(out.map((i) => i.externalId)).toEqual(["1"]);
    expect(out[0]).toMatchObject({ providerWide: true, services: ["HCP Terraform"] });
  });
});

describe("terraform export", () => {
  const base = {
    pluginId: "hcp-terraform",
    accountId: ACC,
    resolvedOutputs: {},
    secretStates: [],
    createdAt: "",
    updatedAt: "",
  };
  it("maps a workspace with its project and imports by id", () => {
    const out = tfeTerraformExport.mapResource({
      ...base,
      id: `${ACC}:workspace:ws-1`,
      resourceTypeId: "workspace",
      displayName: "net-prod",
      externalId: "ws-1",
      fields: {
        name: "net-prod",
        organization: "acme",
        projectId: "prj-1",
        autoApply: true,
        workspaceId: "ws-1",
      },
    });
    expect(out!.resource).toMatchObject({ type: "tfe_workspace", importId: "ws-1" });
    expect(out!.resource.attributes["project_id"]).toEqual({ kind: "string", value: "prj-1" });
    expect(out!.resource.attributes["auto_apply"]).toEqual({ kind: "bool", value: true });
  });

  it("turns a sensitive variable into a Terraform variable and imports by org/workspace/id", () => {
    const out = tfeTerraformExport.mapResource({
      ...base,
      id: "x",
      resourceTypeId: "variable",
      displayName: "db_password",
      fields: {
        key: "db_password",
        sensitive: true,
        category: "terraform",
        workspaceId: "ws-1",
        workspaceName: "net-prod",
        organization: "acme",
        variableId: "var-1",
      },
    });
    expect(out!.resource.importId).toBe("acme/net-prod/var-1");
    expect(out!.resource.attributes["value"]).toMatchObject({ kind: "ref" });
    expect(out!.variables?.[0]?.sensitive).toBe(true);
  });
});
