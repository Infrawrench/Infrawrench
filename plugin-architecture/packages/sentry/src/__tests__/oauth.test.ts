import { buildOAuthAuthorizeUrl, desktopOAuthRedirectUri } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { regionIdFor } from "../oauth.js";
import { plugin } from "../plugin.js";

function fakeFetch(reply: { status: number; body: unknown } | Error) {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  return { doFetch, seen };
}

describe("Sentry OAuth declaration", () => {
  it("offers server and public desktop clients with the plugin's scopes", () => {
    const decl = plugin.manifest.oauth!;
    expect(decl.tokenField).toBe("authToken");
    expect(decl.clients.server?.pkce).toBe(true);
    expect(desktopOAuthRedirectUri(decl)).toBe("http://127.0.0.1:43118/oauth/callback");
    const url = new URL(
      buildOAuthAuthorizeUrl(decl, {
        clientId: "cid",
        redirectUri: "https://app.example/cb",
        state: "s",
        codeChallenge: "c",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://sentry.io/oauth/authorize/");
    expect(url.searchParams.get("scope")?.split(" ")).toContain("org:read");
    expect(url.searchParams.get("scope")?.split(" ")).toContain("alerts:write");
  });
});

describe("completeOAuthConnection", () => {
  it("fills the organization the token is scoped to and its region", async () => {
    const { doFetch, seen } = fakeFetch({
      status: 200,
      body: [
        {
          id: "42",
          slug: "acme",
          name: "Acme",
          links: { organizationUrl: "https://acme.sentry.io", regionUrl: "https://de.sentry.io" },
        },
      ],
    });
    const result = await plugin.completeOAuthConnection!(
      { accessToken: "sentry-oauth", raw: { organization_id: "42" } },
      { client: "server", fetch: doFetch },
    );
    expect(result).toEqual({
      credentials: { region: "de", baseUrl: "", organization: "acme" },
      accountName: "Sentry Acme",
    });
    expect(seen[0]!.url).toBe("https://sentry.io/api/0/organizations/");
    expect(seen[0]!.headers["Authorization"]).toBe("Bearer sentry-oauth");
  });

  it("picks the scoped organization out of several", async () => {
    const { doFetch } = fakeFetch({
      status: 200,
      body: [
        { id: "1", slug: "a", links: { regionUrl: "https://us.sentry.io" } },
        { id: "2", slug: "b", name: "Bee", links: { regionUrl: "https://us.sentry.io" } },
      ],
    });
    const result = await plugin.completeOAuthConnection!(
      { accessToken: "t", raw: { organization_id: "2" } },
      { client: "desktop", fetch: doFetch },
    );
    expect(result.credentials?.["organization"]).toBe("b");
    expect(result.credentials?.["region"]).toBe("us");
  });

  it("leaves the organization to the picker when it cannot tell", async () => {
    for (const reply of [
      { status: 200, body: [{ slug: "a" }, { slug: "b" }] },
      { status: 401, body: {} },
      new Error("offline"),
    ]) {
      const { doFetch } = fakeFetch(reply);
      const result = await plugin.completeOAuthConnection!(
        { accessToken: "t", raw: {} },
        { client: "server", fetch: doFetch },
      );
      expect(result).toEqual({ credentials: { baseUrl: "" } });
    }
  });
});

describe("regionIdFor", () => {
  it("maps region URLs to picker ids", () => {
    expect(regionIdFor("https://de.sentry.io")).toBe("de");
    expect(regionIdFor("https://us.sentry.io")).toBe("us");
    expect(regionIdFor(undefined)).toBe("us");
    expect(regionIdFor("not a url")).toBe("us");
  });
});

describe("validateServerCredentials", () => {
  it("rejects an OAuth token on a self-hosted instance only", () => {
    const oauth = { authToken: "t", __oauth: "sealed" };
    expect(plugin.validateServerCredentials!({ ...oauth, region: "de" })).toBeNull();
    expect(
      plugin.validateServerCredentials!({
        ...oauth,
        region: "self-hosted",
        baseUrl: "https://sentry.example.com",
      }),
    ).toMatch(/sentry.io only/);
    expect(
      plugin.validateServerCredentials!({
        authToken: "sntryu_x",
        region: "self-hosted",
        baseUrl: "https://sentry.example.com",
      }),
    ).toBeNull();
  });
});
