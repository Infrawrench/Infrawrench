import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

/**
 * The channel upsert. Adding a channel no longer decides what it receives —
 * that moved to `alert_rules` — so a channel row is just an identity plus a
 * cached name, and the upsert exists to make re-adding an existing channel
 * idempotent.
 *
 * What still needs pinning is the conflict half: it refreshes the name but must
 * not clobber a stored field the request omitted (`isPrivate` is the only one
 * left), and the org must own the installation before anything is written.
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

  it("inserts the channel under the caller's org with the name normalised", async () => {
    const captured = mockUpsert();
    const res = await postChannel({});
    expect(res.status).toBe(200);
    expect(captured.values).toMatchObject({
      organizationId: "org-1",
      installationId: "inst-1",
      channelId: "C1",
      channelName: "alerts", // the leading "#" is display sugar, not stored
      isPrivate: false,
    });
  });

  it("carries no trigger opt-ins — what a channel receives lives in alert_rules", async () => {
    const captured = mockUpsert();
    const res = await postChannel({ logMatchAlerts: false, weeklyDigest: true });
    expect(res.status).toBe(200);
    // Trigger names in the body are inert. Were any of them to reach the row
    // again, routing would have two sources of truth that could disagree.
    for (const trigger of [
      "syncIncidents",
      "budgetAlerts",
      "anomalyAlerts",
      "metricAlerts",
      "resourceDrift",
      "workflowPages",
      "providerIncidents",
      "expiryAlerts",
      "logMatchAlerts",
      "postureAlerts",
      "probeAlerts",
      "weeklyDigest",
    ]) {
      expect(captured.values, trigger).not.toHaveProperty(trigger);
      expect(captured.set, trigger).not.toHaveProperty(trigger);
    }
  });

  it("refreshes the cached name on re-add without touching omitted fields", async () => {
    const captured = mockUpsert();
    const res = await postChannel({});
    expect(res.status).toBe(200);
    expect(captured.set).toMatchObject({ channelName: "alerts" });
    // The request said nothing about visibility, so the stored value stands.
    expect(captured.set).not.toHaveProperty("isPrivate");
  });

  it("updates isPrivate when the request states it", async () => {
    const captured = mockUpsert();
    const res = await postChannel({ isPrivate: true });
    expect(res.status).toBe(200);
    expect(captured.values).toMatchObject({ isPrivate: true });
    expect(captured.set).toMatchObject({ isPrivate: true });
  });

  it("400s on a missing channel id or name, writing nothing", async () => {
    mockUpsert();
    expect((await postChannel({ channelId: "  " })).status).toBe(400);
    expect((await postChannel({ channelName: "#" })).status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("404s when the installation does not belong to the org", async () => {
    mockUpsert();
    const res = await postChannel({ installationId: "someone-elses" });
    expect(res.status).toBe(404);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
