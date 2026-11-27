/**
 * The contract's two gates, enforced before a payload is decoded.
 *
 * - `Authentication`: who is calling. Refuses a credential we do not accept
 *   (401), enforces `RequiresUser` and `RequiredOrgPermission`, holds writes
 *   until a signed-in person has a username, and provides `Caller`.
 * - `RepositoryAccess`: resolves `:owner/:repo`, answers 404 to anyone who
 *   cannot read it, enforces `RequiredAccess` (against the un-archived level
 *   where the endpoint is `AllowedWhenArchived`), and provides
 *   `CurrentRepository`.
 *
 * Both also leave what the handlers read on the fiber (`AuthRef`, `RepoRef`).
 */
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import {
  AllowedWhenArchived,
  Authentication,
  Caller,
  CurrentRepository,
  type GitPermission,
  RepositoryAccess,
  RequiredAccess,
  RequiredOrgPermission,
  RequiresUser,
  accessAtLeast,
  forbidden,
  notFound,
  unauthorized,
} from "@infrawrench/git-contract";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { type Principal, toCaller } from "../auth/principal";
import { repoAccess } from "../auth/repo-access";
import { getNamespaceForUser } from "../db/namespaces";
import { agentMayCall, isAgentEndpoint } from "./agent-token";
import { orgPermissions } from "../db/organizations";
import { getRepository, toRepoForAccess } from "../db/repositories";
import { AuthRef, type AuthState, RepoRef, inScope } from "./context";
import { RequestErrorsLive } from "./errors";

const routeParam = Effect.fnUntraced(function* (name: string) {
  const route = yield* HttpRouter.RouteContext;
  return route.params[name];
});

/** Whether the principal holds `permission` in the organisation. */
const holdsOrgPermission = async (
  principal: Principal,
  organizationId: string,
  permission: GitPermission,
): Promise<boolean> => {
  if (principal.kind === "api-key") {
    return (
      principal.organizationId === organizationId &&
      hasPermission(principal.permissions, permission)
    );
  }
  // A token never reaches settings (`repoAccess` rule 2), and this gate is settings.
  if (principal.kind !== "user" || principal.via !== "session") return false;
  const granted = await orgPermissions(organizationId, principal.userId, { withElevation: true });
  return hasPermission(granted, permission);
};

/** Groups a signed-in person may call before they have a username. */
const BEFORE_USERNAME = new Set(["session"]);
/** Groups only a session reaches: a token cannot mint or revoke credentials. */
const SESSION_ONLY = new Set(["account", "t3"]);
/**
 * The only groups a CI job token reaches: it reports statuses on its
 * repository's commits, an agent running in a job records its trace
 * (`handlers/traces.ts`) and reads and answers its instructions
 * (`handlers/instructions.ts`, which keeps sending and withdrawing one to
 * people), and a reviewer running in a job reports what it found
 * (`handlers/findings.ts`, which lets a job list and report and nothing
 * else). Everything else a job reads it reads over Git; it never merges,
 * comments or changes settings through the API.
 */
const JOB_GROUPS = new Set(["statuses", "traces", "instructions", "findings"]);

