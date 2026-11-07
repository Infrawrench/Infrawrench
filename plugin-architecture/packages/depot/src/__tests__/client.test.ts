import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DepotClient } from "../client.js";
import { buildSeries, dayBuckets } from "../metrics.js";
import { fetchDepotQuotas } from "../quotas.js";
import { resolveRates } from "../rates.js";
import { parseStatusFeed } from "../status-feed.js";

const ACCOUNT = "acct";

interface Call {
  method: string;
  body: Record<string, unknown>;
}

function response(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** What a route answers to fail the call instead of returning a body. */
class Failure {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {}
}

/** Route Connect calls by method name. */
function installApi(routes: Record<string, (body: Record<string, unknown>) => unknown>) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
    const method = String(url).replace("https://api.depot.dev/", "");
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ method, body });
    const route = routes[method];
    if (!route) return response({ code: "not_found", message: method }, 404);
    const answer = route(body);
    return answer instanceof Failure
      ? response({ code: answer.code, message: answer.code }, answer.status)
      : response(answer);
  }) as unknown as typeof fetch);
  return calls;
}

afterEach(() => vi.restoreAllMocks());

const client = () => hostClient(new DepotClient({ token: "org-token", plan: "startup" }));

const PROJECTS = {
  "depot.core.v1.ProjectService/ListProjects": () => ({
    projects: [
      {
        projectId: "p1",
        organizationId: "org1",
        name: "web",
        regionId: "us-east-1",
        createdAt: "2026-01-01T00:00:00Z",
        cachePolicy: { keepGb: 50, keepDays: 14 },
        hardware: "HARDWARE_8X16",
      },
    ],
  }),
  "depot.core.v1.UsageService/ListProjectUsage": () => ({
    usage: [{ projectId: "p1", buildCount: 12, buildDurationSeconds: 1800, layerCacheSizeGb: 7 }],
  }),
};

