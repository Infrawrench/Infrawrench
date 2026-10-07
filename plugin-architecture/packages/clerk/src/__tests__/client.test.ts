import { beforeEach, describe, expect, it } from "vitest";
import type { HostServices } from "@infrawrench/plugin-base";
import { ClerkClient } from "../client.js";
import { API_VERSION } from "../api.js";
import { parseStatusFeed } from "../status-feed.js";

const ACCOUNT = "acct";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

let calls: Call[] = [];

function client(handler: (call: Call) => { status?: number; body?: unknown }): ClerkClient {
  const services: HostServices = {
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
          headers: {},
          body: res.body === undefined ? "" : JSON.stringify(res.body),
        };
      },
    },
  };
  return new ClerkClient({ secretKey: "sk_live_abc" }, services);
}

beforeEach(() => {
  calls = [];
});

describe("credentials", () => {
  it("rejects publishable keys", () => {
    expect(() => new ClerkClient({ secretKey: "pk_live_abc" })).toThrow(/sk_live_/);
    expect(() => new ClerkClient({})).toThrow(/secretKey/);
  });
});

describe("transport", () => {
  it("sends the bearer key and pins the API version", async () => {
    const c = client(() => ({ body: [] }));
    await c.listResources("redirect-url", ACCOUNT);
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer sk_live_abc");
    expect(calls[0]!.headers["Clerk-API-Version"]).toBe(API_VERSION);
  });

  it("pages offset lists that answer {data, total_count}", async () => {
    const c = client((call) => {
      const offset = Number(new URL(call.url).searchParams.get("offset"));
      const data = Array.from({ length: offset === 0 ? 500 : 3 }, (_, i) => ({
        id: `org_${offset + i}`,
        name: `Org ${offset + i}`,
        created_at: 1700000000000,
      }));
      return { body: { data, total_count: 503 } };
    });
    const orgs = await c.listResources("organization", ACCOUNT);
    expect(orgs).toHaveLength(503);
    expect(calls).toHaveLength(2);
    expect(orgs[0]!.createdAt).toBe(new Date(1700000000000).toISOString());
  });

  it("surfaces Clerk's error long_message and code with the status", async () => {
    const c = client(() => ({
      status: 422,
      body: {
        errors: [
          {
            message: "is invalid",
            long_message: "email_address must be a valid email address.",
            code: "form_param_format_invalid",
          },
        ],
      },
    }));
    const error = (await c
      .createResource("user", ACCOUNT, { email: "nope" })
      .catch((e) => e)) as Error & { status?: number };
    expect(error.status).toBe(422);
    expect(error.message).toContain("email_address must be a valid email address.");
    expect(error.message).toContain("form_param_format_invalid");
  });
});

describe("mapping", () => {
  it("maps users with their primary email and sign-in methods", async () => {
    const c = client(() => ({
      body: [
        {
          id: "user_1",
          primary_email_address_id: "idn_2",
          email_addresses: [
            { id: "idn_1", email_address: "old@example.com" },
            { id: "idn_2", email_address: "ada@example.com" },
          ],
          password_enabled: true,
          external_accounts: [{ provider: "oauth_google" }],
          two_factor_enabled: true,
          banned: false,
          last_active_at: 1700000000000,
        },
      ],
    }));
    const [user] = await c.listResources("user", ACCOUNT);
    expect(user).toMatchObject({
      displayName: "ada@example.com",
      fields: {
        email: "ada@example.com",
        signInMethods: "password, google",
        twoFactorEnabled: true,
      },
    });
  });

  it("shows a domain's DNS targets", async () => {
    const c = client(() => ({
      body: {
        data: [
          {
            id: "dmn_1",
            name: "example.com",
            is_satellite: false,
            frontend_api_url: "https://clerk.example.com",
            cname_targets: [
              { host: "clerk.example.com", value: "frontend-api.clerk.services", required: true },
            ],
          },
        ],
        total_count: 1,
      },
    }));
    const [domain] = await c.listResources("domain", ACCOUNT);
    expect(domain!.fields["dnsRecords"]).toBe(
      "CNAME clerk.example.com → frontend-api.clerk.services",
    );
  });
});

describe("mutations", () => {
  it("counts new users per day bucket for metrics", async () => {
    const c = client((call) => {
      const params = new URL(call.url).searchParams;
      return {
        body: { object: "total_count", total_count: params.get("created_at_after") ? 2 : 10 },
      };
    });
    const end = Date.UTC(2026, 9, 6);
    const series = await c.fetchMetricSeries("instance", `${ACCOUNT}:instance:ins_1`, ACCOUNT, {
      startMs: end - 3 * 86_400_000,
      endMs: end,
    });
    expect(series[0]!.label).toBe("New users");
    expect(series[0]!.points).toHaveLength(3);
    expect(series[0]!.points.every((p) => p.value === 2)).toBe(true);
  });

  it("revokes every active session", async () => {
    const c = client((call) =>
      call.method === "GET" ? { body: [{ id: "sess_1" }, { id: "sess_2" }] } : { body: {} },
    );
    await c.invokeAction("user", `${ACCOUNT}:user:user_1`, "revoke-sessions");
    expect(calls.filter((x) => x.method === "POST").map((x) => new URL(x.url).pathname)).toEqual([
      "/v1/sessions/sess_1/revoke",
      "/v1/sessions/sess_2/revoke",
    ]);
  });

  it("rejects JWT templates with invalid claims JSON before calling Clerk", async () => {
    const c = client(() => ({ body: {} }));
    await expect(
      c.createResource("jwt-template", ACCOUNT, { name: "x", claims: "{not json" }),
    ).rejects.toThrow(/valid JSON/);
    expect(calls).toHaveLength(0);
  });

  it("applies settings changes to the right endpoints", async () => {
    const c = client(() => ({ body: {} }));
    await c.applyManifest(
      "r",
      ACCOUNT,
      JSON.stringify([
        { id: "restrictions.blocklist", value: "on" },
        { id: "org.max_allowed_memberships", value: "25" },
      ]),
    );
    expect(calls.map((x) => [new URL(x.url).pathname, JSON.parse(x.body!)])).toEqual([
      ["/v1/instance/restrictions", { blocklist: true }],
      ["/v1/instance/organization_settings", { max_allowed_memberships: 25 }],
    ]);
  });
});

describe("status feed", () => {
  it("keeps unresolved incidents", () => {
    const body = JSON.stringify({
      incidents: [
        {
          id: "a",
          name: "Dashboard increased latency",
          status: "resolved",
          impact: "minor",
          created_at: "2026-10-01T00:00:00Z",
          resolved_at: "2026-10-02T00:00:00Z",
          incident_updates: [],
        },
        {
          id: "b",
          name: "Sign-in errors",
          status: "identified",
          impact: "major",
          created_at: "2026-10-06T00:00:00Z",
          incident_updates: [],
        },
      ],
    });
    expect(parseStatusFeed(body).map((i) => i.externalId)).toEqual(["b"]);
  });
});
