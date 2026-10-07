import { beforeEach, describe, expect, it } from "vitest";
import type { HostServices } from "@infrawrench/plugin-base";
import { OktaClient } from "../client.js";
import { nextLink, normalizeOrgUrl, rateLimitBucket } from "../api.js";
import { parseStatusFeed } from "../status-feed.js";
import { oktaTerraformExport } from "../terraform.js";

const ACCOUNT = "acct";
const ORG = "https://acme.okta.com";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}
interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

let calls: Call[] = [];

function services(handler: (call: Call) => Reply): HostServices {
  return {
    http: {
      request: async (req) => {
        const call: Call = {
          url: req.url,
          method: req.method,
          headers: req.headers,
          ...(typeof req.body === "string" ? { body: req.body } : {}),
        };
        calls.push(call);
        const res = handler(call);
        return {
          status: res.status ?? 200,
          headers: res.headers ?? {},
          body:
            res.body === undefined
              ? ""
              : typeof res.body === "string"
                ? res.body
                : JSON.stringify(res.body),
        };
      },
    },
  };
}

function ssws(handler: (call: Call) => Reply) {
  return new OktaClient({ orgUrl: "acme-admin.okta.com", apiToken: "tok" }, services(handler));
}

function decodeJwt(jwt: string): {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
} {
  const [h, c] = jwt.split(".");
  const dec = (s: string) => JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
  return { header: dec(h!), claims: dec(c!) };
}

beforeEach(() => {
  calls = [];
});

describe("credentials", () => {
  it("needs an API token or a service app key", () => {
    expect(() => new OktaClient({ orgUrl: ORG })).toThrow(/API token/);
    expect(() => new OktaClient({ orgUrl: ORG, clientId: "x" })).toThrow(/private key/);
  });

  it("maps the admin console host to the org host", () => {
    expect(normalizeOrgUrl("acme-admin.okta.com")).toBe("https://acme.okta.com");
    expect(normalizeOrgUrl("https://dev-1-admin.oktapreview.com/admin/dashboard")).toBe(
      "https://dev-1.oktapreview.com",
    );
    expect(normalizeOrgUrl("https://login.example.com")).toBe("https://login.example.com");
  });
});

describe("SSWS transport", () => {
  it("sends the SSWS header and follows Link pagination", async () => {
    const client = ssws((call) => {
      if (call.url === `${ORG}/api/v1/users?limit=200`) {
        return {
          body: [{ id: "u1", status: "ACTIVE", profile: { login: "ada@example.com" } }],
          headers: {
            link: `<${ORG}/api/v1/users?limit=200>; rel="self", <${ORG}/api/v1/users?after=u1&limit=200>; rel="next"`,
          },
        };
      }
      return { body: [{ id: "u2", status: "LOCKED_OUT", profile: { login: "bob@example.com" } }] };
    });
    const users = await client.listResources("user", ACCOUNT);
    expect(users.map((u) => u.externalId)).toEqual(["u1", "u2"]);
    expect(calls[0]!.headers["Authorization"]).toBe("SSWS tok");
    expect(calls[1]!.url).toBe(`${ORG}/api/v1/users?after=u1&limit=200`);
    expect(client.renderSidebarItem(users[1]!).status?.status).toBe("error");
  });

  it("surfaces Okta's errorSummary and the HTTP status", async () => {
    const client = ssws(() => ({
      status: 403,
      body: {
        errorCode: "E0000006",
        errorSummary: "You do not have permission to perform the requested action",
        errorCauses: [],
      },
    }));
    const error = (await client
      .getResource("user", `${ACCOUNT}:user:u1`, ACCOUNT)
      .catch((e) => e)) as Error & { status?: number };
    expect(error.status).toBe(403);
    expect(error.message).toContain("You do not have permission");
    expect(error.message).toContain("E0000006");
  });

  it("deactivates a user before deleting", async () => {
    const client = ssws((call) =>
      call.method === "GET" ? { body: { id: "u1", status: "ACTIVE" } } : { status: 204 },
    );
    await client.deleteResource("user", `${ACCOUNT}:user:u1`);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "GET /api/v1/users/u1",
      "POST /api/v1/users/u1/lifecycle/deactivate",
      "DELETE /api/v1/users/u1",
    ]);
  });

  it("lists every policy type and tolerates feature-gated ones", async () => {
    const client = ssws((call) => {
      const type = new URL(call.url).searchParams.get("type");
      if (type === "PASSWORD")
        return {
          body: [{ id: "p1", type, name: "Default", status: "ACTIVE", system: true, priority: 1 }],
        };
      if (type === "ENTITY_RISK")
        return { status: 400, body: { errorSummary: "feature not enabled" } };
      return { body: [] };
    });
    const policies = await client.listResources("policy", ACCOUNT);
    expect(policies).toHaveLength(1);
    expect(policies[0]!.fields).toMatchObject({ type: "PASSWORD", system: true, priority: 1 });
    expect(calls).toHaveLength(12);
  });

  it("reads rate-limit headroom as quotas", async () => {
    const client = ssws(() => ({
      body: [],
      headers: {
        "x-rate-limit-limit": "600",
        "x-rate-limit-remaining": "540",
        "x-rate-limit-reset": "1700000000",
      },
    }));
    const quotas = await client.fetchQuotas(ACCOUNT);
    expect(quotas).toHaveLength(5);
    expect(quotas[0]).toMatchObject({ id: "rate-limit:/api/v1/users", limit: 600, used: 60 });
  });

  it("builds IP network zones from CIDRs and ranges", async () => {
    const client = ssws((call) => ({ body: { id: "z1", ...JSON.parse(call.body ?? "{}") } }));
    const zone = await client.createResource("network-zone", ACCOUNT, {
      name: "Office",
      usage: "POLICY",
      gateways: "203.0.113.0/24, 198.51.100.1-198.51.100.9",
    });
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({
      type: "IP",
      gateways: [
        { type: "CIDR", value: "203.0.113.0/24" },
        { type: "RANGE", value: "198.51.100.1-198.51.100.9" },
      ],
    });
    expect(zone.fields["gateways"]).toBe("203.0.113.0/24, 198.51.100.1-198.51.100.9");
  });
});

