import { describe, expect, it } from "vitest";
import { HubApiError, secretKind } from "../api.js";
import { DockerHubClient, parseRateHeader } from "../client.js";
import { mapRepository, splitTagId } from "../mappers.js";
import { plugin } from "../plugin.js";
import { isRelevant, parseStatusFeed } from "../status-feed.js";
import { dockerHubTerraformExport } from "../terraform.js";
import type { Call } from "./helpers.js";
import { makeHttp } from "./helpers.js";

const ACCOUNT = "acct";

/** Routes `/v2/auth/token` to a JWT and everything else to `route`. */
function hub(route: (call: Call) => unknown) {
  return makeHttp((call) => {
    if (call.url.pathname === "/v2/auth/token") return { access_token: "jwt-1" };
    return route(call);
  });
}

function client(route: (call: Call) => unknown, creds: Record<string, string> = {}) {
  const { http, calls } = hub(route);
  return {
    c: new DockerHubClient(
      { username: "alice", token: "dckr_pat_x", namespaces: "alice, acme", ...creds },
      { http } as never,
    ),
    calls,
  };
}

describe("helpers", () => {
  it("recognises token kinds", () => {
    expect(secretKind("dckr_oat_1")).toBe("oat");
    expect(secretKind("dckr_pat_1")).toBe("pat");
    expect(secretKind("hunter2")).toBe("password");
  });

  it("parses rate-limit headers", () => {
    expect(parseRateHeader("200;w=21600")).toEqual({ value: 200, window: 21600 });
    expect(parseRateHeader("5")).toEqual({ value: 5 });
    expect(parseRateHeader(undefined)).toBeUndefined();
  });

  it("splits tag ids", () => {
    expect(splitTagId("acme/api:1.2")).toEqual({ ns: "acme", repo: "api", tag: "1.2" });
  });

  it("maps library repositories to their short image name", () => {
    const r = mapRepository(ACCOUNT, { namespace: "library", name: "nginx", pull_count: 5 });
    expect(r.resolvedOutputs["image"]).toBe("docker.io/nginx");
    expect(r.parentResourceId).toBe(`${ACCOUNT}:dockerhub-namespace:library`);
  });
});

describe("auth", () => {
  it("exchanges the token for a JWT once and sends it as a Bearer", async () => {
    const { c, calls } = client(() => ({ results: [], next: null }));
    await c.listResources("dockerhub-repository", ACCOUNT);
    const login = calls.filter((x) => x.url.pathname === "/v2/auth/token");
    expect(login).toHaveLength(1);
    expect(login[0]!.body).toEqual({ identifier: "alice", secret: "dckr_pat_x" });
    expect(calls[1]!.headers["Authorization"]).toBe("Bearer jwt-1");
  });

  it("re-exchanges after a 401 and surfaces other errors with a status", async () => {
    let first = true;
    const { c, calls } = client(() => {
      if (first) {
        first = false;
        return { status: 401, body: { detail: "expired" } };
      }
      return { status: 403, body: { message: "forbidden" } };
    });
    const err = await c.listResources("dockerhub-repository", ACCOUNT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HubApiError);
    expect((err as HubApiError).status).toBe(403);
    expect(calls.filter((x) => x.url.pathname === "/v2/auth/token")).toHaveLength(2);
  });

  it("lists namespaces for the credential picker", async () => {
    const { http } = hub((call) =>
      call.url.pathname === "/v2/user/orgs/" ? { results: [{ orgname: "acme" }], next: null } : {},
    );
    const opts = await plugin.listCredentialOptions!(
      "namespaces",
      { username: "alice", token: "dckr_pat_x" },
      { http } as never,
    );
    expect(opts.map((o) => o.id)).toEqual(["alice", "acme"]);
  });

  it("an organization token manages only its organization", async () => {
    const { http, calls } = hub(() => ({ results: [], next: null }));
    const c = new DockerHubClient({ username: "acme", token: "dckr_oat_x" }, { http } as never);
    await c.listResources("dockerhub-repository", ACCOUNT);
    expect(calls.map((x) => x.url.pathname)).toContain("/v2/namespaces/acme/repositories");
    expect(await c.listResources("dockerhub-access-token", ACCOUNT)).toEqual([]);
  });
});

