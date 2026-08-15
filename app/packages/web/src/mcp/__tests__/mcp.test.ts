import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db/client", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
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

vi.mock("@/auth/workos", () => ({
  workos: {
    userManagement: {
      getUser: vi.fn(),
    },
  },
  clientId: "test-client",
}));

vi.mock("@/auth/api-auth", () => ({
  verifyWorkosAccessToken: vi.fn(),
}));

vi.mock("@/api/auth-middleware", () => ({
  ensureUserFromClaims: vi.fn(),
  hasMembership: vi.fn(),
  listUserOrganizations: vi.fn(),
  sessionMiddleware: vi.fn(),
  orgMiddleware: vi.fn(),
}));

const { wellKnownRoutes } = await import("@/mcp/well-known");
const { authenticateMcpRequest } = await import("@/mcp/auth");
const { probeClientRegistrationSupport, resetRegistrationProbeForTests } =
  await import("@/mcp/registration-probe");
const apiAuth = await import("@/auth/api-auth");
const middleware = await import("@/api/auth-middleware");
const ceremony = await import("@infrawrench/server-core/trials/ceremony");
const principal = await import("@infrawrench/server-core/trials/principal");

/** Stubs the probe's fetch so route tests never reach the network. */
function stubProbeAsDocument(doc: Record<string, unknown>) {
  const fetchStub = vi.fn(async () => Response.json(doc));
  resetRegistrationProbeForTests(fetchStub as unknown as typeof fetch);
  return fetchStub;
}

describe("MCP well-known routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubProbeAsDocument({ client_id_metadata_document_supported: true });
    delete process.env["WORKOS_AUTHKIT_DOMAIN"];
    delete process.env["WORKOS_ISSUER"];
    delete process.env["PUBLIC_BASE_URL"];
    delete process.env["APP_URL"];
  });

  it("/oauth-protected-resource advertises the WorkOS authorization server", async () => {
    process.env["WORKOS_AUTHKIT_DOMAIN"] = "https://auth.example.com";
    process.env["PUBLIC_BASE_URL"] = "https://infrawrench.test";

    const res = await wellKnownRoutes.request("/oauth-protected-resource");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBe("https://infrawrench.test/api/mcp");
    expect(body.authorization_servers).toEqual(["https://auth.example.com"]);
    expect(body.bearer_methods_supported).toContain("header");
  });

  // RFC 9728 §3.1: clients derive the metadata URL from the resource path
  // rather than reading it off the WWW-Authenticate challenge.
  it("serves the same metadata at the resource-path-suffixed URL", async () => {
    process.env["WORKOS_AUTHKIT_DOMAIN"] = "https://auth.example.com";
    process.env["PUBLIC_BASE_URL"] = "https://infrawrench.test";

    const res = await wellKnownRoutes.request("/oauth-protected-resource/api/mcp");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBe("https://infrawrench.test/api/mcp");
    expect(body.authorization_servers).toEqual(["https://auth.example.com"]);
  });

  it("falls back to APP_URL so the resource keeps its https scheme", async () => {
    process.env["WORKOS_AUTHKIT_DOMAIN"] = "https://auth.example.com";
    process.env["APP_URL"] = "https://app.infrawrench.test";

    const res = await wellKnownRoutes.request("/oauth-protected-resource");
    const body = await res.json();
    expect(body.resource).toBe("https://app.infrawrench.test/api/mcp");
  });

  it("honours x-forwarded-proto when no explicit origin is configured", async () => {
    process.env["WORKOS_AUTHKIT_DOMAIN"] = "https://auth.example.com";

    const res = await wellKnownRoutes.request("/oauth-protected-resource", {
      headers: { "x-forwarded-proto": "https" },
    });
    const body = await res.json();
    expect(body.resource).toMatch(/^https:\/\//);
  });

  it("advertises only scopes the AuthKit server actually grants", async () => {
    process.env["WORKOS_AUTHKIT_DOMAIN"] = "https://auth.example.com";

    const res = await wellKnownRoutes.request("/oauth-protected-resource");
    const body = await res.json();
    expect(body.scopes_supported).toEqual(["openid", "profile", "email", "offline_access"]);
  });

  it("fails loudly instead of advertising a dead authorization server", async () => {
    const res = await wellKnownRoutes.request("/oauth-protected-resource");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("server_error");
  });

  it("/oauth-authorization-server redirects to the upstream metadata", async () => {
    process.env["WORKOS_AUTHKIT_DOMAIN"] = "https://auth.example.com";
    const res = await wellKnownRoutes.request("/oauth-authorization-server", {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://auth.example.com/.well-known/oauth-authorization-server",
    );
  });
});

