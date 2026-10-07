import { describe, expect, it } from "vitest";
import { JfrogApiError, normaliseBaseUrl } from "../api.js";
import { JfrogClient, tokenIdFromJwt } from "../client.js";
import { parseBuildRunId, parsePercent, parseSize, violationId } from "../mappers.js";
import { platformSeries } from "../metrics.js";
import { reindexPath } from "../reindex.js";
import { renderJfrogDetail } from "../render.js";
import { mapComponent, parseStatusFeed } from "../status-feed.js";
import { jfrogTerraformExport, repositoryResourceType } from "../terraform.js";
import type { Call } from "./helpers.js";
import { makeHttp } from "./helpers.js";

const ACCOUNT = "acct";
const creds = { baseUrl: "acme.jfrog.io/ui/", accessToken: "tok" };

function client(route: (call: Call) => unknown) {
  const { http, calls } = makeHttp(route);
  return { c: new JfrogClient(creds, { http } as never), calls };
}

function jwt(claims: Record<string, unknown>): string {
  const b64 = btoa(JSON.stringify(claims))
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `eyJhbGciOiJSUzI1NiJ9.${b64}.sig`;
}

describe("helpers", () => {
  it("normalises the platform URL", () => {
    expect(normaliseBaseUrl("acme.jfrog.io/ui/")).toBe("https://acme.jfrog.io");
    expect(normaliseBaseUrl("https://rt.example.com/artifactory/")).toBe("https://rt.example.com");
    expect(normaliseBaseUrl("http://10.0.0.5:8082")).toBe("http://10.0.0.5:8082");
  });

  it("parses storage display strings", () => {
    expect(parseSize("1.5 GB")).toBe(Math.round(1.5 * 1024 ** 3));
    expect(parseSize("2,084,408")).toBe(2084408);
    expect(parseSize("32.22 GB (15.77%)")).toBe(Math.round(32.22 * 1024 ** 3));
    expect(parseSize("n/a")).toBeUndefined();
    expect(parsePercent("32.22 GB (15.77%)")).toBe(15.77);
  });

  it("splits build run ids on the last slash", () => {
    expect(parseBuildRunId("team/app/42")).toEqual({ name: "team/app", number: "42" });
    expect(() => parseBuildRunId("nope")).toThrow();
  });

  it("keys violations by their details URL", () => {
    expect(
      violationId({ violation_details_url: "https://x/xray/api/v1/violations/security/abc123" }),
    ).toBe("abc123");
    expect(violationId({ issue_id: "XRAY-1", watch_name: "w" })).toBe("XRAY-1|w|");
  });

  it("reads the token id out of the JWT", () => {
    expect(tokenIdFromJwt(jwt({ jti: "tid-1", sub: "x" }))).toBe("tid-1");
    expect(tokenIdFromJwt("not-a-jwt")).toBeUndefined();
  });

  it("knows which package types have an index", () => {
    expect(reindexPath("npm", "npm-local")).toBe("/artifactory/api/npm/npm-local/reindex");
    expect(reindexPath("Debian", "deb")).toBe("/artifactory/api/deb/reindex/deb");
    expect(reindexPath("rpm", "yum-local")).toBe("/artifactory/api/yum/yum-local");
    expect(reindexPath("generic", "g")).toBeUndefined();
  });
});

describe("requests", () => {
  it("sends a Bearer token and maps errors to a status", async () => {
    const { c, calls } = client(() => ({
      status: 403,
      body: { errors: [{ status: 403, message: "Forbidden" }] },
    }));
    const err = await c.listResources("jfrog-access-token", ACCOUNT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JfrogApiError);
    expect((err as JfrogApiError).status).toBe(403);
    expect((err as Error).message).toContain("Forbidden");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer tok");
    expect(calls[0]!.url.origin).toBe("https://acme.jfrog.io");
  });

  it("follows Access cursors across pages", async () => {
    const { c, calls } = client((call) => {
      if (call.url.pathname === "/access/api/v2/groups") {
        return call.url.searchParams.get("cursor")
          ? { groups: [{ group_name: "b" }] }
          : { groups: [{ group_name: "a" }], cursor: "a" };
      }
      const name = call.url.pathname.split("/").pop();
      return { name, members: ["alice"], admin_privileges: name === "b" };
    });
    const groups = await c.listResources("jfrog-group", ACCOUNT);
    expect(groups.map((g) => g.externalId)).toEqual(["a", "b"]);
    expect(groups[1]!.fields["adminPrivileges"]).toBe(true);
    expect(calls.filter((x) => x.url.pathname === "/access/api/v2/groups")).toHaveLength(2);
  });
});

