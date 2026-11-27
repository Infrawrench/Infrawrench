/**
 * Who and what may reach a repository (collaborators, protected branches,
 * deploy keys), and a person's own credentials for Git (SSH keys, access
 * tokens).
 */
import { eq } from "drizzle-orm";
import { HttpApiBuilder } from "effect/http-api";
import {
  type CommitEmail,
  type ProtectedBranch,
  type ProtectedBranchCreate,
  type ProtectedBranchUpdate,
  type UserRef,
  GitApi,
  accessAtLeast,
  badRequest,
  conflict,
  forbidden,
  notFound,
  ok,
  unprocessable,
} from "@infrawrench/git-contract";
import { organizationMembers, roles } from "@infrawrench/server-core/db/schema";
import {
  type GitCommitEmail,
  type GitCommitEmailResult,
  addGitCommitEmail,
  listGitCommitEmails,
  removeGitCommitEmail,
  resendGitCommitEmail,
  verifyGitCommitEmail,
} from "@infrawrench/server-core/git/commit-emails";
import { accessFromPermissions } from "../../auth/access";
import { parsePublicKey, publicKeyProblemMessage } from "../../auth/ssh-keys";
import { mintAccessToken, normalizeScopes } from "../../auth/tokens";
import { grantLapsesAt } from "../../mcp/oauth/protocol";
import { db } from "../../db/client";
import {
  type CollaboratorRow,
  listCollaborators,
  removeCollaborator,
  setCollaborator,
} from "../../db/collaborators";
import {
  type DeployKeyRow,
  type UserKeyRow,
  addDeployKey,
  addUserKey,
  deleteDeployKey,
  deleteUserKey,
  listDeployKeys,
  listUserKeys,
} from "../../db/keys";
import { effectivePermissions } from "../../db/org-permissions";
import {
  type ProtectedBranchRow,
  type ProtectedBranchSettings,
  createProtectedBranch,
  deleteProtectedBranch,
  listProtectedBranches,
  matchesBranchPattern,
  recentStatusContexts,
  updateProtectedBranch,
} from "../../db/policy";
import {
  type AccessTokenRow,
  insertAccessToken,
  isOAuthGrantId,
  listAccessTokens,
  revokeAccessToken,
} from "../../db/tokens";
import { userByUsername } from "../../db/users";
import { RepoReaderError } from "../../repo/reader";
import { type RepoCx, op, repoOp } from "../context";
import { userIdsFor } from "../thread-edits";
import { iso, isoOrNull, peopleById } from "../views/repositories";

const collaboratorViews = async (rows: readonly CollaboratorRow[]) => {
  const person = await peopleById(rows.flatMap((row) => [row.userId, row.addedByUserId]));
  return rows.flatMap((row) => {
    const user = person(row.userId);
    return user
      ? [
          {
            user,
            role: row.role,
            addedBy: person(row.addedByUserId),
            createdAt: iso(row.createdAt),
          },
        ]
      : [];
  });
};

/** An organisation's members who reach its repositories through their role. */
const organizationAccess = async (organizationId: string | null) => {
  if (organizationId === null) return [];
  const members = await db
    .select({
      userId: organizationMembers.userId,
      roleId: organizationMembers.roleId,
      legacyRole: organizationMembers.role,
      roleName: roles.name,
      isSystem: roles.isSystem,
      systemKey: roles.systemKey,
      permissions: roles.permissions,
    })
    .from(organizationMembers)
    .leftJoin(roles, eq(roles.id, organizationMembers.roleId))
    .where(eq(organizationMembers.organizationId, organizationId))
    .limit(500);
  const person = await peopleById(members.map((member) => member.userId));
  return members.flatMap((member) => {
    const access = accessFromPermissions(
      effectivePermissions(
        member,
        member.isSystem === null
          ? null
          : {
              isSystem: member.isSystem,
              systemKey: member.systemKey,
              permissions: member.permissions,
            },
        [],
      ),
    );
    const user = person(member.userId);
    return user && access !== "none"
      ? [{ user, access, roleName: member.roleName ?? member.legacyRole }]
      : [];
  });
};

