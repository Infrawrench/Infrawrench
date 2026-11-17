/**
 * The commitment report request schemas are the one validator for a report:
 * the API decodes with them strictly, and a value they accept is stored as
 * sent. So they refuse every second spelling of a config (what the old
 * hand-written normalizer rewrote) and accept exactly what reads back
 * identically.
 */
import { Exit, Schema, SchemaIssue } from "effect";
import { DEFAULT_COMMITMENT_REPORT_CONFIG } from "@infrawrench/client-core";
import { describe, expect, it } from "vitest";
import { CommitmentReportConfig, CommitmentReportInput, STRICT_PARSE_OPTIONS } from "../schemas";

const format = SchemaIssue.makeFormatterStandardSchemaV1();
const base = DEFAULT_COMMITMENT_REPORT_CONFIG;

function decode(schema: Schema.Top, value: unknown) {
  const exit = Schema.decodeUnknownExit(schema as Schema.Codec<unknown, unknown>)(value, {
    ...STRICT_PARSE_OPTIONS,
    errors: "all",
  });
  if (Exit.isSuccess(exit)) return { ok: true as const, value: exit.value };
  const error = Exit.findErrorOption(exit);
  if (error._tag === "None" || !Schema.isSchemaError(error.value))
    throw new Error("not a schema error");
  return {
    ok: false as const,
    issues: format(error.value.issue).issues.map((i) => ({
      path: (i.path ?? []).map(String).join("."),
      message: i.message,
    })),
  };
}

const config = (value: unknown) => decode(CommitmentReportConfig, value);

describe("CommitmentReportConfig", () => {
  it("accepts the default and decodes it unchanged", () => {
    expect(config(base)).toEqual({ ok: true, value: base });
    const full = {
      ...base,
      dateRange: { kind: "absolute", from: "2025-01-01", to: "2026-06-30" },
      granularity: "monthly",
      groupBy: "commitment",
      filters: {
        providers: ["aws", "azure"],
        commitmentTypes: ["savings_plan"],
        services: ["AmazonEC2"],
        accountIds: ["acc-1"],
        regions: ["us-east-1"],
        commitmentIds: ["arn:aws:savingsplans::1:savingsplan/x"],
      },
      metric: "netSavings",
    };
    expect(config(full)).toEqual({ ok: true, value: full });
  });

  it("refuses hourly with the reason", () => {
    const result = config({ ...base, granularity: "hourly" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues[0]!.message).toMatch(/one row per day/);
  });

  it("refuses unknown keys rather than dropping them", () => {
    expect(config({ ...base, binning: "daily" }).ok).toBe(false);
    expect(config({ ...base, filters: { provider: ["aws"] } }).ok).toBe(false);
    expect(config({ ...base, filters: { commitmentTypes: ["spot"] } }).ok).toBe(false);
  });

  it("requires every key, so nothing is defaulted on the way in", () => {
    const { groupBy: _groupBy, ...withoutGroupBy } = base;
    const { metric: _metric, ...withoutMetric } = base;
    expect(config(withoutGroupBy).ok).toBe(false);
    expect(config(withoutMetric).ok).toBe(false);
  });

  it("refuses a second spelling of a filter instead of rewriting it", () => {
    expect(config({ ...base, filters: { regions: [] } })).toEqual({
      ok: false,
      issues: [
        { path: "filters.regions", message: "omit a filter rather than sending an empty list" },
      ],
    });
    expect(config({ ...base, filters: { providers: ["aws", "aws"] } })).toEqual({
      ok: false,
      issues: [{ path: "filters.providers", message: "a filter lists each value once" }],
    });
    expect(config({ ...base, filters: { services: [" AmazonEC2"] } }).ok).toBe(false);
    expect(config({ ...base, filters: { services: [""] } }).ok).toBe(false);
  });

  it("checks absolute ranges: real days, in order, within the granularity's window", () => {
    const daily = { ...base, granularity: "daily" };
    const range = (from: string, to: string, over: object = daily) =>
      config({ ...over, dateRange: { kind: "absolute", from, to } });
    expect(range("2026-02-30", "2026-03-01")).toEqual({
      ok: false,
      issues: [{ path: "dateRange.from", message: "expected a calendar day, YYYY-MM-DD" }],
    });
    expect(range("2026-07-02", "2026-07-01").ok).toBe(false);
    expect(range("2025-01-01", "2026-06-30")).toEqual({
      ok: false,
      issues: [
        {
          path: "dateRange",
          message:
            "A daily report covers at most 367 days; use weekly or monthly for longer windows.",
        },
      ],
    });
    expect(range("2025-01-01", "2026-06-30", { ...base, granularity: "monthly" }).ok).toBe(true);
    expect(range("2022-01-01", "2026-06-30", { ...base, granularity: "quarterly" }).ok).toBe(false);
    // The longest a relative 12m resolves to.
    expect(range("2027-03-01", "2028-03-01").ok).toBe(true);
  });
});

describe("CommitmentReportInput", () => {
  it("stores what was sent: description and folder as given, absent keys absent", () => {
    const body = { name: "Coverage by account", config: base };
    expect(decode(CommitmentReportInput, body)).toEqual({ ok: true, value: body });
    const full = { ...body, description: " notes\n", folderId: null };
    expect(decode(CommitmentReportInput, full)).toEqual({ ok: true, value: full });
  });

  it("refuses a blank or padded name rather than trimming it", () => {
    expect(decode(CommitmentReportInput, { name: "", config: base }).ok).toBe(false);
    expect(decode(CommitmentReportInput, { name: " Coverage ", config: base })).toEqual({
      ok: false,
      issues: [{ path: "name", message: "name must not start or end with whitespace" }],
    });
    expect(decode(CommitmentReportInput, { name: "x".repeat(121), config: base }).ok).toBe(false);
  });
});
