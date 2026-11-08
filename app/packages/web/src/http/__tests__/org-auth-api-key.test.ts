/**
 * `iwk_` API keys on the org route tree.
 *
 * Each `describe` below pins one of the five properties the widening had to
 * hold. They are written against a domain served the way `api/index.ts`
 * serves the real ones (`OrgAuth` as the server provides it, the real
 * `RequiredPermission` gate, real `effectivePermissions` and a real
 * `intersectPermissions`); only the things that talk to Postgres or WorkOS
 * (`authenticateApiRequest`, `resolveEffectivePermissions`, cost visibility
 * and sharing resolution) and the `db` handle are stubbed. Mocking the
 * intersection would have made the headline property untestable.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Effect, Schema } from "effect";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { AVAILABLE_SCOPES } from "@infrawrench/ui/settings/api-key-scopes";

process.env["DATABASE_URL"] = "postgres://localhost/test";
process.env["WORKOS_API_KEY"] = "test_workos_api_key";
process.env["WORKOS_CLIENT_ID"] = "test_workos_client_id";
process.env["WORKOS_COOKIE_PASSWORD"] = "x".repeat(40);

// ---------------------------------------------------------------- db stub --

/** Rows the next `select(...)` chain resolves to, in order. */
const selectQueue: unknown[][] = [];
/** Everything `insert(...).values(...)` was handed, in order. */
const inserted: Array<Record<string, unknown>> = [];

function thenableRows(rows: unknown[]) {
  const p = Promise.resolve(rows) as Promise<unknown[]> & {
    limit: (n?: number) => Promise<unknown[]>;
    leftJoin: () => typeof p;
    orderBy: () => typeof p;
  };
  p.limit = () => Promise.resolve(rows);
  p.leftJoin = () => p;
  p.orderBy = () => p;
  return p;
}

const mockSelect = vi.fn(() => ({
  from: () => ({
    where: () => thenableRows(selectQueue.shift() ?? []),
    leftJoin: () => ({ where: () => thenableRows(selectQueue.shift() ?? []) }),
    innerJoin: () => ({ where: () => thenableRows(selectQueue.shift() ?? []) }),
  }),
}));

const mockInsert = vi.fn(() => ({
  values: (v: Record<string, unknown>) => {
    inserted.push(v);
    const p = Promise.resolve(undefined) as Promise<undefined> & {
      onConflictDoNothing: () => Promise<undefined>;
      onConflictDoUpdate: () => Promise<undefined>;
    };
    p.onConflictDoNothing = () => Promise.resolve(undefined);
    p.onConflictDoUpdate = () => Promise.resolve(undefined);
    return p;
  },
}));

vi.mock("@/db/client", () => ({
  db: { select: (...a: unknown[]) => mockSelect(...(a as [])), insert: () => mockInsert() },
}));

// "Not an agent" by default, so these cases keep exercising the human path.
// Mocked rather than left real because the module reaches Postgres at import.
vi.mock("@infrawrench/server-core/trials/ceremony", () => ({
  resolveAgentCredential: vi.fn(async () => null),
  getClaimStatus: vi.fn(async () => null),
}));

vi.mock("@infrawrench/server-core/trials/principal", () => ({
  resolveAgentPrincipal: vi.fn(async () => null),
  touchAgentRegistration: vi.fn(async () => undefined),
}));

vi.mock("@/db/schema", () => ({
  users: { id: "id", email: "email", displayName: "display_name" },
  organizationMembers: { id: "id", userId: "user_id", organizationId: "organization_id" },
  organizations: { id: "id", displayName: "display_name" },
  auditLogs: { id: "id" },
  apiKeys: { id: "id", name: "name", prefix: "prefix" },
}));

// ------------------------------------------------------------ auth stubs --

const mockAuthenticateApiRequest = vi.fn();
const mockVerifyWorkosAccessToken = vi.fn();
vi.mock("@/auth/api-auth", () => ({
  authenticateApiRequest: (...a: unknown[]) => mockAuthenticateApiRequest(...a),
  verifyWorkosAccessToken: (...a: unknown[]) => mockVerifyWorkosAccessToken(...a),
}));

const mockLoadSealedSession = vi.fn();
vi.mock("@/auth/workos", () => ({
  workos: {
    userManagement: {
      loadSealedSession: (...a: unknown[]) => mockLoadSealedSession(...a),
      getUser: vi.fn(),
    },
  },
  clientId: "client-1",
}));

