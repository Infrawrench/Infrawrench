import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Agent links: provider narrowing, how a platform agent's authority is
 * computed, and the exactly-once credential collection of the device flow.
 * Postgres is the recording driver (see `helpers/fake-postgres.ts`).
 */

import { fakePostgres } from "./helpers/fake-postgres";

const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

const resolveEffectivePermissions = vi.fn(async () => ({
  permissions: ["*"] as string[],
  role: null,
  elevations: [],
}));
vi.mock("../permissions/resolver", () => ({
  ensureSystemRoles: vi.fn(async () => undefined),
  getSystemRole: vi.fn(async () => ({ id: "role-member" })),
  resolveEffectivePermissions: (...a: unknown[]) =>
    (resolveEffectivePermissions as (...b: unknown[]) => unknown)(...a),
}));

process.env["ENCRYPTION_MASTER_KEY"] ??= Buffer.alloc(32, 1).toString("base64");

const scopes = await import("../agent-links/scopes");
const principal = await import("../trials/principal");
const links = await import("../agent-links/links");

beforeEach(() => {
  pg.reset();
  resolveEffectivePermissions.mockClear();
  resolveEffectivePermissions.mockResolvedValue({ permissions: ["*"], role: null, elevations: [] });
});

describe("narrowToProviders", () => {
  it("rewrites provider-scoped permissions once per provider and leaves the rest", () => {
    expect(
      scopes.narrowToProviders(["resources:read", "costs:read", "secrets:write"], ["aws", "gcp"]),
    ).toEqual([
      "resources:aws:read",
      "resources:gcp:read",
      "costs:read",
      "secrets:aws:write",
      "secrets:gcp:write",
    ]);
  });

  it("treats no providers as every provider", () => {
    expect(scopes.narrowToProviders(["resources:read"], [])).toEqual(["resources:read"]);
    expect(scopes.narrowToProviders(["resources:read"], null)).toEqual(["resources:read"]);
  });

  it("never writes a wildcard or extra segment from a malformed provider", () => {
    expect(scopes.narrowToProviders(["resources:read"], ["*", "a:b", "aws"])).toEqual([
      "resources:aws:read",
    ]);
  });
});

describe("plugin-aware matching", () => {
  const narrowed = ["resources:aws:read"];

  it("never satisfies the unsegmented check a route or tool asks for", async () => {
    const { hasPermission } = await import("../permissions/catalog");
    expect(hasPermission(narrowed, "resources:read")).toBe(false);
  });

  it("is honoured only for the named plugin", () => {
    expect(scopes.holdsForPlugin(narrowed, "resources:read", "aws")).toBe(true);
    expect(scopes.holdsForPlugin(narrowed, "resources:read", "gcp")).toBe(false);
    expect(scopes.holdsForPlugin(narrowed, "resources:write", "aws")).toBe(false);
    expect(scopes.holdsForPlugin(["resources:read"], "resources:read", "gcp")).toBe(true);
  });

  it("reports where a narrowed grant applies", () => {
    expect(scopes.holdsForSomePlugin(narrowed, "resources:read")).toBe(true);
    expect(scopes.holdsForSomePlugin(narrowed, "resources:delete")).toBe(false);
    expect(scopes.pluginsAllowedFor(narrowed, "resources:read")).toEqual(["aws"]);
    expect(scopes.pluginsAllowedFor(["resources:read"], "resources:read")).toBeNull();
  });
});

