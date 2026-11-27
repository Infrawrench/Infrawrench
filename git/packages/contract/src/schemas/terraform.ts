/**
 * Terraform workspaces of a repository: the Infrastructure tab
 * (git/README.md "Terraform"). A workspace is a root directory plus a name;
 * its state lives behind the HTTP backend (`urls.ts` `terraformStatePath`),
 * its plans and applies run on Infrawrench CI, and the resources in its state
 * are matched to the organisation's Infrawrench resources.
 */
import { Schema } from "effect";
import { BranchKey, IsoDateTime, Oid } from "./common";
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
  "skipped",
] as const;
export const TerraformRunStatus = Schema.Literals(TERRAFORM_RUN_STATUSES).annotate({
  identifier: "TerraformRunStatus",
  description:
    "`planned`: a plan with changes, nothing applied (a branch page's plan ends here). `no_changes`: the plan was empty. `awaiting_approval`: an apply waiting for someone to approve it. `discarded`: a plan nobody applied before a newer one replaced it. `skipped`: never run, on purpose (a branch page from a fork is never planned); `statusReason` says why, and it is not a failure.",
});
export type TerraformRunStatus = typeof TerraformRunStatus.Type;

export const TERRAFORM_RUN_OPERATIONS = ["plan", "apply", "destroy"] as const;
export const TERRAFORM_RUN_TRIGGERS = ["branch", "merge", "manual", "drift"] as const;

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

/** The monthly cost change a plan would cause, from the app's branch page cost analysis. */
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
  branchPage: Schema.NullOr(BranchKey).annotate({
    description: "The key of the branch page the run plans, when it is one's.",
  }),
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
  viewerCanApprove: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Whether the caller may approve this run while it is `awaiting_approval`: an admin of the repository, or someone with `ci:approve` in the organisation that owns it.",
    }),
  ),
}).annotate({ identifier: "TerraformRun" });
export type TerraformRun = typeof TerraformRun.Type;

/** A run started by hand. */
export const TerraformRunCreate = Schema.Struct({
  operation: Schema.Literals(["plan", "apply"]),
  ref: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "A branch or a full commit id. Default: the workspace's branch. An apply only runs on the workspace's branch.",
    }),
  ),
}).annotate({ identifier: "TerraformRunCreate" });
export type TerraformRunCreate = typeof TerraformRunCreate.Type;

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
  planOnBranch: Schema.Boolean,
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
      "What the resources it manages cost a month (the app's month to date figure, per matched resource), in the organisation's currency. Null when none are matched, none has a cost yet, or the viewer may not see costs. A viewer whose view of costs is limited to some accounts gets the sum of what they may see.",
  }),
  matchedResourceCount: Schema.optionalKey(
    Schema.Int.annotate({
      description: "Resources of its current state matched to an Infrawrench resource.",
    }),
  ),
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
  planOnBranch: Schema.optionalKey(Schema.Boolean),
  applyOnMerge: Schema.optionalKey(Schema.Boolean),
  applyRequiresApproval: Schema.optionalKey(Schema.Boolean),
  accountIds: Schema.optionalKey(Schema.Array(Schema.String)),
}).annotate({ identifier: "TerraformWorkspaceCreate" });
export type TerraformWorkspaceCreate = typeof TerraformWorkspaceCreate.Type;

export const TerraformWorkspaceSettings = Schema.Struct({
  name: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,62}$/))),
  branch: Schema.optionalKey(Schema.String),
  terraformVersion: Schema.optionalKey(Schema.NullOr(Schema.String)),
  planOnBranch: Schema.optionalKey(Schema.Boolean),
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

/** Why a directory was taken for a root (`@infrawrench/git-terraform` discovery's rules). */
export const TERRAFORM_ROOT_REASONS = ["backend", "provider-block", "unreferenced"] as const;

export const TerraformConfigurationCostLine = Schema.Struct({
  address: Schema.String,
  type: Schema.String,
  count: Schema.Int,
  monthly: Schema.Finite.annotate({ description: "All of its instances, a month." }),
  detail: Schema.String.annotate({
    description: "How it was priced, for a person.",
    examples: ["2 × t3.medium, us-east-1, on demand, $30.37 each"],
  }),
}).annotate({ identifier: "TerraformConfigurationCostLine" });
export type TerraformConfigurationCostLine = typeof TerraformConfigurationCostLine.Type;

