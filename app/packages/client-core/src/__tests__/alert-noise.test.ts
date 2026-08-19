import { describe, expect, it } from "vitest";

import {
  NOISE_LIMITS,
  buildNoiseReport,
  couldBeActedOn,
  findNoisy,
  formatAckRate,
  groupNoise,
  wasActedOn,
  type NoiseDelivery,
} from "../alert-noise";

const NOW = "2026-08-17T12:00:00.000Z";

function delivery(over: Partial<NoiseDelivery> = {}): NoiseDelivery {
  return {
    trigger: "metricAlerts",
    severity: "warning",
    ruleId: "rule-1",
    ruleName: "Everything to #infra",
    state: "awaiting_ack",
    createdAt: "2026-08-10T09:00:00.000Z",
    acknowledgedAt: null,
    ...over,
  };
}

function many(count: number, over: Partial<NoiseDelivery> = {}): NoiseDelivery[] {
  return Array.from({ length: count }, (_, i) =>
    delivery({
      ...over,
      createdAt: `2026-08-${String((i % 28) + 1).padStart(2, "0")}T09:00:00.000Z`,
    }),
  );
}

describe("wasActedOn", () => {
  it("counts only an explicit acknowledgement", () => {
    // `sent` means the message left the building, not that anybody read it —
    // treating it as engagement would make the report say every org is fine.
    expect(wasActedOn({ state: "sent", acknowledgedAt: null })).toBe(false);
    expect(wasActedOn({ state: "acknowledged", acknowledgedAt: null })).toBe(true);
    expect(wasActedOn({ state: "escalated", acknowledgedAt: NOW })).toBe(true);
  });
});

describe("couldBeActedOn", () => {
  it("excludes deliveries that never showed an ack button", () => {
    // Otherwise the report indicts an org for not pressing a button it was
    // never shown.
    expect(couldBeActedOn({ state: "sent" })).toBe(false);
    expect(couldBeActedOn({ state: "held" })).toBe(false);
    expect(couldBeActedOn({ state: "awaiting_ack" })).toBe(true);
    expect(couldBeActedOn({ state: "expired" })).toBe(true);
  });
});

describe("groupNoise", () => {
  it("groups by rule and by trigger, loudest first", () => {
    const { byRule, byTrigger } = groupNoise([
      ...many(5, { ruleId: "a", ruleName: "A", trigger: "budgetAlerts" }),
      ...many(2, { ruleId: "b", ruleName: "B", trigger: "metricAlerts" }),
    ]);
    expect(byRule.map((g) => g.label)).toEqual(["A", "B"]);
    expect(byRule[0]?.count).toBe(5);
    expect(byTrigger[0]?.label).toBe("budgetAlerts");
  });

  it("keeps deliveries that matched no rule under one entry", () => {
    // An org whose alerts all fall through to the defaults is exactly the one
    // this report should be shouting at.
    const { byRule } = groupNoise(many(3, { ruleId: null, ruleName: null }));
    expect(byRule[0]?.key).toBe("rule:none");
    expect(byRule[0]?.label).toBe("No rule matched");
  });

  it("reports a null ack rate when nothing asked for a response", () => {
    // Not the same as 0%, and rendering it as 0% would be the report's own
    // version of the lie it exists to catch.
    const { byRule } = groupNoise(many(5, { state: "sent" }));
    expect(byRule[0]?.actionable).toBe(0);
    expect(byRule[0]?.acknowledgedRate).toBeNull();
  });

  it("computes the median acknowledgement time", () => {
    const { byRule } = groupNoise([
      delivery({
        state: "acknowledged",
        createdAt: "2026-08-10T09:00:00.000Z",
        acknowledgedAt: "2026-08-10T09:10:00.000Z",
      }),
      delivery({
        state: "acknowledged",
        createdAt: "2026-08-11T09:00:00.000Z",
        acknowledgedAt: "2026-08-11T09:30:00.000Z",
      }),
      delivery({
        state: "acknowledged",
        createdAt: "2026-08-12T09:00:00.000Z",
        acknowledgedAt: "2026-08-12T10:00:00.000Z",
      }),
    ]);
    expect(byRule[0]?.medianAckMinutes).toBe(30);
  });

  it("ignores an acknowledgement recorded before the delivery", () => {
    // Clock skew across replicas; a negative duration would drag the median
    // somewhere no human could interpret.
    const { byRule } = groupNoise([
      delivery({
        state: "acknowledged",
        createdAt: "2026-08-10T09:00:00.000Z",
        acknowledgedAt: "2026-08-10T08:00:00.000Z",
      }),
    ]);
    expect(byRule[0]?.medianAckMinutes).toBeNull();
  });
});

