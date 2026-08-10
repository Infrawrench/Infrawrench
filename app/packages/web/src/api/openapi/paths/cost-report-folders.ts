import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const ParentFolderId = z
  .string()
  .nullable()
  .describe(
    "Parent folder for nesting; null is a top-level folder. Nesting is capped at 3 levels, and " +
      "moving a folder inside itself or one of its own subfolders is rejected — both are 400s.",
  );

const CostReportFolderInput = strict({
  name: z.string().min(1).max(120),
  parentFolderId: ParentFolderId.optional(),
}).openapi("CostReportFolderInput");

const CostReportFolder = strict({
  id: Uuid,
  name: z.string(),
  parentFolderId: ParentFolderId,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("CostReportFolder");

export function registerCostReportFolderPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const params = (extra: Record<string, z.ZodType>) => OrgIdParam.extend(extra);
  const idParam = () => params({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/cost-report-folders",
    tags: ["Cost reports"],
    summary: "List cost-report folders",
    description:
      "The org's report folders as a flat list — build the tree from `parentFolderId`. Folders " +
      "organize the Reports list and nothing else; a report's id, URL and dashboard cards are " +
      "unchanged by where it is filed.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Folders",
        content: { "application/json": { schema: z.array(CostReportFolder) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/cost-report-folders",
    tags: ["Cost reports"],
    summary: "Create a cost-report folder",
    request: {
      params: OrgIdParam,
      body: {
        content: { "application/json": { schema: CostReportFolderInput } },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Created",
        content: { "application/json": { schema: CostReportFolder } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/cost-report-folders/{id}",
    tags: ["Cost reports"],
    summary: "Update a cost-report folder",
    description:
      "Rename and/or reparent. Filing a *report* is not here — that is `PUT " +
      "/cost-reports/{id}` with a different `folderId`. Reparenting past the 3-level depth " +
      "limit, or under the folder's own subtree, is a 400.",
    request: {
      params: idParam(),
      body: {
        content: { "application/json": { schema: CostReportFolderInput } },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Updated",
        content: { "application/json": { schema: CostReportFolder } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/cost-report-folders/{id}",
    tags: ["Cost reports"],
    summary: "Delete a cost-report folder",
    description:
      "Never blocked by contents and never destructive to them: the folder's reports and " +
      "immediate subfolders fall back to the top level. Deleting a folder cannot delete a " +
      "report.",
    request: { params: idParam() },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });
}
