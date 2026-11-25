/**
 * The contract's shapes that it exports as schemas only, as types: what the
 * API sends for them. Types the contract already exports (`Issue`,
 * `PullRequest`, `CiRun`, ...) are imported from it directly.
 */
import type * as contract from "@infrawrench/git-contract";

type Wire<S extends { readonly Encoded: unknown }> = S["Encoded"];

export type Collaborator = Wire<typeof contract.Collaborator>;
export type OrganizationAccess = Wire<typeof contract.OrganizationAccess>;
export type ProtectedBranch = Wire<typeof contract.ProtectedBranch>;
export type DeployKey = Wire<typeof contract.DeployKey>;
export type UserKey = Wire<typeof contract.UserKey>;
export type AccessToken = Wire<typeof contract.AccessToken>;
export type ReviewDecision = Wire<typeof contract.ReviewDecision>;
export type ReviewEvent = Wire<typeof contract.ReviewEvent>;
export type DiffSide = Wire<typeof contract.DiffSide>;
export type MilestoneRef = Wire<typeof contract.MilestoneRef>;
export type ThreadCounts = Wire<typeof contract.ThreadCounts>;

export type CiJob = Wire<typeof contract.CiJob>;
export type CiJobOutput = Wire<typeof contract.CiJobOutput>;
export type CiRunDetail = Wire<typeof contract.CiRunDetail>;
export type CiRepositoryStatus = Wire<typeof contract.CiRepositoryStatus>;
export type CiEvent = Wire<typeof contract.CiEvent>;

export type Money = Wire<typeof contract.Money>;
export type TerraformWorkspace = Wire<typeof contract.TerraformWorkspace>;
export type TerraformRun = Wire<typeof contract.TerraformRun>;
export type TerraformRunStatus = Wire<typeof contract.TerraformRunStatus>;
export type TerraformAction = Wire<typeof contract.TerraformAction>;
export type TerraformPlanSummary = Wire<typeof contract.TerraformPlanSummary>;
export type TerraformResourceChange = Wire<typeof contract.TerraformResourceChange>;
export type TerraformCostDelta = Wire<typeof contract.TerraformCostDelta>;
export type TerraformStateVersion = Wire<typeof contract.TerraformStateVersion>;
export type TerraformManagedResource = Wire<typeof contract.TerraformManagedResource>;
export type TerraformRoot = Wire<typeof contract.TerraformRoot>;
export type TerraformAccount = Wire<typeof contract.TerraformAccount>;
export type TerraformLock = Wire<typeof contract.TerraformLock>;