/**
 * Only the DB-backed role lookup is stubbed. `effectivePermissions` (and the
 * `intersectPermissions` inside it) run for real, which is the point.
 */
const mockResolveEffectivePermissions = vi.fn();
vi.mock("@infrawrench/server-core/permissions", () => ({
  resolveEffectivePermissions: (...a: unknown[]) => mockResolveEffectivePermissions(...a),
}));

// `OrgAuth` also resolves the caller's cost visibility and sharing principal;
// neither is under test here, and both would read Postgres.
vi.mock("@infrawrench/server-core/cost/visibility", () => ({
  resolveCostVisibility: async (organizationId: string) => ({ organizationId, restricted: false }),
}));
vi.mock("@/services/object-sharing", () => ({
  resolveSharingPrincipal: async (organizationId: string, userId: string) => ({
    organizationId,
    userId,
    roleId: null,
    override: false,
  }),
  runWithSharingPrincipal: (_principal: unknown, fn: () => unknown) => fn(),
}));

const { RequiredPermission } = await import("@/http/annotations");
const { makeDomain, withApiDefaults } = await import("@/http/domain");
const { legacy } = await import("@/http/legacy");
const { OrgAuth } = await import("@/http/middleware-tags");
const { MiddlewareLive } = await import("@/http/middleware-live");
const { OrgPrincipal } = await import("@/http/principal");
const { makeHttpApiHandler } = await import("@/http/server");
const { logAudit } = await import("@/services/audit");

// ------------------------------------------------------------------- app --

const KEY_ID = "11111111-1111-4111-8111-111111111111";
const OWNER = "user_owner";
const ORG = "org_home";

/** Records what each handler saw as its principal, so tests can assert on it. */
let seen: Record<string, unknown> = {};

const Params = { orgId: Schema.String } as const;

const Group = HttpApiGroup.make("orgTree")
  .add(
    HttpApiEndpoint.get("readCosts", "/costs", {
      params: Params,
      success: Schema.Struct({ ok: Schema.Boolean }),
    }).annotate(RequiredPermission, "costs:read"),
    HttpApiEndpoint.post("writeCosts", "/costs", {
      params: Params,
      success: Schema.Struct({ ok: Schema.Boolean }),
    }).annotate(RequiredPermission, "costs:write"),
    // Deliberately ungated, to prove the deny list (not a permission check) is
    // what closes these.
    HttpApiEndpoint.post("mintKey", "/api-keys", {
      params: Params,
      success: Schema.Struct({ minted: Schema.Boolean }),
    }),
    HttpApiEndpoint.get("team", "/team", {
      params: Params,
      success: Schema.Struct({ members: Schema.Array(Schema.String) }),
    }),
    HttpApiEndpoint.post("invite", "/team/invitations", {
      params: Params,
      success: Schema.Struct({ invited: Schema.Boolean }),
    }),
    HttpApiEndpoint.get("accessRequests", "/access-requests", {
      params: Params,
      success: Schema.Struct({ queue: Schema.Array(Schema.String) }),
    }),
    HttpApiEndpoint.post("approve", "/access-requests/:id/approve", {
      params: { ...Params, id: Schema.String },
      success: Schema.Struct({ approved: Schema.Boolean }),
    }),
    HttpApiEndpoint.get("billing", "/billing", {
      params: Params,
      success: Schema.Struct({ plan: Schema.String }),
    }),
    HttpApiEndpoint.put("pushPreferences", "/push/preferences", {
      params: Params,
      success: Schema.Struct({ saved: Schema.Boolean }),
    }),
    // Writes an audit row the way a real handler does: actor only, no key id.
    HttpApiEndpoint.post("createAccount", "/accounts", {
      params: Params,
      success: Schema.Struct({ ok: Schema.Boolean }),
    }).annotate(RequiredPermission, "accounts:write"),
  )
  .prefix("/api/org/:orgId")
  .middleware(OrgAuth);

class OrgTreeApi extends withApiDefaults(HttpApi.make("orgTree").add(Group)) {}

const snapshot = Effect.gen(function* () {
  const principal = yield* OrgPrincipal;
  seen = {
    apiKey: principal.apiKey,
    session: principal.session,
    organizationId: principal.organizationId,
    permissions: principal.permissions,
    role: principal.role,
    elevations: principal.elevations,
  };
});

