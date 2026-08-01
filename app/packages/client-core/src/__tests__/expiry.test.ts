import { describe, expect, it } from "vitest";

import {
  DEFAULT_EXPIRY_LEAD_DAYS,
  DEFAULT_MAX_AGE_DAYS,
  computeExpiryFeed,
  expirySeverity,
  itemsWithinLead,
  parseExpiryInstant,
  type ExpiryScanInput,
} from "../expiry";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");
const DAY = 86_400_000;

function iso(daysFromNow: number): string {
  return new Date(NOW + daysFromNow * DAY).toISOString();
}

const plugins = [
  {
    id: "aws",
    displayName: "AWS",
    resourceTypes: [
      {
        id: "acm-certificate",
        displayName: "ACM Certificate",
        expiryFields: [
          {
            fieldKey: "notAfter",
            from: "expiry" as const,
            kind: "tls-cert" as const,
            label: "Certificate expires",
          },
        ],
      },
      {
        id: "secrets-manager-secret",
        displayName: "Secret",
        expiryFields: [
          {
            fieldKey: "lastChangedDate",
            from: "created" as const,
            kind: "secret-version" as const,
            label: "Last rotated",
            maxAgeDays: 90,
          },
        ],
      },
      { id: "ec2-instance", displayName: "EC2 Instance" },
    ],
  },
  {
    id: "openai",
    displayName: "OpenAI",
    resourceTypes: [
      {
        id: "project-api-key",
        displayName: "Project API Key",
        expiryFields: [
          {
            fieldKey: "createdAt",
            from: "created" as const,
            kind: "api-token" as const,
            label: "Key age",
          },
        ],
      },
    ],
  },
];

const accounts = [
  { id: "acc-aws", displayName: "Prod AWS", pluginId: "aws" },
  { id: "acc-oai", displayName: "OpenAI Org", pluginId: "openai" },
];

function resource(
  overrides: Partial<ExpiryScanInput["resources"][number]> & { id: string },
): ExpiryScanInput["resources"][number] {
  return {
    pluginId: "aws",
    resourceTypeId: "acm-certificate",
    accountId: "acc-aws",
    displayName: overrides.id,
    externalId: null,
    fields: {},
    ...overrides,
  };
}

describe("parseExpiryInstant", () => {
  it("parses ISO 8601 with and without time", () => {
    expect(parseExpiryInstant("2026-08-01T12:00:00.000Z")).toBe(NOW);
    expect(parseExpiryInstant("2026-08-01")).toBe(Date.parse("2026-08-01"));
  });

  it("parses unix epochs in seconds and milliseconds, as numbers or strings", () => {
    expect(parseExpiryInstant(NOW)).toBe(NOW);
    expect(parseExpiryInstant(NOW / 1000)).toBe(NOW);
    expect(parseExpiryInstant(String(NOW))).toBe(NOW);
    expect(parseExpiryInstant(String(NOW / 1000))).toBe(NOW);
  });

  it("parses Go-style timestamps with a trailing zone name", () => {
    expect(parseExpiryInstant("2038-01-18 00:00:00 +0000 UTC")).toBe(
      Date.parse("2038-01-18 00:00:00 +0000"),
    );
  });

  it("rejects sentinels and garbage rather than guessing", () => {
    expect(parseExpiryInstant("")).toBeNull();
    expect(parseExpiryInstant("—")).toBeNull();
    expect(parseExpiryInstant("NEVER")).toBeNull();
    expect(parseExpiryInstant(null)).toBeNull();
    expect(parseExpiryInstant(undefined)).toBeNull();
    expect(parseExpiryInstant(true)).toBeNull();
    expect(parseExpiryInstant(443)).toBeNull(); // a port, not a date
    expect(parseExpiryInstant(Number.NaN)).toBeNull();
  });
});

describe("expirySeverity", () => {
  it("buckets by days remaining", () => {
    expect(expirySeverity(-1, 60)).toBe("expired");
    expect(expirySeverity(0, 60)).toBe("critical");
    expect(expirySeverity(6, 60)).toBe("critical");
    expect(expirySeverity(7, 60)).toBe("warning");
    expect(expirySeverity(29, 60)).toBe("warning");
    expect(expirySeverity(30, 60)).toBe("upcoming");
    expect(expirySeverity(60, 60)).toBe("upcoming");
    expect(expirySeverity(61, 60)).toBe("ok");
  });
});

