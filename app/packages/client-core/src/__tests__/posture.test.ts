import { describe, expect, it } from "vitest";

import {
  POSTURE_SEVERITIES,
  alertablePostureFindings,
  computePostureFindings,
  postureFindingKey,
  type PostureCheckRule,
  type PostureScanInput,
} from "../posture";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");
const DAY = 86_400_000;

function rule(overrides: Partial<PostureCheckRule>): PostureCheckRule {
  return {
    id: "test-rule",
    title: "Test rule",
    severity: "high",
    category: "other",
    conditions: [],
    reason: "Test reason",
    ...overrides,
  };
}

/** One plugin, one type carrying `rules`, one account, one resource with `fields`. */
function scan(rules: PostureCheckRule[], fields: unknown): PostureScanInput {
  return {
    plugins: [
      {
        id: "aws",
        displayName: "AWS",
        resourceTypes: [{ id: "bucket", displayName: "S3 Bucket", postureChecks: rules }],
      },
    ],
    accounts: [{ id: "acc-1", displayName: "Prod", pluginId: "aws" }],
    resources: [
      {
        id: "r-1",
        pluginId: "aws",
        resourceTypeId: "bucket",
        accountId: "acc-1",
        displayName: "logs-bucket",
        externalId: "logs-bucket",
        fields,
      },
    ],
  };
}

function matched(rules: PostureCheckRule[], fields: unknown): boolean {
  return computePostureFindings(scan(rules, fields), { now: NOW }).totalCount === 1;
}

