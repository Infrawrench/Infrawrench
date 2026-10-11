import { buildOAuthAuthorizeUrl, desktopOAuthRedirectUri } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { plugin } from "../plugin.js";

const tokens = { accessToken: "hf_oauth_tok", raw: {} };

function fakeFetch(reply: { status: number; body: unknown } | Error) {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  return { doFetch, seen };
}

describe("Hugging Face OAuth declaration", () => {
  it("offers a confidential server client and a public desktop client", () => {
    const decl = plugin.manifest.oauth!;
    expect(decl.tokenField).toBe("apiToken");
    expect(decl.clients.server?.auth).toBe("client_secret_basic");
    expect(desktopOAuthRedirectUri(decl)).toBe("http://127.0.0.1:43118/oauth/callback");
    const url = new URL(
      buildOAuthAuthorizeUrl(decl, {
        clientId: "cid",
        redirectUri: "https://app.example/cb",
        state: "s",
        codeChallenge: "c",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://huggingface.co/oauth/authorize");
    expect(url.searchParams.get("scope")).toBe(
      "openid profile read-memberships manage-repos write-endpoints jobs webhooks inference-api read-billing",
    );
  });
});

describe("completeOAuthConnection", () => {
  it("names the account after the user", async () => {
    const { doFetch, seen } = fakeFetch({ status: 200, body: { name: "ada", orgs: [] } });
    const result = await plugin.completeOAuthConnection!(tokens, {
      client: "server",
      fetch: doFetch,
    });
    expect(result).toEqual({ accountName: "Hugging Face (ada)" });
    expect(seen[0]!.url).toBe("https://huggingface.co/api/whoami-v2");
    expect(seen[0]!.headers["Authorization"]).toBe("Bearer hf_oauth_tok");
  });

  it("returns nothing when the lookup fails", async () => {
    for (const reply of [{ status: 401, body: {} }, new Error("offline")]) {
      const { doFetch } = fakeFetch(reply);
      expect(
        await plugin.completeOAuthConnection!(tokens, { client: "desktop", fetch: doFetch }),
      ).toEqual({});
    }
  });
});
