/**
 * Git: `/api/org/:orgId/git`, the endpoint definitions.
 *
 * What the app shows and sets of git.infrawrench.com, which is its own site:
 * the organisation's namespace there (claimed and renamed with `git:admin`,
 * by the forge's own name rules), what a new repository starts as, the
 * repositories with a link out to each, and what they use against the plan.
 * Everything else about a repository is the forge's own API.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { GIT_FORGE_VISIBILITIES, GIT_NAME_MAX_LENGTH } from "@infrawrench/client-core";
import { maxLength, minLength } from "../schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Conflict, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { OrgParams } from "../http/schemas/common";

export const GitForgeVisibility = Schema.Literals(GIT_FORGE_VISIBILITIES).annotate({
  identifier: "GitForgeVisibility",
});

export const GitForgeNamespace = Schema.Struct({
  slug: Schema.String.annotate({
    description: "The first path segment of every repository URL, as its owner spelled it.",
  }),
  url: Schema.String.annotate({ description: "The namespace's page on the forge." }),
  defaultVisibility: GitForgeVisibility.annotate({
    description: "What a new repository starts as, unless its creator says otherwise.",
  }),
  createdAt: Schema.String,
  renamedAt: Schema.NullOr(Schema.String),
}).annotate({ identifier: "GitForgeNamespace" });

export const GitForgeLimits = Schema.Struct({
  privateRepositories: Schema.NullOr(Schema.Int).annotate({
    description: "How many private repositories the plan allows. Null is no limit.",
  }),
  privateStorageBytes: Schema.Finite.annotate({
    description: "Bytes of private repositories at which pushes to them are refused.",
  }),
  includedStorageBytes: Schema.Finite.annotate({
    description:
      "Bytes of private repositories that cost nothing. Storage between this and " +
      "`privateStorageBytes` is metered; where the two are equal nothing is.",
  }),
}).annotate({ identifier: "GitForgeLimits" });

export const GitForgeUsage = Schema.Struct({
  repositories: Schema.Int,
  publicRepositories: Schema.Int,
  privateRepositories: Schema.Int,
  storageBytes: Schema.Finite.annotate({ description: "Bytes of every repository's packs." }),
  privateStorageBytes: Schema.Finite.annotate({
    description: "The part private repositories hold: what the limits count.",
  }),
}).annotate({ identifier: "GitForgeUsage" });

export const GitForgeOverview = Schema.Struct({
  forgeUrl: Schema.String.annotate({ description: "The forge's origin." }),
  namespace: Schema.NullOr(GitForgeNamespace).annotate({
    description: "Null until someone with `git:admin` claims one.",
  }),
  plan: Schema.Literals(["free", "paid"]),
  limits: GitForgeLimits,
  usage: GitForgeUsage,
  reservedNamesAllowed: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "The caller may claim a name on the reserved list: a platform admin, for Infrawrench's own organisation.",
    }),
  ),
}).annotate({ identifier: "GitForgeOverview" });

export const GitForgeRepository = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  fullName: Schema.String.annotate({ description: "`namespace/name`." }),
  url: Schema.String.annotate({ description: "The repository's page on the forge." }),
  description: Schema.NullOr(Schema.String),
  visibility: GitForgeVisibility,
  archived: Schema.Boolean,
  isFork: Schema.Boolean,
  defaultBranch: Schema.String,
  pushedAt: Schema.NullOr(Schema.String).annotate({
    description: "Null until something is pushed.",
  }),
  openBranches: Schema.Int.annotate({
    description:
      "The repository's open branch pages: its branches under review, and the ones forks propose to it.",
  }),
  openIssues: Schema.Int,
  sizeBytes: Schema.Finite,
  ci: Schema.NullOr(
    Schema.Struct({
      status: Schema.String.annotate({
        description: "A CI run status (`passed`, `failed`, `running`, ...).",
      }),
      runId: Schema.String,
      sha: Schema.String,
    }),
  ).annotate({
    description: "The latest CI run of the default branch. Null when CI has not run there.",
  }),
}).annotate({ identifier: "GitForgeRepository" });

export const GitForgeRepositoryList = Schema.Struct({
  repositories: Schema.Array(GitForgeRepository),
}).annotate({ identifier: "GitForgeRepositoryList" });

export const GitForgeNamespaceInput = Schema.Struct({
  slug: Schema.String.check(minLength(1), maxLength(GIT_NAME_MAX_LENGTH)).annotate({
    description:
      "Letters, digits, dots, dashes and underscores; starts with a letter, digit or " +
      "underscore; does not end in `.git`; not one of the forge's reserved names.",
  }),
}).annotate({ identifier: "GitForgeNamespaceInput" });

export const GitForgeSettingsInput = Schema.Struct({
  defaultVisibility: GitForgeVisibility,
}).annotate({ identifier: "GitForgeSettingsInput" });

export class GitForgeGroup extends HttpApiGroup.make("gitForge")
  .add(
    HttpApiEndpoint.get("overview", "/", {
      params: OrgParams,
      success: GitForgeOverview,
    })
      .annotate(RequiredPermission, "git:read")
      .annotate(
        OpenApi.Summary,
        "The organisation's namespace on git.infrawrench.com and its usage",
      )
      .annotate(
        OpenApi.Description,
        "The namespace (null until claimed), the plan's limits for private repositories and " +
          "their storage, and what the namespace uses. Public repositories are free and count " +
          "toward no limit.",
      )
      .annotate(SuccessDescription, "Namespace, limits and usage"),
    HttpApiEndpoint.put("setNamespace", "/namespace", {
      params: OrgParams,
      payload: GitForgeNamespaceInput,
      success: GitForgeNamespace,
      error: [BadRequest, Conflict],
    })
      .annotate(RequiredPermission, "git:admin")
      .annotate(OpenApi.Summary, "Claim or rename the organisation's namespace")
      .annotate(
        OpenApi.Description,
        "Claims the namespace when the organisation has none, renames it otherwise. A rename " +
          "moves no repository, and URLs under the old name stop resolving. A first claim needs " +
          "a paid plan. 400 when the name breaks the forge's rules or is reserved, or when an " +
          "organisation that is not on a paid plan claims one; 409 when someone has it.",
      )
      .annotate(SuccessDescription, "The namespace")
      .annotate(InvalidRequestMessage, "Invalid namespace"),
    HttpApiEndpoint.put("setSettings", "/settings", {
      params: OrgParams,
      payload: GitForgeSettingsInput,
      success: GitForgeNamespace,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "git:admin")
      .annotate(OpenApi.Summary, "Set what a new repository starts as")
      .annotate(OpenApi.Description, "404 until the organisation has claimed a namespace.")
      .annotate(SuccessDescription, "The namespace")
      .annotate(InvalidRequestMessage, "Invalid Git settings"),
    HttpApiEndpoint.get("repositories", "/repositories", {
      params: OrgParams,
      success: GitForgeRepositoryList,
    })
      .annotate(RequiredPermission, "git:read")
      .annotate(OpenApi.Summary, "The organisation's repositories on git.infrawrench.com")
      .annotate(
        OpenApi.Description,
        "Most recently pushed first, private ones included, each with its open pull requests " +
          "and the latest CI run of its default branch. At most 500; the forge lists the rest.",
      )
      .annotate(SuccessDescription, "Repositories"),
  )
  .prefix("/api/org/:orgId/git")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Git") {}

export class GitForgeApi extends withApiDefaults(HttpApi.make("git").add(GitForgeGroup)) {}
