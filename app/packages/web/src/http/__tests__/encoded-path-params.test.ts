import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

// A path parameter carrying an encoded `/` (an ARN, a Kubernetes
// `namespace/name`) or `\`: the HttpApi router matches the route on the raw
// path and hands the handler the decoded value, as Hono's `c.req.param()`
// did, so the desktop's cloud transport may send one (its allowlist lets an
// encoded slash through inside a contract route's parameter, see
// `desktop/electron/cloud-allowlist.ts`). The service catalog's member
// removal is the route that needs it.
const mockGetRecord = vi.fn();
const mockRemove = vi.fn();
const mockRestore = vi.fn();
vi.mock("@infrawrench/server-core/service-catalog/store", () => ({
  ServiceInputError: class extends Error {},
  addServiceMembers: vi.fn(async () => 1),
  createServiceRecord: vi.fn(),
  deleteServiceRecord: vi.fn(),
  getServiceRecord: (...a: unknown[]) => mockGetRecord(...a),
  getServiceWire: vi.fn(async (_org: string, row: { id: string }) => ({
    service: { id: row.id },
    membership: { members: [], excluded: [] },
  })),
  listServicesWire: vi.fn(async () => []),
  removeServiceMember: (...a: unknown[]) => mockRemove(...a),
  restoreExcludedMember: (...a: unknown[]) => mockRestore(...a),
  updateServiceRecord: vi.fn(),
}));
vi.mock("@infrawrench/server-core/service-catalog/lookup", () => ({
  getServicesForResources: vi.fn(),
}));
vi.mock("@infrawrench/server-core/service-catalog/summary", () => ({
  buildServiceSummary: vi.fn(),
}));
vi.mock("@infrawrench/server-core/service-catalog/events", () => ({
  publishServiceChanged: vi.fn(async () => undefined),
}));
vi.mock("@infrawrench/server-core/scorecards/store", () => ({
  ensureDefaultScorecard: vi.fn(async () => undefined),
  listScorecardHistory: vi.fn(async () => ({})),
  listScorecardResults: vi.fn(async () => []),
  markScorecardsDue: vi.fn(async () => undefined),
}));
vi.mock("@/services/audit", () => ({ logAudit: vi.fn() }));

const { servicesDomain } = await import("@/http/domains/services/index");
const app = () => buildTestApi(servicesDomain, { basePath: "/api/org/org-1/services" });

const row = { id: "svc-1", name: "Checkout", slug: "checkout", tier: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRecord.mockResolvedValue(row);
  mockRemove.mockResolvedValue("removed");
});

describe("an encoded slash inside a path parameter", () => {
  it("reaches the member removal with the decoded ARN", async () => {
    const res = await app().request(
      "/svc-1/members/arn%3Aaws%3Aec2%3Aus-east-1%3A1%3Ainstance%2Fi-1",
      { method: "DELETE" },
    );

    expect(res.status).toBe(200);
    expect(mockGetRecord).toHaveBeenCalledWith("org-1", "svc-1");
    expect(mockRemove).toHaveBeenCalledWith(
      "org-1",
      row,
      "arn:aws:ec2:us-east-1:1:instance/i-1",
      "user-1",
    );
  });

  it("decodes a namespaced id and a backslash the same way, the query included", async () => {
    mockRestore.mockResolvedValue(true);

    const namespaced = await app().request("/svc-1/members/kube-system%2Fcoredns", {
      method: "DELETE",
    });
    const restored = await app().request("/svc-1/members/DOMAIN%5Cuser?restore=1", {
      method: "DELETE",
    });

    expect(namespaced.status).toBe(200);
    expect(mockRemove).toHaveBeenCalledWith("org-1", row, "kube-system/coredns", "user-1");
    expect(restored.status).toBe(200);
    expect(mockRestore).toHaveBeenCalledWith("svc-1", "DOMAIN\\user");
  });

  it("cannot reach another route: an encoded slash stays inside the parameter", async () => {
    // Decoded before routing, `svc-1/members/x` would be the members list's
    // POST target or a 404; routed raw, it is one service id.
    const res = await app().request("/svc-1%2Fmembers%2Fx/members/r1", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(mockGetRecord).toHaveBeenCalledWith("org-1", "svc-1/members/x");
  });
});
