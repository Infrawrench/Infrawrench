import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * The GitHub App setup callback must not attach an installation on the say-so
 * of the URL: it needs the session of the user the state names, that user's
 * permission in the org right now, and GitHub's confirmation (over the user
 * authorization flow) that the GitHub user can access the installation.
 */

const verifyInstallState = vi.fn();
const signInstallState = vi.fn(() => "next-state");
const exchangeGithubUserCode = vi.fn();
const userCanAccessInstallation = vi.fn();
const oauthConfig = vi.fn<() => { clientId: string; clientSecret: string } | null>();
vi.mock("@infrawrench/server-core/github/app", () => ({
  verifyInstallState: (...a: unknown[]) => verifyInstallState(...a),
  signInstallState: (...a: unknown[]) => signInstallState(...(a as [])),
  exchangeGithubUserCode: (...a: unknown[]) => exchangeGithubUserCode(...a),
  userCanAccessInstallation: (...a: unknown[]) => userCanAccessInstallation(...a),
  githubAppOAuthConfig: () => oauthConfig(),
  githubUserAuthorizeUrl: (clientId: string, redirectUri: string, state: string) =>
    `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
  getInstallation: vi.fn().mockResolvedValue({ accountLogin: "acme", accountType: "Organization" }),
  githubAppSlug: () => "infrawrench",
  isGithubAppConfigured: () => true,
  listInstallationRepos: vi.fn(),
}));

let sessionUser: string | null = "user1";
vi.mock("@/api/auth-middleware", () => ({
  sessionMiddleware: async (c: { set: (k: string, v: unknown) => void }) => {
    if (!sessionUser) return new Response("Unauthorized", { status: 401 });
    c.set("session", { userId: sessionUser, email: "u@example.com" });
    return undefined;
  },
}));

const permissions = vi.fn<() => string[]>();
vi.mock("@infrawrench/server-core/permissions", () => ({
  resolveEffectivePermissions: () => Promise.resolve({ permissions: permissions() }),
}));
vi.mock("@infrawrench/server-core/permissions/catalog", () => ({
  hasPermission: (granted: string[], p: string) => granted.includes(p),
}));

const linkGithubInstallation = vi.fn();
vi.mock("@/services/github-installations", () => ({
  linkGithubInstallation: (...a: unknown[]) => linkGithubInstallation(...a),
}));

vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/db/schema", () => ({ githubInstallations: {} }));

const { githubSetupRoute } = await import("@/api/routes/github");

const STATE = { organizationId: "org1", userId: "user1", returnTo: "workflows" };

function get(query: string, cookie = true) {
  const app = new Hono();
  app.route("/api", githubSetupRoute);
  return app.request(`/api/github/setup?${query}`, {
    headers: cookie ? { cookie: "wos-session=sealed" } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionUser = "user1";
  verifyInstallState.mockReturnValue({ ...STATE, installationId: null });
  oauthConfig.mockReturnValue({ clientId: "Iv1.client", clientSecret: "secret" });
  permissions.mockReturnValue(["dashboards:write"]);
  exchangeGithubUserCode.mockResolvedValue("ghu_token");
  userCanAccessInstallation.mockResolvedValue(true);
  linkGithubInstallation.mockResolvedValue("linked");
});

describe("GET /api/github/setup", () => {
  it("rejects an invalid state", async () => {
    verifyInstallState.mockReturnValue(null);
    const res = await get("installation_id=42&state=bad");
    expect(res.headers.get("location")).toMatch(/\?github=error$/);
    expect(linkGithubInstallation).not.toHaveBeenCalled();
  });

  it("bounces a signed-out browser through sign-in and back", async () => {
    const res = await get("installation_id=42&state=s", false);
    const location = res.headers.get("location") ?? "";
    expect(location).toMatch(/^\/api\/auth\/sign-in\?return_to=/);
    expect(decodeURIComponent(location)).toContain("/api/github/setup?installation_id=42&state=s");
    expect(linkGithubInstallation).not.toHaveBeenCalled();
  });

  it("refuses a session that is not the user the state was minted for", async () => {
    sessionUser = "attacker";
    const res = await get("installation_id=42&state=s");
    expect(res.headers.get("location")).toMatch(/github=error/);
    expect(linkGithubInstallation).not.toHaveBeenCalled();
  });

  it("refuses a user who lost the permission since minting the URL", async () => {
    permissions.mockReturnValue(["dashboards:read"]);
    const res = await get("installation_id=42&state=s");
    expect(res.headers.get("location")).toMatch(/github=error/);
  });

  it("refuses outright when the OAuth client is not configured", async () => {
    oauthConfig.mockReturnValue(null);
    const res = await get("installation_id=42&state=s");
    expect(res.headers.get("location")).toMatch(/github=error/);
    expect(linkGithubInstallation).not.toHaveBeenCalled();
  });

  it("sends the first leg through GitHub user authorization, carrying the id in a signed state", async () => {
    const res = await get("installation_id=42&setup_action=install&state=s");
    expect(res.headers.get("location")).toMatch(
      /^https:\/\/github\.com\/login\/oauth\/authorize\?client_id=Iv1\.client/,
    );
    expect(signInstallState).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org1", userId: "user1", installationId: 42 }),
    );
    expect(linkGithubInstallation).not.toHaveBeenCalled();
  });

  it("links the installation once GitHub confirms the user can access it", async () => {
    verifyInstallState.mockReturnValue({ ...STATE, installationId: 42 });
    const res = await get("code=abc&state=s2");
    expect(exchangeGithubUserCode).toHaveBeenCalledWith(
      "abc",
      expect.stringMatching(/\/api\/github\/setup$/),
    );
    expect(userCanAccessInstallation).toHaveBeenCalledWith("ghu_token", 42);
    expect(linkGithubInstallation).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org1", userId: "user1", installationId: 42 }),
    );
    expect(res.headers.get("location")).toMatch(/\/org\/org1\/workflows\?github=connected$/);
  });

  it("ignores a URL installation_id once the state carries one", async () => {
    verifyInstallState.mockReturnValue({ ...STATE, installationId: 42 });
    await get("code=abc&installation_id=999&state=s2");
    expect(userCanAccessInstallation).toHaveBeenCalledWith("ghu_token", 42);
  });

  it("refuses an installation the GitHub user cannot access", async () => {
    verifyInstallState.mockReturnValue({ ...STATE, installationId: 7 });
    userCanAccessInstallation.mockResolvedValue(false);
    const res = await get("code=abc&state=s2");
    expect(res.headers.get("location")).toMatch(/github=error/);
    expect(linkGithubInstallation).not.toHaveBeenCalled();
  });

  it("refuses an installation already connected to another org", async () => {
    verifyInstallState.mockReturnValue({ ...STATE, installationId: 42 });
    linkGithubInstallation.mockResolvedValue("owned-elsewhere");
    const res = await get("code=abc&state=s2");
    expect(res.headers.get("location")).toMatch(/github=error/);
  });

  it("records nothing for an install request awaiting approval", async () => {
    const res = await get("setup_action=request&state=s");
    expect(res.headers.get("location")).toMatch(/github=requested/);
    expect(linkGithubInstallation).not.toHaveBeenCalled();
  });
});
