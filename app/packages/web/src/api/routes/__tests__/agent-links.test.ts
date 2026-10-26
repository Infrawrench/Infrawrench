import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { buildTestApp } from "./test-utils";

/**
 * The agent link HTTP surface: the device flow, the person's approval, the
 * link-authenticated agent routes and the org tree's edit. The domain logic in
 * `server-core/agent-links/links.ts` is mocked (it has its own suite); these
 * pin the wire contract and the gates in front of it.
 */

process.env["ENCRYPTION_MASTER_KEY"] = Buffer.alloc(32, 1).toString("base64");
process.env["WORKOS_API_KEY"] = "test_workos_api_key";
process.env["WORKOS_CLIENT_ID"] = "test_workos_client_id";

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
  EXTERNAL_ID_MAX: 120,
  LABEL_MAX: 80,
  LINK_POLL_INTERVAL_S: 5,
  LINK_REQUEST_TTL_MS: 900_000,
  PLATFORM_SLUG: /^[a-z0-9-]{1,40}$/,
  createLinkRequest: vi.fn(async () => ({
    deviceCode: "dev",
    userCode: "ABCD-EFGH",
    expiresAt: new Date(),
  })),
  pollLinkRequest: vi.fn(),
  lookupLinkRequest: vi.fn(async () => ({
    id: "req-1",
    platform: "nibblets",
    label: "Nibblets",
    requestedScopes: ["resources:read"],
    expiresAt: new Date("2026-10-23T00:15:00Z"),
  })),
  approveLinkRequest: vi.fn(async () => undefined),
  denyLinkRequest: vi.fn(async () => undefined),
  grantablePermissions: vi.fn(async () => ["team:invite", "resources:read", "costs:read"]),
  resolveLinkCredential: vi.fn(async (token: string) => (token === "iwl_good" ? link : null)),
  touchLink: vi.fn(async () => undefined),
  linkEffectiveScopes: vi.fn(async () => ["resources:read", "costs:read"]),
  listLinkAgents: vi.fn(async () => [agentRow]),
  getLinkAgent: vi.fn(async () => agentRow),
  getLink: vi.fn(async () => link),
  createPlatformAgent: vi.fn(async () => ({ agent: agentRow, credential: "iwa_new" })),
  updatePlatformAgent: vi.fn(async () => undefined),
  rotatePlatformAgent: vi.fn(async () => ({ credential: "iwa_rotated", prefix: "iwa_rota" })),
  revokePlatformAgent: vi.fn(async () => true),
  revokeLink: vi.fn(async () => true),
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

