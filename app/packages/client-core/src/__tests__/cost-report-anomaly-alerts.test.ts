import { describe, expect, it } from "vitest";
import {
  DEFAULT_COST_REPORT_ANOMALY_ALERT,
  costReportAnomalyAlertProblem,
} from "../cost-report-anomaly-alerts";

const valid = {
  enabled: true,
  ...DEFAULT_COST_REPORT_ANOMALY_ALERT,
  destinations: [{ kind: "slack" as const, channelId: "c1" }],
};

describe("costReportAnomalyAlertProblem", () => {
  it("accepts the defaults with a destination", () => {
    expect(costReportAnomalyAlertProblem(valid)).toBeNull();
  });

  it("bounds sensitivity and the floor like the org-wide settings", () => {
    expect(costReportAnomalyAlertProblem({ ...valid, sigmas: 0.5 })).toMatch(/between 1 and 10/);
    expect(costReportAnomalyAlertProblem({ ...valid, sigmas: 11 })).toMatch(/between 1 and 10/);
    expect(costReportAnomalyAlertProblem({ ...valid, minDeltaCents: 50 })).toMatch(/minimum rise/);
    expect(costReportAnomalyAlertProblem({ ...valid, minDeltaCents: 10.5 })).toMatch(
      /minimum rise/,
    );
  });

  it("needs somewhere to send an enabled alert, but not a disabled one", () => {
    expect(costReportAnomalyAlertProblem({ ...valid, destinations: [] })).toMatch(
      /at least one destination/,
    );
    expect(
      costReportAnomalyAlertProblem({ ...valid, enabled: false, destinations: [] }),
    ).toBeNull();
  });

  it("caps the destination list", () => {
    const many = Array.from({ length: 21 }, () => ({ kind: "push" as const }));
    expect(costReportAnomalyAlertProblem({ ...valid, destinations: many })).toMatch(/At most 20/);
  });
});
