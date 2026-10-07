import { beforeEach, describe, expect, it } from "vitest";
import type { HostServices } from "@infrawrench/plugin-base";
import { Auth0Client } from "../client.js";
import { normalizeDomain, regionOfDomain } from "../api.js";
import { parseStatusFeed } from "../status-feed.js";
import { auth0TerraformExport } from "../terraform.js";

const ACCOUNT = "acct";
const DOMAIN = "acme.eu.auth0.com";

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

function client(handler: (call: Call) => Reply): Auth0Client {
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
        const res = call.url.endsWith("/oauth/token")
          ? { body: { access_token: "mgmt-token", expires_in: 86400, token_type: "Bearer" } }
          : handler(call);
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
  return new Auth0Client(
    { domain: `https://${DOMAIN}/`, clientId: "cid", clientSecret: "csecret" },
    services,
  );
}

const apiCalls = () => calls.filter((c) => !c.url.endsWith("/oauth/token"));

beforeEach(() => {
  calls = [];
});

describe("credentials and auth", () => {
  it("normalizes the domain and derives the region", () => {
    expect(normalizeDomain("https://ACME.eu.auth0.com/")).toBe("acme.eu.auth0.com");
    expect(regionOfDomain("acme.eu.auth0.com")).toBe("eu");
    expect(regionOfDomain("acme.auth0.com")).toBe("us");
    expect(regionOfDomain("login.example.com")).toBe("");
  });

  it("requests a Management API token for the tenant audience and reuses it", async () => {
    const c = client(() => ({ body: { roles: [], total: 0 } }));
    await c.listResources("role", ACCOUNT);
    await c.listResources("role", ACCOUNT);
    const tokens = calls.filter((x) => x.url.endsWith("/oauth/token"));
    expect(tokens).toHaveLength(1);
    expect(JSON.parse(tokens[0]!.body!)).toEqual({
      grant_type: "client_credentials",
      client_id: "cid",
      client_secret: "csecret",
      audience: `https://${DOMAIN}/api/v2/`,
    });
    expect(apiCalls()[0]!.headers["Authorization"]).toBe("Bearer mgmt-token");
  });

  it("maps errors with status and Auth0's message", async () => {
    const c = client(() => ({
      status: 403,
      body: {
        statusCode: 403,
        error: "Forbidden",
        message: "Insufficient scope, expected any of: read:users",
        errorCode: "insufficient_scope",
      },
    }));
    const error = (await c
      .getResource("user", `${ACCOUNT}:user:auth0|1`, ACCOUNT)
      .catch((e) => e)) as Error & { status?: number };
    expect(error.status).toBe(403);
    expect(error.message).toContain("Insufficient scope");
    expect(error.message).toContain("insufficient_scope");
  });
});

describe("listing", () => {
  it("pages with include_totals until the total is reached", async () => {
    const c = client((call) => {
      const page = Number(new URL(call.url).searchParams.get("page"));
      const users = Array.from({ length: page === 0 ? 100 : 20 }, (_, i) => ({
        user_id: `auth0|${page}-${i}`,
        email: `u${page}-${i}@example.com`,
        identities: [{ connection: "Username-Password-Authentication" }],
      }));
      return { body: { start: page * 100, limit: 100, total: 120, users } };
    });
    const users = await c.listResources("user", ACCOUNT);
    expect(users).toHaveLength(120);
    expect(apiCalls()).toHaveLength(2);
    expect(new URL(apiCalls()[0]!.url).searchParams.get("include_totals")).toBe("true");
    expect(users[0]!.fields["connection"]).toBe("Username-Password-Authentication");
  });

  it("builds the tenant from settings, branding and active users", async () => {
    const c = client((call) => {
      if (call.url.includes("/tenants/settings"))
        return {
          body: {
            friendly_name: "Acme",
            support_email: "help@acme.dev",
            enabled_locales: ["en", "de"],
          },
        };
      if (call.url.includes("/branding"))
        return { body: { colors: { primary: "#0059d6" }, logo_url: "https://acme.dev/logo.png" } };
      return { body: 1234 };
    });
    const [tenant] = await c.listResources("tenant", ACCOUNT);
    expect(tenant).toMatchObject({
      externalId: DOMAIN,
      displayName: "Acme",
      fields: {
        region: "eu",
        enabledLocales: "en, de",
        brandPrimaryColor: "#0059d6",
        activeUsers: 1234,
      },
      resolvedOutputs: { issuer: `https://${DOMAIN}/` },
    });
  });

  it("maps custom domains with their CNAME target and verification records", async () => {
    const c = client(() => ({
      body: [
        {
          custom_domain_id: "cd_1",
          domain: "login.acme.dev",
          status: "pending_verification",
          type: "auth0_managed_certs",
          primary: false,
          origin_domain_name: "acme-cd-xyz.edge.tenants.auth0.com",
          verification: {
            methods: [
              {
                name: "cname",
                record: "acme-cd-xyz.edge.tenants.auth0.com",
                domain: "login.acme.dev",
              },
            ],
          },
        },
      ],
    }));
    const [domain] = await c.listResources("custom-domain", ACCOUNT);
    expect(domain!.fields).toMatchObject({
      originDomainName: "acme-cd-xyz.edge.tenants.auth0.com",
      status: "pending_verification",
    });
    expect(c.renderSidebarItem(domain!).status?.status).toBe("provisioning");
  });
});

