import { describe, expect, it } from "vitest";
import {
  DORA_SETTINGS_DEFAULTS,
  analyzeDora,
  buildDoraReport,
  detectRollbacks,
  doraBand,
  formatDeployFrequency,
  formatDoraHours,
  formatDoraRate,
  isProductionDeploy,
  matchesDoraPattern,
  sameCommit,
  scopeDoraAnalysis,
  summarizeDora,
  validateDoraSettings,
  type DoraDeployEvent,
  type DoraIncidentInput,
  type DoraSettings,
} from "../dora";

const settings: DoraSettings = { ...DORA_SETTINGS_DEFAULTS };

let seq = 0;
function deploy(at: string, over: Partial<DoraDeployEvent> = {}): DoraDeployEvent {
  seq++;
  return {
    id: over.id ?? `d${seq}`,
    source: "plugin",
    kind: "deployment",
    name: "web",
    environment: "production",
    repository: "acme/web",
    commitSha: null,
    commitAt: null,
    deployedAt: at,
    status: "success",
    isRollback: false,
    accountId: "acct",
    pluginId: "vercel",
    resourceId: `res-${seq}`,
    targetResourceId: "project-web",
    url: null,
    scope: { environment: { key: "production", label: "production" } },
    ...over,
  };
}

function incident(
  startedAt: string,
  resolvedAt: string | null,
  over: Partial<DoraIncidentInput> = {},
): DoraIncidentInput {
  return {
    id: over.id ?? `i-${startedAt}`,
    title: "Outage",
    severity: "sev2",
    startedAt,
    resolvedAt,
    affectedResourceIds: [],
    affectedAccountIds: [],
    ...over,
  };
}

describe("patterns", () => {
  it("matches globs case-insensitively", () => {
    expect(matchesDoraPattern("Production", "production")).toBe(true);
    expect(matchesDoraPattern("prod-eu", "prod*")).toBe(true);
    expect(matchesDoraPattern("web-prod", "*prod")).toBe(true);
    expect(matchesDoraPattern("staging", "prod*")).toBe(false);
    expect(matchesDoraPattern("nightly-deploy-job", "*deploy*")).toBe(true);
    expect(matchesDoraPattern("ab", "a*b*b")).toBe(false);
    expect(matchesDoraPattern("prod (eu)", "prod (eu)")).toBe(true);
  });

  it("counts pipeline runs only when the pipeline is named as a deploy", () => {
    expect(
      isProductionDeploy(
        deploy("2026-10-01T00:00:00Z", { kind: "pipeline", environment: null, name: "web-deploy" }),
        settings,
      ),
    ).toBe(true);
    expect(
      isProductionDeploy(
        deploy("2026-10-01T00:00:00Z", { kind: "pipeline", environment: null, name: "web-tests" }),
        settings,
      ),
    ).toBe(false);
    expect(
      isProductionDeploy(deploy("2026-10-01T00:00:00Z", { environment: "preview" }), settings),
    ).toBe(false);
  });
});

describe("validateDoraSettings", () => {
  it("rejects out-of-range windows and empty production lists", () => {
    expect(validateDoraSettings({ failureWindowHours: 0 })).toMatch(/failureWindowHours/);
    expect(validateDoraSettings({ failureWindowHours: 1.5 })).toMatch(/failureWindowHours/);
    expect(validateDoraSettings({ productionEnvironments: [] })).toMatch(/at least one/);
    expect(validateDoraSettings({ pipelinePatterns: [" "] })).toMatch(/empty/);
    expect(validateDoraSettings({ failureWindowHours: 48, pipelinePatterns: [] })).toBeNull();
  });
});

describe("sameCommit", () => {
  it("treats an abbreviated SHA as the same commit", () => {
    expect(sameCommit("1a2b3c4d5e6f", "1a2b3c4d5e6f7a8b9c0d")).toBe(true);
    expect(sameCommit("1a2b3c4", "1a2b3c5ffff")).toBe(false);
    expect(sameCommit("abc", "abcdef0")).toBe(false);
  });
});

describe("detectRollbacks", () => {
  it("flags a redeploy of an older commit as a rollback of the deploy before it", () => {
    const a = deploy("2026-10-01T10:00:00Z", { id: "a", commitSha: "aaaaaaa1" });
    const b = deploy("2026-10-01T11:00:00Z", { id: "b", commitSha: "bbbbbbb2" });
    const c = deploy("2026-10-01T11:30:00Z", { id: "c", commitSha: "aaaaaaa1" });
    expect([...detectRollbacks([a, b, c])]).toEqual([["c", "b"]]);
  });

  it("never pairs deploys across environments", () => {
    const a = deploy("2026-10-01T10:00:00Z", { id: "a", commitSha: "aaaaaaa1" });
    const b = deploy("2026-10-01T11:00:00Z", { id: "b", commitSha: "bbbbbbb2" });
    const c = deploy("2026-10-01T11:30:00Z", {
      id: "c",
      commitSha: "aaaaaaa1",
      environment: "staging",
    });
    expect(detectRollbacks([a, b, c]).size).toBe(0);
  });

  it("honours the provider's own flag", () => {
    const a = deploy("2026-10-01T10:00:00Z", { id: "a" });
    const b = deploy("2026-10-01T11:00:00Z", { id: "b", isRollback: true });
    expect(detectRollbacks([a, b]).get("b")).toBe("a");
  });
});

