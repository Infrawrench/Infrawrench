import { hostClient, hostPlugin } from "@infrawrench/plugin-base/effect";
import { describe, expect, it } from "vitest";
import { pathEncode } from "@infrawrench/plugin-base";
import { BitbucketApiError, authHeader, bitbucketClients, statusOf } from "../api.js";
import {
  BitbucketClient,
  cleanLog,
  parseListish,
  parseVariableLines,
  runnerLabels,
} from "../client.js";
import { mapPipeline, parseRunnerId, runnerExternalId, stateWord } from "../mappers.js";
import { pipelineSeries } from "../metrics.js";
import { plugin } from "../plugin.js";
import { parseStatusFeed } from "../status-feed.js";
import type { Call } from "./helpers.js";
import { makeHttp, makeSecrets } from "./helpers.js";

const ACC = "acc";
const API = "https://api.bitbucket.org/2.0";

function client(
  route: (call: Call) => unknown,
  extra: object = {},
  creds: Record<string, string> = {},
) {
  const { http, calls } = makeHttp(route);
  const c = hostClient(
    new BitbucketClient({ email: "me@example.com", token: "tok", workspace: "acme", ...creds }, {
      http,
      ...extra,
    } as never),
  );
  return { c, calls };
}

const REPO = {
  slug: "api",
  name: "API",
  full_name: "acme/api",
  is_private: true,
  project: { key: "PLAT" },
};

describe("auth", () => {
  it("uses Basic with the email for API tokens and Bearer for access tokens", () => {
    expect(authHeader({ email: "me@example.com", token: "tok" })).toBe(
      `Basic ${btoa("me@example.com:tok")}`,
    );
    expect(authHeader({ token: "tok" })).toBe("Bearer tok");
  });
});

describe("transport", () => {
  it("follows next links on the API host only", async () => {
    const { http, calls } = makeHttp((call) => {
      if (call.url.searchParams.get("page") === "2") return { values: [{ key: "2" }] };
      expect(call.url.searchParams.get("pagelen")).toBe("100");
      return { values: [{ key: "1" }], next: `${API}/workspaces/acme/projects?page=2` };
    });
    const projects = `/workspaces/${pathEncode("acme")}/projects` as const;
    const { lists } = bitbucketClients({ token: "t", http });
    expect((await lists.getAll(projects, "values")).map((x) => x.key)).toEqual(["1", "2"]);
    expect(calls).toHaveLength(2);

    const evil = makeHttp(() => ({ values: [], next: "https://evil.example/steal" }));
    await expect(
      bitbucketClients({ token: "t", http: evil.http }).lists.getAll(projects, "values"),
    ).rejects.toThrow("Refusing to send the account's credentials there");
  });

  it("maps errors with a numeric status and Bitbucket's message", async () => {
    const { c } = client(() => ({
      status: 403,
      body: { type: "error", error: { message: "Forbidden", detail: "no scope" } },
    }));
    const err = await c.getResource("project", "acc:project:PLAT", ACC).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BitbucketApiError);
    expect(statusOf(err)).toBe(403);
    expect((err as Error).message).toMatch(/Forbidden: no scope/);
  });
});

describe("workspace picker", () => {
  it("lists workspaces from /user/workspaces", async () => {
    const { http } = makeHttp(() => ({
      values: [
        { administrator: true, workspace: { slug: "zeta", name: "Zeta" } },
        { administrator: false, workspace: { slug: "acme", name: "Acme" } },
      ],
    }));
    const options = await hostPlugin(plugin).listCredentialOptions!(
      "workspace",
      { email: "a@b.c", token: "t" },
      { http } as never,
    );
    expect(options).toEqual([
      { id: "acme", label: "Acme", description: "acme" },
      { id: "zeta", label: "Zeta", description: "zeta (admin)" },
    ]);
  });

  it("explains that access tokens cannot list workspaces", async () => {
    const { http } = makeHttp(() => ({ status: 401, body: {} }));
    await expect(
      hostPlugin(plugin).listCredentialOptions!("workspace", { token: "t" }, { http } as never),
    ).rejects.toThrow(/Type the workspace slug/);
  });
});