describe("mutations", () => {
  it("appends an action to its trigger's flow, keeping existing bindings", async () => {
    const c = client((call) => {
      if (call.url.endsWith("/actions/actions/act-2")) {
        return {
          body: {
            id: "act-2",
            name: "tag-users",
            supported_triggers: [{ id: "post-login", version: "v3" }],
          },
        };
      }
      if (call.method === "GET" && call.url.includes("/bindings")) {
        return {
          body: { bindings: [{ id: "b-1", display_name: "existing", action: { id: "act-1" } }] },
        };
      }
      return { body: {} };
    });
    await c.invokeAction("action", `${ACCOUNT}:action:act-2`, "bind");
    const patch = apiCalls().find((x) => x.method === "PATCH")!;
    expect(patch.url).toBe(`https://${DOMAIN}/api/v2/actions/triggers/post-login/bindings`);
    expect(JSON.parse(patch.body!)).toEqual({
      bindings: [
        { ref: { type: "binding_id", value: "b-1" }, display_name: "existing" },
        { ref: { type: "action_id", value: "act-2" }, display_name: "tag-users" },
      ],
    });
  });

  it("splits identifier|scope permission ids for role grants", async () => {
    const c = client(() => ({ body: {} }));
    await c.executeNoSqlCommand("role", `${ACCOUNT}:role:rol_1`, ACCOUNT, "add-permissions", [
      JSON.stringify({ permissions: JSON.stringify(["https://api.acme.dev|read:invoices"]) }),
    ]);
    expect(JSON.parse(apiCalls()[0]!.body!)).toEqual({
      permissions: [
        { resource_server_identifier: "https://api.acme.dev", permission_name: "read:invoices" },
      ],
    });
  });

  it("reads the client secret only on demand", async () => {
    const c = client(() => ({ body: { client_secret: "s3cret" } }));
    await expect(
      c.resolveOutput("application", `${ACCOUNT}:application:cid1`, "clientSecret", ACCOUNT),
    ).resolves.toBe("s3cret");
    expect(new URL(apiCalls()[0]!.url).searchParams.get("fields")).toBe("client_secret");
  });

  it("reports rate-limit headroom as a quota", async () => {
    const c = client(() => ({
      body: 10,
      headers: { "x-ratelimit-limit": "50", "x-ratelimit-remaining": "48" },
    }));
    const [quota] = await c.fetchQuotas(ACCOUNT);
    expect(quota).toMatchObject({ limit: 50, used: 2 });
  });
});

describe("status feed", () => {
  it("keeps entries whose newest update is not resolved", () => {
    const body = `<feed xmlns="http://www.w3.org/2005/Atom">
<entry><title type="html"><![CDATA[Elevated errors]]></title><id>a1</id><link href="https://status.auth0.com/incidents/a1"/><updated>2026-09-01T16:08:00Z</updated>
<content type="html"><![CDATA[<p><small>Sep 1</small><br><strong>Resolved</strong> - Fixed.</p><p><small>Sep 1</small><br><strong>Investigating</strong> - Looking.</p>]]></content></entry>
<entry><title type="html"><![CDATA[Login latency]]></title><id>b2</id><link href="https://status.auth0.com/incidents/b2"/><updated>2026-10-06T10:00:00Z</updated>
<content type="html"><![CDATA[<p><small>Oct 6</small><br><strong>Monitoring</strong> - A fix is in place.</p>]]></content></entry>
</feed>`;
    const incidents = parseStatusFeed(body);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      externalId: "b2",
      state: "monitoring",
      regions: ["us"],
      lastUpdateText: "A fix is in place.",
    });
  });
});

describe("terraform", () => {
  it("exports an action with its code from a variable", () => {
    const out = auth0TerraformExport.mapResource({
      id: "a:action:act-1",
      pluginId: "auth0",
      resourceTypeId: "action",
      accountId: "a",
      displayName: "Tag users",
      externalId: "act-1",
      fields: { name: "Tag users", trigger: "post-login@v3", runtime: "node22" },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    });
    expect(out?.resource.type).toBe("auth0_action");
    expect(out?.resource.attributes["code"]).toEqual({
      kind: "ref",
      expr: "var.auth0_action_tag_users_code",
    });
    expect(out?.resource.attributes["supported_triggers"]).toEqual({
      kind: "block",
      attributes: {
        id: { kind: "string", value: "post-login" },
        version: { kind: "string", value: "v3" },
      },
    });
  });
});
