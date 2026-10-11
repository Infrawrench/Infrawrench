import { describe, expect, it, vi } from "vitest";
import { buildOAuthAuthorizeUrl, desktopOAuthRedirectUri } from "@infrawrench/plugin-base";
import { plugin } from "../plugin.js";
import { ResendClient } from "../client.js";
import { completeResendOAuth } from "../oauth.js";
import { makeHttp } from "./helpers.js";

describe("Resend OAuth declaration", () => {
  const decl = plugin.manifest.oauth!;

  it("fills the existing API key field with full access and rotating refresh", () => {
    expect(decl.tokenField).toBe("apiKey");
    expect(plugin.manifest.credentialFields.map((f) => f.key)).toContain("apiKey");
    expect(decl.scopes).toEqual(["full_access"]);
    expect(decl.access).toBe("full");
    expect(decl.refresh).toBe("rotating");
    expect(plugin.completeOAuthConnection).toBe(completeResendOAuth);
  });

  it("uses PKCE on the server and a 127.0.0.1 loopback on the desktop", () => {
    expect(decl.clients.server?.pkce).toBe(true);
    expect(desktopOAuthRedirectUri(decl)).toBe("http://127.0.0.1:43118/oauth/callback");
    const url = new URL(
      buildOAuthAuthorizeUrl(decl, {
        clientId: "cid",
        redirectUri: "http://127.0.0.1:43118/oauth/callback",
        state: "st",
        codeChallenge: "ch",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://api.resend.com/oauth/authorize");
    expect(url.searchParams.get("scope")).toBe("full_access");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("ResendClient with an OAuth connection", () => {
  it("asks the host for a current token on every request", async () => {
    const { http, calls } = makeHttp(() => ({ data: [], has_more: false }));
    let n = 0;
    const getAccessToken = vi.fn(async () => `oauth-${++n}`);
    const c = new ResendClient({ apiKey: "stale-token", __oauth: "{}" }, {
      http,
      oauth: { getAccessToken },
    } as never);
    await c.listResources("resend-api-key", "acc").catch(() => undefined);
    await c.listResources("resend-webhook", "acc").catch(() => undefined);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(getAccessToken).toHaveBeenCalledTimes(calls.length);
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer oauth-1");
    expect(calls.at(-1)!.headers["Authorization"]).toBe(`Bearer oauth-${calls.length}`);
    expect(calls.some((call) => call.headers["Authorization"] === "Bearer stale-token")).toBe(
      false,
    );
  });

  it("keeps using the pasted key when there is no OAuth service", async () => {
    const { http, calls } = makeHttp(() => ({ data: [], has_more: false }));
    const c = new ResendClient({ apiKey: "re_KEY" }, { http } as never);
    await c.listResources("resend-api-key", "acc").catch(() => undefined);
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer re_KEY");
  });
});

describe("completeResendOAuth", () => {
  const tokens = { accessToken: "jwt", raw: {} };

  it("names the account after the first verified domain", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { name: "pending.example.com", status: "pending" },
              { name: "mail.example.com", status: "verified" },
            ],
          }),
          { status: 200 },
        ),
    );
    const res = await completeResendOAuth(tokens, {
      client: "desktop",
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toEqual({ accountName: "Resend (mail.example.com)" });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer jwt");
  });

  it("returns nothing for a team without domains or a failed call", async () => {
    const empty = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    expect(
      await completeResendOAuth(tokens, {
        client: "server",
        fetch: empty as unknown as typeof fetch,
      }),
    ).toEqual({});
    const denied = vi.fn(async () => new Response("{}", { status: 401 }));
    expect(
      await completeResendOAuth(tokens, {
        client: "server",
        fetch: denied as unknown as typeof fetch,
      }),
    ).toEqual({});
  });
});
