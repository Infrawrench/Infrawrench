import { describe, expect, it } from "vitest";
import {
  BUILTIN_EVIDENCE_SOURCE_IDS,
  COMPLIANCE_FRAMEWORKS,
  compliancePackPeriodFor,
  compliancePeriodDays,
  computeComplianceControls,
  getEvidenceSource,
  parseCompliancePeriod,
  registerEvidenceSource,
  summarizeVulnerabilityEvidence,
  toComplianceCsv,
  validateComplianceControlSetting,
  vulnerabilityEvidenceGaps,
  type ComplianceFrameworkDefinition,
  type EvidenceSourceResult,
  type VulnerabilityFindingRow,
} from "../index";

const result = (
  sourceId: string,
  status: EvidenceSourceResult["status"],
  gaps: string[] = [],
): EvidenceSourceResult => ({
  sourceId,
  label: sourceId,
  kind: "snapshot",
  status,
  summary: `${sourceId} summary`,
  metrics: [],
  gaps,
  itemCount: 0,
  error: null,
});

const framework: ComplianceFrameworkDefinition = {
  id: "test",
  name: "Test",
  version: "1",
  description: "",
  scopeNote: "",
  controls: [
    { id: "A", title: "Two sources", group: "G", sources: ["posture", "audit-log"] },
    { id: "B", title: "One source", group: "G", sources: ["incidents"] },
  ],
};

describe("framework registry", () => {
  it("maps every control onto a known evidence source", () => {
    for (const f of COMPLIANCE_FRAMEWORKS) {
      expect(f.controls.length).toBeGreaterThan(0);
      const ids = new Set<string>();
      for (const c of f.controls) {
        expect(ids.has(c.id), `${f.id} ${c.id} duplicated`).toBe(false);
        ids.add(c.id);
        expect(c.sources.length, `${f.id} ${c.id} has no source`).toBeGreaterThan(0);
        for (const s of c.sources)
          expect(getEvidenceSource(s), `${f.id} ${c.id} -> ${s}`).toBeDefined();
      }
    }
  });

  it("uses every built-in source somewhere", () => {
    const used = new Set(
      COMPLIANCE_FRAMEWORKS.flatMap((f) => f.controls.flatMap((c) => c.sources)),
    );
    for (const id of BUILTIN_EVIDENCE_SOURCE_IDS) expect(used.has(id), id).toBe(true);
  });

  it("keeps ISO control ids inside the 2022 Annex A themes", () => {
    const iso = COMPLIANCE_FRAMEWORKS.find((f) => f.id === "iso27001")!;
    for (const c of iso.controls) expect(c.id).toMatch(/^[5-8]\.\d{1,2}$/);
  });

  it("lets a later feature register a source", () => {
    registerEvidenceSource({
      id: "test-extra",
      label: "Extra",
      description: "",
      kind: "period",
      permission: "resources:read",
      surface: "Extra",
    });
    expect(getEvidenceSource("test-extra")?.label).toBe("Extra");
  });
});

describe("computeComplianceControls", () => {
  it("passes a control when a source has evidence and none shows a gap", () => {
    const { controls, counts } = computeComplianceControls({
      framework,
      results: [
        result("posture", "present"),
        result("audit-log", "no-data"),
        result("incidents", "present"),
      ],
      settings: [],
    });
    expect(controls[0]!.status).toBe("evidence");
    expect(controls[0]!.missingSources).toEqual(["audit-log"]);
    expect(counts).toMatchObject({ evidence: 2, gaps: 0, notApplicable: 0, unowned: 2 });
  });

  it("fails a control on any gap, quoting the reason", () => {
    const { controls } = computeComplianceControls({
      framework,
      results: [
        result("posture", "gap", ["2 critical"]),
        result("audit-log", "present"),
        result("incidents", "present"),
      ],
      settings: [],
    });
    expect(controls[0]!.status).toBe("gaps");
    expect(controls[0]!.reasons).toEqual(["posture: 2 critical"]);
  });

  it("treats no evidence at all as a gap, never a pass", () => {
    const { controls } = computeComplianceControls({
      framework,
      results: [
        result("posture", "present"),
        result("audit-log", "present"),
        result("incidents", "unavailable"),
      ],
      settings: [],
    });
    expect(controls[1]!.status).toBe("gaps");
    expect(controls[1]!.reasons[0]).toMatch(/No evidence collected/);
  });

  it("honours not-applicable and resolves owners, including departed ones", () => {
    const { controls, counts } = computeComplianceControls({
      framework,
      results: [
        result("posture", "gap", ["x"]),
        result("audit-log", "present"),
        result("incidents", "present"),
      ],
      settings: [
        {
          frameworkId: "test",
          controlId: "A",
          applicable: false,
          justification: "No production systems in scope",
          ownerUserId: null,
          ownerLabel: null,
          notes: null,
          updatedByUserId: null,
          updatedAt: "2026-10-01T00:00:00.000Z",
        },
        {
          frameworkId: "test",
          controlId: "B",
          applicable: true,
          justification: null,
          ownerUserId: "gone",
          ownerLabel: null,
          notes: null,
          updatedByUserId: null,
          updatedAt: "2026-10-01T00:00:00.000Z",
        },
        // Another framework's setting must not leak in.
        {
          frameworkId: "other",
          controlId: "B",
          applicable: false,
          justification: "n/a",
          ownerUserId: null,
          ownerLabel: null,
          notes: null,
          updatedByUserId: null,
          updatedAt: "2026-10-01T00:00:00.000Z",
        },
      ],
      memberNames: new Map(),
    });
    expect(controls[0]!.status).toBe("not-applicable");
    expect(controls[0]!.reasons).toEqual([]);
    expect(controls[1]!.status).toBe("evidence");
    expect(controls[1]!.owner).toEqual({
      userId: "gone",
      displayName: "Former member",
      isLabel: false,
    });
    expect(counts).toMatchObject({ notApplicable: 1, evidence: 1, unowned: 0 });
  });
});

