/**
 * `/api/session` and the namespace endpoints: who is signed in, the username
 * a first sign-in picks, profiles, and an organisation claiming its
 * namespace.
 */
import { and, eq, ilike, or, sql } from "drizzle-orm";
import { HttpApiBuilder } from "effect/http-api";
import {
  AUTH_PATHS,
  type ErrorCode,
  GIT_PERMISSIONS,
  GitApi,
  NAME_MAX_LENGTH,
  type Namespace,
  TooManyRequests,
  badRequest,
  conflict,
  forbidden,
  nameProblemMessage,
  namespaceSlugProblem,
  notFound,
  suggestSlug,
} from "@infrawrench/git-contract";
import { gitNamespaces, gitUsers, users } from "@infrawrench/server-core/db/schema";
import { gitPrivateRepositoryRefusal } from "@infrawrench/server-core/git/quota";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { signOut } from "../../auth/sign-in";
import { db } from "../../db/client";
import {
  type NamespaceRow,
  claimOrganizationNamespace,
  claimUserNamespace,
  getNamespaceBySlug,
  getNamespaceForOrganization,
  getNamespaceForUser,
  isSlugTaken,
  renameNamespace,
  updateNamespaceProfile,
} from "../../db/namespaces";
import { getOrganization } from "../../db/organizations";
import { countVisibleRepositories } from "../../db/repository-lists";
import { maySignUp } from "../../db/signups"; // git-feature-flag
import { getGitUser, getUser } from "../../db/users";
import { appOrigin } from "../../env";
import { type Cx, op } from "../context";
import { iso } from "../views/repositories";

const gitPermissionsOf = (permissions: readonly string[]) =>
  GIT_PERMISSIONS.filter((permission) => hasPermission(permissions, permission));

/** Refuse a slug the rules do not allow, with the code the form branches on. */
const checkSlug = (slug: string, invalid: ErrorCode, reserved: ErrorCode): void => {
  const problem = namespaceSlugProblem(slug);
  if (problem === null) return;
  throw badRequest(
    nameProblemMessage(problem, NAME_MAX_LENGTH),
    problem === "reserved" ? reserved : invalid,
  );
};

/** A free, valid username to offer, from the person's name or email. */
const suggestUsername = async (sources: ReadonlyArray<string | null>): Promise<string | null> => {
  for (const source of sources) {
    const base = source ? suggestSlug(source) : "";
    if (base === "" || namespaceSlugProblem(base) !== null) continue;
    for (const candidate of [base, `${base}-1`, `${base}-2`, `${base}-3`]) {
      if (namespaceSlugProblem(candidate) === null && !(await isSlugTaken(candidate))) {
        return candidate;
      }
    }
  }
  return null;
};

/**
 * A username is the person's account, not a repository: claimed and changed
 * from a signed-in browser only, never with a token, whatever its scopes. A
 * freed username can be claimed by someone else, so a token that could rename
 * one could hand the person's URLs to a stranger.
 */
export const requireSession = (cx: Pick<Cx, "principal">): void => {
  if (cx.principal.kind !== "user" || cx.principal.via !== "session") {
    throw forbidden("A username is changed from a signed-in browser, not with a token");
  }
};

/** How often a namespace may be renamed: old URLs stop resolving each time. */
const RENAME_INTERVAL_MS = 24 * 60 * 60 * 1000;

const checkRenameInterval = (namespace: NamespaceRow): void => {
  if (namespace.renamedAt && Date.now() - namespace.renamedAt.getTime() < RENAME_INTERVAL_MS) {
    throw new TooManyRequests({ error: "A name can be changed once a day" });
  }
};

export const namespaceView = async (cx: Cx, namespace: NamespaceRow): Promise<Namespace> => {
  const viewer = await cx.viewer();
  const membership =
    namespace.organizationId === null
      ? undefined
      : viewer.organizations.find((organization) => organization.id === namespace.organizationId);
  const isUserOwner = namespace.userId !== null && namespace.userId === cx.userId;
  const permissions = membership ? gitPermissionsOf(membership.permissions) : [];
  // A token never reaches settings; a session does.
  const session = cx.principal.kind === "user" && cx.principal.via === "session";
  const isOwner = session && (isUserOwner || permissions.includes("git:admin"));
  const sees = isUserOwner || membership !== undefined;
  return {
    id: namespace.id,
    slug: namespace.slug,
    kind: namespace.kind,
    displayName: namespace.displayName,
    description: namespace.description,
    avatarUrl: namespace.avatarUrl,
    websiteUrl: namespace.websiteUrl,
    location: namespace.location,
    userId: namespace.userId,
    organizationId: membership ? namespace.organizationId : null,
    appUrl:
      membership && namespace.organizationId
        ? `${appOrigin(cx.env)}/org/${namespace.organizationId}`
        : null,
    repositoryCount: await countVisibleRepositories(namespace.id, viewer),
    createdAt: iso(namespace.createdAt),
    viewer: {
      isOwner,
      canCreateRepository:
        cx.username !== null &&
        sees &&
        (isUserOwner || permissions.includes("git:write") || permissions.includes("git:admin")),
      canAdminister: isOwner,
      permissions,
    },
  };
};

