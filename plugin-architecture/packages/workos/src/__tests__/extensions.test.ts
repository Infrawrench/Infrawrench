import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkosClient } from "../client.js";
import { plugin } from "../plugin.js";

const ACCOUNT = "acct-1";
const ORG = "org_01ACME";

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** Route `METHOD /path` (query ignored unless the key includes it) to JSON bodies. */
function routed(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url: url.pathname + url.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const body =
      routes[`${method} ${url.pathname}${url.search}`] ?? routes[`${method} ${url.pathname}`];
    const status = body === undefined ? 404 : 200;
    const text = body === undefined ? '{"message":"not found"}' : JSON.stringify(body);
    return {
      ok: status === 200,
      status,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => JSON.parse(text),
      text: async () => text,
    } as unknown as Response;
  }) as unknown as typeof fetch);
  const sent = (method: string, path: string) =>
    calls.filter((c) => c.method === method && c.url.split("?")[0] === path);
  return { calls, sent, client: new WorkosClient({ apiKey: "sk_test_key" }) };
}

const list = (data: unknown[]) => ({ object: "list", data, list_metadata: { after: null } });

afterEach(() => vi.restoreAllMocks());

describe("registry", () => {
  it("registers the new types", () => {
    const ids = plugin.resourceTypes.map((t) => t.id);
    for (const id of [
      "organization-domain",
      "organization-role",
      "permission",
      "organization-api-key",
      "feature-flag",
      "group",
    ]) {
      expect(ids).toContain(id);
    }
  });
});

describe("organization domains", () => {
  it("lists domains from organizations with their TXT record", async () => {
    const { client } = routed({
      "GET /organizations": list([
        {
          id: ORG,
          name: "Acme",
          domains: [
            {
              id: "org_domain_1",
              domain: "acme.com",
              state: "pending",
              verification_strategy: "dns",
              verification_prefix: "_workos-challenge",
              verification_token: "tok123",
            },
          ],
        },
      ]),
    });
    const [domain] = await client.listResources("organization-domain", ACCOUNT);
    expect(domain).toMatchObject({
      id: `${ACCOUNT}:organization-domain:org_domain_1`,
      parentResourceId: `${ACCOUNT}:organization:${ORG}`,
      fields: {
        domain: "acme.com",
        txtRecordName: "_workos-challenge.acme.com",
        txtRecordValue: "tok123",
        organizationId: ORG,
      },
    });
    const detail = client.renderDetail(domain!);
    expect(JSON.stringify(detail)).toContain("_workos-challenge.acme.com");
  });

  it("creates under the parent organization and verifies", async () => {
    const { client, sent } = routed({
      "POST /organization_domains": { id: "org_domain_2", domain: "acme.io", organization_id: ORG },
      "POST /organization_domains/org_domain_2/verify": { id: "org_domain_2", state: "verified" },
    });
    await client.createResource(
      "organization-domain",
      ACCOUNT,
      { domain: " Acme.IO " },
      `${ACCOUNT}:organization:${ORG}`,
    );
    expect(sent("POST", "/organization_domains")[0]!.body).toEqual({
      domain: "acme.io",
      organization_id: ORG,
    });
    await client.invokeAction(
      "organization-domain",
      `${ACCOUNT}:organization-domain:org_domain_2`,
      "verify",
      ACCOUNT,
    );
    expect(sent("POST", "/organization_domains/org_domain_2/verify")).toHaveLength(1);
  });
});

describe("organization roles", () => {
  it("lists only custom roles, keyed by organization and slug", async () => {
    const { client } = routed({
      "GET /organizations": list([{ id: ORG, name: "Acme" }]),
      [`GET /authorization/organizations/${ORG}/roles`]: list([
        { slug: "admin", name: "Admin", type: "EnvironmentRole" },
        { slug: "org-billing", name: "Billing", type: "OrganizationRole", permissions: ["*"] },
      ]),
    });
    const roles = await client.listResources("organization-role", ACCOUNT);
    expect(roles.map((r) => r.id)).toEqual([`${ACCOUNT}:organization-role:${ORG}/org-billing`]);
  });

  it("rejects a slug without the org- prefix and sets permissions after create", async () => {
    const { client, sent } = routed({
      [`POST /authorization/organizations/${ORG}/roles`]: { slug: "org-ops", name: "Ops" },
      [`PUT /authorization/organizations/${ORG}/roles/org-ops/permissions`]: {
        slug: "org-ops",
        name: "Ops",
        permissions: ["deploys:run"],
      },
    });
    const parent = `${ACCOUNT}:organization:${ORG}`;
    await expect(
      client.createResource("organization-role", ACCOUNT, { name: "Ops", slug: "ops" }, parent),
    ).rejects.toThrow("org-");
    const role = await client.createResource(
      "organization-role",
      ACCOUNT,
      { name: "Ops", permissions: '["deploys:run"]' },
      parent,
    );
    expect(
      sent("PUT", `/authorization/organizations/${ORG}/roles/org-ops/permissions`)[0]!.body,
    ).toEqual({
      permissions: ["deploys:run"],
    });
    expect(role.fields["permissions"]).toBe("deploys:run");
  });

  it("deletes through the organization-scoped route", async () => {
    const { client, sent } = routed({
      [`DELETE /authorization/organizations/${ORG}/roles/org-ops`]: {},
    });
    await client.deleteResource(
      "organization-role",
      `${ACCOUNT}:organization-role:${ORG}/org-ops`,
      ACCOUNT,
    );
    expect(sent("DELETE", `/authorization/organizations/${ORG}/roles/org-ops`)).toHaveLength(1);
  });

  it("replaces an environment role's permissions from the prompt", async () => {
    const { client, sent } = routed({
      "PUT /authorization/roles/editor/permissions": { slug: "editor", permissions: ["a", "b"] },
    });
    await client.executeNoSqlCommand("role", `${ACCOUNT}:role:editor`, ACCOUNT, "set-permissions", [
      JSON.stringify({ permissions: '["a","b"]' }),
    ]);
    expect(sent("PUT", "/authorization/roles/editor/permissions")[0]!.body).toEqual({
      permissions: ["a", "b"],
    });
  });
});

