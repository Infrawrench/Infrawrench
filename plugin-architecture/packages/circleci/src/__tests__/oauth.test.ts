import { buildOAuthAuthorizeUrl, desktopOAuthRedirectUri } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { plugin } from "../plugin.js";

function fakeFetch(handler: (url: string) => { status: number; body: unknown } | Error) {
  const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, init });
    const reply = handler(url);
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  return { doFetch, seen };
}

describe("CircleCI OAuth declaration", () => {
  it("is desktop-only, dynamically registered and never refreshed", () => {
    const decl = plugin.manifest.oauth!;
    expect(decl.clientRegistration).toBe("dynamic");
    expect(decl.clients.server).toBeUndefined();
    expect(decl.refresh).toBe("none");
    expect(decl.tokenField).toBe("apiToken");
    expect(desktopOAuthRedirectUri(decl)).toBe("http://127.0.0.1:43118/oauth/callback");
    const url = new URL(
      buildOAuthAuthorizeUrl(decl, {
        clientId: "cid",
        redirectUri: desktopOAuthRedirectUri(decl),
        state: "s",
        codeChallenge: "c",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://app.circleci.com/oauth/authorize");
    expect(url.searchParams.get("scope")).toBeNull();
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("registerOAuthClient", () => {
  it("registers a public client for the loopback redirect", async () => {
    const { doFetch, seen } = fakeFetch(() => ({
      status: 201,
      body: { client_id: "dyn-1", token_endpoint_auth_method: "none" },
    }));
    const client = await plugin.registerOAuthClient!({
      redirectUri: "http://127.0.0.1:43118/oauth/callback",
      fetch: doFetch,
    });
    expect(client).toEqual({ clientId: "dyn-1" });
    expect(seen[0]!.url).toBe("https://app.circleci.com/oauth/register");
    expect(JSON.parse(String(seen[0]!.init?.body))).toEqual({
      client_name: "Infrawrench",
      redirect_uris: ["http://127.0.0.1:43118/oauth/callback"],
      grant_types: ["authorization_code"],
      response_types: ["code"],
    });
  });

  it("explains a refused registration", async () => {
    const { doFetch } = fakeFetch(() => ({
      status: 400,
      body: { error: "invalid_redirect_uri", error_description: "must be loopback" },
    }));
    await expect(
      plugin.registerOAuthClient!({ redirectUri: "https://x", fetch: doFetch }),
    ).rejects.toThrow(/HTTP 400.*must be loopback/);
  });
});

describe("completeOAuthConnection", () => {
  const tokens = { accessToken: "ccipat_tok", expiresAt: 1, raw: {} };

  it("picks the only organization and names the account after the user", async () => {
    const { doFetch, seen } = fakeFetch((url) =>
      url.endsWith("/me")
        ? { status: 200, body: { login: "ada", name: "Ada" } }
        : { status: 200, body: [{ id: "org-1", name: "Acme", slug: "gh/acme" }] },
    );
    const result = await plugin.completeOAuthConnection!(tokens, {
      client: "desktop",
      fetch: doFetch,
    });
    expect(result).toEqual({
      credentials: { organization: "org-1" },
      accountName: "CircleCI (ada)",
    });
    expect((seen[0]!.init?.headers as Record<string, string>)["Circle-Token"]).toBe("ccipat_tok");
  });

  it("leaves the organization to the picker when there are several", async () => {
    const { doFetch } = fakeFetch((url) =>
      url.endsWith("/me")
        ? new Error("offline")
        : {
            status: 200,
            body: [
              { id: "a", name: "A", slug: "gh/a" },
              { id: "b", name: "B", slug: "gh/b" },
            ],
          },
    );
    expect(
      await plugin.completeOAuthConnection!(tokens, { client: "desktop", fetch: doFetch }),
    ).toEqual({});
  });
});
