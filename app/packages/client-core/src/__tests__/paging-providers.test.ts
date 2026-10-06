import { describe, expect, it } from "vitest";
import { destinationKey } from "../alert-routing";
import { pagingDedupKey, sortPagerIncidents, type PagerIncidentRecord } from "../paging-providers";

function incident(partial: Partial<PagerIncidentRecord>): PagerIncidentRecord {
  return {
    id: "x",
    accountId: "a",
    accountName: "PD",
    pluginId: "pagerduty",
    externalId: "P1",
    reference: null,
    title: "t",
    status: "triggered",
    statusLabel: null,
    urgency: null,
    url: null,
    serviceName: null,
    assignees: [],
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: null,
    resolvedAt: null,
    fromInfrawrench: false,
    canAcknowledge: true,
    canResolve: true,
    ...partial,
  };
}

describe("pagingDedupKey", () => {
  it("is stable and readable", () => {
    expect(pagingDedupKey("org1", "probe:p1")).toBe("iw:org1:probe:p1");
    expect(pagingDedupKey("org1", "probe:p1")).toBe(pagingDedupKey("org1", "probe:p1"));
  });

  it("differs between orgs for the same lifecycle key", () => {
    expect(pagingDedupKey("a", "k")).not.toBe(pagingDedupKey("b", "k"));
  });

  it("never exceeds PagerDuty's 255-character limit", () => {
    expect(pagingDedupKey("org", "x".repeat(400))).toHaveLength(255);
  });
});

describe("paging destinations", () => {
  it("keys by account and target so two accounts never collide", () => {
    expect(destinationKey({ kind: "paging-provider", accountId: "a", targetId: "S1" })).toBe(
      "paging-provider:a:S1",
    );
    expect(destinationKey({ kind: "provider-on-call", accountId: "b", sourceId: "S1" })).toBe(
      "provider-on-call:b:S1",
    );
  });
});

describe("sortPagerIncidents", () => {
  it("puts triggered before acknowledged before resolved, newest first", () => {
    const sorted = sortPagerIncidents([
      incident({ id: "r", status: "resolved", createdAt: "2026-10-05T00:00:00Z" }),
      incident({ id: "a", status: "acknowledged", createdAt: "2026-10-04T00:00:00Z" }),
      incident({ id: "t-old", status: "triggered", createdAt: "2026-10-01T00:00:00Z" }),
      incident({ id: "t-new", status: "triggered", createdAt: "2026-10-03T00:00:00Z" }),
    ]);
    expect(sorted.map((i) => i.id)).toEqual(["t-new", "t-old", "a", "r"]);
  });
});