describe("authenticateMcpRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when no Authorization header is present", async () => {
    const result = await authenticateMcpRequest(null);
    expect(result).toBeNull();
  });

  it("returns null when the header isn't Bearer", async () => {
    const result = await authenticateMcpRequest("Basic abc123");
    expect(result).toBeNull();
  });

  it("returns null when JWT verification fails", async () => {
    vi.mocked(apiAuth.verifyWorkosAccessToken).mockResolvedValue(null);
    const result = await authenticateMcpRequest("Bearer bogus");
    expect(result).toBeNull();
  });

  // The credential every anonymous registration actually holds. Routing it
  // through the JWT verifier was the bug that made the documented agent MCP
  // flow a guaranteed 401 — auth.md tells agents to bring this token here.
  it("authenticates an iwa_ credential without consulting the JWT verifier", async () => {
    vi.mocked(ceremony.resolveAgentCredential).mockResolvedValue("reg-1");
    vi.mocked(principal.resolveAgentPrincipal).mockResolvedValue({
      registrationId: "reg-1",
      organizationId: "org-trial",
      userId: "agent_reg-1",
      claimedByUserId: null,
      claimed: false,
      permissions: ["resources:read"],
      trialExpiresInMs: 60_000,
    });

    const result = await authenticateMcpRequest("Bearer iwa_secret");
    expect(result).toEqual({
      userId: "agent_reg-1",
      organizationId: "org-trial",
      agent: {
        registrationId: "reg-1",
        claimed: false,
        permissions: ["resources:read"],
        trialExpiresInMs: 60_000,
      },
    });
    expect(apiAuth.verifyWorkosAccessToken).not.toHaveBeenCalled();
  });

  it("returns null for an unknown or revoked iwa_ credential", async () => {
    vi.mocked(ceremony.resolveAgentCredential).mockResolvedValue(null);
    const result = await authenticateMcpRequest("Bearer iwa_revoked");
    expect(result).toBeNull();
    expect(apiAuth.verifyWorkosAccessToken).not.toHaveBeenCalled();
  });

  // AuthKit OAuth tokens issued to MCP clients are not guaranteed to carry an
  // org_id claim, and an MCP client has no org picker — fall back to the
  // caller's own memberships rather than 401.
  it("falls back to the caller's membership when the token has no org_id", async () => {
    vi.mocked(apiAuth.verifyWorkosAccessToken).mockResolvedValue({
      sub: "user_123",
      email: "u@example.com",
    } as never);
    vi.mocked(middleware.ensureUserFromClaims).mockResolvedValue({
      id: "user_123",
      email: "u@example.com",
    });
    vi.mocked(middleware.listUserOrganizations).mockResolvedValue([
      { id: "org_789", displayName: "Acme", role: "owner" },
    ]);

    const result = await authenticateMcpRequest("Bearer jwt-no-org");
    expect(result).toEqual({
      userId: "user_123",
      organizationId: "org_789",
      email: "u@example.com",
    });
    expect(middleware.hasMembership).not.toHaveBeenCalled();
  });

  it("picks the oldest membership when the caller belongs to several orgs", async () => {
    vi.mocked(apiAuth.verifyWorkosAccessToken).mockResolvedValue({
      sub: "user_123",
      email: "u@example.com",
    } as never);
    vi.mocked(middleware.ensureUserFromClaims).mockResolvedValue({
      id: "user_123",
      email: "u@example.com",
    });
    vi.mocked(middleware.listUserOrganizations).mockResolvedValue([
      { id: "org_old", displayName: "Old", role: "owner" },
      { id: "org_new", displayName: "New", role: "member" },
    ]);

    const result = await authenticateMcpRequest("Bearer jwt-multi-org");
    expect(result?.organizationId).toBe("org_old");
  });

  it("returns null when the caller belongs to no organization", async () => {
    vi.mocked(apiAuth.verifyWorkosAccessToken).mockResolvedValue({
      sub: "user_123",
      email: "u@example.com",
    } as never);
    vi.mocked(middleware.ensureUserFromClaims).mockResolvedValue({
      id: "user_123",
      email: "u@example.com",
    });
    vi.mocked(middleware.listUserOrganizations).mockResolvedValue([]);

    const result = await authenticateMcpRequest("Bearer jwt-no-orgs");
    expect(result).toBeNull();
  });

  it("returns userId/organizationId on success", async () => {
    vi.mocked(apiAuth.verifyWorkosAccessToken).mockResolvedValue({
      sub: "user_123",
      email: "u@example.com",
      org_id: "org_456",
    } as never);

    vi.mocked(middleware.ensureUserFromClaims).mockResolvedValue({
      id: "user_123",
      email: "u@example.com",
    });
    vi.mocked(middleware.hasMembership).mockResolvedValue(true);

    const result = await authenticateMcpRequest("Bearer jwt-good");
    expect(result).toEqual({
      userId: "user_123",
      organizationId: "org_456",
      email: "u@example.com",
    });
    expect(middleware.ensureUserFromClaims).toHaveBeenCalledWith("user_123", "u@example.com");
    expect(middleware.hasMembership).toHaveBeenCalledWith("user_123", "org_456");
  });

  it("returns null when the caller has no membership in the org_id", async () => {
    vi.mocked(apiAuth.verifyWorkosAccessToken).mockResolvedValue({
      sub: "user_123",
      email: "u@example.com",
      org_id: "org_456",
    } as never);
    vi.mocked(middleware.ensureUserFromClaims).mockResolvedValue({
      id: "user_123",
      email: "u@example.com",
    });
    vi.mocked(middleware.hasMembership).mockResolvedValue(false);

    const result = await authenticateMcpRequest("Bearer jwt-no-membership");
    expect(result).toBeNull();
  });
});

