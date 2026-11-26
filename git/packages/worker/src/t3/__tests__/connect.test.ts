/**
 * An environment added through T3 Connect, against the fake environment
 * (`helpers/fake-t3.ts`) answering on a tunnel address: which addresses
 * count as one, that the guarded fetch still decides what is called, the
 * whole sign-in, and that its OAuth documents may name its own origin only.
 */
import { describe, expect, it } from "vitest";
import { T3_CONNECT_REFUSAL } from "@infrawrench/git-contract";
import { fakeT3 } from "../../__tests__/helpers/fake-t3";
import { connectOrigin, isConnectOrigin } from "../connect";
import { LOCALHOST_REFUSAL, T3Error, environmentOrigin, makeT3Http } from "../http";
import {
  authorizeUrl,
  discover,
  exchangeCode,
  pkceChallenge,
  randomToken,
  registerClient,
} from "../oauth";

const SITE = ["git.example.test"];
const REDIRECT = "https://git.example.test/auth/t3/callback";
const TUNNEL = "https://prod-0123456789abcdef.tunnels.example.net";

const httpOf = (fetch: (input: string, init: RequestInit) => Promise<Response>) =>
  makeT3Http({ fetch, siteHosts: SITE });

const refusal = async (work: () => unknown): Promise<T3Error> => {
  try {
    await work();
  } catch (error) {
    if (error instanceof T3Error) return error;
    throw error;
  }
  throw new Error("was not refused");
};

describe("which addresses are a T3 Connect environment's", () => {
  it("takes the MCP URL T3 Code copies and keeps the origin", () => {
    expect(connectOrigin(`${TUNNEL}/mcp`, SITE)).toBe(TUNNEL);
    expect(connectOrigin("  prod-0123456789abcdef.tunnels.example.net ", SITE)).toBe(TUNNEL);
    expect(isConnectOrigin(TUNNEL)).toBe(true);
  });

  it("refuses everything else, with what to do about it", async () => {
    for (const pasted of [
      "https://t3.example.net/mcp",
      "https://localhost:3773/mcp",
      "https://127.0.0.1/mcp",
      "https://10.0.0.5/mcp",
      "https://169.254.169.254/latest/meta-data",
      "https://[fd00::1]/mcp",
      "https://box.local/mcp",
      "https://relay.t3.codes",
      "https://app.t3.codes/approve-agent",
      `${TUNNEL}:8443/mcp`,
      `https://user:secret@${new URL(TUNNEL).host}/mcp`,
      "https://dev-julius-0123456789abcdef.tunnels.example.net/mcp",
      "https://git.example.test",
    ]) {
      const error = await refusal(() => connectOrigin(pasted, SITE));
      expect(error.code, pasted).toBe("address_refused");
      expect(error.message, pasted).toBe(T3_CONNECT_REFUSAL);
    }
    expect(
      (await refusal(() => connectOrigin(`http://${new URL(TUNNEL).host}`, SITE))).message,
    ).toBe("The address has to start with https://");
    expect((await refusal(() => connectOrigin("  ", SITE))).message).toBe("That is not an address");
  });

  it("is held to the zone once the zone is known", async () => {
    expect(connectOrigin(`${TUNNEL}/mcp`, SITE, ["tunnels.example.net"])).toBe(TUNNEL);
    const error = await refusal(() =>
      connectOrigin(`${TUNNEL}/mcp`, SITE, ["tunnels.example.org"]),
    );
    expect(error.message).toBe(T3_CONNECT_REFUSAL);
    expect(isConnectOrigin(TUNNEL, ["tunnels.example.org"])).toBe(false);
  });

  it("never loosens the public-address rule: a tunnel name that is this site is refused", async () => {
    const host = "prod-0123456789abcdef.tunnels.example.net";
    const error = await refusal(() => connectOrigin(`https://${host}/mcp`, [host]));
    expect(error.code).toBe("address_refused");
    expect(error.message).not.toBe(T3_CONNECT_REFUSAL);
  });

  it("leaves a typed address to the public-address rule alone", async () => {
    // A tunnel address typed as an address is still taken, a port and all the rest too.
    expect(environmentOrigin(`${TUNNEL}/mcp`, SITE)).toBe(TUNNEL);
    expect(environmentOrigin("https://t3.example.net:8443", SITE)).toBe(
      "https://t3.example.net:8443",
    );
    expect((await refusal(() => environmentOrigin("https://localhost", SITE))).message).toBe(
      LOCALHOST_REFUSAL,
    );
  });
});