export const TerraformConfigurationUnpriced = Schema.Struct({
  address: Schema.String,
  type: Schema.String,
  reason: Schema.String.annotate({
    description: "Why it has no price, as a sentence.",
    examples: ["instance_type is not known from the configuration"],
  }),
}).annotate({ identifier: "TerraformConfigurationUnpriced" });
export type TerraformConfigurationUnpriced = typeof TerraformConfigurationUnpriced.Type;

export const TerraformConfigurationOther = Schema.Struct({
  type: Schema.String,
  count: Schema.Int,
  kind: Schema.Literals(["usage", "free", "unknown"]).annotate({
    description:
      "`usage`: billed by what it does (requests, bytes stored), which a configuration does not say. `free`: no charge of its own. `unknown`: no price data for the type.",
  }),
}).annotate({ identifier: "TerraformConfigurationOther" });
export type TerraformConfigurationOther = typeof TerraformConfigurationOther.Type;

export const TERRAFORM_ESTIMATE_STATUSES = ["pending", "priced", "unavailable"] as const;

/**
 * A root's monthly cost from its configuration alone: no state, no plan.
 * List prices of what the configuration declares, with what could not be
 * priced listed beside the total. An estimate, never a bill.
 */
export const TerraformConfigurationEstimate = Schema.Struct({
  status: Schema.Literals(TERRAFORM_ESTIMATE_STATUSES).annotate({
    description:
      "`pending`: not priced yet (the app prices scans in the background). `priced`: the fields below are the answer. `unavailable`: this deployment has no price data, or pricing failed.",
  }),
  currency: Schema.NullOr(Schema.String),
  monthlyTotal: Schema.NullOr(Schema.Finite).annotate({
    description: "The priced resources' sum. Null when nothing could be priced.",
  }),
  complete: Schema.Boolean.annotate({
    description:
      "Nothing that may cost a fixed amount was left out. False whenever `unpriced` is not empty.",
  }),
  lines: Schema.Array(TerraformConfigurationCostLine).annotate({
    description: "Priced resources, most expensive first.",
  }),
  unpriced: Schema.Array(TerraformConfigurationUnpriced),
  others: Schema.Array(TerraformConfigurationOther).annotate({
    description: "Resources not priced because a configuration cannot price them, by type.",
  }),
  pricedAt: Schema.NullOr(IsoDateTime),
}).annotate({ identifier: "TerraformConfigurationEstimate" });
export type TerraformConfigurationEstimate = typeof TerraformConfigurationEstimate.Type;

/** A directory that is a Terraform root, with what its configuration declares. */
export const TerraformRoot = Schema.Struct({
  path: Schema.String.annotate({ description: "From the repository root. Empty for the root." }),
  reasons: Schema.Array(Schema.Literals(TERRAFORM_ROOT_REASONS)).annotate({
    description:
      "Why it is a root: it declares a backend, it configures a provider, or it declares resources and no other directory calls it as a module.",
  }),
  workspaces: Schema.Array(Schema.String).annotate({
    description: "Names of the workspaces already on it.",
  }),
  suggestedWorkspace: Schema.String.annotate({
    description: "A free workspace name for it, from its path.",
  }),
  backend: Schema.NullOr(
    Schema.Struct({
      type: Schema.String.annotate({ examples: ["s3", "gcs", "http", "remote", "cloud"] }),
      settings: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })).annotate(
        {
          description:
            "Settings written as plain literals (`bucket`, `key`, `region`). Credentials are never read.",
        },
      ),
    }),
  ).annotate({ description: "Null: no backend block, so state is local." }),
  requiredVersion: Schema.NullOr(Schema.String),
  providers: Schema.Array(
    Schema.Struct({
      name: Schema.String.annotate({ description: "The local name.", examples: ["aws"] }),
      source: Schema.NullOr(Schema.String).annotate({ examples: ["hashicorp/aws"] }),
      version: Schema.NullOr(Schema.String).annotate({ examples: ["~> 6.20"] }),
      configured: Schema.Boolean.annotate({ description: "It has a `provider` block here." }),
      resources: Schema.Int,
      dataSources: Schema.Int,
    }),
  ),
  modules: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      source: Schema.NullOr(Schema.String),
      version: Schema.NullOr(Schema.String),
      localPath: Schema.NullOr(Schema.String).annotate({
        description: "The directory, for a module in this repository.",
      }),
    }),
  ).annotate({ description: "Its own `module` blocks." }),
  localModules: Schema.Array(Schema.String).annotate({
    description: "Directories of this repository it calls as modules, however many calls away.",
  }),
  resourceCount: Schema.Int.annotate({
    description: "Resource blocks, its own and its local modules', before `count` and `for_each`.",
  }),
  dataSourceCount: Schema.Int,
  resourceTypes: Schema.Array(Schema.Struct({ type: Schema.String, count: Schema.Int })),
  variableCount: Schema.Int,
  requiredVariables: Schema.Array(Schema.String).annotate({
    description: "Variables with no default and no value in an auto-loaded `.tfvars` file.",
  }),
  outputCount: Schema.Int,
  lockFile: Schema.Boolean.annotate({ description: "`.terraform.lock.hcl` is committed." }),
  tfvarsFiles: Schema.Array(Schema.String),
  usesWorkspace: Schema.Boolean.annotate({
    description: "It reads `terraform.workspace`, so it behaves differently per CLI workspace.",
  }),
  unreadable: Schema.Array(Schema.Struct({ file: Schema.String, reason: Schema.String })),
  estimate: TerraformConfigurationEstimate,
}).annotate({ identifier: "TerraformRoot" });
export type TerraformRoot = typeof TerraformRoot.Type;