describe("OAuth service app with DPoP", () => {
  it("signs a client assertion, answers the DPoP nonce challenge and binds API calls", async () => {
    const pair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.privateKey)), kid: "key-1" };
    let tokenCalls = 0;
    const client = new OktaClient(
      {
        orgUrl: ORG,
        clientId: "0oaclient",
        privateKey: JSON.stringify(jwk),
        scopes: "okta.users.read",
      },
      services((call) => {
        if (call.url.endsWith("/oauth2/v1/token")) {
          tokenCalls++;
          if (tokenCalls === 1)
            return {
              status: 400,
              body: { error: "invalid_dpop_proof", error_description: "DPoP proof required" },
            };
          if (tokenCalls === 2)
            return {
              status: 400,
              body: { error: "use_dpop_nonce" },
              headers: { "dpop-nonce": "n-1" },
            };
          return { body: { access_token: "at-1", token_type: "DPoP", expires_in: 3600 } };
        }
        return { body: { id: "u1", status: "ACTIVE", profile: { login: "a@b.c" } } };
      }),
    );
    await client.getResource("user", `${ACCOUNT}:user:u1`, ACCOUNT);

    const form = new URLSearchParams(calls[2]!.body!);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("scope")).toBe("okta.users.read");
    const assertion = form.get("client_assertion")!;
    const { header, claims } = decodeJwt(assertion);
    expect(header).toMatchObject({ alg: "RS256", kid: "key-1" });
    expect(claims).toMatchObject({
      iss: "0oaclient",
      sub: "0oaclient",
      aud: `${ORG}/oauth2/v1/token`,
    });
    const [h, c, s] = assertion.split(".");
    const sig = Uint8Array.from(atob(s!.replace(/-/g, "+").replace(/_/g, "/")), (ch) =>
      ch.charCodeAt(0),
    );
    expect(
      await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        pair.publicKey,
        sig,
        new TextEncoder().encode(`${h}.${c}`),
      ),
    ).toBe(true);
    expect(decodeJwt(calls[2]!.headers["DPoP"]!).claims).toMatchObject({
      htm: "POST",
      nonce: "n-1",
    });

    const api = calls[3]!;
    expect(api.headers["Authorization"]).toBe("DPoP at-1");
    const proof = decodeJwt(api.headers["DPoP"]!);
    expect(proof.header).toMatchObject({ typ: "dpop+jwt", alg: "ES256" });
    expect(proof.claims).toMatchObject({ htm: "GET", htu: `${ORG}/api/v1/users/u1` });
    expect(typeof proof.claims["ath"]).toBe("string");
  });
});

describe("helpers", () => {
  it("parses Link headers and groups rate-limit buckets", () => {
    expect(nextLink('<https://a/x?after=1>; rel="next"')).toBe("https://a/x?after=1");
    expect(nextLink('<https://a/x>; rel="self"')).toBeNull();
    expect(rateLimitBucket("/api/v1/users")).toBe("/api/v1/users");
    expect(rateLimitBucket("/api/v1/users/00u1")).toBe("/api/v1/users/{id}");
    expect(rateLimitBucket("/api/v1/users/00u1/groups")).toBe("/api/v1/users/{id}/*");
  });
});

describe("status feed", () => {
  it("keeps unresolved entries from the Atom feed", () => {
    const body = `<feed xmlns="http://www.w3.org/2005/Atom">
 <entry><title>Resolved Service Disruption</title><updated>2025-04-30T16:47:04.000Z</updated><link href="https://status.okta.com/#incident/a"/><id>https://www.salesforce.com/a</id><content type="text">Fixed.</content></entry>
 <entry><title>Service Degradation</title><updated>2026-10-06T10:00:00.000Z</updated><link href="https://status.okta.com/#incident/b"/><id>https://www.salesforce.com/b</id><content type="text">US Cell 6 errors.</content></entry>
</feed>`;
    const incidents = parseStatusFeed(body);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      externalId: "https://www.salesforce.com/b",
      impact: "minor",
      providerWide: true,
      lastUpdateText: "US Cell 6 errors.",
    });
  });
});

describe("terraform", () => {
  it("exports IP network zones with their gateways", () => {
    const out = oktaTerraformExport.mapResource({
      id: "a:network-zone:z1",
      pluginId: "okta",
      resourceTypeId: "network-zone",
      accountId: "a",
      displayName: "Office",
      externalId: "z1",
      fields: { name: "Office", type: "IP", usage: "POLICY", gateways: "203.0.113.0/24" },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    });
    expect(out?.resource).toMatchObject({ type: "okta_network_zone", importId: "z1" });
    expect(out?.resource.attributes["gateways"]).toEqual({
      kind: "list",
      items: [{ kind: "string", value: "203.0.113.0/24" }],
    });
  });
});
