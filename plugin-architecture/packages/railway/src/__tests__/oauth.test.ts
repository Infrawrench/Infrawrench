import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOAuthAuthorizeUrl,
  desktopOAuthRedirectUri,
  OAUTH_CREDENTIAL_KEY,
  type OAuthTokenSet,
} from "@infrawrench/plugin-base";
import { RailwayClient } from "../client.js";
import { plugin } from "../plugin.js";
import { RESOURCE_TYPES } from "../resource-types.js";
import { completeRailwayOAuth } from "../oauth.js";

const TOKENS: OAuthTokenSet = { accessToken: "rw-oauth-access", raw: {} };
const GRANT = JSON.stringify({ v: 1, client: "server", connectedAt: 1 });

function graphql(data: unknown, status = 200) {
  return vi.fn(
    async (_url: string, _init: RequestInit) => new Response(JSON.stringify(data), { status }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("Railway OAuth declaration", () => {
  const decl = plugin.manifest.oauth!;

  it("requests refresh tokens the way Railway documents", () => {
    expect(decl.scopes).toContain("openid");
    expect(decl.scopes).toContain("offline_access");
    expect(decl.authorizeParams).toEqual({ prompt: "consent" });
    expect(decl.refresh).toBe("rotating");
  });

  it("asks for email and profile, which listing granted workspaces needs", () => {
    expect(decl.scopes).toEqual(expect.arrayContaining(["email", "profile", "workspace:admin"]));
  });

  it("uses a 127.0.0.1 loopback for the native client", () => {
    expect(desktopOAuthRedirectUri(decl)).toBe("http://127.0.0.1:43118/oauth/callback");
    const url = new URL(
      buildOAuthAuthorizeUrl(decl, {
        clientId: "cid",
        redirectUri: desktopOAuthRedirectUri(decl),
        state: "st",
        codeChallenge: "ch",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://backboard.railway.com/oauth/auth");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toBe(decl.scopes.join(" "));
  });
});

describe("completeRailwayOAuth", () => {
  it("pre-fills the single granted workspace", async () => {
    const fetchMock = graphql({
      data: {
        me: { name: "Jane", email: "j@example.com", workspaces: [{ id: "w1", name: "Acme" }] },
      },
    });
    const res = await completeRailwayOAuth(TOKENS, {
      client: "server",
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toEqual({ credentials: { workspaceId: "w1" }, accountName: "Acme" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://backboard.railway.com/graphql/v2");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer rw-oauth-access",
    );
    expect(String(init.body)).toContain("me { name email workspaces");
  });

  it("leaves the workspace on All workspaces when several were granted", async () => {
    const fetchMock = graphql({
      data: {
        me: {
          name: "Jane",
          email: "j@example.com",
          workspaces: [
            { id: "w1", name: "Acme" },
            { id: "w2", name: "Side" },
          ],
        },
      },
    });
    const res = await completeRailwayOAuth(TOKENS, {
      client: "desktop",
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toEqual({ accountName: "Jane" });
  });

  it("returns nothing when the lookup fails", async () => {
    const res = await completeRailwayOAuth(TOKENS, {
      client: "server",
      fetch: graphql({ errors: [{ message: "Not Authorized" }] }, 401) as unknown as typeof fetch,
    });
    expect(res).toEqual({});
  });
});

describe("workspace discovery for OAuth credentials", () => {
  it("reads me.workspaces instead of the apiToken query", async () => {
    const fetchMock = graphql({ data: { me: { workspaces: [{ id: "w9", name: "Granted" }] } } });
    vi.stubGlobal("fetch", fetchMock);
    const client = new RailwayClient(
      { apiToken: "rw-oauth-access", [OAUTH_CREDENTIAL_KEY]: GRANT },
      RESOURCE_TYPES,
    );
    expect(await client.workspaces()).toEqual([{ id: "w9", name: "Granted" }]);
    const body = String(fetchMock.mock.calls[0]![1].body);
    expect(body).toContain("me {");
    expect(body).not.toContain("apiToken");
  });

  it("lists granted workspaces in the workspace picker", async () => {
    vi.stubGlobal(
      "fetch",
      graphql({ data: { me: { workspaces: [{ id: "w9", name: "Granted" }] } } }),
    );
    expect(
      await plugin.listCredentialOptions!("workspaceId", {
        apiToken: "rw-oauth-access",
        [OAUTH_CREDENTIAL_KEY]: GRANT,
      }),
    ).toEqual([{ id: "w9", label: "Granted", description: "w9" }]);
  });
});
