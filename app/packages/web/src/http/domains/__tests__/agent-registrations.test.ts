import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

/**
 * Settings → Agents editing a platform agent on the org tree. The domain logic
 * in `server-core/agent-links/links.ts` is mocked (it has its own suite);
 * these pin the gates in front of it: `team:invite`, the link's ceiling, and
 * that an editor may only add scopes they hold themselves.
 */

const link = {
  id: "link-1",
  organizationId: "org-1",
  platform: "nibblets",
  label: "Nibblets on PogAir-4",
  scopes: ["resources:read", "costs:read"],
  approvedByUserId: "user_approver",
  credentialPrefix: "iwl_abcd",
  lastSeenAt: null,
  revokedAt: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
};
const agentRow = {
  id: "reg-1",
  externalId: "nib-1",
  label: "Pog",
  scopes: ["resources:read"],
  providers: [] as string[],
  credentialPrefix: "iwa_abcd",
  lastSeenAt: null,
  revokedAt: null,
  createdAt: new Date("2026-10-02T00:00:00Z"),
};

class AgentLinkError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code?: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const links = {
  AgentLinkError,
  LABEL_MAX: 80,
  grantablePermissions: vi.fn(async () => ["team:invite", "resources:read", "costs:read"]),
  linkEffectiveScopes: vi.fn(async () => ["resources:read", "costs:read"]),
  getLinkAgent: vi.fn(async () => agentRow),
  getLink: vi.fn(async () => link),
  updatePlatformAgent: vi.fn(async () => undefined),
  // The real validator: it is the contract's 400 shape.
  validateAgentGrant: (effective: string[], scopes: string[], providers?: string[]) => {
    const notAllowed = scopes.filter((s) => !effective.includes(s));
    if (notAllowed.length > 0) {
      throw new AgentLinkError("outside", 400, "scope_not_allowed", { scopes: notAllowed });
    }
    return { scopes, providers: providers ?? [] };
  },
};
vi.mock("@infrawrench/server-core/agent-links/links", () => links);
vi.mock("@infrawrench/server-core/trials/ceremony", () => ({
  revokeAgentRegistration: vi.fn(async () => true),
}));

vi.mock("@/services/agent-links", () => ({
  serializeAgent: (row: { id: string }) => ({ id: row.id }),
  unknownProviders: vi.fn(async (p: string[]) => p.filter((x) => x !== "aws")),
}));
vi.mock("@/services/audit", () => ({ logAudit: vi.fn() }));
// The org-scoped lookup in the Settings PATCH:
// `db.select(...).from(...).where(...).limit(1)`.
vi.mock("@/db/client", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [{ linkId: "link-1" }] }) }),
    }),
  },
}));

const { agentRegistrationsDomain } = await import("@/http/domains/agent-registrations/index");

const basePath = "/api/org/org-1/agent-registrations";
const buildApp = (permissions?: string[]) =>
  buildTestApi(agentRegistrationsDomain, { basePath, ...(permissions ? { permissions } : {}) });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PATCH /agent-registrations/:id from Settings", () => {
  const patch = (body: unknown) => ({
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  it("needs team:invite", async () => {
    const res = await buildApp(["team:read"]).request(
      "/reg-1",
      patch({ scopes: ["resources:read"] }),
    );
    expect(res.status).toBe(403);
  });

  it("is held to the link ceiling", async () => {
    const res = await buildApp().request("/reg-1", patch({ scopes: ["resources:write"] }));
    expect(res.status).toBe(400);
  });

  it("cannot add a scope the editor does not hold", async () => {
    // The editor's own role, resolved without elevation (not the request's
    // permissions, which can carry a break-glass grant).
    links.grantablePermissions.mockResolvedValueOnce(["team:invite", "resources:read"]);
    const res = await buildApp().request(
      "/reg-1",
      patch({ scopes: ["resources:read", "costs:read"] }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).scopes).toEqual(["costs:read"]);
  });

  it("counts widening the providers as adding every scope it widens", async () => {
    links.getLinkAgent.mockResolvedValueOnce({ ...agentRow, providers: ["aws"] });
    links.grantablePermissions.mockResolvedValueOnce(["team:invite"]);
    const res = await buildApp().request("/reg-1", patch({ providers: [] }));
    expect(res.status).toBe(400);
    expect((await res.json()).scopes).toEqual(["resources:read"]);
    expect(links.updatePlatformAgent).not.toHaveBeenCalled();
  });

  it("lets an editor narrow providers without holding the scopes", async () => {
    links.getLinkAgent.mockResolvedValueOnce({ ...agentRow, providers: ["aws", "gcp"] });
    links.grantablePermissions.mockResolvedValueOnce(["team:invite"]);
    const res = await buildApp().request("/reg-1", patch({ providers: ["aws"] }));
    expect(res.status).toBe(200);
  });

  it("saves a valid edit", async () => {
    const res = await buildApp().request(
      "/reg-1",
      patch({ scopes: ["costs:read"], providers: ["aws"] }),
    );
    expect(res.status).toBe(200);
    expect(links.updatePlatformAgent).toHaveBeenCalledWith("reg-1", {
      scopes: ["costs:read"],
      providers: ["aws"],
    });
  });
});

describe("DELETE /agent-registrations/:id", () => {
  it("needs team:invite", async () => {
    const res = await buildApp(["team:read"]).request("/reg-1", { method: "DELETE" });
    expect(res.status).toBe(403);
  });

  it("revokes, idempotently", async () => {
    const res = await buildApp().request("/reg-1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, revoked: true });
  });
});
