/**
 * The whole API as one `HttpApi`, and one per group for a server that mounts
 * (or a client that derives) a part of it.
 */
import { HttpApi } from "effect/http-api";
import { withApiDefaults } from "./http/auth";
import { CiGroup, StatusesGroup, TerraformGroup } from "./groups/automation";
import { ContentsGroup } from "./groups/contents";
import { IssuesGroup, LabelsGroup, MilestonesGroup } from "./groups/issues";
import { NamespacesGroup } from "./groups/namespaces";
import { PullsGroup } from "./groups/pulls";
import { RepositoriesGroup, RepositoryListsGroup } from "./groups/repositories";
import {
  AgentsGroup,
  FindingsGroup,
  InstructionsGroup,
  ReviewGroup,
  ReviewSettingsGroup,
  T3Group,
  TracesGroup,
  VersionsGroup,
} from "./groups/review";
import { SessionGroup } from "./groups/session";
import { WorkspaceGroup } from "./groups/workspace";
import {
  AccountGroup,
  CollaboratorsGroup,
  DeployKeysGroup,
  ProtectedBranchesGroup,
} from "./groups/settings";

/** Every group, in the order the documentation lists them. */
export const GIT_API_GROUPS = [
  SessionGroup,
  NamespacesGroup,
  RepositoryListsGroup,
  RepositoriesGroup,
  ContentsGroup,
  IssuesGroup,
  PullsGroup,
  VersionsGroup,
  TracesGroup,
  FindingsGroup,
  InstructionsGroup,
  AgentsGroup,
  ReviewSettingsGroup,
  ReviewGroup,
  WorkspaceGroup,
  T3Group,
  LabelsGroup,
  MilestonesGroup,
  CollaboratorsGroup,
  ProtectedBranchesGroup,
  DeployKeysGroup,
  AccountGroup,
  StatusesGroup,
  CiGroup,
  TerraformGroup,
] as const;

/** `git.infrawrench.com/api`: every group. */
export class GitApi extends withApiDefaults(
  HttpApi.make("git")
    .add(SessionGroup)
    .add(NamespacesGroup)
    .add(RepositoryListsGroup)
    .add(RepositoriesGroup)
    .add(ContentsGroup)
    .add(IssuesGroup)
    .add(PullsGroup)
    .add(VersionsGroup)
    .add(TracesGroup)
    .add(FindingsGroup)
    .add(InstructionsGroup)
    .add(AgentsGroup)
    .add(ReviewSettingsGroup)
    .add(ReviewGroup)
    .add(WorkspaceGroup)
    .add(T3Group)
    .add(LabelsGroup)
    .add(MilestonesGroup)
    .add(CollaboratorsGroup)
    .add(ProtectedBranchesGroup)
    .add(DeployKeysGroup)
    .add(AccountGroup)
    .add(StatusesGroup)
    .add(CiGroup)
    .add(TerraformGroup),
) {}

export class SessionApi extends withApiDefaults(HttpApi.make("git-session").add(SessionGroup)) {}
export class NamespacesApi extends withApiDefaults(
  HttpApi.make("git-namespaces").add(NamespacesGroup),
) {}
export class RepositoriesApi extends withApiDefaults(
  HttpApi.make("git-repositories").add(RepositoryListsGroup).add(RepositoriesGroup),
) {}
export class ContentsApi extends withApiDefaults(HttpApi.make("git-contents").add(ContentsGroup)) {}
export class IssuesApi extends withApiDefaults(
  HttpApi.make("git-issues").add(IssuesGroup).add(LabelsGroup).add(MilestonesGroup),
) {}
export class PullsApi extends withApiDefaults(HttpApi.make("git-pulls").add(PullsGroup)) {}
/** Versions, traces, findings, instructions, agents and what configures them. */
export class ReviewApi extends withApiDefaults(
  HttpApi.make("git-review")
    .add(VersionsGroup)
    .add(TracesGroup)
    .add(FindingsGroup)
    .add(InstructionsGroup)
    .add(AgentsGroup)
    .add(ReviewSettingsGroup)
    .add(ReviewGroup)
    .add(WorkspaceGroup)
    .add(T3Group),
) {}
export class RepositorySettingsApi extends withApiDefaults(
  HttpApi.make("git-repository-settings")
    .add(CollaboratorsGroup)
    .add(ProtectedBranchesGroup)
    .add(DeployKeysGroup),
) {}
export class AccountApi extends withApiDefaults(HttpApi.make("git-account").add(AccountGroup)) {}
export class StatusesApi extends withApiDefaults(HttpApi.make("git-statuses").add(StatusesGroup)) {}
export class CiApi extends withApiDefaults(HttpApi.make("git-ci").add(CiGroup)) {}
export class TerraformApi extends withApiDefaults(
  HttpApi.make("git-terraform").add(TerraformGroup),
) {}