export const SessionHandlers = HttpApiBuilder.group(GitApi, "session", (handlers) =>
  handlers
    .handle(
      "me",
      op(async (cx) => {
        const base = { signInUrl: AUTH_PATHS.signIn, appUrl: appOrigin(cx.env) };
        const userId = cx.principal.kind === "user" ? cx.principal.userId : null;
        const user = userId ? await getUser(userId) : null;
        if (!user) {
          return { user: null, onboarding: null, personal: null, organizations: [], ...base };
        }
        const [gitUser, namespace, viewer] = await Promise.all([
          getGitUser(user.id),
          getNamespaceForUser(user.id),
          cx.viewer(),
        ]);
        const organizations = await Promise.all(
          viewer.organizations.map(async (organization) => {
            const permissions = gitPermissionsOf(organization.permissions);
            // Whether one more private repository fits the plan right now, and why not.
            const refusal = await gitPrivateRepositoryRefusal({
              organizationId: organization.id,
              userId: null,
            });
            return {
              id: organization.id,
              name: organization.name,
              namespace: organization.namespace,
              permissions,
              canClaimNamespace:
                organization.namespace === null && permissions.includes("git:admin"),
              privateRepositories: refusal === null,
              privateRepositoryRefusal: refusal,
              defaultVisibility: organization.defaultVisibility ?? "private",
            };
          }),
        );
        const personalRefusal =
          namespace === null
            ? null
            : await gitPrivateRepositoryRefusal({ organizationId: null, userId: user.id });
        return {
          user: {
            id: user.id,
            email: user.email,
            username: namespace?.slug ?? null,
            displayName: namespace?.displayName ?? user.displayName,
            avatarUrl: namespace?.avatarUrl ?? gitUser?.avatarUrl ?? null,
          },
          onboarding: {
            needsUsername: namespace === null,
            suggestedUsername:
              namespace === null
                ? await suggestUsername([
                    gitUser?.suggestedSlug ?? null,
                    user.email,
                    user.displayName,
                  ])
                : null,
            // git-feature-flag: remove with the flag (KNOWLEDGE.md "Git feature flag").
            signupsOpen: namespace === null ? await maySignUp(user.id) : true,
          },
          personal:
            namespace === null
              ? null
              : {
                  privateRepositories: personalRefusal === null,
                  privateRepositoryRefusal: personalRefusal,
                  defaultVisibility: namespace.defaultVisibility,
                },
          organizations,
          ...base,
        };
      }),
    )
    .handle(
      "signOut",
      op(async (cx) => {
        const { cookie, redirectTo } = await signOut(cx.request, cx.env);
        cx.setCookie(cookie);
        return { ok: true as const, redirectTo };
      }),
    )
    .handle(
      "usernameAvailability",
      op(async (_cx, { query }) => {
        const username = query.username;
        const problem = namespaceSlugProblem(username);
        if (problem !== null) {
          return {
            username,
            available: false,
            reason: problem === "reserved" ? ("reserved" as const) : ("invalid" as const),
            message: nameProblemMessage(problem, NAME_MAX_LENGTH),
          };
        }
        return (await isSlugTaken(username))
          ? {
              username,
              available: false,
              reason: "taken" as const,
              message: "That username is taken",
            }
          : { username, available: true, reason: null, message: null };
      }),
    )
    .handle(
      "claimUsername",
      op(async (cx, { payload }) => {
        requireSession(cx);
        const userId = cx.userId!;
        checkSlug(payload.username, "username_invalid", "username_reserved");
        // git-feature-flag: remove with the flag (KNOWLEDGE.md "Git feature flag").
        if (!(await maySignUp(userId))) {
          throw forbidden("Sign-ups are not open yet", "signups_closed");
        }
        const user = await getUser(userId);
        const claimed = await claimUserNamespace(userId, payload.username, {
          displayName: user?.displayName ?? null,
        });
        if (!claimed.ok) {
          throw claimed.reason === "already_claimed"
            ? conflict("You already have a username", "namespace_already_claimed")
            : conflict("That username is taken", "username_taken");
        }
        return { namespace: refOf(claimed.namespace) };
      }),
    )
    .handle(
      "renameUsername",
      op(async (cx, { payload }) => {
        requireSession(cx);
        checkSlug(payload.username, "username_invalid", "username_reserved");
        const current = await getNamespaceForUser(cx.userId!);
        if (!current) throw forbidden("Choose a username first", "username_required");
        if (current.slug === payload.username) return { namespace: refOf(current) };
        // A change of case only is not a new name and does not count.
        if (current.slugLower !== payload.username.toLowerCase()) checkRenameInterval(current);
        const renamed = await renameNamespace(current.id, payload.username);
        if (!renamed) throw conflict("That username is taken", "username_taken");
        return { namespace: refOf(renamed) };
      }),
    ),
);

