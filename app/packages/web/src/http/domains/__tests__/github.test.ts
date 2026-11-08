import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

// The org-tree half of the GitHub App connection: status, the signed install
// URL, the repo listing across installations, and dropping a connection.
// GitHub itself is never called: the app module is mocked whole.
const signInstallState = vi.fn((_: unknown) => "signed-state");
const listInstallationRepos = vi.fn();
let configured = true;
let oauth: { clientId: string; clientSecret: string } | null = { clientId: "c", clientSecret: "s" };
vi.mock("@infrawrench/server-core/github/app", () => ({
  isGithubAppConfigured: () => configured,
  githubAppSlug: () => (configured ? "infrawrench" : null),
  githubAppOAuthConfig: () => oauth,
  signInstallState: (input: unknown) => signInstallState(input),
  listInstallationRepos: (...a: unknown[]) => listInstallationRepos(...a),
  verifyInstallState: vi.fn(),
  exchangeGithubUserCode: vi.fn(),
  userCanAccessInstallation: vi.fn(),
  getInstallation: vi.fn(),
  githubUserAuthorizeUrl: vi.fn(),
}));

let installs: Array<{ installationId: number; accountLogin: string }> = [];
const updates: unknown[] = [];
vi.mock("@/db/client", () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => installs }) }),
    update: () => ({
      set: (values: unknown) => ({
        where: async () => {
          updates.push(values);
        },
      }),
    }),
  },
}));
vi.mock("@/db/schema", () => ({
  githubInstallations: { organizationId: "o", installationId: "i", deletedAt: "d" },
}));
vi.mock("@/services/github-installations", () => ({ linkGithubInstallation: vi.fn() }));

const { githubDomain } = await import("@/http/domains/github/index");
const app = (permissions?: string[]) =>
  buildTestApi(githubDomain, {
    basePath: "/api/org/org-1/github",
    ...(permissions ? { permissions } : {}),
  });

beforeEach(() => {
  vi.clearAllMocks();
  configured = true;
  oauth = { clientId: "c", clientSecret: "s" };
  installs = [{ installationId: 7, accountLogin: "acme" }];
  updates.length = 0;
});

describe("GitHub App org routes", () => {
  it("reports configuration and the org's connections", async () => {
    const res = await app().request("/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      configured: true,
      appSlug: "infrawrench",
      installations: [{ installationId: 7, accountLogin: "acme" }],
    });
    const denied = await app([]).request("/status");
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "Missing permission: dashboards:read" });
  });

  it("signs an install URL for the caller, keeping only a known return page", async () => {
    const res = await app().request("/install-url?return=workflows");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      url: "https://github.com/apps/infrawrench/installations/new?state=signed-state",
    });
    expect(signInstallState).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      returnTo: "workflows",
    });
    await app().request("/install-url?return=https://evil.example");
    expect(signInstallState).toHaveBeenLastCalledWith(
      expect.objectContaining({ returnTo: "agents" }),
    );
    const denied = await app(["dashboards:read"]).request("/install-url");
    expect(await denied.json()).toEqual({ error: "Missing permission: dashboards:write" });
  });

  it("refuses an install URL the server cannot complete", async () => {
    oauth = null;
    const noOauth = await app().request("/install-url");
    expect(noOauth.status).toBe(400);
    expect((await noOauth.json()).error).toMatch(
      /^GitHub App user authorization is not configured/,
    );
    configured = false;
    const none = await app().request("/install-url");
    expect(await none.json()).toEqual({ error: "GitHub App is not configured on this server." });
  });

  it("lists repos across installations, sorted, skipping one that fails", async () => {
    installs = [
      { installationId: 7, accountLogin: "acme" },
      { installationId: 8, accountLogin: "beta" },
    ];
    listInstallationRepos.mockImplementation(async (id: number) => {
      if (id === 8) throw new Error("suspended");
      return [
        { id: 2, fullName: "acme/zeta", defaultBranch: "main", private: true },
        { id: 1, fullName: "acme/alpha", defaultBranch: "main", private: false },
      ];
    });
    const res = await app().request("/repos");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.repos.map((r: { fullName: string }) => r.fullName)).toEqual([
      "acme/alpha",
      "acme/zeta",
    ]);
    expect(body.repos[0]).toMatchObject({ installationId: 7 });
  });

  it("soft-deletes a connection", async () => {
    const res = await app().request("/installations/7", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ deletedAt: expect.any(Date) });
  });
});
