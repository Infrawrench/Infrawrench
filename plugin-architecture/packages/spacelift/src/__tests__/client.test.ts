import { describe, expect, it } from "vitest";
import { gql, normaliseEndpoint, statusForErrors, statusOf } from "../api.js";
import { SpaceliftClient, stackUpdateInput, vendorInput } from "../client.js";
import { runSeries } from "../metrics.js";
import { plugin } from "../plugin.js";
import { mapComponent } from "../status-feed.js";
import { spaceliftTerraformExport } from "../terraform.js";
import type { Call } from "./helpers.js";
import { makeHttp } from "./helpers.js";

const ACC = "acc";
const jwt = (expSecs: number) => `x.${btoa(JSON.stringify({ exp: expSecs }))}.y`;

/** Routes GraphQL calls by operation text; answers the key exchange itself. */
function graph(route: (query: string, vars: Record<string, unknown>, call: Call) => unknown) {
  return makeHttp((call) => {
    const body = call.body as { query: string; variables: Record<string, unknown> };
    if (body.query.includes("apiKeyUser"))
      return { data: { apiKeyUser: { jwt: jwt(Math.floor(Date.now() / 1000) + 3600) } } };
    const out = route(body.query, body.variables ?? {}, call);
    return out &&
      typeof out === "object" &&
      ("data" in (out as object) || "errors" in (out as object))
      ? out
      : { data: out };
  });
}

function client(route: (query: string, vars: Record<string, unknown>, call: Call) => unknown) {
  const { http, calls } = graph(route);
  return {
    c: new SpaceliftClient({ endpoint: "acme", apiKeyId: "id", apiKeySecret: "sec" }, {
      http,
    } as never),
    calls,
  };
}

describe("api", () => {
  it("normalises account names, hosts and URLs", () => {
    expect(normaliseEndpoint("acme")).toBe("https://acme.app.spacelift.io/graphql");
    expect(normaliseEndpoint("https://acme.app.us.spacelift.io/graphql")).toBe(
      "https://acme.app.us.spacelift.io/graphql",
    );
    expect(normaliseEndpoint("spacelift.example.com/")).toBe(
      "https://spacelift.example.com/graphql",
    );
    expect(() => normaliseEndpoint("")).toThrow(/account name/);
  });

  it("exchanges the key once, caches the JWT and sends it as a bearer", async () => {
    const { http, calls } = graph((q, _v, call) => {
      expect(call.headers["Authorization"]).toMatch(/^Bearer x\./);
      return { stacks: [] };
    });
    const ctx = {
      endpoint: "https://acme.app.spacelift.io/graphql",
      keyId: "id",
      keySecret: "sec",
      http,
    };
    await gql(ctx, "a", "{ stacks { id } }");
    await gql(ctx, "b", "{ stacks { id } }");
    expect(calls.filter((c) => JSON.stringify(c.body).includes("apiKeyUser"))).toHaveLength(1);
    expect((calls[0]!.body as { variables: unknown }).variables).toEqual({
      id: "id",
      secret: "sec",
    });
  });

  it("re-exchanges the key when the JWT is refused", async () => {
    let n = 0;
    const { http, calls } = graph(() =>
      n++ === 0 ? { errors: [{ message: "unauthorized" }] } : { ok: true },
    );
    const ctx = {
      endpoint: "https://acme.app.spacelift.io/graphql",
      keyId: "id",
      keySecret: "sec",
      http,
    };
    expect(await gql<{ ok: boolean }>(ctx, "x", "{ ok }")).toEqual({ ok: true });
    expect(calls.filter((c) => JSON.stringify(c.body).includes("apiKeyUser"))).toHaveLength(2);
  });

  it("maps GraphQL errors to statuses", async () => {
    expect(statusForErrors([{ message: "stack not found" }])).toBe(404);
    expect(statusForErrors([{ message: "forbidden: you do not have permission" }])).toBe(403);
    const { http } = graph(() => ({ errors: [{ message: "could not find stack x" }] }));
    const err = await gql(
      { endpoint: "https://a.app.spacelift.io/graphql", keyId: "i", keySecret: "s", http },
      "stack",
      "{ x }",
    ).catch((e: unknown) => e);
    expect(statusOf(err)).toBe(404);
  });

  it("explains a rejected key", async () => {
    const { http } = makeHttp(() => ({ data: { apiKeyUser: null } }));
    const err = await gql(
      { endpoint: "https://a.app.spacelift.io/graphql", keyId: "i", keySecret: "s", http },
      "x",
      "{ x }",
    ).catch((e: unknown) => e);
    expect(statusOf(err)).toBe(401);
  });
});

