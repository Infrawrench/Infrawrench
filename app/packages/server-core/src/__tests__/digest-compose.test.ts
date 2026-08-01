import { describe, expect, it } from "vitest";
import {
  addDays,
  civilMoment,
  composeWeeklyDigest,
  digestDueDate,
  digestLines,
  digestSegments,
  digestTitle,
  digestWindow,
  formatDigestEmailHtml,
  formatDigestEmailText,
  formatDigestSlackBody,
  formatDigestTeamsBody,
  isDigestDue,
  isValidTimeZone,
  type DigestCostGroup,
  type DigestInput,
  type DigestSchedule,
} from "../digest/compose";

/**
 * The composer is deliberately pure — these tests pin down the window math
 * (local Mondays in an arbitrary IANA zone, across both DST transitions), the
 * schedule's due check, the week-over-week arithmetic (totals, deltas, movers,
 * currency separation), and the formatting all three transports share.
 */

const UTC_MONDAY_7: DigestSchedule = { timezone: "UTC", sendDay: 1, sendHour: 7 };

const WINDOW = {
  weekStart: "2026-07-20",
  weekEnd: "2026-07-26",
  prevWeekStart: "2026-07-13",
  prevWeekEnd: "2026-07-19",
};

/** A group with one point per week, in the middle of each week. */
function group(
  key: string,
  currency: string,
  prevAmount: number,
  currentAmount: number,
): DigestCostGroup {
  return {
    key,
    currency,
    points: [
      { bucket: "2026-07-15", amount: prevAmount },
      { bucket: "2026-07-22", amount: currentAmount },
    ],
  };
}

function input(overrides: Partial<DigestInput> = {}): DigestInput {
  return {
    window: WINDOW,
    byProvider: [],
    byService: [],
    syncIncidentsOpened: 0,
    resourcesAdded: 0,
    resourcesRemoved: 0,
    providerIncidents: 0,
    expiringSoon: 0,
    ...overrides,
  };
}

describe("digestWindow", () => {
  it("on a Monday reports the week that just ended", () => {
    // 2026-07-27 is a Monday.
    const w = digestWindow(new Date("2026-07-27T08:00:00Z"));
    expect(w).toEqual(WINDOW);
  });

  it("mid-week still reports the last complete week", () => {
    // Thursday of the following week.
    const w = digestWindow(new Date("2026-07-30T15:30:00Z"));
    expect(w).toEqual(WINDOW);
  });

  it("on a Sunday the current week is not complete yet", () => {
    const w = digestWindow(new Date("2026-07-26T23:00:00Z"));
    expect(w.weekStart).toBe("2026-07-13");
    expect(w.weekEnd).toBe("2026-07-19");
  });
});

describe("isDigestDue", () => {
  it("is not due before Monday 07:00 UTC", () => {
    expect(isDigestDue(new Date("2026-07-27T06:59:59Z"), WINDOW)).toBe(false);
  });

  it("is due from Monday 07:00 UTC", () => {
    expect(isDigestDue(new Date("2026-07-27T07:00:00Z"), WINDOW)).toBe(true);
  });

  it("stays due later in the week (catch-up after downtime)", () => {
    expect(isDigestDue(new Date("2026-07-29T02:00:00Z"), WINDOW)).toBe(true);
  });

  it("defaults to the pre-schedule behaviour of Monday 07:00 UTC", () => {
    expect(isDigestDue(new Date("2026-07-27T07:00:00Z"), WINDOW, UTC_MONDAY_7)).toBe(true);
    expect(isDigestDue(new Date("2026-07-27T06:59:59Z"), WINDOW, UTC_MONDAY_7)).toBe(false);
  });

  it("honours a later send day", () => {
    const friday: DigestSchedule = { timezone: "UTC", sendDay: 5, sendHour: 9 };
    // Window ends Sun 2026-07-26, so Friday of the following week is 2026-07-31.
    expect(digestDueDate(WINDOW, 5)).toBe("2026-07-31");
    expect(isDigestDue(new Date("2026-07-27T09:00:00Z"), WINDOW, friday)).toBe(false);
    expect(isDigestDue(new Date("2026-07-31T08:59:00Z"), WINDOW, friday)).toBe(false);
    expect(isDigestDue(new Date("2026-07-31T09:00:00Z"), WINDOW, friday)).toBe(true);
  });

  it("puts sendDay 7 on the Sunday six days after the window", () => {
    expect(digestDueDate(WINDOW, 1)).toBe("2026-07-27");
    expect(digestDueDate(WINDOW, 7)).toBe("2026-08-02");
  });
});