const domain = makeDomain(
  "org-tree",
  OrgTreeApi,
  HttpApiBuilder.group(OrgTreeApi, "orgTree", (h) =>
    h
      .handle("readCosts", () => snapshot.pipe(Effect.as({ ok: true })))
      .handle("writeCosts", () => snapshot.pipe(Effect.as({ ok: true })))
      .handle("mintKey", () => Effect.succeed({ minted: true }))
      .handle("team", () => Effect.succeed({ members: [] }))
      .handle("invite", () => Effect.succeed({ invited: true }))
      .handle("accessRequests", () => Effect.succeed({ queue: [] }))
      .handle("approve", () => Effect.succeed({ approved: true }))
      .handle("billing", () => Effect.succeed({ plan: "pro" }))
      .handle("pushPreferences", () => Effect.succeed({ saved: true }))
      .handle("createAccount", () =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          yield* legacy(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "account.create",
              entityType: "account",
              entityId: "acc-1",
            }),
          );
          return { ok: true };
        }),
      ),
  ),
);

function buildApp() {
  const handler = makeHttpApiHandler([domain], MiddlewareLive);
  return {
    request: (path: string, init?: RequestInit) =>
      handler.handle(new Request(`http://localhost${path}`, init)),
  };
}

/** The key authenticates; `roleGrants` is what its owner's role holds today. */
function keyAuthenticates(scopes: string[], roleGrants: string[], organizationId = ORG) {
  mockAuthenticateApiRequest.mockResolvedValue({
    userId: OWNER,
    organizationId,
    apiKeyId: KEY_ID,
    scopes,
  });
  selectQueue.push([{ email: "owner@example.com" }]); // the owner's users row
  mockResolveEffectivePermissions.mockResolvedValue({
    permissions: roleGrants,
    role: { id: "r1", name: "Admin", isSystem: true, systemKey: "admin", permissions: roleGrants },
    elevations: [],
  });
}

/** A signed-in person with the same role, for side-by-side comparisons. */
function sessionAuthenticates(roleGrants: string[]) {
  mockLoadSealedSession.mockReturnValue({
    authenticate: vi.fn().mockResolvedValue({
      authenticated: true,
      user: { id: OWNER, email: "owner@example.com" },
      sessionId: "sess_1",
    }),
  });
  selectQueue.push([{ role: "admin" }]); // orgMiddleware membership
  mockResolveEffectivePermissions.mockResolvedValue({
    permissions: roleGrants,
    role: { id: "r1", name: "Admin", isSystem: true, systemKey: "admin", permissions: roleGrants },
    elevations: [],
  });
}

const KEY_HEADERS = { authorization: "Bearer iwk_secret" };
const COOKIE_HEADERS = { cookie: "wos-session=sealed" };

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
  inserted.length = 0;
  seen = {};
});

// ---------------------------------------------------------------- 1 ------

describe("property 1 — a key's permissions are its scopes ∩ its owner's role", () => {
  it("cannot exceed the owner's role, even scoped `*`", async () => {
    keyAuthenticates(["*"], ["costs:read"]);
    const app = buildApp();
    expect((await app.request(`/api/org/${ORG}/costs`, { headers: KEY_HEADERS })).status).toBe(200);
    expect(seen["permissions"]).toEqual(["costs:read"]);

    keyAuthenticates(["*"], ["costs:read"]);
    const res = await app.request(`/api/org/${ORG}/costs`, {
      method: "POST",
      headers: KEY_HEADERS,
    });
    expect(res.status).toBe(403);
  });

  it("cannot exceed its own scopes, even under an owner scoped `*`", async () => {
    keyAuthenticates(["costs:read"], ["*"]);
    const app = buildApp();
    expect((await app.request(`/api/org/${ORG}/costs`, { headers: KEY_HEADERS })).status).toBe(200);
    expect(seen["permissions"]).toEqual(["costs:read"]);

    keyAuthenticates(["costs:read"], ["*"]);
    const res = await app.request(`/api/org/${ORG}/costs`, {
      method: "POST",
      headers: KEY_HEADERS,
    });
    expect(res.status).toBe(403);
  });

  /** The headline regression: a key must not survive its owner's demotion. */
  it("stops working the moment its owner is demoted", async () => {
    const app = buildApp();
    keyAuthenticates(["costs:read", "costs:write"], ["costs:read", "costs:write"]);
    expect(
      (await app.request(`/api/org/${ORG}/costs`, { method: "POST", headers: KEY_HEADERS })).status,
    ).toBe(200);

    // Same key, same scopes; the owner is now a read-only member.
    keyAuthenticates(["costs:read", "costs:write"], ["costs:read"]);
    expect(
      (await app.request(`/api/org/${ORG}/costs`, { method: "POST", headers: KEY_HEADERS })).status,
    ).toBe(403);
  });

  it("grants nothing at all to a key with no scopes", async () => {
    keyAuthenticates([], ["*"]);
    const res = await buildApp().request(`/api/org/${ORG}/costs`, { headers: KEY_HEADERS });
    expect(res.status).toBe(403);
  });

  /**
   * A break-glass grant is authority handed to a person for a bounded window.
   * `effectivePermissions` resolves key principals with `includeElevation:
   * false`; if that ever flipped, an expiring elevation would become permanent
   * authority on an unattended credential.
   */
  it("never folds a live break-glass elevation into a key", async () => {
    keyAuthenticates(["*"], ["costs:read"]);
    await buildApp().request(`/api/org/${ORG}/costs`, { headers: KEY_HEADERS });
    expect(mockResolveEffectivePermissions).toHaveBeenCalledWith(
      ORG,
      { kind: "user", userId: OWNER },
      { includeElevation: false },
    );
    expect(seen["elevations"]).toEqual([]);
  });
});

