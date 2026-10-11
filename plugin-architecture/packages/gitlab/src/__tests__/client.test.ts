import { describe, expect, it } from "vitest";
import { GitLabApiError, glPaged, resolveBaseUrl, statusOf } from "../api.js";
import { GitLabClient, cleanTrace, parseListish, splitVariable } from "../client.js";
import { hookEventFlags, parseVariableLines } from "../inputs.js";
import { describeLevels, mapVariable } from "../mappers.js";
import { jobSeries, percentile, pipelineSeries } from "../metrics.js";
import { plugin } from "../plugin.js";
import { parseStatusFeed } from "../status-feed.js";
import { gitlabTerraformExport } from "../terraform.js";
import type { Call } from "./helpers.js";
import { makeHttp, makeSecrets } from "./helpers.js";

const ACC = "acc";

function client(
  route: (call: Call) => unknown,
  creds: Record<string, string> = {},
  extra: object = {},
) {
  const { http, calls } = makeHttp(route);
  const c = new GitLabClient({ url: "https://gitlab.example.com", token: "glpat-x", ...creds }, {
    http,
    ...extra,
  } as never);
  return { c, calls };
}

describe("base URL", () => {
  it("normalises what people paste", () => {
    expect(resolveBaseUrl("")).toBe("https://gitlab.com");
    expect(resolveBaseUrl("gitlab.example.com")).toBe("https://gitlab.example.com");
    expect(resolveBaseUrl("https://gitlab.example.com/api/v4/")).toBe("https://gitlab.example.com");
    expect(resolveBaseUrl("https://example.com/gitlab/")).toBe("https://example.com/gitlab");
    expect(() => resolveBaseUrl("ftp://x")).toThrow(/https/);
    expect(() => resolveBaseUrl("https://user:pw@gitlab.com")).toThrow(/token field/);
  });

  it("refuses plain http on the cloud host", () => {
    expect(plugin.validateServerCredentials!({ url: "http://10.0.0.1" })).toMatch(/https/);
    expect(plugin.validateServerCredentials!({ url: "gitlab.com" })).toBeNull();
  });
});

describe("transport", () => {
  it("sends PRIVATE-TOKEN and follows X-Next-Page", async () => {
    const { http, calls } = makeHttp((call) => {
      expect(call.headers["PRIVATE-TOKEN"]).toBe("tok");
      const page = call.url.searchParams.get("page");
      expect(call.url.searchParams.get("per_page")).toBe("100");
      return page === "1"
        ? { body: [{ id: 1 }], headers: { "X-Next-Page": "2" } }
        : { body: [{ id: 2 }], headers: { "X-Next-Page": "" } };
    });
    const out = await glPaged<{ id: number }>(
      { baseUrl: "https://g.example", token: "tok", http },
      "/projects",
    );
    expect(out.map((x) => x.id)).toEqual([1, 2]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url.pathname).toBe("/api/v4/projects");
  });

  it("throws with a numeric status and GitLab's message", async () => {
    const { c } = client(() => ({ status: 403, body: { message: "403 Forbidden" } }));
    const err = await c.getResource("runner", "acc:runner:5", ACC).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitLabApiError);
    expect(statusOf(err)).toBe(403);
    expect((err as Error).message).toMatch(/403 Forbidden/);
  });

  it("flattens field-map validation errors", async () => {
    const { c } = client(() => ({
      status: 400,
      body: { message: { key: ["has already been taken"] } },
    }));
    await expect(
      c.createResource("project-variable", ACC, { project: "7", key: "A", value: "v" }),
    ).rejects.toThrow(/key has already been taken/);
  });
});

describe("group picker", () => {
  it("checks the token and lists groups by path", async () => {
    const { http } = makeHttp((call) => {
      if (call.url.pathname === "/api/v4/user") return { id: 1, username: "me" };
      expect(call.url.searchParams.get("min_access_level")).toBe("10");
      return [
        { id: 2, full_path: "acme/platform", name: "platform" },
        { id: 1, full_path: "acme", name: "acme" },
      ];
    });
    const options = await plugin.listCredentialOptions!(
      "group",
      { token: "t", url: "gitlab.com" },
      { http } as never,
    );
    expect(options.map((o) => o.id)).toEqual(["1", "2"]);
  });

  it("explains a rejected token", async () => {
    const { http } = makeHttp(() => ({ status: 401, body: { message: "401 Unauthorized" } }));
    await expect(
      plugin.listCredentialOptions!("group", { token: "t" }, { http } as never),
    ).rejects.toThrow(/expired/);
  });
});

