import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkosClient } from "../client.js";

const ACCOUNT = "acct-1";
const ORG = "org_01HXYZ";
const ORG2 = "org_02ABCD";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

let calls: FetchCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function installFetch(handler: (url: string, init?: RequestInit) => Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((async (
    url: string,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(url), ...(init !== undefined && { init }) });
    return handler(String(url), init);
  }) as unknown as typeof fetch);
}

function client() {
  return new WorkosClient({ apiKey: "sk_test_key" });
}

function list(data: unknown[], after: string | null = null) {
  return { object: "list", data, list_metadata: { before: null, after } };
}

const ORG_LIST = list([
  {
    id: ORG,
    name: "Acme",
    domains: [{ domain: "acme.com", state: "verified" }],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
  },
  { id: ORG2, name: "Globex", domains: [], created_at: "2026-02-01T00:00:00.000Z" },
]);

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("constructor", () => {
  it("requires an apiKey", () => {
    expect(() => new WorkosClient({})).toThrow(/apiKey/);
  });
});

describe("listing", () => {
  it("lists organizations with Bearer auth", async () => {
    installFetch(() => jsonResponse(ORG_LIST));
    const resources = await client().listResources("organization", ACCOUNT);

    expect(resources).toHaveLength(2);
    expect(resources[0]).toMatchObject({
      id: `${ACCOUNT}:organization:${ORG}`,
      pluginId: "workos",
      resourceTypeId: "organization",
      displayName: "Acme",
      externalId: ORG,
      fields: { name: "Acme", organizationId: ORG, domains: "acme.com" },
    });
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk_test_key");
    expect(calls[0]!.url).toContain("https://api.workos.com/organizations?");
  });

  it("follows the after cursor across pages", async () => {
    let page = 0;
    installFetch(() => {
      page++;
      if (page === 1) return jsonResponse(list([{ id: "user_1", email: "a@acme.com" }], "cur"));
      return jsonResponse(list([{ id: "user_2", email: "b@acme.com" }]));
    });
    const users = await client().listResources("user", ACCOUNT);
    expect(users.map((u) => u.externalId)).toEqual(["user_1", "user_2"]);
    expect(calls[1]!.url).toContain("after=cur");
  });

  it("fans memberships out per organization and labels them with user emails", async () => {
    installFetch((url) => {
      if (url.includes("/user_management/users")) {
        return jsonResponse(list([{ id: "user_1", email: "jo@acme.com" }]));
      }
      if (url.includes("/user_management/organization_memberships")) {
        if (url.includes(`organization_id=${ORG}`)) {
          return jsonResponse(
            list([
              {
                id: "om_1",
                user_id: "user_1",
                organization_id: ORG,
                role: { slug: "admin" },
                status: "active",
              },
            ]),
          );
        }
        // The second org's key has no access — a per-org failure must not
        // empty the whole listing.
        return jsonResponse({ message: "forbidden" }, 403);
      }
      return jsonResponse(ORG_LIST);
    });

    const memberships = await client().listResources("organization-membership", ACCOUNT);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({
      displayName: "jo@acme.com",
      parentResourceId: `${ACCOUNT}:organization:${ORG}`,
      fields: { role: "admin", status: "active", userEmail: "jo@acme.com" },
    });
  });

  it("lists roles from the authorization API keyed by slug", async () => {
    installFetch(() =>
      jsonResponse({
        object: "list",
        data: [
          {
            id: "role_1",
            slug: "admin",
            name: "Admin",
            type: "EnvironmentRole",
            permissions: ["posts:read"],
          },
        ],
      }),
    );
    const roles = await client().listResources("role", ACCOUNT);
    expect(roles[0]).toMatchObject({
      id: `${ACCOUNT}:role:admin`,
      externalId: "admin",
      fields: { slug: "admin", permissions: "posts:read" },
    });
  });

  it("exposes the webhook signing secret as a resolved output", async () => {
    installFetch(() =>
      jsonResponse(
        list([
          {
            id: "we_1",
            endpoint_url: "https://example.com/hooks",
            secret: "whsec_abc",
            status: "enabled",
            events: ["user.created"],
          },
        ]),
      ),
    );
    const endpoints = await client().listResources("webhook-endpoint", ACCOUNT);
    expect(endpoints[0]!.displayName).toBe("example.com");
    expect(endpoints[0]!.resolvedOutputs["signingSecret"]).toBe("whsec_abc");
  });
});

