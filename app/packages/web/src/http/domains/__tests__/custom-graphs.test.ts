import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

// The service runs graph scripts in the workflow-runtime sandbox against the
// org's real accounts; these tests are about the transport, so nothing of it
// is loaded and no script ever runs.
class FakeCustomGraphError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
  }
}
class FakePlanRequiredError extends Error {}

const service = {
  listCustomGraphs: vi.fn(),
  getCustomGraph: vi.fn(),
  createCustomGraph: vi.fn(),
  updateCustomGraph: vi.fn(),
  softDeleteCustomGraph: vi.fn(),
  generateCustomGraphTypings: vi.fn(),
  checkCustomGraphSource: vi.fn(),
  renderOrgCustomGraph: vi.fn(),
};
vi.mock("@/services/custom-graphs", () => ({
  CustomGraphError: FakeCustomGraphError,
  listCustomGraphs: (...a: unknown[]) => service.listCustomGraphs(...a),
  getCustomGraph: (...a: unknown[]) => service.getCustomGraph(...a),
  createCustomGraph: (...a: unknown[]) => service.createCustomGraph(...a),
  updateCustomGraph: (...a: unknown[]) => service.updateCustomGraph(...a),
  softDeleteCustomGraph: (...a: unknown[]) => service.softDeleteCustomGraph(...a),
  generateCustomGraphTypings: (...a: unknown[]) => service.generateCustomGraphTypings(...a),
  checkCustomGraphSource: (...a: unknown[]) => service.checkCustomGraphSource(...a),
  renderOrgCustomGraph: (...a: unknown[]) => service.renderOrgCustomGraph(...a),
}));
vi.mock("@/services/entitlements", () => ({ PlanRequiredError: FakePlanRequiredError }));

const { customGraphsDomain } = await import("@/http/domains/custom-graphs/index");

const basePath = "/api/org/org-1/custom-graphs";
const app = (permissions?: string[]) =>
  buildTestApi(customGraphsDomain, { basePath, ...(permissions ? { permissions } : {}) });

const row = {
  id: "g1",
  organizationId: "org-1",
  name: "Spend",
  description: null,
  source: "graph.render({})",
  createdByUserId: "user-1",
  sourceAuthorUserId: "user-1",
  deletedAt: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-02T00:00:00Z"),
};

const json = (body: unknown, method = "POST") => ({ method, body: JSON.stringify(body) });

describe("custom graph routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists summaries without the source", async () => {
    service.listCustomGraphs.mockResolvedValue([row]);
    const res = await app().request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      {
        id: "g1",
        name: "Spend",
        description: null,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
      },
    ]);
    expect(service.listCustomGraphs).toHaveBeenCalledWith("org-1");
  });

  it("creates with 201, passing the body and the author through", async () => {
    service.createCustomGraph.mockResolvedValue(row);
    const res = await app().request("/", json({ name: "Spend", source: "x" }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { id: string }).id).toBe("g1");
    expect(service.createCustomGraph).toHaveBeenCalledWith(
      "org-1",
      { name: "Spend", source: "x" },
      "user-1",
    );
  });

  it("answers the service's refusals with their status", async () => {
    service.createCustomGraph.mockRejectedValueOnce(new FakeCustomGraphError("name is required."));
    const bad = await app().request("/", json({}));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "name is required." });

    service.createCustomGraph.mockRejectedValueOnce(new FakePlanRequiredError("Upgrade"));
    const plan = await app().request("/", json({ name: "x" }));
    expect(plan.status).toBe(402);
    expect(await plan.json()).toEqual({ error: "Upgrade" });

    service.softDeleteCustomGraph.mockRejectedValueOnce(
      new FakeCustomGraphError("Custom graph not found.", 404),
    );
    const gone = await app().request("/nope", { method: "DELETE" });
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: "Custom graph not found." });
  });

  it("requires dashboards:write to write", async () => {
    const res = await app(["dashboards:read"]).request("/", json({ name: "x" }));
    expect(res.status).toBe(403);
    expect(service.createCustomGraph).not.toHaveBeenCalled();
  });

  it("serves the typings as text", async () => {
    service.generateCustomGraphTypings.mockResolvedValue("declare const graph: {};");
    const res = await app().request("/typings");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=UTF-8");
    expect(await res.text()).toBe("declare const graph: {};");
  });

  it("checks source, and refuses a body without it", async () => {
    service.checkCustomGraphSource.mockResolvedValue({
      diagnostics: [],
      hasErrors: false,
      degraded: false,
    });
    const res = await app().request("/check", json({ source: "graph" }));
    expect(res.status).toBe(200);
    expect(service.checkCustomGraphSource).toHaveBeenCalledWith("org-1", "graph");

    const missing = await app().request("/check", json({}));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "source is required" });
  });

  it("404s a missing graph", async () => {
    service.getCustomGraph.mockResolvedValue(null);
    const res = await app().request("/nope");
    expect(res.status).toBe(404);
  });

  it("renders with only the inputs given, and with none for an empty body", async () => {
    const result = {
      ok: true,
      spec: {},
      error: null,
      logs: [],
      renderedAt: "2026-10-01T00:00:00.000Z",
      durationMs: 3,
    };
    service.renderOrgCustomGraph.mockResolvedValue(result);
    const res = await app().request(
      "/g1/render",
      json({ controls: { region: "eu" }, button: "", trigger: "interaction" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(service.renderOrgCustomGraph).toHaveBeenCalledWith("org-1", "g1", {
      controls: { region: "eu" },
      trigger: "interaction",
    });

    const empty = await app().request("/g1/render", { method: "POST" });
    expect(empty.status).toBe(200);
    expect(service.renderOrgCustomGraph).toHaveBeenLastCalledWith("org-1", "g1", {});
  });

  it("refuses an invalid render request", async () => {
    const res = await app().request("/g1/render", json({ trigger: "cron" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid render request" });
    expect(service.renderOrgCustomGraph).not.toHaveBeenCalled();
  });
});
