import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPaymentSucceededEvent,
  occurredAtIso,
  parseMeasurement,
  postRevnuEvent,
  stripeMinorToMajor,
  type PaymentSucceededInput,
} from "../revnu";

const ANON = `ra_${"ab".repeat(16)}`;
const WHEN = "2026-08-27T09:14:36.000Z";

function event(overrides: Partial<PaymentSucceededInput> = {}) {
  const input: PaymentSucceededInput = {
    eventId: overrides.eventId ?? "cs_test_1",
    occurredAt: overrides.occurredAt ?? WHEN,
    amountMinor: "amountMinor" in overrides ? (overrides.amountMinor ?? null) : 4950,
    currency: "currency" in overrides ? (overrides.currency ?? null) : "usd",
    purchaseKind: "purchaseKind" in overrides ? (overrides.purchaseKind ?? null) : "subscription",
  };
  if (overrides.anonymousId !== undefined) input.anonymousId = overrides.anonymousId;
  if (overrides.consentState !== undefined) input.consentState = overrides.consentState;
  if (overrides.email !== undefined) input.email = overrides.email;
  if (overrides.phone !== undefined) input.phone = overrides.phone;
  return buildPaymentSucceededEvent(input);
}

describe("stripeMinorToMajor", () => {
  it("divides two-decimal currencies, including USD, by 100", () => {
    expect(stripeMinorToMajor(4950, "usd")).toEqual({ amount: 49.5, currency: "USD" });
    expect(stripeMinorToMajor(1250, "gbp")).toEqual({ amount: 12.5, currency: "GBP" });
    expect(stripeMinorToMajor(0, "USD")).toEqual({ amount: 0, currency: "USD" });
  });

  it("leaves Stripe zero-decimal currencies in major units", () => {
    expect(stripeMinorToMajor(500, "jpy")).toEqual({ amount: 500, currency: "JPY" });
    expect(stripeMinorToMajor(500, "krw")).toEqual({ amount: 500, currency: "KRW" });
  });

  it("divides Stripe three-decimal currencies by 1000", () => {
    for (const currency of ["bhd", "jod", "kwd", "omr", "tnd"]) {
      expect(stripeMinorToMajor(5120, currency)).toEqual({
        amount: 5.12,
        currency: currency.toUpperCase(),
      });
    }
    expect(stripeMinorToMajor(50, "kwd")).toEqual({ amount: 0.05, currency: "KWD" });
  });

  it("treats UGX and ISK as two-decimal, the way Stripe settles them", () => {
    expect(stripeMinorToMajor(500, "ugx")).toEqual({ amount: 5, currency: "UGX" });
    expect(stripeMinorToMajor(500, "isk")).toEqual({ amount: 5, currency: "ISK" });
  });

  it("omits an amount that is not a non-negative integer", () => {
    expect(stripeMinorToMajor(12.5, "USD")).toBeNull();
    expect(stripeMinorToMajor(-100, "USD")).toBeNull();
    expect(stripeMinorToMajor(100, "us")).toBeNull();
  });
});

describe("occurredAtIso", () => {
  it("accepts ISO strings, epoch seconds and epoch milliseconds", () => {
    expect(occurredAtIso(WHEN)).toBe(WHEN);
    expect(occurredAtIso(1_754_000_000)).toBe(new Date(1_754_000_000 * 1000).toISOString());
    expect(occurredAtIso(1_754_000_000_000)).toBe(new Date(1_754_000_000_000).toISOString());
  });

  it("rejects a malformed timestamp", () => {
    expect(occurredAtIso("not-a-date")).toBeNull();
    expect(occurredAtIso("")).toBeNull();
    expect(occurredAtIso(Number.NaN)).toBeNull();
    expect(occurredAtIso(-1)).toBeNull();
    expect(occurredAtIso(null)).toBeNull();
  });
});

