import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

// Instantiation needs resources:write and resources:delete, passes the change
// freeze gate, and only then checks its body, in that order.
const mockInstantiate = vi.fn();
const mockActiveFreeze = vi.fn();
const mockLogAudit = vi.fn(async () => undefined);

vi.mock("@/services/audit", () => ({ logAudit: mockLogAudit }));
vi.mock("@infrawrench/server-core/change-freezes", () => ({
  findActiveChangeFreeze: (...args: unknown[]) => mockActiveFreeze(...args),
}));
vi.mock("@infrawrench/server-core/environments/store", () => ({
  EnvironmentInputError: class extends Error {},
  createEnvironmentTemplateRecord: vi.fn(),
  deleteEnvironmentTemplateRecord: vi.fn(),
  getEnvironmentInstance: vi.fn(async () => null),
  getEnvironmentSettings: vi.fn(),
  getEnvironmentTemplate: vi.fn(async () => null),
  listEnvironmentInstances: vi.fn(),
  listEnvironmentTemplates: vi.fn(),
  setEnvironmentSettings: vi.fn(),
  updateEnvironmentTemplateRecord: vi.fn(),
}));
vi.mock("@infrawrench/server-core/environments/capture", () => ({
  captureEnvironmentDraft: vi.fn(),
}));
vi.mock("@infrawrench/server-core/environments/instantiate", () => ({
  estimateEnvironmentInstantiation: vi.fn(),
  forgetEnvironmentInstance: vi.fn(),
  instantiateEnvironment: (...args: unknown[]) => mockInstantiate(...args),
  reconcileEnvironmentInstances: vi.fn(),
  tearDownEnvironment: vi.fn(),
}));
vi.mock("@infrawrench/server-core/environments/pass", () => ({
  runEnvironmentRepairPass: vi.fn(),
}));

const { environmentsDomain } = await import("@/http/domains/environments/index");
const basePath = "/api/org/org-1/environments";
const buildApp = (permissions?: readonly string[]) =>
  buildTestApi(environmentsDomain, { basePath, ...(permissions ? { permissions } : {}) });

const freeze = {
  id: "f1",
  organizationId: "org-1",
  name: "Launch",
  reason: "Big day",
  startsAt: new Date("2030-01-01T00:00:00.000Z"),
  endsAt: null,
  active: true,
  createdByUserId: null,
  endedByUserId: null,
  createdAt: new Date("2030-01-01T00:00:00.000Z"),
  updatedAt: new Date("2030-01-01T00:00:00.000Z"),
};

const instantiate = (body: unknown, headers?: Record<string, string>) =>
  buildApp().request("/templates/t1/instantiate", {
    method: "POST",
    body: JSON.stringify(body),
    ...(headers ? { headers } : {}),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockActiveFreeze.mockResolvedValue(null);
  mockInstantiate.mockResolvedValue({ id: "i1", status: "active", expiresAt: "x", members: [] });
});

describe("environment routes", () => {
  it("instantiates with 201, stringifying parameter values", async () => {
    const res = await instantiate({ name: "pr-12", ttlHours: 24, parameters: { size: 2 } });
    expect(res.status).toBe(201);
    expect(mockInstantiate.mock.calls[0]![2]).toEqual({
      name: "pr-12",
      ttlHours: 24,
      parameters: { size: "2" },
    });
  });

  it("needs resources:delete to instantiate", async () => {
    const res = await buildApp(["resources:write"]).request("/templates/t1/instantiate", {
      method: "POST",
      body: JSON.stringify({ name: "pr-12", ttlHours: 24 }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Missing permission: resources:delete" });
  });

  it("answers an active freeze with the 423 body, before checking the fields", async () => {
    mockActiveFreeze.mockResolvedValue(freeze);
    const res = await instantiate({ ttlHours: 24 });
    expect(res.status).toBe(423);
    expect(await res.json()).toEqual({
      error:
        'Change freeze "Launch" is in effect until it is ended by an admin. Destructive actions ' +
        'are blocked. Admins can retry with the "x-change-freeze-override: true" header to override.',
      code: "change_freeze_active",
      freeze: {
        id: "f1",
        name: "Launch",
        reason: "Big day",
        startsAt: "2030-01-01T00:00:00.000Z",
        endsAt: null,
      },
    });
    expect(mockInstantiate).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "change_freeze.block" }),
    );
  });

  it("lets a freezes:override holder through with the header", async () => {
    mockActiveFreeze.mockResolvedValue(freeze);
    const res = await instantiate(
      { name: "pr-12", ttlHours: 24 },
      { "x-change-freeze-override": "true" },
    );
    expect(res.status).toBe(201);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "change_freeze.override" }),
    );
  });

  it("requires a TTL", async () => {
    const res = await instantiate({ name: "pr-12" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "ttlHours is required; environments must expire" });
  });

  it("answers a missing template with its own sentence", async () => {
    const res = await buildApp().request("/templates/t9", { method: "GET" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Template not found" });
  });
});