describe("resolveAgentPrincipal for a platform agent", () => {
  // Keys in projection order, as the recording driver decodes positionally.
  const platformRow = (overrides: Record<string, unknown> = {}) => ({
    organizationId: "org-1",
    claimedByUserId: "user_approver",
    claimedAt: new Date(),
    revokedAt: null,
    trialExpiresAt: null,
    kind: "platform",
    linkId: "link-1",
    scopes: ["resources:read", "resources:write", "costs:read"],
    providers: [],
    linkOrganizationId: "org-1",
    linkScopes: ["resources:read", "costs:read", "billing:read"],
    linkRevokedAt: null,
    ...overrides,
  });

  it("is scopes ∩ link ceiling ∩ approver role − agent denials", async () => {
    resolveEffectivePermissions.mockResolvedValue({
      permissions: ["resources:read", "resources:write", "billing:read"],
      role: null,
      elevations: [],
    });
    pg.queueRows([platformRow()]);
    const p = await principal.resolveAgentPrincipal("reg-1");
    // resources:write is outside the ceiling, costs:read outside the role,
    // billing:read is agent-denied whatever the ceiling says.
    expect(p?.permissions).toEqual(["resources:read"]);
    expect(p?.linkId).toBe("link-1");
    expect(p?.claimed).toBe(true);
    expect(p?.trialExpiresInMs).toBeNull();
  });

  it("never folds in the approver's break-glass elevation", async () => {
    pg.queueRows([platformRow()]);
    await principal.resolveAgentPrincipal("reg-1");
    expect(resolveEffectivePermissions).toHaveBeenCalledWith(
      "org-1",
      { kind: "user", userId: "user_approver" },
      { includeElevation: false },
    );
  });

  it("narrows to providers after intersecting, keeping nothing org-wide", async () => {
    pg.queueRows([platformRow({ providers: ["aws"] })]);
    const p = await principal.resolveAgentPrincipal("reg-1");
    // costs:read is in scope, ceiling and role, but cannot be limited to AWS.
    expect(p?.permissions).toEqual(["resources:aws:read"]);
  });

  it("refuses an agent whose link is revoked", async () => {
    pg.queueRows([platformRow({ linkRevokedAt: new Date() })]);
    expect(await principal.resolveAgentPrincipal("reg-1")).toBeNull();
  });

  it("refuses an agent whose link belongs to another org", async () => {
    pg.queueRows([platformRow({ linkOrganizationId: "org-2" })]);
    expect(await principal.resolveAgentPrincipal("reg-1")).toBeNull();
  });

  it("refuses a platform row with no link at all", async () => {
    pg.queueRows([platformRow({ linkId: null })]);
    expect(await principal.resolveAgentPrincipal("reg-1")).toBeNull();
  });

  it("holds nothing once the approver is gone", async () => {
    pg.queueRows([platformRow({ claimedByUserId: null })]);
    const p = await principal.resolveAgentPrincipal("reg-1");
    expect(p?.permissions).toEqual([]);
    expect(resolveEffectivePermissions).not.toHaveBeenCalled();
  });
});

describe("validateAgentGrant", () => {
  it("names exactly the scopes outside the ceiling", () => {
    try {
      links.validateAgentGrant(["resources:read"], ["resources:read", "costs:read"], undefined);
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(links.AgentLinkError);
      const err = e as InstanceType<typeof links.AgentLinkError>;
      expect(err.code).toBe("scope_not_allowed");
      expect(err.details).toEqual({ scopes: ["costs:read"] });
    }
  });

  it("refuses scopes that cannot be limited to providers once providers are chosen", () => {
    try {
      links.validateAgentGrant(
        ["resources:read", "accounts:delete", "costs:read"],
        ["resources:read", "accounts:delete", "costs:read"],
        ["aws"],
      );
      throw new Error("expected a throw");
    } catch (e) {
      const err = e as InstanceType<typeof links.AgentLinkError>;
      expect(err.code).toBe("scope_not_allowed");
      expect(err.details).toEqual({ scopes: ["accounts:delete", "costs:read"] });
    }
    // Without providers they are fine.
    expect(links.validateAgentGrant(["accounts:delete"], ["accounts:delete"], []).scopes).toEqual([
      "accounts:delete",
    ]);
  });

  it("rejects provider ids that could smuggle a segment", () => {
    expect(() => links.validateAgentGrant([], [], ["aws:read"])).toThrow(/Not plugin ids/);
  });
});

describe("pollLinkRequest", () => {
  const future = new Date(Date.now() + 600_000);

  it("collects an approved link once, then answers expired", async () => {
    // select the request
    pg.queueRows([{ id: "req-1", status: "approved", expiresAt: future, lastPolledAt: null }]);
    // the conditional update that wins the collection
    pg.queueRows([
      {
        platform: "nibblets",
        label: "Nibblets",
        organizationId: "org-1",
        approvedScopes: ["resources:read"],
        decidedByUserId: "user_approver",
      },
    ]);
    const first = await links.pollLinkRequest("device-code");
    expect(first.status).toBe("approved");
    expect(first.status === "approved" && first.credential.startsWith("iwl_")).toBe(true);
    const linkInsert = pg.queries.find((q) => q.sql.startsWith('insert into "agent_links"'));
    expect(linkInsert).toBeDefined();
    // The plaintext credential is never written.
    expect(linkInsert?.params).not.toContain(first.status === "approved" ? first.credential : "");

    pg.reset();
    pg.queueRows([{ id: "req-1", status: "consumed", expiresAt: future, lastPolledAt: null }]);
    expect(await links.pollLinkRequest("device-code")).toEqual({ status: "expired" });
  });

  it("answers expired when a concurrent poll already won the collection", async () => {
    pg.queueRows([{ id: "req-1", status: "approved", expiresAt: future, lastPolledAt: null }]);
    pg.queueRows([]);
    expect(await links.pollLinkRequest("device-code")).toEqual({ status: "expired" });
    expect(pg.queries.some((q) => q.sql.startsWith('insert into "agent_links"'))).toBe(false);
  });

  it("asks a platform polling too fast to slow down", async () => {
    pg.queueRows([{ id: "req-1", status: "pending", expiresAt: future, lastPolledAt: new Date() }]);
    expect(await links.pollLinkRequest("device-code")).toEqual({ status: "slow_down" });
  });

  it("reports an unknown device code as expired", async () => {
    pg.queueRows([]);
    expect(await links.pollLinkRequest("nope")).toEqual({ status: "expired" });
  });
});

