/**
 * Terraform on git.infrawrench.com (`git/packages/terraform`): the workspaces
 * a repository's Infrastructure tab shows, their plan and apply runs, the
 * catalogue of state versions, and which Infrawrench resource each address in
 * a state is.
 *
 * Not to be confused with the other "Terraform" things in this repo. IaC
 * reconciliation (`iac-schema.ts`) classifies an organisation's inventory
 * against a state somebody uploaded; these tables are the forge running
 * Terraform itself and being its state backend.
 *
 * **No state is stored here.** A state holds every secret its workspace
 * manages; its bytes live in R2 under `r2Key` and Postgres keeps the
 * catalogue. A run's plan is kept as its summary, which names attributes and
 * never carries a value.
 *
 * `repositoryId` is a `git_repositories.id` without a foreign key for now:
 * that table lands with the forge's own schema, and the constraint is added
 * once both are in.
 *
 * Lives in its own module and is re-exported from `schema.ts`, the
 * satellite-schema convention.
 */
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { accounts, organizations, users } from "./core-schema.js";

/** Terraform's lock info, as the client sent it (`@infrawrench/git-terraform` `LockInfo`). */
export interface TerraformLockInfoRow {
  ID: string;
  Operation: string;
  Info: string;
  Who: string;
  Version: string;
  Created: string;
  Path: string;
}

/**
 * A run's monthly cost change, from the app's pull request cost analysis.
 * **Null is not zero**: a change that could not be priced leaves the total
 * null or `partial`, never smaller.
 */
export interface TerraformRunCostDelta {
  /** Sum of the priced changes, per month, or null when nothing could be priced. */
  monthlyDelta: number | null;
  currency: string | null;
  /** True when at least one change is missing from the total. */
  partial: boolean;
  pricedChanges: number;
  unpricedChanges: number;
}

/**
 * A Terraform root in a repository, run as one unit with one state.
 * `(repository, name)` is the workspace's address:
 * `/<owner>/<repo>/terraform/<name>/state`.
 */
export const gitTerraformWorkspaces = pgTable(
  "git_terraform_workspaces",
  {
    id: text("id").primaryKey(),
    /** `git_repositories.id`. No foreign key yet: see the file comment. */
    repositoryId: text("repository_id").notNull(),
    /**
     * The organisation whose accounts and resources the workspace is tied to.
     * Null for a repository in a personal namespace, which has state and runs
     * but no lent credentials and no resource links.
     */
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    /** Lowercase letters, digits, `-` and `_`; a URL segment. */
    name: text("name").notNull(),
    /** The root directory, relative to the repository; empty for its top. */
    rootPath: text("root_path").notNull().default(""),
    /** Apply on a push to the default branch without waiting for an approval. */
    autoApply: boolean("auto_apply").notNull().default(false),
    /** Which program runs it. */
    product: text("product").$type<"terraform" | "opentofu">().notNull().default("terraform"),
    /** An exact release (`1.9.8`), or null to follow the forge's default. */
    toolVersion: text("tool_version"),
    /** Input variables that are not secret: `TF_VAR_<name>`. */
    variables: jsonb("variables").$type<Record<string, string>>().notNull().default({}),
    /** Input variables read from the repository's CI secrets: variable to secret name. */
    secretVariables: jsonb("secret_variables")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    /**
     * A mirror of the lock the workspace's Durable Object holds, so listings
     * and the app can show it without asking every object. The object is the
     * truth; this is written after it changes and may trail it.
     */
    lockId: text("lock_id"),
    lockInfo: jsonb("lock_info").$type<TerraformLockInfoRow | null>(),
    /** The authenticated principal holding the lock (`user:<id>`, `ci:<run id>`). */
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at"),
    /** The newest state version, mirrored the same way. Null when there is no state. */
    currentStateVersionId: text("current_state_version_id"),
    currentSerial: integer("current_serial"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    repoNameIdx: uniqueIndex("git_terraform_workspaces_repo_name_idx").on(t.repositoryId, t.name),
    orgIdx: index("git_terraform_workspaces_org_idx").on(t.organizationId),
    productValid: check(
      "git_terraform_workspaces_product_valid",
      sql`${t.product} IN ('terraform', 'opentofu')`,
    ),
  }),
);

/**
 * The Infrawrench accounts whose credentials a workspace's runs are lent, as
 * environment variables. A row is the grant: an admin linked the account.
 * Deleting the account takes the grant with it.
 */
export const gitTerraformWorkspaceAccounts = pgTable(
  "git_terraform_workspace_accounts",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => gitTerraformWorkspaces.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    addedByUserId: text("added_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.accountId] }),
    accountIdx: index("git_terraform_workspace_accounts_account_idx").on(t.accountId),
  }),
);

export type GitTerraformRunKind = "plan" | "apply";

export type GitTerraformRunStatus =
  /** Recorded, its CI run not started yet. */
  | "queued"
  | "running"
  /** A plan finished and its summary is stored. */
  | "planned"
  /** An apply that waits for someone to approve it (the workspace does not auto-apply). */
  | "awaiting_approval"
  | "applied"
  | "failed"
  | "cancelled"
  /** A newer commit of the same pull request, or a newer push, replaced it. */
  | "superseded";

/**
 * One plan or apply of a workspace at a commit, run as an Infrawrench CI run
 * (`ciRunId`). The plan document itself is never stored: `planSummary` is
 * `@infrawrench/git-terraform`'s `PlanSummary`, attribute names without values.
 */
