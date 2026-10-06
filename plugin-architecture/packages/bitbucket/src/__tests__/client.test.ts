import { describe, expect, it } from "vitest";
import { BitbucketApiError, authHeader, bbPaged, statusOf } from "../api.js";
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
  const c = new BitbucketClient(
    { email: "me@example.com", token: "tok", workspace: "acme", ...creds },
    {
      http,
      ...extra,
    } as never,
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
      if (call.url.searchParams.get("page") === "2") return { values: [{ n: 2 }] };
      expect(call.url.searchParams.get("pagelen")).toBe("100");
      return { values: [{ n: 1 }], next: `${API}/repositories/acme?page=2` };
    });
    const ctx = { token: "t", workspace: "acme", http };
    expect((await bbPaged<{ n: number }>(ctx, "/repositories/acme")).map((x) => x.n)).toEqual([
      1, 2,
    ]);
    expect(calls).toHaveLength(2);

    const evil = makeHttp(() => ({ values: [], next: "https://evil.example/steal" }));
    await expect(bbPaged({ token: "t", workspace: "acme", http: evil.http }, "/x")).rejects.toThrow(
      /refusing/,
    );
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
    const options = await plugin.listCredentialOptions!(
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
      plugin.listCredentialOptions!("workspace", { token: "t" }, { http } as never),
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
