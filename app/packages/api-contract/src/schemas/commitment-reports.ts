/**
 * Commitment reports (client-core `commitment-reports.ts`), as Effect schemas:
 * the one validator for a report's config and its create/replace body. The
 * API decodes requests with them (strictly, `STRICT_PARSE_OPTIONS`, so an
 * unknown key is an error rather than a silently different report), and the
 * editors, the CLI and the chat tools validate with the same values.
 *
 * Nothing here rewrites what was sent. A stored config is the request as
 * decoded, and it has to read back byte for byte equal, because the Terraform
 * resource diffs its plan against what the server returns. So input with two
 * spellings of one meaning is refused rather than canonicalised: a name with
 * surrounding whitespace, a filter list that is empty (omit it instead) or
 * repeats a value, a blank filter value. Every key of the config is required
 * except the individual filter lists.
 */
import { Schema } from "effect";
import {
  COMMITMENT_REPORT_GRANULARITIES,
  COMMITMENT_REPORT_GROUP_BYS,
  COMMITMENT_REPORT_KINDS,
  COMMITMENT_REPORT_LIMITS,
  COMMITMENT_REPORT_METRICS,
  commitmentReportRangeProblem,
  type CommitmentReportConfig as CommitmentReportConfigContract,
  type CommitmentReportFilters as CommitmentReportFiltersContract,
  type CommitmentReportInput as CommitmentReportInputContract,
} from "@infrawrench/client-core";
import { maxLength, minLength } from "./checks";
import type { Exact } from "./contract";
import { CostDateRange } from "./cost-enums";
import { NonEmptyString } from "./primitives";

const L = COMMITMENT_REPORT_LIMITS;

export const CommitmentReportMetric = Schema.Literals(COMMITMENT_REPORT_METRICS).annotate({
  identifier: "CommitmentReportMetric",
  description: "The metric the chart draws. A result always carries every metric.",
  message: `metric must be one of ${COMMITMENT_REPORT_METRICS.join(", ")}`,
});

export const CommitmentReportGranularity = Schema.Literals(
  COMMITMENT_REPORT_GRANULARITIES,
).annotate({
  identifier: "CommitmentReportGranularity",
  description:
    "Bucket size. There is no hourly: spend is collected one row per UTC day, so an hourly " +
    "bucket would put each day's spend at midnight. Weeks start on Monday.",
  message:
    "granularity must be daily, weekly, monthly or quarterly. There is no hourly: spend is " +
    "collected one row per day, so an hourly bucket would be invented.",
});

export const CommitmentReportGroupBy = Schema.Literals(COMMITMENT_REPORT_GROUP_BYS).annotate({
  identifier: "CommitmentReportGroupBy",
  description:
    "`commitment_type` and `commitment` split the commitment side by holding and put uncovered " +
    "usage in its own `__on_demand__` group; covered usage the provider did not tie to a " +
    "commitment (all of AWS, whose Cost Explorer cannot group by commitment) is " +
    "`__unattributed__`, and a commitment the inventory no longer holds is `__unknown_kind__` " +
    "under `commitment_type`. Under those two, each group's coverage is its share of the " +
    "bucket's whole usage, so the groups add up. Instance family is not offered: no collector " +
    "stores it on cost rows.",
  message: `groupBy must be one of ${COMMITMENT_REPORT_GROUP_BYS.join(", ")}`,
});

export const CommitmentReportKind = Schema.Literals(COMMITMENT_REPORT_KINDS).annotate({
  identifier: "CommitmentReportKind",
  message: `a commitment type is one of ${COMMITMENT_REPORT_KINDS.join(", ")}`,
});

/** A filter value: an id or a name as the options list it, never padded or blank. */
const FilterValue = Schema.String.check(
  minLength(1),
  maxLength(L.maxFilterValueLength),
  Schema.isTrimmed(),
);

/**
 * One filter list. Absent does not filter; present must say something, once
 * per value, so the stored list is the only way to write that filter.
 */