/** Every Terraform root of a repository at one commit, read from its files. */
export const TerraformScan = Schema.Struct({
  commitOid: Oid,
  roots: Schema.Array(TerraformRoot),
  moduleCount: Schema.Int.annotate({ description: "Directories that are modules." }),
  truncated: Schema.Boolean.annotate({
    description:
      "A limit (directories, files or bytes read) stopped the scan: there may be roots it does not list.",
  }),
  scannedAt: IsoDateTime,
}).annotate({ identifier: "TerraformScan" });
export type TerraformScan = typeof TerraformScan.Type;

export const TerraformConfigurationChangeLine = Schema.Struct({
  address: Schema.String,
  type: Schema.String,
  monthlyBefore: Schema.NullOr(Schema.Finite),
  monthlyAfter: Schema.NullOr(Schema.Finite),
  monthlyDelta: Schema.Finite,
}).annotate({ identifier: "TerraformConfigurationChangeLine" });
export type TerraformConfigurationChangeLine = typeof TerraformConfigurationChangeLine.Type;

/** What a branch's configuration does to one root's estimate. */
export const TerraformConfigurationRootChange = Schema.Struct({
  path: Schema.String,
  workspace: Schema.NullOr(Schema.String).annotate({
    description: "A workspace on the root, when it has one.",
  }),
  status: Schema.Literals(TERRAFORM_ESTIMATE_STATUSES),
  currency: Schema.NullOr(Schema.String),
  monthlyBefore: Schema.NullOr(Schema.Finite),
  monthlyAfter: Schema.NullOr(Schema.Finite),
  monthlyDelta: Schema.NullOr(Schema.Finite).annotate({
    description: "After less before. Null while pending, or when either side has no price at all.",
  }),
  complete: Schema.Boolean,
  lines: Schema.Array(TerraformConfigurationChangeLine).annotate({
    description: "Resources whose estimate changed, largest change first.",
  }),
  unpriced: Schema.Array(TerraformConfigurationUnpriced).annotate({
    description: "What the head cannot price that the base did not already fail to.",
  }),
}).annotate({ identifier: "TerraformConfigurationRootChange" });
export type TerraformConfigurationRootChange = typeof TerraformConfigurationRootChange.Type;

/**
 * A branch page's monthly cost change from configuration: the roots its
 * changes touch, each priced at the merge base and at the head. A root a
 * Terraform plan has priced for the page's head is left out: the plan's cost
 * card is the answer there, never both.
 */
export const TerraformConfigurationChange = Schema.Struct({
  baseOid: Schema.NullOr(Oid).annotate({
    description: "The merge base. Null with no history in common.",
  }),
  headOid: Oid,
  roots: Schema.Array(TerraformConfigurationRootChange),
}).annotate({ identifier: "TerraformConfigurationChange" });
export type TerraformConfigurationChange = typeof TerraformConfigurationChange.Type;

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
