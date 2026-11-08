import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";
import type { ApiKeyPrincipal } from "@/http/principal";

const mockCreateWsToken = vi.fn();
vi.mock("@/services/ws-tokens", () => ({
  createWsToken: (...a: unknown[]) => mockCreateWsToken(...a),
}));

const { wsTokenDomain } = await import("@/http/domains/ws-token/index");

function buildApp(permissions: string[], apiKey?: ApiKeyPrincipal) {
  return buildTestApi(wsTokenDomain, {
    basePath: "/api/org/org-1/ws-token",
    permissions,
    principal: { apiKey },
  });
}

describe("ws-token routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("issues a token when permitted", async () => {
    mockCreateWsToken.mockReturnValue("tok-abc");
    const res = await buildApp(["resources:execute"]).request("/", { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json()).token).toBe("tok-abc");
    // A person: no ceiling, so the socket resolves their role live.
    expect(mockCreateWsToken).toHaveBeenCalledWith("user-1", "org-1", undefined);
  });

  it("carries an API key's scopes onto the token, so the socket keeps its ceiling", async () => {
    mockCreateWsToken.mockReturnValue("tok-key");
    const res = await buildApp(["resources:execute"], {
      id: "key-1",
      scopes: ["resources:execute"],
    }).request("/", { method: "POST" });
    expect(res.status).toBe(200);
    expect(mockCreateWsToken).toHaveBeenCalledWith("user-1", "org-1", {
      scopes: ["resources:execute"],
    });
  });

  it("marks a token minted by an agent so its scopes are read as final", async () => {
    mockCreateWsToken.mockReturnValue("tok-agent");
    await buildApp(["resources:execute"], {
      id: "reg-1",
      scopes: ["resources:execute"],
      agentRegistrationId: "reg-1",
    }).request("/", { method: "POST" });
    expect(mockCreateWsToken).toHaveBeenCalledWith("user-1", "org-1", {
      scopes: ["resources:execute"],
      agentRegistrationId: "reg-1",
    });
  });

  it("returns 403 when the caller lacks resources:execute", async () => {
    const res = await buildApp(["resources:read"]).request("/", { method: "POST" });
    expect(res.status).toBe(403);
    expect(mockCreateWsToken).not.toHaveBeenCalled();
  });
});