describe("revokeLink", () => {
  it("revokes the link and every live agent it made", async () => {
    pg.queueRows([{ id: "link-1" }]);
    expect(await links.revokeLink("link-1")).toBe(true);
    const regUpdate = pg.queries.find((q) => q.sql.startsWith('update "agent_auth_registrations"'));
    expect(regUpdate?.sql).toContain('"link_id" = ');
    expect(regUpdate?.sql).toContain('"revoked_at" is null');
  });
});

describe("links Infrawrench makes itself (Nibblets agent sessions)", () => {
  it("creates an approved link with no credential yet", async () => {
    const link = await links.createApprovedLink({
      organizationId: "org-1",
      platform: "nibblets",
      label: "home-server",
      scopes: ["costs:read"],
      approvedByUserId: "user-1",
    });
    expect(link.credentialPrefix).toBeNull();
    const insert = pg.queries.find((q) => q.sql.startsWith('insert into "agent_links"'));
    expect(insert?.params).toContain("user-1");
  });

  it("mints a credential only while the platform has never used the link", async () => {
    pg.queueRows([{ id: "link-1" }]);
    const token = await links.issueLinkCredential("link-1");
    expect(token?.startsWith("iwl_")).toBe(true);
    const update = pg.lastQuery();
    expect(update.sql).toContain('"last_seen_at" is null');
    expect(update.sql).toContain('"revoked_at" is null');
    // Stored as a hash, never the token.
    expect(update.params).not.toContain(token);

    pg.queueRows([]);
    expect(await links.issueLinkCredential("link-1")).toBeNull();
  });
});

describe("createPlatformAgent", () => {
  const link = {
    id: "link-1",
    organizationId: "org-1",
    platform: "nibblets",
    label: "Nibblets",
    scopes: ["resources:read"],
    approvedByUserId: "user_approver",
    credentialPrefix: null,
    lastSeenAt: null,
    revokedAt: null,
    createdAt: new Date(),
  };

  it("writes the registration, user and membership in one transaction under a per-link lock", async () => {
    const transaction = vi.spyOn(pg.db, "transaction");
    pg.queueRows([]); // no live agent with that externalId
    await links.createPlatformAgent({
      link,
      externalId: "nib-1",
      label: "Pog",
      scopes: ["resources:read"],
      providers: [],
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    const sqls = pg.queries.map((q) => q.sql);
    const lock = sqls.findIndex((q) => q.includes("pg_advisory_xact_lock"));
    const reg = sqls.findIndex((q) => q.startsWith('insert into "agent_auth_registrations"'));
    const user = sqls.findIndex((q) => q.startsWith('insert into "users"'));
    const member = sqls.findIndex((q) => q.startsWith('insert into "organization_members"'));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(reg);
    expect(reg).toBeLessThan(user);
    expect(user).toBeLessThan(member);
    transaction.mockRestore();
  });

  it("refuses past the live-agent cap without writing anything", async () => {
    pg.queueRows([]); // externalId lookup
    pg.queueRows([]); // advisory lock
    pg.queueRows([{ n: links.MAX_LIVE_AGENTS_PER_LINK }]);
    await expect(
      links.createPlatformAgent({
        link,
        externalId: "nib-2",
        label: "Pog",
        scopes: ["resources:read"],
        providers: [],
      }),
    ).rejects.toMatchObject({ code: "too_many_agents", status: 409 });
    expect(pg.queries.some((q) => q.sql.startsWith('insert into "agent_auth_registrations"'))).toBe(
      false,
    );
  });
});
