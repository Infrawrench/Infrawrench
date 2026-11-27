/**
 * Who and what may reach a repository (collaborators, protected branches,
 * deploy keys: `/api/repos/:owner/:repo`, all `admin`), and a person's own
 * credentials for Git (SSH keys and access tokens: `/api/user`).
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
import { BadRequest, Conflict, Forbidden, NotFound, UnprocessableEntity } from "../http/errors";
import { Ok, RepoParams } from "../schemas/common";
import { UserRef } from "../schemas/people";
import { CollaboratorRole } from "../schemas/repository";
import {
  AccessToken,
  AccessTokenCreate,
  AccessTokenCreated,
  Collaborator,
  CommitEmail,
  CommitEmailCreate,
  CommitEmailVerify,
  DeployKey,
  DeployKeyCreate,
  OrganizationAccess,
  ProtectedBranch,
  ProtectedBranchCreate,
  ProtectedBranchUpdate,
  UserKey,
  UserKeyCreate,
} from "../schemas/settings";

const CollaboratorParams = {
  ...RepoParams,
  username: Schema.String.annotate({ description: "The collaborator's username." }),
} as const;
const RuleParams = { ...RepoParams, ruleId: Schema.String } as const;
const KeyParams = { ...RepoParams, keyId: Schema.String } as const;

export class CollaboratorsGroup extends HttpApiGroup.make("collaborators")
  .add(
    HttpApiEndpoint.get("list", "/collaborators", {
      params: RepoParams,
      success: Schema.Struct({
        collaborators: Schema.Array(Collaborator),
        organization: Schema.Array(OrganizationAccess).annotate({
          description:
            "For an organisation's repository: its members who reach it through their role. Managed in the Infrawrench app, shown here read-only.",
        }),
      }),
    })
      .annotate(RequiredAccess, "admin")
      .annotate(AllowedWhenArchived, true)
      .annotate(OpenApi.Summary, "Who has access to a repository")
      .annotate(SuccessDescription, "Collaborators and organisation access"),
    HttpApiEndpoint.put("set", "/collaborators/:username", {
      params: CollaboratorParams,
      payload: Schema.Struct({ role: CollaboratorRole }),
      success: Collaborator,
      error: [BadRequest, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "admin")
      .annotate(OpenApi.Summary, "Add a collaborator, or change their role")
      .annotate(SuccessDescription, "The collaborator"),
    HttpApiEndpoint.delete("remove", "/collaborators/:username", {
      params: CollaboratorParams,
      success: Ok,
    })
      .annotate(RequiredAccess, "admin")
      .annotate(OpenApi.Summary, "Remove a collaborator")
      .annotate(SuccessDescription, "Removed"),
    HttpApiEndpoint.get("listAssignable", "/assignees", {
      params: RepoParams,
      query: { q: Schema.optionalKey(Schema.String) },
      success: Schema.Struct({ users: Schema.Array(UserRef) }),
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "People a thread can be assigned to")
      .annotate(
        OpenApi.Description,
        "Everyone with at least `triage` who has a username, at most fifty; narrow with `q`. Empty for a caller below `triage` who is not a member of the owning organisation: it is the organisation's membership.",
      )
      .annotate(SuccessDescription, "People"),
  )
  .prefix("/api/repos/:owner/:repo")
  .middleware(RepositoryAccess)
  .middleware(Authentication)
  .annotate(OpenApi.Title, "Collaborators") {}

export class ProtectedBranchesGroup extends HttpApiGroup.make("protectedBranches")
  .add(
    HttpApiEndpoint.get("list", "/protected-branches", {
      params: RepoParams,
      success: Schema.Struct({ rules: Schema.Array(ProtectedBranch) }),
    })
      .annotate(RequiredAccess, "admin")
      .annotate(AllowedWhenArchived, true)
      .annotate(OpenApi.Summary, "A repository's protected-branch rules")
      .annotate(SuccessDescription, "Rules, by pattern"),
    HttpApiEndpoint.post("create", "/protected-branches", {
      params: RepoParams,
      payload: ProtectedBranchCreate,
      success: ProtectedBranch,
      error: [BadRequest, Conflict],
    })
      .annotate(RequiredAccess, "admin")
      .annotate(OpenApi.Summary, "Protect branches matching a pattern")
      .annotate(SuccessDescription, "The rule"),
    HttpApiEndpoint.patch("update", "/protected-branches/:ruleId", {
      params: RuleParams,
      payload: ProtectedBranchUpdate,
      success: ProtectedBranch,
      error: [BadRequest, Conflict],
    })
      .annotate(RequiredAccess, "admin")
      .annotate(OpenApi.Summary, "Change a protected-branch rule")
      .annotate(SuccessDescription, "The rule"),
    HttpApiEndpoint.delete("delete", "/protected-branches/:ruleId", {
      params: RuleParams,
      success: Ok,
    })
      .annotate(RequiredAccess, "admin")
      .annotate(OpenApi.Summary, "Remove a protected-branch rule")
      .annotate(SuccessDescription, "Removed"),
    HttpApiEndpoint.get("statusContexts", "/protected-branches/status-contexts", {
      params: RepoParams,
      success: Schema.Struct({ contexts: Schema.Array(Schema.String) }),
    })
      .annotate(RequiredAccess, "admin")
      .annotate(AllowedWhenArchived, true)
      .annotate(OpenApi.Summary, "Status contexts seen on recent commits")
      .annotate(OpenApi.Description, "For the required-checks picker.")
      .annotate(SuccessDescription, "Contexts"),
  )
  .prefix("/api/repos/:owner/:repo")
  .middleware(RepositoryAccess)
  .middleware(Authentication)
  .annotate(OpenApi.Title, "Protected branches") {}

export class DeployKeysGroup extends HttpApiGroup.make("deployKeys")
  .add(
    HttpApiEndpoint.get("list", "/deploy-keys", {
      params: RepoParams,
      success: Schema.Struct({ keys: Schema.Array(DeployKey) }),
    })
      .annotate(RequiredAccess, "admin")
      .annotate(AllowedWhenArchived, true)
      .annotate(OpenApi.Summary, "A repository's deploy keys")
      .annotate(SuccessDescription, "Deploy keys"),
    HttpApiEndpoint.post("create", "/deploy-keys", {
      params: RepoParams,
      payload: DeployKeyCreate,
      success: DeployKey,
      error: [BadRequest, Conflict],
    })
      .annotate(RequiredAccess, "admin")
      .annotate(OpenApi.Summary, "Add a deploy key")
      .annotate(
        OpenApi.Description,
        "409 `key_in_use` when the key is already someone's SSH key or another repository's deploy key: a key names exactly one principal.",
      )
      .annotate(SuccessDescription, "The key"),
    HttpApiEndpoint.delete("delete", "/deploy-keys/:keyId", { params: KeyParams, success: Ok })
      .annotate(RequiredAccess, "admin")
      .annotate(OpenApi.Summary, "Remove a deploy key")
      .annotate(SuccessDescription, "Removed"),
  )
  .prefix("/api/repos/:owner/:repo")
  .middleware(RepositoryAccess)
  .middleware(Authentication)
  .annotate(OpenApi.Title, "Deploy keys") {}

/**
 * A person's own SSH keys, access tokens and commit emails. Session only: a
 * token cannot mint or revoke credentials, its own included, nor say which
 * addresses are its person's.
 */
