import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

// The service is mocked: it reaches Drizzle. These tests own the transport
// contract: permissions, validation, status codes, error mapping, audit.
const svc = {
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  referents: vi.fn(),
};

class FakeInUseError extends Error {
  constructor(readonly referents: unknown[]) {
    super("in use");
  }
}
class FakeLimitError extends Error {}
class FakeNameConflictError extends Error {}

vi.mock("../../../services/cost-scenarios", () => ({
  CostScenarioInUseError: FakeInUseError,
  CostScenarioLimitError: FakeLimitError,
  CostScenarioNameConflictError: FakeNameConflictError,
  listCostScenarioModels: (...a: unknown[]) => svc.list(...a),
  getCostScenarioModel: (...a: unknown[]) => svc.get(...a),
  createCostScenarioModel: (...a: unknown[]) => svc.create(...a),
  updateCostScenarioModel: (...a: unknown[]) => svc.update(...a),
  softDeleteCostScenarioModel: (...a: unknown[]) => svc.remove(...a),
  listCostScenarioReferents: (...a: unknown[]) => svc.referents(...a),
}));

const mockLogAudit = vi.fn();
vi.mock("../../../services/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const { costScenariosDomain } = await import("@/http/domains/cost-scenarios/index");

const app = (permissions?: string[]) =>
  buildTestApi(costScenariosDomain, {
    basePath: "/api/org/org-1/cost-scenarios",
    ...(permissions ? { permissions } : {}),
  });

const send = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const model = {
  id: "m-1",
  name: "New cluster",
  description: null,
  currency: "USD",
  adjustments: [],
  createdByUserId: "user-1",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

const input = {
  name: "New cluster",
  currency: "USD",
  adjustments: [
    { id: "a1", label: "Cluster", kind: "recurring", startDate: "2026-09-01", amountCents: 100 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  svc.list.mockResolvedValue([model]);
  svc.get.mockResolvedValue(model);
  svc.create.mockResolvedValue(model);
  svc.update.mockResolvedValue(model);
  svc.remove.mockResolvedValue(true);
  svc.referents.mockResolvedValue([]);
});

describe("scenario models", () => {
  it("lists under `models` with costs:read and refuses writes without costs:write", async () => {
    const res = await app(["costs:read"]).request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: [model] });
    expect((await app(["costs:read"]).request("/", send("POST", input))).status).toBe(403);
    expect(svc.create).not.toHaveBeenCalled();
  });

  it("creates with defaults filled in and audits the adjustment count", async () => {
    const res = await app().request("/", send("POST", input));
    expect(res.status).toBe(200);
    expect(svc.create).toHaveBeenCalledWith(
      "org-1",
      {
        ...input,
        adjustments: [
          {
            ...input.adjustments[0],
            endDate: null,
            currency: null,
            period: null,
            percent: null,
            scope: [],
          },
        ],
      },
      "user-1",
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "cost_scenario.create",
        metadata: { name: "New cluster", adjustments: 0 },
      }),
    );
  });

  it("refuses an invalid body with the route's sentence", async () => {
    const res = await app().request("/", send("POST", { name: "" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid scenario model" });
  });

  it("maps a name collision to 409 and any other service error to 400", async () => {
    svc.create.mockRejectedValueOnce(new FakeNameConflictError("taken"));
    const taken = await app().request("/", send("POST", input));
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: "taken" });

    svc.update.mockRejectedValueOnce(new Error("one_off takes no endDate"));
    const refused = await app().request("/m-1", send("PUT", input));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "one_off takes no endDate" });
  });

  it("404s an unknown model", async () => {
    svc.get.mockResolvedValue(null);
    svc.update.mockResolvedValue(null);
    svc.remove.mockResolvedValue(false);
    expect((await app().request("/nope")).status).toBe(404);
    expect((await app().request("/nope", send("PUT", input))).status).toBe(404);
    expect((await app().request("/nope", { method: "DELETE" })).status).toBe(404);
    expect((await app().request("/nope/referents")).status).toBe(404);
    expect(svc.referents).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("refuses to delete a referenced model, naming the referents", async () => {
    const referents = [{ kind: "budget", id: "b-1", name: "Prod" }];
    svc.remove.mockRejectedValue(new FakeInUseError(referents));
    const res = await app().request("/m-1", { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "in use", referents });
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("deletes and audits, and lists referents", async () => {
    const res = await app().request("/m-1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cost_scenario.delete", entityId: "m-1" }),
    );
    svc.referents.mockResolvedValue([{ kind: "cost_report", id: "r-1", name: "Monthly" }]);
    const refs = await app(["costs:read"]).request("/m-1/referents");
    expect(await refs.json()).toEqual({
      referents: [{ kind: "cost_report", id: "r-1", name: "Monthly" }],
    });
  });
});
