import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

let claimed: Row[] = [];
const finished: Row[] = [];
let call = 0;

// The first update of a pass is the claim; every later one finishes a row.
vi.mock("../../db/client", () => {
  const chain = () => ({
    from: () => ({
      where: () => ({ orderBy: () => ({ limit: () => ({ for: () => [] }) }) }),
    }),
  });
  return {
    db: {
      select: chain,
      update: () => ({
        set: (value: Row) => ({
          where: () => {
            call += 1;
            if (call === 1) return { returning: () => Promise.resolve(claimed) };
            finished.push(value);
            return Promise.resolve();
          },
        }),
      }),
    },
  };
});

const { revnuRetryDelayMs, runRevnuReportPass } = await import("../revnu-report-pass");

const NOW = new Date("2026-11-05T12:00:00.000Z");
const payload = { event_id: "cs_1", event_name: "payment_succeeded", occurred_at: "2026-11-05" };

function row(overrides: Row = {}): Row {
  return {
    id: "row-1",
    stripeCheckoutSessionId: "cs_1",
    paidAt: NOW,
    reportAttempts: 1,
    reportPayload: payload,
    ...overrides,
  };
}

describe("runRevnuReportPass", () => {
  const original = process.env["REVNU_EVENT_KEY"];

  beforeEach(() => {
    process.env["REVNU_EVENT_KEY"] = "test-key";
    call = 0;
    claimed = [];
    finished.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (original === undefined) delete process.env["REVNU_EVENT_KEY"];
    else process.env["REVNU_EVENT_KEY"] = original;
  });

  it("claims nothing without a key, so queued rows wait", async () => {
    delete process.env["REVNU_EVENT_KEY"];
    claimed = [row()];
    await expect(runRevnuReportPass({ now: NOW })).resolves.toEqual({ claimed: 0, reported: 0 });
    expect(call).toBe(0);
  });

  it("sends the frozen body and clears it on acceptance", async () => {
    claimed = [row()];
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(runRevnuReportPass({ now: NOW })).resolves.toEqual({ claimed: 1, reported: 1 });
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual(payload);
    expect(finished[0]).toMatchObject({ reportPayload: null, nextReportAt: null });
    expect(finished[0]?.["reportedAt"]).toBeInstanceOf(Date);
  });

  it("backs off and keeps the payload when Revnu asks for a retry", async () => {
    claimed = [row({ reportAttempts: 3, paidAt: new Date() })];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 503 })));
    await runRevnuReportPass({ now: NOW });
    expect(finished[0]).not.toHaveProperty("reportPayload");
    expect(finished[0]).not.toHaveProperty("reportedAt");
    expect(finished[0]?.["nextReportAt"]).toBeInstanceOf(Date);
  });

  it("gives up and clears the email on an outright refusal", async () => {
    claimed = [row()];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 409 })));
    await runRevnuReportPass({ now: NOW });
    expect(finished[0]).toMatchObject({ reportPayload: null, nextReportAt: null });
    expect(finished[0]?.["reportAbandonedAt"]).toBeInstanceOf(Date);
  });

  it("gives up when the retry window has run out", async () => {
    claimed = [row({ paidAt: new Date(Date.now() - 8 * 24 * 60 * 60_000) })];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 500 })));
    await runRevnuReportPass({ now: NOW });
    expect(finished[0]?.["reportAbandonedAt"]).toBeInstanceOf(Date);
    expect(finished[0]).toMatchObject({ reportPayload: null });
  });
});

describe("revnuRetryDelayMs", () => {
  it("doubles from a minute and caps at six hours", () => {
    expect(revnuRetryDelayMs(1)).toBe(60_000);
    expect(revnuRetryDelayMs(2)).toBe(120_000);
    expect(revnuRetryDelayMs(30)).toBe(6 * 60 * 60_000);
  });
});
