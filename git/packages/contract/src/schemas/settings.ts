/**
 * Repository settings (collaborators, protected branches, deploy keys) and
 * personal settings (SSH keys, access tokens).
 */
import { Schema } from "effect";
import { IsoDateTime } from "./common";
import { UserRef } from "./people";
import { CollaboratorRole } from "./repository";

export const Collaborator = Schema.Struct({
  user: UserRef,
  role: CollaboratorRole,
  addedBy: Schema.NullOr(UserRef),
  createdAt: IsoDateTime,
}).annotate({ identifier: "Collaborator" });
export type Collaborator = typeof Collaborator.Type;

/** Someone who reaches the repository through the organisation that owns it, not as a collaborator. */
export const OrganizationAccess = Schema.Struct({
  user: UserRef,
  access: CollaboratorRole.annotate({
    description: "From their `git:*` permissions: `read`, `write` or `admin`.",
  }),
  roleName: Schema.NullOr(Schema.String).annotate({
    description: "Their Infrawrench role in the organisation.",
  }),
}).annotate({ identifier: "OrganizationAccess" });
export type OrganizationAccess = typeof OrganizationAccess.Type;

export const ProtectedBranch = Schema.Struct({
  id: Schema.String,
  pattern: Schema.String.annotate({
    description:
      "A branch name or glob: `*` matches within a path segment, `**` across them (`main`, `release/*`).",
  }),
  requireBranchPage: Schema.Boolean.annotate({
    description: "Changes arrive through a branch page only: direct pushes are refused.",
  }),
  requiredApprovals: Schema.Int.annotate({
    description: "Approving reviews of the current head a merge needs. 0 for none.",
  }),
  dismissStaleApprovals: Schema.Boolean.annotate({
    description: "A push to the head dismisses the approvals of the older head.",
  }),
  requiredStatusContexts: Schema.Array(Schema.String).annotate({
    description: "Status contexts that must be `success` on the head.",
  }),
  allowForcePush: Schema.Boolean,
  allowDeletion: Schema.Boolean,
  restrictPushers: Schema.Boolean.annotate({
    description: "Only `pushers` (and admins) may push or merge.",
  }),
  pushers: Schema.Array(UserRef),
  enforceAdmins: Schema.Boolean.annotate({
    description: "The rule binds administrators too: nobody bypasses it.",
  }),
  matchingBranches: Schema.Array(Schema.String).annotate({
    description: "Existing branches the pattern matches, up to a handful.",
  }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "ProtectedBranch" });
export type ProtectedBranch = typeof ProtectedBranch.Type;

const protectionFields = {
  requireBranchPage: Schema.Boolean,
  requiredApprovals: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 })),
  dismissStaleApprovals: Schema.Boolean,
  requiredStatusContexts: Schema.Array(Schema.String).check(Schema.isMaxLength(50)),
  allowForcePush: Schema.Boolean,
  allowDeletion: Schema.Boolean,
  restrictPushers: Schema.Boolean,
  pushers: Schema.Array(Schema.String).annotate({ description: "Usernames." }),
  enforceAdmins: Schema.Boolean,
} as const;

export const ProtectedBranchCreate = Schema.Struct({
  pattern: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  requireBranchPage: Schema.optionalKey(protectionFields.requireBranchPage),
  requiredApprovals: Schema.optionalKey(protectionFields.requiredApprovals),
  dismissStaleApprovals: Schema.optionalKey(protectionFields.dismissStaleApprovals),
  requiredStatusContexts: Schema.optionalKey(protectionFields.requiredStatusContexts),
  allowForcePush: Schema.optionalKey(protectionFields.allowForcePush),
  allowDeletion: Schema.optionalKey(protectionFields.allowDeletion),
  restrictPushers: Schema.optionalKey(protectionFields.restrictPushers),
  pushers: Schema.optionalKey(protectionFields.pushers),
  enforceAdmins: Schema.optionalKey(protectionFields.enforceAdmins),
}).annotate({ identifier: "ProtectedBranchCreate" });
export type ProtectedBranchCreate = typeof ProtectedBranchCreate.Type;

export const ProtectedBranchUpdate = Schema.Struct({
  pattern: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255))),
  requireBranchPage: Schema.optionalKey(protectionFields.requireBranchPage),
  requiredApprovals: Schema.optionalKey(protectionFields.requiredApprovals),
  dismissStaleApprovals: Schema.optionalKey(protectionFields.dismissStaleApprovals),
  requiredStatusContexts: Schema.optionalKey(protectionFields.requiredStatusContexts),
  allowForcePush: Schema.optionalKey(protectionFields.allowForcePush),
  allowDeletion: Schema.optionalKey(protectionFields.allowDeletion),
  restrictPushers: Schema.optionalKey(protectionFields.restrictPushers),
  pushers: Schema.optionalKey(protectionFields.pushers),
  enforceAdmins: Schema.optionalKey(protectionFields.enforceAdmins),
}).annotate({ identifier: "ProtectedBranchUpdate" });
export type ProtectedBranchUpdate = typeof ProtectedBranchUpdate.Type;