describe("DepotClient", () => {
  it("requires a token", () => {
    expect(() => hostClient(new DepotClient({}))).toThrow(/token/);
  });

  it("lists projects with their settings and 30-day usage", async () => {
    installApi(PROJECTS);
    const [project] = await client().listResources("depot-project", ACCOUNT);
    expect(project).toMatchObject({
      id: "acct:depot-project:p1",
      displayName: "web",
      fields: {
        regionId: "us-east-1",
        hardware: "8x16",
        cacheKeepGb: 50,
        cacheKeepDays: 14,
        builds30d: 12,
        buildMinutes30d: 30,
        layerCacheGb: 7,
      },
      resolvedOutputs: { projectId: "p1", registryRepository: "registry.depot.dev/p1" },
    });
  });

  it("lists recent builds under their project with a cache hit rate", async () => {
    const calls = installApi({
      ...PROJECTS,
      "depot.core.v1.BuildService/ListBuilds": () => ({
        builds: [
          {
            buildId: "b1",
            status: "STATUS_SUCCESS",
            createdAt: "2026-10-01T10:00:00Z",
            buildDurationSeconds: 90,
            cachedSteps: 3,
            totalSteps: 4,
          },
        ],
      }),
    });
    const [build] = await client().listResources("depot-build", ACCOUNT);
    expect(build).toMatchObject({
      id: "acct:depot-build:p1/b1",
      parentResourceId: "acct:depot-project:p1",
      fields: { status: "success", cacheHitRate: 75, durationSeconds: 90 },
    });
    expect(calls.find((c) => c.method.endsWith("ListBuilds"))!.body).toEqual({
      projectId: "p1",
      pageSize: 25,
    });
    const detail = client().renderDetail(build!);
    expect(detail.status?.status).toBe("healthy");
  });

  it("lists trust policies across all four CI providers", async () => {
    installApi({
      ...PROJECTS,
      "depot.core.v1.ProjectService/ListTrustPolicies": () => ({
        trustPolicies: [
          { trustPolicyId: "t1", github: { repositoryOwner: "acme", repository: "api" } },
          { trustPolicyId: "t2", buildkite: { organizationSlug: "acme", pipelineSlug: "deploy" } },
        ],
      }),
    });
    const policies = await client().listResources("depot-trust-policy", ACCOUNT);
    expect(policies.map((p) => [p.fields["provider"], p.fields["subject"]])).toEqual([
      ["github", "acme/api"],
      ["buildkite", "acme/deploy"],
    ]);
  });

  it("creates a project with the picked region, size and cache policy", async () => {
    const calls = installApi({
      "depot.core.v1.ProjectService/CreateProject": (body) => ({
        project: { projectId: "p9", name: body["name"], regionId: body["regionId"] },
      }),
    });
    const created = await client().createResource("depot-project", ACCOUNT, {
      name: "api",
      regionId: "eu-central-1",
      hardware: "16x32",
      cacheKeepGb: "100",
      cacheKeepDays: "7",
    });
    expect(created.externalId).toBe("p9");
    expect(calls[0]!.body).toEqual({
      name: "api",
      regionId: "eu-central-1",
      cachePolicy: { keepGb: 100, keepDays: 7 },
      hardware: "HARDWARE_16X32",
    });
  });

  it("updates a project's settings", async () => {
    const calls = installApi({
      "depot.core.v1.ProjectService/UpdateProject": (body) => ({
        project: { projectId: body["projectId"], name: body["name"], regionId: "us-east-1" },
      }),
    });
    await client().updateResource("depot-project", "acct:depot-project:p1", ACCOUNT, {
      name: "web2",
      hardware: "default",
      cacheKeepGb: "20",
    });
    expect(calls[0]!.body).toEqual({
      projectId: "p1",
      name: "web2",
      hardware: "HARDWARE_UNSPECIFIED",
      cachePolicy: { keepGb: 20 },
    });
  });

  it("creates a project token and surfaces its secret once", async () => {
    const calls = installApi({
      "depot.core.v1.ProjectService/CreateToken": () => ({ tokenId: "tok1", secret: "s3cret" }),
    });
    const token = await client().createResource(
      "depot-token",
      ACCOUNT,
      { description: "CI" },
      "acct:depot-project:p1",
    );
    expect(calls[0]!.body).toEqual({ projectId: "p1", description: "CI" });
    expect(token.id).toBe("acct:depot-token:p1/tok1");
    expect(token.resolvedOutputs["token"]).toBe("s3cret");
  });

  it("adds a GitLab trust relationship", async () => {
    const calls = installApi({
      "depot.core.v1.ProjectService/AddTrustPolicy": (body) => ({
        trustPolicy: { trustPolicyId: "t3", gitlab: (body as { gitlab: unknown }).gitlab },
      }),
    });
    const created = await client().createResource("depot-trust-policy", ACCOUNT, {
      projectId: "p1",
      provider: "gitlab",
      namespaceId: "acme",
      gitlabProject: "api",
    });
    expect(calls[0]!.body).toEqual({
      projectId: "p1",
      gitlab: { namespaceId: "acme", projectId: "api" },
    });
    expect(created.fields["subject"]).toBe("acme/api");
  });

  it("deletes children through their project", async () => {
    const calls = installApi({
      "depot.core.v1.ProjectService/RemoveTrustPolicy": () => ({}),
      "depot.build.v1.RegistryService/DeleteImage": () => ({}),
      "depot.core.v1.ProjectService/DeleteToken": () => ({}),
    });
    const c = client();
    await c.deleteResource("depot-trust-policy", "acct:depot-trust-policy:p1/t1", ACCOUNT);
    await c.deleteResource("depot-registry-image", "acct:depot-registry-image:p1/latest", ACCOUNT);
    await c.deleteResource("depot-token", "acct:depot-token:p1/tok1", ACCOUNT);
    expect(calls.map((x) => x.body)).toEqual([
      { projectId: "p1", trustPolicyId: "t1" },
      { projectId: "p1", imageTags: ["latest"] },
      { tokenId: "tok1" },
    ]);
  });

  it("resets a project's cache behind a destructive, confirmed action", async () => {
    const calls = installApi({
      ...PROJECTS,
      "depot.core.v1.ProjectService/ResetProject": () => ({}),
    });
    const c = client();
    const [project] = await c.listResources("depot-project", ACCOUNT);
    const reset = c
      .renderDetail(project!)
      .headerActions!.find((a) => a.action.type === "plugin-action")!;
    expect(reset.action).toMatchObject({ actionId: "reset-cache", destructive: true });
    expect((reset.action as { confirmMessage?: string }).confirmMessage).toMatch(/deletes/);
    await c.invokeAction("depot-project", "acct:depot-project:p1", "reset-cache", ACCOUNT);
    expect(calls.at(-1)).toEqual({
      method: "depot.core.v1.ProjectService/ResetProject",
      body: { projectId: "p1" },
    });
  });

  it("lists GitHub Actions repositories for the billing cycle", async () => {
    installApi({
      "depot.core.v1.UsageService/GetUsage": () => ({
        githubActionsJobs: [
          {
            repo: "acme/api",
            jobs: [
              {
                workflow: "ci",
                runner: "depot-ubuntu-24.04",
                jobCount: 4,
                minutesElapsed: 8,
                minutesBilled: 8,
              },
              {
                workflow: "e2e",
                runner: "depot-ubuntu-24.04-8",
                jobCount: 1,
                minutesElapsed: 2,
                minutesBilled: 8,
              },
            ],
          },
        ],
      }),
    });
    const c = client();
    const [repo] = await c.listResources("depot-actions-repo", ACCOUNT);
    expect(repo!.fields).toMatchObject({ repo: "acme/api", jobs: 5, minutesBilled: 16 });
    const detail = c.renderDetail(repo!);
    const table = detail.sections[1]!.children[0] as {
      rows: Array<{ cells: Record<string, string> }>;
    };
    expect(table.rows[0]!.cells["workflow"]).toBe("ci");
  });
});