describe("permissions", () => {
  it("validates the slug before creating", async () => {
    const { client, sent } = routed({
      "POST /authorization/permissions": { slug: "invoices:read", name: "Read invoices" },
    });
    await expect(
      client.createResource("permission", ACCOUNT, { slug: "Invoices Read", name: "x" }),
    ).rejects.toThrow("lowercase");
    await client.createResource("permission", ACCOUNT, {
      slug: "invoices:read",
      name: "Read invoices",
    });
    expect(sent("POST", "/authorization/permissions")[0]!.body).toEqual({
      slug: "invoices:read",
      name: "Read invoices",
    });
  });
});

describe("organization API keys", () => {
  it("creates with permissions and keeps the one-time value as an output", async () => {
    const { client, sent } = routed({
      [`POST /organizations/${ORG}/api_keys`]: {
        id: "api_key_1",
        name: "CI",
        obfuscated_value: "sk_…abcd",
        value: "sk_full_secret",
        permissions: ["deploys:run"],
      },
    });
    const key = await client.createResource(
      "organization-api-key",
      ACCOUNT,
      { name: "CI", permissions: '["deploys:run"]', expiresAt: "2999-01-01T00:00:00Z" },
      `${ACCOUNT}:organization:${ORG}`,
    );
    expect(sent("POST", `/organizations/${ORG}/api_keys`)[0]!.body).toEqual({
      name: "CI",
      permissions: ["deploys:run"],
      expires_at: "2999-01-01T00:00:00.000Z",
    });
    expect(key.id).toBe(`${ACCOUNT}:organization-api-key:${ORG}/api_key_1`);
    expect(key.resolvedOutputs["apiKey"]).toBe("sk_full_secret");
  });

  it("refuses an expiry in the past", async () => {
    const { client } = routed({});
    await expect(
      client.createResource(
        "organization-api-key",
        ACCOUNT,
        { name: "CI", expiresAt: "2000-01-01T00:00:00Z" },
        `${ACCOUNT}:organization:${ORG}`,
      ),
    ).rejects.toThrow("future");
  });

  it("expires and deletes by key id", async () => {
    const { client, sent } = routed({
      "POST /api_keys/api_key_1/expire": { id: "api_key_1" },
      "DELETE /api_keys/api_key_1": {},
    });
    const id = `${ACCOUNT}:organization-api-key:${ORG}/api_key_1`;
    await client.invokeAction("organization-api-key", id, "expire", ACCOUNT);
    await client.deleteResource("organization-api-key", id, ACCOUNT);
    expect(sent("POST", "/api_keys/api_key_1/expire")[0]!.body).toEqual({});
    expect(sent("DELETE", "/api_keys/api_key_1")).toHaveLength(1);
  });
});

describe("feature flags", () => {
  it("toggles through enable/disable and targets organizations", async () => {
    const { client, sent } = routed({
      "PUT /feature-flags/new-nav/disable": { slug: "new-nav", enabled: false },
      "POST /feature-flags/new-nav/targets/org_01ACME": {},
    });
    const flag = await client.updateResource(
      "feature-flag",
      `${ACCOUNT}:feature-flag:new-nav`,
      ACCOUNT,
      {
        enabled: "false",
      },
    );
    expect(flag.fields["enabled"]).toBe(false);
    await client.executeNoSqlCommand(
      "feature-flag",
      `${ACCOUNT}:feature-flag:new-nav`,
      ACCOUNT,
      "add-target",
      [JSON.stringify({ target: ORG })],
    );
    expect(sent("PUT", "/feature-flags/new-nav/disable")).toHaveLength(1);
    expect(sent("POST", `/feature-flags/new-nav/targets/${ORG}`)).toHaveLength(1);
    await expect(
      client.executeNoSqlCommand(
        "feature-flag",
        `${ACCOUNT}:feature-flag:new-nav`,
        ACCOUNT,
        "add-target",
        [JSON.stringify({ target: "../../organizations" })],
      ),
    ).rejects.toThrow("organization or user");
  });
});