describe("repositories", () => {
  const storage = {
    binariesSummary: { artifactsSize: "1 GB", artifactsCount: "10" },
    repositoriesSummaryList: [
      { repoKey: "libs-local", repoType: "LOCAL", filesCount: 3, itemsCount: 4, usedSpace: "2 MB" },
      { repoKey: "TOTAL", repoType: "NA" },
    ],
  };

  it("lists with one configurations call and joins storage", async () => {
    const { c } = client((call) => {
      switch (call.url.pathname) {
        case "/artifactory/api/repositories":
          return [
            { key: "libs-local", type: "LOCAL", packageType: "Maven" },
            { key: "npm-remote", type: "REMOTE", packageType: "Npm" },
            { key: "all", type: "VIRTUAL", packageType: "Maven" },
          ];
        case "/artifactory/api/repositories/configurations":
          return {
            LOCAL: [{ key: "libs-local", packageType: "maven", xrayIndex: true }],
            REMOTE: [{ key: "npm-remote", packageType: "npm", url: "https://registry.npmjs.org" }],
            VIRTUAL: [
              {
                key: "all",
                packageType: "maven",
                repositories: ["libs-local"],
                defaultDeploymentRepo: "libs-local",
              },
            ],
          };
        case "/artifactory/api/storageinfo":
          return storage;
        default:
          return { status: 404, body: {} };
      }
    });
    const repos = await c.listResources("jfrog-repository", ACCOUNT);
    const byKey = Object.fromEntries(repos.map((r) => [r.externalId, r.fields]));
    expect(byKey["libs-local"]).toMatchObject({
      rclass: "local",
      packageType: "maven",
      filesCount: 3,
      usedSpaceBytes: 2 * 1024 ** 2,
    });
    expect(byKey["npm-remote"]).toMatchObject({
      rclass: "remote",
      remoteUrl: "https://registry.npmjs.org",
    });
    expect(byKey["all"]).toMatchObject({ rclass: "virtual", repositories: "libs-local" });
    expect(repos[0]!.resolvedOutputs["url"]).toBe("https://acme.jfrog.io/artifactory/libs-local");
  });

  it("falls back to per-repository reads when the bulk call is refused", async () => {
    const { c, calls } = client((call) => {
      if (call.url.pathname === "/artifactory/api/repositories")
        return [{ key: "a", type: "LOCAL" }];
      if (call.url.pathname === "/artifactory/api/repositories/configurations")
        return { status: 403, body: {} };
      if (call.url.pathname === "/artifactory/api/repositories/a")
        return { key: "a", rclass: "local", packageType: "generic" };
      return { status: 403, body: {} };
    });
    const repos = await c.listResources("jfrog-repository", ACCOUNT);
    expect(repos[0]!.fields["packageType"]).toBe("generic");
    expect(calls.some((x) => x.url.pathname === "/artifactory/api/repositories/a")).toBe(true);
  });

  it("updates with a partial POST", async () => {
    const { c, calls } = client((call) => {
      if (call.url.pathname === "/artifactory/api/repositories/r" && call.method === "GET") {
        return { key: "r", rclass: "remote", packageType: "npm", url: "https://old" };
      }
      if (call.method === "POST") return { text: "Repository updated" };
      return {};
    });
    await c.updateResource("jfrog-repository", `${ACCOUNT}:jfrog-repository:r`, ACCOUNT, {
      remoteUrl: "https://new.example.com",
      offline: "true",
    });
    const post = calls.find((x) => x.method === "POST")!;
    expect(post.url.pathname).toBe("/artifactory/api/repositories/r");
    expect(post.body).toEqual({
      key: "r",
      rclass: "remote",
      url: "https://new.example.com",
      offline: true,
    });
  });

  it("creates a virtual repository from picked members", async () => {
    const { c, calls } = client((call) => {
      if (call.method === "PUT") return { text: "Successfully created repository" };
      if (call.url.pathname === "/artifactory/api/repositories/v")
        return { key: "v", rclass: "virtual", packageType: "npm" };
      return {};
    });
    await c.createResource("jfrog-repository", ACCOUNT, {
      key: "v",
      rclass: "virtual",
      packageType: "npm",
      repositories: '["a","b"]',
    });
    const put = calls.find((x) => x.method === "PUT")!;
    expect(put.body).toMatchObject({
      key: "v",
      rclass: "virtual",
      packageType: "npm",
      repositories: ["a", "b"],
    });
  });
});