describe("buildPaymentSucceededEvent", () => {
  it("reuses the checkout session id and converts the amount", () => {
    const first = event();
    const second = event();
    expect(first?.event_id).toBe("cs_test_1");
    expect(second?.event_id).toBe(first?.event_id);
    expect(first).toMatchObject({
      event_name: "payment_succeeded",
      occurred_at: WHEN,
      amount: 49.5,
      currency: "USD",
      properties: { purchase_kind: "subscription" },
    });
    expect(first).not.toHaveProperty("anonymous_id");
    expect(first).not.toHaveProperty("consent_state");
    expect(first).not.toHaveProperty("test");
    expect(first).not.toHaveProperty("reversal_of");
  });

  it("sends a saved denial and does not invent granted", () => {
    expect(event({ consentState: "denied" })?.consent_state).toBe("denied");
    expect(event({ consentState: "pending" })?.consent_state).toBe("pending");
    expect(event({ consentState: "granted" })?.consent_state).toBe("granted");
    expect(event({ consentState: null })).not.toHaveProperty("consent_state");
    expect(event({ consentState: "yes" })).not.toHaveProperty("consent_state");
  });

  it("omits a missing or invalid anonymous id", () => {
    expect(event({ anonymousId: null })).not.toHaveProperty("anonymous_id");
    expect(event({ anonymousId: "customer-1" })).not.toHaveProperty("anonymous_id");
    expect(event({ anonymousId: ANON })?.anonymous_id).toBe(ANON);
  });

  it("returns null for a malformed occurred_at", () => {
    expect(event({ occurredAt: "yesterday" })).toBeNull();
  });

  it("omits amount and currency together when either is unusable", () => {
    expect(event({ amountMinor: null })).not.toHaveProperty("amount");
    expect(event({ amountMinor: null })).not.toHaveProperty("currency");
    expect(event({ currency: null })).not.toHaveProperty("amount");
    expect(event({ amountMinor: -1 })).not.toHaveProperty("amount");
  });

  it("puts email and phone on the top level only", () => {
    const body = event({
      email: "buyer@example.com",
      phone: "+14155551212",
    });
    expect(body?.email).toBe("buyer@example.com");
    expect(body?.phone).toBe("+14155551212");
    expect(body?.properties).toEqual({ purchase_kind: "subscription" });
    expect(event({ email: "not an email" })).not.toHaveProperty("email");
  });

  it("does not invent a qualification property", () => {
    expect(event({ purchaseKind: null })?.properties).toBeUndefined();
    expect(JSON.stringify(event())).not.toContain("is_first_order");
    expect(JSON.stringify(event())).not.toContain("fullRefund");
  });
});

describe("parseMeasurement", () => {
  it("keeps a valid handoff and drops everything else", () => {
    expect(parseMeasurement({ anonymousId: ANON, consentState: "denied" })).toEqual({
      anonymousId: ANON,
      consentState: "denied",
    });
    expect(parseMeasurement({ anonymousId: "ra_short", consentState: "nope" })).toEqual({
      anonymousId: null,
      consentState: null,
    });
    expect(parseMeasurement(undefined).anonymousId).toBeNull();
  });
});

describe("postRevnuEvent", () => {
  const original = process.env["REVNU_EVENT_KEY"];

  afterEach(() => {
    vi.unstubAllGlobals();
    if (original === undefined) delete process.env["REVNU_EVENT_KEY"];
    else process.env["REVNU_EVENT_KEY"] = original;
  });

  it("does not call Revnu when the key is unset", async () => {
    delete process.env["REVNU_EVENT_KEY"];
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const body = event();
    expect(body).not.toBeNull();
    await expect(postRevnuEvent(body!)).resolves.toBe("unconfigured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [200, "accepted"],
    [202, "accepted"],
    [400, "rejected"],
    [401, "retry"],
    [409, "rejected"],
    [429, "retry"],
    [500, "retry"],
    [503, "retry"],
  ])("maps status %s to %s", async (status, result) => {
    process.env["REVNU_EVENT_KEY"] = "test-key";
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: Number(status) }));
    vi.stubGlobal("fetch", fetchMock);
    const body = event();
    await expect(postRevnuEvent(body!)).resolves.toBe(result);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://revnu.com/api/measurement/events");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer test-key");
    const sent = JSON.parse(String(init.body)) as { event_id: string; test?: boolean };
    expect(sent.event_id).toBe("cs_test_1");
    expect(sent.test).toBeUndefined();
  });

  it("retries the same event id after a network failure", async () => {
    process.env["REVNU_EVENT_KEY"] = "test-key";
    const fetchMock = vi.fn().mockRejectedValue(new Error("socket hang up"));
    vi.stubGlobal("fetch", fetchMock);
    const body = event();
    await expect(postRevnuEvent(body!)).resolves.toBe("retry");
    await expect(postRevnuEvent(body!)).resolves.toBe("retry");
    const ids = fetchMock.mock.calls.map((call) => {
      const init = call[1] as RequestInit;
      return (JSON.parse(String(init.body)) as { event_id: string }).event_id;
    });
    expect(ids).toEqual(["cs_test_1", "cs_test_1"]);
  });
});
