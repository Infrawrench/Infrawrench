import { describe, expect, it } from "vitest";

import {
  ALERT_TRIGGERS,
  DEFAULT_MUTED_TRIGGERS,
  PUSHABLE_TRIGGERS,
  conditionMatches,
  defaultAlertRule,
  isWithinQuietHours,
  quietHoldUntil,
  quietHoursEnd,
  routeAlertRules,
  validateAlertRule,
  type AlertCondition,
  type AlertMatchInput,
  type AlertRule,
  type AlertSeverity,
  type QuietHours,
} from "../alert-routing";

/**
 * The routing table is pure, so it is testable without a database, a clock or a
 * transport — which is the whole reason it lives here rather than in
 * `server-core`. What is worth pinning down:
 *
 *  - the "absent fact never matches" rule, in both directions, because getting
 *    it wrong routes org-wide alerts into per-account channels;
 *  - first-match-wins and the tee escape hatch, which is what makes the
 *    editor's ordering meaningful;
 *  - the quiet-hours window arithmetic, including the overnight wrap and the
 *    day-of-week attribution that goes with it.
 */

const BASE: AlertMatchInput = {
  trigger: "anomalyAlerts",
  severity: "warning",
  title: "Cost anomaly: AmazonEC2",
  body: 'service "AmazonEC2" cost $920.00 on 2026-08-05',
  facts: { accountId: "acc-prod", pluginId: "aws", amountCents: 92_000, key: "AmazonEC2" },
};

function rule(over: Partial<AlertRule> = {}): AlertRule {
  return {
    id: over.id ?? "r1",
    name: "rule",
    enabled: true,
    position: 0,
    conditions: [],
    destinations: [{ kind: "push" }],
    continueOnMatch: false,
    quietHours: null,
    escalation: null,
    ...over,
  };
}

describe("conditionMatches", () => {
  function check(condition: AlertCondition, input: AlertMatchInput = BASE): boolean {
    return conditionMatches(condition, input);
  }

  it("matches a trigger by membership, both ways round", () => {
    expect(check({ field: "trigger", op: "in", values: ["anomalyAlerts"] })).toBe(true);
    expect(check({ field: "trigger", op: "in", values: ["budgetAlerts"] })).toBe(false);
    expect(check({ field: "trigger", op: "notIn", values: ["resourceDrift"] })).toBe(true);
    expect(check({ field: "trigger", op: "notIn", values: ["anomalyAlerts"] })).toBe(false);
  });

  it("orders severity so `gte` is a floor, not an equality", () => {
    expect(check({ field: "severity", op: "gte", severity: "info" })).toBe(true);
    expect(check({ field: "severity", op: "gte", severity: "warning" })).toBe(true);
    expect(check({ field: "severity", op: "gte", severity: "critical" })).toBe(false);
    expect(check({ field: "severity", op: "eq", severity: "warning" })).toBe(true);
    expect(check({ field: "severity", op: "eq", severity: "critical" })).toBe(false);
  });

  it("compares money in cents", () => {
    expect(check({ field: "amountCents", op: "gte", cents: 50_000 })).toBe(true);
    expect(check({ field: "amountCents", op: "gte", cents: 100_000 })).toBe(false);
    expect(check({ field: "amountCents", op: "lt", cents: 100_000 })).toBe(true);
    expect(check({ field: "amountCents", op: "lt", cents: 50_000 })).toBe(false);
  });

  it("treats a missing amount as no amount, not as zero", () => {
    // A drift digest is not a $0 spend anomaly. If it satisfied `< $500` it
    // would be routed by a rule that is plainly about money.
    const noMoney: AlertMatchInput = { ...BASE, facts: {} };
    expect(check({ field: "amountCents", op: "lt", cents: 50_000 }, noMoney)).toBe(false);
    expect(check({ field: "amountCents", op: "gte", cents: 0 }, noMoney)).toBe(false);
  });

  it("fails an account condition in BOTH directions when the alert has no account", () => {
    // The invariant: a condition about accounts never matches an alert that is
    // not about an account. `notIn` inverting to true would let an org-wide
    // page fall into a per-account channel's rule.
    const orgWide: AlertMatchInput = { ...BASE, facts: { pluginId: "aws" } };
    expect(check({ field: "accountId", op: "in", values: ["acc-prod"] }, orgWide)).toBe(false);
    expect(check({ field: "accountId", op: "notIn", values: ["acc-prod"] }, orgWide)).toBe(false);
  });

  it("matches key and free text case-insensitively", () => {
    expect(check({ field: "key", op: "contains", value: "ec2" })).toBe(true);
    expect(check({ field: "key", op: "eq", value: "amazonec2" })).toBe(true);
    expect(check({ field: "key", op: "notContains", value: "rds" })).toBe(true);
    expect(check({ field: "text", op: "contains", value: "COST $920" })).toBe(true);
    expect(check({ field: "text", op: "notContains", value: "disk" })).toBe(true);
  });

  it("does not let a text match straddle the title/body seam", () => {
    const input: AlertMatchInput = { ...BASE, title: "abc", body: "def" };
    expect(check({ field: "text", op: "contains", value: "abcdef" }, input)).toBe(false);
    expect(check({ field: "text", op: "contains", value: "abc" }, input)).toBe(true);
  });
});