/** Everyone who could be assigned: the owner, collaborators and members with at least triage. */
const assignable = async (cx: RepoCx): Promise<UserRef[]> => {
  const { repository, owner } = cx.repo;
  const [collaborators, members] = await Promise.all([
    listCollaborators(repository.id),
    organizationAccess(owner.organizationId),
  ]);
  const person = await peopleById([
    owner.userId,
    ...collaborators.filter((row) => accessAtLeast(row.role, "triage")).map((row) => row.userId),
  ]);
  const found = new Map<string, UserRef>();
  const add = (user: UserRef | null) => {
    if (user && user.username !== null) found.set(user.id, user);
  };
  add(person(owner.userId));
  for (const row of collaborators) {
    if (accessAtLeast(row.role, "triage")) add(person(row.userId));
  }
  for (const member of members) {
    if (accessAtLeast(member.access, "triage")) add(member.user);
  }
  return [...found.values()];
};

/** Whether the caller may list who can be assigned: `triage` here, or a member of the owning organisation. */
export const maySeeAssignable = async (
  cx: Pick<RepoCx, "userId" | "access" | "repo" | "viewer">,
): Promise<boolean> => {
  if (cx.userId === null) return false;
  if (accessAtLeast(cx.access, "triage")) return true;
  const organizationId = cx.repo.owner.organizationId;
  if (organizationId === null) return false;
  return (await cx.viewer()).organizations.some(
    (organization) => organization.id === organizationId,
  );
};

export const CollaboratorsHandlers = HttpApiBuilder.group(GitApi, "collaborators", (handlers) =>
  handlers
    .handle(
      "list",
      repoOp(async (cx) => {
        const [collaborators, organization] = await Promise.all([
          listCollaborators(cx.repo.repository.id).then(collaboratorViews),
          organizationAccess(cx.repo.owner.organizationId),
        ]);
        return { collaborators, organization };
      }),
    )
    .handle(
      "set",
      repoOp(async (cx, { params, payload }) => {
        const person = await userByUsername(params.username);
        if (!person) throw unprocessable(`There is nobody named ${params.username}`);
        if (person.id === cx.repo.owner.userId) {
          throw unprocessable("The owner already has every access to this repository");
        }
        const row = await setCollaborator(
          cx.repo.repository.id,
          person.id,
          payload.role,
          cx.userId,
        );
        const [view] = await collaboratorViews([row]);
        return view!;
      }),
    )
    .handle(
      "remove",
      repoOp(async (cx, { params }) => {
        const person = await userByUsername(params.username);
        if (!person || !(await removeCollaborator(cx.repo.repository.id, person.id))) {
          throw notFound("No such collaborator");
        }
        return ok;
      }),
    )
    .handle(
      "listAssignable",
      repoOp(async (cx, { query }) => {
        // Who works on a repository is a list for the people who assign work there and the
        // organisation's own members, never for a reader of a public repository: it is the
        // organisation's membership.
        if (!(await maySeeAssignable(cx))) return { users: [] };
        const q = (query.q ?? "").trim().toLowerCase();
        const users = (await assignable(cx))
          .filter(
            (user) =>
              q === "" ||
              (user.username ?? "").toLowerCase().includes(q) ||
              (user.displayName ?? "").toLowerCase().includes(q),
          )
          .sort((a, b) => (a.username ?? "").localeCompare(b.username ?? ""))
          .slice(0, 50);
        return { users };
      }),
    ),
);

// ---------------------------------------------------------------------------
// Protected branches
// ---------------------------------------------------------------------------

