import { buildOAuthAuthorizeUrl } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { plugin } from "../plugin.js";

const tokens = { accessToken: "HRKU-tok", raw: {} };

function fakeFetch(reply: { status: number; body: unknown } | Error) {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  return { doFetch, seen };
}

describe("Heroku OAuth declaration", () => {
  it("is a server-only client asking for the global scope", () => {
    const decl = plugin.manifest.oauth!;
    expect(decl.tokenField).toBe("apiKey");
    expect(decl.clients.server).toBeDefined();
    expect(decl.clients.desktop).toBeUndefined();
    expect(decl.access).toBe("full");
    expect(decl.refresh).toBe("reusable");
    expect(decl.tokenUrl).toBe("https://id.heroku.com/oauth/token");
    const url = new URL(
      buildOAuthAuthorizeUrl(decl, {
        clientId: "cid",
        redirectUri: "https://app.example/cb",
        state: "s",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://id.heroku.com/oauth/authorize");
    expect(url.searchParams.get("scope")).toBe("global");
    expect(url.searchParams.get("response_type")).toBe("code");
  });
});

describe("completeOAuthConnection", () => {
  it("names the account after the user's email", async () => {
    const { doFetch, seen } = fakeFetch({ status: 200, body: { email: "ada@example.com" } });
    const result = await plugin.completeOAuthConnection!(tokens, {
      client: "server",
      fetch: doFetch,
    });
    expect(result).toEqual({ accountName: "Heroku (ada@example.com)" });
    expect(seen[0]!.url).toBe("https://api.heroku.com/account");
    expect(seen[0]!.headers["Authorization"]).toBe("Bearer HRKU-tok");
    expect(seen[0]!.headers["Accept"]).toBe("application/vnd.heroku+json; version=3");
  });

  it("returns nothing when the lookup fails", async () => {
    for (const reply of [{ status: 401, body: {} }, new Error("offline")]) {
      const { doFetch } = fakeFetch(reply);
      expect(
        await plugin.completeOAuthConnection!(tokens, { client: "server", fetch: doFetch }),
      ).toEqual({});
    }
  });
});
