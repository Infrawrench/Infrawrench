/**
 * A report folder. Cost reports and resource reports share one folder tree,
 * so the component is defined once: the cost-report-folders domain manages
 * folders, and `GET /resource-reports/folders` lists the ones a resource
 * report can be filed under.
 */
import { Schema } from "effect";
import { IsoDateTime, Uuid } from "./common";

export const CostReportFolder = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  parentFolderId: Schema.NullOr(Schema.String).annotate({
    description:
      "Parent folder for nesting; null is a top-level folder. Nesting is capped at 3 levels, and " +
      "moving a folder inside itself or one of its own subfolders is rejected, both are 400s.",
  }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "CostReportFolder" });