describe("computePostureFindings conditions", () => {
  it("empty matches an absent field and an empty string, but not 0", () => {
    const r = [rule({ conditions: [{ fieldKey: "policy", when: "empty" }] })];
    expect(matched(r, {})).toBe(true);
    expect(matched(r, { policy: "" })).toBe(true);
    expect(matched(r, { policy: 0 })).toBe(false);
    expect(matched(r, { policy: "restricted" })).toBe(false);
  });

  it("equals compares case-insensitively and never matches an absent field", () => {
    const r = [rule({ conditions: [{ fieldKey: "acl", when: "equals", value: "public-read" }] })];
    expect(matched(r, { acl: "PUBLIC-READ" })).toBe(true);
    expect(matched(r, { acl: "private" })).toBe(false);
    // Absent is distinct from empty: a resource synced before the field
    // existed must not alarm.
    expect(matched(r, {})).toBe(false);
    expect(matched(r, { acl: "" })).toBe(false);
  });

  it("notEquals never matches an absent field either", () => {
    const r = [rule({ conditions: [{ fieldKey: "sslMode", when: "notEquals", value: "full" }] })];
    expect(matched(r, { sslMode: "flexible" })).toBe(true);
    expect(matched(r, { sslMode: "Full" })).toBe(false);
    expect(matched(r, {})).toBe(false);
  });

  it("truthy matches booleans, non-zero numbers and true-words only", () => {
    const r = [rule({ conditions: [{ fieldKey: "public", when: "truthy" }] })];
    expect(matched(r, { public: true })).toBe(true);
    expect(matched(r, { public: "true" })).toBe(true);
    expect(matched(r, { public: "Yes" })).toBe(true);
    expect(matched(r, { public: 1 })).toBe(true);
    expect(matched(r, { public: false })).toBe(false);
    expect(matched(r, { public: "false" })).toBe(false);
    expect(matched(r, { public: 0 })).toBe(false);
    // Unknown strings are not true-like — never alarm on data we can't read.
    expect(matched(r, { public: "banana" })).toBe(false);
    expect(matched(r, {})).toBe(false);
  });

  it("falsy matches false-like values but not absent or empty", () => {
    const r = [rule({ conditions: [{ fieldKey: "encrypted", when: "falsy" }] })];
    expect(matched(r, { encrypted: false })).toBe(true);
    expect(matched(r, { encrypted: "false" })).toBe(true);
    expect(matched(r, { encrypted: "No" })).toBe(true);
    expect(matched(r, { encrypted: 0 })).toBe(true);
    expect(matched(r, { encrypted: true })).toBe(false);
    expect(matched(r, { encrypted: "true" })).toBe(false);
    // Absent and "" are `empty`'s territory: a resource synced before the
    // field existed must not read as unencrypted.
    expect(matched(r, {})).toBe(false);
    expect(matched(r, { encrypted: "" })).toBe(false);
    expect(matched(r, { encrypted: "banana" })).toBe(false);
  });

  it("olderThanDays matches instants past the budget, in every stored format", () => {
    const r = [rule({ conditions: [{ fieldKey: "createdAt", when: "olderThanDays", days: 90 }] })];
    const old = NOW - 91 * DAY;
    const fresh = NOW - 89 * DAY;
    expect(matched(r, { createdAt: new Date(old).toISOString() })).toBe(true);
    expect(matched(r, { createdAt: new Date(fresh).toISOString() })).toBe(false);
    // Unix epochs, seconds and milliseconds, number or numeric string.
    expect(matched(r, { createdAt: Math.floor(old / 1000) })).toBe(true);
    expect(matched(r, { createdAt: old })).toBe(true);
    expect(matched(r, { createdAt: String(old) })).toBe(true);
    // Date-only strings.
    expect(matched(r, { createdAt: new Date(old).toISOString().slice(0, 10) })).toBe(true);
    // Unparseable or absent fails the condition, never alarms.
    expect(matched(r, { createdAt: "not a date" })).toBe(false);
    expect(matched(r, { createdAt: 80 })).toBe(false); // a count, not an epoch
    expect(matched(r, {})).toBe(false);
  });

  it("requires ALL conditions to hold", () => {
    const r = [
      rule({
        conditions: [
          { fieldKey: "publiclyAccessible", when: "truthy" },
          { fieldKey: "storageEncrypted", when: "falsy" },
        ],
      }),
    ];
    expect(matched(r, { publiclyAccessible: true, storageEncrypted: false })).toBe(true);
    expect(matched(r, { publiclyAccessible: true, storageEncrypted: true })).toBe(false);
    expect(matched(r, { publiclyAccessible: false, storageEncrypted: false })).toBe(false);
  });

  it("a rule with no conditions never matches", () => {
    expect(matched([rule({ conditions: [] })], { anything: "x" })).toBe(false);
  });

  it("a non-object fields bag only defeats value conditions, not empty ones", () => {
    const emptyRule = [rule({ conditions: [{ fieldKey: "policy", when: "empty" }] })];
    const truthyRule = [rule({ conditions: [{ fieldKey: "public", when: "truthy" }] })];
    expect(matched(emptyRule, null)).toBe(true);
    expect(matched(emptyRule, "corrupt")).toBe(true);
    expect(matched(truthyRule, null)).toBe(false);
    expect(matched(truthyRule, [1, 2])).toBe(false);
  });
});

