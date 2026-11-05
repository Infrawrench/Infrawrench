import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

type Row = Record<string, unknown>;

let selected: Row[] = [];
let selectError: Error | null = null;
let insertError: Error | null = null;
const inserts: Row[] = [];
const updates: Row[] = [];

vi.mock("@/db/client", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => (selectError ? Promise.reject(selectError) : Promise.resolve(selected)),
      }),
    }),
    insert: () => ({
      values: (value: Row) => {
        if (insertError) return Promise.reject(insertError);
        inserts.push(value);
        return Object.assign(Promise.resolve(), {
          onConflictDoNothing: () => Promise.resolve(),
        });
      },
    }),
    update: () => ({
      set: (value: Row) => ({
        where: () => {
          updates.push(value);
          return Object.assign(Promise.resolve([{ id: "handoff-1" }]), {
            returning: () => Promise.resolve([{ id: "handoff-1" }]),
          });
        },
      }),
    }),
  },
}));

vi.mock("uuid", () => ({ v4: () => "handoff-uuid" }));

const { queuePaidCheckout, refreshUnreportedConsent, saveCheckoutHandoff } =
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

function reset() {
  selected = [];
  selectError = null;
  insertError = null;
  inserts.length = 0;
  updates.length = 0;
}

describe("queuePaidCheckout", () => {
  const original = process.env["REVNU_EVENT_KEY"];

  beforeEach(() => {
    reset();
    process.env["REVNU_EVENT_KEY"] = "test-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (original === undefined) delete process.env["REVNU_EVENT_KEY"];
    else process.env["REVNU_EVENT_KEY"] = original;
  });

  it("freezes the event onto the row and calls nobody", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    selected = [{ id: "row-1", anonymousId: ANON, consentState: "granted", paidAt: null }];

    await queuePaidCheckout(session(), WHEN);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(updates[0]?.["paidAt"]).toBeInstanceOf(Date);
    expect(updates[0]?.["nextReportAt"]).toBeInstanceOf(Date);
    expect(updates[0]?.["reportPayload"]).toMatchObject({
      event_id: "cs_test_1",
      event_name: "payment_succeeded",
      anonymous_id: ANON,
      consent_state: "granted",
      amount: 20,
      currency: "USD",
      email: "buyer@example.com",
      properties: { purchase_kind: "subscription" },
    });
    expect(updates[0]?.["reportPayload"]).not.toHaveProperty("test");
  });

  it("does nothing on a redelivery, so the queued body never changes", async () => {
    selected = [{ id: "row-1", consentState: "granted", paidAt: new Date() }];
    await queuePaidCheckout(session(), WHEN);
    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
  });

  it("does not report a buyer who declined, and closes the row", async () => {
    selected = [{ id: "row-1", anonymousId: ANON, consentState: "denied", paidAt: null }];
    await queuePaidCheckout(session(), WHEN);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.["paidAt"]).toBeInstanceOf(Date);
    expect(updates[0]).toMatchObject({ anonymousId: null });
    expect(updates[0]).not.toHaveProperty("reportPayload");
    expect(updates[0]).not.toHaveProperty("nextReportAt");
    expect(inserts).toEqual([]);
  });

  it("reports a pending answer, without joining it to the visit", async () => {
    selected = [{ id: "row-1", anonymousId: ANON, consentState: "pending", paidAt: null }];
    await queuePaidCheckout(session(), WHEN);
    const payload = updates[0]?.["reportPayload"] as Row;
    expect(payload["consent_state"]).toBe("pending");
    expect(payload).not.toHaveProperty("anonymous_id");
  });

  it("sends pending when nothing was recorded, as on a desktop checkout", async () => {
    selected = [{ id: "row-1", anonymousId: null, consentState: null, paidAt: null }];
    await queuePaidCheckout(session(), WHEN);
    expect((updates[0]?.["reportPayload"] as Row)["consent_state"]).toBe("pending");
  });

  it("falls back to the session metadata when the handoff row was lost", async () => {
    await queuePaidCheckout(
      session({
        metadata: { organizationId: "org-1", revnu_anonymous_id: ANON, kind: "capacity_slot" },
        mode: "payment",
      }),
      WHEN,
    );
    expect(inserts[0]).toMatchObject({
      organizationId: "org-1",
      stripeCheckoutSessionId: "cs_test_1",
      anonymousId: ANON,
      consentState: "granted",
    });
    expect(inserts[0]?.["reportPayload"]).toMatchObject({
      anonymous_id: ANON,
      consent_state: "granted",
      properties: { purchase_kind: "capacity_slot" },
    });
  });

  it("treats a lost row with no visitor id as unanswered", async () => {
    await queuePaidCheckout(session(), WHEN);
    expect(inserts[0]).toMatchObject({ consentState: "pending", anonymousId: null });
  });

  it("ignores other purchases on the same Stripe account", async () => {
    await queuePaidCheckout(session({ mode: "payment", metadata: {} }), WHEN);
    expect(inserts).toEqual([]);
    expect(updates).toEqual([]);
  });

  it("does not queue an unpaid session", async () => {
    await queuePaidCheckout(session({ payment_status: "unpaid" }), WHEN);
    expect(inserts).toEqual([]);
    expect(updates).toEqual([]);
  });

  it("does not queue anything when the key is unset", async () => {
    delete process.env["REVNU_EVENT_KEY"];
    selected = [{ id: "row-1", paidAt: null }];
    await queuePaidCheckout(session(), WHEN);
    expect(updates).toEqual([]);
  });

  it("skips a malformed occurred_at without failing the purchase", async () => {
    selected = [{ id: "row-1", paidAt: null }];
    await queuePaidCheckout(session(), "not-a-date");
    expect(updates).toEqual([]);
  });

  it("never throws, because a redelivery would re-run the billing write", async () => {
    selectError = new Error("db down");
    await expect(queuePaidCheckout(session(), WHEN)).resolves.toBeUndefined();
  });

  it("does not log query parameters, which hold the buyer's email", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    selectError = new Error('Failed query, params: ["buyer@example.com"]');
    await queuePaidCheckout(session(), WHEN);
    expect(JSON.stringify(log.mock.calls)).not.toContain("buyer@example.com");
    log.mockRestore();
  });
});

describe("saveCheckoutHandoff", () => {
  beforeEach(reset);

  it("never throws, because the buyer already has a Stripe session", async () => {
    insertError = new Error("db down");
    await expect(
      saveCheckoutHandoff({
        organizationId: "org-1",
        createdByUserId: "user-1",
        stripeCheckoutSessionId: "cs_test_1",
        measurement: { anonymousId: null, consentState: "pending" },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("refreshUnreportedConsent", () => {
  beforeEach(reset);

  it("writes a withdrawal even with no visitor id", async () => {
    const updated = await refreshUnreportedConsent("org-1", "user-1", {
      anonymousId: null,
      consentState: "denied",
    });
    expect(updated).toBe(1);
    expect(updates[0]).toMatchObject({ consentState: "denied" });
  });

  it("does not touch rows without an answer", async () => {
    const updated = await refreshUnreportedConsent("org-1", "user-1", {
      anonymousId: ANON,
      consentState: null,
    });
    expect(updated).toBe(0);
    expect(updates).toEqual([]);
  });
});
