import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi, type TestCaller } from "@/http/testing";

/**
 * The paging-provider routes only parse, gate and audit; the work is in
 * server-core (mocked here, since it reaches the db client at import time).
 */
class PagingProviderError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  act: vi.fn(),
  list: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@infrawrench/server-core/paging/providers", () => ({
  PagingProviderError,
  actOnPagerIncident: (...a: unknown[]) => mocks.act(...a),
  listPagerIncidents: (...a: unknown[]) => mocks.list(...a),
  listPagingDestinations: vi.fn(async () => ({ accounts: [] })),
  listPagingEvents: vi.fn(async () => []),
  listPagingProviders: vi.fn(async () => []),
  previewProviderOnCall: vi.fn(),
  syncPagingIncidents: vi.fn(),
  updatePagingProviderSettings: (...a: unknown[]) => mocks.update(...a),
}));
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mocks.audit(...a) }));

const { pagingProvidersDomain } = await import("@/http/domains/paging-providers/index");

function orgApp(mount: "paging-providers" | "paging-incidents", permissions: string[]) {
  const caller: TestCaller = {
    basePath: `/api/org/org-1/${mount}`,
    permissions,
    principal: {
      session: { userId: "user-1", email: "sam@example.com" },
    },
  };
  return buildTestApi(pagingProvidersDomain, caller);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PUT /paging-providers/:accountId/settings", () => {
  it("requires org:settings:write", async () => {
    const res = await orgApp("paging-providers", ["team:read"]).request("/acc-1/settings", {
      method: "PUT",
      body: JSON.stringify({ inboundEnabled: true }),
    });
    expect(res.status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("rejects a body without inboundEnabled", async () => {
    const res = await orgApp("paging-providers", ["org:settings:write"]).request(
      "/acc-1/settings",
      { method: "PUT", body: JSON.stringify({ webhookSecret: "x" }) },
    );
    expect(res.status).toBe(400);
  });

  it("passes the secret through and never audits it", async () => {
    mocks.update.mockResolvedValue({ account: { accountId: "acc-1" }, warning: null });
    const res = await orgApp("paging-providers", ["org:settings:write"]).request(
      "/acc-1/settings",
      { method: "PUT", body: JSON.stringify({ inboundEnabled: true, webhookSecret: "whsec_abc" }) },
    );
    expect(res.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith("org-1", "acc-1", {
      inboundEnabled: true,
      webhookSecret: "whsec_abc",
    });
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("whsec_abc");
  });

  it("maps a provider error to its status", async () => {
    mocks.update.mockRejectedValue(new PagingProviderError("No paging provider account", 404));
    const res = await orgApp("paging-providers", ["org:settings:write"]).request(
      "/acc-x/settings",
      { method: "PUT", body: JSON.stringify({ inboundEnabled: false }) },
    );
    expect(res.status).toBe(404);
  });
});

describe("/paging-incidents", () => {
  it("lists open incidents by default with incidents:read", async () => {
    mocks.list.mockResolvedValue([]);
    const res = await orgApp("paging-incidents", ["incidents:read"]).request("/");
    expect(res.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith("org-1", { status: "open" });
  });

  it("acknowledges as the signed-in member", async () => {
    mocks.act.mockResolvedValue({ id: "i1", accountId: "a1", externalId: "P1", reference: "#7" });
    const res = await orgApp("paging-incidents", ["incidents:write"]).request("/i1/acknowledge", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(mocks.act).toHaveBeenCalledWith("org-1", "i1", "acknowledge", "sam@example.com");
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "paging_incident.acknowledge" }),
    );
  });

  it("turns a provider's 401 into a 400, not a session expiry", async () => {
    mocks.act.mockRejectedValue(Object.assign(new Error("bad key"), { status: 401 }));
    const res = await orgApp("paging-incidents", ["incidents:write"]).request("/i1/resolve", {
      method: "POST",
    });
    expect(res.status).toBe(400);
  });
});
