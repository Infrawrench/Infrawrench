/**
 * Cost-report folders: `/api/org/:orgId/cost-report-folders`, the endpoint
 * definitions.
 *
 * A folder organizes the Reports list and nothing else, so it follows the
 * cost-report permissions exactly: reads are `costs:read`, writes
 * `costs:write`. Filing a *report* into a folder is not here: that is the
 * report's own PUT with a different `folderId`. The body is the shared schema
 * the folder dialog validates with (`@infrawrench/ui/schemas`).
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { CostReportFolderInput } from "@infrawrench/ui/schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, Forbidden, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, Ok, OrgIdParams, OrgParams, Uuid } from "../../schemas/common";

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

export class CostReportFoldersGroup extends HttpApiGroup.make("costReportFolders")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Array(CostReportFolder),
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List cost-report folders")
      .annotate(
        OpenApi.Description,
        "The org's report folders as a flat list; build the tree from `parentFolderId`. Folders " +
          "organize the Reports list and nothing else; a report's id, URL and dashboard cards are " +
          "unchanged by where it is filed.",
      )
      .annotate(SuccessDescription, "Folders"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: CostReportFolderInput,
      success: CostReportFolder,
      error: [BadRequest, Forbidden],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Create a cost-report folder")
      .annotate(SuccessDescription, "Created")
      .annotate(InvalidRequestMessage, "Invalid folder"),
    HttpApiEndpoint.put("update", "/:id", {
      params: OrgIdParams,
      payload: CostReportFolderInput,
      success: CostReportFolder,
      error: [BadRequest, Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Update a cost-report folder")
      .annotate(
        OpenApi.Description,
        "Rename and/or reparent. Filing a *report* is not here; that is `PUT " +
          "/cost-reports/{id}` with a different `folderId`. Reparenting past the 3-level depth " +
          "limit, or under the folder's own subtree, is a 400.",
      )
      .annotate(SuccessDescription, "Updated")
      .annotate(InvalidRequestMessage, "Invalid folder"),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: OrgIdParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Delete a cost-report folder")
      .annotate(
        OpenApi.Description,
        "Never blocked by contents and never destructive to them: the folder's reports and " +
          "immediate subfolders fall back to the top level. Deleting a folder cannot delete a " +
          "report.",
      )
      .annotate(SuccessDescription, "Deleted"),
  )
  .prefix("/api/org/:orgId/cost-report-folders")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Cost reports") {}

export class CostReportFoldersApi extends withApiDefaults(
  HttpApi.make("cost-report-folders").add(CostReportFoldersGroup),
) {}
