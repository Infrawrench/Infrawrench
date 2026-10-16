import { describe, expect, it, vi } from "vitest";
import type { IdleRuleDeclaration, OrphanAccountGroup } from "@infrawrench/plugin-base";

/**
 * The read side of idle findings: the merge into the orphan feed, the rule
 * catalog and the settings validation are pure; the database is never
 * reached, so the client module is stubbed only to keep its import inert.
 */
vi.mock("../db/client", () => ({ db: {} }));
vi.mock("../plugin-loader", () => ({ loadPlugins: async () => [] }));

const { mergeIdleFindings, buildIdleRuleViews, IDLE_FINDING_ROW_PREFIX } =
  await import("../idle/feed");
const { idleRuleRequests, normalizeIdleSettings, validateIdleSettingsPatch, IdleSettingsError } =
  await import("../idle/settings");

const natRule: IdleRuleDeclaration = {
  id: "nat-gateway",
  label: "Idle NAT gateway",
  description: "No traffic",
  resourceTypeIds: ["nat-gateway"],
  action: "remove",
  thresholds: [
    {
      key: "maxBytesOut",
      label: "Bytes out",
      unit: "bytes",
      default: 1_000_000,
      min: 0,
      max: 1e10,
    },
  ],
};
const tableRule: IdleRuleDeclaration = {
  id: "dynamodb-provisioned",
  label: "Over-provisioned DynamoDB table",
  description: "Consumes a fraction of provisioned capacity",
  resourceTypeIds: ["dynamodb-table"],
  action: "reconfigure",
  thresholds: [
    { key: "maxUtilization", label: "Utilisation", unit: "percent", default: 5, min: 0, max: 50 },
  ],
};

const awsPlugin = {
  id: "aws",
  displayName: "AWS",
  resourceTypes: [
    { id: "nat-gateway", displayName: "NAT Gateway" },
    { id: "dynamodb-table", displayName: "DynamoDB Table" },
    { id: "ebs-volume", displayName: "EBS Volume" },
  ],
  rules: [natRule, tableRule],
  remediationCommands: () => [
    {
      tool: "aws",
      command: "aws ec2 delete-nat-gateway",
      description: "Delete",
      destructive: true,
    },
  ],
};
const ddPlugin = {
  id: "datadog",
  displayName: "Datadog",
  resourceTypes: [],
  rules: [
    {
      id: "unused-custom-metric",
      label: "Unused custom metric",
      description: "Never queried",
      resourceTypeIds: [],
      action: "reconfigure" as const,
      thresholds: [],
    },
  ],
};

function stored(over: Record<string, unknown> = {}) {
  return {
    id: "f-1",
    accountId: "acc-aws",
    pluginId: "aws",
    ruleId: "nat-gateway",
    subjectKey: "nat-0abc",
    resourceId: "res-nat",
    resourceTypeId: "nat-gateway",
    displayName: "nat-0abc",
    subjectLabel: null,
    reason: "No traffic in 14 days",
    evidence: [
      {
        metric: "BytesOutToDestination",
        label: "Bytes out",
        statistic: "sum" as const,
        value: 0,
        unit: "bytes" as const,
        threshold: 1_000_000,
        comparison: "atMost" as const,
      },
    ],
    estimate: { monthlyAmount: 32.85, currency: "USD", basis: "list-price" as const },
    fields: { region: "us-east-1" },
    lookbackDays: 14,
    firstDetectedAt: new Date("2026-10-01T00:00:00Z"),
    evaluatedAt: new Date("2026-10-16T00:00:00Z"),
    ...over,
  };
}

const accounts = [
  { id: "acc-aws", displayName: "Prod AWS", pluginId: "aws" },
  { id: "acc-dd", displayName: "Datadog", pluginId: "datadog" },
];
const resourcesById = new Map([
  [
    "res-nat",
    {
      id: "res-nat",
      externalId: "nat-0abc",
      displayName: "egress-nat",
      fields: { region: "us-east-1", vpcId: "vpc-1" },
      lastSyncedAt: "2026-10-16T01:00:00.000Z",
    },
  ],
  [
    "res-vol",
    { id: "res-vol", externalId: "vol-1", displayName: "old-disk", fields: {}, lastSyncedAt: null },
  ],
]);
const settings = { enabled: true, lookbackDays: 14, rules: {} };