// ---------------------------------------------------------------- 2 ------

describe("property 2 — a key is pinned to its own org", () => {
  it("403s when presented against another org, without running the handler", async () => {
    // The key belongs to `org_home`; the URL asks for `org_other`.
    keyAuthenticates(["*"], ["*"], ORG);
    const res = await buildApp().request(`/api/org/org_other/costs`, { headers: KEY_HEADERS });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "API key belongs to a different organization" });
    expect(seen).toEqual({});
  });

  it("resolves no permissions for the org it was aimed at", async () => {
    keyAuthenticates(["*"], ["*"], ORG);
    await buildApp().request(`/api/org/org_other/costs`, { headers: KEY_HEADERS });
    expect(mockResolveEffectivePermissions).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- 3 ------

describe("property 3 — every route keeps its existing permission gate", () => {
  it("answers a key and a user identically when the permission is held", async () => {
    const app = buildApp();
    keyAuthenticates(["costs:read"], ["costs:read"]);
    const viaKey = await app.request(`/api/org/${ORG}/costs`, { headers: KEY_HEADERS });

    sessionAuthenticates(["costs:read"]);
    const viaSession = await app.request(`/api/org/${ORG}/costs`, { headers: COOKIE_HEADERS });

    expect(viaKey.status).toBe(viaSession.status);
    expect(await viaKey.json()).toEqual(await viaSession.json());
    expect(viaKey.status).toBe(200);
  });

  it("answers a key and a user identically when the permission is missing", async () => {
    const app = buildApp();
    keyAuthenticates(["costs:read"], ["costs:read"]);
    const viaKey = await app.request(`/api/org/${ORG}/costs`, {
      method: "POST",
      headers: KEY_HEADERS,
    });

    sessionAuthenticates(["costs:read"]);
    const viaSession = await app.request(`/api/org/${ORG}/costs`, {
      method: "POST",
      headers: COOKIE_HEADERS,
    });

    expect(viaKey.status).toBe(403);
    expect(viaSession.status).toBe(403);
    expect(await viaKey.text()).toBe(await viaSession.text());
  });

  it("leaves the key with no role, so owner-only guards fail closed", async () => {
    keyAuthenticates(["*"], ["*"]);
    await buildApp().request(`/api/org/${ORG}/costs`, { headers: KEY_HEADERS });
    expect(seen["role"]).toBeNull();
    expect(seen["session"]).toMatchObject({ userId: OWNER, email: "owner@example.com" });
    expect(seen["organizationId"]).toBe(ORG);
    expect(seen["apiKey"]).toEqual({ id: KEY_ID, scopes: ["*"] });
  });
});

// ------------------------------------------------------- human-only list --

describe("routes that stay human-only whatever the key holds", () => {
  const denied: Array<[string, string, RegExp]> = [
    ["POST", "/api-keys", /cannot manage API keys/],
    ["GET", "/billing", /cannot change billing/],
    ["PUT", "/push/preferences", /cannot register devices/],
    ["POST", "/team/invitations", /team membership/],
    ["POST", "/access-requests/r1/approve", /break-glass/],
  ];

  it.each(denied)("403s %s %s even for a `*` key held by an owner", async (method, path, why) => {
    keyAuthenticates(["*"], ["*"]);
    const res = await buildApp().request(`/api/org/${ORG}${path}`, {
      method,
      headers: KEY_HEADERS,
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(why);
  });

  it("still allows the reads of the partially-denied prefixes", async () => {
    const app = buildApp();
    keyAuthenticates(["*"], ["*"]);
    expect((await app.request(`/api/org/${ORG}/team`, { headers: KEY_HEADERS })).status).toBe(200);
    keyAuthenticates(["*"], ["*"]);
    expect(
      (await app.request(`/api/org/${ORG}/access-requests`, { headers: KEY_HEADERS })).status,
    ).toBe(200);
  });

  it("does not close the same routes to a signed-in person", async () => {
    sessionAuthenticates(["*"]);
    const res = await buildApp().request(`/api/org/${ORG}/api-keys`, {
      method: "POST",
      headers: COOKIE_HEADERS,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ minted: true });
  });
});

// ------------------------------------------------------------- costs -----

/**
 * The cost surface, which is the one the Terraform provider is mostly about.
 *
 * Nothing in the deny list touches it, so reachability is decided entirely by
 * the scope intersection, which means the Create API Key dialog's list is the
 * real ceiling. It used to offer eleven strings, none of them `costs:*`, so
 * every key an org could actually mint was refused here. The last case is what
 * ties the enforcement below to the thing a person clicks.
 */
describe("cost routes honour the key's scopes and nothing else", () => {
  /** Exactly what the dialog offered before the cost scopes were added. */
  const PRE_FIX_PICKER = [
    "resources:read",
    "resources:write",
    "dashboards:read",
    "dashboards:write",
    "workflows:read",
    "workflows:write",
    "workflows:approve",
    "chat:read",
    "chat:write",
  ];

  it("refuses a key holding every scope the old dialog could produce", async () => {
    const app = buildApp();
    keyAuthenticates(PRE_FIX_PICKER, ["*"]);
    expect((await app.request(`/api/org/${ORG}/costs`, { headers: KEY_HEADERS })).status).toBe(403);
    keyAuthenticates(PRE_FIX_PICKER, ["*"]);
    expect(
      (await app.request(`/api/org/${ORG}/costs`, { method: "POST", headers: KEY_HEADERS })).status,
    ).toBe(403);
  });

  it("allows exactly the cost verb the key was scoped for", async () => {
    const app = buildApp();
    keyAuthenticates(["costs:read"], ["*"]);
    expect((await app.request(`/api/org/${ORG}/costs`, { headers: KEY_HEADERS })).status).toBe(200);
    keyAuthenticates(["costs:read"], ["*"]);
    expect(
      (await app.request(`/api/org/${ORG}/costs`, { method: "POST", headers: KEY_HEADERS })).status,
    ).toBe(403);

    keyAuthenticates(["costs:read", "costs:write"], ["*"]);
    expect(
      (await app.request(`/api/org/${ORG}/costs`, { method: "POST", headers: KEY_HEADERS })).status,
    ).toBe(200);
  });

  it("is not reachable by a key that simply omitted the scope", async () => {
    keyAuthenticates(["resources:read"], ["*"]);
    const res = await buildApp().request(`/api/org/${ORG}/costs`, { headers: KEY_HEADERS });
    expect(res.status).toBe(403);
    expect(seen).toEqual({});
  });

  it("is mintable from the dialog, which is what makes the above usable", () => {
    const offered = AVAILABLE_SCOPES.map((s) => s.value);
    expect(offered).toContain("costs:read");
    expect(offered).toContain("costs:write");
  });
});

// ---------------------------------------------------------------- 4 ------

describe("property 4 — revoked, expired and orphaned keys fail closed", () => {
  /**
   * `authenticateApiRequest` returns null for all of: unknown hash, revoked
   * key, expired key, past-sunset legacy hash, and an owner with no membership
   * row. The middleware must turn every one of them into a 401 rather than
   * falling through to the session middleware.
   */
  it("401s whenever the key does not authenticate", async () => {
    mockAuthenticateApiRequest.mockResolvedValue(null);
    const res = await buildApp().request(`/api/org/${ORG}/costs`, { headers: KEY_HEADERS });
    expect(res.status).toBe(401);
    expect(seen).toEqual({});
  });

  it("401s on a result carrying no key id, rather than trusting it", async () => {
    mockAuthenticateApiRequest.mockResolvedValue({ userId: OWNER, organizationId: ORG });
    const res = await buildApp().request(`/api/org/${ORG}/costs`, { headers: KEY_HEADERS });
    expect(res.status).toBe(401);
  });

  it("401s when the owner's user row is gone", async () => {
    mockAuthenticateApiRequest.mockResolvedValue({
      userId: OWNER,
      organizationId: ORG,
      apiKeyId: KEY_ID,
      scopes: ["*"],
    });
    selectQueue.push([]); // no users row: the owner was deleted
    const res = await buildApp().request(`/api/org/${ORG}/costs`, { headers: KEY_HEADERS });
    expect(res.status).toBe(401);
    expect(mockResolveEffectivePermissions).not.toHaveBeenCalled();
  });

  it("does not silently downgrade a failed key to the session path", async () => {
    mockAuthenticateApiRequest.mockResolvedValue(null);
    await buildApp().request(`/api/org/${ORG}/costs`, {
      headers: { ...KEY_HEADERS, ...COOKIE_HEADERS },
    });
    expect(mockLoadSealedSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- 5 ------

describe("property 5 — session and WorkOS bearer behaviour is unchanged", () => {
  it("never touches the API-key path for a cookie request", async () => {
    sessionAuthenticates(["costs:read"]);
    const res = await buildApp().request(`/api/org/${ORG}/costs`, { headers: COOKIE_HEADERS });
    expect(res.status).toBe(200);
    expect(mockAuthenticateApiRequest).not.toHaveBeenCalled();
    expect(seen["apiKey"]).toBeUndefined();
    expect(seen["role"]).toMatchObject({ systemKey: "admin" });
  });

  it("never touches the API-key path for a WorkOS bearer token", async () => {
    mockVerifyWorkosAccessToken.mockResolvedValue({ sub: OWNER, email: "owner@example.com" });
    selectQueue.push([{ id: OWNER, email: "owner@example.com" }]); // ensureUserFromClaims
    selectQueue.push([{ role: "admin" }]); // orgMiddleware membership
    mockResolveEffectivePermissions.mockResolvedValue({
      permissions: ["costs:read"],
      role: null,
      elevations: [],
    });
    const res = await buildApp().request(`/api/org/${ORG}/costs`, {
      headers: { authorization: "Bearer eyJhbGciOi.workos.token" },
    });
    expect(res.status).toBe(200);
    expect(mockAuthenticateApiRequest).not.toHaveBeenCalled();
    expect(seen["apiKey"]).toBeUndefined();
  });

  it("still 401s an unauthenticated request from sessionMiddleware", async () => {
    const res = await buildApp().request(`/api/org/${ORG}/costs`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(mockAuthenticateApiRequest).not.toHaveBeenCalled();
  });

  it("still 403s a session user who is not a member of the org", async () => {
    mockLoadSealedSession.mockReturnValue({
      authenticate: vi.fn().mockResolvedValue({
        authenticated: true,
        user: { id: OWNER, email: "owner@example.com" },
        sessionId: "sess_1",
      }),
    });
    selectQueue.push([]); // no membership row
    const res = await buildApp().request(`/api/org/${ORG}/costs`, { headers: COOKIE_HEADERS });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });
});

// ------------------------------------------------------------------ audit --

describe("audit entries name the key, not just its owner", () => {
  it("stamps the key id on a row the handler never mentioned one to", async () => {
    keyAuthenticates(["accounts:write"], ["accounts:write"]);
    const res = await buildApp().request(`/api/org/${ORG}/accounts`, {
      method: "POST",
      headers: KEY_HEADERS,
    });
    expect(res.status).toBe(200);
    const row = inserted.find((r) => r["action"] === "account.create");
    expect(row).toMatchObject({ userId: OWNER, apiKeyId: KEY_ID, organizationId: ORG });
  });

  it("leaves the key id null for a person at a browser", async () => {
    sessionAuthenticates(["accounts:write"]);
    await buildApp().request(`/api/org/${ORG}/accounts`, {
      method: "POST",
      headers: COOKIE_HEADERS,
    });
    const row = inserted.find((r) => r["action"] === "account.create");
    expect(row).toMatchObject({ userId: OWNER, apiKeyId: null });
  });
});