export const gitTerraformRuns = pgTable(
  "git_terraform_runs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => gitTerraformWorkspaces.id, { onDelete: "cascade" }),
    /** Denormalised from the workspace, for a repository's or a pull request's runs. */
    repositoryId: text("repository_id").notNull(),
    kind: text("kind").$type<GitTerraformRunKind>().notNull(),
    /** What started it. */
    trigger: text("trigger").$type<"pull-request" | "push" | "manual">().notNull(),
    commitSha: text("commit_sha").notNull(),
    branch: text("branch"),
    /** The pull request a plan is for; null for a run on a branch. */
    pullNumber: integer("pull_number"),
    status: text("status").$type<GitTerraformRunStatus>().notNull().default("queued"),
    planSummary: jsonb("plan_summary").$type<Record<string, unknown> | null>(),
    /** The summary's own totals, as columns so a listing needs no JSON. */
    resourcesToAdd: integer("resources_to_add"),
    resourcesToChange: integer("resources_to_change"),
    resourcesToDestroy: integer("resources_to_destroy"),
    costDelta: jsonb("cost_delta").$type<TerraformRunCostDelta | null>(),
    /** `ci_runs.id`. No foreign key: a CI run is pruned on its own schedule. */
    ciRunId: text("ci_run_id"),
    startedByUserId: text("started_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedByUserId: text("approved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at"),
    /** Why it failed, for people. Never Terraform's output: that is the CI run's log. */
    error: text("error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
  },
  (t) => ({
    workspaceCreatedIdx: index("git_terraform_runs_workspace_created_idx").on(
      t.workspaceId,
      t.createdAt,
    ),
    repoPullIdx: index("git_terraform_runs_repo_pull_idx").on(t.repositoryId, t.pullNumber),
    ciRunIdx: index("git_terraform_runs_ci_run_idx").on(t.ciRunId),
    kindValid: check("git_terraform_runs_kind_valid", sql`${t.kind} IN ('plan', 'apply')`),
    statusValid: check(
      "git_terraform_runs_status_valid",
      sql`${t.status} IN ('queued', 'running', 'planned', 'awaiting_approval', 'applied', 'failed', 'cancelled', 'superseded')`,
    ),
  }),
);

/**
 * One stored version of a workspace's state: where its bytes are and what
 * Terraform says about them. Rows are only ever added; restoring an old
 * version writes a new one.
 *
 * `(workspace, lineage, serial)` is indexed but not unique: a restore can
 * write a serial an abandoned history of the same lineage already used.
 */
export const gitTerraformStateVersions = pgTable(
  "git_terraform_state_versions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => gitTerraformWorkspaces.id, { onDelete: "cascade" }),
    serial: integer("serial").notNull(),
    lineage: text("lineage").notNull(),
    /** `terraform/<workspace id>/states/<version id>.tfstate` in the forge's bucket. */
    r2Key: text("r2_key").notNull(),
    /** Bytes. */
    size: integer("size").notNull(),
    /** Lowercase hex SHA-256 of the bytes. */
    sha256: text("sha256").notNull(),
    terraformVersion: text("terraform_version"),
    resourceCount: integer("resource_count").notNull().default(0),
    /** The authenticated principal that wrote it: `user:<id>`, `token:<id>`, `ci:<run id>`. */
    createdBy: text("created_by").notNull(),
    /** Set when `createdBy` is a person. */
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** The run that wrote it, when a CI job did. */
    runId: text("run_id").references(() => gitTerraformRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    workspaceCreatedIdx: index("git_terraform_state_versions_workspace_created_idx").on(
      t.workspaceId,
      t.createdAt,
    ),
    lineageSerialIdx: index("git_terraform_state_versions_lineage_serial_idx").on(
      t.workspaceId,
      t.lineage,
      t.serial,
    ),
  }),
);

/**
 * What a workspace's current state manages, one row per resource instance,
 * and the Infrawrench resource it is when one matched. Replaced as a set each
 * time a state version is linked.
 *
 * `resourceId` is an Infrawrench resource id (`<accountId>:<typeId>:<externalId>`)
 * with no foreign key, like every other table that names a resource: resources
 * are pruned and re-synced under the same id. Null means the state has the
 * address but no synced resource matched it.
 */
export const gitTerraformManagedResources = pgTable(
  "git_terraform_managed_resources",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => gitTerraformWorkspaces.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The state version the set was read from. */
    stateVersionId: text("state_version_id").references(() => gitTerraformStateVersions.id, {
      onDelete: "set null",
    }),
    /** Full Terraform address, e.g. `module.vpc.aws_subnet.private[0]`. */
    address: text("address").notNull(),
    terraformType: text("terraform_type").notNull(),
    /** `registry.terraform.io/hashicorp/aws` */
    provider: text("provider"),
    /** The instance's `name` or `Name` tag, to show an address nothing matched. */
    label: text("label"),
    resourceId: text("resource_id"),
    /** How the two were tied: `import-id`, `external-id` or `identifier`. */
    matchedBy: text("matched_by").$type<"import-id" | "external-id" | "identifier">(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    workspaceAddressIdx: uniqueIndex("git_terraform_managed_resources_workspace_address_idx").on(
      t.workspaceId,
      t.address,
    ),
    /** "Which repository and path manage this resource?" on a resource page. */
    orgResourceIdx: index("git_terraform_managed_resources_org_resource_idx").on(
      t.organizationId,
      t.resourceId,
    ),
  }),
);
