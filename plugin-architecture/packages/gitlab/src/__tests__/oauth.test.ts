import { buildOAuthAuthorizeUrl, desktopOAuthRedirectUri } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { plugin } from "../plugin.js";

const tokens = { accessToken: "oauth-tok", raw: {} };

function fakeFetch(reply: { status: number; body: unknown } | Error) {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  return { doFetch, seen };
}

describe("GitLab OAuth declaration", () => {
  it("offers a confidential server client and a public desktop client", () => {
    const decl = plugin.manifest.oauth!;
    expect(decl.tokenField).toBe("token");
    expect(decl.clients.server?.pkce).toBe(true);
    expect(decl.clients.desktop).toBeDefined();
    expect(desktopOAuthRedirectUri(decl)).toBe("http://127.0.0.1:43118/oauth/callback");
    expect(decl.refresh).toBe("rotating");
    const url = new URL(
      buildOAuthAuthorizeUrl(decl, {
        clientId: "cid",
        redirectUri: "https://app.example/cb",
        state: "s",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://gitlab.com/oauth/authorize");
    expect(url.searchParams.get("scope")).toBe("api create_runner");
  });
});

describe("completeOAuthConnection", () => {
  it("pre-fills GitLab.com and names the account after the user", async () => {
    const { doFetch, seen } = fakeFetch({ status: 200, body: { username: "ada" } });
    const result = await plugin.completeOAuthConnection!(tokens, {
      client: "desktop",
      fetch: doFetch,
    });
    expect(result).toEqual({
      credentials: { url: "https://gitlab.com" },
      accountName: "GitLab (ada)",
    });
    expect(seen[0]!.url).toBe("https://gitlab.com/api/v4/user");
    expect(seen[0]!.headers["Authorization"]).toBe("Bearer oauth-tok");
  });

  it("still pre-fills the URL when the user lookup fails", async () => {
    for (const reply of [{ status: 403, body: {} }, new Error("offline")]) {
      const { doFetch } = fakeFetch(reply);
      const result = await plugin.completeOAuthConnection!(tokens, {
        client: "server",
        fetch: doFetch,
      });
      expect(result).toEqual({ credentials: { url: "https://gitlab.com" } });
    }
  });
});

describe("validateServerCredentials", () => {
  it("keeps an OAuth token on GitLab.com", () => {
    const oauth = { token: "t", __oauth: "sealed" };
    expect(plugin.validateServerCredentials!({ ...oauth, url: "https://gitlab.com" })).toBeNull();
    expect(
      plugin.validateServerCredentials!({ ...oauth, url: "https://gitlab.example.com" }),
    ).toMatch(/GitLab.com only/);
    expect(
      plugin.validateServerCredentials!({ token: "glpat-x", url: "https://gitlab.example.com" }),
    ).toBeNull();
  });
});
