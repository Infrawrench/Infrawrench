import { describe, expect, it } from "vitest";
import {
  clampIdleLookbackDays,
  IDLE_LOOKBACK_LIMITS,
  IdleFindingAccessError,
  idleAtMost,
  idleRuleKey,
  normalizeIdleFindings,
  resolveIdleThresholds,
  type IdleFindingRecord,
  type IdleScanRequest,
} from "../idle-findings.js";
import { pluginManifestSchema } from "../validation/index.js";

const rule = {
  thresholds: [
    {
      key: "maxBytes",
      label: "Bytes",
      unit: "bytes" as const,
      default: 1_000_000,
      min: 0,
      max: 1e9,
    },
    { key: "maxConns", label: "Connections", unit: "count" as const, default: 0, min: 0, max: 100 },
  ],
};

const request: Pick<IdleScanRequest, "rules" | "resources"> = {
  rules: { "nat-gateway": { thresholds: { maxBytes: 1_000_000, maxConns: 0 } } },
  resources: [
    {
      id: "res-1",
      resourceTypeId: "nat-gateway",
      externalId: "nat-1",
      displayName: "nat-1",
      fields: { region: "us-east-1" },
      resolvedOutputs: {},
    },
  ],
};

function finding(overrides: Partial<IdleFindingRecord> = {}): IdleFindingRecord {
  return {
    ruleId: "nat-gateway",
    subjectKey: "nat-1",
    resourceId: "res-1",
    resourceTypeId: "nat-gateway",
    displayName: "nat-1",
    reason: "No traffic in 14 days",
    evidence: [
      {
        metric: "BytesOutToDestination",
        label: "Bytes sent",
        statistic: "sum",
        value: 0,
        unit: "bytes",
        threshold: 1_000_000,
        comparison: "atMost",
      },
    ],
    estimate: { monthlyAmount: 32.851, currency: "USD", basis: "list-price" },
    ...overrides,
  };
}

describe("resolveIdleThresholds", () => {
  it("takes defaults, applies overrides, clamps into range and ignores junk", () => {
    expect(resolveIdleThresholds(rule, undefined)).toEqual({ maxBytes: 1_000_000, maxConns: 0 });
    expect(resolveIdleThresholds(rule, { maxBytes: 5, maxConns: 500, other: 1 })).toEqual({
      maxBytes: 5,
      maxConns: 100,
    });
    expect(resolveIdleThresholds(rule, { maxBytes: "x", maxConns: -3 })).toEqual({
      maxBytes: 1_000_000,
      maxConns: 0,
    });
    expect(resolveIdleThresholds(rule, { maxBytes: "42" })).toMatchObject({ maxBytes: 42 });
  });
});

describe("clampIdleLookbackDays", () => {
  it("clamps and rounds, falling back to the default", () => {
    expect(clampIdleLookbackDays(3)).toBe(IDLE_LOOKBACK_LIMITS.min);
    expect(clampIdleLookbackDays(400)).toBe(IDLE_LOOKBACK_LIMITS.max);
    expect(clampIdleLookbackDays(20.6)).toBe(21);
    expect(clampIdleLookbackDays("nope")).toBe(IDLE_LOOKBACK_LIMITS.default);
  });
});

describe("normalizeIdleFindings", () => {
  it("keeps a valid finding and rounds the estimate to cents", () => {
    const [out] = normalizeIdleFindings([finding()], request);
    expect(out).toMatchObject({
      ruleId: "nat-gateway",
      resourceId: "res-1",
      resourceTypeId: "nat-gateway",
      estimate: { monthlyAmount: 32.85, currency: "USD", basis: "list-price" },
    });
    expect(out!.evidence).toHaveLength(1);
  });

  it("drops findings for rules that were not requested or resources it was not handed", () => {
    expect(normalizeIdleFindings([finding({ ruleId: "elsewhere" })], request)).toEqual([]);
    expect(normalizeIdleFindings([finding({ resourceId: "res-404" })], request)).toEqual([]);
  });

  it("takes the resource type from the request, never from the plugin", () => {
    const [out] = normalizeIdleFindings([finding({ resourceTypeId: "made-up" })], request);
    expect(out!.resourceTypeId).toBe("nat-gateway");
  });

  it("keeps non-resource subjects with their label and a null type", () => {
    const [out] = normalizeIdleFindings(
      [
        finding({
          resourceId: null,
          resourceTypeId: null,
          subjectKey: "app.requests",
          subjectLabel: "Custom metric",
        }),
      ],
      request,
    );
    expect(out).toMatchObject({
      resourceId: null,
      resourceTypeId: null,
      subjectLabel: "Custom metric",
    });
  });

  it("dedupes (rule, subject) and drops bad estimates and evidence values", () => {
    const out = normalizeIdleFindings(
      [
        finding({
          estimate: { monthlyAmount: -1, currency: "USD", basis: "list-price" },
          evidence: [
            {
              metric: "X",
              label: "X",
              statistic: "sum",
              value: Number.NaN,
              unit: "count",
            },
          ],
        }),
        finding(),
      ],
      request,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.estimate).toBeNull();
    expect(out[0]!.evidence[0]!.value).toBeNull();
  });

  it("never throws on garbage", () => {
    expect(normalizeIdleFindings(null as never, request)).toEqual([]);
    expect(normalizeIdleFindings([null, 3, {}] as never, request)).toEqual([]);
  });
});

describe("helpers", () => {
  it("idleAtMost treats no data as not idle", () => {
    expect(idleAtMost(null, 10)).toBe(false);
    expect(idleAtMost(0, 0)).toBe(true);
    expect(idleAtMost(11, 10)).toBe(false);
  });

  it("idleRuleKey qualifies by plugin", () => {
    expect(idleRuleKey("aws", "nat-gateway")).toBe("aws:nat-gateway");
  });

  it("IdleFindingAccessError carries its help link", () => {
    const err = new IdleFindingAccessError("denied", { label: "Fix", url: "https://example.com" });
    expect(err.name).toBe("IdleFindingAccessError");
    expect(err.helpUrl).toBe("https://example.com");
  });
});

describe("manifest validation", () => {
  const base = {
    id: "demo",
    version: "0.1.0",
    displayName: "Demo",
    description: "Demo plugin",
    logoSvg: "<svg/>",
    author: "Infrawrench",
    minHostVersion: "0.1.0",
  };
  const valid = (m: unknown) => pluginManifestSchema.safeParse(m).success;
  const idleFindings = {
    rules: [
      {
        id: "nat-gateway",
        label: "Idle NAT gateway",
        description: "No traffic",
        resourceTypeIds: ["nat"],
        action: "remove",
        thresholds: [
          { key: "maxBytes", label: "Bytes", unit: "bytes", default: 1, min: 0, max: 2 },
        ],
      },
    ],
  };

  it("accepts a well-formed declaration", () => {
    expect(valid({ ...base, idleFindings })).toBe(true);
  });

  it("rejects a default outside its range and duplicate rule ids", () => {
    const badDefault = structuredClone(idleFindings);
    badDefault.rules[0]!.thresholds[0]!.default = 5;
    expect(valid({ ...base, idleFindings: badDefault })).toBe(false);
    expect(
      valid({ ...base, idleFindings: { rules: [idleFindings.rules[0], idleFindings.rules[0]] } }),
    ).toBe(false);
  });
});
