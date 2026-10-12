import { describe, expect, it } from "vitest";
import { doraBand, doraBandChanges, type DoraMetric, type DoraSummary } from "../dora";
import { DEFAULT_SCORECARD_LEVELS, scorecardLevelDirection } from "../scorecards";
import {
  DORA_BAND_CHANGED,
  SCORECARD_LEVEL_CHANGED,
  SERVICE_CHANGED,
  VULNERABILITY_FOUND,
  eventDataJsonSchema,
  getEventType,
} from "../event-catalog";

function metric(m: DoraMetric, value: number | null, sample = 5) {
  return { value, band: doraBand(m, value), sample };
}

function summary(over: {
  frequency?: number | null;
  lead?: number | null;
  cfr?: number | null;
  restore?: number | null;
}): DoraSummary {
  return {
    deploymentFrequency: {
      ...metric("deployment_frequency", over.frequency ?? null),
      deploys: 0,
      days: 30,
    },
    leadTime: { ...metric("lead_time", over.lead ?? null), p90Hours: null },
    changeFailureRate: {
      ...metric("change_failure_rate", over.cfr ?? null),
      changes: 0,
      failures: 0,
    },
    timeToRestore: { ...metric("time_to_restore", over.restore ?? null), restores: 0 },
  };
}

describe("doraBandChanges", () => {
  it("reports each metric that crossed a band, in metric order, with its direction", () => {
    const before = summary({ frequency: 0.5, lead: 30, cfr: 0.04, restore: 2 });
    const after = summary({ frequency: 1.2, lead: 30, cfr: 0.12, restore: 2 });
    expect(doraBandChanges(before, after)).toEqual([
      {
        metric: "deployment_frequency",
        previousBand: "high",
        band: "elite",
        direction: "improved",
        value: 1.2,
        previousValue: 0.5,
        sample: 5,
      },
      {
        metric: "change_failure_rate",
        previousBand: "elite",
        band: "medium",
        direction: "worsened",
        value: 0.12,
        previousValue: 0.04,
        sample: 5,
      },
    ]);
  });

  it("is empty when values move within a band", () => {
    expect(
      doraBandChanges(summary({ lead: 30, restore: 2 }), summary({ lead: 100, restore: 20 })),
    ).toEqual([]);
  });

  it("treats lower-is-better metrics the right way round", () => {
    const [change] = doraBandChanges(summary({ restore: 30 }), summary({ restore: 0.5 }));
    expect(change).toMatchObject({
      metric: "time_to_restore",
      band: "elite",
      direction: "improved",
    });
    const [worse] = doraBandChanges(summary({ lead: 2 }), summary({ lead: 24 * 40 }));
    expect(worse).toMatchObject({ previousBand: "elite", band: "low", direction: "worsened" });
  });

  it("ignores a metric that has no band on either side", () => {
    // Data appearing or running out is not a performance change.
    expect(doraBandChanges(summary({ restore: null }), summary({ restore: 0.5 }))).toEqual([]);
    expect(doraBandChanges(summary({ lead: 2 }), summary({ lead: null }))).toEqual([]);
  });
});

describe("scorecardLevelDirection", () => {
  const levels = DEFAULT_SCORECARD_LEVELS;
  const [bottom, , top] = [...levels].sort((a, b) => a.minScore - b.minScore);

  it("says up, down or nothing", () => {
    expect(scorecardLevelDirection(bottom!.key, top!.key, levels)).toBe("up");
    expect(scorecardLevelDirection(top!.key, bottom!.key, levels)).toBe("down");
    expect(scorecardLevelDirection(top!.key, top!.key, levels)).toBeNull();
  });

  it("counts no level as the bottom rung in both directions", () => {
    expect(scorecardLevelDirection(null, bottom!.key, levels)).toBe("up");
    expect(scorecardLevelDirection(bottom!.key, null, levels)).toBe("down");
    expect(scorecardLevelDirection(null, null, levels)).toBeNull();
  });
});

describe("the four outbound event types", () => {
  it("are registered with version 1 and a schema", () => {
    for (const def of [
      SERVICE_CHANGED,
      SCORECARD_LEVEL_CHANGED,
      VULNERABILITY_FOUND,
      DORA_BAND_CHANGED,
    ]) {
      expect(getEventType(def.type)).toBe(def);
      expect(def.version).toBe(1);
      expect(eventDataJsonSchema(def)["required"]).toEqual(Object.keys(def.fields));
    }
    expect(
      [SERVICE_CHANGED, SCORECARD_LEVEL_CHANGED, VULNERABILITY_FOUND, DORA_BAND_CHANGED].map(
        (d) => d.type,
      ),
    ).toEqual([
      "service.changed",
      "scorecard.level_changed",
      "vulnerability.found",
      "dora.band_changed",
    ]);
  });
});
