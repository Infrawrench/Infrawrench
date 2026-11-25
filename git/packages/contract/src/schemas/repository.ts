/**
 * Repositories as the forge shows them: a row in a list, and the page header.
 */
import { Schema } from "effect";
import { REPO_ACCESS_LEVELS } from "../http/annotations";
import { IsoDateTime } from "./common";
import { NamespaceRef } from "./people";

export const VISIBILITIES = ["public", "private"] as const;
export const Visibility = Schema.Literals(VISIBILITIES).annotate({ identifier: "Visibility" });
export type Visibility = typeof Visibility.Type;

export const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
export const MergeMethod = Schema.Literals(MERGE_METHODS).annotate({
  identifier: "MergeMethod",
  description:
    "`merge`: a merge commit. `squash`: one commit on the base. `rebase`: the commits replayed onto the base.",
});
export type MergeMethod = typeof MergeMethod.Type;

export const RepoAccess = Schema.Literals(REPO_ACCESS_LEVELS).annotate({
  identifier: "RepoAccess",
});

/** A repository named beside something else (a fork's parent, a pull request's head). */
export const RepositoryRef = Schema.Struct({
  id: Schema.String,
  owner: Schema.String,
  name: Schema.String,
  visibility: Visibility,
}).annotate({ identifier: "RepositoryRef" });
export type RepositoryRef = typeof RepositoryRef.Type;

/** A repository in a list. */
export const RepositorySummary = Schema.Struct({
  id: Schema.String,
  owner: NamespaceRef,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  visibility: Visibility,
  archived: Schema.Boolean,
  isFork: Schema.Boolean,
  parent: Schema.NullOr(RepositoryRef).annotate({
    description:
      "What it was forked from. Null for a fork whose parent is gone or hidden from the viewer.",
  }),
  defaultBranch: Schema.String,
  primaryLanguage: Schema.NullOr(Schema.String),
  topics: Schema.Array(Schema.String),
  starCount: Schema.Int,
  forkCount: Schema.Int,
  openIssueCount: Schema.Int,
  openPullRequestCount: Schema.Int,
  sizeBytes: Schema.Finite,
  pushedAt: Schema.NullOr(IsoDateTime).annotate({
    description: "The last push. Null for a repository nothing has been pushed to.",
  }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  viewerHasStarred: Schema.Boolean,
}).annotate({ identifier: "RepositorySummary" });
export type RepositorySummary = typeof RepositorySummary.Type;

export const RepositoryFeatures = Schema.Struct({
  issues: Schema.Boolean,
  pullRequests: Schema.Boolean,
}).annotate({ identifier: "RepositoryFeatures" });

export const MergeSettings = Schema.Struct({
  allowMergeCommit: Schema.Boolean,
  allowSquash: Schema.Boolean,
  allowRebase: Schema.Boolean,
  defaultMethod: MergeMethod,
  deleteBranchOnMerge: Schema.Boolean,
}).annotate({ identifier: "MergeSettings" });

/** What the viewer may do, for the buttons the repository's pages show. */
export const RepositoryViewer = Schema.Struct({
  access: RepoAccess.annotate({
    description:
      "The viewer's `repoAccess`. On an archived repository this is at most `read`, whoever they are.",
  }),
  canAdminister: Schema.Boolean.annotate({
    description: "May open settings (and unarchive): `admin` before the archive cap is applied.",
  }),
  canPush: Schema.Boolean,
  canTriage: Schema.Boolean,
  canFork: Schema.Boolean,
  hasStarred: Schema.Boolean,
}).annotate({ identifier: "RepositoryViewer" });

/** The repository page's header and everything its tabs decide from. */
export const Repository = Schema.Struct({
  ...RepositorySummary.fields,
  homepageUrl: Schema.NullOr(Schema.String),
  isEmpty: Schema.Boolean.annotate({
    description: "No branch yet: show the setup instructions instead of a tree.",
  }),
  httpCloneUrl: Schema.String,
  sshCloneUrl: Schema.String,
  features: RepositoryFeatures,
  merge: MergeSettings,
  branchCount: Schema.Int,
  tagCount: Schema.Int,
  hasCi: Schema.Boolean.annotate({
    description: "The default branch has `.infrawrench/ci/*.yml`, or the repository has runs.",
  }),
  hasTerraform: Schema.Boolean.annotate({
    description: "It has Terraform workspaces: show the Infrastructure tab.",
  }),
  viewer: RepositoryViewer,
}).annotate({ identifier: "Repository" });
export type Repository = typeof Repository.Type;

export const RepositoryCreate = Schema.Struct({
  owner: Schema.String.annotate({
    description:
      "The namespace to create it in: the caller's own, or an organisation's they hold `git:write` in.",
  }),
  name: Schema.String,
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(350))),
  visibility: Visibility,
  defaultBranch: Schema.optionalKey(Schema.String.annotate({ description: "Default `main`." })),
  initialize: Schema.optionalKey(
    Schema.Struct({
      readme: Schema.Boolean,
      gitignore: Schema.optionalKey(
        Schema.String.annotate({ description: "A template name (`Terraform`, `Node`)." }),
      ),
      license: Schema.optionalKey(
        Schema.String.annotate({ description: "An SPDX id (`MIT`, `Apache-2.0`)." }),
      ),
    }).annotate({
      description: "Start it with one commit. Omitted: empty, ready for a first push.",
    }),
  ),
}).annotate({ identifier: "RepositoryCreate" });

export const RepositoryUpdate = Schema.Struct({
  description: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(350)))),
  homepageUrl: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(500)))),
  topics: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(20))),
  defaultBranch: Schema.optionalKey(Schema.String.annotate({ description: "An existing branch." })),
  features: Schema.optionalKey(
    Schema.Struct({
      issues: Schema.optionalKey(Schema.Boolean),
      pullRequests: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  merge: Schema.optionalKey(
    Schema.Struct({
      allowMergeCommit: Schema.optionalKey(Schema.Boolean),
      allowSquash: Schema.optionalKey(Schema.Boolean),
      allowRebase: Schema.optionalKey(Schema.Boolean),
      defaultMethod: Schema.optionalKey(MergeMethod),
      deleteBranchOnMerge: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  archived: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Archive (read-only for everyone) or unarchive.",
    }),
  ),
}).annotate({ identifier: "RepositoryUpdate" });

export const REPOSITORY_SORTS = ["pushed", "name", "stars", "created"] as const;
export const RepositorySort = Schema.Literals(REPOSITORY_SORTS);

export const REPOSITORY_LIST_TYPES = ["all", "sources", "forks", "archived", "private"] as const;
export const RepositoryListType = Schema.Literals(REPOSITORY_LIST_TYPES);

export const COLLABORATOR_ROLES = ["read", "triage", "write", "admin"] as const;
export const CollaboratorRole = Schema.Literals(COLLABORATOR_ROLES).annotate({
  identifier: "CollaboratorRole",
  description:
    "`read`: clone and comment. `triage`: also label, assign, close and reopen. `write`: also push and merge. `admin`: also settings.",
});
export type CollaboratorRole = typeof CollaboratorRole.Type;
