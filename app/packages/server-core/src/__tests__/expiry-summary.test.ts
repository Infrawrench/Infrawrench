import { describe, expect, it } from "vitest";
import type { ExpiryItem } from "@infrawrench/client-core";
import {
  MAX_LISTED_DEADLINES,
  expiryContext,
  expiryItemLine,
  expiryLines,
  expiryTitle,
  formatExpiryPushBody,
  formatExpirySlackBody,
  formatExpiryTeamsBody,
  summarizeExpiry,
} from "../expiry/summary";

/**
 * The message shape is pure so it is pinned down here without a database:
 * the body cap, the per-severity counts, and the "in Nd" / "Nd overdue"
 * grammar every transport shares. The claim/cooldown orchestration is covered
 * by `expiry-alerts.test.ts`.
 */

function item(overrides: Partial<ExpiryItem> = {}): ExpiryItem {
  return {
    resourceId: "r1",
    pluginId: "cloudflare",
    pluginName: "Cloudflare",
    resourceTypeId: "ssl-certificate",
    resourceTypeName: "SSL Certificate",
    accountId: "acc-1",
    accountName: "prod-cf",
    displayName: "example.com",
    externalId: null,
    fieldKey: "expiresAt",
    kind: "tls-cert",
    label: "Certificate expires",
    basis: "expiry",
    dueAt: "2026-08-10T00:00:00.000Z",
    daysRemaining: 9,
    severity: "warning",
    ...overrides,
  };
}

describe("summarizeExpiry", () => {
  it("counts every alertable severity, zeros included", () => {
    const summary = summarizeExpiry(
      [
        item({ severity: "expired", daysRemaining: -3 }),
        item({ severity: "critical", daysRemaining: 2 }),
        item({ severity: "critical", daysRemaining: 5 }),
        item({ severity: "upcoming", daysRemaining: 45 }),
      ],
      60,
    );
    expect(summary.total).toBe(4);
    expect(summary.counts).toEqual({ expired: 1, critical: 2, warning: 0, upcoming: 1 });
    expect(summary.leadDays).toBe(60);
  });

  it("caps the named deadlines and reports the overflow", () => {
    const many = Array.from({ length: MAX_LISTED_DEADLINES + 5 }, (_, i) =>
      item({ displayName: `cert-${i}`, daysRemaining: i }),
    );
    const summary = summarizeExpiry(many, 60);
    expect(summary.items).toHaveLength(MAX_LISTED_DEADLINES);
    expect(summary.items[0]?.displayName).toBe("cert-0");
    expect(summary.omitted).toBe(5);
  });

  it("keeps the feed's soonest-first order rather than re-sorting", () => {
    const summary = summarizeExpiry(
      [item({ displayName: "first" }), item({ displayName: "second" })],
      60,
    );
    expect(summary.items.map((i) => i.displayName)).toEqual(["first", "second"]);
  });
});

describe("expiryItemLine", () => {
  it("renders a future deadline as 'in Nd'", () => {
    expect(expiryItemLine(item({ daysRemaining: 12 }))).toBe(
      "example.com — Certificate expires in 12d",
    );
  });

  it("renders a passed deadline as 'Nd overdue'", () => {
    expect(expiryItemLine(item({ daysRemaining: -3, severity: "expired" }))).toBe(
      "example.com — Certificate expires 3d overdue",
    );
  });

  it("treats due-today as 'in 0d', not expired", () => {
    expect(expiryItemLine(item({ daysRemaining: 0, severity: "critical" }))).toContain("in 0d");
  });
});

describe("titles and bodies", () => {
  it("leads with the lead time while nothing has lapsed", () => {
    const summary = summarizeExpiry([item(), item()], 60);
    expect(expiryTitle(summary)).toBe("Expiry radar: 2 deadlines within 60 days");
  });

  it("leads with the lapsed count once something expired", () => {
    const summary = summarizeExpiry([item({ severity: "expired", daysRemaining: -1 }), item()], 60);
    expect(expiryTitle(summary)).toBe("Expiry radar: 1 deadline passed, 1 approaching");
  });

  it("bolds the headline for Slack and keeps Teams plain", () => {
    const summary = summarizeExpiry([item()], 60);
    expect(formatExpirySlackBody(summary)).toContain("*1 deadline*");
    expect(formatExpiryTeamsBody(summary)).not.toContain("*");
  });

  it("lists each deadline as a bullet and collapses the rest", () => {
    const many = Array.from({ length: MAX_LISTED_DEADLINES + 2 }, (_, i) =>
      item({ displayName: `cert-${i}`, daysRemaining: i }),
    );
    const lines = expiryLines(summarizeExpiry(many, 60), (s) => s);
    expect(lines).toContain("• cert-0 — Certificate expires in 0d");
    expect(lines[lines.length - 1]).toBe("…and 2 more deadlines on the expiry radar");
  });

  it("keeps the push body to the soonest deadline plus the counts", () => {
    const summary = summarizeExpiry(
      [item({ daysRemaining: 2, severity: "critical" }), item({ daysRemaining: 20 })],
      60,
    );
    const body = formatExpiryPushBody(summary);
    expect(body).toContain("example.com — Certificate expires in 2d");
    expect(body).toContain("0 expired · 1 critical · 1 warning · 0 upcoming");
  });

  it("names the lead time in the context line", () => {
    expect(expiryContext(summarizeExpiry([item()], 45))).toContain("45-day lead time");
  });
});
