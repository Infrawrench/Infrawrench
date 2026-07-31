import { describe, expect, it } from "vitest";
import {
  MAX_DIFF_FIELDS,
  MAX_LISTED_CHANGES,
  MAX_SCANNED_CHANGES,
  accountEnabled,
  driftContext,
  driftLines,
  driftTitle,
  enabledKinds,
  formatDriftPushBody,
  formatDriftSlackBody,
  formatDriftTeamsBody,
  kindEnabled,
  summarizeDrift,
  type DriftChangeRow,
  type DriftFilter,
} from "../drift/summary";

const SINCE = new Date("2026-07-31T09:00:00.000Z");

const DEFAULT_FILTER: DriftFilter = {
  notifyCreated: true,
  notifyUpdated: false,
  notifyDeleted: true,
  accountIds: [],
};

function row(overrides: Partial<DriftChangeRow> = {}): DriftChangeRow {
  return {
    accountId: "acc-1",
    accountName: "prod-aws",
    resourceTypeId: "ec2-instance",
    displayName: "web-1",
    changeKind: "updated",
    fields: [],
    ...overrides,
  };
}

describe("drift filter", () => {
  it("ships with field updates off and appearances/disappearances on", () => {
    expect(kindEnabled(DEFAULT_FILTER, "created")).toBe(true);
    expect(kindEnabled(DEFAULT_FILTER, "deleted")).toBe(true);
    expect(kindEnabled(DEFAULT_FILTER, "updated")).toBe(false);
    expect(enabledKinds(DEFAULT_FILTER)).toEqual(["created", "deleted"]);
  });

  it("an empty account list means every account", () => {
    expect(accountEnabled(DEFAULT_FILTER, "anything")).toBe(true);
  });

  it("a non-empty account list is a whitelist", () => {
    const scoped = { ...DEFAULT_FILTER, accountIds: ["acc-1", "acc-2"] };
    expect(accountEnabled(scoped, "acc-2")).toBe(true);
    expect(accountEnabled(scoped, "acc-9")).toBe(false);
  });

  it("every kind off yields no kinds to query for", () => {
    const muted: DriftFilter = {
      notifyCreated: false,
      notifyUpdated: false,
      notifyDeleted: false,
      accountIds: [],
    };
    expect(enabledKinds(muted)).toEqual([]);
  });
});

describe("summarizeDrift caps", () => {
  it("counts each kind and keeps distinct accounts in first-seen order", () => {
    const summary = summarizeDrift(
      [
        row({ changeKind: "created" }),
        row({ changeKind: "deleted" }),
        row({ accountId: "acc-2", accountName: "do-main", changeKind: "created" }),
        row({ changeKind: "updated", fields: ["size"] }),
      ],
      SINCE,
    );
    expect(summary.total).toBe(4);
    expect(summary.created).toBe(2);
    expect(summary.deleted).toBe(1);
    expect(summary.updated).toBe(1);
    expect(summary.accountIds).toEqual(["acc-1", "acc-2"]);
    expect(summary.soleAccountName).toBeNull();
  });

  it("names the account when the window covers exactly one", () => {
    const summary = summarizeDrift([row({ changeKind: "created" })], SINCE);
    expect(summary.soleAccountName).toBe("prod-aws");
    expect(driftTitle(summary)).toBe("Infrastructure drift: 1 change in prod-aws");
  });

  it("names at most MAX_LISTED_CHANGES changes and counts the rest as omitted", () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      row({ changeKind: "created", displayName: `web-${i}` }),
    );
    const summary = summarizeDrift(rows, SINCE);
    expect(summary.total).toBe(40);
    expect(summary.items).toHaveLength(MAX_LISTED_CHANGES);
    expect(summary.omitted).toBe(40 - MAX_LISTED_CHANGES);
    expect(summary.truncated).toBe(false);
  });

  it("caps the read at MAX_SCANNED_CHANGES and reports the overflow", () => {
    // The caller reads one row past the cap; that extra row is the overflow
    // signal and must not be counted in the total.
    const rows = Array.from({ length: MAX_SCANNED_CHANGES + 1 }, () =>
      row({ changeKind: "created" }),
    );
    const summary = summarizeDrift(rows, SINCE);
    expect(summary.truncated).toBe(true);
    expect(summary.total).toBe(MAX_SCANNED_CHANGES);
    expect(summary.items).toHaveLength(MAX_LISTED_CHANGES);
    expect(driftTitle(summary)).toBe("Infrastructure drift: 500+ changes");
  });

  it("is a no-op on an empty window", () => {
    const summary = summarizeDrift([], SINCE);
    expect(summary.total).toBe(0);
    expect(summary.items).toEqual([]);
    expect(summary.omitted).toBe(0);
    expect(summary.accountIds).toEqual([]);
  });

  it("leads with creations and deletions, not field updates", () => {
    const rows = [
      ...Array.from({ length: MAX_LISTED_CHANGES }, (_, i) =>
        row({ changeKind: "updated", displayName: `noise-${i}`, fields: ["updatedAt"] }),
      ),
      row({ changeKind: "deleted", displayName: "gone" }),
      row({ changeKind: "created", displayName: "fresh" }),
    ];
    const summary = summarizeDrift(rows, SINCE);
    expect(summary.items[0]?.displayName).toBe("fresh");
    expect(summary.items[1]?.displayName).toBe("gone");
    expect(summary.items).toHaveLength(MAX_LISTED_CHANGES);
  });
});

