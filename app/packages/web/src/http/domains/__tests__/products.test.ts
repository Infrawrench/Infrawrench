import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

const mockDisabled = vi.fn();
const mockSet = vi.fn();

/**
 * Re-declared rather than imported: the real module reaches server-core's db
 * client, which throws at import time without DATABASE_URL, and the handler
 * branches on `instanceof`.
 */
class MockProductSettingsError extends Error {}

vi.mock("@infrawrench/server-core/products/settings", () => ({
  ProductSettingsError: MockProductSettingsError,
  disabledProducts: (...args: unknown[]) => mockDisabled(...args),
  setDisabledProducts: (...args: unknown[]) => mockSet(...args),
}));

const mockLogAudit = vi.fn();
vi.mock("../../../services/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const { productsDomain } = await import("@/http/domains/products/index");

const basePath = "/api/org/org-1/products";
const buildApp = (permissions?: string[]) =>
  buildTestApi(productsDomain, permissions ? { basePath, permissions } : { basePath });

const put = (body: unknown) => ({
  method: "PUT",
  body: JSON.stringify(body),
  headers: { "Content-Type": "application/json" },
});

beforeEach(() => {
  vi.clearAllMocks();
  mockDisabled.mockResolvedValue(["costs"]);
  mockSet.mockImplementation((_org: string, ids: string[]) => Promise.resolve(ids));
});

describe("GET /products", () => {
  it("answers the turned-off apps to any member", async () => {
    const res = await buildApp([]).request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ disabled: ["costs"] });
    expect(mockDisabled).toHaveBeenCalledWith("org-1");
  });
});

describe("PUT /products", () => {
  it("saves the list and records the change", async () => {
    const res = await buildApp(["org:settings:write"]).request(
      "/",
      put({ disabled: ["costs", "automation"] }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ disabled: ["costs", "automation"] });
    expect(mockSet).toHaveBeenCalledWith("org-1", ["costs", "automation"]);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "product_settings.update",
        entityId: "org-1",
        metadata: { disabled: ["costs", "automation"] },
      }),
    );
  });

  it("refuses a caller without org:settings:write", async () => {
    const res = await buildApp(["resources:read"]).request("/", put({ disabled: [] }));
    expect(res.status).toBe(403);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("answers 400 with the store's sentence for a refused app", async () => {
    mockSet.mockRejectedValue(new MockProductSettingsError("Unknown app: billing"));
    const res = await buildApp(["org:settings:write"]).request("/", put({ disabled: ["billing"] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown app: billing" });
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that is not a list of ids", async () => {
    const res = await buildApp(["org:settings:write"]).request("/", put({ disabled: "costs" }));
    expect(res.status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });
});
