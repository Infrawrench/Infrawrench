import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

/**
 * The rule list's structural check: the body is `unknown` JSON, so a bad
 * discriminant or shape must be a 400 naming the rule and field, never a 500
 * or a rule that saves and silently routes nowhere.
 */
const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  list: vi.fn(),
  owned: vi.fn(),
  foreign: vi.fn(),
  cancel: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@infrawrench/server-core/alerts/rules", () => ({
  listAlertRules: (...a: unknown[]) => mocks.list(...a),
  replaceAlertRules: (...a: unknown[]) => mocks.replace(...a),
  resolveRoutingRules: vi.fn(),
}));
vi.mock("@infrawrench/server-core/alerts/destinations", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@infrawrench/server-core/alerts/destinations")>();
  return {
    canonicalDestination: real.canonicalDestination,
    destinationShapeError: real.destinationShapeError,
    foreignDestinationError: (...a: unknown[]) => mocks.foreign(...a),
    loadDestinationCatalog: vi.fn(),
    loadOwnedDestinations: (...a: unknown[]) => mocks.owned(...a),
  };
});
vi.mock("@infrawrench/server-core/alerts/ack", () => ({
  acknowledgeAlert: vi.fn(),
  cancelAlertDeliveries: (...a: unknown[]) => mocks.cancel(...a),
  listAlertDeliveries: vi.fn(),
}));
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mocks.audit(...a) }));

const { alertRulesDomain } = await import("@/http/domains/alert-rules/index");

const app = (permissions: string[] = ["org:settings:write"]) =>
  buildTestApi(alertRulesDomain, { basePath: "/api/org/org-1/alert-rules", permissions });

const put = (body: unknown, permissions?: string[]) =>
  app(permissions).request("/", { method: "PUT", body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.owned.mockResolvedValue({});
  mocks.list.mockResolvedValue([{ id: "rule-1" }]);
  mocks.foreign.mockReturnValue(null);
  mocks.audit.mockResolvedValue(undefined);
  mocks.replace.mockImplementation(async (_org, _user, rules: unknown[]) => rules);
});

describe("PUT /alert-rules", () => {
  it("requires org:settings:write before reading the body", async () => {
    const res = await put({ rules: [] }, ["costs:read"]);
    expect(res.status).toBe(403);
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("refuses a body without a rules array", async () => {
    const res = await put({ rules: "nope" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "rules must be an array" });
  });

  it("names the rule and the unknown condition field", async () => {
    const res = await put({ rules: [{ name: "a", conditions: [{ field: "colour" }] }] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Rule 1: Unknown condition field "colour"' });
  });

  it("names unknown triggers", async () => {
    const res = await put({
      rules: [{ name: "a", conditions: [{ field: "trigger", op: "in", values: ["nope", 3] }] }],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Rule 1: Unknown trigger(s): nope, 3" });
  });

  it("refuses a destination with no identifier", async () => {
    const res = await put({ rules: [{ name: "a", destinations: [{ kind: "slack" }] }] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Rule 1: A Slack destination needs a channelId" });
  });

  it("refuses a destination that is not an object", async () => {
    const res = await put({ rules: [{ name: "a", destinations: ["slack"] }] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Rule 1: Unknown destination "?"' });
  });

  it("refuses a rule id the org does not own", async () => {
    const res = await put({ rules: [{ id: "someone-elses", name: "a" }] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unknown rule id "someone-elses"' });
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("refuses a destination owned by another org", async () => {
    mocks.foreign.mockReturnValueOnce("That Slack channel is not connected to this organization");
    const res = await put({
      rules: [{ name: "a", destinations: [{ kind: "slack", channelId: "c-x" }] }],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Rule 1: That Slack channel is not connected to this organization",
    });
  });

  it("saves the normalised list in order and audits the names", async () => {
    const res = await put({
      rules: [
        { id: "rule-1", name: "  Pages  ", destinations: [{ kind: "push" }] },
        { name: "Rest", enabled: false, continueOnMatch: true },
      ],
    });
    expect(res.status).toBe(200);
    expect(mocks.replace).toHaveBeenCalledWith("org-1", "user-1", [
      {
        id: "rule-1",
        name: "Pages",
        enabled: true,
        position: 0,
        conditions: [],
        destinations: [{ kind: "push" }],
        continueOnMatch: false,
        quietHours: null,
        escalation: null,
      },
      {
        name: "Rest",
        enabled: false,
        position: 1,
        conditions: [],
        destinations: [],
        continueOnMatch: true,
        quietHours: null,
        escalation: null,
      },
    ]);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "alert_rules.replace",
        metadata: { ruleCount: 2, names: ["Pages", "Rest"] },
      }),
    );
  });
});

describe("POST /alert-rules/deliveries/cancel", () => {
  it("refuses a body without an ids array", async () => {
    const res = await app().request("/deliveries/cancel", {
      method: "POST",
      body: JSON.stringify({ ids: "d-1" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "ids must be an array" });
  });

  it("cancels the listed deliveries", async () => {
    mocks.cancel.mockResolvedValue(2);
    const res = await app().request("/deliveries/cancel", {
      method: "POST",
      body: JSON.stringify({ ids: ["d-1", "d-2"] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: 2 });
    expect(mocks.cancel).toHaveBeenCalledWith("org-1", ["d-1", "d-2"]);
  });
});