describe("findNoisy", () => {
  const build = (deliveries: NoiseDelivery[]) => findNoisy(groupNoise(deliveries).byRule);

  it("says nothing about a group too small to judge", () => {
    // Three unacknowledged alerts is not evidence, and a report that cried
    // noise at every new rule would be the second thing people ignore.
    expect(build(many(NOISE_LIMITS.minCountToJudge - 1))).toEqual([]);
  });

  it("flags a rule nobody has ever acknowledged", () => {
    const findings = build(many(20));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.reason).toBe("never-acknowledged");
  });

  it("prefers the stronger reason when a group qualifies for two", () => {
    // "Never acknowledged once in 200" is a far stronger statement than
    // "acknowledged 15% of the time"; reporting the weaker one would
    // understate it.
    const findings = build(many(NOISE_LIMITS.floodCount + 20));
    expect(findings[0]?.reason).toBe("never-acknowledged");
  });

  it("flags a flood even when it is being acknowledged", () => {
    const findings = build(many(NOISE_LIMITS.floodCount + 5, { state: "acknowledged" }));
    expect(findings[0]?.reason).toBe("very-frequent");
  });

  it("flags a mostly-ignored rule", () => {
    const findings = build([
      ...many(2, { state: "acknowledged", acknowledgedAt: "2026-08-10T09:05:00.000Z" }),
      ...many(20),
    ]);
    expect(findings[0]?.reason).toBe("mostly-ignored");
  });

  it("says nothing about a rule that is being acted on", () => {
    expect(
      build(many(30, { state: "acknowledged", acknowledgedAt: "2026-08-10T09:05:00.000Z" })),
    ).toEqual([]);
  });

  it("never flags a group whose deliveries could not be acknowledged", () => {
    // A channel-only rule has no ack button; calling it ignored would be
    // indicting the org for the product's own design.
    expect(build(many(50, { state: "sent" }))).toEqual([]);
  });
});

describe("buildNoiseReport", () => {
  it("carries the window and the totals", () => {
    const report = buildNoiseReport(
      [...many(5), ...many(3, { state: "acknowledged", acknowledgedAt: NOW, ruleId: "b" })],
      { from: "2026-07-18T00:00:00.000Z", to: NOW, generatedAt: NOW },
    );
    expect(report.totalDeliveries).toBe(8);
    expect(report.actionableDeliveries).toBe(8);
    expect(report.acknowledgedDeliveries).toBe(3);
    expect(report.from).toBe("2026-07-18T00:00:00.000Z");
  });

  it("is empty and honest with no deliveries", () => {
    const report = buildNoiseReport([], { from: NOW, to: NOW, generatedAt: NOW });
    expect(report).toMatchObject({ totalDeliveries: 0, byRule: [], byTrigger: [], noisy: [] });
  });
});

describe("formatAckRate", () => {
  it("renders a dash rather than a zero for an incomputable rate", () => {
    expect(formatAckRate(null)).toBe("—");
    expect(formatAckRate(0)).toBe("0%");
    expect(formatAckRate(0.615)).toBe("62%");
  });
});