describe("listing", () => {
  it("lists pipelines per repository with braces encoded, skipping repos that refuse", async () => {
    const { c, calls } = client((call) => {
      if (call.url.pathname === "/2.0/repositories/acme") {
        return { values: [REPO, { ...REPO, slug: "web", full_name: "acme/web" }] };
      }
      if (call.url.pathname === "/2.0/repositories/acme/web/pipelines")
        return { status: 404, body: {} };
      expect(call.url.searchParams.get("sort")).toBe("-created_on");
      return {
        values: [
          {
            uuid: "{p1}",
            build_number: 7,
            target: { ref_type: "branch", ref_name: "main", commit: { hash: "abcdef1234567890" } },
            state: { name: "COMPLETED", result: { name: "FAILED" } },
            build_seconds_used: 90,
            created_on: "2026-10-01T10:00:00Z",
            completed_on: "2026-10-01T10:02:00Z",
          },
        ],
      };
    });
    const [p] = await c.listResources("pipeline", ACC);
    expect(p!.externalId).toBe("api/{p1}");
    expect(p!.fields).toMatchObject({
      result: "FAILED",
      refName: "main",
      durationSecs: 120,
      buildSeconds: 90,
    });
    expect(p!.parentResourceId).toBe("acc:repository:api");
    expect(p!.resolvedOutputs["webUrl"]).toBe("https://bitbucket.org/acme/api/pipelines/results/7");

    await c.getResource("pipeline", "acc:pipeline:api/{p1}", ACC).catch(() => undefined);
    expect(calls.some((x) => x.url.toString().includes("/pipelines/%7Bp1%7D"))).toBe(true);
  });

  it("strips the username from the HTTPS clone URL", async () => {
    const { c } = client(() => ({
      values: [
        {
          ...REPO,
          links: {
            clone: [
              { name: "https", href: "https://me@bitbucket.org/acme/api.git" },
              { name: "ssh", href: "git@bitbucket.org:acme/api.git" },
            ],
          },
        },
      ],
    }));
    const [r] = await c.listResources("repository", ACC);
    expect(r!.resolvedOutputs["httpsCloneUrl"]).toBe("https://bitbucket.org/acme/api.git");
  });
});