describe("listing", () => {
  it("falls back to the minimal stack selection when the full one is refused", async () => {
    const { c } = client((q) => {
      if (q.includes("trackedCommit"))
        return { errors: [{ message: 'Cannot query field "trackedCommit"' }] };
      return {
        stacks: [{ id: "net", name: "Net", space: "root", repository: "infra", branch: "main" }],
      };
    });
    const [s] = await c.listResources("stack", ACC);
    expect(s).toMatchObject({ externalId: "net", parentResourceId: `${ACC}:space:root` });
    expect(s!.resolvedOutputs["url"]).toBe("https://acme.app.spacelift.io/stack/net");
  });

  it("lists recent runs from run search, skipping modules", async () => {
    const { c, calls } = client(() => ({
      searchRuns: {
        edges: [
          {
            node: {
              run: {
                id: "R1",
                state: "FINISHED",
                type: "TRACKED",
                title: "Add VPC",
                createdAt: 1790000000,
                delta: { addCount: 2 },
              },
              stack: { id: "net", name: "Net" },
              isModule: false,
            },
          },
          {
            node: {
              run: { id: "R2", state: "FAILED" },
              stack: { id: "mod", name: "Mod" },
              isModule: true,
            },
          },
        ],
      },
    }));
    const runs = await c.listResources("run", ACC);
    expect(runs.map((r) => r.externalId)).toEqual(["net/R1"]);
    expect(runs[0]!.fields).toMatchObject({ toAdd: 2, state: "FINISHED" });
    const vars = (calls.at(-1)!.body as { variables: { input: unknown } }).variables.input;
    expect(vars).toMatchObject({ first: 50, orderBy: { field: "createdAt", direction: "DESC" } });
  });

  it("hides secret context values", async () => {
    const { c } = client(() => ({
      contexts: [
        {
          id: "aws",
          name: "AWS",
          config: [
            {
              id: "AWS_REGION",
              type: "ENVIRONMENT_VARIABLE",
              value: "eu-west-1",
              writeOnly: false,
            },
            { id: "AWS_SECRET", type: "ENVIRONMENT_VARIABLE", value: null, writeOnly: true },
          ],
        },
      ],
    }));
    const vars = await c.listResources("context-variable", ACC);
    expect(vars.map((v) => [v.externalId, v.resolvedOutputs["value"]])).toEqual([
      ["aws/AWS_REGION", "eu-west-1"],
      ["aws/AWS_SECRET", undefined],
    ]);
  });
});

describe("logs", () => {
  it("reads each phase with logs, oldest first, following tokens", async () => {
    const { c } = client((q, v) => {
      if (q.includes("history")) {
        return {
          stack: {
            run: {
              history: [
                { state: "FINISHED", stateVersion: 1, hasLogs: false },
                { state: "PLANNING", stateVersion: 1, hasLogs: true },
                { state: "INITIALIZING", stateVersion: 1, hasLogs: true },
              ],
            },
          },
        };
      }
      if (v["state"] === "PLANNING" && !v["token"])
        return {
          stack: {
            run: { logs: { messages: [{ message: "plan 1" }], hasMore: true, nextToken: "t" } },
          },
        };
      if (v["state"] === "PLANNING")
        return {
          stack: {
            run: { logs: { messages: [{ message: "\u001b[1mplan 2\u001b[0m" }], hasMore: false } },
          },
        };
      return { stack: { run: { logs: { messages: [{ message: "init" }], hasMore: false } } } };
    });
    const out = await c.getLogs("run", `${ACC}:run:net/R1`, ACC, { tailLines: 100 });
    expect(out.containers).toEqual(["all", "initializing", "planning"]);
    expect(out.text).toBe("== INITIALIZING\ninit\n== PLANNING\nplan 1\nplan 2\n");
  });
});

