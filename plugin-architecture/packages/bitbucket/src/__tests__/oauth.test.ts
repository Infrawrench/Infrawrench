import { buildOAuthAuthorizeUrl } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { BitbucketClient } from "../client.js";
import { plugin } from "../plugin.js";
import { makeHttp } from "./helpers.js";

const tokens = { accessToken: "bb-oauth", raw: {} };

function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const seen: Array<{ url: URL; auth: string | undefined }> = [];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ url, auth: ((init?.headers ?? {}) as Record<string, string>)["Authorization"] });
    const route = routes[url.pathname];
    return new Response(JSON.stringify(route?.body ?? {}), { status: route?.status ?? 404 });
  }) as typeof fetch;
  return { doFetch, seen };
}

describe("Bitbucket OAuth declaration", () => {
  it("is a server-only consumer with Basic client auth and no scopes in the URL", () => {
    const decl = plugin.manifest.oauth!;
    expect(decl.clients).toEqual({ server: { auth: "client_secret_basic" } });
    expect(decl.tokenField).toBe("token");
    expect(decl.refresh).toBe("rotating");
    const url = new URL(
      buildOAuthAuthorizeUrl(decl, { clientId: "key", redirectUri: "https://a/cb", state: "s" }),
    );
    expect(url.origin + url.pathname).toBe("https://bitbucket.org/site/oauth2/authorize");
    expect(url.searchParams.has("scope")).toBe(false);
  });
});

describe("completeOAuthConnection", () => {
  it("pre-fills the only workspace and clears the email", async () => {
    const { doFetch, seen } = fakeFetch({
      "/2.0/user": { status: 200, body: { display_name: "Ada" } },
      "/2.0/user/workspaces": {
        status: 200,
        body: { values: [{ workspace: { slug: "acme", name: "Acme" } }] },
      },
    });
    const result = await plugin.completeOAuthConnection!(tokens, {
      client: "server",
      fetch: doFetch,
    });
    expect(result).toEqual({
      credentials: { email: "", workspace: "acme" },
      accountName: "Bitbucket Acme",
    });
    expect(seen.every((s) => s.auth === "Bearer bb-oauth")).toBe(true);
  });

  it("leaves the workspace to the picker when there are several", async () => {
    const { doFetch } = fakeFetch({
      "/2.0/user": { status: 200, body: { display_name: "Ada" } },
      "/2.0/user/workspaces": {
        status: 200,
        body: { values: [{ workspace: { slug: "a" } }, { workspace: { slug: "b" } }] },
      },
    });
    const result = await plugin.completeOAuthConnection!(tokens, {
      client: "server",
      fetch: doFetch,
    });
    expect(result).toEqual({ credentials: { email: "" }, accountName: "Bitbucket (Ada)" });
  });
});

describe("OAuth-connected accounts", () => {
  it("send the token as Bearer even when an email is left in the form", async () => {
    const { http, calls } = makeHttp(() => ({ values: [] }));
    const client = new BitbucketClient(
      { token: "bb-oauth", workspace: "acme", email: "old@example.com", __oauth: "{}" },
      { http } as never,
    );
    await client.listResources("project", "acc").catch(() => undefined);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer bb-oauth");
  });

  it("list workspaces in the picker with the Bearer token", async () => {
    const { http, calls } = makeHttp(() => ({
      values: [{ administrator: true, workspace: { slug: "acme", name: "Acme" } }],
    }));
    const options = await plugin.listCredentialOptions!(
      "workspace",
      { token: "bb-oauth", email: "old@example.com", __oauth: "{}" },
      { http } as never,
    );
    expect(options).toEqual([{ id: "acme", label: "Acme", description: "acme (admin)" }]);
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer bb-oauth");
  });
});