export const AuthenticationLive = Layer.succeed(Authentication)((httpEffect, { endpoint, group }) =>
  Effect.gen(function* () {
    const authenticated = yield* inScope(async (inv) => {
      const result = await inv.authenticate(inv.request, inv.env);
      // On every answer from here on, refusals included: WorkOS has already
      // rotated the refresh token behind a refreshed session.
      inv.cookies.push(...result.setCookies);
      const principal = result.principal;
      const username =
        principal.kind === "user"
          ? ((await getNamespaceForUser(principal.userId))?.slug ?? null)
          : null;
      return { ...result, username } satisfies AuthState;
    });
    if (authenticated.refused) return yield* unauthorized("That credential was not accepted");

    const principal = authenticated.principal;
    // Now that it is known who is asking: their budget for this kind of request.
    const limited = yield* inScope((inv) => inv.admit(inv.request, principal));
    if (limited !== null) return HttpServerResponse.raw(limited);
    if (
      principal.kind === "job" &&
      !JOB_GROUPS.has(group.identifier) &&
      !isAgentEndpoint(principal, group.identifier, endpoint.identifier)
    ) {
      return yield* forbidden("A CI job token reads over Git and reports commit statuses");
    }
    // An agent's token for one branch's markers: those endpoints and no others.
    if (!agentMayCall(principal, group.identifier, endpoint.identifier)) {
      return yield* forbidden(
        "An agent's token records a trace, answers instructions and reports findings on its branch",
      );
    }
    const isPerson = principal.kind === "user";
    if (Context.get(endpoint.annotations, RequiresUser) && !isPerson) {
      return yield* principal.kind === "anonymous"
        ? unauthorized()
        : forbidden("This needs a signed-in person");
    }
    if (SESSION_ONLY.has(group.identifier) && !(isPerson && principal.via === "session")) {
      return yield* principal.kind === "anonymous"
        ? unauthorized()
        : forbidden("Credentials are managed from a signed-in browser, not with a token");
    }
    // Signed in without a username: reads like a visitor, writes nothing.
    if (
      isPerson &&
      authenticated.username === null &&
      endpoint.method !== "GET" &&
      !BEFORE_USERNAME.has(group.identifier)
    ) {
      return yield* forbidden("Choose a username first", "username_required");
    }

    const orgPermission = Context.get(endpoint.annotations, RequiredOrgPermission);
    if (orgPermission !== undefined) {
      if (principal.kind === "anonymous") return yield* unauthorized();
      const organizationId = (yield* routeParam("orgId")) ?? "";
      const allowed = yield* inScope(() =>
        holdsOrgPermission(principal, organizationId, orgPermission),
      );
      if (!allowed) return yield* forbidden(`This needs ${orgPermission} in the organisation`);
    }

    return yield* httpEffect.pipe(
      Effect.provideService(Caller, toCaller(principal, authenticated.username)),
      Effect.provideService(AuthRef, authenticated),
    );
  }),
);

/**
 * Writes an archived repository still takes from anyone who can read it:
 * they change the caller's own things, not the repository.
 */
const ARCHIVE_SAFE = new Set(["repositories.star", "repositories.unstar", "repositories.fork"]);

export const RepositoryAccessLive = Layer.succeed(RepositoryAccess)(
  (httpEffect, { endpoint, group }) =>
    Effect.gen(function* () {
      const auth = yield* AuthRef;
      const owner = (yield* routeParam("owner")) ?? "";
      const name = (yield* routeParam("repo")) ?? "";
      const resolved = yield* inScope(async () => {
        const found = await getRepository(owner, name);
        if (!found) return null;
        return { found, decision: await repoAccess.detail(auth.principal, toRepoForAccess(found)) };
      });
      // Missing and unreadable are one answer, so a private repository does not leak.
      if (!resolved || resolved.decision.access === "none") {
        return yield* notFound("Repository not found");
      }
      const { found, decision } = resolved;
      const access = decision.access;

      const need = Context.get(endpoint.annotations, RequiredAccess) ?? "read";
      const whenArchived = Context.get(endpoint.annotations, AllowedWhenArchived);
      const judged = whenArchived ? decision.unarchived : access;
      // Archived is read-only for everybody. The cap on `access` already holds
      // back what needs more than `read`; this holds back the writes that need
      // only `read` (a comment, a new issue, a review).
      if (
        found.repository.archived &&
        endpoint.method !== "GET" &&
        !whenArchived &&
        !ARCHIVE_SAFE.has(`${group.identifier}.${endpoint.identifier}`)
      ) {
        if (auth.principal.kind === "anonymous") return yield* unauthorized();
        return yield* forbidden("This repository is archived and read-only", "repository_archived");
      }
      if (!accessAtLeast(judged, need)) {
        if (auth.principal.kind === "anonymous") return yield* unauthorized();
        return yield* found.repository.archived && accessAtLeast(decision.unarchived, need)
          ? forbidden("This repository is archived and read-only", "repository_archived")
          : forbidden(`This needs ${need} access to the repository`);
      }

      return yield* httpEffect.pipe(
        Effect.provideService(CurrentRepository, {
          id: found.repository.id,
          namespaceId: found.repository.namespaceId,
          owner: found.owner.slug,
          name: found.repository.name,
          visibility: found.repository.visibility,
          archived: found.repository.archived,
          defaultBranch: found.repository.defaultBranch,
          access,
        }),
        Effect.provideService(RepoRef, { found, access, unarchived: decision.unarchived }),
      );
    }),
);

/** Every middleware implementation, for the server to provide once. */
export const MiddlewareLive = Layer.mergeAll(
  AuthenticationLive,
  RepositoryAccessLive,
  RequestErrorsLive,
);
