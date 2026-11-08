import { beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { HttpFailure } from "@/http/errors";
import { buildTestApi } from "@/http/testing";

/**
 * The page behind the Teams anomaly card links: it checks the session itself
 * (bouncing a signed-out browser through sign-in), re-checks membership and
 * `costs:write`, reads and writes inside the member's cost visibility, and
 * guards the write with a double-submit CSRF pair.
 */

let sessionUser: string | null = "user1";
vi.mock("@/http/auth", () => ({
  authenticatePerson: () =>
    sessionUser
      ? Effect.succeed({
          session: { userId: sessionUser, email: "u@example.com" },
          refreshedSession: undefined,
        })
      : Effect.fail(new HttpFailure(401, { error: "Unauthorized" })),
}));

const permissions = vi.fn<() => string[]>();
vi.mock("@infrawrench/server-core/permissions", () => ({
  resolveEffectivePermissions: () => Promise.resolve({ permissions: permissions() }),
}));

const scoped = vi.fn();
vi.mock("@/auth/cost-visibility", () => ({
  withPrincipalCostVisibility: (orgId: string, principal: unknown, fn: () => Promise<unknown>) => {
    scoped(orgId, principal);
    return fn();
  },
}));

const getView = vi.fn();
vi.mock("@/services/cost-anomalies", () => ({
  getCostAnomalyView: (...a: unknown[]) => getView(...a),
}));

class FakeFeedbackError extends Error {}
const submit = vi.fn();
vi.mock("@/services/cost-anomaly-feedback", () => ({
  CostAnomalyFeedbackError: FakeFeedbackError,
  submitCostAnomalyFeedback: (...a: unknown[]) => submit(...a),
}));

const logAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

const { anomalyFeedbackLinkDomain } = await import("@/http/domains/anomaly-feedback-link/index");
const app = () => buildTestApi(anomalyFeedbackLinkDomain, { permissions: [] });

const anomaly = {
  id: "an-1",
  day: "2026-11-01",
  dimension: "service",
  dimensionKey: "AmazonEC2",
  actualCents: 12345,
  currency: "USD",
  feedback: null,
};

function form(fields: Record<string, string>, cookie = "csrf-1") {
  return app().request("/api/anomaly-feedback", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: `wos-session=sealed; anomaly_feedback_csrf=${cookie}`,
    },
    body: new URLSearchParams({ o: "org-1", a: "an-1", csrf: "csrf-1", ...fields }).toString(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionUser = "user1";
  permissions.mockReturnValue(["costs:write"]);
  getView.mockResolvedValue(anomaly);
  submit.mockResolvedValue({ anomaly, suppression: null });
});

describe("GET /api/anomaly-feedback", () => {
  const get = (query: string, cookie = true) =>
    app().request(`/api/anomaly-feedback?${query}`, {
      headers: cookie ? { cookie: "wos-session=sealed" } : {},
    });

  it("refuses an incomplete link", async () => {
    const res = await get("o=org-1");
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("text/html; charset=UTF-8");
    expect(await res.text()).toContain("This link is incomplete.");
  });

  it("bounces a signed-out browser through sign-in and back to the same link", async () => {
    const res = await get("o=org-1&a=an-1&v=unexpected", false);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `/api/auth/sign-in?return_to=${encodeURIComponent("/api/anomaly-feedback?o=org-1&a=an-1&v=unexpected")}`,
    );
    expect(getView).not.toHaveBeenCalled();
  });

  it("answers a session that does not authenticate as the session middleware did", async () => {
    sessionUser = null;
    const res = await get("o=org-1&a=an-1");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("refuses a non-member and a member without costs:write", async () => {
    permissions.mockReturnValue([]);
    const outsider = await get("o=org-1&a=an-1");
    expect(outsider.status).toBe(403);
    expect(await outsider.text()).toContain("You are not a member of the organization");

    permissions.mockReturnValue(["costs:read"]);
    const reader = await get("o=org-1&a=an-1");
    expect(reader.status).toBe(403);
    expect(await reader.text()).toContain("You need the costs:write permission");
    expect(getView).not.toHaveBeenCalled();
  });

  it("reads the anomaly inside the member's cost visibility", async () => {
    getView.mockResolvedValue(null);
    const res = await get("o=org-1&a=an-1");
    expect(scoped).toHaveBeenCalledWith("org-1", { userId: "user1" });
    expect(getView).toHaveBeenCalledWith("org-1", "an-1");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("That anomaly no longer exists.");
  });

  it("renders the form with the preselected verdict and a CSRF cookie the form echoes", async () => {
    const res = await get("o=org-1&a=an-1&v=unexpected");
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    const csrf = /^anomaly_feedback_csrf=([^;]+); /.exec(cookie)?.[1];
    expect(cookie).toBe(
      `anomaly_feedback_csrf=${csrf}; Max-Age=900; Path=/api/anomaly-feedback; HttpOnly; SameSite=Lax`,
    );
    const body = await res.text();
    expect(body).toContain(`<input type="hidden" name="csrf" value="${csrf}">`);
    expect(body).toContain('value="unexpected" checked');
    expect(body).toContain("<strong>AmazonEC2</strong>");
  });
});

describe("POST /api/anomaly-feedback", () => {
  it("refuses a form whose CSRF value does not match the cookie", async () => {
    const res = await form({ verdict: "expected" }, "other");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("This form expired.");
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses a form without a verdict", async () => {
    const res = await form({ verdict: "maybe" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Choose expected or unexpected.");
  });

  it("saves the feedback in the member's scope, clears the cookie and goes to Costs", async () => {
    const res = await form({
      verdict: "expected",
      reason: "not-a-reason",
      note: "  planned  ",
      recurrence: "weekly",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/\/org\/org-1\/costs$/);
    expect(res.headers.get("set-cookie")).toBe(
      "anomaly_feedback_csrf=; Max-Age=0; Path=/api/anomaly-feedback",
    );
    expect(scoped).toHaveBeenLastCalledWith("org-1", { userId: "user1" });
    expect(submit).toHaveBeenCalledWith(
      "org-1",
      "an-1",
      expect.objectContaining({ verdict: "expected", reason: null, note: "planned" }),
      "user1",
    );
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cost_anomaly.feedback", userId: "user1" }),
    );
  });

  it("answers the service's refusal as the page and an anomaly that is gone as a 404", async () => {
    submit.mockRejectedValueOnce(new FakeFeedbackError("Suppression already exists"));
    const refused = await form({ verdict: "expected" });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("Suppression already exists");

    submit.mockResolvedValueOnce(null);
    const gone = await form({ verdict: "unexpected" });
    expect(gone.status).toBe(404);
    expect(logAudit).not.toHaveBeenCalled();
  });
});
