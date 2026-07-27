import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The cooldown protocol every pager shares. The store is faked here because
 * what matters is the protocol around it — claim, fan out, roll back a claim
 * whose page reached nobody — not which table backs it.
 */

const sendOneShotPage = vi.fn(async () => ({ attempted: 1, succeeded: 1, failed: 0 }));
const sendPushToOrg = vi.fn(async () => ({ attempted: 1, succeeded: 1 }));
const sendSlackToOrg = vi.fn(async () => ({ attempted: 0, succeeded: 0, failed: 0 }));
const sendMsTeamsToOrg = vi.fn(async () => ({ attempted: 0, succeeded: 0, failed: 0 }));

vi.mock("../twilio-pager", () => ({ sendOneShotPage }));
vi.mock("../push/dispatch", () => ({ sendPushToOrg }));
vi.mock("../slack", () => ({ sendSlackToOrg }));
vi.mock("../msteams", () => ({ sendMsTeamsToOrg }));

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
  sendPushToOrg.mockResolvedValue({ attempted: 1, succeeded: 1 });
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
    expect(sendPushToOrg).toHaveBeenCalledWith("org1", "workflowPages", {
      title: "checkout-api",
      body: "disk full",
      data: AUDIENCE.pushData,
    });
  });

  it("prefers an explicit title over the source name", async () => {
    await deliverPage(AUDIENCE, fakeStore(), { message: "disk full", title: "Checkout" });
    expect(sendOneShotPage).toHaveBeenCalledWith("org1", "infrawrench: Checkout — disk full", {});
    expect(sendSlackToOrg).toHaveBeenCalledWith(
      "org1",
      "workflowPages",
      expect.objectContaining({ title: "Checkout", url: AUDIENCE.url }),
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
    sendPushToOrg.mockResolvedValue({ attempted: 0, succeeded: 0 });
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
    sendPushToOrg.mockResolvedValue({ attempted: 1, succeeded: 1 });
    const store = fakeStore();

    await deliverPage(AUDIENCE, store, { message: "partial" });

    expect(store.released).toEqual([]);
  });
});