const LIST = {
  projects: "depot.core.v1.ProjectService/ListProjects",
  usage: "depot.core.v1.UsageService/ListProjectUsage",
  builds: "depot.core.v1.BuildService/ListBuilds",
  tokens: "depot.core.v1.ProjectService/ListTokens",
  trust: "depot.core.v1.ProjectService/ListTrustPolicies",
  images: "depot.build.v1.RegistryService/ListImages",
};
const TRUNCATED = "has more than Infrawrench reads";
const NOT_A_LIST = "is not a list";
const countOf = (calls: Call[], method: string) => calls.filter((c) => c.method === method).length;

describe("list reads a sync prunes by", () => {
  const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");
  afterEach(() => {
    Reflect.deleteProperty(globalThis, UNREAD_HOOK);
  });

  /** Two pages, the second only reachable through the first's token. */
  const twoPages =
    <K extends string>(key: K, first: object, second: object) =>
    (body: Record<string, unknown>) =>
      body["pageToken"] === "next"
        ? { [key]: [second] }
        : { [key]: [first], nextPageToken: "next" };

  it("asks for projects at the documented maximum and throws past the row ceiling", async () => {
    const calls = installApi({
      ...PROJECTS,
      [LIST.projects]: () => ({ projects: [{ projectId: "p" }], nextPageToken: "more" }),
    });
    await expect(client().listResources("depot-project", ACCOUNT)).rejects.toThrow(TRUNCATED);
    expect(countOf(calls, LIST.projects)).toBe(400);
    expect(calls.find((c) => c.method === LIST.projects)!.body["pageSize"]).toBe(250);
  });

  it("reads an account with no projects, which proto3 JSON answers with no list at all", async () => {
    installApi({ [LIST.projects]: () => ({}), [LIST.usage]: () => ({}) });
    await expect(client().listResources("depot-project", ACCOUNT)).resolves.toEqual([]);
  });

  it("keeps reading past an empty page that still carries a token", async () => {
    const calls = installApi({
      [LIST.usage]: () => ({}),
      [LIST.projects]: (body) =>
        body["pageToken"] === "next"
          ? { projects: [{ projectId: "p2" }] }
          : { nextPageToken: "next" },
    });
    const projects = await client().listResources("depot-project", ACCOUNT);
    expect(projects.map((p) => p.externalId)).toEqual(["p2"]);
    expect(countOf(calls, LIST.projects)).toBe(2);
  });

  it.each([
    ["a list that is not an array", { projects: "oops" }],
    ["a whole answer that is an array", []],
    ["a whole answer of null", null],
  ])("throws on %s on the first page", async (_name, page) => {
    installApi({ ...PROJECTS, [LIST.projects]: () => page });
    await expect(client().listResources("depot-project", ACCOUNT)).rejects.toThrow(NOT_A_LIST);
  });

  it("throws on a bad page after a good one", async () => {
    installApi({
      ...PROJECTS,
      [LIST.projects]: (body) =>
        body["pageToken"] === "next"
          ? { projects: { renamed: true } }
          : { projects: [{ projectId: "p1" }], nextPageToken: "next" },
    });
    await expect(client().listResources("depot-project", ACCOUNT)).rejects.toThrow(NOT_A_LIST);
  });

  it("throws when the host answers a list with an empty body", async () => {
    const request = vi.fn(async () => ({ status: 200, headers: {}, body: "" }));
    const fetchStub = vi.spyOn(globalThis, "fetch");
    const hosted = hostClient(new DepotClient({ token: "t" }, { http: { request } }));
    await expect(hosted.listResources("depot-project", ACCOUNT)).rejects.toThrow(NOT_A_LIST);
    expect(request).toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("goes through the host's HTTP service with no CA set", async () => {
    const request = vi.fn(
      async (_req: { url: string; caCert?: string }) =>
        ({ status: 200, headers: {}, body: "{}" }) as const,
    );
    const fetchStub = vi.spyOn(globalThis, "fetch");
    const hosted = hostClient(new DepotClient({ token: "t" }, { http: { request } }));
    await hosted.listResources("depot-project", ACCOUNT);
    expect(request.mock.calls[0]![0]).not.toHaveProperty("caCert");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("still lists projects when the usage read fails, but not when it is cut short", async () => {
    installApi({ ...PROJECTS, [LIST.usage]: () => new Failure(503, "unavailable") });
    const [project] = await client().listResources("depot-project", ACCOUNT);
    expect(project!.externalId).toBe("p1");

    const calls = installApi({
      ...PROJECTS,
      [LIST.usage]: () => ({ usage: [{ projectId: "x" }], nextPageToken: "more" }),
    });
    await expect(client().listResources("depot-project", ACCOUNT)).rejects.toThrow(TRUNCATED);
    expect(countOf(calls, LIST.usage)).toBe(1000);
  });

  it("follows the pages of a project's tokens", async () => {
    const calls = installApi({
      ...PROJECTS,
      [LIST.tokens]: twoPages("tokens", { tokenId: "t1" }, { tokenId: "t2" }),
    });
    const tokens = await client().listResources("depot-token", ACCOUNT);
    expect(tokens.map((t) => t.externalId)).toEqual(["p1/t1", "p1/t2"]);
    expect(calls.find((c) => c.method === LIST.tokens)!.body).toEqual({
      projectId: "p1",
      pageSize: 250,
    });
  });

  it("follows the pages of a project's trust policies", async () => {
    const calls = installApi({
      ...PROJECTS,
      [LIST.trust]: twoPages(
        "trustPolicies",
        { trustPolicyId: "t1", github: { repositoryOwner: "a", repository: "b" } },
        { trustPolicyId: "t2", github: { repositoryOwner: "a", repository: "c" } },
      ),
    });
    const policies = await client().listResources("depot-trust-policy", ACCOUNT);
    expect(policies.map((t) => t.externalId)).toEqual(["p1/t1", "p1/t2"]);
    expect(calls.find((c) => c.method === LIST.trust)!.body["pageSize"]).toBe(250);
  });

  it.each([
    ["depot-token", LIST.tokens, "tokens", 40],
    ["depot-trust-policy", LIST.trust, "trustPolicies", 40],
    ["depot-registry-image", LIST.images, "images", 100],
  ])("throws when %s runs past its cap", async (type, method, key, requests) => {
    const calls = installApi({
      ...PROJECTS,
      [method]: () => ({ [key]: [], nextPageToken: "more" }),
    });
    await expect(client().listResources(type, ACCOUNT)).rejects.toThrow(TRUNCATED);
    expect(countOf(calls, method)).toBe(requests);
  });

  it("reads images past the old 200 cap", async () => {
    const tag = (page: number, i: number) => ({ tag: `v${page}-${i}` });
    installApi({
      ...PROJECTS,
      [LIST.images]: (body) => {
        const page = Number(body["pageToken"] ?? 0);
        return {
          images: Array.from({ length: 100 }, (_, i) => tag(page, i)),
          ...(page < 2 ? { nextPageToken: String(page + 1) } : {}),
        };
      },
    });
    const images = await client().listResources("depot-registry-image", ACCOUNT);
    expect(images).toHaveLength(300);
  });

  it.each([
    ["a 5xx", 503, "unavailable"],
    ["a throttle", 429, "resource_exhausted"],
    ["an expired credential", 401, "unauthenticated"],
    ["a missing route", 404, "not_found"],
  ])("fails the image list on %s rather than reading none", async (_name, status, code) => {
    installApi({ ...PROJECTS, [LIST.images]: () => new Failure(status, code) });
    await expect(client().listResources("depot-registry-image", ACCOUNT)).rejects.toThrow(
      String(status),
    );
  });

  it("fails the image list on a page that is not a list", async () => {
    installApi({ ...PROJECTS, [LIST.images]: () => ({ images: "oops" }) });
    await expect(client().listResources("depot-registry-image", ACCOUNT)).rejects.toThrow(
      NOT_A_LIST,
    );
  });

  const TWO_PROJECTS = {
    [LIST.projects]: () => ({ projects: [{ projectId: "p1" }, { projectId: "p2" }] }),
    [LIST.images]: (body: Record<string, unknown>) =>
      body["projectId"] === "p1"
        ? new Failure(403, "permission_denied")
        : { images: [{ tag: "latest" }] },
  };

  it("keeps a refused project's stored images without failing the type", async () => {
    const unread = vi.fn();
    Reflect.set(globalThis, UNREAD_HOOK, unread);
    installApi(TWO_PROJECTS);
    const images = await client().listResources("depot-registry-image", ACCOUNT);
    expect(images.map((i) => i.externalId)).toEqual(["p2/latest"]);
    expect(unread).toHaveBeenCalledWith({ parentResourceIds: ["acct:depot-project:p1"] });
  });

  it("shows the refusal on a host that keeps no track of stored rows", async () => {
    installApi(TWO_PROJECTS);
    await expect(client().listResources("depot-registry-image", ACCOUNT)).rejects.toThrow("403");
  });

  it("reads builds as a rolling window of the first page", async () => {
    const calls = installApi({
      ...PROJECTS,
      [LIST.builds]: () => ({ builds: [{ buildId: "b1" }], nextPageToken: "older" }),
    });
    const builds = await client().listResources("depot-build", ACCOUNT);
    expect(builds.map((b) => b.externalId)).toEqual(["p1/b1"]);
    expect(countOf(calls, LIST.builds)).toBe(1);
  });

  it.each([
    ["depot-build", LIST.builds, { builds: "oops" }],
    ["depot-token", LIST.tokens, { tokens: "oops" }],
    ["depot-trust-policy", LIST.trust, { trustPolicies: "oops" }],
  ])("fails %s on a page that is not a list", async (type, method, page) => {
    installApi({ ...PROJECTS, [method]: () => page });
    await expect(client().listResources(type, ACCOUNT)).rejects.toThrow(NOT_A_LIST);
  });

  it("fails the actions repositories on a usage answer with no body", async () => {
    const request = vi.fn(async () => ({ status: 200, headers: {}, body: "" }));
    const hosted = hostClient(new DepotClient({ token: "t" }, { http: { request } }));
    await expect(hosted.listResources("depot-actions-repo", ACCOUNT)).rejects.toThrow(NOT_A_LIST);
  });

  it("charts a project from part of its history when it runs past the chart's cap", async () => {
    const calls = installApi({
      [LIST.builds]: () => ({
        builds: [{ buildId: "b", createdAt: new Date().toISOString(), buildDurationSeconds: 60 }],
        nextPageToken: "more",
      }),
    });
    const series = await client().fetchMetricSeries(
      "depot-project",
      "acct:depot-project:p1",
      ACCOUNT,
    );
    expect(series.find((s) => s.label === "Builds")!.points.at(-1)!.value).toBe(10);
    expect(countOf(calls, LIST.builds)).toBe(10);
  });
});

describe("metrics", () => {
  it("charts build minutes, builds and cache hit rate per day", () => {
    const day0 = Date.parse("2026-10-01T00:00:00Z");
    const days = dayBuckets(day0, day0 + 2 * 86_400_000);
    const series = buildSeries(
      [
        {
          createdAt: "2026-10-01T05:00:00Z",
          buildDurationSeconds: 120,
          cachedSteps: 1,
          totalSteps: 4,
          status: "STATUS_FAILED",
        },
        {
          createdAt: "2026-10-01T06:00:00Z",
          buildDurationSeconds: 60,
          cachedSteps: 3,
          totalSteps: 4,
        },
      ],
      days,
    );
    const get = (label: string) => series.find((s) => s.label === label)!;
    expect(get("Build minutes").points.map((p) => p.value)).toEqual([3, 0]);
    expect(get("Builds").points.map((p) => p.value)).toEqual([2, 0]);
    expect(get("Failed builds").points[0]!.value).toBe(1);
    // A day with no steps has no hit rate rather than 0%.
    expect(get("Cache hit rate").points).toEqual([{ timestamp: day0, value: 50 }]);
  });
});

describe("quotas", () => {
  it("reads cycle usage against the plan's allowances", async () => {
    const calls = installApi({
      "depot.core.v1.UsageService/GetUsage": () => ({
        containerBuild: [{ projectName: "web", minutesBilled: 1200 }],
        githubActionsJobs: [
          {
            repo: "acme/api",
            jobs: [
              { runner: "depot-ubuntu-24.04", minutesBilled: 300 },
              { runner: "depot-macos-15", minutesBilled: 50 },
            ],
          },
        ],
        storage: [{ storageType: "cache", totalGb: 40 }],
      }),
    });
    const quotas = await fetchDepotQuotas(
      { token: "t" },
      resolveRates("startup", "cycleStartDay=15").rates,
      new Date("2026-10-04T12:00:00Z"),
    );
    expect(calls[0]!.body["startAt"]).toBe("2026-09-15T00:00:00.000Z");
    expect(quotas.map((q) => [q.id, q.used, q.limit])).toEqual([
      ["included-build-minutes", 1200, 5000],
      ["included-actions-minutes", 300, 20000],
      ["included-storage", 40, 250],
    ]);
  });

  it("reports nothing for a plan without allowances", async () => {
    installApi({ "depot.core.v1.UsageService/GetUsage": () => ({}) });
    expect(await fetchDepotQuotas({ token: "t" }, resolveRates("business", "").rates)).toEqual([]);
  });
});

describe("status feed", () => {
  it("keeps unresolved incidents and maps builder regions", () => {
    const body = JSON.stringify({
      incidents: [
        {
          id: "i1",
          name: "Slow builds in Frankfurt",
          status: "investigating",
          impact: "minor",
          created_at: "2026-10-04T10:00:00Z",
          updated_at: "2026-10-04T10:05:00Z",
          resolved_at: null,
          components: [{ name: "eu-central-1" }],
          incident_updates: [],
        },
        {
          id: "i2",
          name: "Old",
          status: "resolved",
          impact: "minor",
          created_at: "2026-09-01T10:00:00Z",
          updated_at: "2026-09-01T11:00:00Z",
          resolved_at: "2026-09-01T11:00:00Z",
          incident_updates: [],
        },
      ],
    });
    const incidents = parseStatusFeed(body);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.regions).toEqual(["eu-central-1"]);
  });
});