describe("mergeIdleFindings", () => {
  it("adds a resource-backed row with its evidence, estimate and commands", () => {
    const groups = mergeIdleFindings([], {
      findings: [stored()],
      settings,
      plugins: [awsPlugin],
      accounts,
      resourcesById,
    });
    expect(groups).toHaveLength(1);
    const row = groups[0]!.resources[0]!;
    expect(row).toMatchObject({
      id: "res-nat",
      resourceTypeName: "NAT Gateway",
      displayName: "egress-nat",
      externalId: "nat-0abc",
      cost: null,
      estimate: { monthlyAmount: 32.85 },
      idle: {
        ruleKey: "aws:nat-gateway",
        ruleLabel: "Idle NAT gateway",
        action: "remove",
        hasResource: true,
        detectedAt: "2026-10-01T00:00:00.000Z",
      },
    });
    expect(row.remediation?.commands).toHaveLength(1);
    expect(groups[0]!.pluginName).toBe("AWS");
  });

  it("gives a non-resource subject a finding id and its label", () => {
    const groups = mergeIdleFindings([], {
      findings: [
        stored({
          id: "f-dd",
          accountId: "acc-dd",
          pluginId: "datadog",
          ruleId: "unused-custom-metric",
          subjectKey: "app.checkout.latency",
          resourceId: null,
          resourceTypeId: null,
          displayName: "app.checkout.latency",
          subjectLabel: "Custom metric",
          estimate: null,
        }),
      ],
      settings,
      plugins: [ddPlugin],
      accounts,
      resourcesById,
    });
    const row = groups[0]!.resources[0]!;
    expect(row.id).toBe(`${IDLE_FINDING_ROW_PREFIX}f-dd`);
    expect(row.resourceTypeName).toBe("Custom metric");
    expect(row.externalId).toBe("app.checkout.latency");
    expect(row.idle?.hasResource).toBe(false);
  });

  it("skips disabled rules, the master switch, gone resources and already-flagged rows", () => {
    const base = { plugins: [awsPlugin], accounts, resourcesById };
    expect(
      mergeIdleFindings([], {
        ...base,
        findings: [stored()],
        settings: { ...settings, rules: { "aws:nat-gateway": { enabled: false } } },
      }),
    ).toEqual([]);
    expect(
      mergeIdleFindings([], {
        ...base,
        findings: [stored()],
        settings: { ...settings, enabled: false },
      }),
    ).toEqual([]);
    expect(
      mergeIdleFindings([], { ...base, findings: [stored({ resourceId: "res-gone" })], settings }),
    ).toEqual([]);

    const existing: OrphanAccountGroup[] = [
      {
        accountId: "acc-aws",
        accountName: "Prod AWS",
        pluginId: "aws",
        pluginName: "AWS",
        resources: [
          {
            id: "res-nat",
            pluginId: "aws",
            resourceTypeId: "nat-gateway",
            resourceTypeName: "NAT Gateway",
            displayName: "egress-nat",
            externalId: "nat-0abc",
            reason: "orphan rule",
            cost: null,
            owner: null,
            lastSyncedAt: null,
          },
        ],
      },
    ];
    const merged = mergeIdleFindings(existing, { ...base, findings: [stored()], settings });
    expect(merged[0]!.resources).toHaveLength(1);
    expect(merged[0]!.resources[0]!.reason).toBe("orphan rule");
  });

  it("drops findings for rules the plugin no longer declares", () => {
    expect(
      mergeIdleFindings([], {
        findings: [stored({ ruleId: "retired-rule" })],
        settings,
        plugins: [awsPlugin],
        accounts,
        resourcesById,
      }),
    ).toEqual([]);
  });
});

describe("buildIdleRuleViews", () => {
  it("resolves effective thresholds and switches from the org's overrides", () => {
    const views = buildIdleRuleViews([awsPlugin], {
      ...settings,
      rules: {
        "aws:nat-gateway": { thresholds: { maxBytesOut: 5_000 } },
        "aws:dynamodb-provisioned": { enabled: false },
      },
    });
    const nat = views.find((v) => v.ruleKey === "aws:nat-gateway")!;
    expect(nat.enabled).toBe(true);
    expect(nat.thresholds[0]).toMatchObject({ value: 5_000, default: 1_000_000 });
    expect(nat.resourceTypeNames).toEqual(["NAT Gateway"]);
    expect(views.find((v) => v.ruleKey === "aws:dynamodb-provisioned")!.enabled).toBe(false);
  });
});

describe("idle settings", () => {
  const declared = new Map([
    ["aws:nat-gateway", { rule: natRule }],
    ["aws:dynamodb-provisioned", { rule: tableRule }],
  ]);

  it("accepts a valid patch", () => {
    expect(() =>
      validateIdleSettingsPatch(
        {
          lookbackDays: 30,
          rules: { "aws:nat-gateway": { enabled: true, thresholds: { maxBytesOut: 0 } } },
        },
        declared,
      ),
    ).not.toThrow();
  });

  it("rejects out-of-range values and unknown keys rather than clamping", () => {
    expect(() => validateIdleSettingsPatch({ lookbackDays: 3 }, declared)).toThrow(
      IdleSettingsError,
    );
    expect(() => validateIdleSettingsPatch({ lookbackDays: 14.5 }, declared)).toThrow(
      IdleSettingsError,
    );
    expect(() => validateIdleSettingsPatch({ rules: { "aws:nope": {} } }, declared)).toThrow(
      /Unknown idle rule/,
    );
    expect(() =>
      validateIdleSettingsPatch(
        { rules: { "aws:nat-gateway": { thresholds: { bogus: 1 } } } },
        declared,
      ),
    ).toThrow(/Unknown threshold/);
    expect(() =>
      validateIdleSettingsPatch(
        { rules: { "aws:dynamodb-provisioned": { thresholds: { maxUtilization: 90 } } } },
        declared,
      ),
    ).toThrow(/from 0 to 50/);
  });

  it("normalizes a hand-written row back into bounds", () => {
    expect(
      normalizeIdleSettings({
        lookbackDays: 400,
        rules: {
          "aws:nat-gateway": { enabled: "yes", thresholds: { maxBytesOut: "x", ok: 3 } },
        } as never,
      }),
    ).toEqual({
      enabled: true,
      lookbackDays: 42,
      rules: { "aws:nat-gateway": { thresholds: { ok: 3 } } },
    });
  });

  it("builds the plugin request from enabled rules only", () => {
    const requests = idleRuleRequests(
      "aws",
      { rules: [natRule, tableRule] },
      { ...settings, rules: { "aws:dynamodb-provisioned": { enabled: false } } },
    );
    expect(requests).toEqual({ "nat-gateway": { thresholds: { maxBytesOut: 1_000_000 } } });
    expect(idleRuleRequests("aws", { rules: [natRule] }, { ...settings, enabled: false })).toEqual(
      {},
    );
  });
});