describe("drift rendering", () => {
  const summary = summarizeDrift(
    [
      row({ changeKind: "created", displayName: "web-3" }),
      row({
        accountId: "acc-2",
        accountName: "do-main",
        changeKind: "deleted",
        displayName: "old",
      }),
      row({
        changeKind: "updated",
        displayName: "api-1",
        fields: ["region", "size", "tags", "image", "vpc", "subnet"],
      }),
    ],
    SINCE,
  );

  it("bolds the headline for Slack and leaves Teams plain", () => {
    const slack = formatDriftSlackBody(summary);
    const teams = formatDriftTeamsBody(summary);
    expect(slack).toContain("*3 changes*");
    // The Adaptive Card escaper would render a literal asterisk.
    expect(teams).not.toContain("*");
    expect(teams).toContain("3 changes");
  });

  it("names the account per line only when the window spans several", () => {
    const multi = formatDriftTeamsBody(summary);
    expect(multi).toContain("(prod-aws)");
    expect(multi).toContain("(do-main)");

    const single = formatDriftTeamsBody(
      summarizeDrift([row({ changeKind: "created", displayName: "web-3" })], SINCE),
    );
    expect(single).not.toContain("(prod-aws)");
  });

  it("caps the named fields on an updated line", () => {
    const lines = driftLines(summary, (s) => s);
    const updated = lines.find((l) => l.includes("api-1"));
    expect(updated).toBe(
      `• updated · ec2-instance "api-1" (prod-aws): region, size, tags, image +2 more`,
    );
    expect(MAX_DIFF_FIELDS).toBe(4);
  });

  it("points at the change timeline when it omitted changes", () => {
    const many = summarizeDrift(
      Array.from({ length: 30 }, (_, i) => row({ changeKind: "created", displayName: `r-${i}` })),
      SINCE,
    );
    expect(formatDriftTeamsBody(many)).toContain(
      `…and ${30 - MAX_LISTED_CHANGES} more changes in the change timeline`,
    );
  });

  it("says 'and more' rather than a wrong count once the read overflowed", () => {
    const over = summarizeDrift(
      Array.from({ length: MAX_SCANNED_CHANGES + 1 }, () => row({ changeKind: "created" })),
      SINCE,
    );
    const body = formatDriftTeamsBody(over);
    expect(body).toContain("500+ changes");
    expect(body).toContain("…and more — open the change timeline for the full window");
  });

  it("keeps the push body to the counts, since a banner shows a few lines", () => {
    const body = formatDriftPushBody(summary);
    expect(body).toBe("3 resource changes across 2 accounts: 1 created, 1 updated, 1 deleted");
    expect(body).not.toContain("\n");
  });

  it("puts the window start in the context line", () => {
    expect(driftContext(summary)).toBe("2 accounts · since 2026-07-31T09:00:00.000Z");
  });
});