describe("routeAlertRules", () => {
  it("is first-match-wins by default", () => {
    const decision = routeAlertRules(
      [
        rule({
          id: "specific",
          position: 0,
          conditions: [{ field: "amountCents", op: "gte", cents: 50_000 }],
          destinations: [{ kind: "slack", channelId: "incidents" }],
        }),
        rule({
          id: "catchall",
          position: 1,
          destinations: [{ kind: "slack", channelId: "noise" }],
        }),
      ],
      BASE,
      new Date("2026-08-06T12:00:00Z"),
    );
    expect(decision.matchedRuleIds).toEqual(["specific"]);
    expect(decision.legs).toHaveLength(1);
    expect(decision.legs[0]!.destinations).toEqual([{ kind: "slack", channelId: "incidents" }]);
  });

  it("falls through to the catch-all when the specific rule does not match", () => {
    const cheap: AlertMatchInput = { ...BASE, facts: { ...BASE.facts, amountCents: 1_000 } };
    const decision = routeAlertRules(
      [
        rule({
          id: "specific",
          position: 0,
          conditions: [{ field: "amountCents", op: "gte", cents: 50_000 }],
          destinations: [{ kind: "slack", channelId: "incidents" }],
        }),
        rule({
          id: "catchall",
          position: 1,
          destinations: [{ kind: "slack", channelId: "noise" }],
        }),
      ],
      cheap,
      new Date("2026-08-06T12:00:00Z"),
    );
    expect(decision.matchedRuleIds).toEqual(["catchall"]);
  });

  it("keeps evaluating past a tee rule", () => {
    const decision = routeAlertRules(
      [
        rule({
          id: "audit",
          position: 0,
          continueOnMatch: true,
          destinations: [{ kind: "slack", channelId: "audit" }],
        }),
        rule({
          id: "catchall",
          position: 1,
          destinations: [{ kind: "slack", channelId: "noise" }],
        }),
      ],
      BASE,
      new Date("2026-08-06T12:00:00Z"),
    );
    expect(decision.matchedRuleIds).toEqual(["audit", "catchall"]);
    expect(decision.legs).toHaveLength(2);
  });

  it("lets a destination-less rule swallow alerts", () => {
    // An enabled rule with no destinations is how an org says "drop these".
    // It has to shadow the rules below it or it would do nothing at all.
    const decision = routeAlertRules(
      [
        rule({
          id: "mute",
          position: 0,
          conditions: [{ field: "key", op: "contains", value: "ec2" }],
          destinations: [],
        }),
        rule({ id: "catchall", position: 1, destinations: [{ kind: "push" }] }),
      ],
      BASE,
      new Date("2026-08-06T12:00:00Z"),
    );
    expect(decision.matchedRuleIds).toEqual(["mute"]);
    expect(decision.legs).toHaveLength(0);
    expect(decision.unrouted).toBe(false);
  });

  it("skips disabled rules entirely", () => {
    const decision = routeAlertRules(
      [
        rule({ id: "off", position: 0, enabled: false, destinations: [{ kind: "push" }] }),
        rule({ id: "on", position: 1, destinations: [{ kind: "slack", channelId: "c" }] }),
      ],
      BASE,
      new Date("2026-08-06T12:00:00Z"),
    );
    expect(decision.matchedRuleIds).toEqual(["on"]);
  });

  it("evaluates by position, not by array order", () => {
    const decision = routeAlertRules(
      [
        rule({ id: "second", position: 5, destinations: [{ kind: "slack", channelId: "b" }] }),
        rule({ id: "first", position: 1, destinations: [{ kind: "slack", channelId: "a" }] }),
      ],
      BASE,
      new Date("2026-08-06T12:00:00Z"),
    );
    expect(decision.matchedRuleIds).toEqual(["first"]);
  });

  it("reports an unrouted alert rather than pretending it was handled", () => {
    const decision = routeAlertRules(
      [
        rule({
          id: "r",
          conditions: [{ field: "trigger", op: "in", values: ["probeAlerts"] }],
        }),
      ],
      BASE,
      new Date("2026-08-06T12:00:00Z"),
    );
    expect(decision.unrouted).toBe(true);
    expect(decision.legs).toHaveLength(0);
  });

  it("ANDs every condition on a rule", () => {
    const conditions: AlertCondition[] = [
      { field: "trigger", op: "in", values: ["anomalyAlerts"] },
      { field: "amountCents", op: "gte", cents: 50_000 },
      { field: "accountId", op: "in", values: ["acc-prod"] },
    ];
    expect(routeAlertRules([rule({ conditions })], BASE, new Date()).unrouted).toBe(false);

    const staging: AlertMatchInput = { ...BASE, facts: { ...BASE.facts, accountId: "acc-stg" } };
    expect(routeAlertRules([rule({ conditions })], staging, new Date()).unrouted).toBe(true);
  });
});