/** A pattern is a branch name or a glob over one: nothing a ref name could not contain. */
const checkPattern = (pattern: string): void => {
  if (/[\s~^:?[\\]/.test(pattern) || pattern.startsWith("/") || pattern.endsWith("/")) {
    throw badRequest("A pattern is a branch name, with * and ** as wildcards");
  }
};

const settingsOf = async (
  payload: ProtectedBranchCreate | ProtectedBranchUpdate,
): Promise<ProtectedBranchSettings> => {
  const settings: ProtectedBranchSettings = {};
  if (payload.pattern !== undefined) {
    checkPattern(payload.pattern);
    settings.pattern = payload.pattern;
  }
  if (payload.requireBranchPage !== undefined) {
    settings.requirePullRequest = payload.requireBranchPage;
  }
  if (payload.requiredApprovals !== undefined)
    settings.requiredApprovals = payload.requiredApprovals;
  if (payload.dismissStaleApprovals !== undefined) {
    settings.dismissStaleApprovals = payload.dismissStaleApprovals;
  }
  if (payload.requiredStatusContexts !== undefined) {
    settings.requiredStatusContexts = [...new Set(payload.requiredStatusContexts)];
  }
  if (payload.allowForcePush !== undefined) settings.allowForcePush = payload.allowForcePush;
  if (payload.allowDeletion !== undefined) settings.allowDeletion = payload.allowDeletion;
  if (payload.restrictPushers !== undefined) settings.restrictPushers = payload.restrictPushers;
  if (payload.pushers !== undefined) settings.pusherUserIds = await userIdsFor(payload.pushers);
  if (payload.enforceAdmins !== undefined) settings.enforceAdmins = payload.enforceAdmins;
  return settings;
};

const ruleViews = async (
  cx: RepoCx,
  rows: readonly ProtectedBranchRow[],
): Promise<ProtectedBranch[]> => {
  const person = await peopleById(rows.flatMap((row) => row.pusherUserIds));
  let branches: readonly string[] = [];
  if (rows.length > 0) {
    try {
      branches = (await cx.git.listRefs({ limit: 100 })).branches.map((branch) => branch.name);
    } catch (error) {
      // The rules are Postgres's; without the storage they simply list no matches.
      if (!(error instanceof RepoReaderError)) throw error;
    }
  }
  return rows.map((row) => ({
    id: row.id,
    pattern: row.pattern,
    requireBranchPage: row.requirePullRequest,
    requiredApprovals: row.requiredApprovals,
    dismissStaleApprovals: row.dismissStaleApprovals,
    requiredStatusContexts: row.requiredStatusContexts,
    allowForcePush: row.allowForcePush,
    allowDeletion: row.allowDeletion,
    restrictPushers: row.restrictPushers,
    pushers: row.pusherUserIds.flatMap((id) => person(id) ?? []),
    enforceAdmins: row.enforceAdmins,
    matchingBranches: branches
      .filter((branch) => matchesBranchPattern(row.pattern, branch))
      .slice(0, 5),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  }));
};

export const ProtectedBranchesHandlers = HttpApiBuilder.group(
  GitApi,
  "protectedBranches",
  (handlers) =>
    handlers
      .handle(
        "list",
        repoOp(async (cx) => ({
          rules: await ruleViews(cx, await listProtectedBranches(cx.repo.repository.id)),
        })),
      )
      .handle(
        "create",
        repoOp(async (cx, { payload }) => {
          const settings = await settingsOf(payload);
          const rule = await createProtectedBranch(
            cx.repo.repository.id,
            { ...settings, pattern: payload.pattern },
            cx.userId,
          );
          if (!rule) throw conflict("There is already a rule for that pattern", "name_taken");
          const [view] = await ruleViews(cx, [rule]);
          return view!;
        }),
      )
      .handle(
        "update",
        repoOp(async (cx, { params, payload }) => {
          const rule = await updateProtectedBranch(
            cx.repo.repository.id,
            params.ruleId,
            await settingsOf(payload),
          );
          if (rule === null) throw notFound("No such rule");
          if (rule === "conflict") {
            throw conflict("There is already a rule for that pattern", "name_taken");
          }
          const [view] = await ruleViews(cx, [rule]);
          return view!;
        }),
      )
      .handle(
        "delete",
        repoOp(async (cx, { params }) => {
          if (!(await deleteProtectedBranch(cx.repo.repository.id, params.ruleId))) {
            throw notFound("No such rule");
          }
          return ok;
        }),
      )
      .handle(
        "statusContexts",
        repoOp(async (cx) => ({ contexts: await recentStatusContexts(cx.repo.repository.id) })),
      ),
);

// ---------------------------------------------------------------------------
// Keys and tokens
// ---------------------------------------------------------------------------

/** A pasted `.pub` line as what is stored, or the 400 that says what is wrong with it. */
const parseKey = async (line: string, title: string | undefined) => {
  const parsed = await parsePublicKey(line);
  if (!parsed.ok) throw badRequest(publicKeyProblemMessage(parsed.problem), "key_invalid");
  const { algorithm, publicKey, fingerprint, comment } = parsed.key;
  return {
    title: (title?.trim() || comment || algorithm).slice(0, 100),
    algorithm,
    publicKey,
    fingerprint,
  };
};

const keyFields = (row: UserKeyRow | DeployKeyRow) => ({
  id: row.id,
  title: row.title,
  algorithm: row.algorithm,
  fingerprint: row.fingerprint,
  createdAt: iso(row.createdAt),
  lastUsedAt: isoOrNull(row.lastUsedAt),
});

const KEY_IN_USE = "That key is already in use: a key names one person or one repository";

const deployKeyViews = async (rows: readonly DeployKeyRow[]) => {
  const person = await peopleById(rows.map((row) => row.addedByUserId));
  return rows.map((row) => ({
    ...keyFields(row),
    readOnly: row.readOnly,
    addedBy: person(row.addedByUserId),
  }));
};

export const DeployKeysHandlers = HttpApiBuilder.group(GitApi, "deployKeys", (handlers) =>
  handlers
    .handle(
      "list",
      repoOp(async (cx) => ({
        keys: await deployKeyViews(await listDeployKeys(cx.repo.repository.id)),
      })),
    )
    .handle(
      "create",
      repoOp(async (cx, { payload }) => {
        const key = await parseKey(payload.key, payload.title);
        const row = await addDeployKey(cx.repo.repository.id, {
          ...key,
          readOnly: payload.readOnly ?? true,
          addedByUserId: cx.userId,
        });
        if (!row) throw conflict(KEY_IN_USE, "key_in_use");
        const [view] = await deployKeyViews([row]);
        return view!;
      }),
    )
    .handle(
      "delete",
      repoOp(async (cx, { params }) => {
        if (!(await deleteDeployKey(cx.repo.repository.id, params.keyId))) {
          throw notFound("No such key");
        }
        return ok;
      }),
    ),
);

const tokenView = (row: AccessTokenRow) => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  scopes: normalizeScopes(row.scopes),
  createdAt: iso(row.createdAt),
  // What an MCP client was granted (`mcp/oauth/grants.ts`) is listed with the
  // tokens and revoked the same way. Its row's expiry is its current access
  // token's, an hour out, which the client renews by itself: what a person
  // wants to know is when the connection ends if it is left unused.
  expiresAt: isoOrNull(
    row.expiresAt !== null && isOAuthGrantId(row.id) ? grantLapsesAt(row.expiresAt) : row.expiresAt,
  ),
  lastUsedAt: isoOrNull(row.lastUsedAt),
});