describe("computeExpiryFeed", () => {
  it("emits one item per declared field with the right severity, sorted soonest first", () => {
    const feed = computeExpiryFeed(
      {
        plugins,
        accounts,
        resources: [
          resource({ id: "cert-ok", fields: { notAfter: iso(200) } }),
          resource({ id: "cert-soon", fields: { notAfter: iso(3) } }),
          resource({ id: "cert-expired", fields: { notAfter: iso(-2) } }),
          resource({ id: "cert-upcoming", fields: { notAfter: iso(45) } }),
        ],
      },
      { now: NOW },
    );

    expect(feed.items.map((i) => i.resourceId)).toEqual([
      "cert-expired",
      "cert-soon",
      "cert-upcoming",
      "cert-ok",
    ]);
    expect(feed.items.map((i) => i.severity)).toEqual(["expired", "critical", "upcoming", "ok"]);
    expect(feed.counts).toEqual({ expired: 1, critical: 1, warning: 0, upcoming: 1, ok: 1 });
    expect(feed.totalCount).toBe(4);
    expect(feed.leadDays).toBe(DEFAULT_EXPIRY_LEAD_DAYS);
    const soon = feed.items[1]!;
    expect(soon.daysRemaining).toBe(3);
    expect(soon.kind).toBe("tls-cert");
    expect(soon.label).toBe("Certificate expires");
    expect(soon.basis).toBe("expiry");
    expect(soon.pluginName).toBe("AWS");
    expect(soon.accountName).toBe("Prod AWS");
  });

  it("derives due dates from age budgets for from:'created' rules", () => {
    const feed = computeExpiryFeed(
      {
        plugins,
        accounts,
        resources: [
          resource({
            id: "stale-secret",
            resourceTypeId: "secrets-manager-secret",
            fields: { lastChangedDate: iso(-100) },
          }),
          resource({
            id: "fresh-key",
            pluginId: "openai",
            resourceTypeId: "project-api-key",
            accountId: "acc-oai",
            fields: { createdAt: iso(-10) },
          }),
        ],
      },
      { now: NOW },
    );

    const secret = feed.items.find((i) => i.resourceId === "stale-secret")!;
    expect(secret.basis).toBe("age");
    expect(secret.daysRemaining).toBe(-10); // 90-day budget, changed 100 days ago
    expect(secret.severity).toBe("expired");

    // No maxAgeDays on the rule → per-kind default budget applies.
    const key = feed.items.find((i) => i.resourceId === "fresh-key")!;
    expect(key.daysRemaining).toBe(DEFAULT_MAX_AGE_DAYS["api-token"] - 10);
  });

  it("honours a custom lead time", () => {
    const feed = computeExpiryFeed(
      { plugins, accounts, resources: [resource({ id: "c", fields: { notAfter: iso(45) } })] },
      { now: NOW, leadDays: 40 },
    );
    expect(feed.items[0]!.severity).toBe("ok");
    expect(feed.leadDays).toBe(40);
    expect(itemsWithinLead(feed)).toEqual([]);
  });

  it("skips unparseable values, undeclared types, and orphaned accounts", () => {
    const feed = computeExpiryFeed(
      {
        plugins,
        accounts,
        resources: [
          resource({ id: "no-date", fields: { notAfter: "" } }),
          resource({ id: "sentinel", fields: { notAfter: "NEVER" } }),
          resource({
            id: "not-declared",
            resourceTypeId: "ec2-instance",
            fields: { notAfter: iso(1) },
          }),
          resource({ id: "gone-account", accountId: "acc-deleted", fields: { notAfter: iso(1) } }),
          resource({ id: "bad-bag", fields: null }),
        ],
      },
      { now: NOW },
    );
    expect(feed.items).toEqual([]);
    expect(feed.totalCount).toBe(0);
  });

  it("emits several items for a resource declaring several rules", () => {
    const feed = computeExpiryFeed(
      {
        plugins: [
          {
            id: "p",
            displayName: "P",
            resourceTypes: [
              {
                id: "t",
                displayName: "T",
                expiryFields: [
                  { fieldKey: "a", from: "expiry" as const, kind: "other" as const, label: "A" },
                  { fieldKey: "b", from: "expiry" as const, kind: "other" as const, label: "B" },
                ],
              },
            ],
          },
        ],
        accounts: [{ id: "acc", displayName: "Acc", pluginId: "p" }],
        resources: [
          {
            id: "r",
            pluginId: "p",
            resourceTypeId: "t",
            accountId: "acc",
            displayName: "r",
            externalId: null,
            fields: { a: iso(1), b: iso(2) },
          },
        ],
      },
      { now: NOW },
    );
    expect(feed.items.map((i) => i.fieldKey)).toEqual(["a", "b"]);
  });
});