describe("create", () => {
  it("creates an invitation scoped to the parent organization", async () => {
    installFetch(() =>
      jsonResponse({
        id: "invitation_1",
        email: "new@acme.com",
        state: "pending",
        organization_id: ORG,
        expires_at: "2026-08-12T00:00:00.000Z",
      }),
    );
    const invitation = await client().createResource(
      "invitation",
      ACCOUNT,
      { email: "new@acme.com", roleSlug: "member", expiresInDays: "5" },
      `${ACCOUNT}:organization:${ORG}`,
    );

    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body).toEqual({
      email: "new@acme.com",
      organization_id: ORG,
      role_slug: "member",
      expires_in_days: 5,
    });
    expect(invitation).toMatchObject({
      resourceTypeId: "invitation",
      parentResourceId: `${ACCOUNT}:organization:${ORG}`,
    });
  });

  it("submits organization domains as pending domain_data", async () => {
    installFetch(() => jsonResponse({ id: ORG, name: "Acme", domains: [] }));
    await client().createResource("organization", ACCOUNT, {
      name: "Acme",
      domains: "acme.com, acme.dev",
    });
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.domain_data).toEqual([
      { domain: "acme.com", state: "pending" },
      { domain: "acme.dev", state: "pending" },
    ]);
  });
});

describe("delete and actions", () => {
  it("revokes instead of deleting invitations", async () => {
    installFetch(() => jsonResponse({ id: "invitation_1", state: "revoked" }));
    await client().deleteResource("invitation", `${ACCOUNT}:invitation:invitation_1`, ACCOUNT);
    expect(calls[0]!.url).toBe(
      "https://api.workos.com/user_management/invitations/invitation_1/revoke",
    );
    expect(calls[0]!.init?.method).toBe("POST");
  });

  it("deactivates a membership via PUT", async () => {
    installFetch(() => jsonResponse({ id: "om_1", status: "inactive" }));
    await client().invokeAction(
      "organization-membership",
      `${ACCOUNT}:organization-membership:om_1`,
      "deactivate",
      ACCOUNT,
    );
    expect(calls[0]!.url).toBe(
      "https://api.workos.com/user_management/organization_memberships/om_1/deactivate",
    );
    expect(calls[0]!.init?.method).toBe("PUT");
  });

  it("rejects unknown actions", async () => {
    installFetch(() => jsonResponse({}));
    await expect(
      client().invokeAction("role", `${ACCOUNT}:role:admin`, "explode", ACCOUNT),
    ).rejects.toThrow(/unknown action/);
  });
});

describe("update", () => {
  it("updates a membership role via role_slug", async () => {
    installFetch((url) => {
      if (url.includes("/users/")) return jsonResponse({ id: "user_1", email: "jo@acme.com" });
      return jsonResponse({
        id: "om_1",
        user_id: "user_1",
        organization_id: ORG,
        role: { slug: "member" },
        status: "active",
      });
    });
    const updated = await client().updateResource(
      "organization-membership",
      `${ACCOUNT}:organization-membership:om_1`,
      ACCOUNT,
      { role: "member" },
    );
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body).toEqual({ role_slug: "member" });
    expect(updated.fields["role"]).toBe("member");
  });
});

describe("create config", () => {
  it("omits the organization picker when launched from a parent org", async () => {
    installFetch((url) => {
      if (url.includes("/authorization/organizations/")) {
        return jsonResponse({ data: [{ slug: "admin", name: "Admin" }] });
      }
      return jsonResponse(ORG_LIST);
    });
    const config = await client().getCreateConfig("invitation", `${ACCOUNT}:organization:${ORG}`);
    const keys = config.fields.map((field) => field.key);
    expect(keys).not.toContain("organizationId");
    const role = config.fields.find((field) => field.key === "roleSlug");
    expect(role?.kind).toBe("select");
    expect(role?.options).toEqual([{ id: "admin", label: "Admin" }]);
  });

  it("includes a live organization picker otherwise", async () => {
    installFetch((url) => {
      if (url.includes("/authorization/roles")) return jsonResponse({ data: [] });
      return jsonResponse(ORG_LIST);
    });
    const config = await client().getCreateConfig("organization-membership");
    const orgField = config.fields.find((field) => field.key === "organizationId");
    expect(orgField?.kind).toBe("select");
    expect(orgField?.options).toEqual([
      { id: ORG, label: "Acme" },
      { id: ORG2, label: "Globex" },
    ]);
  });
});