describe("repositories and tags", () => {
  it("follows next links across pages", async () => {
    const { c } = client((call) => {
      if (call.url.pathname !== "/v2/namespaces/alice/repositories")
        return { results: [], next: null };
      return call.url.searchParams.get("page") === "2"
        ? { results: [{ namespace: "alice", name: "b" }], next: null }
        : {
            results: [{ namespace: "alice", name: "a", is_private: true }],
            next: "https://hub.docker.com/v2/namespaces/alice/repositories?page=2&page_size=100",
          };
    });
    const repos = await c.listResources("dockerhub-repository", ACCOUNT);
    expect(repos.map((r) => r.externalId)).toEqual(["alice/a", "alice/b"]);
    expect(repos[0]!.fields["isPrivate"]).toBe(true);
  });

  it("edits descriptions, visibility and immutable tags through their own routes", async () => {
    const { c, calls } = client((call) =>
      call.method === "GET"
        ? {
            namespace: "acme",
            name: "api",
            description: "old",
            full_description: "# readme",
            immutable_tags_settings: { enabled: false, rules: [] },
          }
        : {},
    );
    await c.updateResource(
      "dockerhub-repository",
      `${ACCOUNT}:dockerhub-repository:acme/api`,
      ACCOUNT,
      {
        description: "new",
        isPrivate: "false",
        immutableTags: "true",
        immutableTagsRules: "^v\\d+$",
      },
    );
    const writes = calls.filter((x) => x.method !== "GET" && x.url.pathname !== "/v2/auth/token");
    expect(writes.map((w) => `${w.method} ${w.url.pathname}`)).toEqual([
      "PATCH /v2/repositories/acme/api/",
      "POST /v2/repositories/acme/api/privacy",
      "PATCH /v2/namespaces/acme/repositories/api/immutabletags",
    ]);
    expect(writes[0]!.body).toEqual({ description: "new", full_description: "# readme" });
    expect(writes[1]!.body).toEqual({ is_private: false });
    expect(writes[2]!.body).toEqual({ immutable_tags: true, immutable_tags_rules: ["^v\\d+$"] });
  });

  it("deletes a tag with the trailing-slash route", async () => {
    const { c, calls } = client(() => ({}));
    await c.deleteResource("dockerhub-tag", `${ACCOUNT}:dockerhub-tag:acme/api:1.0`, ACCOUNT);
    expect(calls.at(-1)!.method).toBe("DELETE");
    expect(calls.at(-1)!.url.pathname).toBe("/v2/repositories/acme/api/tags/1.0/");
  });

  it("pages the tags tab", async () => {
    const { c } = client(() => ({
      results: [
        {
          name: "latest",
          full_size: 10,
          digest: "sha256:abc",
          tag_last_pushed: "2026-01-01T00:00:00Z",
        },
      ],
      next: "x",
    }));
    const res = await c.listArtifacts(
      "dockerhub-repository",
      `${ACCOUNT}:dockerhub-repository:acme/api`,
      ACCOUNT,
    );
    expect(res.items[0]).toMatchObject({
      name: "acme/api",
      version: "latest",
      digest: "sha256:abc",
      sizeBytes: 10,
    });
    expect(res.nextPageToken).toBe("2");
  });

  it("grants a team, falling back to an update when it already has access", async () => {
    const { c, calls } = client((call) =>
      call.method === "POST" ? { status: 400, body: { message: "exists" } } : {},
    );
    await c.executeNoSqlCommand(
      "dockerhub-repository",
      `${ACCOUNT}:dockerhub-repository:acme/api`,
      ACCOUNT,
      "grant-team-access",
      [JSON.stringify({ teamId: "7", permission: "write" })],
    );
    const patch = calls.at(-1)!;
    expect(`${patch.method} ${patch.url.pathname}`).toBe(
      "PATCH /v2/repositories/acme/api/groups/7/",
    );
    expect(patch.body).toEqual({ permission: "write" });
  });
});