const commitEmailView = (row: GitCommitEmail): CommitEmail => ({
  id: row.id,
  organizationId: row.organizationId,
  email: row.email,
  verifiedAt: isoOrNull(row.verifiedAt),
  codeSentAt: isoOrNull(row.sentAt),
  createdAt: iso(row.createdAt),
});

/** Server-core's answer as the API's: the address, or the refusal under its status. */
const commitEmailOf = (result: GitCommitEmailResult): CommitEmail => {
  if (result.ok) return commitEmailView(result.email);
  const { status, code, message } = result.refusal;
  const known = code === "not_found" || code === "too_soon" ? undefined : code;
  if (status === 404) throw notFound(message);
  if (status === 403) throw forbidden(message, known);
  if (status === 409) throw conflict(message, known);
  throw badRequest(message, known);
};

export const AccountHandlers = HttpApiBuilder.group(GitApi, "account", (handlers) =>
  handlers
    .handle(
      "listKeys",
      op(async (cx) => ({ keys: (await listUserKeys(cx.userId!)).map(keyFields) })),
    )
    .handle(
      "createKey",
      op(async (cx, { payload }) => {
        const row = await addUserKey(cx.userId!, await parseKey(payload.key, payload.title));
        if (!row) throw conflict(KEY_IN_USE, "key_in_use");
        return keyFields(row);
      }),
    )
    .handle(
      "deleteKey",
      op(async (cx, { params }) => {
        if (!(await deleteUserKey(cx.userId!, params.keyId))) throw notFound("No such key");
        return ok;
      }),
    )
    .handle(
      "listTokens",
      op(async (cx) => ({ tokens: (await listAccessTokens(cx.userId!)).map(tokenView) })),
    )
    .handle(
      "createToken",
      op(async (cx, { payload }) => {
        const minted = await mintAccessToken();
        const row = await insertAccessToken({
          userId: cx.userId!,
          name: payload.name.trim(),
          prefix: minted.prefix,
          hash: minted.hash,
          scopes: normalizeScopes(payload.scopes),
          expiresAt:
            payload.expiresInDays == null
              ? null
              : new Date(Date.now() + payload.expiresInDays * 24 * 60 * 60 * 1000),
        });
        return { token: tokenView(row), secret: minted.secret };
      }),
    )
    .handle(
      "revokeToken",
      op(async (cx, { params }) => {
        if (!(await revokeAccessToken(cx.userId!, params.tokenId))) throw notFound("No such token");
        return ok;
      }),
    )
    .handle(
      "listCommitEmails",
      op(async (cx) => {
        // Only the organisations the session lists: an address kept where the
        // person is no longer a member is not shown, and counts for nothing.
        const organizations = (await cx.viewer()).organizations.map(
          (organization) => organization.id,
        );
        return {
          emails: (await listGitCommitEmails(cx.userId!, organizations)).map(commitEmailView),
        };
      }),
    )
    .handle(
      "addCommitEmail",
      op(async (cx, { payload }) => {
        const member = (await cx.viewer()).organizations.some(
          (organization) => organization.id === payload.organizationId,
        );
        if (!member) throw forbidden("You are not a member of that organisation", "not_a_member");
        return commitEmailOf(
          await addGitCommitEmail({
            organizationId: payload.organizationId,
            userId: cx.userId!,
            email: payload.email,
          }),
        );
      }),
    )
    .handle(
      "sendCommitEmailCode",
      op(async (cx, { params }) =>
        commitEmailOf(await resendGitCommitEmail({ id: params.emailId, userId: cx.userId! })),
      ),
    )
    .handle(
      "verifyCommitEmail",
      op(async (cx, { params, payload }) =>
        commitEmailOf(
          await verifyGitCommitEmail({
            id: params.emailId,
            userId: cx.userId!,
            code: payload.code,
          }),
        ),
      ),
    )
    .handle(
      "removeCommitEmail",
      op(async (cx, { params }) => {
        if (!(await removeGitCommitEmail({ id: params.emailId, userId: cx.userId! }))) {
          throw notFound("No such address");
        }
        return ok;
      }),
    ),
);