describe("calendar helpers", () => {
  it("adds days across month, year and leap boundaries", () => {
    expect(addDays("2026-07-31", 1)).toBe("2026-08-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("accepts real zones and rejects invented ones", () => {
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimeZone("Not A Zone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });

  it("falls back to UTC rather than throwing on a bad stored zone", () => {
    // A hand-edited row must not stop every other org's digest.
    expect(civilMoment(new Date("2026-07-27T07:00:00Z"), "Mars/Olympus_Mons")).toEqual(
      civilMoment(new Date("2026-07-27T07:00:00Z"), "UTC"),
    );
  });
});

/**
 * The reason these exist: the composed window, the "is it due" check and the
 * `last_sent_week_start` claim key all have to agree, and a DST transition is
 * exactly where a naive `+7 * 86_400_000` implementation stops agreeing —
 * silently double-sending or skipping a week once a year.
 */
describe("timezone-aware scheduling", () => {
  describe("non-hour offset (Asia/Kolkata, +05:30)", () => {
    const schedule: DigestSchedule = { timezone: "Asia/Kolkata", sendDay: 1, sendHour: 7 };

    it("uses the local calendar week, not UTC's", () => {
      // 19:00Z on Sunday is already 00:30 on Monday in Kolkata, so the week
      // that just closed locally is a week ahead of UTC's.
      const at = new Date("2026-07-26T19:00:00Z");
      expect(digestWindow(at, "Asia/Kolkata")).toEqual(WINDOW);
      expect(digestWindow(at, "UTC").weekStart).toBe("2026-07-13");
    });

    it("fires on the half-hour offset", () => {
      // 07:00 IST is 01:30 UTC.
      const window = digestWindow(new Date("2026-07-27T01:30:00Z"), "Asia/Kolkata");
      expect(isDigestDue(new Date("2026-07-27T01:29:00Z"), window, schedule)).toBe(false);
      expect(isDigestDue(new Date("2026-07-27T01:30:00Z"), window, schedule)).toBe(true);
    });
  });

  describe("across the date line", () => {
    it("Pacific/Kiritimati (+14) closes its week ahead of UTC", () => {
      // 11:00Z Sunday is 01:00 Monday in Kiritimati.
      const at = new Date("2026-07-26T11:00:00Z");
      expect(digestWindow(at, "Pacific/Kiritimati")).toEqual(WINDOW);
      expect(digestWindow(at, "UTC").weekEnd).toBe("2026-07-19");
    });

    it("Pacific/Niue (-11) closes its week behind UTC", () => {
      // 05:00Z Monday is still 18:00 Sunday in Niue.
      const at = new Date("2026-07-27T05:00:00Z");
      expect(digestWindow(at, "Pacific/Niue").weekEnd).toBe("2026-07-19");
      expect(digestWindow(at, "UTC").weekEnd).toBe("2026-07-26");
    });
  });

  describe("spring forward — a 23-hour local day", () => {
    // America/New_York, 2026-03-08: 01:59:59 EST jumps straight to 03:00 EDT.
    // The local hour 2 never occurs on that date.
    const sundayAt2: DigestSchedule = {
      timezone: "America/New_York",
      sendDay: 7,
      sendHour: 2,
    };

    it("keeps the week seven dated days long", () => {
      // Monday after the transition; the reported week contains the short day.
      const w = digestWindow(new Date("2026-03-09T11:00:00Z"), "America/New_York");
      expect(w).toEqual({
        weekStart: "2026-03-02",
        weekEnd: "2026-03-08",
        prevWeekStart: "2026-02-23",
        prevWeekEnd: "2026-03-01",
      });
    });

    it("does not skip a send whose hour the clock jumps over", () => {
      const w = digestWindow(new Date("2026-03-08T12:00:00Z"), "America/New_York");
      expect(w.weekEnd).toBe("2026-03-01");
      expect(digestDueDate(w, 7)).toBe("2026-03-08");
      // 01:30 EST — before the jump, and before the send hour.
      expect(isDigestDue(new Date("2026-03-08T06:30:00Z"), w, sundayAt2)).toBe(false);
      // 03:00 EDT — the clock skipped 02:00 entirely, so the digest becomes due
      // the moment the local hour clears the send hour. Late, never skipped.
      expect(isDigestDue(new Date("2026-03-08T07:00:00Z"), w, sundayAt2)).toBe(true);
    });

    it("still fires at the usual local time the next morning", () => {
      const w = digestWindow(new Date("2026-03-09T11:00:00Z"), "America/New_York");
      const schedule: DigestSchedule = {
        timezone: "America/New_York",
        sendDay: 1,
        sendHour: 7,
      };
      // EDT is UTC-4 after the transition: 07:00 local is 11:00Z, not 12:00Z.
      expect(isDigestDue(new Date("2026-03-09T10:59:00Z"), w, schedule)).toBe(false);
      expect(isDigestDue(new Date("2026-03-09T11:00:00Z"), w, schedule)).toBe(true);
    });
  });

  describe("fall back — a 25-hour local day", () => {
    // America/New_York, 2026-11-01: 01:00–02:00 happens twice (EDT then EST).
    const sundayAt1: DigestSchedule = {
      timezone: "America/New_York",
      sendDay: 7,
      sendHour: 1,
    };

    it("keeps the week seven dated days long", () => {
      const w = digestWindow(new Date("2026-11-01T06:30:00Z"), "America/New_York");
      expect(w).toEqual({
        weekStart: "2026-10-19",
        weekEnd: "2026-10-25",
        prevWeekStart: "2026-10-12",
        prevWeekEnd: "2026-10-18",
      });
      // The repeated hour must not push the window on either.
      expect(digestWindow(new Date("2026-11-02T12:00:00Z"), "America/New_York").weekEnd).toBe(
        "2026-11-01",
      );
    });

    it("stays due across the repeated hour rather than firing twice", () => {
      const w = digestWindow(new Date("2026-11-01T06:30:00Z"), "America/New_York");
      expect(digestDueDate(w, 7)).toBe("2026-11-01");
      // 00:30 EDT — before the send hour.
      expect(isDigestDue(new Date("2026-11-01T04:30:00Z"), w, sundayAt1)).toBe(false);
      // 01:30 EDT — the first pass through the repeated hour.
      expect(isDigestDue(new Date("2026-11-01T05:30:00Z"), w, sundayAt1)).toBe(true);
      // 01:30 EST — the second pass. Still "due"; the last_sent_week_start
      // claim, not this predicate, is what keeps it to one send.
      expect(isDigestDue(new Date("2026-11-01T06:30:00Z"), w, sundayAt1)).toBe(true);
    });

    it("agrees with the window's own claim key on both sides of the change", () => {
      // Every instant on the due date must report the same weekStart, or the
      // claim key would differ between two ticks and re-send the week.
      const keys = [
        "2026-11-01T04:30:00Z",
        "2026-11-01T05:30:00Z",
        "2026-11-01T06:30:00Z",
        "2026-11-01T23:30:00Z",
      ].map((t) => digestWindow(new Date(t), "America/New_York").weekStart);
      expect(new Set(keys).size).toBe(1);
      expect(keys[0]).toBe("2026-10-19");
    });
  });
});

describe("composeWeeklyDigest", () => {
  it("totals per currency with delta and percentage", () => {
    const digest = composeWeeklyDigest(
      input({ byProvider: [group("aws", "USD", 100, 150), group("gcp", "USD", 50, 25)] }),
    );
    expect(digest.totals).toEqual([
      {
        currency: "USD",
        currentAmount: 175,
        previousAmount: 150,
        delta: 25,
        deltaPct: expect.closeTo(16.666, 2),
      },
    ]);
  });

  it("reports a null percentage when last week was zero", () => {
    const digest = composeWeeklyDigest(input({ byProvider: [group("aws", "USD", 0, 40)] }));
    expect(digest.totals[0]?.deltaPct).toBeNull();
  });

  it("keeps currencies separate and sorts by current spend", () => {
    const digest = composeWeeklyDigest(
      input({ byProvider: [group("hetzner", "EUR", 10, 20), group("aws", "USD", 100, 90)] }),
    );
    expect(digest.totals.map((t) => t.currency)).toEqual(["USD", "EUR"]);
  });

  it("ranks movers by absolute delta in the primary currency only", () => {
    const digest = composeWeeklyDigest(
      input({
        byProvider: [
          group("aws", "USD", 100, 160), // +60
          group("gcp", "USD", 100, 20), // -80
          group("fly", "USD", 10, 15), // +5
          group("vercel", "USD", 30, 31), // +1
          group("hetzner", "EUR", 0, 90), // non-primary currency, excluded
        ],
      }),
    );
    expect(digest.topProviderMovers.map((m) => m.key)).toEqual(["gcp", "aws", "fly"]);
    expect(digest.topProviderMovers[0]?.delta).toBe(-80);
  });

  it("ignores flat groups and empty keys", () => {
    const digest = composeWeeklyDigest(
      input({ byProvider: [group("aws", "USD", 50, 50), group("", "USD", 10, 90)] }),
    );
    expect(digest.topProviderMovers).toEqual([]);
  });

  it("only counts points inside each week", () => {
    const digest = composeWeeklyDigest(
      input({
        byProvider: [
          {
            key: "aws",
            currency: "USD",
            points: [
              { bucket: "2026-07-12", amount: 999 }, // before prev week
              { bucket: "2026-07-13", amount: 10 }, // prev week (first day)
              { bucket: "2026-07-26", amount: 30 }, // current week (last day)
              { bucket: "2026-07-27", amount: 999 }, // after window
            ],
          },
        ],
      }),
    );
    expect(digest.totals[0]).toMatchObject({ currentAmount: 30, previousAmount: 10 });
  });
});

describe("formatting", () => {
  it("titles with the reported week's range", () => {
    const digest = composeWeeklyDigest(input());
    expect(digestTitle(digest)).toBe("Weekly digest · Jul 20 – Jul 26");
  });

  it("renders spend, movers, incidents and resource churn", () => {
    const digest = composeWeeklyDigest(
      input({
        byProvider: [group("aws", "USD", 100, 150)],
        byService: [group("AmazonEC2", "USD", 60, 110)],
        syncIncidentsOpened: 2,
        resourcesAdded: 5,
        resourcesRemoved: 1,
      }),
    );
    const body = formatDigestSlackBody(digest);
    expect(body).toContain("*Spend: $150.00*");
    expect(body).toContain("+$50.00 (+50.0%) vs $100.00 the week before");
    expect(body).toContain("*Top movers by provider*");
    expect(body).toContain("• aws: $150.00 (+$50.00 vs last week)");
    expect(body).toContain("• AmazonEC2: $110.00 (+$50.00 vs last week)");
    expect(body).toContain("2 sync incidents opened");
    expect(body).toContain("5 added, 1 removed");
  });

  it("explains an empty cost week instead of printing zeros", () => {
    const lines = digestLines(composeWeeklyDigest(input()), (s) => s);
    expect(lines[0]).toContain("No cost data was recorded for last week");
  });

  it("adds an expiring-soon line only when deadlines are inside the lead time", () => {
    const withDeadlines = formatDigestSlackBody(composeWeeklyDigest(input({ expiringSoon: 3 })));
    expect(withDeadlines).toContain("*Expiring soon*: 3 deadlines within your lead time");
    const one = formatDigestSlackBody(composeWeeklyDigest(input({ expiringSoon: 1 })));
    expect(one).toContain("1 deadline within your lead time");
    const without = formatDigestSlackBody(composeWeeklyDigest(input()));
    expect(without).not.toContain("Expiring soon");
  });

  it("labels currencies when an org spends in more than one", () => {
    const digest = composeWeeklyDigest(
      input({ byProvider: [group("aws", "USD", 1, 2), group("hetzner", "EUR", 1, 2)] }),
    );
    const body = formatDigestSlackBody(digest);
    expect(body).toContain("Spend (USD)");
    expect(body).toContain("Spend (EUR)");
  });
});

describe("AI narrative slot", () => {
  const digest = () => composeWeeklyDigest(input({ byProvider: [group("aws", "USD", 100, 150)] }));

  it("puts the paragraph above the deterministic content on every transport", () => {
    const n = "Spend rose on the back of a single EC2 fleet.";
    expect(formatDigestSlackBody(digest(), n).startsWith(n)).toBe(true);
    expect(formatDigestTeamsBody(digest(), n).startsWith(n)).toBe(true);
    expect(formatDigestEmailText(digest(), n)).toContain(n);
    expect(formatDigestEmailHtml(digest(), n)).toContain(n);
  });

  it("changes nothing else when absent — the digest is identical without it", () => {
    const withNothing = formatDigestSlackBody(digest());
    for (const missing of [undefined, null, ""]) {
      expect(formatDigestSlackBody(digest(), missing)).toBe(withNothing);
    }
  });

  it("keeps the deterministic content intact when a paragraph is present", () => {
    const body = formatDigestSlackBody(digest(), "Anything at all.");
    expect(body).toContain("*Spend: $150.00*");
    expect(body).toContain("Resources");
  });
});

describe("email rendering", () => {
  const digest = () =>
    composeWeeklyDigest(
      input({
        byProvider: [group("aws", "USD", 100, 150)],
        byService: [group("AmazonEC2", "USD", 60, 110)],
        syncIncidentsOpened: 2,
        resourcesAdded: 5,
        resourcesRemoved: 1,
      }),
    );

  it("leads the text part with the title and appends the deep link", () => {
    const text = formatDigestEmailText(digest(), null, "https://app.example.com/org/o1/costs");
    expect(text.split("\n")[0]).toBe("Weekly digest · Jul 20 – Jul 26");
    expect(text).toContain("Spend: $150.00");
    // No mrkdwn asterisks — a mail client would render them literally.
    expect(text).not.toContain("*Spend");
    expect(text).toContain("View in Infrawrench: https://app.example.com/org/o1/costs");
  });

  it("omits the link line when there is no APP_URL to link to", () => {
    expect(formatDigestEmailText(digest())).not.toContain("View in Infrawrench");
    expect(formatDigestEmailHtml(digest())).not.toContain("<a href");
  });

  it("emits self-contained HTML with an inline-styled button", () => {
    const html = formatDigestEmailHtml(digest(), null, "https://app.example.com/x");
    expect(html).toContain("<h1");
    expect(html).toContain("<strong>Spend: $150.00</strong>");
    expect(html).toContain('href="https://app.example.com/x"');
    // No external stylesheet or script — mail clients strip both.
    expect(html).not.toContain("<style");
    expect(html).not.toContain("<script");
  });

  it("escapes provider text so a stray angle bracket cannot inject markup", () => {
    const digestWithMarkup = composeWeeklyDigest(
      input({ byProvider: [group("<img src=x>", "USD", 10, 90)] }),
    );
    const html = formatDigestEmailHtml(digestWithMarkup);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x&gt;");
  });

  it("escapes the narrative paragraph too", () => {
    const html = formatDigestEmailHtml(digest(), "5 < 6 & <b>bold</b>");
    expect(html).toContain("5 &lt; 6 &amp; &lt;b&gt;bold&lt;/b&gt;");
  });
});

/**
 * The narrative is model output that goes into the body verbatim, and the
 * system prompt is not a security boundary — a paragraph that happens to
 * contain HTML must come out as text on every transport.
 *
 * The regression: the HTML part used to recover its own markup by splitting the
 * rendered line on `/(<strong>.*?<\/strong>)/` and passing the matches through
 * unescaped. A narrative containing `<strong>` therefore reached the mail body
 * raw — and because the pattern is non-greedy across the whole line, so did
 * everything sitting between two such tags. The renderers now build from
 * `digestSegments`, so markup and text are never in the same string.
 */
describe("a narrative that contains markup", () => {
  const digest = () => composeWeeklyDigest(input({ byProvider: [group("aws", "USD", 100, 150)] }));

  /** Both halves of the old hole: the tag itself, and the payload it smuggled. */
  const HOSTILE =
    "<strong>lead</strong><script>alert(1)</script><img src=x onerror=alert(1)><strong>tail</strong> and 5 < 6";

  it("escapes every tag in the HTML mail body, including the smuggled payload", () => {
    const html = formatDigestEmailHtml(digest(), HOSTILE);
    // Nothing from the paragraph survives as markup.
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror=alert(1)>");
    expect(html).toContain("&lt;strong&gt;lead&lt;/strong&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;strong&gt;tail&lt;/strong&gt;");
    expect(html).toContain("5 &lt; 6");
    // The digest's own emphasis is still real markup.
    expect(html).toContain("<strong>Spend: $150.00</strong>");
  });

  it("escapes a bare angle bracket rather than opening a tag", () => {
    const html = formatDigestEmailHtml(digest(), "Spend < last week, and A&B rose");
    expect(html).toContain("Spend &lt; last week, and A&amp;B rose");
  });

  it("counts the paragraph's own <strong> as text, not as a bold segment", () => {
    const segments = digestSegments(digest(), HOSTILE);
    expect(segments[0]).toEqual([{ text: HOSTILE, bold: false }]);
    // Only fragments the composer marked up ask for emphasis, and none of them
    // carry markup characters of their own.
    for (const line of segments) {
      for (const seg of line) {
        if (seg.bold) expect(seg.text).not.toMatch(/[<>]/);
      }
    }
  });

  it("does not break the Slack or Teams renderers", () => {
    // Slack and Teams take the paragraph as literal text; their transports
    // escape it (`&<>` in slack.ts, `\ * _ [ ]` in msteams.ts) on the way out,
    // so the renderers must pass it through unmangled and keep the
    // deterministic content intact underneath it.
    const withMarkup = `${HOSTILE} *not really bold*`;
    const slack = formatDigestSlackBody(digest(), withMarkup);
    expect(slack.startsWith(withMarkup)).toBe(true);
    expect(slack).toContain("*Spend: $150.00*");
    expect(slack).toContain("*Top movers by provider*");
    expect(slack).toContain("• aws: $150.00 (+$50.00 vs last week)");

    const teams = formatDigestTeamsBody(digest(), withMarkup);
    expect(teams.startsWith(withMarkup)).toBe(true);
    expect(teams).toContain("Spend: $150.00");
    expect(teams).not.toContain("*Spend");

    const text = formatDigestEmailText(digest(), withMarkup);
    expect(text).toContain(withMarkup);
    expect(text).toContain("Spend: $150.00");
  });

  it("renders the same body whether or not the paragraph looks like markup", () => {
    // The paragraph is the only thing that changes: swapping it for plain prose
    // must not move a single line of the deterministic content.
    const strip = (s: string) => s.split("\n").slice(2).join("\n");
    expect(strip(formatDigestSlackBody(digest(), HOSTILE))).toBe(
      strip(formatDigestSlackBody(digest(), "Nothing unusual happened.")),
    );
  });
});