/*
 * The 2026-07-28 spec deprecates Dynamic Client Registration in favour of
 * Client ID Metadata Documents. Both are WorkOS Dashboard toggles, not code —
 * the probe's job is to tell the operator, from our logs, which of them the
 * configured authorization server actually advertises.
 */
describe("client registration probe", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("warns when the AS advertises neither CIMD nor DCR", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubProbeAsDocument({ issuer: "https://auth.example.com" });
    await probeClientRegistrationSupport("https://auth.example.com");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "neither Client ID Metadata Documents nor Dynamic Client Registration",
      ),
    );
  });

  it("reports CIMD support without warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    stubProbeAsDocument({ client_id_metadata_document_supported: true });
    await probeClientRegistrationSupport("https://auth.example.com");
    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Client ID Metadata Documents yes"));
  });

  it("still recognises DCR-only servers — the old way keeps working", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    stubProbeAsDocument({
      registration_endpoint: "https://auth.example.com/oauth2/register",
    });
    await probeClientRegistrationSupport("https://auth.example.com");
    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Dynamic Client Registration yes"));
  });

  it("probes once per TTL window", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchStub = stubProbeAsDocument({ client_id_metadata_document_supported: true });
    await probeClientRegistrationSupport("https://auth.example.com");
    await probeClientRegistrationSupport("https://auth.example.com");
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("never throws (or warns) when the AS is unreachable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    resetRegistrationProbeForTests(
      vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      }) as unknown as typeof fetch,
    );
    await probeClientRegistrationSupport("https://auth.example.com");
    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("could not probe"));
  });
});
