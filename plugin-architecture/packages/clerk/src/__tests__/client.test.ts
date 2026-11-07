import { hostClient } from "@infrawrench/plugin-base/effect";
import type { HostedMethods } from "@infrawrench/plugin-base";
import { beforeEach, describe, expect, it } from "vitest";
import type { HostServices, SettingDescriptor } from "@infrawrench/plugin-base";
import { ClerkClient } from "../client.js";
import { API_VERSION } from "../api.js";
import { OAuthApplicationResourceType } from "../resources.js";
import { parseStatusFeed } from "../status-feed.js";

const ACCOUNT = "acct";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

let calls: Call[] = [];

function client(
  handler: (call: Call) => { status?: number; body?: unknown },
  secrets?: HostServices["secrets"],
): HostedMethods<ClerkClient> {
  const services: HostServices = {
    ...(secrets ? { secrets } : {}),
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
  return hostClient(new ClerkClient({ secretKey: "sk_live_abc" }, services));
}

beforeEach(() => {
  calls = [];
});

describe("credentials", () => {
  it("rejects publishable keys", () => {
    expect(() => hostClient(new ClerkClient({ secretKey: "pk_live_abc" }))).toThrow(/sk_live_/);
    expect(() => hostClient(new ClerkClient({}))).toThrow(/secretKey/);
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

  it.each([`${ACCOUNT}:user:`, `${ACCOUNT}:user:   `, "user"])(
    "refuses to revoke sessions for the blank user id in %j, sending nothing",
    async (resourceId) => {
      const c = client((call) =>
        call.method === "GET" ? { body: [{ id: "sess_other_user" }] } : { body: {} },
      );
      await expect(c.invokeAction("user", resourceId, "revoke-sessions")).rejects.toThrow(
        /needs a user id/,
      );
      expect(calls).toHaveLength(0);
    },
  );

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

describe("OAuth application client secret", () => {
  const RESOURCE = `${ACCOUNT}:oauth-application:oa_1`;
  const app = { id: "oa_1", name: "App", client_id: "cid", client_secret: "shh" };

  function store() {
    const saved = new Map<string, string>();
    return {
      saved,
      secrets: {
        getPlaintext: async (resourceId: string, field: string) =>
          saved.get(`${resourceId}/${field}`) ?? null,
        setPlaintext: async (resourceId: string, field: string, value: string) => {
          saved.set(`${resourceId}/${field}`, value);
        },
      },
    };
  }
  const create = (c: HostedMethods<ClerkClient>) =>
    c.createResource("oauth-application", ACCOUNT, { name: "App", redirectUris: "https://a.test" });

  it("hands the host the secret from the create response", async () => {
    const { saved, secrets } = store();
    const resource = await create(client(() => ({ body: app }), secrets));
    expect(resource.id).toBe(RESOURCE);
    expect(resource.secretStates).toEqual([
      { fieldKey: "clientSecret", resolution: { kind: "plaintext", value: "shh" } },
    ]);
    // The host's store points at the resource row, which it writes after this returns.
    expect(saved.size).toBe(0);
  });

  it("keeps the secret out of the fields and outputs, which are stored in the clear", async () => {
    const resource = await create(client(() => ({ body: app })));
    expect(JSON.stringify([resource.fields, resource.resolvedOutputs])).not.toContain("shh");
  });

  it("has nothing to hand over for a public client", async () => {
    const { client_secret: _none, ...publicApp } = app;
    const resource = await create(client(() => ({ body: publicApp })));
    expect(resource.secretStates).toEqual([]);
  });

  it("reads the output back from the host's store", async () => {
    const { saved, secrets } = store();
    saved.set(`${RESOURCE}/clientSecret`, "shh");
    const c = client(() => ({ body: {} }), secrets);
    expect(await c.resolveOutput("oauth-application", RESOURCE, "clientSecret", ACCOUNT)).toBe(
      "shh",
    );
    expect(calls).toHaveLength(0);
  });

  it("explains an application whose secret was never kept", async () => {
    const { secrets } = store();
    const c = client(() => ({ body: app }), secrets);
    await expect(
      c.resolveOutput("oauth-application", RESOURCE, "clientSecret", ACCOUNT),
    ).rejects.toThrow(/created or rotated/);
    expect(calls).toHaveLength(0);
  });

  it("replaces the kept secret when it is rotated", async () => {
    const { saved, secrets } = store();
    saved.set(`${RESOURCE}/clientSecret`, "old");
    const c = client(() => ({ body: { ...app, client_secret: "new" } }), secrets);
    const exported = await c.exportCredential(
      "oauth-application",
      RESOURCE,
      ACCOUNT,
      "rotate-secret",
    );
    expect(saved.get(`${RESOURCE}/clientSecret`)).toBe("new");
    expect(exported.warning).not.toContain("could not keep");
  });

  it("says so when a rotated secret could not be kept, and still shows it", async () => {
    const c = client(() => ({ body: { ...app, client_secret: "new" } }));
    const exported = await c.exportCredential(
      "oauth-application",
      RESOURCE,
      ACCOUNT,
      "rotate-secret",
    );
    expect(exported.fields?.find((f) => f.label === "Client secret")?.value).toBe("new");
    expect(exported.warning).toContain("could not keep");
  });

  it("declares the secret as a sensitive output", () => {
    const output = OAuthApplicationResourceType.outputs?.find((o) => o.key === "clientSecret");
    expect(output?.sensitive).toBe(true);
  });
});

describe("bot protection settings", () => {
  const settingsClient = () =>
    client((call) =>
      new URL(call.url).pathname === "/v1/instance/protect"
        ? { body: { rules_enabled: false, specter_enabled: true } }
        : { body: {} },
    );

  it("shows Specter as read-only and the rules as a toggle", async () => {
    const manifest = await settingsClient().getManifest();
    const { settings }: { settings: SettingDescriptor[] } = JSON.parse(manifest);
    expect(settings.find((s) => s.id === "protect.specter_enabled")).toMatchObject({
      control: "readonly",
      value: "on",
    });
    expect(settings.find((s) => s.id === "protect.rules_enabled")).toMatchObject({
      control: "toggle",
      value: "off",
    });
  });

  it("sends the rules toggle alone", async () => {
    await settingsClient().applyManifest(
      "r",
      ACCOUNT,
      JSON.stringify([{ id: "protect.rules_enabled", value: "on" }]),
    );
    expect(calls.map((x) => [new URL(x.url).pathname, JSON.parse(x.body!)])).toEqual([
      ["/v1/instance/protect", { rules_enabled: true }],
    ]);
  });

  it("refuses a Specter change before sending anything", async () => {
    await expect(
      settingsClient().applyManifest(
        "r",
        ACCOUNT,
        JSON.stringify([
          { id: "restrictions.blocklist", value: "on" },
          { id: "protect.rules_enabled", value: "on" },
          { id: "protect.specter_enabled", value: "off" },
        ]),
      ),
    ).rejects.toThrow(/Clerk support/);
    expect(calls).toHaveLength(0);
  });
});

describe("settings groups", () => {
  it.each(["__proto__", "constructor", "toString", "hasOwnProperty"])(
    "skips the group %j without writing to what it inherits",
    async (group) => {
      const c = client(() => ({ body: {} }));
      try {
        await c.applyManifest(
          "r",
          ACCOUNT,
          JSON.stringify([{ id: `${group}.polluted`, value: "on" }]),
        );
        expect(Object.getOwnPropertyDescriptor(Object.prototype, "polluted")).toBeUndefined();
        expect(Object.getOwnPropertyDescriptor(Object, "polluted")).toBeUndefined();
        expect(
          Object.getOwnPropertyDescriptor(Object.prototype.toString, "polluted"),
        ).toBeUndefined();
        expect(
          Object.getOwnPropertyDescriptor(Object.prototype.hasOwnProperty, "polluted"),
        ).toBeUndefined();
        expect(calls).toHaveLength(0);
      } finally {
        for (const shared of [
          Object.prototype,
          Object,
          Object.prototype.toString,
          Object.prototype.hasOwnProperty,
        ]) {
          Reflect.deleteProperty(shared, "polluted");
        }
      }
    },
  );
});

describe("lists", () => {
  const pathOf = (call: Call) => new URL(call.url).pathname;
  const offsetOf = (call: Call) => Number(new URL(call.url).searchParams.get("offset"));
  const rows = (offset: number, length = 500) =>
    Array.from({ length }, (_, i) => ({ id: `row_${offset + i}`, name: `Row ${offset + i}` }));

  it("reads past the old 2,500 row cap", async () => {
    const c = client((call) => {
      const offset = offsetOf(call);
      return { body: rows(offset, offset < 12_000 ? 500 : 7) };
    });
    expect(await c.listResources("user", ACCOUNT)).toHaveLength(12_007);
  });

  it("refuses a list that never ends instead of returning part of it", async () => {
    const c = client((call) => ({ body: rows(offsetOf(call)) }));
    await expect(c.listResources("user", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(100);
  });

  it("refuses a page whose list key was renamed, first or later", async () => {
    const first = client(() => ({ body: { items: [], total_count: 0 } }));
    await expect(first.listResources("organization", ACCOUNT)).rejects.toThrow("is not a list");
    calls = [];
    const later = client((call) =>
      offsetOf(call) === 0
        ? { body: { data: rows(0), total_count: 900 } }
        : { body: { items: rows(500), total_count: 900 } },
    );
    await expect(later.listResources("organization", ACCOUNT)).rejects.toThrow("is not a list");
    expect(calls).toHaveLength(2);
  });

  it("refuses an empty answer", async () => {
    const c = client(() => ({}));
    await expect(c.listResources("redirect-url", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("keeps reading a short page when total_count says there is more", async () => {
    const c = client((call) => {
      const offset = offsetOf(call);
      return { body: { data: rows(offset, offset < 200 ? 100 : 50), total_count: 250 } };
    });
    expect(await c.listResources("machine", ACCOUNT)).toHaveLength(250);
    expect(calls.map(offsetOf)).toEqual([0, 100, 200]);
  });

  it("reads the blocklist as one page, and refuses it when that page is not all of it", async () => {
    const whole = client(() => ({ body: { data: rows(0, 2), total_count: 2 } }));
    expect(await whole.listResources("blocklist-identifier", ACCOUNT)).toHaveLength(2);
    const renamed = client(() => ({ body: { items: [], total_count: 0 } }));
    await expect(renamed.listResources("blocklist-identifier", ACCOUNT)).rejects.toThrow(
      "is not a list",
    );
    const part = client(() => ({ body: { data: rows(0, 2), total_count: 3 } }));
    await expect(part.listResources("blocklist-identifier", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
  });

  it("lets a bad domains page through the instance's catch", async () => {
    const c = client((call) =>
      pathOf(call) === "/v1/domains" ? { body: { items: [] } } : { body: { id: "ins_1" } },
    );
    await expect(c.listResources("instance", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("still names the instance when domains fail for another reason", async () => {
    const c = client((call) =>
      pathOf(call) === "/v1/domains" ? { status: 403, body: {} } : { body: { id: "ins_1" } },
    );
    const [instance] = await c.listResources("instance", ACCOUNT);
    expect(instance!.externalId).toBe("ins_1");
  });

  it("revokes nothing when it cannot read every session", async () => {
    const c = client((call) =>
      call.method === "GET" ? { body: rows(offsetOf(call)) } : { body: {} },
    );
    await expect(
      c.invokeAction("user", `${ACCOUNT}:user:user_1`, "revoke-sessions"),
    ).rejects.toThrow("has more than Infrawrench reads");
    expect(calls.filter((x) => x.method === "POST")).toHaveLength(0);
  });

  it("reads every session past the old cap before revoking", async () => {
    const c = client((call) => {
      if (call.method !== "GET") return { body: {} };
      const offset = offsetOf(call);
      return { body: rows(offset, offset < 2_500 ? 500 : 1) };
    });
    await c.invokeAction("user", `${ACCOUNT}:user:user_1`, "revoke-sessions");
    expect(calls.filter((x) => x.method === "POST")).toHaveLength(2_501);
  });

  it("lets a picker stop at its cap", async () => {
    const c = client((call) => ({ body: rows(offsetOf(call)) }));
    const config = await c.getCreateConfig("organization");
    const owner = config.fields.find((f) => f.key === "createdBy");
    expect(owner!.options).toHaveLength(500);
    expect(calls).toHaveLength(1);
  });

  it("lets a detail view stop at its cap", async () => {
    const c = client((call) => {
      const offset = offsetOf(call);
      if (pathOf(call).endsWith("/memberships")) {
        return {
          body: {
            data: rows(offset).map((r) => ({ public_user_data: { user_id: r.id } })),
            total_count: 5_000,
          },
        };
      }
      return { body: [] };
    });
    const detail = await c.enrichDetail({
      id: `${ACCOUNT}:organization:org_1`,
      pluginId: "clerk",
      resourceTypeId: "organization",
      accountId: ACCOUNT,
      displayName: "Org",
      fields: {},
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    });
    expect(JSON.parse(detail.resolvedOutputs["__members__"]!)).toHaveLength(1000);
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
