import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

class FakeOrgConfigError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
  }
}
class FakePlanRequiredError extends Error {}

const exportOrgConfig = vi.fn();
const planOrgConfig = vi.fn();
const applyOrgConfig = vi.fn();
const parseOrgConfigDocument = vi.fn();
vi.mock("@/services/org-config", () => ({
  OrgConfigError: FakeOrgConfigError,
  exportOrgConfig: (...a: unknown[]) => exportOrgConfig(...a),
  planOrgConfig: (...a: unknown[]) => planOrgConfig(...a),
  applyOrgConfig: (...a: unknown[]) => applyOrgConfig(...a),
  parseOrgConfigDocument: (...a: unknown[]) => parseOrgConfigDocument(...a),
  // The real one: which sections a parsed document carries.
  orgConfigDocumentSections: (doc: Record<string, unknown>) =>
    ["budgets", "workflows"].filter((s) => doc[s] !== undefined),
}));
vi.mock("@/services/entitlements", () => ({ PlanRequiredError: FakePlanRequiredError }));
const logAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {
    from: () => c,
    where: () => c,
    limit: () => c,
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej),
  };
  return c;
}
vi.mock("@/db/client", () => ({ db: { select: () => chain([{ name: "Acme" }]) } }));

const { orgConfigDomain } = await import("@/http/domains/org-config/index");

const app = (permissions?: string[]) =>
  buildTestApi(orgConfigDomain, {
    basePath: "/api/org/org-1/config",
    ...(permissions ? { permissions } : {}),
  });

const plan = {
  mode: "merge",
  changes: [],
  unresolved: [],
  counts: { create: 1, update: 0, delete: 0, unchanged: 2 },
};

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

describe("org config routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("exports the named sections under the org's name", async () => {
    exportOrgConfig.mockResolvedValue({ version: 1, budgets: [] });
    const res = await app().request("/export?sections=budgets");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"version":1,"budgets":[]}');
    expect(exportOrgConfig).toHaveBeenCalledWith("org-1", {
      organizationName: "Acme",
      sections: ["budgets"],
    });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "org_config.export", metadata: { sections: ["budgets"] } }),
    );
  });

  it("refuses an unknown section", async () => {
    const res = await app().request("/export?sections=budgets,nope");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /^Unknown section\(s\): nope\./,
    );
  });

  it("names the section permission an export is missing", async () => {
    const res = await app(["config:read", "budgets:read"]).request(
      "/export?sections=budgets,workflows",
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Missing permission: workflows:read (required for the "workflows" section)',
    });
    expect(exportOrgConfig).not.toHaveBeenCalled();
  });

  it("gates plan on config:read before reading the body", async () => {
    const res = await app(["budgets:read"]).request("/plan", post({ document: {} }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Missing permission: config:read" });
    expect(parseOrgConfigDocument).not.toHaveBeenCalled();
  });

  it("plans a wrapped document, defaulting to merge", async () => {
    parseOrgConfigDocument.mockReturnValue({ version: 1, budgets: [] });
    planOrgConfig.mockResolvedValue(plan);
    const res = await app().request("/plan", post({ document: { budgets: [] } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(plan);
    expect(parseOrgConfigDocument).toHaveBeenCalledWith({ budgets: [] });
    expect(planOrgConfig).toHaveBeenCalledWith(
      "org-1",
      { version: 1, budgets: [] },
      { mode: "merge", userId: "user-1" },
    );
  });

  it("takes a bare document as the whole body", async () => {
    parseOrgConfigDocument.mockReturnValue({ version: 1 });
    planOrgConfig.mockResolvedValue(plan);
    await app().request("/plan", post({ version: 1, mode: "replace" }));
    expect(parseOrgConfigDocument).toHaveBeenCalledWith({ version: 1, mode: "replace" });
    expect(planOrgConfig).toHaveBeenCalledWith(
      "org-1",
      { version: 1 },
      {
        mode: "replace",
        userId: "user-1",
      },
    );
  });

  it("answers the validator's refusal as a 400", async () => {
    parseOrgConfigDocument.mockImplementation(() => {
      throw new FakeOrgConfigError("Invalid config document at budgets.0.key: Invalid");
    });
    const res = await app().request("/apply", post({ document: { budgets: [{}] } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid config document at budgets.0.key: Invalid",
    });
  });

  it("needs each carried section's write permission to apply", async () => {
    parseOrgConfigDocument.mockReturnValue({ version: 1, workflows: [] });
    const res = await app(["config:write", "budgets:write"]).request(
      "/apply",
      post({ document: {} }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Missing permission: workflows:write (required for the "workflows" section)',
    });
    expect(applyOrgConfig).not.toHaveBeenCalled();
  });

  it("applies, audits the counts and answers a plan gate as 402", async () => {
    parseOrgConfigDocument.mockReturnValue({ version: 1, budgets: [] });
    applyOrgConfig.mockResolvedValueOnce({ ...plan, applied: true });
    const res = await app().request("/apply", post({ document: {}, mode: "replace" }));
    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "org_config.apply",
        metadata: { mode: "replace", sections: ["budgets"], created: 1, updated: 0, deleted: 0 },
      }),
    );

    applyOrgConfig.mockRejectedValueOnce(new FakePlanRequiredError("Upgrade to apply"));
    const gated = await app().request("/apply", post({ document: {} }));
    expect(gated.status).toBe(402);
    expect(await gated.json()).toEqual({ error: "Upgrade to apply" });
  });

  it("answers a body that is not JSON as the 500 it always was", async () => {
    const res = await app().request("/plan", { method: "POST", body: "{nope" });
    expect(res.status).toBe(500);
    expect(parseOrgConfigDocument).not.toHaveBeenCalled();
  });
});