describe("computePostureFindings aggregation", () => {
  const input: PostureScanInput = {
    plugins: [
      {
        id: "aws",
        displayName: "AWS",
        resourceTypes: [
          {
            id: "bucket",
            displayName: "S3 Bucket",
            postureChecks: [
              rule({
                id: "public",
                title: "Bucket public",
                severity: "critical",
                category: "public-exposure",
                conditions: [{ fieldKey: "public", when: "truthy" }],
                reason: "Bucket is public",
              }),
              rule({
                id: "unencrypted",
                title: "Bucket unencrypted",
                severity: "medium",
                category: "encryption",
                conditions: [{ fieldKey: "encrypted", when: "falsy" }],
                reason: "Bucket is unencrypted",
              }),
            ],
          },
          // A type with no rules contributes nothing.
          { id: "queue", displayName: "SQS Queue" },
        ],
      },
      {
        id: "hetzner",
        displayName: "Hetzner",
        resourceTypes: [
          {
            id: "server",
            displayName: "Server",
            postureChecks: [
              rule({
                id: "no-firewall",
                title: "No firewall",
                severity: "high",
                category: "public-exposure",
                conditions: [{ fieldKey: "firewallIds", when: "empty" }],
                reason: "Server has no firewall attached",
              }),
            ],
          },
        ],
      },
    ],
    accounts: [
      { id: "acc-b", displayName: "Beta", pluginId: "aws" },
      { id: "acc-a", displayName: "Alpha", pluginId: "hetzner" },
    ],
    resources: [
      {
        id: "r-1",
        pluginId: "aws",
        resourceTypeId: "bucket",
        accountId: "acc-b",
        displayName: "b-bucket",
        externalId: null,
        // Matches both bucket rules.
        fields: { public: true, encrypted: false },
      },
      {
        id: "r-2",
        pluginId: "aws",
        resourceTypeId: "bucket",
        accountId: "acc-b",
        displayName: "a-bucket",
        externalId: null,
        fields: { public: "true", encrypted: true },
      },
      {
        id: "r-3",
        pluginId: "hetzner",
        resourceTypeId: "server",
        accountId: "acc-a",
        displayName: "web-1",
        externalId: "42",
        fields: { firewallIds: "" },
      },
      {
        // Account soft-deleted (missing from accounts) — skipped entirely.
        id: "r-4",
        pluginId: "aws",
        resourceTypeId: "bucket",
        accountId: "acc-gone",
        displayName: "ghost",
        externalId: null,
        fields: { public: true },
      },
      {
        // Type without rules — skipped.
        id: "r-5",
        pluginId: "aws",
        resourceTypeId: "queue",
        accountId: "acc-b",
        displayName: "jobs",
        externalId: null,
        fields: {},
      },
    ],
  };

  it("sorts by severity rank, then account name, then display name", () => {
    const feed = computePostureFindings(input, { now: NOW });
    expect(feed.findings.map((f) => [f.ruleId, f.displayName])).toEqual([
      ["public", "a-bucket"],
      ["public", "b-bucket"],
      ["no-firewall", "web-1"],
      ["unencrypted", "b-bucket"],
    ]);
    expect(feed.totalCount).toBe(4);
    expect(feed.counts).toEqual({ critical: 2, high: 1, medium: 1, low: 0 });
    expect(feed.generatedAt).toBe(new Date(NOW).toISOString());
  });

  it("carries full resource identity on each finding", () => {
    const feed = computePostureFindings(input, { now: NOW });
    const f = feed.findings.find((x) => x.resourceId === "r-3");
    expect(f).toMatchObject({
      pluginId: "hetzner",
      pluginName: "Hetzner",
      resourceTypeId: "server",
      resourceTypeName: "Server",
      accountId: "acc-a",
      accountName: "Alpha",
      displayName: "web-1",
      externalId: "42",
      ruleId: "no-firewall",
      title: "No firewall",
      severity: "high",
      category: "public-exposure",
      reason: "Server has no firewall attached",
    });
  });

  it("is deterministic across identical inputs", () => {
    const a = computePostureFindings(input, { now: NOW });
    const b = computePostureFindings(input, { now: NOW });
    expect(a).toEqual(b);
  });

  it("returns an empty feed when nothing declares rules", () => {
    const feed = computePostureFindings(
      { plugins: [{ id: "p", displayName: "P", resourceTypes: [] }], accounts: [], resources: [] },
      { now: NOW },
    );
    expect(feed.findings).toEqual([]);
    expect(feed.counts).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
  });

  describe("dismissals", () => {
    /** One accepted finding, keyed the way every surface keys them. */
    const dismissal = {
      resourceId: "r-1",
      ruleId: "public",
      dismissedAt: "2026-07-01T09:00:00.000Z",
      dismissedBy: "Ada",
      reason: "Static site bucket, public on purpose",
    };

    it("moves a dismissed finding out of findings and counts", () => {
      const feed = computePostureFindings({ ...input, dismissals: [dismissal] }, { now: NOW });
      expect(feed.findings.map((f) => [f.resourceId, f.ruleId])).toEqual([
        ["r-2", "public"],
        ["r-3", "no-firewall"],
        ["r-1", "unencrypted"],
      ]);
      expect(feed.totalCount).toBe(3);
      expect(feed.counts).toEqual({ critical: 1, high: 1, medium: 1, low: 0 });
      expect(feed.dismissedCount).toBe(1);
      expect(feed.dismissed.map((f) => [f.resourceId, f.ruleId])).toEqual([["r-1", "public"]]);
      // The dismissal travels with the finding, note and author intact.
      expect(feed.dismissed[0]?.dismissal).toEqual(dismissal);
      // …and the finding itself is still fully computed.
      expect(feed.dismissed[0]?.title).toBe("Bucket public");
    });

    it("keeps a dismissed finding out of the alert feed", () => {
      const feed = computePostureFindings({ ...input, dismissals: [dismissal] }, { now: NOW });
      expect(alertablePostureFindings(feed).map((f) => f.resourceId)).toEqual(["r-2", "r-3"]);
    });

    it("dismisses one rule on a resource without touching its other findings", () => {
      const feed = computePostureFindings({ ...input, dismissals: [dismissal] }, { now: NOW });
      // r-1 matches both bucket rules; only `public` was accepted.
      expect(feed.findings.some((f) => f.resourceId === "r-1" && f.ruleId === "unencrypted")).toBe(
        true,
      );
    });

    it("ignores a dismissal whose finding no longer matches", () => {
      const feed = computePostureFindings(
        {
          ...input,
          dismissals: [
            dismissal,
            // Right resource, rule that isn't matching.
            { ...dismissal, ruleId: "no-firewall" },
            // Resource that no longer exists at all.
            { ...dismissal, resourceId: "r-gone" },
          ],
        },
        { now: NOW },
      );
      expect(feed.dismissedCount).toBe(1);
      expect(feed.totalCount).toBe(3);
    });

    it("lists dismissed findings most recently accepted first", () => {
      const feed = computePostureFindings(
        {
          ...input,
          dismissals: [
            dismissal,
            {
              resourceId: "r-3",
              ruleId: "no-firewall",
              dismissedAt: "2026-07-20T09:00:00.000Z",
              dismissedBy: null,
              reason: null,
            },
          ],
        },
        { now: NOW },
      );
      expect(feed.dismissed.map((f) => f.resourceId)).toEqual(["r-3", "r-1"]);
    });

    it("changes nothing when the dismissal list is empty or absent", () => {
      const withEmpty = computePostureFindings({ ...input, dismissals: [] }, { now: NOW });
      const without = computePostureFindings(input, { now: NOW });
      expect(withEmpty).toEqual(without);
      expect(without.dismissed).toEqual([]);
      expect(without.dismissedCount).toBe(0);
    });
  });
});