describe("storage browser", () => {
  it("lists a folder with sizes", async () => {
    const { c, calls } = client(() => ({
      files: [
        { uri: "/sub", folder: true, size: "-1" },
        { uri: "/a.jar", folder: false, size: "1024", lastModified: "2026-01-01T00:00:00Z" },
      ],
    }));
    const items = await c.listStorageObjects("libs-local", "org/acme");
    expect(calls[0]!.url.pathname).toBe("/artifactory/api/storage/libs-local/org/acme");
    expect(calls[0]!.url.search).toBe("?list&deep=0&listFolders=1");
    expect(items).toEqual([
      { key: "org/acme/sub/", name: "sub", size: 0, lastModified: "", isDirectory: true },
      {
        key: "org/acme/a.jar",
        name: "a.jar",
        size: 1024,
        lastModified: "2026-01-01T00:00:00Z",
        isDirectory: false,
      },
    ]);
  });

  it("falls back to folder info without a Pro license", async () => {
    const { c } = client((call) =>
      call.url.search ? { status: 400, body: {} } : { children: [{ uri: "/x", folder: false }] },
    );
    const items = await c.listStorageObjects("r", "");
    expect(items).toEqual([{ key: "x", name: "x", size: 0, lastModified: "", isDirectory: false }]);
  });

  it("points remote repositories at their cache", () => {
    const c = new JfrogClient(creds);
    const detail = c.renderDetail({
      id: `${ACCOUNT}:jfrog-repository:npm-remote`,
      pluginId: "jfrog",
      resourceTypeId: "jfrog-repository",
      accountId: ACCOUNT,
      displayName: "npm-remote",
      fields: { key: "npm-remote", rclass: "remote", packageType: "npm" },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    });
    expect(detail.storageBrowser?.bucketName).toBe("npm-remote-cache");
    expect(detail.headerActions?.map((a) => a.label)).toContain("Zap cache");
    expect(detail.headerActions?.map((a) => a.label)).toContain("Recalculate index");
  });
});

describe("tokens, users, builds, xray", () => {
  it("creates a token and keeps its value as a secret", async () => {
    const token = jwt({ jti: "tid-9" });
    const { c, calls } = client((call) => {
      if (call.method === "POST") return { access_token: token, expires_in: 86400 };
      return {
        token_id: "tid-9",
        subject: "jfac@x/users/ci",
        description: "CI",
        expiry: 1900000000,
        issued_at: 1800000000,
      };
    });
    const r = await c.createResource("jfrog-access-token", ACCOUNT, {
      description: "CI",
      scope: "applied-permissions/user",
      expiresIn: "86400",
      username: "ci",
    });
    expect(calls[0]!.body).toMatchObject({
      scope: "applied-permissions/user",
      expires_in: 86400,
      username: "ci",
      refreshable: false,
    });
    expect(r.externalId).toBe("tid-9");
    expect(r.fields["username"]).toBe("ci");
    expect(r.secretStates[0]).toEqual({
      fieldKey: "accessToken",
      resolution: { kind: "plaintext", value: token },
    });
  });

  it("diffs group membership on user edit", async () => {
    const { c, calls } = client((call) => {
      if (call.method === "GET") return { username: "alice", groups: ["readers", "old"] };
      return {};
    });
    await c.updateResource("jfrog-user", `${ACCOUNT}:jfrog-user:alice`, ACCOUNT, {
      groups: "readers, new",
      admin: "false",
    });
    const patches = calls.filter((x) => x.method === "PATCH");
    expect(patches[0]!.body).toEqual({ admin: false });
    expect(patches[1]!.url.pathname).toBe("/access/api/v2/users/alice/groups");
    expect(patches[1]!.body).toEqual({ add: ["new"], remove: ["old"] });
  });

  it("lists recent build runs and deletes one", async () => {
    const { c, calls } = client((call) => {
      if (call.url.pathname === "/artifactory/api/build")
        return { builds: [{ uri: "/app", lastStarted: "2026-01-02" }] };
      if (call.url.pathname === "/artifactory/api/build/app")
        return {
          buildsNumbers: [
            { uri: "/1", started: "2026-01-01" },
            { uri: "/2", started: "2026-01-02" },
          ],
        };
      return { text: "Builds deleted successfully" };
    });
    const runs = await c.listResources("jfrog-build-run", ACCOUNT);
    expect(runs.map((r) => r.externalId)).toEqual(["app/2", "app/1"]);
    expect(runs[0]!.parentResourceId).toBe(`${ACCOUNT}:jfrog-build:app`);
    await c.deleteResource("jfrog-build-run", runs[0]!.id, ACCOUNT);
    expect(calls.at(-1)!.body).toEqual({
      buildName: "app",
      buildNumbers: ["2"],
      deleteArtifacts: false,
    });
  });

  it("treats a missing Xray as no watches and toggles a watch", async () => {
    const none = client(() => ({ status: 404, body: { error: "not found" } }));
    expect(await none.c.listResources("jfrog-xray-watch", ACCOUNT)).toEqual([]);
    const { c, calls } = client((call) =>
      call.method === "GET"
        ? { general_data: { name: "w", active: true }, assigned_policies: [{ name: "p" }] }
        : { info: "ok" },
    );
    await c.invokeAction("jfrog-xray-watch", `${ACCOUNT}:jfrog-xray-watch:w`, "disable", ACCOUNT);
    expect(calls[1]!.method).toBe("PUT");
    expect(calls[1]!.body).toMatchObject({
      general_data: { name: "w", active: false },
      assigned_policies: [{ name: "p" }],
    });
  });

  it("searches violations newest first", async () => {
    const { c, calls } = client(() => ({
      total_violations: 1,
      violations: [
        {
          issue_id: "XRAY-1",
          severity: "High",
          watch_name: "w",
          violation_details_url: "https://x/v/abc",
        },
      ],
    }));
    const v = await c.listResources("jfrog-xray-violation", ACCOUNT);
    expect(v[0]!.externalId).toBe("abc");
    expect(calls[0]!.body).toMatchObject({
      pagination: { order_by: "created", direction: "desc", limit: 100 },
    });
  });
});

