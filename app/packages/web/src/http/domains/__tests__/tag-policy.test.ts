import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

// The stores reach server-core's db client at import time: stub them at the
// boundary. These tests own the transport contract of the tag policy:
// permissions, validation and the audit trail.
const mockGetPolicy = vi.fn();
const mockSetPolicy = vi.fn();
const mockCompliance = vi.fn();
const mockLogAudit = vi.fn();

vi.mock("@infrawrench/server-core/cost/tag-policy", () => ({
  getOrgTagPolicy: (...args: unknown[]) => mockGetPolicy(...args),
  setOrgTagPolicy: (...args: unknown[]) => mockSetPolicy(...args),
}));
vi.mock("../../../services/tag-policy", () => ({
  getAccountTagCompliance: (...args: unknown[]) => mockCompliance(...args),
}));
vi.mock("../../../services/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const { tagPolicyDomain } = await import("@/http/domains/tag-policy/index");

const buildApp = (permissions: string[]) =>
  buildTestApi(tagPolicyDomain, { basePath: "/api/org/org-1/tag-policy", permissions });

const policy = { requiredTags: [{ key: "owner" }], enforceOnCreate: true };
const put = (body: unknown) => ({ method: "PUT", body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPolicy.mockResolvedValue(policy);
  mockSetPolicy.mockImplementation((_org: string, p: unknown) => Promise.resolve(p));
  mockCompliance.mockResolvedValue([]);
});

describe("GET /tag-policy", () => {
  it("needs resources:read", async () => {
    expect((await buildApp(["costs:read"]).request("/")).status).toBe(403);
    const res = await buildApp(["resources:read"]).request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(policy);
  });
});

describe("PUT /tag-policy", () => {
  it("needs org:settings:write", async () => {
    expect((await buildApp(["resources:read"]).request("/", put(policy))).status).toBe(403);
    expect(mockSetPolicy).not.toHaveBeenCalled();
  });

  it("saves the policy and audits the required keys", async () => {
    const res = await buildApp(["org:settings:write"]).request("/", put(policy));
    expect(res.status).toBe(200);
    expect(mockSetPolicy).toHaveBeenCalledWith("org-1", policy);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "tag_policy.update",
        entityId: "org-1",
        metadata: { requiredKeys: ["owner"], enforceOnCreate: true },
      }),
    );
  });

  it("refuses a policy without enforceOnCreate rather than defaulting it", async () => {
    const res = await buildApp(["org:settings:write"]).request(
      "/",
      put({ requiredTags: [{ key: "owner" }] }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("Invalid tag policy");
    expect(mockSetPolicy).not.toHaveBeenCalled();
  });
});

describe("GET /tag-policy/compliance", () => {
  it("answers the policy beside the per-account scores", async () => {
    const accounts = [
      {
        accountId: "a1",
        pluginId: "aws",
        displayName: "Prod",
        totalResources: 10,
        evaluated: 8,
        compliant: 6,
        score: 75,
      },
    ];
    mockCompliance.mockResolvedValue(accounts);
    const res = await buildApp(["resources:read"]).request("/compliance");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ policy, accounts });
  });
});