describe("quiet hours", () => {
  const OVERNIGHT: QuietHours = {
    timezone: "UTC",
    startMinute: 22 * 60,
    endMinute: 8 * 60,
    days: [],
    urgentOverride: null,
  };

  it("covers an overnight window on both sides of midnight", () => {
    expect(isWithinQuietHours(OVERNIGHT, new Date("2026-08-06T23:30:00Z"))).toBe(true);
    expect(isWithinQuietHours(OVERNIGHT, new Date("2026-08-07T03:00:00Z"))).toBe(true);
    expect(isWithinQuietHours(OVERNIGHT, new Date("2026-08-07T12:00:00Z"))).toBe(false);
    // Half-open: the closing minute is already outside.
    expect(isWithinQuietHours(OVERNIGHT, new Date("2026-08-07T08:00:00Z"))).toBe(false);
  });

  it("releases at the window's end, floored to the minute", () => {
    const end = quietHoursEnd(OVERNIGHT, new Date("2026-08-06T23:17:42Z"));
    expect(end?.toISOString()).toBe("2026-08-07T08:00:00.000Z");
    // Two alerts held inside one window converge on the same release instant,
    // so the flush pass sends them as one batch rather than a trickle.
    const other = quietHoursEnd(OVERNIGHT, new Date("2026-08-07T02:03:04Z"));
    expect(other?.toISOString()).toBe("2026-08-07T08:00:00.000Z");
  });

  it("returns null outside the window", () => {
    expect(quietHoursEnd(OVERNIGHT, new Date("2026-08-07T12:00:00Z"))).toBeNull();
  });

  it("handles an ordinary same-day window", () => {
    const lunch: QuietHours = { ...OVERNIGHT, startMinute: 12 * 60, endMinute: 13 * 60 };
    expect(isWithinQuietHours(lunch, new Date("2026-08-06T12:30:00Z"))).toBe(true);
    expect(quietHoursEnd(lunch, new Date("2026-08-06T12:30:00Z"))?.toISOString()).toBe(
      "2026-08-06T13:00:00.000Z",
    );
    expect(isWithinQuietHours(lunch, new Date("2026-08-06T14:00:00Z"))).toBe(false);
  });

  it("attributes an overnight window to the day it opened", () => {
    // 2026-08-07 is a Friday. A Friday-night window covers Saturday 02:00
    // without Saturday being in the list, and does not cover Friday 02:00.
    const fridayNight: QuietHours = { ...OVERNIGHT, days: [5] };
    expect(isWithinQuietHours(fridayNight, new Date("2026-08-07T23:00:00Z"))).toBe(true);
    expect(isWithinQuietHours(fridayNight, new Date("2026-08-08T02:00:00Z"))).toBe(true);
    expect(isWithinQuietHours(fridayNight, new Date("2026-08-07T02:00:00Z"))).toBe(false);
  });

  it("treats an empty window as empty, not as all day", () => {
    const empty: QuietHours = { ...OVERNIGHT, startMinute: 540, endMinute: 540 };
    expect(isWithinQuietHours(empty, new Date("2026-08-06T09:00:00Z"))).toBe(false);
    expect(isWithinQuietHours(empty, new Date("2026-08-06T21:00:00Z"))).toBe(false);
  });

  it("lets an urgent alert through the window", () => {
    const withOverride: QuietHours = { ...OVERNIGHT, urgentOverride: "critical" };
    const at = new Date("2026-08-07T03:00:00Z");
    expect(quietHoldUntil(withOverride, "warning", at)).not.toBeNull();
    expect(quietHoldUntil(withOverride, "critical", at)).toBeNull();
    // Without an override, even a critical alert waits.
    expect(quietHoldUntil(OVERNIGHT, "critical", at)).not.toBeNull();
  });

  it("respects a non-UTC zone", () => {
    const berlin: QuietHours = { ...OVERNIGHT, timezone: "Europe/Berlin" };
    // 21:30 UTC is 23:30 in Berlin in August (CEST, UTC+2) — inside the window.
    expect(isWithinQuietHours(berlin, new Date("2026-08-06T21:30:00Z"))).toBe(true);
    // 19:00 UTC is 21:00 Berlin — before it opens.
    expect(isWithinQuietHours(berlin, new Date("2026-08-06T19:00:00Z"))).toBe(false);
    // The release lands at 08:00 local = 06:00 UTC.
    expect(quietHoursEnd(berlin, new Date("2026-08-06T21:30:00Z"))?.toISOString()).toBe(
      "2026-08-07T06:00:00.000Z",
    );
  });

  it("lands on the local hour across a spring-forward", () => {
    // The one branch the other zone cases never reach: the DST correction pass
    // in `quietHoursEnd`. Europe/Berlin springs forward on 2026-03-29 (the last
    // Sunday of March), 02:00 CET → 03:00 CEST.
    //
    // An alert at 23:00 Berlin on the Saturday is inside a 22:00→08:00 window.
    // The window is 10 wall-clock hours but only 9 real ones, because an hour
    // is skipped. Adding 9h of *real* time to the instant lands at 09:00 local,
    // an hour past what the user typed; the correction pulls it back to 08:00.
    const berlin: QuietHours = { ...OVERNIGHT, timezone: "Europe/Berlin" };
    const saturdayNight = new Date("2026-03-28T22:00:00Z"); // 23:00 CET
    expect(isWithinQuietHours(berlin, saturdayNight)).toBe(true);
    // 08:00 CEST on the Sunday is 06:00 UTC.
    expect(quietHoursEnd(berlin, saturdayNight)?.toISOString()).toBe("2026-03-29T06:00:00.000Z");
  });

  it("treats an unreadable timezone as no quiet hours rather than silence", () => {
    // A typo'd zone must not swallow a pager.
    const broken: QuietHours = { ...OVERNIGHT, timezone: "Mars/Olympus_Mons" };
    expect(isWithinQuietHours(broken, new Date("2026-08-07T03:00:00Z"))).toBe(false);
    expect(quietHoldUntil(broken, "warning", new Date("2026-08-07T03:00:00Z"))).toBeNull();
  });

  it("holds a matching alert through routeAlertRules", () => {
    const decision = routeAlertRules(
      [rule({ quietHours: OVERNIGHT, destinations: [{ kind: "push" }] })],
      BASE,
      new Date("2026-08-07T03:00:00Z"),
    );
    expect(decision.legs[0]!.holdUntil?.toISOString()).toBe("2026-08-07T08:00:00.000Z");
  });
});

