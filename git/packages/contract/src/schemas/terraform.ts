/**
 * Terraform workspaces of a repository: the Infrastructure tab
 * (git/README.md "Terraform"). A workspace is a root directory plus a name;
 * its state lives behind the HTTP backend (`urls.ts` `terraformStatePath`),
 * its plans and applies run on Infrawrench CI, and the resources in its state
 * are matched to the organisation's Infrawrench resources.
 */
import { Schema } from "effect";
import { IsoDateTime, Oid } from "./common";
import { UserRef } from "./people";

/** An amount in a currency. Costs are monthly unless a field says otherwise. */
export const Money = Schema.Struct({
  amount: Schema.Finite,
  currency: Schema.String.annotate({ description: "ISO 4217.", examples: ["USD"] }),
}).annotate({ identifier: "Money" });
export type Money = typeof Money.Type;

export const TERRAFORM_RUN_STATUSES = [
  "queued",
  "planning",
  "planned",
  "no_changes",
  "awaiting_approval",
  "applying",
  "applied",
  "errored",
  "cancelled",
  "discarded",
] as const;
export const TerraformRunStatus = Schema.Literals(TERRAFORM_RUN_STATUSES).annotate({
  identifier: "TerraformRunStatus",
  description:
    "`planned`: a plan with changes, nothing applied (a pull request's plan ends here). `no_changes`: the plan was empty. `awaiting_approval`: an apply waiting for someone to approve it. `discarded`: a plan nobody applied before a newer one replaced it.",
});
export type TerraformRunStatus = typeof TerraformRunStatus.Type;

export const TERRAFORM_RUN_OPERATIONS = ["plan", "apply", "destroy"] as const;
export const TERRAFORM_RUN_TRIGGERS = ["pull_request", "merge", "manual", "drift"] as const;

export const TERRAFORM_ACTIONS = [
  "create",
  "update",
  "delete",
  "replace",
  "read",
  "forget",
  "no-op",
] as const;
export const TerraformAction = Schema.Literals(TERRAFORM_ACTIONS).annotate({
  identifier: "TerraformAction",
});
export type TerraformAction = typeof TerraformAction.Type;

export const TerraformResourceChange = Schema.Struct({
  address: Schema.String.annotate({ examples: ["module.db.aws_db_instance.main"] }),
  type: Schema.String,
  name: Schema.String,
  module: Schema.NullOr(Schema.String),
  provider: Schema.String,
  action: TerraformAction,
  changedAttributes: Schema.Array(Schema.String).annotate({
    description: "Top-level attribute names that change. Values are never sent.",
  }),
}).annotate({ identifier: "TerraformResourceChange" });
export type TerraformResourceChange = typeof TerraformResourceChange.Type;

/** What a plan would do, as `Plan: 2 to add, 1 to change, 0 to destroy.` */
export const TerraformPlanSummary = Schema.Struct({
  add: Schema.Int,
  change: Schema.Int,
  destroy: Schema.Int,
  replace: Schema.Int.annotate({
    description: "Of the above: resources destroyed and created again (counted in both).",
  }),
  import: Schema.Int,
  hasChanges: Schema.Boolean,
  resourceChanges: Schema.Array(TerraformResourceChange),
  resourceChangesTruncated: Schema.Boolean,
  outputChanges: Schema.Int,
}).annotate({ identifier: "TerraformPlanSummary" });
export type TerraformPlanSummary = typeof TerraformPlanSummary.Type;

/** The monthly cost change a plan would cause, from the app's pull request cost analysis. */
export const TerraformCostDelta = Schema.Struct({
  currency: Schema.String,
  monthlyBefore: Schema.NullOr(Schema.Finite).annotate({
    description: "Null when only the change was priced, not the totals.",
  }),
  monthlyAfter: Schema.NullOr(Schema.Finite),
  monthlyDelta: Schema.Finite,
  unpriced: Schema.Int.annotate({
    description: "Changed resources no price was found for; the delta leaves them out.",
  }),
  lines: Schema.Array(
    Schema.Struct({
      address: Schema.String,
      type: Schema.String,
      action: TerraformAction,
      monthlyBefore: Schema.NullOr(Schema.Finite),
      monthlyAfter: Schema.NullOr(Schema.Finite),
      monthlyDelta: Schema.Finite,
    }),
  ),
}).annotate({ identifier: "TerraformCostDelta" });
export type TerraformCostDelta = typeof TerraformCostDelta.Type;