describe("analyzeDora", () => {
  it("blames an incident on the most recent matching change in the window only", () => {
    const a = deploy("2026-10-01T08:00:00Z", { id: "a" });
    const b = deploy("2026-10-01T09:00:00Z", { id: "b" });
    const { changes, restores } = analyzeDora({
      events: [a, b],
      incidents: [incident("2026-10-01T10:00:00Z", "2026-10-01T12:00:00Z")],
      resourceChanges: [],
      settings,
    });
    expect(changes.find((c) => c.id === "a")!.failure).toBeNull();
    expect(changes.find((c) => c.id === "b")!.failure?.kind).toBe("incident");
    expect(restores).toHaveLength(1);
    expect(restores[0]!.hours).toBe(2);
    expect(restores[0]!.changeId).toBe("b");
  });

  it("matches incidents to changes by affected resources when they name any", () => {
    const a = deploy("2026-10-01T08:00:00Z", { id: "a", targetResourceId: "api" });
    const b = deploy("2026-10-01T09:00:00Z", { id: "b", targetResourceId: "web" });
    const { changes } = analyzeDora({
      events: [a, b],
      incidents: [incident("2026-10-01T10:00:00Z", null, { affectedResourceIds: ["api"] })],
      resourceChanges: [],
      settings,
    });
    expect(changes.find((c) => c.id === "a")!.failure?.kind).toBe("incident");
    expect(changes.find((c) => c.id === "b")!.failure).toBeNull();
  });

  it("ignores incidents outside the failure window", () => {
    const a = deploy("2026-10-01T08:00:00Z", { id: "a" });
    const { changes } = analyzeDora({
      events: [a],
      incidents: [incident("2026-10-03T08:00:00Z", null)],
      resourceChanges: [],
      settings: { ...settings, failureWindowHours: 24 },
    });
    expect(changes[0]!.failure).toBeNull();
  });

  it("records a rollback as a failure and a restore", () => {
    const a = deploy("2026-10-01T10:00:00Z", { id: "a", commitSha: "aaaaaaa1" });
    const b = deploy("2026-10-01T11:00:00Z", { id: "b", commitSha: "bbbbbbb2" });
    const c = deploy("2026-10-01T11:30:00Z", { id: "c", commitSha: "aaaaaaa1" });
    const { changes, restores } = analyzeDora({
      events: [a, b, c],
      incidents: [],
      resourceChanges: [],
      settings,
    });
    expect(changes.find((x) => x.id === "b")!.failure?.kind).toBe("rollback");
    expect(changes.find((x) => x.id === "c")!.isRollback).toBe(true);
    expect(restores).toEqual([
      expect.objectContaining({ kind: "rollback", hours: 0.5, changeId: "b" }),
    ]);
  });

  it("computes lead time from commit to deploy, never negative", () => {
    const a = deploy("2026-10-02T00:00:00Z", { commitAt: "2026-10-01T00:00:00Z" });
    const b = deploy("2026-10-02T00:00:00Z", { commitAt: "2026-10-03T00:00:00Z" });
    const { changes } = analyzeDora({
      events: [a, b],
      incidents: [],
      resourceChanges: [],
      settings,
    });
    expect(changes.map((c) => c.leadTimeHours)).toEqual([24, 0]);
  });

  it("counts failed deploys and resource changes only when the settings say so", () => {
    const failed = deploy("2026-10-01T00:00:00Z", { status: "failure" });
    const rc = {
      id: "rc1",
      resourceId: "db",
      accountId: "acct",
      pluginId: "aws",
      displayName: "db",
      changeKind: "updated" as const,
      at: "2026-10-01T01:00:00Z",
      revertedAt: "2026-10-01T02:00:00Z",
      scope: {},
    };
    const off = analyzeDora({ events: [failed], incidents: [], resourceChanges: [rc], settings });
    expect(off.changes).toHaveLength(0);
    const on = analyzeDora({
      events: [failed],
      incidents: [],
      resourceChanges: [rc],
      settings: { ...settings, countFailedDeploys: true, includeResourceChanges: true },
    });
    expect(on.changes.map((c) => c.failure?.kind)).toEqual(["failed_deploy", "reverted"]);
  });
});

