import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

/**
 * Regression coverage for the channel upsert: re-adding an existing channel
 * must not reset per-trigger opt-ins the request omitted. The channel row is
 * upserted (`onConflictDoUpdate`), so the conflict-update SET must contain a
 * trigger column only when the request explicitly sent it — defaults belong
 * to the INSERT half only.
 */
const mockInsert = vi.fn();
const mockSelect = vi.fn();
vi.mock("@/db/client", () => ({
  db: {
    insert: (...a: unknown[]) => mockInsert(...a),
    select: (...a: unknown[]) => mockSelect(...a),
  },
}));

vi.mock("@infrawrench/server-core/slack", () => ({
  exchangeSlackCode: vi.fn(),
  isSlackConfigured: () => true,
  listSlackChannels: vi.fn(),
  recordSlackInstall: vi.fn(),
  sendSlackTest: vi.fn(),
  signSlackState: vi.fn(),
  slackAuthorizeUrl: vi.fn(),
  verifySlackState: vi.fn(),
}));

const { slackRoutes } = await import("@/api/routes/slack");
const buildApp = () => buildTestApp(slackRoutes);

/** The org owns installation inst-1 — the upsert's precondition. */
function mockLiveInstallations() {
  mockSelect.mockReturnValue({
    from: () => ({ where: () => Promise.resolve([{ id: "inst-1" }]) }),
  });
}

/** Capture the insert values and the conflict-update SET of the next upsert. */
function mockUpsert() {
  const captured: { values?: Record<string, unknown>; set?: Record<string, unknown> } = {};
  mockInsert.mockReturnValue({
    values: (v: Record<string, unknown>) => {
      captured.values = v;
      return {
        onConflictDoUpdate: (o: { set: Record<string, unknown> }) => {
          captured.set = o.set;
          return { returning: () => Promise.resolve([{ id: "ch-1" }]) };
        },
      };
    },
  });
  return captured;
}

const postChannel = (body: Record<string, unknown>) =>
  buildApp().request("/channels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      installationId: "inst-1",
      channelId: "C1",
      channelName: "#alerts",
      ...body,
    }),
  });

describe("POST /channels upsert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLiveInstallations();
  });

  it("applies trigger defaults on insert", async () => {
    const captured = mockUpsert();
    const res = await postChannel({});
    expect(res.status).toBe(200);
    expect(captured.values).toMatchObject({
      logMatchAlerts: true,
      expiryAlerts: true,
      metricAlerts: true,
      weeklyDigest: true,
      resourceDrift: false, // the one trigger that defaults off
    });
  });

  it("leaves omitted triggers unchanged when re-adding an existing channel", async () => {
    const captured = mockUpsert();
    const res = await postChannel({});
    expect(res.status).toBe(200);
    // A channel whose logMatchAlerts (or any other trigger) was disabled must
    // keep that stored value: the conflict-update SET may not mention it.
    for (const column of [
      "isPrivate",
      "syncIncidents",
      "budgetAlerts",
      "anomalyAlerts",
      "metricAlerts",
      "resourceDrift",
      "workflowPages",
      "providerIncidents",
      "expiryAlerts",
      "logMatchAlerts",
      "weeklyDigest",
    ]) {
      expect(captured.set, column).not.toHaveProperty(column);
    }
    expect(captured.set).toMatchObject({ channelName: "alerts" });
  });

  it("updates exactly the triggers the request explicitly sets", async () => {
    const captured = mockUpsert();
    const res = await postChannel({ logMatchAlerts: false, weeklyDigest: true });
    expect(res.status).toBe(200);
    expect(captured.set).toMatchObject({ logMatchAlerts: false, weeklyDigest: true });
    expect(captured.set).not.toHaveProperty("expiryAlerts");
    expect(captured.set).not.toHaveProperty("metricAlerts");
    expect(captured.values).toMatchObject({ logMatchAlerts: false, weeklyDigest: true });
  });

  it("404s when the installation does not belong to the org", async () => {
    mockUpsert();
    const res = await postChannel({ installationId: "someone-elses" });
    expect(res.status).toBe(404);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
