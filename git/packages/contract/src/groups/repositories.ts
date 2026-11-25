/**
 * Repositories: creating, listing and finding them (`RepositoryListsGroup`,
 * no repository in the path), and one repository's own page, settings, forks
 * and stars (`RepositoriesGroup`, under `/api/repos/:owner/:repo`).
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import {
  AllowedWhenArchived,
  RequiredAccess,
  RequiresUser,
  SuccessDescription,
} from "../http/annotations";
import { Authentication, RepositoryAccess } from "../http/auth";
import {
  BadRequest,
  Conflict,
  NotFound,
  PaymentRequired,
  UnprocessableEntity,
} from "../http/errors";
import {
  NamespaceSlug,
  Ok,
  Page,
  PageQuery,
  QueryFlag,
  RepoParams,
  SortDirection,
} from "../schemas/common";
import { UserRef } from "../schemas/people";
import {
  Repository,
  RepositoryCreate,
  RepositoryListType,
  RepositorySort,
  RepositorySummary,
  RepositoryUpdate,
  Visibility,
} from "../schemas/repository";

const listQuery = {
  ...PageQuery,
  q: Schema.optionalKey(
    Schema.String.annotate({ description: "Words to find in the name and description." }),
  ),
  sort: Schema.optionalKey(RepositorySort.annotate({ description: "Default `pushed`." })),
  direction: Schema.optionalKey(SortDirection),
} as const;

export class RepositoryListsGroup extends HttpApiGroup.make("repositoryLists")
  .add(
    HttpApiEndpoint.post("create", "/repos", {
      payload: RepositoryCreate,
      success: Repository,
      error: [BadRequest, NotFound, Conflict, PaymentRequired],
    })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Create a repository")
      .annotate(
        OpenApi.Description,
        "In the caller's own namespace, or an organisation's where they hold `git:write`. 409 `name_taken`; 402 `plan_required` for a private repository the owner's plan does not allow.",
      )
      .annotate(SuccessDescription, "The repository"),
    HttpApiEndpoint.get("listForNamespace", "/namespaces/:namespace/repos", {
      params: { namespace: NamespaceSlug },
      query: {
        ...listQuery,
        type: Schema.optionalKey(RepositoryListType.annotate({ description: "Default `all`." })),
      },
      success: Page(RepositorySummary),
      error: NotFound,
    })
      .annotate(OpenApi.Summary, "A namespace's repositories")
      .annotate(OpenApi.Description, "Only the ones the caller can read.")
      .annotate(SuccessDescription, "Repositories"),
    HttpApiEndpoint.get("listStarredBy", "/namespaces/:namespace/starred", {
      params: { namespace: NamespaceSlug },
      query: PageQuery,
      success: Page(RepositorySummary),
      error: NotFound,
    })
      .annotate(OpenApi.Summary, "Repositories a user has starred")
      .annotate(
        OpenApi.Description,
        "Most recently starred first; only the ones the caller can read.",
      )
      .annotate(SuccessDescription, "Repositories"),
    HttpApiEndpoint.get("listMine", "/user/repos", {
      query: {
        ...listQuery,
        access: Schema.optionalKey(
          Schema.Literals(["read", "write", "admin"]).annotate({
            description:
              "Only repositories the caller has at least this access to (`write` for a pull request's head picker). Default `read`.",
          }),
        ),
      },
      success: Page(RepositorySummary),
    })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Repositories the caller can reach")
      .annotate(
        OpenApi.Description,
        "Their own, their organisations' and the ones they collaborate on. Public repositories of strangers are not listed.",
      )
      .annotate(SuccessDescription, "Repositories"),
    HttpApiEndpoint.get("explore", "/explore/repos", {
      query: {
        ...listQuery,
        language: Schema.optionalKey(Schema.String),
        topic: Schema.optionalKey(Schema.String),
        includeForks: Schema.optionalKey(QueryFlag),
      },
      success: Page(RepositorySummary),
    })
      .annotate(OpenApi.Summary, "Explore and search repositories")
      .annotate(
        OpenApi.Description,
        "Public repositories, plus private ones the caller can read. Without `q`, sorted by `sort` (default `stars`).",
      )
      .annotate(SuccessDescription, "Repositories"),
  )
  .prefix("/api")
  .middleware(Authentication)
  .annotate(OpenApi.Title, "Repositories") {}

export class RepositoriesGroup extends HttpApiGroup.make("repositories")
  .add(
    HttpApiEndpoint.get("get", "/", { params: RepoParams, success: Repository })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "A repository")
      .annotate(SuccessDescription, "The repository"),
    HttpApiEndpoint.patch("update", "/", {
      params: RepoParams,
      payload: RepositoryUpdate,
      success: Repository,
      error: [BadRequest, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "admin")
      .annotate(AllowedWhenArchived, true)
      .annotate(OpenApi.Summary, "Change a repository's settings")
      .annotate(
        OpenApi.Description,
        "Archiving and unarchiving go through here too; an archived repository still answers this to its administrators.",
      )
      .annotate(SuccessDescription, "The repository"),
    HttpApiEndpoint.post("rename", "/rename", {
      params: RepoParams,
      payload: Schema.Struct({ name: Schema.String }),
      success: Repository,
      error: [BadRequest, Conflict],
    })
      .annotate(RequiredAccess, "admin")
      .annotate(OpenApi.Summary, "Rename a repository")
      .annotate(SuccessDescription, "The repository, at its new name"),
    HttpApiEndpoint.post("transfer", "/transfer", {
      params: RepoParams,
      payload: Schema.Struct({
        owner: Schema.String.annotate({
          description:
            "The namespace to move it to: the caller's own, or an organisation's where they hold `git:admin`.",
        }),
      }),
      success: Repository,
      error: [BadRequest, Conflict, PaymentRequired],
    })
      .annotate(RequiredAccess, "admin")
      .annotate(OpenApi.Summary, "Transfer a repository to another namespace")
      .annotate(SuccessDescription, "The repository, under its new owner"),
    HttpApiEndpoint.put("setVisibility", "/visibility", {
      params: RepoParams,
      payload: Schema.Struct({ visibility: Visibility }),
      success: Repository,
      error: [BadRequest, PaymentRequired, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "admin")
      .annotate(OpenApi.Summary, "Make a repository public or private")
      .annotate(OpenApi.Description, "A fork of a private repository cannot be made public (422).")
      .annotate(SuccessDescription, "The repository"),
    HttpApiEndpoint.delete("delete", "/", {
      params: RepoParams,
      query: {
        confirm: Schema.String.annotate({
          description: "`owner/name`, typed by the person to confirm.",
        }),
      },
      success: Ok,
      error: BadRequest,
    })
      .annotate(RequiredAccess, "admin")
      .annotate(AllowedWhenArchived, true)
      .annotate(OpenApi.Summary, "Delete a repository")
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.post("fork", "/forks", {
      params: RepoParams,
      payload: Schema.Struct({
        owner: Schema.String.annotate({ description: "The namespace to fork into." }),
        name: Schema.optionalKey(
          Schema.String.annotate({ description: "The parent's name when omitted." }),
        ),
        defaultBranchOnly: Schema.optionalKey(Schema.Boolean),
      }),
      success: Repository,
      error: [BadRequest, Conflict, PaymentRequired, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Fork a repository")
      .annotate(
        OpenApi.Description,
        "A fork of a private repository is private and stays within the same owner's reach.",
      )
      .annotate(SuccessDescription, "The fork"),
    HttpApiEndpoint.get("listForks", "/forks", {
      params: RepoParams,
      query: PageQuery,
      success: Page(RepositorySummary),
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "A repository's forks")
      .annotate(SuccessDescription, "Forks the caller can read"),
    HttpApiEndpoint.put("star", "/star", { params: RepoParams, success: Ok })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Star a repository")
      .annotate(SuccessDescription, "Starred"),
    HttpApiEndpoint.delete("unstar", "/star", { params: RepoParams, success: Ok })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Unstar a repository")
      .annotate(SuccessDescription, "Unstarred"),
    HttpApiEndpoint.get("listStargazers", "/stargazers", {
      params: RepoParams,
      query: PageQuery,
      success: Page(UserRef),
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "People who starred a repository")
      .annotate(SuccessDescription, "Stargazers, newest first"),
  )
  .prefix("/api/repos/:owner/:repo")
  .middleware(RepositoryAccess)
  .middleware(Authentication)
  .annotate(OpenApi.Title, "Repositories") {}