const PROJECT = {
  id: 7,
  name: "api",
  name_with_namespace: "Acme / api",
  path_with_namespace: "acme/api",
  default_branch: "main",
  visibility: "private",
  namespace: { id: 3, full_path: "acme", kind: "group" },
  permissions: { project_access: { access_level: 40 } },
};
const DEV_PROJECT = {
  ...PROJECT,
  id: 8,
  path_with_namespace: "acme/web",
  permissions: { project_access: { access_level: 30 } },
};

describe("listing", () => {
  it("scopes projects to the group and counts open merge requests", async () => {
    const { c, calls } = client(
      (call) => {
        if (call.url.pathname === "/api/v4/groups/3/projects") {
          expect(call.url.searchParams.get("include_subgroups")).toBe("true");
          return [PROJECT];
        }
        if (call.url.pathname === "/api/v4/projects/7/merge_requests") {
          return { body: [{}], headers: { "x-total": "12" } };
        }
        throw new Error(`unexpected ${call.url}`);
      },
      { group: "3" },
    );
    const [p] = await c.listResources("project", ACC);
    expect(p!.fields).toMatchObject({
      openMergeRequests: 12,
      namespaceId: "3",
      defaultBranch: "main",
    });
    expect(p!.resolvedOutputs["pathWithNamespace"]).toBe("acme/api");
    expect(calls.some((x) => x.url.pathname.endsWith("merge_requests"))).toBe(true);
  });

  it("asks for variables only where the user is a maintainer, and never stores values", async () => {
    const asked: string[] = [];
    const { c } = client((call) => {
      if (call.url.pathname === "/api/v4/projects") return [PROJECT, DEV_PROJECT];
      asked.push(call.url.pathname);
      return [
        {
          key: "TOKEN",
          value: "s3cret",
          environment_scope: "review/*",
          protected: true,
          masked: true,
        },
      ];
    });
    const vars = await c.listResources("project-variable", ACC);
    expect(asked).toEqual(["/api/v4/projects/7/variables"]);
    expect(vars[0]!.externalId).toBe("7/TOKEN/review/*");
    expect(JSON.stringify(vars[0])).not.toContain("s3cret");
    expect(vars[0]!.parentResourceId).toBe("acc:project:7");
  });

  it("skips projects that refuse a child listing", async () => {
    const { c } = client((call) => {
      if (call.url.pathname === "/api/v4/projects") return [PROJECT, DEV_PROJECT];
      if (call.url.pathname === "/api/v4/projects/7/environments")
        return { status: 403, body: { message: "no" } };
      return [{ id: 1, name: "production", state: "available", tier: "production" }];
    });
    const envs = await c.listResources("environment", ACC);
    expect(envs.map((e) => e.externalId)).toEqual(["8/1"]);
  });
});