export class AccountGroup extends HttpApiGroup.make("account")
  .add(
    HttpApiEndpoint.get("listKeys", "/keys", {
      success: Schema.Struct({ keys: Schema.Array(UserKey) }),
    })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "The caller's SSH keys")
      .annotate(SuccessDescription, "SSH keys"),
    HttpApiEndpoint.post("createKey", "/keys", {
      payload: UserKeyCreate,
      success: UserKey,
      error: [BadRequest, Conflict],
    })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Add an SSH key")
      .annotate(OpenApi.Description, "400 `key_invalid`; 409 `key_in_use`.")
      .annotate(SuccessDescription, "The key"),
    HttpApiEndpoint.delete("deleteKey", "/keys/:keyId", {
      params: { keyId: Schema.String },
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Remove an SSH key")
      .annotate(SuccessDescription, "Removed"),
    HttpApiEndpoint.get("listTokens", "/tokens", {
      success: Schema.Struct({ tokens: Schema.Array(AccessToken) }),
    })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "The caller's access tokens")
      .annotate(OpenApi.Description, "Never the tokens themselves: only their names and prefixes.")
      .annotate(SuccessDescription, "Access tokens"),
    HttpApiEndpoint.post("createToken", "/tokens", {
      payload: AccessTokenCreate,
      success: AccessTokenCreated,
      error: BadRequest,
    })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Create an access token")
      .annotate(OpenApi.Description, "The answer carries the token itself, this once.")
      .annotate(SuccessDescription, "The token and its secret"),
    HttpApiEndpoint.delete("revokeToken", "/tokens/:tokenId", {
      params: { tokenId: Schema.String },
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Revoke an access token")
      .annotate(SuccessDescription, "Revoked"),
    HttpApiEndpoint.get("listCommitEmails", "/commit-emails", {
      success: Schema.Struct({ emails: Schema.Array(CommitEmail) }),
    })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "The caller's commit emails")
      .annotate(
        OpenApi.Description,
        "The extra addresses the caller's commits carry, in each organisation they are a member of. An address counts only in its organisation's repositories, and only once verified.",
      )
      .annotate(SuccessDescription, "Commit emails, the oldest first"),
    HttpApiEndpoint.post("addCommitEmail", "/commit-emails", {
      payload: CommitEmailCreate,
      success: CommitEmail,
      error: [BadRequest, Forbidden, Conflict],
    })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Add a commit email in an organisation")
      .annotate(
        OpenApi.Description,
        "Mails a code to the address. 400 `email_invalid`; 403 `not_a_member`; 409 `email_taken` when it is another member's account address or one they have verified.",
      )
      .annotate(SuccessDescription, "The address, not yet verified"),
    HttpApiEndpoint.post("sendCommitEmailCode", "/commit-emails/:emailId/send", {
      params: { emailId: Schema.String },
      success: CommitEmail,
      error: [NotFound, Forbidden, Conflict],
    })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Mail another code")
      .annotate(OpenApi.Description, "409 when one was asked for less than a minute ago.")
      .annotate(SuccessDescription, "The address"),
    HttpApiEndpoint.post("verifyCommitEmail", "/commit-emails/:emailId/verify", {
      params: { emailId: Schema.String },
      payload: CommitEmailVerify,
      success: CommitEmail,
      error: [BadRequest, NotFound, Forbidden, Conflict],
    })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Verify a commit email with its code")
      .annotate(
        OpenApi.Description,
        "400 `code_invalid` for a wrong, expired or used code; a code works once, for a day and for five wrong tries.",
      )
      .annotate(SuccessDescription, "The address, verified"),
    HttpApiEndpoint.delete("removeCommitEmail", "/commit-emails/:emailId", {
      params: { emailId: Schema.String },
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Remove a commit email")
      .annotate(SuccessDescription, "Removed"),
  )
  .prefix("/api/user")
  .middleware(Authentication)
  .annotate(OpenApi.Title, "Account") {}
