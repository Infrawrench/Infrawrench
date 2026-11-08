import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

/**
 * The org tree's view of agent links (Settings → Agents): `team:read` to list
 * them, `team:invite` to revoke one, and an id from another org is a 404.
 */

const link = {
  id: "link-1",
  organizationId: "org-1",
  platform: "nibblets",
  label: "Nibblets on PogAir-4",
  scopes: ["resources:read"],
  approvedByUserId: "user_approver",
  credentialPrefix: "iwl_abcd",
  lastSeenAt: null,
  revokedAt: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
};

const links = {
  getLink: vi.fn(async (_org: string, id: string) => (id === "link-1" ? link : null)),
  listOrgLinks: vi.fn(async () => [link]),
  revokeLink: vi.fn(async () => true),
};
vi.mock("@infrawrench/server-core/agent-links/links", () => links);

const summary = {
  id: "link-1",
  organizationId: "org-1",
  organizationName: "Acme",
  platform: "nibblets",
  label: "Nibblets on PogAir-4",
  scopes: ["resources:read"],
  effectiveScopes: ["resources:read"],
  narrowableScopes: ["resources:read"],
  scopeGroups: [{ title: "Resources", scopes: [{ value: "resources:read", label: "Read" }] }],
  providers: [{ id: "aws", displayName: "AWS" }],
  approvedBy: { email: "a@example.com" },
  createdAt: "2026-10-01T00:00:00.000Z",
  credentialPrefix: "iwl_abcd",
  lastSeenAt: null,
  revokedAt: null,
};
vi.mock("@/services/agent-links", () => ({ buildOrgLinkSummary: vi.fn(async () => summary) }));
const logAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

const { agentLinksDomain } = await import("@/http/domains/agent-links/index");

const basePath = "/api/org/org-1/agent-links";
const buildApp = (permissions?: string[]) =>
  buildTestApi(agentLinksDomain, { basePath, ...(permissions ? { permissions } : {}) });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /agent-links", () => {
  it("lists the org's links as summaries", async () => {
    const res = await buildApp(["team:read"]).request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([summary]);
    expect(links.listOrgLinks).toHaveBeenCalledWith("org-1");
  });

  it("needs team:read", async () => {
    const res = await buildApp([]).request("/");
    expect(res.status).toBe(403);
  });
});

describe("DELETE /agent-links/:id", () => {
  it("needs team:invite", async () => {
    const res = await buildApp(["team:read"]).request("/link-1", { method: "DELETE" });
    expect(res.status).toBe(403);
    expect(links.revokeLink).not.toHaveBeenCalled();
  });

  it("404s a link from another org", async () => {
    const res = await buildApp().request("/link-2", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Agent link not found" });
    expect(links.revokeLink).not.toHaveBeenCalled();
  });

  it("revokes and audits", async () => {
    const res = await buildApp().request("/link-1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, revoked: true });
    expect(links.revokeLink).toHaveBeenCalledWith("link-1");
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "agent_link.revoke",
        entityId: "link-1",
        metadata: { platform: "nibblets", by: "member", alreadyRevoked: false },
      }),
    );
  });
});
