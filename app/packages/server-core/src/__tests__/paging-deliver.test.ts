import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The cooldown protocol every pager shares. The store is faked here because
 * what matters is the protocol around it — claim, fan out, roll back a claim
 * whose page reached nobody — not which table backs it.
 */

const sendOneShotPage = vi.fn(async () => ({ attempted: 1, succeeded: 1, failed: 0 }));

vi.mock("../twilio-pager", () => ({ sendOneShotPage }));

/**
 * All three transports sit behind `routeAlert` now, so that is the single seam
 * these tests mock. `alertReached` is the real predicate rather than a stub —
 * it decides whether a cooldown or claim is kept, and faking it would hide
 * exactly the bug it exists to prevent.
 */
// Defaults to a successful delivery: `routeAlert` never throws and always
// returns a result, so a mock that resolves `undefined` would fail tests in a
// way the real function cannot.
const routeAlert = vi.fn(async (..._args: unknown[]) => routed());
vi.mock("../alerts/route", () => ({
  routeAlert: (...a: unknown[]) => routeAlert(...a),
  alertReached: (r: { succeeded?: number; held?: number } | null | undefined) =>
    (r?.succeeded ?? 0) > 0 || (r?.held ?? 0) > 0,
}));

/** A delivery that reached one Slack channel and one phone. */
function routed(over: Record<string, unknown> = {}) {
  return {
    attempted: 2,
    succeeded: 2,
    byTransport: { push: 1, slack: 1, msTeams: 0 },
    attemptedByTransport: { push: 1, slack: 1, msTeams: 0 },
    held: 0,
    unrouted: false,
    matchedRuleIds: ["rule1"],
    // The tracked-Slack half of the result. Present by default because
    // `byTransport.slack` is 1 — a result claiming a Slack delivery with no
    // message to show for it is a shape the real function never returns.
    slackMessages: [{ installationId: "inst1", channelId: "C1", ts: "1722700000.000100" }],
    deliveryIds: [],
    ...over,
  };
}

/** A delivery that reached nobody — no rule matched, or every channel failed. */
function unroutedResult() {
  return routed({
    attempted: 0,
    succeeded: 0,
    byTransport: { push: 0, slack: 0, msTeams: 0 },
    attemptedByTransport: { push: 0, slack: 0, msTeams: 0 },
    matchedRuleIds: [],
    slackMessages: [],
    unrouted: true,
  });
}

const { deliverPage, pageKeyAndCooldown } = await import("../paging/deliver");
type Store = Parameters<typeof deliverPage>[1];

const AUDIENCE = {
  organizationId: "org1",
  name: "checkout-api",
  context: "Source: checkout-api",
  url: "https://app.example/org/org1",
  pushData: { type: "api_page" as const, orgId: "org1", source: "checkout-api", key: "default" },
};

/** A store that claims successfully and records what it was asked to do. */
function fakeStore(overrides: Partial<Store> = {}): Store & { released: unknown[] } {
  const released: unknown[] = [];
  return {
    read: async () => null,
    claim: async () => true,
    release: async (prior) => {
      released.push(prior);
    },
    released,
    ...overrides,
  } as Store & { released: unknown[] };
}

beforeEach(() => {
  vi.clearAllMocks();
  sendOneShotPage.mockResolvedValue({ attempted: 1, succeeded: 1, failed: 0 });
  routeAlert.mockResolvedValue(routed());
});

describe("pageKeyAndCooldown", () => {
  it("defaults the key and the cooldown", () => {
    expect(pageKeyAndCooldown({ message: "hi" })).toEqual({ key: "default", cooldownMinutes: 60 });
  });

  it("honours an explicit zero cooldown", () => {
    expect(pageKeyAndCooldown({ message: "hi", cooldownMinutes: 0 }).cooldownMinutes).toBe(0);
  });

  it("clamps a negative cooldown to zero rather than paging into the past", () => {
    expect(pageKeyAndCooldown({ message: "hi", cooldownMinutes: -5 }).cooldownMinutes).toBe(0);
  });
});

describe("deliverPage", () => {
  it("fans out and reports per-transport counts", async () => {
    const result = await deliverPage(AUDIENCE, fakeStore(), { message: "disk full" });
    expect(result).toMatchObject({ delivered: true, suppressed: false, sms: 1, push: 1 });
    expect(routeAlert).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org1", trigger: "workflowPages" }),
      // A page is the one call whose entire purpose is to interrupt, so it is
      // never held by a rule's quiet hours.
      expect.objectContaining({ bypassQuietHours: true }),
    );
  });

  it("prefers an explicit title over the source name", async () => {
    await deliverPage(AUDIENCE, fakeStore(), { message: "disk full", title: "Checkout" });
    expect(sendOneShotPage).toHaveBeenCalledWith("org1", "infrawrench: Checkout — disk full", {});
    expect(routeAlert).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Checkout" }),
      expect.anything(),
    );
  });

  it("only asks Twilio for voice when the caller did", async () => {
    await deliverPage(AUDIENCE, fakeStore(), { message: "wake up", voice: true });
    expect(sendOneShotPage).toHaveBeenCalledWith("org1", expect.any(String), { voice: true });
  });

  it("reports a losing claim as suppressed, with the time it can retry", async () => {
    const lastPagedAt = new Date("2026-07-01T00:00:00.000Z");
    const store = fakeStore({ read: async () => ({ lastPagedAt }), claim: async () => false });
    const result = await deliverPage(AUDIENCE, store, { message: "again", cooldownMinutes: 30 });

    expect(result).toMatchObject({ delivered: false, suppressed: true, sms: 0, push: 0 });
    expect(result.retryAt).toBe("2026-07-01T00:30:00.000Z");
    expect(sendOneShotPage).not.toHaveBeenCalled();
  });

  it("rolls the claim back when every transport reached nobody", async () => {
    sendOneShotPage.mockResolvedValue({ attempted: 0, succeeded: 0, failed: 0 });
    routeAlert.mockResolvedValue(unroutedResult());
    const prior = { lastPagedAt: new Date("2026-07-01T00:00:00.000Z") };
    const store = fakeStore({ read: async () => prior });

    const result = await deliverPage(AUDIENCE, store, { message: "nobody home" });

    expect(result.delivered).toBe(false);
    expect(result.suppressed).toBe(false);
    // The prior timestamp goes back, so the next attempt isn't stuck in a
    // cooldown started by a page nobody received.
    expect(store.released).toEqual([prior]);
  });

  it("keeps the claim when at least one transport succeeded", async () => {
    sendOneShotPage.mockResolvedValue({ attempted: 1, succeeded: 0, failed: 1 });
    routeAlert.mockResolvedValue(routed());
    const store = fakeStore();

    await deliverPage(AUDIENCE, store, { message: "partial" });

    expect(store.released).toEqual([]);
  });
});
