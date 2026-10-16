import { describe, expect, it } from "vitest";
import {
  applySavingsFindingView,
  isEmptySavingsFindingFilter,
  matchesSavingsFindingFilter,
  normalizeSavingsFindingFilter,
  normalizeSavingsFindingStatusInput,
  normalizeSavingsViewInput,
  parseSavingsFindingKey,
  parseSavingsFindingsQuery,
  savingsFindingKey,
  savingsFindingsQuery,
  savingsRate,
  sortSavingsFindings,
  summarizeSavingsFindings,
  type SavingsFinding,
} from "../savings-findings";

function finding(overrides: Partial<SavingsFinding> = {}): SavingsFinding {
  const kind = overrides.kind ?? "orphan";
  const sourceId = overrides.sourceId ?? "r1";
  return {
    key: savingsFindingKey(kind, sourceId),
    kind,
    sourceId,
    title: "Disk looks orphaned",
    detail: null,
    pluginId: "aws",
    pluginName: "AWS",
    accountId: "acc-1",
    accountName: "Prod",
    region: "us-east-1",
    resourceId: sourceId,
    resourceName: "disk-1",
    resourceTypeId: "ebs-volume",
    resourceTypeName: "EBS volume",
    tags: { env: "prod" },
    monthlySavings: { amount: 40, currency: "USD" },
    status: "ready",
    statusChangedAt: null,
    statusChangedBy: null,
    statusNote: null,
    resolution: null,
    detectedAt: "2026-10-01T10:00:00.000Z",
    lastSeenAt: "2026-10-10T10:00:00.000Z",
    present: true,
    realizedSavings: null,
    ...overrides,
  };
}

describe("finding keys", () => {
  it("round-trips, including source ids with colons", () => {
    const key = savingsFindingKey("seat", "inactive:abc:def");
    expect(parseSavingsFindingKey(key)).toEqual({ kind: "seat", sourceId: "inactive:abc:def" });
  });
  it("rejects unknown kinds and empty ids", () => {
    expect(parseSavingsFindingKey("nope:1")).toBeNull();
    expect(parseSavingsFindingKey("orphan:")).toBeNull();
    expect(parseSavingsFindingKey("orphan")).toBeNull();
  });
});

describe("matchesSavingsFindingFilter", () => {
  const f = finding();
  it("matches every dimension", () => {
    expect(
      matchesSavingsFindingFilter(f, {
        kinds: ["orphan"],
        pluginIds: ["aws"],
        accountIds: ["acc-1"],
        regions: ["us-east-1"],
        tags: [{ key: "ENV", values: ["prod"] }],
        minMonthlySavings: 40,
        detectedFrom: "2026-10-01",
        detectedTo: "2026-10-01",
        search: "DISK-1",
      }),
    ).toBe(true);
  });
  it("excludes on each dimension", () => {
    expect(matchesSavingsFindingFilter(f, { kinds: ["seat"] })).toBe(false);
    expect(matchesSavingsFindingFilter(f, { regions: ["eu-west-1"] })).toBe(false);
    expect(matchesSavingsFindingFilter(f, { tags: [{ key: "team" }] })).toBe(false);
    expect(matchesSavingsFindingFilter(f, { tags: [{ key: "env", values: ["dev"] }] })).toBe(false);
    expect(matchesSavingsFindingFilter(f, { minMonthlySavings: 41 })).toBe(false);
    expect(matchesSavingsFindingFilter(f, { detectedFrom: "2026-10-02" })).toBe(false);
    expect(matchesSavingsFindingFilter(f, { detectedTo: "2026-09-30" })).toBe(false);
  });
  it("never lets an unpriced finding through a minimum", () => {
    expect(
      matchesSavingsFindingFilter(finding({ monthlySavings: null }), { minMonthlySavings: 1 }),
    ).toBe(false);
    expect(matchesSavingsFindingFilter(finding({ monthlySavings: null }), {})).toBe(true);
  });
});

describe("sortSavingsFindings", () => {
  const a = finding({
    sourceId: "a",
    resourceName: "a",
    monthlySavings: { amount: 10, currency: "USD" },
  });
  const b = finding({
    sourceId: "b",
    resourceName: "b",
    monthlySavings: { amount: 30, currency: "USD" },
  });
  const c = finding({ sourceId: "c", resourceName: "c", monthlySavings: null });
  it("puts unpriced last in both directions", () => {
    expect(sortSavingsFindings([a, c, b]).map((f) => f.sourceId)).toEqual(["b", "a", "c"]);
    expect(
      sortSavingsFindings([a, c, b], { field: "savings", direction: "asc" }).map((f) => f.sourceId),
    ).toEqual(["a", "b", "c"]);
  });
  it("sorts by detected date", () => {
    const old = finding({ sourceId: "o", detectedAt: "2026-01-01T00:00:00.000Z" });
    const fresh = finding({ sourceId: "n", detectedAt: "2026-09-01T00:00:00.000Z" });
    expect(
      sortSavingsFindings([old, fresh], { field: "detected", direction: "desc" }).map(
        (f) => f.sourceId,
      ),
    ).toEqual(["n", "o"]);
  });
});