describe("edits", () => {
  it("keeps a visible variable's value when only securing it", async () => {
    const { c, calls } = client((call) => {
      if (call.method === "PUT") return {};
      return { uuid: "{v1}", key: "TOKEN", value: "abc", secured: false };
    });
    await c.updateResource("repository-variable", "acc:repository-variable:api/{v1}", ACC, {
      secured: "true",
    });
    expect(calls.find((x) => x.method === "PUT")!.body).toEqual({
      key: "TOKEN",
      value: "abc",
      secured: true,
    });
  });

  it("refuses to edit a secured variable without a new value", async () => {
    const { c } = client(() => ({ uuid: "{v1}", key: "TOKEN", secured: true }));
    await expect(
      c.updateResource("workspace-variable", "acc:workspace-variable:{v1}", ACC, {
        secured: "true",
      }),
    ).rejects.toThrow(/secured/);
  });

  it("runs a custom pipeline on a branch with variables", async () => {
    const { c, calls } = client(() => ({
      uuid: "{p9}",
      build_number: 9,
      state: { name: "PENDING" },
    }));
    await c.createResource("pipeline", ACC, {
      repository: "api",
      branch: "main",
      pipeline: "deploy",
      variables: "ENV=prod",
    });
    expect(calls[0]!.body).toEqual({
      target: {
        type: "pipeline_ref_target",
        ref_type: "branch",
        ref_name: "main",
        selector: { type: "custom", pattern: "deploy" },
      },
      variables: [{ key: "ENV", value: "prod", secured: false }],
    });
  });

  it("keeps a new runner's OAuth credentials as outputs", async () => {
    const { secrets, store } = makeSecrets();
    const { c, calls } = client(
      () => ({
        uuid: "{r1}",
        name: "build",
        labels: ["self.hosted", "linux"],
        oauth_client: { id: "cid", secret: "csecret" },
      }),
      { secrets },
    );
    const created = await c.createResource("runner", ACC, {
      scope: "workspace",
      name: "build",
      platform: "linux",
      labels: "gpu",
    });
    const resource = "resource" in created ? created.resource : created;
    expect(calls[0]!.url.pathname).toBe("/2.0/workspaces/acme/pipelines-config/runners");
    expect(calls[0]!.body).toMatchObject({
      labels: expect.arrayContaining(["self.hosted", "linux", "gpu"]),
    });
    expect(JSON.stringify(resource)).not.toContain("csecret");
    expect(store.get("acc:runner:workspace/{r1}|oauthClientSecret")).toBe("csecret");
    expect(
      await c.resolveOutput("runner", "acc:runner:workspace/{r1}", "oauthClientSecret", ACC),
    ).toBe("csecret");
  });

  it("requires a seven-field cron for schedules", async () => {
    const { c } = client(() => ({}));
    await expect(
      c.createResource("pipeline-schedule", ACC, {
        repository: "api",
        branch: "main",
        cron: "0 3 * * *",
      }),
    ).rejects.toThrow(/seven-field/);
  });

  it("falls back to the deployments_config path for environment changes", async () => {
    const { c, calls } = client((call) => {
      if (call.method === "POST" && call.url.pathname.includes("/environments/")) {
        return call.url.pathname.includes("deployments_config")
          ? { status: 202 }
          : { status: 404, body: {} };
      }
      if (call.url.pathname.endsWith("/deployments")) return { values: [] };
      return { uuid: "{e1}", name: "Production" };
    });
    await c.updateResource("environment", "acc:environment:api/{e1}", ACC, { adminOnly: "true" });
    const posts = calls.filter((x) => x.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toEqual({ change: { restrictions: { admin_only: true } } });
  });
});

describe("pipeline schedule history", () => {
  async function recentRuns(values: unknown[]) {
    const { c } = client((call) =>
      call.url.pathname.endsWith("/executions")
        ? { values }
        : {
            uuid: "{s1}",
            enabled: true,
            target: { ref_name: "main" },
            cron_pattern: "0 0 3 * * ? *",
          },
    );
    const resource = await c.getResource(
      "pipeline-schedule",
      "acc:pipeline-schedule:api/{s1}",
      ACC,
    );
    const table = JSON.stringify(
      new BitbucketClient(
        { email: "e@x.y", token: "t", workspace: "acme" },
        {} as never,
      ).renderDetail(resource),
    );
    return table;
  }

  const RUN = {
    uuid: "{p7}",
    build_number: 7,
    target: { ref_name: "main" },
    state: { name: "COMPLETED", result: { name: "FAILED" } },
    trigger: { name: "SCHEDULE" },
    build_seconds_used: 90,
    created_on: "2026-10-01T10:00:00Z",
  };

  it("reads the run nested under an executed execution", async () => {
    const shown = await recentRuns([
      { type: "pipeline_schedule_execution_executed", pipeline: RUN },
    ]);
    expect(shown).toContain('"n":"7"');
    expect(shown).toContain('"ref":"main"');
    expect(shown).toContain('"result":"FAILED"');
    expect(shown).toContain('"trigger":"SCHEDULE"');
    expect(shown).toContain('"created":"2026-10-01T10:00:00Z"');
  });

  it("says why an errored execution did not start", async () => {
    const shown = await recentRuns([
      {
        type: "pipeline_schedule_execution_errored",
        error: { key: "plan-limit", message: "Out of build minutes" },
      },
    ]);
    expect(shown).toContain("Out of build minutes");
  });

  it("still reads a run written at the top level of the execution", async () => {
    const shown = await recentRuns([RUN]);
    expect(shown).toContain('"n":"7"');
    expect(shown).toContain('"result":"FAILED"');
  });
});

describe("reading a whole list", () => {
  const PROJECTS = "/2.0/workspaces/acme/projects";
  const REPOS = "/2.0/repositories/acme";
  const pageOf = (call: Call) => Number(call.url.searchParams.get("page") ?? "1");

  /** Pages of one row each, numbered from one, then no next link. */
  function paged(call: Call, pages: number, row: (page: number) => object) {
    const page = pageOf(call);
    return {
      values: [row(page)],
      ...(page < pages ? { next: `${call.url.origin}${call.url.pathname}?page=${page + 1}` } : {}),
    };
  }

  const none = () => ({ values: [] });
  const project = (n: number) => ({ key: `P${n}`, name: `P${n}`, uuid: `{p${n}}` });
  const variable = (n: number) => ({ uuid: `{v${n}}`, key: `K${n}`, value: "x", secured: false });

  it("reads an inventory list past the old five pages", async () => {
    const { c, calls } = client((call) => paged(call, 7, project));
    expect(await c.listResources("project", ACC)).toHaveLength(7);
    expect(calls).toHaveLength(7);
  });

  it("reads repositories past the old five pages", async () => {
    const { c } = client((call) => paged(call, 7, (n) => ({ ...REPO, slug: `r${n}` })));
    expect(await c.listResources("repository", ACC)).toHaveLength(7);
  });

  it("reads a repository's children past the old caps", async () => {
    const { c } = client((call) =>
      call.url.pathname === REPOS ? { values: [REPO] } : paged(call, 5, variable),
    );
    expect(await c.listResources("repository-variable", ACC)).toHaveLength(5);
  });

  it("reads an environment's deployment variables past the old two pages", async () => {
    const { c } = client((call) => {
      if (call.url.pathname === REPOS) return { values: [REPO] };
      if (call.url.pathname.endsWith("/environments")) {
        return paged(call, 4, (n) => ({ uuid: `{e${n}}`, name: `E${n}` }));
      }
      return paged(call, 3, variable);
    });
    expect(await c.listResources("deployment-variable", ACC)).toHaveLength(12);
  });

  it("counts every member of a workspace, not the first five pages", async () => {
    const { c } = client((call) =>
      call.url.pathname.endsWith("/members")
        ? paged(call, 7, (n) => ({ user: { uuid: `{u${n}}` } }))
        : { slug: "acme", name: "Acme", uuid: "{w}" },
    );
    const [w] = await c.listResources("workspace", ACC);
    expect(w!.fields["members"]).toBe(7);
  });

  it("finds a deployment variable on a later page", async () => {
    const { c } = client((call) =>
      call.url.pathname.endsWith("/variables")
        ? paged(call, 5, variable)
        : { uuid: "{e1}", name: "Production" },
    );
    const v = await c.getResource(
      "deployment-variable",
      "acc:deployment-variable:api/{e1}/{v5}",
      ACC,
    );
    expect(v.displayName).toContain("K5");
  });

  it("finds a cache on a later page", async () => {
    const { c } = client((call) =>
      paged(call, 5, (n) => ({ uuid: `{c${n}}`, name: `C${n}`, path: "x" })),
    );
    const cache = await c.getResource("pipeline-cache", "acc:pipeline-cache:api/{c5}", ACC);
    expect(cache.fields["name"]).toBe("C5");
  });

  it("clears every cache, past the old three pages", async () => {
    const { c, calls } = client((call) =>
      call.method === "DELETE"
        ? { status: 204 }
        : paged(call, 5, (n) => ({ uuid: `{c${n}}`, name: `C${n}` })),
    );
    await c.invokeAction("repository", "acc:repository:api", "clear-caches", ACC);
    expect(calls.filter((x) => x.method === "DELETE")).toHaveLength(5);
  });

  it("refuses a list that never ends, after exactly 100 requests", async () => {
    const { c, calls } = client((call) => paged(call, Number.MAX_SAFE_INTEGER, project));
    await expect(c.listResources("project", ACC)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(100);
  });

  it("deletes no cache when the list cannot be read whole", async () => {
    const { c, calls } = client((call) =>
      paged(call, Number.MAX_SAFE_INTEGER, (n) => ({ uuid: `{c${n}}`, name: `C${n}` })),
    );
    await expect(
      c.invokeAction("repository", "acc:repository:api", "clear-caches", ACC),
    ).rejects.toThrow("has more than Infrawrench reads");
    expect(calls.filter((x) => x.method === "DELETE")).toHaveLength(0);
  });

  it("refuses a page whose list key was renamed, first or later", async () => {
    const first = client(() => ({ items: [] }));
    await expect(first.c.listResources("project", ACC)).rejects.toThrow("is not a list");
    const later = client((call) => (pageOf(call) === 1 ? paged(call, 2, project) : { items: [] }));
    await expect(later.c.listResources("project", ACC)).rejects.toThrow("is not a list");
  });

  it("refuses a page with no list from a repository's pipelines", async () => {
    const { c } = client((call) =>
      call.url.pathname === REPOS ? { values: [REPO] } : { items: [] },
    );
    await expect(c.listResources("pipeline", ACC)).rejects.toThrow("is not a list");
  });

  it("refuses an answer with no body, which is not an empty list", async () => {
    const { c } = client(() => ({ status: 200 }));
    await expect(c.listResources("project", ACC)).rejects.toThrow("is not a list");
  });

  it("reads an empty list as empty, and goes on past an empty page naming a next one", async () => {
    expect(await client(() => ({ values: [] })).c.listResources("project", ACC)).toEqual([]);
    const { c } = client((call) =>
      pageOf(call) === 1
        ? { values: [], next: `${API}/workspaces/acme/projects?page=2` }
        : { values: [project(2)] },
    );
    expect(await c.listResources("project", ACC)).toHaveLength(1);
  });

  it("refuses a next link off the API, sending nothing there", async () => {
    const { c, calls } = client(() => ({ values: [], next: "https://evil.example/steal" }));
    await expect(c.listResources("project", ACC)).rejects.toThrow(
      "Refusing to send the account's credentials there",
    );
    expect(calls).toHaveLength(1);
  });

  it("refuses a next link off the API through the per-repository catch", async () => {
    const { c, calls } = client((call) =>
      call.url.pathname === REPOS
        ? { values: [REPO] }
        : { values: [], next: "https://evil.example/steal" },
    );
    await expect(c.listResources("repository-webhook", ACC)).rejects.toThrow(
      "Refusing to send the account's credentials there",
    );
    expect(calls.every((x) => x.url.hostname === "api.bitbucket.org")).toBe(true);
  });

  it("refuses a next link off the API on what were the last pages of a list", async () => {
    const { c } = client((call) =>
      pageOf(call) < 5
        ? paged(call, 5, project)
        : { values: [project(5)], next: "https://evil.example/steal" },
    );
    await expect(c.listResources("project", ACC)).rejects.toThrow(
      "Refusing to send the account's credentials there",
    );
  });

  it("lists children of the 30 most recently updated repositories, and says which it left unread", async () => {
    const { c, calls } = client((call) =>
      call.url.pathname === REPOS
        ? { values: Array.from({ length: 32 }, (_, i) => ({ ...REPO, slug: `r${i}` })) }
        : none(),
    );
    const seen: unknown[] = [];
    const hook = Symbol.for("infrawrench.unreadListPart");
    Reflect.set(globalThis, hook, (part: unknown) => seen.push(part));
    await c.listResources("repository-webhook", ACC);
    Reflect.deleteProperty(globalThis, hook);
    expect(calls.filter((x) => x.url.pathname.endsWith("/hooks"))).toHaveLength(30);
    expect(seen).toEqual([
      { parentResourceIds: [`${ACC}:repository:r30`, `${ACC}:repository:r31`] },
    ]);
  });

  it("names a repository the way its children name their parent", async () => {
    const { c } = client((call) => {
      if (call.url.pathname === REPOS) return { values: [{ ...REPO, slug: "r0" }] };
      return call.url.pathname.endsWith("/hooks") ? { values: [{ uuid: "{h}" }] } : none();
    });
    const [hook] = await c.listResources("repository-webhook", ACC);
    expect(hook?.parentResourceId).toBe(`${ACC}:repository:r0`);
  });

  it("reads project deploy keys of up to 1,000 projects, and refuses past that", async () => {
    const rows = (count: number) => Array.from({ length: count }, (_, i) => project(i));
    const within = client((call) =>
      call.url.pathname === PROJECTS ? { values: rows(1000) } : none(),
    );
    await within.c.listResources("project-deploy-key", ACC);
    expect(within.calls.filter((x) => x.url.pathname.endsWith("/deploy-keys"))).toHaveLength(1000);

    const past = client((call) =>
      call.url.pathname === PROJECTS ? { values: rows(1001) } : none(),
    );
    await expect(past.c.listResources("project-deploy-key", ACC)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(past.calls).toHaveLength(1);
  });
});

describe("reads where part of a list is fine", () => {
  const endless = (call: Call, row: (page: number) => object) => {
    const page = Number(call.url.searchParams.get("page") ?? "1");
    return { values: [row(page)], next: `${call.url.origin}${call.url.pathname}?page=${page + 1}` };
  };

  it("fills the repository picker from what it read", async () => {
    const { c, calls } = client((call) =>
      endless(call, (n) => ({ ...REPO, slug: `r${n}`, name: `R${n}` })),
    );
    const form = await c.getCreateConfig("repository-variable");
    const options = form.fields.find((x) => x.key === "repository")!.options!;
    expect(options.length).toBeGreaterThan(0);
    expect(options).toHaveLength(calls.length);
  });

  it("fills the workspace picker from what it read", async () => {
    const { http } = makeHttp((call) =>
      endless(call, (n) => ({ workspace: { slug: `w${n}`, name: `W${n}` } })),
    );
    const options = await hostPlugin(plugin).listCredentialOptions!(
      "workspace",
      { email: "a@b.c", token: "t" },
      { http } as never,
    );
    expect(options.length).toBeGreaterThan(0);
  });

  it("charts a repository from the pages it reads", async () => {
    const created_on = new Date().toISOString();
    const { c, calls } = client((call) =>
      endless(call, (n) => ({ uuid: `{p${n}}`, created_on, state: { name: "COMPLETED" } })),
    );
    const series = await c.fetchMetricSeries("repository", "acc:repository:api", ACC);
    expect(series.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(5);
  });

  it("charts an environment from the pages it reads", async () => {
    const { c, calls } = client((call) =>
      endless(call, (n) => ({ uuid: `{d${n}}`, environment: { uuid: "{e1}" } })),
    );
    await c.fetchMetricSeries("environment", "acc:environment:api/{e1}", ACC);
    expect(calls).toHaveLength(5);
  });

  it("shows a pipeline's logs from the steps it reads", async () => {
    const { c } = client((call) =>
      call.url.pathname.endsWith("/log")
        ? "line\n"
        : endless(call, (n) => ({ uuid: `{s${n}}`, name: `S${n}` })),
    );
    const logs = await c.getLogs("pipeline", "acc:pipeline:api/{p1}", ACC, {});
    expect(logs.containers.length).toBeGreaterThan(0);
  });

  it("shows an environment's newest deployments from the pages it reads", async () => {
    const { c } = client((call) =>
      call.url.pathname.endsWith("/deployments")
        ? endless(call, (n) => ({ uuid: `{d${n}}`, environment: { uuid: "{e1}" } }))
        : { uuid: "{e1}", name: "Production" },
    );
    const e = await c.getResource("environment", "acc:environment:api/{e1}", ACC);
    expect(e.displayName).toBeTruthy();
  });
});

describe("logs", () => {
  it("tails the failed step's log with a Range request", async () => {
    const { c, calls } = client((call) => {
      if (call.url.pathname.endsWith("/steps")) {
        return {
          values: [
            {
              uuid: "{s1}",
              name: "Build",
              state: { name: "COMPLETED", result: { name: "SUCCESSFUL" } },
            },
            {
              uuid: "{s2}",
              name: "Test",
              state: { name: "COMPLETED", result: { name: "FAILED" } },
            },
          ],
        };
      }
      expect(call.headers["Range"]).toBe("bytes=-262144");
      return "\u001b[32mok\u001b[0m\r\nboom\n";
    });
    const logs = await c.getLogs("pipeline", "acc:pipeline:api/{p1}", ACC, {});
    expect(logs.containers).toEqual(["1. Build", "2. Test"]);
    expect(logs.activeContainer).toBe("2. Test");
    expect(logs.text).toContain("ok\nboom");
    expect(calls.at(-1)!.url.toString()).toContain("/steps/%7Bs2%7D/log");
  });
});

describe("helpers", () => {
  it("normalises runner labels", () => {
    expect(runnerLabels("linux", ["gpu", "windows"]).sort()).toEqual([
      "gpu",
      "linux",
      "self.hosted",
    ]);
    expect(() => runnerLabels(undefined, ["gpu"])).toThrow(/platform/);
    expect(parseRunnerId(runnerExternalId("api", "{u}"))).toEqual({ slug: "api", uuid: "{u}" });
    expect(parseRunnerId(runnerExternalId(undefined, "{u}"))).toEqual({ uuid: "{u}" });
  });

  it("parses inputs", () => {
    expect(parseListish('["repo:push"]')).toEqual(["repo:push"]);
    expect(parseVariableLines("A=1=2")).toEqual([{ key: "A", value: "1=2", secured: false }]);
    expect(cleanLog("a\r\nb")).toBe("a\nb");
    expect(stateWord({ name: "IN_PROGRESS", stage: { name: "RUNNING" } })).toBe("RUNNING");
  });

  it("buckets pipelines into build minutes and success rate", () => {
    const range = {
      startMs: Date.parse("2026-10-01T00:00:00Z"),
      endMs: Date.parse("2026-10-05T00:00:00Z"),
    };
    const series = pipelineSeries(
      [
        {
          uuid: "1",
          created_on: "2026-10-02T01:00:00Z",
          build_seconds_used: 120,
          state: { result: { name: "SUCCESSFUL" } },
        },
        {
          uuid: "2",
          created_on: "2026-10-02T02:00:00Z",
          build_seconds_used: 60,
          state: { result: { name: "FAILED" } },
        },
      ],
      range,
    );
    expect(series.find((s) => s.label === "Build minutes")!.points[0]!.value).toBe(3);
    expect(series.find((s) => s.label === "Success rate")!.points[0]!.value).toBe(50);
    expect(mapPipeline(ACC, "acme", "api", { uuid: "{x}" }).displayName).toBe("api #x");
  });
});

describe("status feed", () => {
  it("maps Pipelines incidents to pipeline types and API to provider-wide", () => {
    const body = JSON.stringify({
      page: { id: "x" },
      incidents: [
        {
          id: "i1",
          name: "Pipelines delays",
          status: "investigating",
          impact: "minor",
          created_at: "2026-10-01T10:00:00Z",
          updated_at: "2026-10-01T10:00:00Z",
          shortlink: "https://stspg.io/x",
          components: [{ name: "Pipelines" }],
          incident_updates: [],
        },
        {
          id: "i2",
          name: "API errors",
          status: "identified",
          impact: "major",
          created_at: "2026-10-01T10:00:00Z",
          updated_at: "2026-10-01T10:00:00Z",
          components: [{ name: "API" }],
          incident_updates: [],
        },
      ],
    });
    const [a, b] = parseStatusFeed(body);
    expect(a!.resourceTypes).toContain("pipeline");
    expect(b!.providerWide).toBe(true);
  });
});