describe("postureFindingKey", () => {
  it("cannot be collided by punctuation in either half", () => {
    // Both halves routinely contain slashes, colons and hyphens — GCP ids are
    // slash-paths — so a printable delimiter would be forgeable.
    expect(postureFindingKey({ resourceId: "a", ruleId: "b:c" })).not.toBe(
      postureFindingKey({ resourceId: "a:b", ruleId: "c" }),
    );
    expect(postureFindingKey({ resourceId: "projects/p/zones/z", ruleId: "r" })).toBe(
      postureFindingKey({ resourceId: "projects/p/zones/z", ruleId: "r" }),
    );
  });
});

describe("alertablePostureFindings", () => {
  it("keeps critical and high only", () => {
    const feed = computePostureFindings(
      scan(
        [
          rule({ id: "c", severity: "critical", conditions: [{ fieldKey: "a", when: "truthy" }] }),
          rule({ id: "h", severity: "high", conditions: [{ fieldKey: "a", when: "truthy" }] }),
          rule({ id: "m", severity: "medium", conditions: [{ fieldKey: "a", when: "truthy" }] }),
          rule({ id: "l", severity: "low", conditions: [{ fieldKey: "a", when: "truthy" }] }),
        ],
        { a: true },
      ),
      { now: NOW },
    );
    expect(alertablePostureFindings(feed).map((f) => f.ruleId)).toEqual(["c", "h"]);
  });
});

describe("POSTURE_SEVERITIES", () => {
  it("is in escalation order, worst first", () => {
    expect(POSTURE_SEVERITIES).toEqual(["critical", "high", "medium", "low"]);
  });
});
