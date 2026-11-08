import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

const getObjectSharing = vi.fn();
const putObjectSharing = vi.fn();
const resetObjectSharing = vi.fn();
vi.mock("@/services/object-sharing", () => ({
  getObjectSharing: (...a: unknown[]) => getObjectSharing(...a),
  putObjectSharing: (...a: unknown[]) => putObjectSharing(...a),
  resetObjectSharing: (...a: unknown[]) => resetObjectSharing(...a),
}));
const logAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

const { ObjectNotVisibleError, ObjectAccessDeniedError } =
  await import("@/services/sharing-context");
const { sharingDomain } = await import("@/http/domains/sharing/index");

const app = (permissions?: string[]) =>
  buildTestApi(sharingDomain, {
    basePath: "/api/org/org-1/sharing",
    ...(permissions ? { permissions } : {}),
  });

const sharing = {
  objectType: "dashboard",
  objectId: "d1",
  orgAccess: "viewer",
  grants: [],
  callerLevel: "owner",
  inheritedFrom: null,
};

const put = (body: unknown) => ({ method: "PUT", body: JSON.stringify(body) });

describe("sharing routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses an unknown object type before checking any permission", async () => {
    const res = await app([]).request("/budget/b1");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown object type" });
  });

  it("gates on the object family's permission", async () => {
    const read = await app(["costs:read"]).request("/dashboard/d1");
    expect(read.status).toBe(403);
    expect(await read.json()).toEqual({ error: "Missing permission: dashboards:read" });

    const write = await app(["dashboards:read"]).request("/dashboard/d1", { method: "DELETE" });
    expect(write.status).toBe(403);
    expect(await write.json()).toEqual({ error: "Missing permission: dashboards:write" });
  });

  it("reads the document", async () => {
    getObjectSharing.mockResolvedValue(sharing);
    const res = await app(["dashboards:read"]).request("/dashboard/d1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(sharing);
    expect(getObjectSharing).toHaveBeenCalledWith("org-1", "dashboard", "d1");
  });

  it("answers the service's sharing errors as before", async () => {
    getObjectSharing.mockRejectedValueOnce(new ObjectNotVisibleError());
    const hidden = await app().request("/cost_report/r1");
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual({ error: "Not found" });

    resetObjectSharing.mockRejectedValueOnce(new ObjectAccessDeniedError("owner"));
    const denied = await app().request("/cost_report/r1", { method: "DELETE" });
    expect(denied.status).toBe(403);
  });

  it("checks the document field by field", async () => {
    const notObject = await app().request("/dashboard/d1", { method: "PUT", body: "nope" });
    expect(notObject.status).toBe(400);
    expect(await notObject.json()).toEqual({ error: "Expected a JSON object." });

    const level = await app().request(
      "/dashboard/d1",
      put({ orgAccess: "none", grants: [{ principalKind: "member", principalId: "u1" }] }),
    );
    expect(level.status).toBe(400);
    expect(await level.json()).toEqual({
      error: "Each grant's level must be owner, editor or viewer.",
    });
    expect(putObjectSharing).not.toHaveBeenCalled();
  });

  it("replaces the document and audits it", async () => {
    putObjectSharing.mockResolvedValue(sharing);
    const res = await app().request(
      "/dashboard/d1",
      put({
        orgAccess: "viewer",
        grants: [{ principalKind: "role", principalId: "r1", level: "editor", extra: true }],
      }),
    );
    expect(res.status).toBe(200);
    expect(putObjectSharing).toHaveBeenCalledWith(
      "org-1",
      "dashboard",
      "d1",
      {
        orgAccess: "viewer",
        grants: [{ principalKind: "role", principalId: "r1", level: "editor" }],
      },
      "user-1",
    );
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sharing.update",
        entityType: "dashboard",
        metadata: { orgAccess: "viewer", grants: 1 },
      }),
    );
  });

  it("resets to the default", async () => {
    resetObjectSharing.mockResolvedValue(undefined);
    const res = await app().request("/savings_view/v1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(resetObjectSharing).toHaveBeenCalledWith("org-1", "savings_view", "v1");
  });
});
