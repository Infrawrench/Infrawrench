import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

const mockHasPermission = vi.fn();
vi.mock("@infrawrench/server-core/permissions/catalog", () => ({
  hasPermission: (...args: unknown[]) => mockHasPermission(...args),
}));

const { requirePermission } = await import("../permissions");

function ctxWith(permissions: readonly string[] | undefined) {
  // Minimal Hono Context stub exposing get("permissions").
  return {
    get: (k: string) => (k === "permissions" ? permissions : undefined),
  } as never;
}

describe("requirePermission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not throw when the permission is granted", () => {
    mockHasPermission.mockReturnValue(true);
    expect(() => requirePermission(ctxWith(["resources:read"]), "resources:read")).not.toThrow();
    expect(mockHasPermission).toHaveBeenCalledWith(["resources:read"], "resources:read");
  });

  it("throws a 403 HTTPException when missing", () => {
    mockHasPermission.mockReturnValue(false);
    try {
      requirePermission(ctxWith([]), "billing:write");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(HTTPException);
      expect((e as HTTPException).status).toBe(403);
      expect((e as HTTPException).message).toContain("billing:write");
    }
  });

  it("defaults to empty granted permissions when none set", () => {
    mockHasPermission.mockReturnValue(false);
    expect(() => requirePermission(ctxWith(undefined), "x:y")).toThrow(HTTPException);
    expect(mockHasPermission).toHaveBeenCalledWith([], "x:y");
  });

  it("the thrown exception serializes to a 403 response", async () => {
    mockHasPermission.mockReturnValue(false);
    const app = new Hono();
    app.get("/", (c) => {
      requirePermission(c, "team:read");
      return c.json({ ok: true });
    });
    const res = await app.request("/");
    expect(res.status).toBe(403);
  });
});