describe("organizations and tokens", () => {
  it("diffs team members", async () => {
    const { c, calls } = client((call) => {
      if (call.url.pathname.endsWith("/members") && call.method === "GET") {
        return { results: [{ username: "bob" }, { username: "carol" }], next: null };
      }
      if (call.method === "GET") return { name: "devs", member_count: 2 };
      return {};
    });
    await c.updateResource("dockerhub-team", `${ACCOUNT}:dockerhub-team:acme/devs`, ACCOUNT, {
      members: "bob, dave",
    });
    const writes = calls.filter((x) => x.method === "POST" || x.method === "DELETE");
    expect(writes.map((w) => `${w.method} ${w.url.pathname}`)).toEqual([
      "POST /v2/auth/token",
      "POST /v2/orgs/acme/groups/devs/members",
      "DELETE /v2/orgs/acme/groups/devs/members/carol",
    ]);
  });

  it("creates a personal token and keeps the value", async () => {
    const { c, calls } = client(() => ({
      uuid: "u1",
      token_label: "ci",
      scopes: ["repo:read"],
      token: "dckr_pat_new",
    }));
    const r = await c.createResource("dockerhub-access-token", ACCOUNT, {
      label: "ci",
      scope: "repo:read",
      expiresInDays: "",
    });
    expect(calls.at(-1)!.body).toEqual({ token_label: "ci", scopes: ["repo:read"] });
    expect(r.secretStates[0]?.resolution).toEqual({ kind: "plaintext", value: "dckr_pat_new" });
  });

  it("builds organization token resources from the pickers", async () => {
    const { c, calls } = client(() => ({ id: "t1", label: "bot", token: "dckr_oat_new" }));
    const r = await c.createResource("dockerhub-org-access-token", ACCOUNT, {
      namespace: "acme",
      label: "bot",
      repositories: '["acme/api"]',
      repoScopes: '["scope-image-pull","scope-image-push"]',
      orgScopes: '["scope-repository-list"]',
    });
    expect(calls.at(-1)!.body).toMatchObject({
      label: "bot",
      resources: [
        { type: "TYPE_REPO", path: "acme/api", scopes: ["scope-image-pull", "scope-image-push"] },
        { type: "TYPE_ORG", path: "acme", scopes: ["scope-repository-list"] },
      ],
      expires_at: null,
    });
    expect(r.externalId).toBe("acme/t1");
  });

  it("reads the pull rate limit from registry headers", async () => {
    const { c, calls } = client((call) => {
      if (call.url.host === "auth.docker.io") return { token: "reg" };
      return {
        headers: { "ratelimit-limit": "200;w=21600", "ratelimit-remaining": "150;w=21600" },
        text: "",
      };
    });
    const quotas = await c.fetchQuotas(ACCOUNT);
    expect(quotas).toEqual([
      expect.objectContaining({
        id: "pull-rate-limit",
        limit: 200,
        used: 50,
        name: "Image pulls per 6 hours",
      }),
    ]);
    expect(calls[0]!.headers["Authorization"]).toBe(`Basic ${btoa("alice:dckr_pat_x")}`);
    expect(calls[1]!.method).toBe("HEAD");
  });

  it("returns no quota when the plan is unlimited", async () => {
    const { c } = client((call) =>
      call.url.host === "auth.docker.io" ? { token: "reg" } : { text: "" },
    );
    expect(await c.fetchQuotas(ACCOUNT)).toEqual([]);
  });
});

describe("status feed and terraform", () => {
  it("keeps only incidents about Hub and the registry", () => {
    expect(isRelevant("Issues viewing newly pushed images and tags")).toBe(true);
    expect(isRelevant("Docker Desktop crashes on startup")).toBe(false);
    const feed = JSON.stringify({
      incidents: [
        {
          id: "1",
          name: "Degraded image pulls",
          status: "investigating",
          impact: "major",
          created_at: "2026-10-01T00:00:00Z",
          incident_updates: [],
        },
        {
          id: "2",
          name: "Build Cloud builders slow",
          status: "investigating",
          impact: "minor",
          created_at: "2026-10-01T00:00:00Z",
          incident_updates: [],
        },
      ],
    });
    expect(parseStatusFeed(feed).map((i) => i.externalId)).toEqual(["1"]);
  });

  it("maps repositories to docker_hub_repository", () => {
    const out = dockerHubTerraformExport.mapResource(
      mapRepository(ACCOUNT, {
        namespace: "acme",
        name: "api",
        is_private: true,
        description: "API",
      }),
    );
    expect(out?.resource).toMatchObject({ type: "docker_hub_repository", importId: "acme/api" });
    expect(out?.resource.attributes["private"]).toEqual({ kind: "bool", value: true });
  });
});