describe("validateComplianceControlSetting", () => {
  it("requires a justification for not applicable", () => {
    expect(validateComplianceControlSetting({ applicable: false, justification: "  " })).toMatch(
      /justification/,
    );
    expect(
      validateComplianceControlSetting({ applicable: false, justification: "Out of scope" }),
    ).toBeNull();
  });
  it("refuses a member and a label together", () => {
    expect(
      validateComplianceControlSetting({
        applicable: true,
        ownerUserId: "u",
        ownerLabel: "Security",
      }),
    ).toMatch(/not both/);
  });
});

describe("periods", () => {
  const now = new Date("2026-10-12T15:00:00Z");
  it("defaults to the last 90 days", () => {
    const p = parseCompliancePeriod(undefined, undefined, now);
    expect(p).toEqual({ from: "2026-07-15", to: "2026-10-12" });
    expect(compliancePeriodDays(p as { from: string; to: string })).toBe(90);
  });
  it("rejects malformed and inverted periods", () => {
    expect(parseCompliancePeriod("2026-13-01", undefined, now)).toHaveProperty("error");
    expect(parseCompliancePeriod("2026-10-02", "2026-10-01", now)).toHaveProperty("error");
    expect(parseCompliancePeriod("2024-01-01", "2026-10-01", now)).toHaveProperty("error");
  });
  it("covers the previous month or quarter for scheduled packs", () => {
    expect(compliancePackPeriodFor("monthly", "2026-03-01")).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(compliancePackPeriodFor("monthly", "2026-01-05")).toEqual({
      from: "2025-12-01",
      to: "2025-12-31",
    });
    expect(compliancePackPeriodFor("quarterly", "2026-04-03")).toEqual({
      from: "2026-01-01",
      to: "2026-03-31",
    });
    expect(compliancePackPeriodFor("quarterly", "2026-01-03")).toEqual({
      from: "2025-10-01",
      to: "2025-12-31",
    });
    expect(compliancePackPeriodFor("quarterly", "2026-08-15")).toEqual({
      from: "2026-04-01",
      to: "2026-06-30",
    });
  });
});

describe("toComplianceCsv", () => {
  it("quotes every cell and defuses formulas", () => {
    expect(
      toComplianceCsv(
        ["a", "b"],
        [
          ["=SUM(A1)", null],
          ['say "hi"', 3],
        ],
      ),
    ).toBe('"a","b"\r\n"\t=SUM(A1)",""\r\n"say ""hi""","3"\r\n');
  });
});

describe("summarizeVulnerabilityEvidence", () => {
  const now = Date.parse("2026-10-12T00:00:00Z");
  const finding = (over: Partial<VulnerabilityFindingRow>): VulnerabilityFindingRow =>
    ({
      key: "k",
      accountId: "a",
      accountName: "A",
      pluginId: "aws",
      pluginName: "AWS",
      scanner: "Inspector",
      findingId: "f",
      advisoryId: "CVE-1",
      aliases: [],
      title: null,
      severity: "critical",
      cvssScore: null,
      cvssVector: null,
      packageName: null,
      packageEcosystem: null,
      installedVersion: null,
      fixedVersion: null,
      fixAvailable: null,
      exploitAvailable: null,
      kev: null,
      artifact: {
        kind: "image",
        name: "r",
        digest: null,
        tags: [],
        resourceExternalId: null,
        url: null,
        key: "r",
      },
      firstSeenAt: "2026-09-01T00:00:00Z",
      lastSeenAt: null,
      url: null,
      collectedAt: "2026-10-11T00:00:00Z",
      running: [],
      ...over,
    }) as VulnerabilityFindingRow;
  const running = [
    {
      resourceId: "r1",
      pluginId: "kubernetes",
      resourceTypeId: "pod",
      resourceTypeName: "Pod",
      resourceTypePluralName: "Pods",
      accountId: "a",
      accountName: "A",
      displayName: "p",
    },
  ] as unknown as VulnerabilityFindingRow["running"];

  it("splits running from not running and flags overdue running criticals", () => {
    const summary = summarizeVulnerabilityEvidence(
      {
        findings: [
          finding({ running }),
          finding({ severity: "high", firstSeenAt: "2026-10-10T00:00:00Z" }),
          finding({ severity: "low", firstSeenAt: null }),
        ],
        sources: [],
      },
      [
        {
          advisoryId: "CVE-9",
          severity: "high",
          accountId: "a",
          artifactKind: "image",
          artifactName: "r",
          firstSeenAt: "2026-09-01T00:00:00Z",
          resolvedAt: "2026-10-11T00:00:00Z",
        },
      ],
      now,
    );
    const critical = summary.bySeverity.find((r) => r.severity === "critical")!;
    expect(critical).toMatchObject({ open: 1, openRunning: 1, overdue: 1, overdueRunning: 1 });
    const high = summary.bySeverity.find((r) => r.severity === "high")!;
    expect(high).toMatchObject({
      open: 1,
      openRunning: 0,
      overdue: 0,
      fixed: 1,
      fixedLate: 1,
      medianDaysToFix: 40,
    });
    expect(summary.totalOpenRunning).toBe(1);
    expect(summary.runningResourcesAtRisk).toBe(1);
    expect(vulnerabilityEvidenceGaps(summary)).toEqual([
      "1 running critical finding(s) open longer than the 15-day fix target",
    ]);
  });
});
