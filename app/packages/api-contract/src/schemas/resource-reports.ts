/**
 * Resource reports (client-core `resource-reports.ts`), as Effect schemas.
 *
 * The zod twins are `.strict()`: decode these with `STRICT_PARSE_OPTIONS`
 * (`./primitives`), which also makes the nested date range strict.
 */
import { Schema } from "effect";
import {
  RESOURCE_REPORT_LIMITS,
  RESOURCE_REPORT_TAG_OPS,
  resourceReportConfigError,
  type ResourceReportConfig as ResourceReportConfigContract,
  type ResourceReportFilters as ResourceReportFiltersContract,
  type ResourceReportInput as ResourceReportInputContract,
  type ResourceReportQueryRequest as ResourceReportQueryRequestContract,
  type ResourceReportSort as ResourceReportSortContract,
  type ResourceReportTagFilter as ResourceReportTagFilterContract,
} from "@infrawrench/client-core";
import { maxLength, minLength, trimmed } from "./checks";
import type { Exact } from "./contract";
import { CostBasis, CostDateRange } from "./cost-enums";
import { IsoDate, NonEmptyString } from "./primitives";

const RR = RESOURCE_REPORT_LIMITS;
const Key = Schema.String.check(minLength(1), maxLength(RR.maxKeyLength));
const Values = Schema.mutable(
  Schema.Array(Schema.String.check(minLength(1), maxLength(RR.maxValueLength))),
).check(maxLength(RR.maxFilterValues));
const Ids = Schema.mutable(Schema.Array(Schema.String.check(minLength(1), maxLength(128)))).check(
  maxLength(RR.maxFilterValues),
);
const ReportDay = IsoDate.annotate({ examples: ["2026-07-01"] });

const ColumnId = Schema.String.check(minLength(1), maxLength(RR.maxKeyLength + 8)).annotate({
  description:
    "`<kind>:<key>`. `core:name|type|provider|account|region|status|created|external_id`; " +
    "`field:<key>` a key of the resource's synced fields (offered by `GET /resource-reports/" +
    "options`); `tag:<key>` a provider tag; `vtag:<key>` a virtual tag, read from the " +
    "resource's own cost rows over `costRange` (the value holding the most spend); " +
    "`cost:range|mtd|previous_month` spend joined by provider resource id.",
  examples: ["cost:range"],
});

export const ResourceReportTagFilter = Schema.Struct({
  source: Schema.Literals(["tag", "virtual_tag"]).annotate({
    description: "Provider tags (from the resource) or virtual tags (from its cost rows).",
  }),
  key: Key,
  op: Schema.Literals(RESOURCE_REPORT_TAG_OPS).annotate({
    description: "`exists` and `missing` take no values; `in` and `not_in` need at least one.",
  }),
  values: Values,
}).annotate({ identifier: "ResourceReportTagFilter" });

export const ResourceReportFilters = Schema.Struct({
  pluginIds: Ids.annotate({ description: "Providers; empty does not filter." }),
  accountIds: Ids,
  resourceTypes: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        pluginId: Schema.String.check(minLength(1), maxLength(128)),
        resourceTypeId: Schema.String.check(minLength(1), maxLength(256)),
      }),
    ),
  )
    .check(maxLength(RR.maxFilterValues))
    .annotate({
      description: "Resource types, each with its plugin, since type ids repeat across plugins.",
    }),
  regions: Values.annotate({ description: "Matched exactly, as synced." }),
  statuses: Values.annotate({ description: "Matched ignoring case." }),
  tags: Schema.mutable(Schema.Array(ResourceReportTagFilter))
    .check(maxLength(RR.maxTagFilters))
    .annotate({ description: "AND-ed." }),
  nameContains: Schema.NullOr(Schema.String.check(maxLength(RR.maxNameContainsLength))),
  createdFrom: Schema.NullOr(ReportDay).annotate({
    description: "Inclusive UTC day on the created column.",
  }),
  createdTo: Schema.NullOr(ReportDay),
}).annotate({ identifier: "ResourceReportFilters" });

export const ResourceReportSort = Schema.Struct({
  column: ColumnId,
  direction: Schema.Literals(["asc", "desc"]),
}).annotate({ identifier: "ResourceReportSort" });

/**
 * A saved report's config. The rules a person reads (`resourceReportConfigError`)
 * run as a check, so every writer (the routes, the editors, the provider)
 * refuses the same configs with the same words.
 */
export const ResourceReportConfig = Schema.Struct({
  version: Schema.Literal(1),
  filters: ResourceReportFilters,
  columns: Schema.mutable(Schema.Array(ColumnId))
    .check(maxLength(RR.maxColumns))
    .annotate({ description: "Shown columns, in display order." }),
  sort: Schema.NullOr(ResourceReportSort).annotateKey({
    description: "Null sorts by name, ascending.",
  }),
  costRange: CostDateRange,
  costBasis: CostBasis,
  pageSize: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: RR.maxPageSize })),
})
  .check(Schema.makeFilter((config) => resourceReportConfigError(config) ?? undefined))
  .annotate({ identifier: "ResourceReportConfig" });

export const ResourceReportInput = Schema.Struct({
  name: trimmed([minLength(1), maxLength(RR.maxNameLength)]),
  description: Schema.optionalKey(Schema.String.check(maxLength(RR.maxDescriptionLength))),
  config: ResourceReportConfig,
  folderId: Schema.optionalKey(
    Schema.NullOr(NonEmptyString).annotate({
      description: "A report folder (the tree cost reports use); null is the top level.",
    }),
  ),
}).annotate({ identifier: "ResourceReportInput" });

export const ResourceReportQueryRequest = Schema.Struct({
  config: ResourceReportConfig,
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: RR.maxPageSize })),
  ),
}).annotate({ identifier: "ResourceReportQueryRequest" });

export type ResourceReportSchemasMatchContract = [
  Exact<typeof ResourceReportTagFilter.Type, ResourceReportTagFilterContract>,
  Exact<typeof ResourceReportFilters.Type, ResourceReportFiltersContract>,
  Exact<typeof ResourceReportSort.Type, ResourceReportSortContract>,
  Exact<typeof ResourceReportConfig.Type, ResourceReportConfigContract>,
  Exact<typeof ResourceReportInput.Type, ResourceReportInputContract>,
  Exact<typeof ResourceReportQueryRequest.Type, ResourceReportQueryRequestContract>,
];
[true, true, true, true, true, true] satisfies ResourceReportSchemasMatchContract;