describe("summary and bands", () => {
  it("bands each metric", () => {
    expect(doraBand("deployment_frequency", 2)).toBe("elite");
    expect(doraBand("deployment_frequency", 0.2)).toBe("high");
    expect(doraBand("deployment_frequency", 0.05)).toBe("medium");
    expect(doraBand("deployment_frequency", 0.01)).toBe("low");
    expect(doraBand("lead_time", 3)).toBe("elite");
    expect(doraBand("lead_time", 24 * 40)).toBe("low");
    expect(doraBand("change_failure_rate", 0.05)).toBe("elite");
    expect(doraBand("change_failure_rate", 0.12)).toBe("medium");
    expect(doraBand("time_to_restore", 0.5)).toBe("elite");
    expect(doraBand("time_to_restore", null)).toBeNull();
  });

  it("summarizes a window", () => {
    const events = [
      deploy("2026-10-01T08:00:00Z", { commitAt: "2026-10-01T06:00:00Z" }),
      deploy("2026-10-02T08:00:00Z", { commitAt: "2026-10-02T04:00:00Z" }),
      deploy("2026-10-03T08:00:00Z"),
      deploy("2026-10-20T08:00:00Z"),
    ];
    const analysis = analyzeDora({
      events,
      incidents: [incident("2026-10-03T09:00:00Z", "2026-10-03T09:30:00Z")],
      resourceChanges: [],
      settings,
    });
    const s = summarizeDora(analysis, "2026-10-01T00:00:00Z", "2026-10-08T00:00:00Z");
    expect(s.deploymentFrequency.deploys).toBe(3);
    expect(s.deploymentFrequency.value).toBeCloseTo(3 / 7);
    expect(s.leadTime.value).toBe(3);
    expect(s.changeFailureRate.value).toBeCloseTo(1 / 3);
    expect(s.timeToRestore.value).toBe(0.5);
    expect(s.timeToRestore.band).toBe("elite");
  });

  it("gives an org with no data no bands", () => {
    const s = summarizeDora(
      { changes: [], restores: [] },
      "2026-10-01T00:00:00Z",
      "2026-10-08T00:00:00Z",
    );
    expect(s.deploymentFrequency.band).toBeNull();
    expect(s.changeFailureRate.value).toBeNull();
  });

  it("scopes restores to the scope's own changes", () => {
    const a = deploy("2026-10-01T08:00:00Z", {
      id: "a",
      scope: { owner: { key: "u1", label: "Ada" } },
    });
    const analysis = analyzeDora({
      events: [a],
      incidents: [
        incident("2026-10-01T09:00:00Z", "2026-10-01T10:00:00Z"),
        incident("2026-10-05T09:00:00Z", "2026-10-05T10:00:00Z"),
      ],
      resourceChanges: [],
      settings,
    });
    expect(analysis.restores).toHaveLength(2);
    expect(scopeDoraAnalysis(analysis, { dimension: "owner", value: "u1" }).restores).toHaveLength(
      1,
    );
    expect(scopeDoraAnalysis(analysis, { dimension: "owner", value: null }).changes).toHaveLength(
      0,
    );
  });
});

describe("buildDoraReport", () => {
  it("builds weekly trend buckets, a breakdown and the previous period", () => {
    const report = buildDoraReport({
      events: [
        deploy("2026-09-20T08:00:00Z"),
        deploy("2026-10-01T08:00:00Z", {
          environment: "prod",
          scope: { environment: { key: "prod", label: "prod" } },
        }),
        deploy("2026-10-08T08:00:00Z"),
      ],
      incidents: [],
      resourceChanges: [],
      settings,
      from: "2026-09-28T00:00:00Z",
      to: "2026-10-12T00:00:00Z",
      bucket: "week",
      filter: null,
      groupBy: "environment",
      dimensions: [],
      settingsView: { ...settings, updatedAt: null },
    });
    expect(report.trend.map((b) => b.start)).toEqual([
      "2026-09-28T00:00:00.000Z",
      "2026-10-05T00:00:00.000Z",
    ]);
    expect(report.trend.map((b) => b.deploys)).toEqual([1, 1]);
    expect(report.previous.deploymentFrequency.deploys).toBe(1);
    expect(report.breakdown.map((r) => r.key).sort()).toEqual(["prod", "production"]);
  });
});

describe("formatting", () => {
  it("formats the four numbers", () => {
    expect(formatDeployFrequency(3)).toBe("3/day");
    expect(formatDeployFrequency(0.5)).toBe("3.5/week");
    expect(formatDeployFrequency(0.05)).toBe("1.5/month");
    expect(formatDeployFrequency(0)).toBe("none");
    expect(formatDoraHours(0.25)).toBe("15m");
    expect(formatDoraHours(6.5)).toBe("6.5h");
    expect(formatDoraHours(72)).toBe("3d");
    expect(formatDoraRate(0.125)).toBe("12.5%");
    expect(formatDoraRate(null)).toBe("n/a");
  });
});
