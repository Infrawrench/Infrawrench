import { OAuthTokenError } from "@infrawrench/plugin-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenRouterClient } from "../client.js";
import { plugin } from "../plugin.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OpenRouter OAuth declaration", () => {
  it("needs no client and mints a non-refreshing key into the inference key field", () => {
    const decl = plugin.manifest.oauth!;
    expect(decl.clientRegistration).toBe("none");
    expect(decl.tokenField).toBe("apiKey");
    expect(decl.refresh).toBe("none");
    expect(decl.access).toBe("full");
    expect(decl.clients.desktop?.loopbackHost).toBe("localhost");
  });

  it("builds the consent URL with callback_url and no client id", () => {
    const url = new URL(
      plugin.buildOAuthAuthorizeUrl!({
        clientId: "",
        redirectUri: "http://localhost:43118/oauth/callback",
        state: "st",
        codeChallenge: "ch",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://openrouter.ai/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      callback_url: "http://localhost:43118/oauth/callback",
      state: "st",
      key_label: "Infrawrench",
      code_challenge: "ch",
      code_challenge_method: "S256",
    });
  });
});

describe("exchangeOAuthCode", () => {
  function fakeFetch(status: number, body: unknown) {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), init });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
    return { doFetch, seen };
  }

  it("posts the code and verifier as JSON and returns the key", async () => {
    const { doFetch, seen } = fakeFetch(200, { key: "sk-or-v1-new", user_id: "u1" });
    const tokens = await plugin.exchangeOAuthCode!({
      code: "c1",
      codeVerifier: "v1",
      redirectUri: "http://localhost:43118/oauth/callback",
      client: { clientId: "", auth: "none" },
      fetch: doFetch,
    });
    expect(tokens.accessToken).toBe("sk-or-v1-new");
    expect(tokens.refreshToken).toBeUndefined();
    expect(tokens.expiresAt).toBeUndefined();
    expect(seen[0]!.url).toBe("https://openrouter.ai/api/v1/auth/keys");
    expect(seen[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(seen[0]!.init?.body))).toEqual({
      code: "c1",
      code_verifier: "v1",
      code_challenge_method: "S256",
    });
  });

  it("raises a token error when OpenRouter refuses the code", async () => {
    const { doFetch } = fakeFetch(400, { error: { message: "Invalid code" } });
    const run = plugin.exchangeOAuthCode!({
      code: "bad",
      redirectUri: "x",
      client: { clientId: "", auth: "none" },
      fetch: doFetch,
    });
    await expect(run).rejects.toBeInstanceOf(OAuthTokenError);
    await expect(run).rejects.toThrow("Invalid code");
  });
});

describe("inference-key-only accounts", () => {
  it("lists no management-only objects instead of failing", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const c = new OpenRouterClient({ apiKey: "sk-or-v1-inference" });
    for (const type of ["api-key", "guardrail", "workspace", "byok-credential"]) {
      expect(await c.listResources(type, "acc")).toEqual([]);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