describe("applySavingsFindingView", () => {
  it("applies the status tab, filter and sort together", () => {
    const rows = [
      finding({ sourceId: "1", status: "ready" }),
      finding({ sourceId: "2", status: "in_progress" }),
      finding({ sourceId: "3", status: "completed" }),
      finding({ sourceId: "4", status: "archived", kind: "seat" }),
    ];
    const open = applySavingsFindingView(rows, {
      status: "open",
      filter: {},
      sort: { field: "name", direction: "asc" },
    });
    expect(open.map((f) => f.sourceId)).toEqual(["1", "2"]);
    expect(
      applySavingsFindingView(rows, {
        status: "all",
        filter: { kinds: ["seat"] },
        sort: { field: "name", direction: "asc" },
      }).map((f) => f.sourceId),
    ).toEqual(["4"]);
  });
});

describe("summary and savings rate", () => {
  it("sums open findings per currency and counts the unpriced", () => {
    const summary = summarizeSavingsFindings(
      [
        finding({ sourceId: "1", monthlySavings: { amount: 100, currency: "USD" } }),
        finding({
          sourceId: "2",
          status: "in_progress",
          monthlySavings: { amount: 50, currency: "USD" },
        }),
        finding({ sourceId: "3", monthlySavings: { amount: 20, currency: "EUR" } }),
        finding({ sourceId: "4", monthlySavings: null }),
        finding({
          sourceId: "5",
          status: "completed",
          monthlySavings: { amount: 999, currency: "USD" },
        }),
        finding({
          sourceId: "6",
          status: "archived",
          monthlySavings: { amount: 999, currency: "USD" },
        }),
      ],
      [{ amount: 50, currency: "USD" }],
      30,
    );
    expect(summary.counts).toEqual({ ready: 3, in_progress: 1, completed: 1, archived: 1 });
    expect(summary.potentialMonthly).toEqual([
      { currency: "USD", amount: 150 },
      { currency: "EUR", amount: 20 },
    ]);
    expect(summary.unpricedOpenCount).toBe(1);
    expect(summary.savingsRate).toEqual([
      { currency: "USD", rate: 0.25 },
      { currency: "EUR", rate: 0 },
    ]);
  });
  it("omits a currency with nothing on either side and clamps a negative realized", () => {
    expect(
      savingsRate([{ currency: "USD", amount: -10 }], [{ currency: "USD", amount: 10 }]),
    ).toEqual([{ currency: "USD", rate: 0 }]);
    expect(savingsRate([{ currency: "USD", amount: 0 }], [])).toEqual([]);
  });
  it("has no rate without realized access", () => {
    expect(summarizeSavingsFindings([finding()], null, 30).savingsRate).toBeNull();
  });
});

describe("normalizeSavingsFindingStatusInput", () => {
  it("dedupes keys and trims the note", () => {
    expect(
      normalizeSavingsFindingStatusInput({
        keys: ["orphan:a", "orphan:a", "seat:x"],
        status: "archived",
        note: "  keep it  ",
      }),
    ).toEqual({ keys: ["orphan:a", "seat:x"], status: "archived", note: "keep it" });
  });
  it("rejects bad keys and statuses", () => {
    expect(() => normalizeSavingsFindingStatusInput({ keys: ["x"], status: "ready" })).toThrow(
      /finding key/,
    );
    expect(() =>
      normalizeSavingsFindingStatusInput({ keys: ["orphan:a"], status: "done" }),
    ).toThrow(/status/);
    expect(() => normalizeSavingsFindingStatusInput({ keys: [], status: "ready" })).toThrow(/keys/);
  });
});

describe("saved view input", () => {
  it("canonicalizes empty filter fields away", () => {
    const view = normalizeSavingsViewInput({
      name: " Big prod waste ",
      filter: {
        kinds: [],
        regions: ["us-east-1", "us-east-1"],
        minMonthlySavings: 0,
        search: "  ",
      },
    });
    expect(view).toEqual({
      name: "Big prod waste",
      description: null,
      status: "open",
      filter: { regions: ["us-east-1"] },
      sort: { field: "savings", direction: "desc" },
    });
    expect(isEmptySavingsFindingFilter(normalizeSavingsFindingFilter({ kinds: [] }))).toBe(true);
  });
  it("rejects unknown fields, bad dates and inverted ranges", () => {
    expect(() => normalizeSavingsFindingFilter({ colour: "red" })).toThrow(/Unknown filter field/);
    expect(() => normalizeSavingsFindingFilter({ detectedFrom: "01/02/2026" })).toThrow(
      /YYYY-MM-DD/,
    );
    expect(() =>
      normalizeSavingsFindingFilter({ detectedFrom: "2026-02-01", detectedTo: "2026-01-01" }),
    ).toThrow(/after/);
    expect(() => normalizeSavingsFindingFilter({ kinds: ["commitment"] })).toThrow(/kind/);
  });
});

describe("query string round trip", () => {
  it("encodes and decodes a full view", () => {
    const q = savingsFindingsQuery({
      status: "in_progress",
      filter: {
        kinds: ["orphan", "oversized"],
        accountIds: ["a1"],
        tags: [{ key: "env", values: ["prod", "stage"] }, { key: "team" }],
        minMonthlySavings: 25,
        detectedFrom: "2026-01-01",
        search: "web",
      },
      sort: { field: "detected", direction: "asc" },
    });
    const parsed = parseSavingsFindingsQuery(
      (n) => q.get(n) ?? undefined,
      (n) => q.getAll(n),
    );
    expect(parsed).toEqual({
      status: "in_progress",
      filter: {
        kinds: ["orphan", "oversized"],
        accountIds: ["a1"],
        tags: [{ key: "env", values: ["prod", "stage"] }, { key: "team" }],
        minMonthlySavings: 25,
        detectedFrom: "2026-01-01",
        search: "web",
      },
      sort: { field: "detected", direction: "asc" },
    });
  });
});