describe("signing in to an environment on its T3 Connect address", () => {
  it("discovers, registers and signs in, every request to the tunnel and none elsewhere", async () => {
    const t3 = fakeT3({ origin: TUNNEL });
    const http = httpOf(t3.fetch);
    const found = await discover(http, connectOrigin(`${TUNNEL}/mcp`, SITE), SITE);
    expect(found.endpoints.issuer).toBe(TUNNEL);
    expect(found.resource).toBe(`${TUNNEL}/mcp`);
    const client = await registerClient(http, found.endpoints, { redirectUri: REDIRECT });
    const verifier = randomToken();
    const url = authorizeUrl(found.endpoints, {
      clientId: client.clientId,
      redirectUri: REDIRECT,
      state: "state-1",
      challenge: await pkceChallenge(verifier),
      resource: found.resource,
      scopes: found.scopes,
    });
    expect(new URL(url).origin).toBe(TUNNEL);
    const { code } = t3.approve(url);
    const tokens = await exchangeCode(http, found.endpoints, client, {
      code,
      verifier,
      redirectUri: REDIRECT,
      resource: found.resource,
    });
    expect(tokens.accessToken).not.toBe("");
    // One credential: the environment's own token. T3 Connect gives the forge none.
    expect(tokens.refreshToken).toBeUndefined();
    expect(t3.requests.every((request) => new URL(request.url).origin === TUNNEL)).toBe(true);
  });

  it("refuses OAuth documents that name another host, however public", async () => {
    const t3 = fakeT3({ origin: TUNNEL });
    const asked: string[] = [];
    const rewrite =
      (path: string, change: (body: Record<string, unknown>) => void) =>
      async (input: string, init: RequestInit) => {
        asked.push(input);
        const response = await t3.fetch(input, init);
        if (new URL(input).pathname !== path) return response;
        const body = (await response.json()) as Record<string, unknown>;
        change(body);
        return new Response(JSON.stringify(body), { status: 200 });
      };
    const cases: Array<[string, (body: Record<string, unknown>) => void]> = [
      [
        "/.well-known/oauth-protected-resource/mcp",
        (body) => (body["authorization_servers"] = ["https://auth.example.org"]),
      ],
      [
        "/.well-known/oauth-authorization-server",
        (body) => (body["token_endpoint"] = "https://auth.example.org/token"),
      ],
      [
        "/.well-known/oauth-authorization-server",
        (body) => (body["authorization_endpoint"] = "https://app.t3.codes/authorize"),
      ],
      [
        "/.well-known/oauth-authorization-server",
        (body) =>
          (body["registration_endpoint"] =
            "https://prod-fedcba9876543210.tunnels.example.net/oauth/mcp/register"),
      ],
    ];
    for (const [path, change] of cases) {
      const error = await refusal(() => discover(httpOf(rewrite(path, change)), TUNNEL, SITE));
      expect(error.code, path).toBe("bad_answer");
      expect(error.message).toContain("T3 Connect address");
    }
    expect(asked.every((url) => new URL(url).origin === TUNNEL)).toBe(true);
  });

  it("still refuses a private address in them as an address", async () => {
    const t3 = fakeT3({ origin: TUNNEL });
    const fetch = async (input: string, init: RequestInit) => {
      const response = await t3.fetch(input, init);
      if (new URL(input).pathname !== "/.well-known/oauth-authorization-server") return response;
      const body = (await response.json()) as Record<string, unknown>;
      body["token_endpoint"] = "https://169.254.169.254/token";
      return new Response(JSON.stringify(body), { status: 200 });
    };
    expect((await refusal(() => discover(httpOf(fetch), TUNNEL, SITE))).code).toBe(
      "address_refused",
    );
  });

  it("lets a typed address keep an authorization server of its own", async () => {
    // Not T3 Connect: the documents may name another public host, as before.
    const t3 = fakeT3();
    const fetch = async (input: string, init: RequestInit) => {
      const response = await t3.fetch(input, init);
      if (new URL(input).pathname !== "/.well-known/oauth-authorization-server") return response;
      const body = (await response.json()) as Record<string, unknown>;
      body["token_endpoint"] = "https://auth.example.org/token";
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const found = await discover(httpOf(fetch), t3.origin, SITE);
    expect(found.endpoints.tokenEndpoint).toBe("https://auth.example.org/token");
  });
});