const refOf = (namespace: NamespaceRow) => ({
  slug: namespace.slug,
  kind: namespace.kind,
  displayName: namespace.displayName,
  avatarUrl: namespace.avatarUrl,
});

export const NamespacesHandlers = HttpApiBuilder.group(GitApi, "namespaces", (handlers) =>
  handlers
    .handle(
      "get",
      op(async (cx, { params }) => {
        const namespace = await getNamespaceBySlug(params.namespace);
        if (!namespace) throw notFound("No such user or organisation");
        return namespaceView(cx, namespace);
      }),
    )
    .handle(
      "update",
      op(async (cx, { params, payload }) => {
        const namespace = await getNamespaceBySlug(params.namespace);
        if (!namespace) throw notFound("No such user or organisation");
        if (!(await namespaceView(cx, namespace)).viewer.canAdminister) {
          throw forbidden("Only its owner can edit this profile");
        }
        if (
          payload.websiteUrl !== undefined &&
          payload.websiteUrl !== null &&
          !/^https?:\/\/[^\s]+$/i.test(payload.websiteUrl)
        ) {
          throw badRequest("The website must be an http or https URL");
        }
        const updated = await updateNamespaceProfile(namespace.id, payload);
        return namespaceView(cx, updated ?? namespace);
      }),
    )
    .handle(
      "claimForOrganization",
      op(async (cx, { params, payload }) => {
        const organization = await getOrganization(params.orgId);
        if (!organization) throw notFound("No such organisation");
        checkSlug(payload.slug, "name_invalid", "username_reserved");
        const claimedBy = cx.principal.kind === "anonymous" ? null : cx.principal;
        const userId = claimedBy && "userId" in claimedBy ? claimedBy.userId : "";
        const claimed = await claimOrganizationNamespace(organization.id, payload.slug, userId, {
          displayName: organization.name,
        });
        if (!claimed.ok) {
          throw claimed.reason === "already_claimed"
            ? conflict("This organisation already has a namespace", "namespace_already_claimed")
            : conflict("That name is taken", "namespace_taken");
        }
        return namespaceView(cx, claimed.namespace);
      }),
    )
    .handle(
      "renameForOrganization",
      op(async (cx, { params, payload }) => {
        const current = await getNamespaceForOrganization(params.orgId);
        if (!current) throw notFound("This organisation has no namespace yet");
        checkSlug(payload.slug, "name_invalid", "username_reserved");
        if (current.slug === payload.slug) return namespaceView(cx, current);
        const renamed = await renameNamespace(current.id, payload.slug);
        if (!renamed) throw conflict("That name is taken", "namespace_taken");
        return namespaceView(cx, renamed);
      }),
    )
    .handle(
      "searchUsers",
      op(async (_cx, { query }) => {
        const q = query.q.trim();
        if (q === "") return { users: [] };
        const pattern = `${q.replace(/[\\%_]/g, "\\$&")}%`;
        const rows = await db
          .select({
            id: users.id,
            username: gitNamespaces.slug,
            displayName: sql<
              string | null
            >`coalesce(${gitNamespaces.displayName}, ${users.displayName})`,
            avatarUrl: sql<
              string | null
            >`coalesce(${gitNamespaces.avatarUrl}, ${gitUsers.avatarUrl})`,
          })
          .from(gitNamespaces)
          .innerJoin(users, eq(users.id, gitNamespaces.userId))
          .leftJoin(gitUsers, eq(gitUsers.userId, users.id))
          .where(
            and(
              eq(gitNamespaces.kind, "user"),
              or(
                sql`${gitNamespaces.slugLower} like ${pattern.toLowerCase()}`,
                ilike(gitNamespaces.displayName, pattern),
              ),
            ),
          )
          .orderBy(gitNamespaces.slugLower)
          .limit(10);
        return { users: rows };
      }),
    ),
);
