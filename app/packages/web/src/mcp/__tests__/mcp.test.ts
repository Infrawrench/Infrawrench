import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db/client", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
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
  ensureMembership: vi.fn(),
  provisionUser: vi.fn(),
  sessionMiddleware: vi.fn(),
  orgMiddleware: vi.fn(),
}));

const { wellKnownRoutes } = await import("@/mcp/well-known");
const { authenticateMcpRequest } = await import("@/mcp/auth");
const apiAuth = await import("@/auth/api-auth");
const middleware = await import("@/api/auth-middleware");

describe("MCP well-known routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env["WORKOS_AUTHKIT_DOMAIN"];
    delete process.env["WORKOS_ISSUER"];
    delete process.env["PUBLIC_BASE_URL"];
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

  it("returns null when the token has no org_id claim", async () => {
    vi.mocked(apiAuth.verifyWorkosAccessToken).mockResolvedValue({
      sub: "user_123",
      email: "u@example.com",
    } as never);
    const result = await authenticateMcpRequest("Bearer jwt-no-org");
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
    vi.mocked(middleware.ensureMembership).mockResolvedValue(undefined);

    const result = await authenticateMcpRequest("Bearer jwt-good");
    expect(result).toEqual({
      userId: "user_123",
      organizationId: "org_456",
      email: "u@example.com",
    });
    expect(middleware.ensureUserFromClaims).toHaveBeenCalledWith("user_123", "u@example.com");
    expect(middleware.ensureMembership).toHaveBeenCalledWith("user_123", "org_456");
  });
});
