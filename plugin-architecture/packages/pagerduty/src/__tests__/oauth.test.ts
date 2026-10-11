import type { HttpHostServices } from "@infrawrench/plugin-base";
import { buildOAuthAuthorizeUrl, desktopOAuthRedirectUri } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { PagerDutyClient } from "../client.js";
import { isPagerDutyOAuth } from "../oauth.js";
import { plugin } from "../plugin.js";

function jwt(claims: Record<string, unknown>): string {
  const b64 = (v: unknown) =>
    btoa(JSON.stringify(v)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "RS256" })}.${b64(claims)}.sig`;
}

function fakeFetch(handler: (url: string) => { status: number; body: unknown } | Error) {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const reply = handler(url);
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  return { doFetch, seen };
}

describe("PagerDuty OAuth declaration", () => {
  it("asks the identity service for the classic write scope", () => {
    const decl = plugin.manifest.oauth!;
    expect(decl.tokenField).toBe("apiKey");
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
    expect(url.origin + url.pathname).toBe("https://identity.pagerduty.com/oauth/authorize");
    expect(url.searchParams.get("scope")).toBe("write");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("completeOAuthConnection", () => {
  it("reads the region and subdomain from the id_token and acts as the user", async () => {
    const { doFetch, seen } = fakeFetch(() => ({
      status: 200,
      body: { user: { email: "ada@example.com", name: "Ada" } },
    }));
    const result = await plugin.completeOAuthConnection!(
      {
        accessToken: "pdus+_tok",
        raw: {
          id_token: jwt({ aud: ["cid", "https://api.eu.pagerduty.com"], subdomain: "acme" }),
        },
      },
      { client: "server", fetch: doFetch },
    );
    expect(result).toEqual({
      credentials: { region: "eu", fromEmail: "ada@example.com" },
      accountName: "PagerDuty (acme)",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.eu.pagerduty.com/users/me");
    expect(seen[0]!.headers["Authorization"]).toBe("Bearer pdus+_tok");
  });

  it("probes the regions when there is no id_token", async () => {
    const { doFetch, seen } = fakeFetch((url) =>
      url.startsWith("https://api.pagerduty.com")
        ? { status: 401, body: {} }
        : { status: 200, body: { user: { email: "eu@example.com" } } },
    );
    const result = await plugin.completeOAuthConnection!(
      { accessToken: "pdus+_tok", raw: {} },
      { client: "desktop", fetch: doFetch },
    );
    expect(seen.map((s) => s.url)).toEqual([
      "https://api.pagerduty.com/users/me",
      "https://api.eu.pagerduty.com/users/me",
    ]);
    expect(result).toEqual({
      credentials: { region: "eu", fromEmail: "eu@example.com" },
      accountName: "PagerDuty (eu@example.com)",
    });
  });

  it("still pre-fills a region when the lookups fail", async () => {
    const { doFetch } = fakeFetch(() => new Error("offline"));
    const result = await plugin.completeOAuthConnection!(
      { accessToken: "pdus+_tok", raw: {} },
      { client: "desktop", fetch: doFetch },
    );
    expect(result).toEqual({ credentials: { region: "us" } });
  });
});

describe("OAuth transport", () => {
  it("sends OAuth tokens as Bearer and API keys as Token token=", async () => {
    const headers: string[] = [];
    const http: HttpHostServices = {
      async request(req) {
        headers.push(req.headers["Authorization"] ?? "");
        return { status: 200, headers: {}, body: JSON.stringify({ teams: [], more: false }) };
      },
    };
    for (const creds of [
      { apiKey: "pdus+_abc" },
      { apiKey: "tok", __oauth: "{}" },
      { apiKey: "u+AbCdEf" },
    ]) {
      await new PagerDutyClient(creds, { http }).listResources("pagerduty-team", "acc");
    }
    expect(headers).toEqual(["Bearer pdus+_abc", "Bearer tok", "Token token=u+AbCdEf"]);
    expect(isPagerDutyOAuth({ apiKey: "u+AbCdEf" })).toBe(false);
  });
});
