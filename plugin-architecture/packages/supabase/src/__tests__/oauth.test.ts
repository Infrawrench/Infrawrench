import { buildOAuthAuthorizeUrl } from "@infrawrench/plugin-base";
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

describe("Supabase OAuth declaration", () => {
  it("is a server-only confidential client with app-configured scopes", () => {
    const decl = plugin.manifest.oauth!;
    expect(decl.tokenField).toBe("accessToken");
    expect(decl.clients.server).toEqual({ auth: "client_secret_basic", pkce: true });
    expect(decl.clients.desktop).toBeUndefined();
    expect(decl.access).toBe("read-write");
    const url = new URL(
      buildOAuthAuthorizeUrl(decl, {
        clientId: "cid",
        redirectUri: "https://app.example/cb",
        state: "s",
        codeChallenge: "c",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://api.supabase.com/v1/oauth/authorize");
    expect(url.searchParams.has("scope")).toBe(false);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(decl.tokenUrl).toBe("https://api.supabase.com/v1/oauth/token");
  });
});

describe("completeOAuthConnection", () => {
  it("names the account after the connected organization", async () => {
    const { doFetch, seen } = fakeFetch({
      status: 200,
      body: [{ id: "abc", slug: "abc", name: "Acme" }],
    });
    const result = await plugin.completeOAuthConnection!(tokens, {
      client: "server",
      fetch: doFetch,
    });
    expect(result).toEqual({ accountName: "Supabase (Acme)" });
    expect(seen[0]!.url).toBe("https://api.supabase.com/v1/organizations");
    expect(seen[0]!.headers["Authorization"]).toBe("Bearer oauth-tok");
  });

  it("suggests no name for several organizations or a failed lookup", async () => {
    for (const reply of [
      { status: 200, body: [{ name: "A" }, { name: "B" }] },
      { status: 403, body: {} },
      new Error("offline"),
    ]) {
      const { doFetch } = fakeFetch(reply);
      const result = await plugin.completeOAuthConnection!(tokens, {
        client: "server",
        fetch: doFetch,
      });
      expect(result).toEqual({});
    }
  });
});
