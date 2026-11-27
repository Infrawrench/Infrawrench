/**
 * Git: `/api/org/:orgId/git`, the handlers. The queries are server-core's
 * (`git/forge.ts`), promise code that runs through `legacy`; the forge's own
 * Worker reads the same tables, so nothing here calls it.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  badRequest,
  conflict,
  GitForgeApi,
  GitForgeNamespace,
  GitForgeOverview,
  GitForgeRepositoryList,
  notFound,
} from "@infrawrench/api-contract";
import {
  GitForgeError,
  gitForgeOverview,
  listGitForgeRepositories,
  setGitForgeDefaultVisibility,
  setGitForgeNamespace,
} from "@infrawrench/server-core/git/forge";
import { keepAlive } from "@infrawrench/server-core/runtime/request-scope";
import { isPlatformAdmin } from "../../../auth/platform-admin";
import { logAudit } from "../../../services/audit";
import { ensureGitStoragePrice } from "../billing/operations";
import { makeDomain } from "../../domain";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

/** The refusals `git/forge.ts` throws, as each endpoint's declared errors. */
const namespaceRefusal = (error: unknown) => {
  if (!(error instanceof GitForgeError)) return undefined;
  return error.status === 409 ? conflict(error.message) : badRequest(error.message);
};

const settingsRefusal = (error: unknown) => {
  if (!(error instanceof GitForgeError)) return undefined;
  return error.status === 404 ? notFound(error.message) : badRequest(error.message);
};

/**
 * The reserved names (`infrawrench`, `admin`, ...) keep people from posing as
 * the company or the site. A platform admin, in person and not with a key,
 * may take one for Infrawrench's own organisation.
 */
const mayUseReservedNames = (email: string | undefined, apiKey: unknown): boolean =>
  !apiKey && isPlatformAdmin(email);

const GitForgeHandlers = HttpApiBuilder.group(GitForgeApi, "gitForge", (handlers) =>
  handlers
    .handle("overview", () =>
      Effect.gen(function* () {
        const { organizationId, session, apiKey } = yield* OrgPrincipal;
        const overview = yield* legacy(() => gitForgeOverview(organizationId));
        return yield* respond(GitForgeOverview)({
          ...overview,
          reservedNamesAllowed: mayUseReservedNames(session.email, apiKey),
        });
      }),
    )
    .handle("setNamespace", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session, apiKey } = yield* OrgPrincipal;
        const result = yield* legacyTry(
          () =>
            // A key has no person behind it to record as the claimant.
            setGitForgeNamespace(organizationId, payload.slug, apiKey ? null : session.userId, {
              allowReserved: mayUseReservedNames(session.email, apiKey),
            }),
          namespaceRefusal,
        );
        if (result.change !== "none") {
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: result.change === "claimed" ? "git.namespace.claim" : "git.namespace.rename",
              entityType: "git_namespace",
              entityId: organizationId,
              metadata: { slug: result.namespace.slug, from: result.from ?? null },
            }),
          );
        }
        // Storage above the plan's included amount is billed by a metered
        // price that subscriptions made before the forge existed lack. Adding
        // it is best-effort: the namespace is claimed either way, and the log
        // says what to fix by hand.
        if (result.change === "claimed") {
          yield* fireAndForget(() =>
            keepAlive(
              ensureGitStoragePrice(organizationId).then(
                (added) => {
                  if (added.length > 0)
                    console.log(`[git] added the storage price to org ${organizationId}`);
                },
                (err: unknown) =>
                  console.error(
                    `[git] could not add the storage price to org ${organizationId}'s subscription:`,
                    err,
                  ),
              ),
            ),
          );
        }
        return yield* respond(GitForgeNamespace)(result.namespace);
      }),
    )
    .handle("setSettings", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const namespace = yield* legacyTry(
          () => setGitForgeDefaultVisibility(organizationId, payload.defaultVisibility),
          settingsRefusal,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "git.settings.update",
            entityType: "git_namespace",
            entityId: organizationId,
            metadata: { defaultVisibility: namespace.defaultVisibility },
          }),
        );
        return yield* respond(GitForgeNamespace)(namespace);
      }),
    )
    .handle("repositories", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const repositories = yield* legacy(() => listGitForgeRepositories(organizationId));
        return yield* respond(GitForgeRepositoryList)({ repositories });
      }),
    ),
);

export const gitDomain = makeDomain("git", GitForgeApi, GitForgeHandlers);
