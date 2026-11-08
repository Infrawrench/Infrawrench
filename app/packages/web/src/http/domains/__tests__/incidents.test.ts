import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

/**
 * Incident mode's wire: the store's parsers own the 400 sentences, anything
 * else a store call throws is a logged 500 with the route's own sentence, and
 * declaring answers 201. The services are mocked (they reach the database,
 * Slack and the status pages).
 */
class IncidentInputError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message);
    this.status = status;
  }
}

const mocks = vi.hoisted(() => ({
  declare: vi.fn(),
  patch: vi.fn(),
  get: vi.fn(),
  deleteRecord: vi.fn(),
  deleteNote: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@infrawrench/server-core/incidents/store", () => ({
  IncidentInputError,
  deleteIncidentNoteRecord: (...a: unknown[]) => mocks.deleteNote(...a),
  deleteIncidentRecord: (...a: unknown[]) => mocks.deleteRecord(...a),
  listIncidentRecords: vi.fn(async () => []),
  parseIncidentSeverity: (raw: unknown) => {
    if (raw === undefined || raw === null) return undefined;
    if (raw !== "sev1" && raw !== "sev2")
      throw new IncidentInputError(`Unknown severity "${String(raw)}".`);
    return raw;
  },
  parseIncidentStatus: (raw: unknown) => (raw === undefined ? undefined : raw),
  parseIncidentTimestamp: () => undefined,
}));
vi.mock("@/services/incidents", () => ({
  addNote: vi.fn(),
  affectedServices: vi.fn(async () => []),
  assembleIncidentTimeline: vi.fn(),
  buildPostmortem: vi.fn(),
  declareIncident: (...a: unknown[]) => mocks.declare(...a),
  getIncidentRecord: (...a: unknown[]) => mocks.get(...a),
  listIncidentNoteRecords: vi.fn(async () => []),
  patchIncident: (...a: unknown[]) => mocks.patch(...a),
  retryIncidentArtifacts: vi.fn(),
}));
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mocks.audit(...a) }));

const { incidentsDomain } = await import("@/http/domains/incidents/index");
const app = (permissions?: string[]) =>
  buildTestApi(incidentsDomain, {
    basePath: "/api/org/org-1/incidents",
    ...(permissions ? { permissions } : {}),
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /incidents", () => {
  it("is open to incidents:write and answers 201 with the declared incident", async () => {
    mocks.declare.mockResolvedValue({ id: "i1", title: "Down" });
    const res = await app(["incidents:write"]).request("/", {
      method: "POST",
      body: JSON.stringify({ title: "Down", severity: "sev1", summary: null }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "i1", title: "Down" });
    const [org, input, actor] = mocks.declare.mock.calls[0]!;
    expect(org).toBe("org-1");
    expect(input).toMatchObject({ title: "Down", severity: "sev1", summary: null });
    expect(actor).toMatchObject({ userId: "user-1", permissions: ["incidents:write"] });
  });

  it("answers the parser's 400 sentence", async () => {
    const res = await app().request("/", {
      method: "POST",
      body: JSON.stringify({ title: "Down", severity: "sev9" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unknown severity "sev9".' });
    expect(mocks.declare).not.toHaveBeenCalled();
  });

  it("answers anything else as the route's 500", async () => {
    mocks.declare.mockRejectedValue(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await app().request("/", { method: "POST", body: JSON.stringify({ title: "x" }) });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Incident operation failed" });
    spy.mockRestore();
  });

  it("refuses with 403 without incidents:write", async () => {
    const res = await app(["incidents:read"]).request("/", { method: "POST", body: "{}" });
    expect(res.status).toBe(403);
  });
});

describe("PATCH /incidents/:incidentId", () => {
  it("404s an unknown incident", async () => {
    mocks.patch.mockResolvedValue(null);
    const res = await app().request("/nope", {
      method: "PATCH",
      body: JSON.stringify({ issueUrl: "" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Incident not found" });
    expect(mocks.patch.mock.calls[0]![2]).toEqual({ issueUrl: null });
  });
});

describe("DELETE /incidents/:incidentId/notes/:noteId", () => {
  it("says which of the two was missing", async () => {
    mocks.get.mockResolvedValue({ id: "i1", affectedResourceIds: [] });
    mocks.deleteNote.mockResolvedValue(false);
    const res = await app().request("/i1/notes/n1", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Note not found" });
  });
});

describe("DELETE /incidents/:incidentId", () => {
  it("answers an empty 204 after the audit row", async () => {
    mocks.deleteRecord.mockResolvedValue(true);
    const res = await app().request("/i1", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "incident.delete", entityId: "i1" }),
    );
  });
});
