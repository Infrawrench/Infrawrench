import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

// The store reaches Postgres; these tests are about the transport: the
// keep/clear/set distinction, the `null` answer and the sentences.
class FakeOwnershipInputError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 = 400,
  ) {
    super(message);
  }
}
const mockUpsert = vi.fn();
const mockDelete = vi.fn();
const mockByResource = vi.fn();
vi.mock("@infrawrench/server-core/ownership/store", () => ({
  OwnershipInputError: FakeOwnershipInputError,
  deleteOwnership: (...a: unknown[]) => mockDelete(...a),
  getOwnershipByResource: (...a: unknown[]) => mockByResource(...a),
  listOwnerCandidates: vi.fn(async () => []),
  listOwnership: vi.fn(async () => ({ ownership: [] })),
  upsertOwnership: (...a: unknown[]) => mockUpsert(...a),
}));
const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mockLogAudit(...a) }));

const { ownershipDomain } = await import("@/http/domains/ownership/index");
const basePath = "/api/org/org-1/ownership";
const app = () => buildTestApi(ownershipDomain, { basePath });
const put = (body: unknown) => app().request("/", { method: "PUT", body: JSON.stringify(body) });

// Complete: a partial record under `null | ResourceOwnership` reads as the wrong type.
const record = {
  id: "o1",
  resourceId: "r1",
  accountId: "a1",
  pluginId: "aws",
  resourceTypeId: "ec2-instance",
  resourceName: "web-1",
  ownerUserId: null,
  ownerName: null,
  ownerEmail: null,
  ownerLabel: "SRE",
  purpose: null,
  ticketUrl: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ownership routes", () => {
  it("keeps an absent field, clears a null one and sets a string", async () => {
    mockUpsert.mockResolvedValue(record);
    const res = await put({ resourceId: "r1", ownerUserId: null, ownerLabel: "SRE" });
    expect(res.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledWith(
      "org-1",
      { resourceId: "r1", ownerUserId: null, ownerLabel: "SRE" },
      "user-1",
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "resource_ownership.set" }),
    );
  });

  it("answers null when the patch left nothing to record", async () => {
    mockUpsert.mockResolvedValue(null);
    const res = await put({ resourceId: "r1", ownerLabel: null });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("null");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "resource_ownership.clear" }),
    );
  });

  it("refuses a missing resource or a wrong-typed field in the route's words", async () => {
    expect(await (await put({ ownerLabel: "x" })).json()).toEqual({
      error: "resourceId is required",
    });
    expect(await (await put({ resourceId: "r1", purpose: 3 })).json()).toEqual({
      error: "ownerUserId, ownerLabel, purpose and ticketUrl must be strings",
    });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("answers the store's refusal with its status", async () => {
    mockUpsert.mockRejectedValue(new FakeOwnershipInputError("Resource not found", 404));
    const res = await put({ resourceId: "r1", purpose: "billing" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Resource not found" });
  });

  it("reads and clears one resource's record by query", async () => {
    mockByResource.mockResolvedValue(null);
    const read = await app().request("/resource?resourceId=r1");
    expect(await read.json()).toEqual({ ownership: null });
    const empty = await app().request("/resource?resourceId=");
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: "Missing resourceId" });
    mockDelete.mockResolvedValue(false);
    const gone = await app().request("/?resourceId=r1", { method: "DELETE" });
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: "No ownership recorded for this resource" });
    mockDelete.mockResolvedValue(true);
    const cleared = await app().request("/?resourceId=r1", { method: "DELETE" });
    expect(cleared.status).toBe(204);
  });

  it("refuses a request with no resourceId at all", async () => {
    const res = await app().request("/resource");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Missing resourceId");
  });
});
