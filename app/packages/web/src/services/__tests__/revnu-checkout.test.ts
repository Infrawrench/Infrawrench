import { afterEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

type Row = Record<string, unknown>;

let selected: Row[] = [];
const inserts: Row[] = [];
const updates: Row[] = [];

vi.mock("@/db/client", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(selected),
      }),
    }),
    insert: () => ({
      values: (value: Row) => {
        inserts.push(value);
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (value: Row) => ({
        where: () => {
          updates.push(value);
          const promise = Promise.resolve([{ id: "handoff-1" }]);
          return Object.assign(promise, {
            returning: () => Promise.resolve([{ id: "handoff-1" }]),
          });
        },
      }),
    }),
  },
}));

vi.mock("uuid", () => ({ v4: () => "handoff-uuid" }));

const { reportPaidCheckout, refreshUnreportedConsent, RevnuTemporaryError } =
  await import("../revnu-checkout");

const ANON = `ra_${"ab".repeat(16)}`;
const WHEN = 1_754_000_000;

function session(overrides: Partial<Stripe.Checkout.Session> = {}): Stripe.Checkout.Session {
  return {
    id: "cs_test_1",
    payment_status: "paid",
    mode: "subscription",
    amount_total: 2000,
    currency: "usd",
    metadata: { organizationId: "org-1" },
    customer_details: { email: "buyer@example.com", phone: null },
    ...overrides,
  } as Stripe.Checkout.Session;
}

function bodies(): Array<Record<string, unknown>> {
  return vi
    .mocked(fetch)
    .mock.calls.map((call) => JSON.parse(String(call[1]?.body)) as Record<string, unknown>);
}

describe("reportPaidCheckout", () => {
  const original = process.env["REVNU_EVENT_KEY"];

  afterEach(() => {
    selected = [];
    inserts.length = 0;
    updates.length = 0;
    vi.unstubAllGlobals();
    if (original === undefined) delete process.env["REVNU_EVENT_KEY"];
    else process.env["REVNU_EVENT_KEY"] = original;
  });

  it("posts the saved denial once and skips a redelivery", async () => {
    process.env["REVNU_EVENT_KEY"] = "test-key";
    selected = [
      {
        id: "row-1",
        anonymousId: ANON,
        consentState: "denied",
        googleAdUserData: "denied",
        googleAdPersonalization: "unknown",
        reportedAt: null,
      },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));

    await reportPaidCheckout(session(), WHEN);
    selected[0]!["reportedAt"] = new Date();
    await reportPaidCheckout(session(), WHEN);

    expect(bodies()).toEqual([
      expect.objectContaining({
        event_id: "cs_test_1",
        event_name: "payment_succeeded",
        anonymous_id: ANON,
        consent_state: "denied",
        google_ad_user_data: "denied",
        google_ad_personalization: "unknown",
        amount: 20,
        currency: "USD",
        email: "buyer@example.com",
        properties: { purchase_kind: "subscription" },
      }),
    ]);
    expect(bodies()[0]).not.toHaveProperty("test");
    expect(updates.some((update) => "reportedAt" in update)).toBe(true);
  });

  it("accepts 202 and still marks the checkout reported", async () => {
    process.env["REVNU_EVENT_KEY"] = "test-key";
    selected = [{ id: "row-1", consentState: null, reportedAt: null }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 202 })));
    await reportPaidCheckout(session(), WHEN);
    expect(bodies()[0]).not.toHaveProperty("consent_state");
    expect(bodies()[0]).not.toHaveProperty("anonymous_id");
    expect(bodies()[0]).toMatchObject({
      google_ad_user_data: "unknown",
      google_ad_personalization: "unknown",
    });
    expect(updates.some((update) => update["reportedAt"] instanceof Date)).toBe(true);
  });

  it("throws on 429 and 500 so the same event id can be retried", async () => {
    process.env["REVNU_EVENT_KEY"] = "test-key";
    selected = [{ id: "row-1", reportedAt: null }];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 429 }))
      .mockResolvedValueOnce(new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(reportPaidCheckout(session(), WHEN)).rejects.toBeInstanceOf(RevnuTemporaryError);
    await expect(reportPaidCheckout(session(), WHEN)).rejects.toBeInstanceOf(RevnuTemporaryError);
    expect(bodies().map((body) => body["event_id"])).toEqual(["cs_test_1", "cs_test_1"]);
    expect(updates.some((update) => "reportedAt" in update)).toBe(false);
  });

  it("does not retry a 400 or a 401", async () => {
    process.env["REVNU_EVENT_KEY"] = "test-key";
    selected = [{ id: "row-1", reportedAt: null }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 400 })));
    await reportPaidCheckout(session(), WHEN);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));
    await reportPaidCheckout(session(), WHEN);
    expect(updates.some((update) => "reportedAt" in update)).toBe(false);
  });

  it("leaves the webhook alone when the key is unset", async () => {
    delete process.env["REVNU_EVENT_KEY"];
    selected = [{ id: "row-1", reportedAt: null }];
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await reportPaidCheckout(session(), WHEN);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it("skips a malformed occurred_at without failing the purchase", async () => {
    process.env["REVNU_EVENT_KEY"] = "test-key";
    selected = [{ id: "row-1", reportedAt: null }];
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await reportPaidCheckout(session(), "not-a-date");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not report an unpaid session", async () => {
    process.env["REVNU_EVENT_KEY"] = "test-key";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await reportPaidCheckout(session({ payment_status: "unpaid" }), WHEN);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports from session metadata when no handoff row exists", async () => {
    process.env["REVNU_EVENT_KEY"] = "test-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    await reportPaidCheckout(
      session({
        metadata: { organizationId: "org-1", revnu_anonymous_id: ANON, kind: "capacity_slot" },
        mode: "payment",
      }),
      WHEN,
    );
    expect(bodies()[0]).toMatchObject({
      anonymous_id: ANON,
      google_ad_user_data: "unknown",
      properties: { purchase_kind: "capacity_slot" },
    });
    expect(bodies()[0]).not.toHaveProperty("consent_state");
    expect(inserts[0]).toMatchObject({
      stripeCheckoutSessionId: "cs_test_1",
      anonymousId: ANON,
      organizationId: "org-1",
    });
    expect(inserts[0]?.["reportedAt"]).toBeInstanceOf(Date);
  });
});

describe("refreshUnreportedConsent", () => {
  afterEach(() => {
    updates.length = 0;
  });

  it("writes a withdrawal onto the unfinished checkout", async () => {
    const updated = await refreshUnreportedConsent("org-1", {
      anonymousId: ANON,
      consentState: "denied",
      googleAdUserData: "unknown",
      googleAdPersonalization: "unknown",
    });
    expect(updated).toBe(1);
    expect(updates[0]).toMatchObject({
      consentState: "denied",
      googleAdUserData: "unknown",
      googleAdPersonalization: "unknown",
    });
  });

  it("does not touch rows when the visitor id is missing", async () => {
    const updated = await refreshUnreportedConsent("org-1", {
      anonymousId: null,
      consentState: "denied",
      googleAdUserData: null,
      googleAdPersonalization: null,
    });
    expect(updated).toBe(0);
    expect(updates).toEqual([]);
  });
});