const sshKeyFields = {
  id: Schema.String,
  title: Schema.String,
  algorithm: Schema.String.annotate({
    description: "`ssh-ed25519`, `ecdsa-sha2-nistp256`, `ssh-rsa`, ...",
  }),
  fingerprint: Schema.String.annotate({
    description: "`SHA256:...`, as `ssh-keygen -lf` prints it.",
  }),
  createdAt: IsoDateTime,
  lastUsedAt: Schema.NullOr(IsoDateTime),
} as const;

/** One of a person's SSH keys for Git. Separate from the organisation's server keys in the app. */
export const UserKey = Schema.Struct(sshKeyFields).annotate({ identifier: "UserKey" });
export type UserKey = typeof UserKey.Type;

const PublicKeyText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(16_384),
).annotate({
  description:
    "The public key as in `~/.ssh/id_ed25519.pub`: `ssh-ed25519 AAAA... comment`. The comment is the default title.",
});

export const UserKeyCreate = Schema.Struct({
  title: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100))),
  key: PublicKeyText,
}).annotate({ identifier: "UserKeyCreate" });
export type UserKeyCreate = typeof UserKeyCreate.Type;

/** An SSH key that reaches one repository, with no person behind it. */
export const DeployKey = Schema.Struct({
  ...sshKeyFields,
  readOnly: Schema.Boolean,
  addedBy: Schema.NullOr(UserRef),
}).annotate({ identifier: "DeployKey" });
export type DeployKey = typeof DeployKey.Type;

export const DeployKeyCreate = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  key: PublicKeyText,
  readOnly: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "Default true: clone and fetch only." }),
  ),
}).annotate({ identifier: "DeployKeyCreate" });
export type DeployKeyCreate = typeof DeployKeyCreate.Type;

export const TOKEN_SCOPES = ["repo:read", "repo:write"] as const;
export const TokenScope = Schema.Literals(TOKEN_SCOPES).annotate({
  identifier: "TokenScope",
  description:
    "`repo:read`: clone and read through the API. `repo:write`: also push and write through the API. Never more than the person may do themselves, and never settings.",
});
export type TokenScope = typeof TokenScope.Type;

export const AccessToken = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  prefix: Schema.String.annotate({
    description: "The start of the token (`iwg_a1b2c3d4`), to tell them apart. Never the whole.",
  }),
  scopes: Schema.Array(TokenScope),
  createdAt: IsoDateTime,
  expiresAt: Schema.NullOr(IsoDateTime),
  lastUsedAt: Schema.NullOr(IsoDateTime),
}).annotate({ identifier: "AccessToken" });
export type AccessToken = typeof AccessToken.Type;

export const AccessTokenCreate = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  scopes: Schema.Array(TokenScope).check(Schema.isMinLength(1)),
  expiresInDays: Schema.optionalKey(
    Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 366 }))).annotate({
      description: "Null or omitted: no expiry.",
    }),
  ),
}).annotate({ identifier: "AccessTokenCreate" });
export type AccessTokenCreate = typeof AccessTokenCreate.Type;

export const AccessTokenCreated = Schema.Struct({
  token: AccessToken,
  secret: Schema.String.annotate({
    description:
      "The token itself (`iwg_...`). Shown this once: only its hash is stored, so it cannot be read again.",
  }),
}).annotate({ identifier: "AccessTokenCreated" });
export type AccessTokenCreated = typeof AccessTokenCreated.Type;

/**
 * An extra address a member's commits carry in one organisation: in that
 * organisation's repositories a commit with it is shown as theirs, once they
 * have proved the address with the code mailed to it.
 */
export const CommitEmail = Schema.Struct({
  id: Schema.String,
  organizationId: Schema.String,
  email: Schema.String.annotate({ description: "Lowercased." }),
  verifiedAt: Schema.NullOr(IsoDateTime).annotate({
    description: "Null until the code is entered: the address counts for nothing before.",
  }),
  codeSentAt: Schema.NullOr(IsoDateTime).annotate({
    description: "When a code was last mailed. Null while the first is on its way.",
  }),
  createdAt: IsoDateTime,
}).annotate({ identifier: "CommitEmail" });
export type CommitEmail = typeof CommitEmail.Type;

export const CommitEmailCreate = Schema.Struct({
  organizationId: Schema.String.annotate({
    description: "An organisation the caller is a member of.",
  }),
  email: Schema.String.check(Schema.isMaxLength(320)),
}).annotate({ identifier: "CommitEmailCreate" });
export type CommitEmailCreate = typeof CommitEmailCreate.Type;

export const CommitEmailVerify = Schema.Struct({
  code: Schema.String.check(Schema.isMaxLength(32)).annotate({
    description: "The code from the message, in any case, with or without its dash.",
  }),
}).annotate({ identifier: "CommitEmailVerify" });
export type CommitEmailVerify = typeof CommitEmailVerify.Type;