describe("groups", () => {
  it("adds a membership to a group", async () => {
    const { client, sent } = routed({
      [`POST /organizations/${ORG}/groups/group_1/organization-memberships`]: { id: "group_1" },
    });
    await client.executeNoSqlCommand(
      "group",
      `${ACCOUNT}:group:${ORG}/group_1`,
      ACCOUNT,
      "add-member",
      [JSON.stringify({ membershipId: "om_1" })],
    );
    expect(
      sent("POST", `/organizations/${ORG}/groups/group_1/organization-memberships`)[0]!.body,
    ).toEqual({ organization_membership_id: "om_1" });
  });
});

describe("organizations", () => {
  it("mints an Admin Portal link for the chosen intent", async () => {
    const { client, sent } = routed({
      "POST /portal/generate_link": { link: "https://setup.workos.com/portal/launch?secret=x" },
    });
    const exported = await client.exportCredential(
      "organization",
      `${ACCOUNT}:organization:${ORG}`,
      ACCOUNT,
      "portal-sso",
    );
    expect(sent("POST", "/portal/generate_link")[0]!.body).toEqual({
      organization: ORG,
      intent: "sso",
    });
    expect(exported.content).toBe("https://setup.workos.com/portal/launch?secret=x");
  });

  it("reads organization events with the required repeated events filter", async () => {
    const { client, calls } = routed({
      "GET /events": list([
        {
          id: "event_2",
          event: "organization_membership.created",
          data: { id: "om_1" },
          created_at: "2026-09-02T00:00:00Z",
        },
        {
          id: "event_1",
          event: "invitation.created",
          data: { email: "amy@acme.com" },
          created_at: "2026-09-01T00:00:00Z",
          context: { actor: { id: "user_1", source: "dashboard", name: "Amy" } },
        },
      ]),
    });
    const logs = await client.getLogs("organization", `${ACCOUNT}:organization:${ORG}`, ACCOUNT, {
      tailLines: 50,
    });
    const url = new URL(`https://api.workos.com${calls[0]!.url}`);
    expect(url.searchParams.get("organization_id")).toBe(ORG);
    expect(url.searchParams.getAll("events")).toContain("invitation.created");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(logs.text.split("\n")[0]).toBe(
      "2026-09-01T00:00:00Z invitation.created amy@acme.com by Amy (dashboard)",
    );
  });

  it("clears the external id with null", async () => {
    const { client, sent } = routed({ [`PUT /organizations/${ORG}`]: { id: ORG, name: "Acme" } });
    await client.updateResource("organization", `${ACCOUNT}:organization:${ORG}`, ACCOUNT, {
      name: "Acme",
      externalId: "",
    });
    expect(sent("PUT", `/organizations/${ORG}`)[0]!.body).toEqual({
      name: "Acme",
      external_id: null,
    });
  });
});

describe("users and directories", () => {
  it("revokes only active sessions", async () => {
    const { client, sent } = routed({
      "GET /user_management/users/user_1/sessions": list([
        { id: "session_a", status: "active" },
        { id: "session_b", status: "revoked" },
      ]),
      "POST /user_management/sessions/revoke": {},
    });
    await client.invokeAction("user", `${ACCOUNT}:user:user_1`, "revoke-sessions", ACCOUNT);
    expect(sent("POST", "/user_management/sessions/revoke").map((c) => c.body)).toEqual([
      { session_id: "session_a" },
    ]);
  });

  it("queues a directory sync and reports synced counts", async () => {
    const { client, sent } = routed({
      "POST /directories/directory_1/sync": { status: "queued" },
      "GET /directories/directory_1": {
        id: "directory_1",
        metadata: { users: { active: 40, inactive: 2 }, groups: 7 },
      },
    });
    await client.invokeAction("directory", `${ACCOUNT}:directory:directory_1`, "sync", ACCOUNT);
    expect(sent("POST", "/directories/directory_1/sync")).toHaveLength(1);
    const stats = await client.fetchDashboardStats(
      "directory",
      `${ACCOUNT}:directory:directory_1`,
      ACCOUNT,
    );
    expect(stats).toEqual([
      { label: "Active Users", value: "40" },
      { label: "Inactive Users", value: "2" },
      { label: "Synced Groups", value: "7" },
    ]);
  });

  it("rejects unknown webhook events on edit", async () => {
    const { client } = routed({});
    await expect(
      client.updateResource("webhook-endpoint", `${ACCOUNT}:webhook-endpoint:we_1`, ACCOUNT, {
        events: "user.created, user.exploded",
      }),
    ).rejects.toThrow("user.exploded");
  });
});
