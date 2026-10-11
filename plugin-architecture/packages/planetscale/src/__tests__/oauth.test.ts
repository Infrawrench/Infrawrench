import { buildOAuthAuthorizeUrl } from "@infrawrench/plugin-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlanetScaleClient } from "../client.js";
import { planetscaleAuthorization } from "../oauth.js";
import { plugin } from "../plugin.js";

const tokens = { accessToken: "pscale_oauth_abc", raw: {} };

function fakeFetch(reply: { status: number; body: unknown } | Error) {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  return { doFetch, seen };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PlanetScale OAuth declaration", () => {
  it("is a server-only client writing the service token secret field", () => {
    const decl = plugin.manifest.oauth!;
    expect(decl.tokenField).toBe("serviceTokenSecret");
    expect(decl.clients.server).toBeDefined();
    expect(decl.clients.desktop).toBeUndefined();
    expect(decl.tokenUrl).toBe("https://auth.planetscale.com/oauth/token");
    const url = new URL(
      buildOAuthAuthorizeUrl(decl, {
        clientId: "cid",
        redirectUri: "https://app.example/cb",
        state: "s",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://auth.planetscale.com/oauth/authorize");
    expect(url.searchParams.has("scope")).toBe(false);
  });

  it("lets the service token ID stay empty", () => {
    const field = plugin.manifest.credentialFields.find((f) => f.key === "serviceTokenId");
    expect(field?.optional).toBe(true);
  });
});

describe("planetscaleAuthorization", () => {
  it("sends a service token as id:secret", () => {
    expect(planetscaleAuthorization({ serviceTokenId: "i", serviceTokenSecret: "s" })).toBe("i:s");
  });

  it("sends an OAuth token as Bearer, with or without grant state", () => {
    expect(
      planetscaleAuthorization({
        serviceTokenSecret: "tok",
        __oauth: JSON.stringify({ v: 1, client: "server", connectedAt: 1 }),
      }),
    ).toBe("Bearer tok");
    expect(planetscaleAuthorization({ serviceTokenSecret: "pscale_oauth_x" })).toBe(
      "Bearer pscale_oauth_x",
    );
  });

  it("still asks for the ID of a service token", () => {
    expect(() => planetscaleAuthorization({ serviceTokenSecret: "pscale_tkn_x" })).toThrow(
      /missing serviceTokenId/,
    );
  });
});

describe("client with an OAuth token", () => {
  it("calls the API with a Bearer header", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new PlanetScaleClient({
      serviceTokenSecret: "pscale_oauth_x",
      organizationName: "acme",
    });
    await client.listResources("ps-database", "acct");
    const init = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    const headers = new Headers(init[1]?.headers);
    expect(headers.get("Authorization")).toBe("Bearer pscale_oauth_x");
  });
});

describe("completeOAuthConnection", () => {
  it("pre-fills the organization and names the account", async () => {
    const { doFetch, seen } = fakeFetch({ status: 200, body: { data: [{ name: "acme" }] } });
    const result = await plugin.completeOAuthConnection!(tokens, {
      client: "server",
      fetch: doFetch,
    });
    expect(result).toEqual({
      credentials: { organizationName: "acme" },
      accountName: "PlanetScale (acme)",
    });
    expect(seen[0]!.url).toBe("https://api.planetscale.com/v1/organizations");
    expect(seen[0]!.headers["Authorization"]).toBe("Bearer pscale_oauth_abc");
  });

  it("returns nothing when the lookup fails", async () => {
    for (const reply of [{ status: 403, body: {} }, new Error("offline")]) {
      const { doFetch } = fakeFetch(reply);
      expect(
        await plugin.completeOAuthConnection!(tokens, { client: "server", fetch: doFetch }),
      ).toEqual({});
    }
  });
});
