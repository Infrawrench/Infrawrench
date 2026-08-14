import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Billing has two ways to go quietly wrong: charging someone who must not be
 * charged (complimentary orgs), and a malformed meter event Stripe accepts but
 * never bills. These pin the skip conditions and the exact wire format.
 */

import { fakePostgres } from "./helpers/fake-postgres";

// Real Drizzle over a recording driver against the real schema — the org and
// subscription lookups and the marker update render their actual SQL (and
// shadow-validate under test:postgres:shadow). Sequential results are queued:
// [org row], then [subscription row].
const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

/** The marker updates issued, as (params) of the rendered UPDATE statement. */
const updates = () => pg.queries.filter((q) => q.sql.startsWith('update "deployment_runs"'));

const fetchMock = vi.fn();

let mod: typeof import("../billing/build-meter");

beforeEach(async () => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue({ ok: true, status: 200 });
  process.env["INFRAWRENCH_STRIPE_BUILD_METER_EVENT"] = "hosted_build_seconds";
  process.env["STRIPE_SECRET_KEY"] = "sk_test_x";
  pg.reset();
  pg.queueRows([{ complimentary: false }]);
  pg.queueRows([{ stripeCustomerId: "cus_123" }]);
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
    expect(updates()).toHaveLength(1);
    // set "meter_event_id" = $1 where "id" = $2
    expect(updates()[0]!.params).toEqual(["deploy-run-1", "run-1"]);
  });

  it("never bills a complimentary org", async () => {
    pg.reset();
    pg.queueRows([{ complimentary: true }]);
    await report();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updates()).toEqual([]);
  });

  it("does nothing without a Stripe customer, meter name, or key", async () => {
    pg.reset();
    pg.queueRows([{ complimentary: false }]);
    pg.queueRows([]);
    await report();
    expect(fetchMock).not.toHaveBeenCalled();

    delete process.env["INFRAWRENCH_STRIPE_BUILD_METER_EVENT"];
    pg.reset();
    pg.queueRows([{ complimentary: false }]);
    pg.queueRows([{ stripeCustomerId: "cus_123" }]);
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
    expect(updates()).toEqual([]);
  });
});