describe("the registry", () => {
  it("mutes only drift by default", () => {
    expect(DEFAULT_MUTED_TRIGGERS).toEqual(["resourceDrift"]);
  });

  it("keeps the weekly digest off phones", () => {
    expect(PUSHABLE_TRIGGERS).not.toContain("weeklyDigest");
    expect(PUSHABLE_TRIGGERS).toHaveLength(ALERT_TRIGGERS.length - 1);
  });

  it("has unique ids", () => {
    expect(new Set(ALERT_TRIGGERS.map((t) => t.id)).size).toBe(ALERT_TRIGGERS.length);
  });

  it("excludes drift from the synthesized default, as the old column default did", () => {
    const def = defaultAlertRule([{ kind: "push" }]);
    const drift: AlertMatchInput = { ...BASE, trigger: "resourceDrift" };
    expect(routeAlertRules([def], drift, new Date()).unrouted).toBe(true);
    expect(routeAlertRules([def], BASE, new Date()).unrouted).toBe(false);
  });
});

describe("validateAlertRule", () => {
  const ok = {
    name: "Prod anomalies",
    conditions: [] as AlertCondition[],
    destinations: [{ kind: "push" as const }],
    quietHours: null,
    escalation: null,
  };

  it("accepts a well-formed rule", () => {
    expect(validateAlertRule(ok)).toBeNull();
  });

  it("rejects an unnamed rule", () => {
    expect(validateAlertRule({ ...ok, name: "  " })).toMatch(/name is required/i);
  });

  it("rejects an empty value list, which would otherwise match nothing forever", () => {
    expect(
      validateAlertRule({ ...ok, conditions: [{ field: "trigger", op: "in", values: [] }] }),
    ).toMatch(/at least one value/i);
  });

  it("rejects a negative amount", () => {
    expect(
      validateAlertRule({ ...ok, conditions: [{ field: "amountCents", op: "gte", cents: -1 }] }),
    ).toMatch(/non-negative/i);
  });

  it("rejects an unknown timezone", () => {
    expect(
      validateAlertRule({
        ...ok,
        quietHours: {
          timezone: "Nowhere/Nothing",
          startMinute: 0,
          endMinute: 60,
          days: [],
          urgentOverride: null,
        },
      }),
    ).toMatch(/unknown timezone/i);
  });

  it("rejects a quiet-hours override that is not a real severity", () => {
    // The failure this prevents is silent and backwards: `SEVERITY_RANK[bad]`
    // is undefined, every `>=` against it is false, so a typo'd override holds
    // *everything* — including the pages it was written to let through.
    expect(
      validateAlertRule({
        ...ok,
        quietHours: {
          timezone: "UTC",
          startMinute: 0,
          endMinute: 60,
          days: [1],
          urgentOverride: "urgent" as unknown as AlertSeverity,
        },
      }),
    ).toMatch(/override must be one of/i);
    // Null is the documented "hold everything", and stays legal.
    expect(
      validateAlertRule({
        ...ok,
        quietHours: {
          timezone: "UTC",
          startMinute: 0,
          endMinute: 60,
          days: [1],
          urgentOverride: null,
        },
      }),
    ).toBeNull();
  });

  it("rejects an escalation with nowhere to go", () => {
    expect(
      validateAlertRule({ ...ok, escalation: { afterMinutes: 15, destinations: [] } }),
    ).toMatch(/at least one destination/i);
  });

  it("rejects an escalation that fires before anyone could read the original", () => {
    expect(
      validateAlertRule({
        ...ok,
        escalation: { afterMinutes: 0, destinations: [{ kind: "push" }] },
      }),
    ).toMatch(/at least 1 minute/i);
  });
});
