import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOAuthAuthorizeUrl, desktopOAuthRedirectUri } from "@infrawrench/plugin-base";
import { plugin } from "../plugin.js";
import { CloudinaryClient } from "../client.js";
import { completeCloudinaryOAuth } from "../oauth.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function jwt(claims: Record<string, unknown>): string {
  const enc = (v: unknown) =>
    btoa(JSON.stringify(v)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${enc({ alg: "RS256" })}.${enc(claims)}.sig`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Cloudinary OAuth declaration", () => {
  const decl = plugin.manifest.oauth!;

  it("puts the token in API Secret and makes the API key optional", () => {
    expect(decl.tokenField).toBe("apiSecret");
    const fields = Object.fromEntries(plugin.manifest.credentialFields.map((f) => [f.key, f]));
    expect(fields["apiSecret"]?.sensitive).toBe(true);
    expect(fields["apiKey"]?.optional).toBe(true);
    expect(fields["cloudName"]?.optional).toBeFalsy();
  });

  it("requests the asset scopes plus offline access, with PKCE", () => {
    expect(decl.refresh).toBe("rotating");
    expect(decl.access).toBe("full");
    expect(desktopOAuthRedirectUri(decl)).toBe("http://127.0.0.1:43118/oauth/callback");
    const url = new URL(
      buildOAuthAuthorizeUrl(decl, {
        clientId: "cid",
        redirectUri: "https://app.example.com/cb",
        state: "st",
        codeChallenge: "ch",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://oauth.cloudinary.com/oauth2/auth");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(
      expect.arrayContaining(["asset_management", "upload", "offline_access"]),
    );
  });
});

describe("CloudinaryClient auth", () => {
  function capture() {
    const headers: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((async (_url: string, init?: RequestInit) => {
      headers.push(String((init?.headers as Record<string, string>)["Authorization"]));
      return json({ presets: [] });
    }) as typeof fetch);
    return headers;
  }

  it("uses Basic auth for a pasted key and secret", async () => {
    const headers = capture();
    await new CloudinaryClient({ cloudName: "demo", apiKey: "key", apiSecret: "secret" })
      .listResources("upload-preset", "a")
      .catch(() => undefined);
    expect(headers[0]).toBe(`Basic ${btoa("key:secret")}`);
  });

  it("asks the host for a fresh Bearer token per request when connected", async () => {
    const headers = capture();
    let n = 0;
    const getAccessToken = vi.fn(async () => `fresh-${++n}`);
    const c = new CloudinaryClient(
      { cloudName: "demo", apiKey: "", apiSecret: "stored", __oauth: '{"v":1}' },
      { oauth: { getAccessToken } } as never,
    );
    await c.listResources("upload-preset", "a").catch(() => undefined);
    await c.listResources("upload-preset", "a").catch(() => undefined);
    expect(headers.slice(0, 2)).toEqual(["Bearer fresh-1", "Bearer fresh-2"]);
  });

  it("treats an empty API key as an OAuth token when the grant was stripped", async () => {
    const headers = capture();
    await new CloudinaryClient({ cloudName: "demo", apiSecret: "access-token" })
      .listResources("upload-preset", "a")
      .catch(() => undefined);
    expect(headers[0]).toBe("Bearer access-token");
  });
});

describe("completeCloudinaryOAuth", () => {
  it("reads the cloud name from the token response", async () => {
    const fetchMock = vi.fn();
    const res = await completeCloudinaryOAuth(
      { accessToken: "opaque", raw: { cloud_name: "acme-prod" } },
      { client: "server", fetch: fetchMock as unknown as typeof fetch },
    );
    expect(res).toEqual({
      credentials: { cloudName: "acme-prod", apiKey: "" },
      accountName: "acme-prod",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads it from the access token claims", async () => {
    const res = await completeCloudinaryOAuth(
      { accessToken: jwt({ sub: "u", ext: { cloud_name: "from-jwt" } }), raw: {} },
      { client: "desktop", fetch: vi.fn() as unknown as typeof fetch },
    );
    expect(res.credentials?.["cloudName"]).toBe("from-jwt");
  });

  it("falls back to the token info endpoint", async () => {
    const fetchMock = vi.fn(async () => json({ cloud_name: "from-info" }));
    const res = await completeCloudinaryOAuth(
      { accessToken: "opaque", raw: {} },
      { client: "server", fetch: fetchMock as unknown as typeof fetch },
    );
    expect(res.credentials?.["cloudName"]).toBe("from-info");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.cloudinary.com/v1_1/token/info");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer opaque");
  });

  it("still clears the API key when the cloud cannot be found", async () => {
    const fetchMock = vi.fn(async () => json({ error: { message: "nope" } }, 404));
    const res = await completeCloudinaryOAuth(
      { accessToken: "opaque", raw: {} },
      { client: "server", fetch: fetchMock as unknown as typeof fetch },
    );
    expect(res).toEqual({ credentials: { apiKey: "" } });
  });
});