describe("edits", () => {
  it("keeps a variable's current value when only settings change", async () => {
    const { c, calls } = client((call) => {
      if (call.method === "GET" && call.url.pathname === "/api/v4/projects/7/variables/TOKEN") {
        expect(call.url.searchParams.get("filter[environment_scope]")).toBe("production");
        return { key: "TOKEN", value: "old", environment_scope: "production" };
      }
      if (call.method === "PUT") return { key: "TOKEN", environment_scope: "production" };
      if (call.url.pathname === "/api/v4/projects") return [PROJECT];
      throw new Error(`unexpected ${call.method} ${call.url}`);
    });
    await c.updateResource("project-variable", "acc:project-variable:7/TOKEN/production", ACC, {
      protected: "true",
    });
    const put = calls.find((x) => x.method === "PUT")!;
    expect(put.body).toMatchObject({ value: "old", protected: true });
  });

  it("refuses to edit a hidden variable without a new value", async () => {
    const { c } = client(() => ({ key: "TOKEN", value: null }));
    await expect(
      c.updateResource("project-variable", "acc:project-variable:7/TOKEN/*", ACC, {
        masked: "true",
      }),
    ).rejects.toThrow(/hidden/);
  });

  it("re-protects a branch to change push levels, keeping force push", async () => {
    const { c, calls } = client((call) => {
      if (call.url.pathname === "/api/v4/projects") return [PROJECT];
      if (call.method === "DELETE") return { status: 204 };
      return {
        id: 1,
        name: "release/*",
        push_access_levels: [{ access_level: 40 }],
        merge_access_levels: [{ access_level: 30 }],
        allow_force_push: true,
      };
    });
    await c.updateResource("protected-branch", "acc:protected-branch:7/release/*", ACC, {
      pushAccess: "No one",
    });
    expect(calls.map((x) => `${x.method} ${decodeURIComponent(x.url.pathname)}`)).toContain(
      "DELETE /api/v4/projects/7/protected_branches/release/*",
    );
    const post = calls.find((x) => x.method === "POST")!;
    expect(post.body).toMatchObject({
      name: "release/*",
      push_access_level: 0,
      merge_access_level: 30,
      allow_force_push: true,
    });
  });

  it("keeps a new deploy token's secret for the token output", async () => {
    const { secrets, store } = makeSecrets();
    const { c } = client(
      (call) => {
        if (call.url.pathname === "/api/v4/projects") return [PROJECT];
        expect(call.body).toMatchObject({ scopes: ["read_registry"] });
        return {
          id: 9,
          name: "k8s",
          username: "gitlab+deploy-token-9",
          scopes: ["read_registry"],
          token: "gldt-abc",
        };
      },
      {},
      { secrets },
    );
    const created = await c.createResource("deploy-token", ACC, {
      project: "7",
      name: "k8s",
      scopes: '["read_registry"]',
    });
    const resource = "resource" in created ? created.resource : created;
    expect(JSON.stringify(resource)).not.toContain("gldt-abc");
    expect(store.get("acc:deploy-token:7/9|token")).toBe("gldt-abc");
    expect(await c.resolveOutput("deploy-token", "acc:deploy-token:7/9", "token", ACC)).toBe(
      "gldt-abc",
    );
  });

  it("adds a member by username", async () => {
    const { c, calls } = client((call) => {
      if (call.url.pathname === "/api/v4/projects") return [PROJECT];
      if (call.url.pathname === "/api/v4/users") return [{ id: 42, username: "jane" }];
      return { id: 42, username: "jane", access_level: 30 };
    });
    const m = await c.createResource("project-member", ACC, {
      project: "7",
      username: "@jane",
      accessLevel: "Developer",
    });
    expect(calls.find((x) => x.method === "POST")!.body).toEqual({ user_id: 42, access_level: 30 });
    expect(("resource" in m ? m.resource : m).fields["accessLevel"]).toBe("Developer");
  });
});

describe("actions and logs", () => {
  it("routes job actions to the job", async () => {
    const { c, calls } = client(() => ({}));
    await c.invokeAction("pipeline", "acc:pipeline:7/100", "retry-job:55", ACC);
    await c.invokeAction("pipeline", "acc:pipeline:7/100", "cancel", ACC);
    expect(calls.map((x) => `${x.method} ${x.url.pathname}`)).toEqual([
      "POST /api/v4/projects/7/jobs/55/retry",
      "POST /api/v4/projects/7/pipelines/100/cancel",
    ]);
  });

  it("opens the failed job's log and strips ANSI and section markers", async () => {
    const { c } = client((call) => {
      if (call.url.pathname.endsWith("/jobs")) {
        return [
          { id: 2, name: "test", stage: "test", status: "failed" },
          { id: 1, name: "build", stage: "build", status: "success" },
        ];
      }
      expect(call.url.pathname).toBe("/api/v4/projects/7/jobs/2/trace");
      return "section_start:1700000000:step_script\r\u001b[0K\u001b[32;1mRunning\u001b[0;m\nboom\n";
    });
    const logs = await c.getLogs("pipeline", "acc:pipeline:7/100", ACC, { tailLines: 10 });
    expect(logs.containers).toEqual(["build / build #1", "test / test #2"]);
    expect(logs.activeContainer).toBe("test / test #2");
    expect(logs.text).toContain("Running\nboom");
    expect(logs.text).not.toContain("\u001b");
  });
});

