/**
 * Importing issues from another host (`/api/repos/:owner/:repo/issue-imports`,
 * all `admin`). An administrator's action rather than a client of the public
 * API, because an import writes other people's issues with their original
 * dates, which the API lets no caller do.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { AllowedWhenArchived, RequiredAccess, SuccessDescription } from "../http/annotations";
import { Authentication, RepositoryAccess } from "../http/auth";
import { BadRequest, Conflict, NotFound, UnprocessableEntity } from "../http/errors";
import { RepoParams } from "../schemas/common";
import { IssueImport, IssueImportCreate } from "../schemas/imports";

const ImportParams = { ...RepoParams, importId: Schema.String } as const;

export class IssueImportsGroup extends HttpApiGroup.make("issueImports")
  .add(
    HttpApiEndpoint.get("list", "/issue-imports", {
      params: RepoParams,
      success: Schema.Struct({ imports: Schema.Array(IssueImport) }),
    })
      .annotate(RequiredAccess, "admin")
      .annotate(AllowedWhenArchived, true)
      .annotate(OpenApi.Summary, "A repository's issue imports")
      .annotate(SuccessDescription, "Imports, the newest first"),
    HttpApiEndpoint.post("create", "/issue-imports", {
      params: RepoParams,
      payload: IssueImportCreate,
      success: IssueImport,
      error: [BadRequest, Conflict, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "admin")
      .annotate(OpenApi.Summary, "Import issues from another host")
      .annotate(
        OpenApi.Description,
        "Starts an import of the source repository's issues, with their comments, labels and milestones. Pull requests are not imported. Running it again updates what changed at the source and adds nothing twice. 400 when `repository` is not `owner/name`; 409 while another import of this repository is queued or running; 422 when issues are switched off here.",
      )
      .annotate(SuccessDescription, "The import, queued"),
    HttpApiEndpoint.post("cancel", "/issue-imports/:importId/cancel", {
      params: ImportParams,
      success: IssueImport,
      error: NotFound,
    })
      .annotate(RequiredAccess, "admin")
      .annotate(OpenApi.Summary, "Cancel an issue import")
      .annotate(
        OpenApi.Description,
        "Stops an import that is queued or running and removes its token. What it has already written stays. An import that has ended is answered as it is.",
      )
      .annotate(SuccessDescription, "The import"),
  )
  .prefix("/api/repos/:owner/:repo")
  .middleware(RepositoryAccess)
  .middleware(Authentication)
  .annotate(OpenApi.Title, "Issue imports") {}
