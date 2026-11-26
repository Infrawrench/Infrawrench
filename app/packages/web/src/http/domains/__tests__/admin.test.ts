import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildTestApi } from "@/http/testing";

const mockSelect = vi.fn();
const mockUpdate = vi.fn();
vi.mock("@/db/client", () => ({
  db: {
    select: (...a: unknown[]) => mockSelect(...a),
    update: (...a: unknown[]) => mockUpdate(...a),
  },
}));

// git-feature-flag: remove with the flag (KNOWLEDGE.md "Git feature flag").
const mockGitOrgs = vi.fn<() => Promise<Set<string>>>();
const mockSetGit =
  vi.fn<(orgId: string, enabled: boolean, by: string | null) => Promise<boolean>>();
vi.mock("@infrawrench/server-core/git/feature-flag", () => ({
  gitEnabledOrganizationIds: () => mockGitOrgs(),
  setGitEnabled: (orgId: string, enabled: boolean, by: string | null) =>
    mockSetGit(orgId, enabled, by),
}));

const { adminDomain } = await import("@/http/domains/admin/index");
const buildApp = () => buildTestApi(adminDomain, { basePath: "/api/admin" });

function listReturns(rows: unknown[]) {
  const orderBy = vi.fn().mockResolvedValue(rows);
  const leftJoin = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ leftJoin });
  mockSelect.mockReturnValue({ from });
}

function updateReturns(rows: unknown[]) {
  const returning = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  mockUpdate.mockReturnValue({ set });
  return { set };
}

describe("Admin routes", () => {
  // buildTestApi's session email is test@example.com
  beforeEach(() => {
    vi.clearAllMocks();
    mockGitOrgs.mockResolvedValue(new Set()); // git-feature-flag
    process.env["INFRAWRENCH_PLATFORM_ADMIN_EMAILS"] = "someone@else.com, Test@Example.com";
  });
  afterEach(() => {
    delete process.env["INFRAWRENCH_PLATFORM_ADMIN_EMAILS"];
  });

  it("403s when the allowlist is unset", async () => {
    delete process.env["INFRAWRENCH_PLATFORM_ADMIN_EMAILS"];
    const res = await buildApp().request("/organizations");
    expect(res.status).toBe(403);
  });

  it("403s users not on the allowlist", async () => {
    process.env["INFRAWRENCH_PLATFORM_ADMIN_EMAILS"] = "someone@else.com";
    const res = await buildApp().request("/organizations");
    expect(res.status).toBe(403);
  });

  it("403s users not on the allowlist on any other path under the prefix", async () => {
    process.env["INFRAWRENCH_PLATFORM_ADMIN_EMAILS"] = "someone@else.com";
    const res = await buildApp().request("/orgs");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("403s before reading the body of a write", async () => {
    process.env["INFRAWRENCH_PLATFORM_ADMIN_EMAILS"] = "someone@else.com";
    const res = await buildApp().request("/organizations/org-1/complimentary", {
      method: "PUT",
      body: "not json",
    });
    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("lists organizations for allowlisted admins (case-insensitive match)", async () => {
    listReturns([
      {
        id: "org-1",
        displayName: "Acme",
        complimentary: false,
        createdAt: "2026-01-01T00:00:00Z",
        memberCount: 3,
        subscriptionStatus: "active",
      },
    ]);
    const res = await buildApp().request("/organizations");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: "org-1", complimentary: false });
  });

  // git-feature-flag: remove with the flag (KNOWLEDGE.md "Git feature flag").
  it("lists which organizations have Git and turns it on and off", async () => {
    listReturns([
      {
        id: "org-1",
        displayName: "Acme",
        complimentary: false,
        createdAt: "2026-01-01T00:00:00Z",
        memberCount: 3,
        subscriptionStatus: null,
      },
      {
        id: "org-2",
        displayName: "Beta",
        complimentary: false,
        createdAt: "2026-01-02T00:00:00Z",
        memberCount: 1,
        subscriptionStatus: null,
      },
    ]);
    mockGitOrgs.mockResolvedValue(new Set(["org-2"]));
    const list = (await (await buildApp().request("/organizations")).json()) as Array<{
      id: string;
      git: boolean;
    }>;
    expect(list.map((org) => [org.id, org.git])).toEqual([
      ["org-1", false],
      ["org-2", true],
    ]);

    const limit = vi.fn().mockResolvedValue([{ id: "org-1" }]);
    const where = vi.fn().mockReturnValue({ limit });
    mockSelect.mockReturnValue({ from: vi.fn().mockReturnValue({ where }) });
    mockSetGit.mockResolvedValue(true);
    const res = await buildApp().request("/organizations/org-1/git", {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "org-1", git: true });
    expect(mockSetGit).toHaveBeenCalledWith("org-1", true, "test@example.com");
  });

  it("keeps the Git switch to platform admins", async () => {
    process.env["INFRAWRENCH_PLATFORM_ADMIN_EMAILS"] = "someone@else.com";
    const res = await buildApp().request("/organizations/org-1/git", {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(403);
    expect(mockSetGit).not.toHaveBeenCalled();
  });

  it("grants complimentary access", async () => {
    const { set } = updateReturns([{ id: "org-1", complimentary: true }]);
    const res = await buildApp().request("/organizations/org-1/complimentary", {
      method: "PUT",
      body: JSON.stringify({ complimentary: true }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "org-1", complimentary: true });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ complimentary: true }));
  });

  it("400s on a malformed body", async () => {
    const res = await buildApp().request("/organizations/org-1/complimentary", {
      method: "PUT",
      body: JSON.stringify({ complimentary: "yes" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("404s for an unknown org", async () => {
    updateReturns([]);
    const res = await buildApp().request("/organizations/nope/complimentary", {
      method: "PUT",
      body: JSON.stringify({ complimentary: false }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
  });

  it("has no per-organization feature switch: CI is on for every organization", async () => {
    const res = await buildApp().request("/organizations/org-1/features/ci", {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(404);
  });
});