export const TerraformRun = Schema.Struct({
  id: Schema.String,
  workspace: Schema.Struct({ id: Schema.String, name: Schema.String }),
  operation: Schema.Literals(TERRAFORM_RUN_OPERATIONS),
  trigger: Schema.Literals(TERRAFORM_RUN_TRIGGERS),
  status: TerraformRunStatus,
  statusReason: Schema.NullOr(Schema.String),
  commitOid: Oid,
  ref: Schema.String,
  pullNumber: Schema.NullOr(Schema.Int),
  actor: Schema.NullOr(UserRef),
  approvedBy: Schema.NullOr(UserRef),
  createdAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  plan: Schema.NullOr(TerraformPlanSummary).annotate({ description: "Null until planned." }),
  costDelta: Schema.NullOr(TerraformCostDelta).annotate({
    description: "Null until planned, and for a workspace with no connected accounts.",
  }),
  ciRunId: Schema.NullOr(Schema.String).annotate({
    description: "The CI run that executes it; its jobs carry the log.",
  }),
  stateVersionId: Schema.NullOr(Schema.String).annotate({
    description: "The state version an apply wrote.",
  }),
}).annotate({ identifier: "TerraformRun" });
export type TerraformRun = typeof TerraformRun.Type;

export const TerraformStateVersion = Schema.Struct({
  id: Schema.String,
  serial: Schema.Int,
  lineage: Schema.String,
  sha256: Schema.String.annotate({ description: "Lowercase hex, of the state document." }),
  sizeBytes: Schema.Finite,
  resourceCount: Schema.Int,
  terraformVersion: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  createdBy: Schema.NullOr(UserRef).annotate({
    description: "Null when a CI job wrote it; `runId` then names the run.",
  }),
  runId: Schema.NullOr(Schema.String),
  current: Schema.Boolean,
}).annotate({ identifier: "TerraformStateVersion" });
export type TerraformStateVersion = typeof TerraformStateVersion.Type;

export const TerraformLock = Schema.Struct({
  id: Schema.String.annotate({ description: "Terraform's lock id." }),
  operation: Schema.NullOr(Schema.String),
  who: Schema.NullOr(Schema.String).annotate({ description: "As Terraform reported it." }),
  holder: Schema.NullOr(UserRef),
  runId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
}).annotate({ identifier: "TerraformLock" });
export type TerraformLock = typeof TerraformLock.Type;

/** An Infrawrench connected account whose credentials a workspace's runs get. */
export const TerraformAccount = Schema.Struct({
  accountId: Schema.String,
  name: Schema.String,
  pluginId: Schema.String,
  pluginName: Schema.String,
}).annotate({ identifier: "TerraformAccount" });
export type TerraformAccount = typeof TerraformAccount.Type;

export const TerraformWorkspace = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  rootPath: Schema.String.annotate({
    description: "The directory of the root module, from the repository root. Empty for the root.",
  }),
  branch: Schema.String.annotate({
    description: "The branch whose merges apply. The repository's default branch unless set.",
  }),
  terraformVersion: Schema.NullOr(Schema.String).annotate({
    description: "A version or constraint. Null: read from `required_version`, else the latest.",
  }),
  planOnPullRequest: Schema.Boolean,
  applyOnMerge: Schema.Boolean,
  applyRequiresApproval: Schema.Boolean,
  accounts: Schema.Array(TerraformAccount),
  stateAddress: Schema.String.annotate({
    description: 'The `backend "http"` address. `/lock` and `/unlock` beside it.',
  }),
  lock: Schema.NullOr(TerraformLock),
  currentState: Schema.NullOr(TerraformStateVersion),
  resourceCount: Schema.Int,
  monthlyCost: Schema.NullOr(Money).annotate({
    description:
      "What the resources it manages cost a month, from the app. Null when none are matched or the viewer may not see costs.",
  }),
  driftedCount: Schema.NullOr(Schema.Int).annotate({
    description: "Resources the app's IaC reconciliation finds drifted. Null when not reconciled.",
  }),
  lastRun: Schema.NullOr(TerraformRun),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "TerraformWorkspace" });
