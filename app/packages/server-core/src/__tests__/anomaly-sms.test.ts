import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The rendering half of the batched anomaly text.
 *
 * Everything here is about one constraint: `sendOneShotPage` truncates at 320
 * characters, and its truncation cuts mid-word and would eat the trailing
 * "and N more" — the one part of the message that says the list is partial. So
 * the body is *built* to fit rather than trimmed to fit, and these tests pin
 * that at the sizes real provider and service keys reach.
 *
 * Same split as `drift-summary.test.ts`: the pure part, without mocks doing the
 * work. The claim protocol and the fan-out are exercised end to end in
 * `anomaly-eval.test.ts`.
 */

const sendOneShotPage = vi.fn(async () => ({ attempted: 1, succeeded: 1, failed: 0 }));
vi.mock("../twilio-pager", () => ({ sendOneShotPage }));

const claimAnomalySmsWindow = vi.fn(
  async (): Promise<{ claimed: boolean; prior: Date | null }> => ({ claimed: true, prior: null }),
);
const releaseAnomalySmsWindow = vi.fn(async () => undefined);
vi.mock("../cost/anomaly-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cost/anomaly-settings")>();
  return { ...actual, claimAnomalySmsWindow, releaseAnomalySmsWindow };
});
vi.mock("../db/client", () => ({ db: {} }));
vi.mock("../db/schema", () => ({ orgCostAnomalySettings: {} }));

const { formatAnomalySmsBody, pageAboutAnomalies, SMS_BODY_MAX } =
  await import("../cost/anomaly-sms");

type Item = Parameters<typeof formatAnomalySmsBody>[0][number];

function spike(overrides: Partial<Item> = {}): Item {
  return {
    day: "2026-07-14",
    kind: "spike",
    dimension: "service",
    dimensionKey: "Amazon EC2",
    currency: "USD",
    actual: 2100,
    mean: 310,
    ...overrides,
  };
}

function newSource(overrides: Partial<Item> = {}): Item {
  return spike({ kind: "new_source", mean: 0, ...overrides });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  sendOneShotPage.mockResolvedValue({ attempted: 1, succeeded: 1, failed: 0 });
  claimAnomalySmsWindow.mockResolvedValue({ claimed: true, prior: null });
});

describe("formatAnomalySmsBody", () => {
  it("says the day, what spiked, and what it cost against what", () => {
    const body = formatAnomalySmsBody([spike()]);
    expect(body).toBe(
      "infrawrench cost anomalies 2026-07-14: 1 flagged — Amazon EC2 $2,100 vs $310/day",
    );
  });

  it("leads with the fact that a new source is new, and has no baseline to cite", () => {
    const body = formatAnomalySmsBody([newSource({ dimensionKey: "BigQuery", actual: 900 })]);
    expect(body).toContain("new service BigQuery $900");
    expect(body).not.toContain("/day");
  });

  it("spans the days when a pass flags more than one", () => {
    const body = formatAnomalySmsBody([
      spike({ day: "2026-07-12" }),
      spike({ day: "2026-07-14", dimensionKey: "S3" }),
    ]);
    expect(body).toContain("2026-07-12–2026-07-14");
  });

  it("names three and collapses the remainder into a count", () => {
    const items = Array.from({ length: 9 }, (_, i) => spike({ dimensionKey: `svc-${i}` }));
    const body = formatAnomalySmsBody(items);
    expect(body).toContain("9 flagged");
    expect(body).toContain("svc-2");
    expect(body).not.toContain("svc-3");
    expect(body).toMatch(/and 6 more$/);
  });

  it("keeps the total and the overflow count when every key is enormous", () => {
    // Provider and service keys are stored up to 256 chars. Nothing here may
    // reach the transport's truncation, because that cut lands mid-word and
    // takes "and N more" with it.
    const items = Array.from({ length: 40 }, (_, i) =>
      spike({ dimensionKey: `${"Amazon Elastic Compute Cloud".repeat(9)}-${i}` }),
    );
    const body = formatAnomalySmsBody(items);
    expect(body.length).toBeLessThanOrEqual(SMS_BODY_MAX);
    expect(body).toContain("40 flagged");
    expect(body).toMatch(/and \d+ more$|See the Costs panel$/);
    expect(body.endsWith("…")).toBe(false);
  });

  it("shortens one absurd key rather than dropping the only item", () => {
    const body = formatAnomalySmsBody([spike({ dimensionKey: "x".repeat(400) })]);
    expect(body.length).toBeLessThanOrEqual(SMS_BODY_MAX);
    expect(body).toBe(
      `infrawrench cost anomalies 2026-07-14: 1 flagged — ${"x".repeat(27)}… $2,100 vs $310/day`,
    );
  });

  it("survives a currency Intl cannot format", () => {
    const body = formatAnomalySmsBody([spike({ currency: "XYZ123", actual: 12, mean: 3 })]);
    expect(body).toContain("12.00 XYZ123");
  });
});

describe("pageAboutAnomalies", () => {
  it("sends nothing, and claims nothing, when the org opted out", async () => {
    const outcome = await pageAboutAnomalies("org1", "off", [spike()]);
    expect(outcome).toEqual({ status: "disabled" });
    expect(claimAnomalySmsWindow).not.toHaveBeenCalled();
    expect(sendOneShotPage).not.toHaveBeenCalled();
  });

  it("does not claim a window for a pass with nothing the org wants", async () => {
    const outcome = await pageAboutAnomalies("org1", "new_source", [spike()]);
    expect(outcome).toEqual({ status: "nothing-to-send" });
    expect(claimAnomalySmsWindow).not.toHaveBeenCalled();
  });

  it("is SMS only — a cost anomaly does not ring a phone", async () => {
    await pageAboutAnomalies("org1", "all", [spike()]);
    expect(sendOneShotPage).toHaveBeenCalledTimes(1);
    // No options argument at all: `sendOneShotPage` leaves voice off unless a
    // caller asks, the same rule budget alerts follow.
    expect(sendOneShotPage.mock.calls[0]).toHaveLength(2);
  });

  it("reports a lost race as cooling down rather than as a failure", async () => {
    claimAnomalySmsWindow.mockResolvedValue({ claimed: false, prior: null });
    const outcome = await pageAboutAnomalies("org1", "all", [spike()]);
    expect(outcome).toEqual({ status: "cooling-down" });
    expect(sendOneShotPage).not.toHaveBeenCalled();
  });

  it("releases the claim when nobody was reachable", async () => {
    const prior = new Date("2026-07-15T00:00:00Z");
    claimAnomalySmsWindow.mockResolvedValue({ claimed: true, prior });
    sendOneShotPage.mockResolvedValue({ attempted: 0, succeeded: 0, failed: 0 });
    const now = new Date("2026-07-15T12:00:00Z");

    const outcome = await pageAboutAnomalies("org1", "all", [spike()], now);

    expect(outcome).toEqual({ status: "undelivered", anomalies: 1 });
    expect(releaseAnomalySmsWindow).toHaveBeenCalledWith("org1", now, prior);
  });

  it("never throws — the poller's cost pass rides on this", async () => {
    claimAnomalySmsWindow.mockRejectedValue(new Error("postgres down"));
    const outcome = await pageAboutAnomalies("org1", "all", [spike()]);
    expect(outcome).toEqual({ status: "failed", error: "postgres down" });
  });
});