vi.mock("@/services/agent-links", () => ({
  buildLinkInfo: vi.fn(async () => ({ id: "link-1" })),
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
vi.mock("@/api/auth-middleware", () => ({
  // A stand-in session layer that records it ran, so the public routes can be
  // shown to bypass it.
  sessionMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => unknown) => {
    sessionRuns++;
    c.set("session", { userId: "user-1", email: "u@example.com" });
    return next();
  },
  listUserOrganizations: vi.fn(async () => [{ id: "org-1", displayName: "Acme", role: "owner" }]),
}));
let sessionRuns = 0;

const { agentLinkRequestRoutes, agentLinkRoutes, resetAgentLinkAttemptsForTests } =
  await import("@/api/routes/agent-links");
const { agentRegistrationRoutes } = await import("@/api/routes/agent-registrations");

function app() {
  const root = new Hono();
  root.route("/api/agent-links/requests", agentLinkRequestRoutes);
  root.route("/api/agent-link", agentLinkRoutes);
  return root;
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  sessionRuns = 0;
  resetAgentLinkAttemptsForTests();
});

describe("device flow", () => {
  it("starts a request without a session and answers the contract's shape", async () => {
    const res = await app().request(
      "/api/agent-links/requests",
      json({ platform: "nibblets", label: "Nibblets on PogAir-4", requestedScopes: ["x:y"] }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ deviceCode: "dev", userCode: "ABCD-EFGH", expiresIn: 900 });
    expect(body.verificationUrlComplete).toMatch(/\/link-agents\?code=ABCD-EFGH$/);
    expect(sessionRuns).toBe(0);
    // An unknown pre-tick is dropped, not refused.
    expect(links.createLinkRequest).toHaveBeenCalledWith(
      expect.objectContaining({ requestedScopes: [] }),
    );
  });

  it("refuses a malformed platform slug", async () => {
    const res = await app().request(
      "/api/agent-links/requests",
      json({ platform: "Nib Blets", label: "x" }),
    );
    expect(res.status).toBe(400);
  });

  it("maps poll results, with slow_down as a 429", async () => {
    links.pollLinkRequest.mockResolvedValueOnce({ status: "pending" });
    let res = await app().request("/api/agent-links/requests/token", json({ deviceCode: "d" }));
    expect(await res.json()).toEqual({ status: "pending" });

    links.pollLinkRequest.mockResolvedValueOnce({ status: "slow_down" });
    res = await app().request("/api/agent-links/requests/token", json({ deviceCode: "d" }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "slow_down" });

    links.pollLinkRequest.mockResolvedValueOnce({
      status: "approved",
      credential: "iwl_good",
      linkId: "link-1",
    });
    res = await app().request("/api/agent-links/requests/token", json({ deviceCode: "d" }));
    expect(await res.json()).toEqual({
      status: "approved",
      credential: "iwl_good",
      link: { id: "link-1" },
    });
    expect(sessionRuns).toBe(0);
  });
});

describe("approval", () => {
  it("runs behind the session layer and reports what the person may grant", async () => {
    const res = await app().request("/api/agent-links/requests/lookup", json({ code: "ABCDEFGH" }));
    expect(res.status).toBe(200);
    expect(sessionRuns).toBe(1);
    const body = await res.json();
    expect(body.organizations).toEqual([
      {
        id: "org-1",
        name: "Acme",
        canApprove: true,
        grantableScopes: ["resources:read", "costs:read"],
      },
    ]);
  });

  it("refuses an approver without team:invite", async () => {
    links.grantablePermissions.mockResolvedValueOnce(["resources:read"]);
    const res = await app().request(
      "/api/agent-links/requests/approve",
      json({ code: "ABCDEFGH", organizationId: "org-1", scopes: ["resources:read"] }),
    );
    expect(res.status).toBe(403);
    expect(links.approveLinkRequest).not.toHaveBeenCalled();
  });

  it("refuses a ceiling beyond what the approver holds", async () => {
    const res = await app().request(
      "/api/agent-links/requests/approve",
      json({ code: "ABCDEFGH", organizationId: "org-1", scopes: ["resources:delete"] }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("scope_not_allowed");
  });

  it("refuses agent-denied scopes even when the approver holds them", async () => {
    links.grantablePermissions.mockResolvedValueOnce(["team:invite", "billing:read"]);
    const res = await app().request(
      "/api/agent-links/requests/approve",
      json({ code: "ABCDEFGH", organizationId: "org-1", scopes: ["billing:read"] }),
    );
    expect(res.status).toBe(400);
  });

  it("approves within the approver's grant", async () => {
    const res = await app().request(
      "/api/agent-links/requests/approve",
      json({ code: "ABCDEFGH", organizationId: "org-1", scopes: ["resources:read"] }),
    );
    expect(res.status).toBe(200);
    expect(links.approveLinkRequest).toHaveBeenCalledWith({
      requestId: "req-1",
      organizationId: "org-1",
      userId: "user-1",
      scopes: ["resources:read"],
    });
  });
});

describe("link-authenticated routes", () => {
  const auth = { authorization: "Bearer iwl_good" };

  it("answers 401 without a live link credential", async () => {
    const res = await app().request("/api/agent-link", {
      headers: { authorization: "Bearer iwl_revoked" },
    });
    expect(res.status).toBe(401);
  });

  it("creates an agent and returns its credential once", async () => {
    const res = await app().request(
      "/api/agent-link/agents",
      json({ externalId: "nib-1", label: "Pog", scopes: ["resources:read"] }, auth),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ agent: { id: "reg-1" }, credential: "iwa_new" });
  });

  it("names the scopes outside the ceiling", async () => {
    const res = await app().request(
      "/api/agent-link/agents",
      json({ externalId: "nib-1", label: "Pog", scopes: ["resources:write"] }, auth),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "scope_not_allowed",
      scopes: ["resources:write"],
    });
    expect(links.createPlatformAgent).not.toHaveBeenCalled();
  });

  it("refuses unknown providers", async () => {
    const res = await app().request(
      "/api/agent-link/agents",
      json(
        { externalId: "nib-1", label: "Pog", scopes: ["resources:read"], providers: ["nope"] },
        auth,
      ),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_provider");
  });

  it("passes the exists conflict through as 409 with the agent id", async () => {
    links.createPlatformAgent.mockRejectedValueOnce(
      new AgentLinkError("exists", 409, "exists", { agentId: "reg-old" }),
    );
    const res = await app().request(
      "/api/agent-link/agents",
      json({ externalId: "nib-1", label: "Pog", scopes: ["resources:read"] }, auth),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "exists", agentId: "reg-old" });
  });

  it("rotates and revokes", async () => {
    let res = await app().request("/api/agent-link/agents/reg-1/rotate", {
      method: "POST",
      headers: auth,
    });
    expect(await res.json()).toMatchObject({ credential: "iwa_rotated" });
    res = await app().request("/api/agent-link/agents/reg-1", { method: "DELETE", headers: auth });
    expect(await res.json()).toEqual({ ok: true });
    expect(links.revokePlatformAgent).toHaveBeenCalledWith("reg-1");
  });

  it("unlinks, revoking the link's agents", async () => {
    const res = await app().request("/api/agent-link", { method: "DELETE", headers: auth });
    expect(res.status).toBe(200);
    expect(links.revokeLink).toHaveBeenCalledWith("link-1");
  });
});

describe("PATCH /agent-registrations/:id from Settings", () => {
  const patch = (body: unknown) => ({
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  it("needs team:invite", async () => {
    const res = await buildTestApp(agentRegistrationRoutes, ["team:read"]).request(
      "/reg-1",
      patch({ scopes: ["resources:read"] }),
    );
    expect(res.status).toBe(403);
  });

  it("is held to the link ceiling", async () => {
    const res = await buildTestApp(agentRegistrationRoutes).request(
      "/reg-1",
      patch({ scopes: ["resources:write"] }),
    );
    expect(res.status).toBe(400);
  });

  it("cannot add a scope the editor does not hold", async () => {
    // The editor's own role, resolved without elevation (not the request's
    // permissions, which can carry a break-glass grant).
    links.grantablePermissions.mockResolvedValueOnce(["team:invite", "resources:read"]);
    const res = await buildTestApp(agentRegistrationRoutes).request(
      "/reg-1",
      patch({ scopes: ["resources:read", "costs:read"] }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).scopes).toEqual(["costs:read"]);
  });

  it("counts widening the providers as adding every scope it widens", async () => {
    links.getLinkAgent.mockResolvedValueOnce({ ...agentRow, providers: ["aws"] });
    links.grantablePermissions.mockResolvedValueOnce(["team:invite"]);
    const res = await buildTestApp(agentRegistrationRoutes).request(
      "/reg-1",
      patch({ providers: [] }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).scopes).toEqual(["resources:read"]);
    expect(links.updatePlatformAgent).not.toHaveBeenCalled();
  });

  it("lets an editor narrow providers without holding the scopes", async () => {
    links.getLinkAgent.mockResolvedValueOnce({ ...agentRow, providers: ["aws", "gcp"] });
    links.grantablePermissions.mockResolvedValueOnce(["team:invite"]);
    const res = await buildTestApp(agentRegistrationRoutes).request(
      "/reg-1",
      patch({ providers: ["aws"] }),
    );
    expect(res.status).toBe(200);
  });

  it("saves a valid edit", async () => {
    const res = await buildTestApp(agentRegistrationRoutes).request(
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