const filterList = <S extends Schema.Top>(item: S, description: string) =>
  Schema.optionalKey(
    Schema.mutable(Schema.Array(item))
      .annotate({ description })
      .check(
        minLength(1, { message: "omit a filter rather than sending an empty list" }),
        maxLength(L.maxFilterValues),
        Schema.isUnique({ message: "a filter lists each value once" }),
      ),
  );

export const CommitmentReportFilters = Schema.Struct({
  providers: filterList(
    FilterValue,
    "Plugin ids, as `report-options` lists them (`aws`, `azure`).",
  ),
  commitmentTypes: filterList(
    CommitmentReportKind,
    "Narrows the commitment side to holdings of these kinds.",
  ),
  services: filterList(FilterValue, "Provider service names, as `report-options` lists them."),
  accountIds: filterList(FilterValue, "Connected account ids."),
  regions: filterList(FilterValue, "Provider regions, as `report-options` lists them."),
  commitmentIds: filterList(
    FilterValue,
    "Provider-native commitment ids, as `report-options` lists them. Narrows the commitment " +
      "side to those holdings.",
  ),
}).annotate({
  identifier: "CommitmentReportFilters",
  description:
    "Lists AND-compose; values within a list OR. An absent list does not filter. " +
    "`commitmentTypes` and `commitmentIds` narrow the commitment side (covered usage and unused " +
    "fees) only: uncovered usage stays in, because it is the rest of the coverage denominator.",
});

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` that names a real day (`2026-02-30` does not). */
function isCalendarDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.valueOf()) && day.toISOString().slice(0, 10) === value;
}

/**
 * Why an absolute range cannot be saved: a day that is not a real one, or a
 * window past the granularity's limit (`commitmentReportRangeProblem`). A
 * relative preset needs no check: the limits are set so that every preset
 * fits every granularity.
 */
function rangeIssue(
  dateRange: typeof CostDateRange.Type,
  granularity: (typeof COMMITMENT_REPORT_GRANULARITIES)[number],
): Schema.FilterIssue | undefined {
  if (dateRange.kind === "relative") return undefined;
  for (const key of ["from", "to"] as const) {
    if (!isCalendarDay(dateRange[key])) {
      return { path: ["dateRange", key], issue: "expected a calendar day, YYYY-MM-DD" };
    }
  }
  const problem = commitmentReportRangeProblem(dateRange.from, dateRange.to, granularity);
  return problem === null ? undefined : { path: ["dateRange"], issue: problem };
}

export const CommitmentReportConfig = Schema.Struct({
  version: Schema.Literal(1),
  dateRange: CostDateRange,
  granularity: CommitmentReportGranularity,
  groupBy: CommitmentReportGroupBy,
  filters: CommitmentReportFilters,
  metric: CommitmentReportMetric,
})
  // Described before the check: Effect drops a description annotated after one.
  .annotate({
    description:
      `An absolute range covers at most ${L.maxRangeDays} days, and at most ` +
      `${L.maxDailyRangeDays} at daily granularity. Every relative preset fits every ` +
      "granularity.",
  })
  .check(Schema.makeFilter((config) => rangeIssue(config.dateRange, config.granularity)))
  .annotate({ identifier: "CommitmentReportConfig" });

export const CommitmentReportInput = Schema.Struct({
  name: Schema.String.check(
    minLength(1),
    maxLength(L.maxNameLength),
    Schema.isTrimmed({ message: "name must not start or end with whitespace" }),
  ),
  description: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(maxLength(L.maxDescriptionLength))).annotate({
      description: "Stored as sent; absent is null.",
    }),
  ),
  config: CommitmentReportConfig,
  folderId: Schema.optionalKey(
    Schema.NullOr(NonEmptyString).annotate({
      description:
        "A report folder (`/cost-report-folders`, shared with cost reports); absent or null is " +
        "the top level.",
    }),
  ),
}).annotate({ identifier: "CommitmentReportInput" });

export type CommitmentReportSchemasMatchContract = [
  Exact<typeof CommitmentReportFilters.Type, CommitmentReportFiltersContract>,
  Exact<typeof CommitmentReportConfig.Type, CommitmentReportConfigContract>,
  Exact<typeof CommitmentReportInput.Type, CommitmentReportInputContract>,
];
[true, true, true] satisfies CommitmentReportSchemasMatchContract;