describe("updates", () => {
  const current = {
    name: "Net",
    space: "root",
    repository: "infra",
    branch: "main",
    labels: ["a"],
    autodeploy: false,
    hooks: { beforeInit: ["echo hi"] },
    vendorConfig: {
      __typename: "StackConfigVendorOpenTofu",
      version: "1.8.0",
      openTofuWorkflowTool: "OPEN_TOFU",
      workspace: null,
    },
    workerPool: { id: "pool" },
    vcsIntegration: { id: "gh" },
  };

  it("rebuilds the full stack input so untouched settings survive", () => {
    const input = stackUpdateInput(current, { branch: "release", labels: "x, y" });
    expect(input).toMatchObject({
      name: "Net",
      branch: "release",
      labels: ["x", "y"],
      beforeInit: ["echo hi"],
      afterApply: [],
      workerPool: "pool",
      vcsIntegrationId: "gh",
      vendorConfig: { opentofu: { version: "1.8.0", workflowTool: "OPEN_TOFU" } },
    });
  });

  it("maps every vendor typename", () => {
    expect(
      vendorInput({ __typename: "StackConfigVendorPulumi", loginURL: "s3://x", stackName: "dev" }),
    ).toEqual({ pulumi: { loginURL: "s3://x", stackName: "dev" } });
    expect(vendorInput({ __typename: "StackConfigVendorTerraform", version: "1.5.7" })).toEqual({
      terraform: { version: "1.5.7" },
    });
    expect(vendorInput(undefined)).toBeUndefined();
  });

  it("deletes stacks without destroying resources", async () => {
    const { c, calls } = client(() => ({ stackDelete: { id: "net" } }));
    await c.deleteResource("stack", `${ACC}:stack:net`, ACC);
    expect((calls.at(-1)!.body as { query: string }).query).not.toContain("destroyResources");
  });

  it("falls back to creating drift detection when there is none to update", async () => {
    const { c, calls } = client((q) =>
      q.includes("DriftDetectionUpdate")
        ? { errors: [{ message: "drift detection integration not found" }] }
        : { ok: 1 },
    );
    await c.executeNoSqlCommand("stack", `${ACC}:stack:net`, ACC, "drift", [
      JSON.stringify({ schedule: "0 * * * *, 30 * * * *", reconcile: "true" }),
    ]);
    const last = calls.at(-1)!.body as { query: string; variables: { input: unknown } };
    expect(last.query).toContain("stackIntegrationDriftDetectionCreate");
    expect(last.variables.input).toEqual({
      schedule: ["0 * * * *", "30 * * * *"],
      timezone: "UTC",
      reconcile: true,
      ignoreState: false,
    });
  });
});

describe("quotas and state", () => {
  it("reports run minutes against the plan", async () => {
    const { c } = client((q) =>
      q.includes("runMinutesUsage")
        ? { runMinutesUsage: { totals: { publicMinutes: 100, privateMinutes: 20 } } }
        : { usage: { allowedMinutes: 500, billingPeriodStart: 1790000000 } },
    );
    expect(await c.fetchQuotas(ACC)).toEqual([
      {
        id: "run-minutes",
        service: "Spacelift",
        name: "Run minutes this billing period",
        limit: 500,
        used: 120,
        unit: "minutes",
      },
    ]);
  });

  it("downloads state from the presigned URL without the token", async () => {
    const { http, calls } = graph(() => ({
      stateDownloadUrl: { url: "https://bucket.s3.amazonaws.com/state?sig=1" },
    }));
    const original = http.request.bind(http);
    http.request = async (req) =>
      req.url.startsWith("https://bucket")
        ? { status: 200, headers: {}, body: '{"version":4}' }
        : original(req);
    const c = new SpaceliftClient({ endpoint: "acme", apiKeyId: "id", apiKeySecret: "sec" }, {
      http,
    } as never);
    const out = await c.exportCredential("stack", `${ACC}:stack:net`, ACC, "state");
    expect(out.content).toBe('{"version":4}');
    expect(calls.some((x) => x.url.host === "bucket.s3.amazonaws.com")).toBe(false);
  });
});

describe("misc", () => {
  it("folds runs into series", () => {
    const day = Date.UTC(2026, 9, 1) / 1000;
    const s = runSeries(
      [
        { id: "a", state: "FAILED", type: "TRACKED", createdAt: day + 5 },
        {
          id: "b",
          state: "FINISHED",
          type: "PROPOSED",
          createdAt: day + 9,
          driftDetection: true,
          delta: { addCount: 1 },
        },
      ],
      day * 1000 - 1,
      day * 1000 + 86_400_000,
    );
    const by = Object.fromEntries(s.map((x) => [x.label, x.points[0]!.value]));
    expect(by).toMatchObject({
      Runs: 2,
      "Failed runs": 1,
      "Tracked runs": 1,
      "Drift detection runs": 1,
      "Resources to add": 1,
    });
  });

  it("maps status components", () => {
    expect(mapComponent("GraphQL API")).toMatchObject({ providerWide: true });
    expect(mapComponent("API")).toBeNull();
  });

  it("refuses private endpoints on the server", () => {
    expect(plugin.validateServerCredentials!({ endpoint: "10.1.2.3" })).toMatch(/private/);
    expect(plugin.validateServerCredentials!({ endpoint: "acme" })).toBeNull();
  });

  it("exports a secret context variable through a variable", () => {
    const out = spaceliftTerraformExport.mapResource({
      id: "x",
      pluginId: "spacelift",
      resourceTypeId: "context-variable",
      accountId: ACC,
      displayName: "AWS_SECRET",
      fields: { name: "AWS_SECRET", contextId: "aws", writeOnly: true, type: "env" },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    });
    expect(out!.resource).toMatchObject({
      type: "spacelift_environment_variable",
      importId: "context/aws/AWS_SECRET",
    });
    expect(out!.resource.attributes["value"]).toMatchObject({ kind: "ref" });
  });
});