export type TerraformWorkspace = typeof TerraformWorkspace.Type;

export const TerraformWorkspaceCreate = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,62}$/)),
  rootPath: Schema.String,
  branch: Schema.optionalKey(Schema.String),
  terraformVersion: Schema.optionalKey(Schema.NullOr(Schema.String)),
  planOnPullRequest: Schema.optionalKey(Schema.Boolean),
  applyOnMerge: Schema.optionalKey(Schema.Boolean),
  applyRequiresApproval: Schema.optionalKey(Schema.Boolean),
  accountIds: Schema.optionalKey(Schema.Array(Schema.String)),
}).annotate({ identifier: "TerraformWorkspaceCreate" });
export type TerraformWorkspaceCreate = typeof TerraformWorkspaceCreate.Type;

export const TerraformWorkspaceSettings = Schema.Struct({
  name: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,62}$/))),
  branch: Schema.optionalKey(Schema.String),
  terraformVersion: Schema.optionalKey(Schema.NullOr(Schema.String)),
  planOnPullRequest: Schema.optionalKey(Schema.Boolean),
  applyOnMerge: Schema.optionalKey(Schema.Boolean),
  applyRequiresApproval: Schema.optionalKey(Schema.Boolean),
  accountIds: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description:
        "Replaces the connected accounts. Each must be one the caller could use in the app.",
    }),
  ),
}).annotate({ identifier: "TerraformWorkspaceSettings" });
export type TerraformWorkspaceSettings = typeof TerraformWorkspaceSettings.Type;

/** A directory that looks like a Terraform root, for the "add workspace" picker. */
export const TerraformRoot = Schema.Struct({
  path: Schema.String,
  workspaces: Schema.Array(Schema.String).annotate({
    description: "Names of the workspaces already on it.",
  }),
  backend: Schema.NullOr(Schema.String).annotate({
    description:
      "The backend type its configuration declares (`http`, `s3`), when it declares one.",
  }),
}).annotate({ identifier: "TerraformRoot" });
export type TerraformRoot = typeof TerraformRoot.Type;

/** A resource in a workspace's current state. */
export const TerraformManagedResource = Schema.Struct({
  address: Schema.String,
  mode: Schema.Literals(["managed", "data"]),
  type: Schema.String,
  name: Schema.String,
  module: Schema.NullOr(Schema.String),
  provider: Schema.String,
  providerId: Schema.NullOr(Schema.String).annotate({
    description: "The resource's `id` attribute, when it is not sensitive.",
  }),
  infrawrench: Schema.NullOr(
    Schema.Struct({
      resourceId: Schema.String.annotate({
        description: "The app's composite id, `pluginId:accountId:externalId`.",
      }),
      name: Schema.String,
      pluginId: Schema.String,
      resourceTypeId: Schema.String,
      appUrl: Schema.String,
    }),
  ).annotate({ description: "The Infrawrench resource it was matched to. Null when unmatched." }),
  monthlyCost: Schema.NullOr(Money),
  drift: Schema.NullOr(Schema.Literals(["in_sync", "drifted", "missing"])).annotate({
    description: "From the app's IaC reconciliation. Null when not reconciled.",
  }),
}).annotate({ identifier: "TerraformManagedResource" });
export type TerraformManagedResource = typeof TerraformManagedResource.Type;
