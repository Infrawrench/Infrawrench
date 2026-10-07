import { describe, expect, it } from "vitest";
import { bkFetch, bkPaged, cleanLog, nextLink, statusOf } from "../api.js";
import { BuildkiteClient, pipelineBody, tailLines } from "../client.js";
import { countSteps, linesToEnv, toIso } from "../mappers.js";
import { buildSeries } from "../metrics.js";
import { plugin } from "../plugin.js";
import { policyTemplate } from "../preflight.js";
import { mapComponent } from "../status-feed.js";
import { buildkiteTerraformExport } from "../terraform.js";
import type { Call } from "./helpers.js";
import { makeHttp } from "./helpers.js";

const ACC = "acc";
const API = "https://api.buildkite.com/v2";

function client(route: (call: Call) => unknown, secrets?: Map<string, string>) {
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
  const c = new BuildkiteClient({ apiToken: "bkua_test", organization: "acme" }, services as never);
  c.setSleep(async () => {});
  return { c, calls };
}

describe("api", () => {
  it("sends the token as a bearer and follows Link pagination on the API host only", async () => {
    const { http, calls } = makeHttp((call) => {
      expect(call.headers["Authorization"]).toBe("Bearer t");
      if (call.url.searchParams.get("page") === "2") {
        return {
          body: [{ id: "b" }],
          headers: { Link: `<https://evil.example.com/v2/x?page=3>; rel="next"` },
        };
      }
      expect(call.url.searchParams.get("per_page")).toBe("100");
      return {
        body: [{ id: "a" }],
        headers: {
          link: `<${API}/organizations/acme/pipelines?page=2&per_page=100>; rel="next", <${API}/organizations/acme/pipelines?page=2>; rel="last"`,
        },
      };
    });
    const items = await bkPaged<{ id: string }>(
      { token: "t", http },
      "/organizations/acme/pipelines",
    );
    expect(items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(calls).toHaveLength(2);
  });

  it("attaches the HTTP status and Buildkite's message to errors", async () => {
    const { http } = makeHttp(() => ({
      status: 422,
      body: { message: "Validation Failed", errors: [{ field: "configuration", code: "missing" }] },
    }));
    const err = await bkFetch({ token: "t", http }, "/organizations/acme/pipelines").catch(
      (e) => e,
    );
    expect(statusOf(err)).toBe(422);
    expect(String((err as Error).message)).toContain("Validation Failed - configuration: missing");
  });

  it("waits out one 429 using the reset header, then retries", async () => {
    let n = 0;
    const waits: number[] = [];
    const { http } = makeHttp(() =>
      n++ === 0 ? { status: 429, headers: { "RateLimit-User-Reset": "3" }, body: {} } : { ok: 1 },
    );
    const res = await bkFetch<{ ok: number }>(
      { token: "t", http, sleep: async (ms) => void waits.push(ms) },
      "/user",
    );
    expect(res.ok).toBe(1);
    expect(waits).toEqual([3000]);
  });

  it("parses Link headers", () => {
    expect(nextLink(`<${API}/a?page=2>; rel="next"`)).toBe(`${API}/a?page=2`);
    expect(nextLink(`<${API}/a?page=1>; rel="prev"`)).toBeUndefined();
  });

  it("strips ANSI codes and timestamp markers from logs", () => {
    const raw = "\u001b_bk;t=1700000000000\u0007\u001b[32mok\u001b[0m line\r\nnext";
    expect(cleanLog(raw)).toBe("ok line\nnext");
    expect(tailLines("a\nb\nc\n", 2)).toBe("b\nc\n");
  });
});

describe("organization picker", () => {
  it("lists organizations by slug", async () => {
    const { http } = makeHttp(() => [
      { id: "1", name: "Zeta", slug: "zeta" },
      { id: "2", name: "Acme", slug: "acme" },
    ]);
    const opts = await plugin.listCredentialOptions!("organization", { apiToken: "t" }, {
      http,
    } as never);
    expect(opts).toEqual([
      { id: "acme", label: "Acme", description: "acme" },
      { id: "zeta", label: "Zeta", description: "zeta" },
    ]);
  });

  it("explains a rejected token", async () => {
    const { http } = makeHttp(() => ({ status: 401, body: { message: "Unauthorized" } }));
    await expect(
      plugin.listCredentialOptions!("organization", { apiToken: "t" }, { http } as never),
    ).rejects.toThrow(/read_organizations/);
  });
});

const BUILD = {
  id: "b-1",
  number: 42,
  state: "failed",
  branch: "main",
  commit: "abc",
  message: "Fix things\n\nlong body",
  created_at: "2026-10-01T10:00:00Z",
  started_at: "2026-10-01T10:00:30Z",
  finished_at: "2026-10-01T10:05:30Z",
  pipeline: { slug: "web", name: "Web" },
  jobs: [
    { id: "w", type: "waiter" },
    {
      id: "j1",
      type: "script",
      name: ":rspec: Tests",
      state: "failed",
      exit_status: 1,
      runnable_at: "2026-10-01T10:00:00Z",
      started_at: "2026-10-01T10:01:00Z",
      finished_at: "2026-10-01T10:05:00Z",
      agent: { id: "ag1", name: "agent-1" },
    },
  ],
};

describe("listing", () => {
  it("lists recent builds and their jobs from one organization builds call", async () => {
    const { c, calls } = client((call) => {
      expect(call.url.pathname).toBe("/v2/organizations/acme/builds");
      return [BUILD];
    });
    const builds = await c.listResources("build", ACC);
    const jobs = await c.listResources("job", ACC);
    expect(calls).toHaveLength(1);
    expect(builds[0]).toMatchObject({
      externalId: "web/42",
      parentResourceId: `${ACC}:pipeline:web`,
      displayName: "Web #42 Fix things",
    });
    expect(builds[0]!.fields).toMatchObject({ durationSecs: 300, waitSecs: 60, failedJobs: 1 });
    expect(jobs.map((j) => j.externalId)).toEqual(["web/42/j1"]);
    expect(jobs[0]!.fields).toMatchObject({ agentId: "ag1", exitStatus: 1, waitSecs: 60 });
  });

  it("counts agents per queue from the agents' web URLs", async () => {
    const { c } = client((call) => {
      switch (call.url.pathname) {
        case "/v2/organizations/acme/clusters":
          return [{ id: "c1", name: "Prod", graphql_id: "Q2x1" }];
        case "/v2/organizations/acme/agents":
          return [
            {
              id: "a1",
              name: "a1",
              web_url: "https://buildkite.com/organizations/acme/clusters/c1/queues/q1/agents/a1",
            },
            {
              id: "a2",
              name: "a2",
              web_url: "https://buildkite.com/organizations/acme/clusters/c1/queues/q1/agents/a2",
            },
          ];
        case "/v2/organizations/acme/clusters/c1/queues":
          return [
            { id: "q1", key: "default", dispatch_paused: false },
            {
              id: "q2",
              key: "gpu",
              hosted: true,
              hosted_agents: { instance_shape: { name: "LINUX_AMD64_4X16", cpu: 4, memory: 16 } },
            },
          ];
        default:
          throw new Error(`unexpected ${call.url}`);
      }
    });
    const queues = await c.listResources("queue", ACC);
    expect(queues.map((q) => [q.externalId, q.fields["agentCount"]])).toEqual([
      ["c1/q1", 2],
      ["c1/q2", 0],
    ]);
    expect(queues[1]!.fields).toMatchObject({
      hosted: true,
      instanceShape: "LINUX_AMD64_4X16",
      vcpus: 4,
    });
    expect(queues[0]!.fields["clusterGraphqlId"]).toBe("Q2x1");
  });

  it("returns no templates for an organization without the Enterprise feature", async () => {
    const { c } = client(() => ({ status: 403, body: { message: "Forbidden" } }));
    expect(await c.listResources("pipeline-template", ACC)).toEqual([]);
  });

  it("lists flaky tests with the versioned Test Engine header", async () => {
    const { c, calls } = client((call) => {
      if (call.url.pathname === "/v2/analytics/organizations/acme/suites") {
        return [{ id: "s", slug: "rspec", name: "RSpec" }];
      }
      expect(call.headers["Buildkite-Version"]).toBe("2026-08-01");
      expect(call.url.searchParams.get("labels")).toBe("flaky");
      return [
        {
          id: "t1",
          name: "works",
          scope: "User",
          reliability: 0.875,
          executions_count: 8,
          executions_count_by_result: { passed: 7, failed: 1 },
        },
      ];
    });
    const tests = await c.listResources("test", ACC);
    expect(tests[0]).toMatchObject({ externalId: "rspec/t1", displayName: "User works" });
    expect(tests[0]!.fields).toMatchObject({ reliability: 87.5, failed: 1 });
    expect(calls).toHaveLength(2);
  });
});

describe("logs", () => {
  it("tails a job log with a suffix range and drops the partial first line", async () => {
    const { c } = client((call) => {
      expect(call.url.pathname).toBe("/v2/organizations/acme/jobs/j1/log");
      expect(call.headers["Accept"]).toBe("text/plain");
      expect(call.headers["Range"]).toBe("bytes=-480");
      return { status: 206, body: "tial\n\u001b[31mone\u001b[0m\ntwo\nthree\n" };
    });
    const out = await c.getLogs("job", `${ACC}:job:web/42/j1`, ACC, { tailLines: 2 });
    expect(out.text).toBe("two\nthree\n");
  });

  it("treats 416 as an empty log", async () => {
    const { c } = client(() => ({ status: 416, body: "" }));
    const out = await c.getLogs("job", `${ACC}:job:web/42/j1`, ACC, { tailLines: 10 });
    expect(out.text).toBe("");
  });
});

describe("create and update", () => {
  it("creates a pipeline in a cluster with a team and default steps", async () => {
    const { c, calls } = client((call) => {
      expect(call.method).toBe("POST");
      return { id: "p", name: "Web", slug: "web", repository: "git@x:y.git" };
    });
    await c.createResource("pipeline", ACC, {
      name: "Web",
      repository: "git@x:y.git",
      cluster: "c1",
      team: "t1",
      teamAccess: "build_and_read",
      configuration: "",
    });
    expect(calls[0]!.body).toMatchObject({
      name: "Web",
      repository: "git@x:y.git",
      cluster_id: "c1",
      teams: { t1: "build_and_read" },
    });
    expect((calls[0]!.body as { configuration: string }).configuration).toContain(
      "buildkite-agent pipeline upload",
    );
  });

  it("maps pipeline edits to the API's names", () => {
    expect(
      pipelineBody({
        skipQueuedBranchBuilds: "true",
        branchConfiguration: "",
        defaultTimeoutMinutes: "30",
        tags: "a, b",
      }),
    ).toEqual({
      skip_queued_branch_builds: true,
      branch_configuration: null,
      default_command_step_timeout: 30,
      tags: ["a", "b"],
    });
    expect(() => pipelineBody({ maximumTimeoutMinutes: "x" })).toThrow(/whole minutes/);
  });

  it("keeps a new agent token's value as a secret and resolves it as an output", async () => {
    const secrets = new Map<string, string>();
    const { c } = client(
      () => ({ status: 201, body: { id: "tok", description: "linux", token: "SECRET" } }),
      secrets,
    );
    const res = (await c.createResource(
      "agent-token",
      ACC,
      { description: "linux" },
      `${ACC}:cluster:c1`,
    )) as {
      resource: { id: string };
      warnings: unknown[];
    };
    expect(res.warnings).toEqual([]);
    expect(res.resource.id).toBe(`${ACC}:agent-token:c1/tok`);
    expect(await c.resolveOutput("agent-token", res.resource.id, "token", ACC)).toBe("SECRET");
  });

  it("sends a cluster secret's new value to the value endpoint", async () => {
    const { c, calls } = client((call) =>
      call.method === "GET" ? { id: "s1", key: "K" } : { id: "s1", key: "K" },
    );
    await c.updateResource("cluster-secret", `${ACC}:cluster-secret:c1/s1`, ACC, {
      value: "new",
      description: "d",
    });
    const writes = calls.filter((x) => x.method === "PUT").map((x) => x.url.pathname);
    expect(writes).toEqual([
      "/v2/organizations/acme/clusters/c1/secrets/s1",
      "/v2/organizations/acme/clusters/c1/secrets/s1/value",
    ]);
  });

  it("parses KEY=value environment lines", () => {
    expect(linesToEnv("A=1\n# note\nB=x=y")).toEqual({ A: "1", B: "x=y" });
    expect(() => linesToEnv("nope")).toThrow(/KEY=value/);
  });
});

describe("actions", () => {
  it("retries a job from a build's table through the org-scoped route", async () => {
    const { c, calls } = client(() => ({}));
    await c.invokeAction("build", `${ACC}:build:web/42`, "retry-job:j1", ACC);
    await c.invokeAction("build", `${ACC}:build:web/42`, "rebuild", ACC);
    expect(calls.map((x) => `${x.method} ${x.url.pathname}`)).toEqual([
      "PUT /v2/organizations/acme/jobs/j1/retry",
      "PUT /v2/organizations/acme/pipelines/web/builds/42/rebuild",
    ]);
  });

  it("pauses an agent with a note and timeout", async () => {
    const { c, calls } = client(() => ({ status: 204 }));
    await c.executeNoSqlCommand("agent", `${ACC}:agent:a1`, ACC, "pauseAgent", [
      JSON.stringify({ note: "disk", timeoutMinutes: "30" }),
    ]);
    expect(calls[0]!.body).toEqual({ note: "disk", timeout_in_minutes: 30 });
  });
});

describe("preflight", () => {
  it("compares the token's scopes", async () => {
    const { c } = client(() => ({
      scopes: ["read_organizations", "read_pipelines", "read_builds"],
      user: { email: "a@b.c" },
    }));
    const res = await c.verifyCredentials();
    expect(res.identity).toBe("a@b.c");
    expect(res.checks.find((x) => x.capabilityId === "resources")!.status).toBe("ok");
    expect(res.checks.find((x) => x.capabilityId === "logs")!.status).toBe("missing");
  });

  it("builds a token link with the chosen scopes", () => {
    const t = policyTemplate(["logs"]);
    expect(t.document).toBe("read_build_logs");
    expect(t.helpLink!.url).toContain("scopes%5B%5D=read_build_logs");
  });
});

describe("mappers and metrics", () => {
  it("normalises Buildkite's two timestamp styles", () => {
    expect(toIso("2013-09-03 13:24:38 UTC")).toBe("2013-09-03T13:24:38.000Z");
    expect(toIso("2015-05-09T21:05:59.874Z")).toBe("2015-05-09T21:05:59.874Z");
  });

  it("counts top-level steps", () => {
    expect(countSteps("steps:\n  - command: a\n    env:\n      - x\n  - wait\n")).toBe(2);
  });

  it("folds builds into daily series", () => {
    const series = buildSeries(
      [BUILD as never, { ...BUILD, state: "passed" } as never],
      86_400_000,
    );
    const byLabel = Object.fromEntries(series.map((s) => [s.label, s.points[0]!.value]));
    expect(byLabel).toMatchObject({
      Builds: 2,
      "Failed builds": 1,
      "Pass rate": 50,
      "Build duration p95": 300,
      "Agent wait p95": 60,
    });
  });

  it("maps status components", () => {
    expect(mapComponent("Agent API")).toMatchObject({ providerWide: true });
    expect(mapComponent("MacOS")!.resourceTypes).toContain("queue");
    expect(mapComponent("Slack Notifications")).toBeNull();
  });
});

describe("terraform", () => {
  it("maps a pipeline with its cluster's GraphQL id and imports by GraphQL id", () => {
    const out = buildkiteTerraformExport.mapResource({
      id: `${ACC}:pipeline:web`,
      pluginId: "buildkite",
      resourceTypeId: "pipeline",
      accountId: ACC,
      displayName: "Web",
      externalId: "web",
      fields: {
        name: "Web",
        repository: "git@x:y.git",
        clusterGraphqlId: "Q2x1",
        visibility: "private",
        graphqlId: "UGlw",
        configuration: "steps: []",
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    });
    expect(out!.resource.type).toBe("buildkite_pipeline");
    expect(out!.resource.importId).toBe("UGlw");
    expect(out!.resource.attributes["cluster_id"]).toEqual({ kind: "string", value: "Q2x1" });
    expect(out!.resource.attributes["visibility"]).toEqual({ kind: "string", value: "PRIVATE" });
  });

  it("never inlines a secret value", () => {
    const out = buildkiteTerraformExport.mapResource({
      id: "x",
      pluginId: "buildkite",
      resourceTypeId: "cluster-secret",
      accountId: ACC,
      displayName: "K",
      fields: { clusterId: "c1", key: "DEPLOY", secretId: "s1" },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    });
    expect(out!.resource.attributes["value_wo"]).toEqual({
      kind: "ref",
      expr: "var.buildkite_secret_deploy",
    });
    expect(out!.resource.importId).toBe("c1/s1");
  });
});
