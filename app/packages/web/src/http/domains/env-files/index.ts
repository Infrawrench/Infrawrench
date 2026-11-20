/**
 * Environment files: `/api/org/:orgId/env-files`, the handlers.
 *
 * The service (`server-core/env-files/service.ts`) stores nothing: the
 * committed `.infraenv` is the map. `resolve` is the one route that returns
 * secret values; it calls plugin code, so it runs on the gateway
 * (`edge/gateway-routes.ts`), inside one `legacy` call so `withEgressScope`
 * covers every plugin read, and it is audited with the variable names only.
 */
import { Data, Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { getInstallationAccess } from "@infrawrench/server-core/github/app";
import { GithubApiError } from "@infrawrench/server-core/github/issues-api";
import {
  EnvFileNotFound,
  EnvFileRefused,
  commitInfraenvFile,
  describeInfraenv,
  listInfraenvRepos,
  listInfraenvSources,
  readInfraenvRepoFile,
  resolveInfraenv,
} from "@infrawrench/server-core/env-files/service";
import {
  BadGateway,
  BadRequest,
  EnvFilesApi,
  GithubPermissionRequired,
  InfraenvCommitResult,
  InfraenvDescribeResponse,
  InfraenvRepoFile,
  InfraenvRepoList,
  InfraenvResolveResponse,
  InfraenvSourceList,
  NotFound,
} from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { unexpectedAs } from "../../refusals";

/** An installation lacking a permission: answered once its manage URL is looked up. */
class NeedsPermission extends Data.TaggedError("NeedsPermission")<{
  readonly cause: GithubApiError;
  readonly permission: string;
}> {}

function envFileRefusal(
  error: unknown,
): NeedsPermission | BadRequest | NotFound | BadGateway | undefined {
  if (error instanceof EnvFileRefused) return new BadRequest({ error: error.message });
  if (error instanceof EnvFileNotFound) return new NotFound({ error: error.message });
  if (error instanceof GithubApiError) {
    if (error.missingPermission) {
      return new NeedsPermission({ cause: error, permission: error.missingPermission });
    }
    // GitHub's 409 on a contents write is a sha that moved on: the editor's
    // copy is stale, which is the caller's to fix.
    return error.status !== null && [400, 404, 409, 410, 422].includes(error.status)
      ? new BadRequest({ error: error.message })
      : new BadGateway({ error: error.message });
  }
  return undefined;
}

const envFileCall = <A>(fn: () => PromiseLike<A>) =>
  legacyTry(fn, envFileRefusal).pipe(
    Effect.catchTag("NeedsPermission", ({ cause, permission }) =>
      Effect.gen(function* () {
        const access = yield* legacy(() =>
          getInstallationAccess(cause.installationId).catch(() => null),
        );
        return yield* new GithubPermissionRequired({
          error: cause.message,
          code: "github_permission_required",
          permissions: [permission],
          installationId: cause.installationId,
          accountLogin: access?.accountLogin ?? null,
          manageUrl: access?.htmlUrl ?? null,
        });
      }),
    ),
    unexpectedAs({ logPrefix: "[env-files]", failure: "Environment file request failed" }),
  );

const audit = Effect.fn("envFiles.audit")(function* (
  action: string,
  entityId: string,
  metadata: Record<string, unknown>,
) {
  const { organizationId, session } = yield* OrgPrincipal;
  yield* fireAndForget(() =>
    logAudit({
      organizationId,
      userId: session.userId,
      action,
      entityType: "env_file",
      entityId,
      metadata,
    }),
  );
});

const EnvFilesHandlers = HttpApiBuilder.group(EnvFilesApi, "envFiles", (handlers) =>
  handlers
    .handle("describe", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        // The schema caps the source at the size the service checks, so this
        // reads stored state and cannot refuse.
        const described = yield* legacy(() => describeInfraenv(organizationId, payload.source));
        return yield* respond(InfraenvDescribeResponse)(described);
      }),
    )
    .handle("resolve", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const resolved = yield* envFileCall(() =>
          resolveInfraenv(organizationId, {
            source: payload.source,
            environment: payload.environment ?? null,
            sourceName: payload.sourceName,
          }),
        );
        // Names only: the values are the secrets this route exists to hand out.
        yield* audit("env_file.resolve", payload.sourceName || ".infraenv", {
          environment: resolved.environment,
          variables: resolved.values.map((v) => v.key),
          failed: resolved.problems.flatMap((p) => (p.key ? [p.key] : [])),
        });
        return yield* respond(InfraenvResolveResponse)(resolved);
      }),
    )
    .handle("sources", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const sources = yield* legacy(() =>
          listInfraenvSources(organizationId, { q: query.q, limit: query.limit }),
        );
        return yield* respond(InfraenvSourceList)({ sources });
      }),
    )
    .handle("repos", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const list = yield* envFileCall(() => listInfraenvRepos(organizationId));
        return yield* respond(InfraenvRepoList)(list);
      }),
    )
    .handle("readFile", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const file = yield* envFileCall(() =>
          readInfraenvRepoFile(organizationId, {
            installationId: query.installationId,
            repo: query.repo,
            path: query.path,
            branch: query.branch,
          }),
        );
        return yield* respond(InfraenvRepoFile)(file);
      }),
    )
    .handle("commit", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const result = yield* envFileCall(() => commitInfraenvFile(organizationId, payload));
        yield* audit("env_file.commit", `${payload.repo}:${payload.path}`, {
          repo: payload.repo,
          path: payload.path,
          mode: result.mode,
          branch: result.branch,
          commitSha: result.commitSha,
          pullRequest: result.pullRequest?.url ?? null,
        });
        return yield* respond(InfraenvCommitResult)(result);
      }),
    ),
);

export const envFilesDomain = makeDomain("env-files", EnvFilesApi, EnvFilesHandlers);
