import { buildOAuthAuthorizeUrl } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { plugin } from "../plugin.js";

const noFetch = (async () => {
  throw new Error("no network expected");
}) as unknown as typeof fetch;

describe("Convex OAuth declaration", () => {
  it("is a server-only team-token flow with no refresh", () => {
    const decl = plugin.manifest.oauth!;
    expect(decl.tokenField).toBe("accessToken");
    expect(decl.clients.server?.pkce).toBe(true);
    expect(decl.clients.desktop).toBeUndefined();
    expect(decl.access).toBe("full");
    expect(decl.refresh).toBe("none");
    expect(decl.tokenUrl).toBe("https://api.convex.dev/oauth/token");
    const url = new URL(
      buildOAuthAuthorizeUrl(decl, {
        clientId: "cid",
        redirectUri: "https://app.example/cb",
        state: "s",
        codeChallenge: "c",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://dashboard.convex.dev/oauth/authorize/team");
    expect(url.searchParams.has("scope")).toBe(false);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("completeOAuthConnection", () => {
  it("names the account after the team slug in the token", async () => {
    const result = await plugin.completeOAuthConnection!(
      { accessToken: "team:acme-co|AAAAAA==", raw: {} },
      { client: "server", fetch: noFetch },
    );
    expect(result).toEqual({ accountName: "Convex (acme-co)" });
  });

  it("suggests nothing for a token without the team prefix", async () => {
    const result = await plugin.completeOAuthConnection!(
      { accessToken: "opaque", raw: {} },
      { client: "server", fetch: noFetch },
    );
    expect(result).toEqual({});
  });
});