describe("helpers", () => {
  it("parses variable ids, lists and inputs", () => {
    expect(splitVariable("KEY/review/*")).toEqual({ key: "KEY", envScope: "review/*" });
    expect(splitVariable("KEY")).toEqual({ key: "KEY", envScope: "*" });
    expect(parseListish('["a","b"]')).toEqual(["a", "b"]);
    expect(parseListish("a, b")).toEqual(["a", "b"]);
    expect(parseVariableLines("A=1\n# note\nB=x=y")).toEqual([
      { key: "A", value: "1", variable_type: "env_var" },
      { key: "B", value: "x=y", variable_type: "env_var" },
    ]);
    expect(() => parseVariableLines("bad-key=1")).toThrow(/valid variable name/);
    expect(hookEventFlags("push, pipeline", "project")).toMatchObject({
      push_events: true,
      pipeline_events: true,
      issues_events: false,
    });
    expect(() => hookEventFlags("member", "project")).toThrow(/not a project webhook event/);
    expect(cleanTrace("a\r\nb")).toBe("a\nb");
  });

  it("describes protected branch levels", () => {
    expect(describeLevels([{ access_level: 30 }, { user_id: 4, access_level: null }])).toBe(
      "Developers + Maintainers, 1 user/group/key rule",
    );
  });

  it("buckets pipelines and jobs per day", () => {
    const range = {
      startMs: Date.parse("2026-10-01T00:00:00Z"),
      endMs: Date.parse("2026-10-05T00:00:00Z"),
    };
    const series = pipelineSeries(
      [
        { id: 1, status: "success", created_at: "2026-10-02T10:00:00Z" },
        { id: 2, status: "failed", created_at: "2026-10-02T11:00:00Z" },
        { id: 3, status: "running", created_at: "2026-10-03T11:00:00Z" },
      ],
      range,
    );
    expect(series.find((s) => s.label === "Pipeline success rate")!.points).toEqual([
      { timestamp: Date.parse("2026-10-02T00:00:00Z"), value: 50 },
    ]);
    const jobs = jobSeries(
      [
        {
          id: 1,
          name: "a",
          status: "failed",
          allow_failure: true,
          created_at: "2026-10-02T10:00:00Z",
          duration: 10,
          queued_duration: 2,
        },
        {
          id: 2,
          name: "b",
          status: "success",
          created_at: "2026-10-02T10:00:00Z",
          duration: 30,
          queued_duration: 8,
        },
      ],
      range,
    );
    expect(jobs.find((s) => s.label === "Failed jobs")!.points[0]!.value).toBe(0);
    expect(jobs.find((s) => s.label === "Queue time p95")!.points[0]!.value).toBe(8);
    expect(percentile([3, 1, 2], 50)).toBe(2);
  });
});

describe("status feed", () => {
  it("synthesises incidents from degraded components and maps them to types", () => {
    const body = JSON.stringify({
      result: {
        status: [
          {
            id: "a",
            name: "CI/CD - Hosted runners on Linux",
            status: "Degraded Performance",
            status_code: 300,
          },
          { id: "b", name: "Container Registry", status: "Operational", status_code: 100 },
        ],
        incidents: [],
        maintenance: { active: [] },
      },
    });
    const [incident, ...rest] = parseStatusFeed(body);
    expect(rest).toHaveLength(0);
    expect(incident).toMatchObject({
      services: ["CI/CD"],
      impact: "minor",
      resourceTypes: ["pipeline", "pipeline-schedule", "runner", "environment"],
    });
  });

  it("escalates API incidents to provider-wide", () => {
    const body = JSON.stringify({
      result: {
        status: [],
        incidents: [
          {
            _id: "i1",
            name: "API errors",
            datetime_open: "2026-10-01T10:00:00Z",
            components_affected: [{ name: "API" }],
            messages: [{ details: "Investigating", datetime: "2026-10-01T10:05:00Z", state: 100 }],
          },
        ],
      },
    });
    expect(parseStatusFeed(body)[0]).toMatchObject({
      externalId: "i1",
      providerWide: true,
      state: "investigating",
    });
    expect(() => parseStatusFeed("{}")).toThrow();
  });
});

describe("terraform", () => {
  it("maps variables to a sensitive value variable and the documented import id", () => {
    const v = mapVariable(
      ACC,
      { kind: "project", id: 7, path: "acme/api" },
      {
        key: "TOKEN",
        environment_scope: "production",
        protected: true,
        masked: true,
      },
    );
    const out = gitlabTerraformExport.mapResource(v)!;
    expect(out.resource.type).toBe("gitlab_project_variable");
    expect(out.resource.importId).toBe("7:TOKEN:production");
    expect(out.resource.attributes["value"]).toMatchObject({ kind: "ref" });
    expect(out.variables![0]!.sensitive).toBe(true);
  });
});
