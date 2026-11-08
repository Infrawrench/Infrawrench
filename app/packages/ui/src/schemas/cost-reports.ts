/** Cost report, report folder and bulk-move bodies, as Effect schemas. */
import { Schema } from "effect";
import {
  COST_REPORT_BULK_LIMITS,
  COST_REPORT_FOLDER_LIMITS,
  COST_REPORT_LIMITS,
  type CostReportBulkRequest as CostReportBulkRequestContract,
  type CostReportFolderInput as CostReportFolderInputContract,
  type CostReportInput as CostReportInputContract,
} from "@infrawrench/client-core";
import { maxLength, minLength } from "./checks";
import type { Exact } from "./contract";
import { CostGraphConfig } from "./cost-graph";
import { NonEmptyString } from "./primitives";

/**
 * Create/update body for a report (POST/PUT /cost-reports). `folderId` is
 * nullable rather than merely optional because "move this out of its folder"
 * has to be expressible; the server checks the folder is the org's.
 */
export const CostReportInput = Schema.Struct({
  name: Schema.String.check(minLength(1), maxLength(COST_REPORT_LIMITS.maxNameLength)),
  description: Schema.optionalKey(
    Schema.String.check(maxLength(COST_REPORT_LIMITS.maxDescriptionLength)),
  ),
  config: CostGraphConfig,
  folderId: Schema.optionalKey(
    Schema.NullOr(NonEmptyString).annotate({
      description:
        "Folder the report is filed under (see /cost-report-folders); null is the top level of the " +
        "Reports list. Moving a report is this same PUT with a different folderId; an id from " +
        "another org is a 400. Deleting a folder never deletes its reports; they fall back to " +
        "the top level.",
    }),
  ),
}).annotate({ identifier: "CostReportInput" });

/**
 * Create/update body for a report folder (POST/PUT /cost-report-folders).
 * Shape only: whether the parent exists, stays inside the org, respects the
 * depth limit and forms no cycle is `costReportFolderMoveBlocker`'s, on the
 * server, which alone sees the whole tree.
 */
export const CostReportFolderInput = Schema.Struct({
  name: Schema.String.check(minLength(1), maxLength(COST_REPORT_FOLDER_LIMITS.maxNameLength)),
  parentFolderId: Schema.optionalKey(
    Schema.NullOr(NonEmptyString).annotate({
      description:
        "Parent folder for nesting; null is a top-level folder. Nesting is capped at 3 levels, and " +
        "moving a folder inside itself or one of its own subfolders is rejected, both are 400s.",
    }),
  ),
}).annotate({ identifier: "CostReportFolderInput" });

const BulkIds = Schema.mutable(Schema.Array(NonEmptyString)).check(
  maxLength(COST_REPORT_BULK_LIMITS.maxItems),
);

/**
 * Body for POST /cost-reports/bulk. Shape only: whether every id exists, is
 * visible and editable, and whether the moves keep the tree within its depth
 * limit is decided by the service against the whole tree, before anything is
 * written.
 */
export const CostReportBulkRequest = Schema.Union(
  [
    Schema.Struct({
      action: Schema.Literal("move"),
      reportIds: BulkIds,
      folderIds: BulkIds,
      targetFolderId: Schema.NullOr(NonEmptyString).annotate({
        description:
          "Destination folder; null is the top level. Reports are filed into it and folders " +
          "become its direct children. Needs editor on the destination, because a folder's " +
          "sharing extends to what is filed in it.",
      }),
    }),
    Schema.Struct({ action: Schema.Literal("delete"), reportIds: BulkIds, folderIds: BulkIds }),
  ],
  // Documented as `anyOf`, as the Zod spec's `z.union` was; the literal
  // `action` lets exactly one member match either way.
)
  .check(
    Schema.makeFilter((b) =>
      b.reportIds.length + b.folderIds.length > 0
        ? undefined
        : "Select at least one report or folder.",
    ),
    Schema.makeFilter((b) =>
      b.reportIds.length + b.folderIds.length <= COST_REPORT_BULK_LIMITS.maxItems
        ? undefined
        : `At most ${COST_REPORT_BULK_LIMITS.maxItems} items per request.`,
    ),
  )
  .annotate({
    identifier: "CostReportBulkRequest",
    description:
      "At least one id and at most 500 in total. Reports and folders are validated together " +
      "against the tree as it will be after every move, then applied in one transaction.",
  });

export type CostReportSchemasMatchContract = [
  Exact<typeof CostReportInput.Type, CostReportInputContract>,
  Exact<typeof CostReportFolderInput.Type, CostReportFolderInputContract>,
  Exact<typeof CostReportBulkRequest.Type, CostReportBulkRequestContract>,
];
[true, true, true] satisfies CostReportSchemasMatchContract;
