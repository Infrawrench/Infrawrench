import { buildOAuthAuthorizeUrl } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { listOwnerOptions } from "../owners.js";
import { plugin } from "../plugin.js";
import { makeHttp } from "./helpers.js";

const tokens = { accessToken: "ghu_abc", raw: {} };

function fakeFetch(routes: Record<string, unknown>, status: Record<string, number> = {}) {
  const seen: Array<{ url: string; auth: string | undefined }> = [];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url: url.toString(), auth: headers["Authorization"] });
    const body = routes[url.pathname];
    const code = status[url.pathname] ?? (body === undefined ? 404 : 200);
    return new Response(JSON.stringify(body ?? {}), { status: code });
  }) as typeof fetch;
  return { doFetch, seen };
}

describe("GitHub OAuth declaration", () => {
  it("is a server-only GitHub App flow with refresh", () => {
    const decl = plugin.manifest.oauth!;
    expect(decl.tokenField).toBe("token");
    expect(decl.clients.server).toBeDefined();
    expect(decl.clients.desktop).toBeUndefined();
    expect(decl.refresh).toBe("rotating");
    const url = new URL(
      buildOAuthAuthorizeUrl(decl, {
        clientId: "Iv1.x",
        redirectUri: "https://app.example/cb",
        state: "s",
        codeChallenge: "c",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("scope")).toBe("offline_access");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("completeOAuthConnection", () => {
  it("pre-fills the only installed organization and github.com", async () => {
    const { doFetch, seen } = fakeFetch({
      "/user": { login: "octocat", name: "Octo Cat" },
      "/user/installations": {
        total_count: 2,
        installations: [
          { target_type: "Organization", account: { login: "octo-org" } },
          { target_type: "User", account: { login: "octocat" } },
        ],
      },
    });
    const result = await plugin.completeOAuthConnection!(tokens, {
      client: "server",
      fetch: doFetch,
    });
    expect(result.credentials).toEqual({ host: "github.com", owner: "org:octo-org" });
    expect(result.accountName).toBe("GitHub octo-org");
    expect(seen.every((s) => s.auth === "Bearer ghu_abc")).toBe(true);
  });

  it("leaves the owner to the picker when several are installed", async () => {
    const { doFetch } = fakeFetch({
      "/user": { login: "octocat" },
      "/user/installations": {
        installations: [
          { target_type: "Organization", account: { login: "a" } },
          { target_type: "Enterprise", account: { slug: "ent", name: "Ent Inc" } },
        ],
      },
    });
    const result = await plugin.completeOAuthConnection!(tokens, {
      client: "server",
      fetch: doFetch,
    });
    expect(result.credentials).toEqual({ host: "github.com" });
    expect(result.accountName).toBe("GitHub (octocat)");
  });

  it("still succeeds when the identity calls fail", async () => {
    const { doFetch } = fakeFetch({}, { "/user": 500, "/user/installations": 403 });
    const result = await plugin.completeOAuthConnection!(tokens, {
      client: "server",
      fetch: doFetch,
    });
    expect(result.credentials).toEqual({ host: "github.com" });
    expect(result.accountName).toBeUndefined();
  });
});

describe("OAuth-connected accounts", () => {
  const oauthCreds = { token: "ghu_abc", host: "github.com", __oauth: "sealed" };

  it("lists installations in the owner picker", async () => {
    const { http, calls } = makeHttp((url) =>
      url.pathname === "/user/installations"
        ? {
            body: {
              installations: [
                { target_type: "Organization", account: { login: "zeta" } },
                { target_type: "Enterprise", account: { slug: "ent", name: "Ent" } },
              ],
            },
          }
        : { status: 404, body: {} },
    );
    const options = await listOwnerOptions(oauthCreds, { http } as never);
    expect(options.map((o) => o.id)).toEqual(["enterprise:ent", "org:zeta"]);
    expect(calls).toHaveLength(1);
  });

  it("explains a missing app installation", async () => {
    const { http } = makeHttp(() => ({ body: { installations: [] } }));
    await expect(listOwnerOptions(oauthCreds, { http } as never)).rejects.toThrow(/not installed/);
  });

  it("rejects a GHE.com host for an OAuth token", () => {
    expect(plugin.validateServerCredentials!({ ...oauthCreds, host: "octocorp.ghe.com" })).toMatch(
      /github.com only/,
    );
    expect(plugin.validateServerCredentials!(oauthCreds)).toBeNull();
    expect(
      plugin.validateServerCredentials!({ token: "ghp_x", host: "octocorp.ghe.com" }),
    ).toBeNull();
  });
});
