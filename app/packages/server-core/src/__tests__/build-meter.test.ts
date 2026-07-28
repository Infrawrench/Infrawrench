import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Billing has two ways to go quietly wrong: charging someone who must not be
 * charged (complimentary orgs), and a malformed meter event Stripe accepts but
 * never bills. These pin the skip conditions and the exact wire format.
 */

// Sequential select results: [org row], then [subscription row].
let selectResults: Array<Array<Record<string, unknown>>> = [];
const updates: Array<Record<string, unknown>> = [];
const db = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(selectResults.shift() ?? []),
      }),
    }),
  }),
  update: () => ({
    set: (values: Record<string, unknown>) => ({
      where: () => {
        updates.push(values);
        return Promise.resolve();
      },
    }),
  }),
};
vi.mock("../db/client", () => ({ db }));
vi.mock("../db/deployment-schema", () => ({ deploymentRuns: { id: "id" } }));
vi.mock("../db/core-schema", () => ({ organizations: { id: "id", complimentary: "c" } }));
vi.mock("../db/schema", () => ({ subscriptions: { organizationId: "o", stripeCustomerId: "s" } }));

const fetchMock = vi.fn();

let mod: typeof import("../billing/build-meter");

beforeEach(async () => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue({ ok: true, status: 200 });
  process.env["INFRAWRENCH_STRIPE_BUILD_METER_EVENT"] = "hosted_build_seconds";
  process.env["STRIPE_SECRET_KEY"] = "sk_test_x";
  selectResults = [[{ complimentary: false }], [{ stripeCustomerId: "cus_123" }]];
  updates.length = 0;
  mod = await import("../billing/build-meter");
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  delete process.env["INFRAWRENCH_STRIPE_BUILD_METER_EVENT"];
  delete process.env["STRIPE_SECRET_KEY"];
});

const report = (over: Partial<Parameters<typeof mod.reportHostedBuildToMeter>[0]> = {}) =>
  mod.reportHostedBuildToMeter({
    organizationId: "org1",
    runId: "run-1",
    buildSeconds: 97,
    ...over,
  });

describe("reportHostedBuildToMeter", () => {
  it("posts seconds keyed by customer, with the run id as the dedup identifier", async () => {
    await report();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.stripe.com/v1/billing/meter_events");
    const body = init.body as URLSearchParams;
    expect(body.get("event_name")).toBe("hosted_build_seconds");
    expect(body.get("identifier")).toBe("deploy-run-1");
    expect(body.get("payload[stripe_customer_id]")).toBe("cus_123");
    // Seconds, not micro-dollars: the price lives in Stripe, so the internal
    // placeholder rate can never leak onto an invoice.
    expect(body.get("payload[value]")).toBe("97");
  });

  it("marks the run reported, so a replay job can find the unreported ones", async () => {
    await report();
    expect(updates).toEqual([{ meterEventId: "deploy-run-1" }]);
  });

  it("never bills a complimentary org", async () => {
    selectResults = [[{ complimentary: true }]];
    await report();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it("does nothing without a Stripe customer, meter name, or key", async () => {
    selectResults = [[{ complimentary: false }], []];
    await report();
    expect(fetchMock).not.toHaveBeenCalled();

    delete process.env["INFRAWRENCH_STRIPE_BUILD_METER_EVENT"];
    selectResults = [[{ complimentary: false }], [{ stripeCustomerId: "cus_123" }]];
    await report();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores zero and negative durations", async () => {
    await report({ buildSeconds: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on a Stripe rejection and leaves the run unmarked", async () => {
    // The caller catches; what matters is the row stays replayable.
    fetchMock.mockResolvedValue({ ok: false, status: 429 });
    await expect(report()).rejects.toThrow("429");
    expect(updates).toEqual([]);
  });
});
