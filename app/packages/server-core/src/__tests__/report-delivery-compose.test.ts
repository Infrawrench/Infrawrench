import { describe, it, expect } from "vitest";
import {
  classifyReportDelivery,
  formatReportEmailHtml,
  formatReportEmailText,
  formatReportSlackBody,
  formatReportTeamsBody,
  nextReportDeliveryAttemptAt,
  nextReportSendAt,
  reportDeliverySegments,
  reportDeliveryTitle,
  MAX_DELIVERY_GROUPS,
  MAX_REPORT_DELIVERY_ATTEMPTS,
  type ReportDeliveryData,
  type ReportDeliveryResult,
  type ReportSchedule,
} from "../report-delivery/compose";

/* ------------------------------------------------------------------ *
 * Schedule arithmetic — civil dates, month ends, DST.
 * ------------------------------------------------------------------ */

const schedule = (overrides: Partial<ReportSchedule>): ReportSchedule => ({
  cadence: "daily",
  sendDay: 1,
  sendDayOfMonth: 1,
  hour: 8,
  timezone: "UTC",
  ...overrides,
});

describe("nextReportSendAt", () => {
  it("fires later today when the hour is still ahead", () => {
    const next = nextReportSendAt(schedule({}), new Date("2026-08-10T06:00:00Z"));
    expect(next.toISOString()).toBe("2026-08-10T08:00:00.000Z");
  });

  it("is strictly after `from` — exactly on the hour rolls to the next day", () => {
    const next = nextReportSendAt(schedule({}), new Date("2026-08-10T08:00:00Z"));
    expect(next.toISOString()).toBe("2026-08-11T08:00:00.000Z");
  });

  it("weekly waits for the chosen ISO weekday", () => {
    // 2026-08-10 is a Monday; sendDay 5 is Friday.
    const next = nextReportSendAt(
      schedule({ cadence: "weekly", sendDay: 5 }),
      new Date("2026-08-10T12:00:00Z"),
    );
    expect(next.toISOString()).toBe("2026-08-14T08:00:00.000Z");
  });

  it("monthly clamps day 31 to a 30-day month's last day", () => {
    // Asked for the 31st; April has 30 days — month end is what was meant.
    const next = nextReportSendAt(
      schedule({ cadence: "monthly", sendDayOfMonth: 31 }),
      new Date("2026-04-02T00:00:00Z"),
    );
    expect(next.toISOString()).toBe("2026-04-30T08:00:00.000Z");
  });

  it("monthly clamps day 31 to February's 28th (and the 29th in a leap year)", () => {
    const feb26 = nextReportSendAt(
      schedule({ cadence: "monthly", sendDayOfMonth: 31 }),
      new Date("2026-02-01T00:00:00Z"),
    );
    expect(feb26.toISOString()).toBe("2026-02-28T08:00:00.000Z");
    const feb28 = nextReportSendAt(
      schedule({ cadence: "monthly", sendDayOfMonth: 31 }),
      new Date("2028-02-01T00:00:00Z"),
    );
    expect(feb28.toISOString()).toBe("2028-02-29T08:00:00.000Z");
  });

  it("monthly does not skip a month after firing on a clamped day", () => {
    // Fired on Apr 30 (clamped 31). The next fire is May 31, not June.
    const next = nextReportSendAt(
      schedule({ cadence: "monthly", sendDayOfMonth: 31 }),
      new Date("2026-04-30T08:00:00Z"),
    );
    expect(next.toISOString()).toBe("2026-05-31T08:00:00.000Z");
  });

  it("monthly rolls into the next month once this month's day has passed", () => {
    const next = nextReportSendAt(
      schedule({ cadence: "monthly", sendDayOfMonth: 15 }),
      new Date("2026-01-20T00:00:00Z"),
    );
    expect(next.toISOString()).toBe("2026-02-15T08:00:00.000Z");
  });

  it("keeps the chosen local hour across a DST change", () => {
    // US DST starts Sun 2026-03-08. Weekly Monday 08:00 in New York:
    // Mon Mar 2 is EST (UTC-5, 13:00Z); Mon Mar 9 is EDT (UTC-4, 12:00Z).
    const tz = "America/New_York";
    const beforeChange = nextReportSendAt(
      schedule({ cadence: "weekly", sendDay: 1, timezone: tz }),
      new Date("2026-03-01T00:00:00Z"),
    );
    expect(beforeChange.toISOString()).toBe("2026-03-02T13:00:00.000Z");
    const afterChange = nextReportSendAt(
      schedule({ cadence: "weekly", sendDay: 1, timezone: tz }),
      new Date("2026-03-03T00:00:00Z"),
    );
    expect(afterChange.toISOString()).toBe("2026-03-09T12:00:00.000Z");
  });

  it("handles a non-hour offset zone", () => {
    // Asia/Kolkata is UTC+5:30, so 08:00 local is 02:30Z.
    const next = nextReportSendAt(
      schedule({ timezone: "Asia/Kolkata" }),
      new Date("2026-08-10T00:00:00Z"),
    );
    expect(next.toISOString()).toBe("2026-08-10T02:30:00.000Z");
  });

  it("falls back to UTC on an unknown zone instead of throwing (poller-safe)", () => {
    const next = nextReportSendAt(
      schedule({ timezone: "Not/AZone" }),
      new Date("2026-08-10T06:00:00Z"),
    );
    expect(next.toISOString()).toBe("2026-08-10T08:00:00.000Z");
  });
});

/* ------------------------------------------------------------------ *
 * Composition — converted totals, the caveat, and the empty send.
 * ------------------------------------------------------------------ */