describe("metrics, status feed, terraform", () => {
  it("turns the storage summary into series", () => {
    const series = platformSeries(
      { binariesSummary: { artifactsSize: "2 GB" }, fileStoreSummary: { usedSpace: "1 GB (50%)" } },
      1000,
    );
    expect(series.find((s) => s.label === "Artifacts size")?.points).toEqual([
      { timestamp: 1000, value: 2 * 1024 ** 3 },
    ]);
    expect(
      series.find((s) => s.unit === "%" && s.label === "File store used")?.points[0]?.value,
    ).toBe(50);
  });

  it("maps status components by product", () => {
    expect(mapComponent("Artifactory")?.resourceTypes).toContain("jfrog-repository");
    expect(mapComponent("Security - Xray")?.services).toEqual(["Xray"]);
    expect(mapComponent("JFrog Connect")).toBeNull();
    const incidents = parseStatusFeed(
      JSON.stringify({
        incidents: [
          {
            id: "i1",
            name: "Slow Maven remotes",
            status: "investigating",
            impact: "minor",
            created_at: "2026-10-01T00:00:00Z",
            components: [{ name: "Artifactory" }],
            incident_updates: [],
          },
        ],
      }),
    );
    expect(incidents[0]?.resourceTypes).toContain("jfrog-repository");
  });

  it("maps repositories to the provider's per-type resources", () => {
    expect(repositoryResourceType("local", "docker")).toBe(
      "artifactory_local_docker_v2_repository",
    );
    expect(repositoryResourceType("remote", "npm")).toBe("artifactory_remote_npm_repository");
    expect(repositoryResourceType("local", "terraform")).toBeNull();
    const out = jfrogTerraformExport.mapResource({
      id: "a:jfrog-repository:all",
      pluginId: "jfrog",
      resourceTypeId: "jfrog-repository",
      accountId: "a",
      displayName: "all",
      externalId: "all",
      fields: { key: "all", rclass: "virtual", packageType: "maven", repositories: "a, b" },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    });
    expect(out?.resource.type).toBe("artifactory_virtual_maven_repository");
    expect(out?.resource.attributes["repositories"]).toEqual({
      kind: "list",
      items: [
        { kind: "string", value: "a" },
        { kind: "string", value: "b" },
      ],
    });
  });

  it("renders the permission grants table", () => {
    const detail = renderJfrogDetail(
      {
        id: "a:jfrog-permission:p",
        pluginId: "jfrog",
        resourceTypeId: "jfrog-permission",
        accountId: "a",
        displayName: "p",
        fields: { name: "p" },
        resolvedOutputs: {
          __permission__: JSON.stringify({
            artifact: {
              actions: { users: { alice: ["READ", "WRITE"] } },
              targets: { "libs-local": { include_patterns: ["**"] } },
            },
          }),
        },
        secretStates: [],
        createdAt: "",
        updatedAt: "",
      },
      "https://acme.jfrog.io",
    );
    expect(detail.sections.map((s) => s.title)).toEqual(["Permission", "Targets", "Grants"]);
  });
});
