import { buildOAuthAuthorizeUrl, desktopOAuthRedirectUri } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { POSTHOG_OAUTH_SCOPES } from "../oauth.js";
import { plugin } from "../plugin.js";

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

describe("PostHog OAuth declaration", () => {
  it("goes through the region router with the personal API key scopes", () => {
    const decl = plugin.manifest.oauth!;
    expect(decl.tokenField).toBe("apiKey");
    expect(decl.refresh).toBe("reusable");
    expect(desktopOAuthRedirectUri(decl)).toBe("http://127.0.0.1:43118/oauth/callback");
    const url = new URL(
      buildOAuthAuthorizeUrl(decl, {
        clientId: "https://infrawrench.com/oauth/posthog-desktop.json",
        redirectUri: "http://127.0.0.1:43118/oauth/callback",
        state: "s",
        codeChallenge: "c",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://oauth.posthog.com/oauth/authorize/");
    const scopes = url.searchParams.get("scope")!.split(" ");
    expect(scopes).toContain("billing:read");
    expect(scopes).toContain("query:read");
    // Every scope the preflight probes for is requested.
    const template = plugin.policyTemplate!([]).document.split("\n");
    expect([...template].sort()).toEqual([...POSTHOG_OAUTH_SCOPES].sort());
  });
});

describe("completeOAuthConnection", () => {
  it("pre-fills region and the single granted organization", async () => {
    const { doFetch, seen } = fakeFetch(() => ({ status: 200, body: { name: "Acme" } }));
    const result = await plugin.completeOAuthConnection!(
      {
        accessToken: "pha_tok",
        raw: { posthog_region: "eu", scoped_organizations: ["org-1"], scoped_teams: [] },
      },
      { client: "server", fetch: doFetch },
    );
    expect(result).toEqual({
      credentials: { region: "eu", organizationId: "org-1" },
      accountName: "PostHog (Acme)",
    });
    expect(seen[0]!.url).toBe("https://eu.posthog.com/api/organizations/org-1/");
    expect(seen[0]!.headers["Authorization"]).toBe("Bearer pha_tok");
  });

  it("finds the organization through a project-level grant", async () => {
    const { doFetch, seen } = fakeFetch((url) =>
      url.includes("/api/projects/")
        ? { status: 200, body: { id: 7, organization: "org-7" } }
        : { status: 200, body: { name: "Seven" } },
    );
    const result = await plugin.completeOAuthConnection!(
      { accessToken: "pha_tok", raw: { posthog_region: "us", scoped_teams: [7] } },
      { client: "desktop", fetch: doFetch },
    );
    expect(seen.map((s) => s.url)).toEqual([
      "https://us.posthog.com/api/projects/7/",
      "https://us.posthog.com/api/organizations/org-7/",
    ]);
    expect(result.credentials).toEqual({ region: "us", organizationId: "org-7" });
  });

  it("leaves the organization on current for an all-access grant and survives failures", async () => {
    const { doFetch, seen } = fakeFetch(() => new Error("offline"));
    const result = await plugin.completeOAuthConnection!(
      { accessToken: "pha_tok", raw: { scoped_organizations: ["a", "b"] } },
      { client: "desktop", fetch: doFetch },
    );
    expect(seen[0]!.url).toBe("https://us.posthog.com/api/organizations/@current/");
    expect(result).toEqual({ credentials: { region: "us" } });
  });
});

describe("validateServerCredentials", () => {
  it("rejects an OAuth token pointed at a self-hosted instance", () => {
    expect(plugin.validateServerCredentials!({ apiKey: "pha_x", __oauth: "{}" })).toBeNull();
    expect(
      plugin.validateServerCredentials!({
        apiKey: "pha_x",
        __oauth: "{}",
        host: "https://ph.example.com",
      }),
    ).toMatch(/PostHog Cloud only/);
    expect(
      plugin.validateServerCredentials!({ apiKey: "phx_x", host: "https://ph.example.com" }),
    ).toBeNull();
  });
});
