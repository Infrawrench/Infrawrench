/**
 * `CostReportFolder`, as the resource-report spec (still on Hono) embeds it. The
 * folder routes are documented by their HttpApi domain
 * (`http/domains/cost-report-folders/`), whose definition replaces this one in
 * the merged document.
 */
import { z } from "../zod";
import { strict, Uuid, IsoDateTime } from "../common";

const ParentFolderId = z
  .string()
  .nullable()
  .describe(
    "Parent folder for nesting; null is a top-level folder. Nesting is capped at 3 levels, and " +
      "moving a folder inside itself or one of its own subfolders is rejected, both are 400s.",
  );

export const CostReportFolder = strict({
  id: Uuid,
  name: z.string(),
  parentFolderId: ParentFolderId,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("CostReportFolder");