const baseData = (overrides: Partial<ReportDeliveryData>): ReportDeliveryData => ({
  reportName: "Monthly spend by service",
  description: null,
  from: "2026-07-01",
  to: "2026-07-31",
  groupLabel: "service",
  totals: [],
  topGroups: [],
  url: "https://app.example.com/org/o1/cost-reports/r1",
  ...overrides,
});

function flat(data: ReportDeliveryData): string {
  return reportDeliverySegments(data)
    .map((line) => line.map((seg) => seg.text).join(""))
    .join("\n");
}

describe("reportDeliverySegments", () => {
  it("quotes the converted total with its delta and the conversion caveat", () => {
    const data = baseData({
      totals: [{ currency: "USD", currentAmount: 12_345, previousAmount: 10_000 }],
      conversion: {
        displayCurrency: "USD",
        converted: [{ currency: "EUR", rates: [{ effectiveFrom: "2026-01-01", rate: 1.08 }] }],
        unconverted: ["JPY"],
      },
    });
    const text = flat(data);
    expect(text).toContain("Total: $12,345");
    expect(text).toContain("+$2,345");
    expect(text).toContain("+23.4%");
    expect(text).toContain("vs $10,000 the period before");
    // The caveat names both what was converted and what was left out.
    expect(text).toContain("EUR converted to USD at your organization's stated rates");
    expect(text).toContain("JPY shown unconverted");
  });

  it("omits the comparison suffix when the previous period is unknown", () => {
    const text = flat(
      baseData({ totals: [{ currency: "USD", currentAmount: 50, previousAmount: null }] }),
    );
    expect(text).toContain("Total: $50.00");
    expect(text).not.toContain("the period before");
  });

  it("says 'new' rather than dividing by a zero previous period", () => {
    const text = flat(
      baseData({ totals: [{ currency: "USD", currentAmount: 50, previousAmount: 0 }] }),
    );
    expect(text).toContain("(new)");
  });

  it("an empty result is a message that says it still sends, not a skip", () => {
    const text = flat(baseData({ totals: [] }));
    expect(text).toContain("No spend was recorded");
    expect(text).toContain("still sends");
    // And every transport carries that line, so no channel can go silently quiet.
    const data = baseData({ totals: [] });
    expect(formatReportSlackBody(data)).toContain("still sends");
    expect(formatReportTeamsBody(data)).toContain("still sends");
    expect(formatReportEmailText(data)).toContain("still sends");
    expect(formatReportEmailHtml(data)).toContain("still sends");
  });

  it("bounds the quoted groups and labels the heading with the group dimension", () => {
    const groups = Array.from({ length: 9 }, (_, i) => ({
      label: `service-${i}`,
      currency: "USD",
      amount: 100 - i,
    }));
    const text = flat(
      baseData({
        totals: [{ currency: "USD", currentAmount: 500, previousAmount: null }],
        topGroups: groups,
      }),
    );
    expect(text).toContain("Top services");
    expect(text).toContain("service-0");
    expect(text).toContain(`service-${MAX_DELIVERY_GROUPS - 1}`);
    expect(text).not.toContain(`service-${MAX_DELIVERY_GROUPS}`);
  });

  it("escapes report-controlled text in the email HTML", () => {
    const html = formatReportEmailHtml(
      baseData({
        description: `<img src=x onerror=alert(1)>`,
        totals: [{ currency: "USD", currentAmount: 1, previousAmount: null }],
      }),
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("titles the message with the report name and its resolved window", () => {
    expect(reportDeliveryTitle(baseData({}))).toBe("Monthly spend by service · Jul 1 – Jul 31");
  });
});

/* ------------------------------------------------------------------ *
 * Delivery classification and the retry backoff.
 * ------------------------------------------------------------------ */

const result = (overrides: Partial<ReportDeliveryResult>): ReportDeliveryResult => ({
  attempted: 0,
  succeeded: 0,
  slack: { attempted: 0, succeeded: 0 },
  teams: { attempted: 0, succeeded: 0 },
  email: { attempted: 0, succeeded: 0 },
  ...overrides,
});

describe("classifyReportDelivery", () => {
  it("no destinations at all is no_targets and never retried", () => {
    const outcome = classifyReportDelivery(result({}));
    expect(outcome.status).toBe("no_targets");
    expect(outcome.retryable).toBe(false);
  });

  it("a total failure is the only retryable outcome", () => {
    const outcome = classifyReportDelivery(result({ attempted: 3, succeeded: 0 }));
    expect(outcome.status).toBe("failed");
    expect(outcome.retryable).toBe(true);
  });

  it("a partial delivery is terminal — a retry would double-post", () => {
    const outcome = classifyReportDelivery(result({ attempted: 3, succeeded: 2 }));
    expect(outcome.status).toBe("partial");
    expect(outcome.retryable).toBe(false);
    expect(outcome.error).toContain("Send now");
  });

  it("a full success is clean", () => {
    const outcome = classifyReportDelivery(result({ attempted: 2, succeeded: 2 }));
    expect(outcome).toEqual({ status: "succeeded", error: null, retryable: false });
  });
});

describe("nextReportDeliveryAttemptAt", () => {
  const now = new Date("2026-08-10T08:00:00Z");

  it("backs off 15 minutes, then an hour — the digest's convention", () => {
    expect(nextReportDeliveryAttemptAt(now, 1)?.toISOString()).toBe("2026-08-10T08:15:00.000Z");
    expect(nextReportDeliveryAttemptAt(now, 2)?.toISOString()).toBe("2026-08-10T09:00:00.000Z");
  });

  it("returns null once the attempts are spent", () => {
    expect(nextReportDeliveryAttemptAt(now, MAX_REPORT_DELIVERY_ATTEMPTS)).toBeNull();
  });
});
