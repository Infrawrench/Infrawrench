/**
 * Pull request checks: `/api/org/:orgId/pr-checks`, the handlers.
 *
 * The checks themselves are posted by the github-watcher through the org's
 * GitHub App installation; these configure which repositories get them, list
 * what was posted, and preview the analysis without posting (the CLI's
 * `pr-check`, and the editor extensions). The preview runs plugin estimators
 * and reads GitHub, so it is listed in `edge/gateway-routes.ts`; the CRUD is
 * plain Postgres and stays on the edge.
 */
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { isGithubAppConfigured } from "@infrawrench/server-core/github/app";
import { GithubApiError, isRepoFullName } from "@infrawrench/server-core/github/issues-api";
import {
  PrCheckSettingsError,
  createPrCheckRepository,
  deletePrCheckRepository,
  getPrCheckRepository,
  listPrCheckInstallationAccess,
  listPrCheckRepositories,
  updatePrCheckRepository,
} from "@infrawrench/server-core/pr-checks/settings";
import { listPrCheckRuns } from "@infrawrench/server-core/pr-checks/runs";
import {
  previewFilesCheck,
  previewPullRequestCheck,
} from "@infrawrench/server-core/pr-checks/pass";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { BadGateway, badRequest, HttpFailure, notFound } from "../../errors";
import { fireAndForget, legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import type { Refusals } from "../input-refusals";
import { refuse, statusCall, type ReadRefusal } from "../status-refusals";
import {
  PrCheckDeleted,
  PrCheckPreview,
  PrCheckRepository,
  PrCheckRun,
  PrChecksApi,
  PrCheckStatus,
} from "./api";

/**
 * The route's `failure(c, err)`: a settings refusal carries its status; a
 * GitHub refusal of the request is the caller's 400, any other GitHub failure
 * a 502.
 */
const prCheckRefusal: ReadRefusal = (error) => {
  if (error instanceof PrCheckSettingsError) return error;
  if (error instanceof GithubApiError) {
    const status = error.status !== null && [400, 404, 410, 422].includes(error.status) ? 400 : 502;
    return { status, message: error.message };
  }
  return undefined;
};

/** As {@link statusCall}, with anything unrecognised logged and answered as the route's own 500. */
const prCheckCall = <A, E>(refusals: Refusals<E>, fn: () => PromiseLike<A>) =>
  statusCall(prCheckRefusal, refusals, fn).pipe(
    Effect.catchDefect((defect) => {
      if (defect instanceof HttpFailure) return Effect.die(defect);
      console.error("[pr-checks] unexpected route failure:", defect);
      return Effect.die(new HttpFailure(500, { error: "Pull request check request failed" }));
    }),
  );

const badGateway = (error: string) => new BadGateway({ error });

/** The audit metadata every settings write records. */
const settingsMetadata = (saved: Schema.Schema.Type<typeof PrCheckRepository>) => ({
  repo: saved.repo,
  enabled: saved.enabled,
  commentEnabled: saved.commentEnabled,
  costThreshold: saved.costThreshold,
});

const PrChecksHandlers = HttpApiBuilder.group(PrChecksApi, "prChecks", (handlers) =>
  handlers
    .handle("status", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const [repositories, installations] = yield* legacy(() =>
          Promise.all([
            listPrCheckRepositories(organizationId),
            listPrCheckInstallationAccess(organizationId),
          ]),
        );
        return yield* respond(PrCheckStatus)({
          appConfigured: isGithubAppConfigured(),
          installations,
          repositories,
        });
      }),
    )
    .handle("listRepositories", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const repositories = yield* legacy(() => listPrCheckRepositories(organizationId));
        return yield* respond(Schema.Array(PrCheckRepository))(repositories);
      }),
    )
    .handle("createRepository", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const saved = yield* prCheckCall({ 400: refuse[400], 409: refuse[409] }, () =>
          createPrCheckRepository(organizationId, payload, session.userId),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "pr_checks.create",
            entityType: "pr_check_repository",
            entityId: saved.id,
            metadata: settingsMetadata(saved),
          }),
        );
        return yield* respond(PrCheckRepository, { status: 201 })(saved);
      }),
    )
    .handle("getRepository", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const repo = yield* legacy(() => getPrCheckRepository(organizationId, params.id));
        if (!repo) return yield* notFound("Unknown repository");
        return yield* respond(PrCheckRepository)(repo);
      }),
    )
    .handle("updateRepository", ({ params, payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const saved = yield* prCheckCall(
          { 400: refuse[400], 404: refuse[404], 409: refuse[409] },
          () => updatePrCheckRepository(organizationId, params.id, payload),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "pr_checks.update",
            entityType: "pr_check_repository",
            entityId: saved.id,
            metadata: {
              ...settingsMetadata(saved),
              thresholdConclusion: saved.thresholdConclusion,
            },
          }),
        );
        return yield* respond(PrCheckRepository)(saved);
      }),
    )
    .handle("deleteRepository", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const existing = yield* legacy(async () => {
          const found = await getPrCheckRepository(organizationId, params.id);
          if (!found || !(await deletePrCheckRepository(organizationId, params.id))) return null;
          return found;
        });
        if (!existing) return yield* notFound("Unknown repository");
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "pr_checks.delete",
            entityType: "pr_check_repository",
            entityId: params.id,
            metadata: { repo: existing.repo },
          }),
        );
        return yield* respond(PrCheckDeleted)({ ok: true });
      }),
    )
    .handle("runs", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const runs = yield* legacy(() => listPrCheckRuns(organizationId, query));
        return yield* respond(Schema.Array(PrCheckRun))(runs);
      }),
    )
    .handle("preview", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const refusals = { 400: refuse[400], 404: refuse[404], 502: badGateway };
        if ("repositoryId" in payload) {
          const found = yield* prCheckCall(refusals, async () => {
            const repository = await getPrCheckRepository(organizationId, payload.repositoryId);
            if (!repository) return null;
            return {
              preview: await previewPullRequestCheck(
                organizationId,
                repository,
                payload.pullNumber,
              ),
            };
          });
          if (!found) return yield* notFound("Unknown repository");
          if (!found.preview) return yield* notFound("No such pull request");
          return yield* respond(PrCheckPreview)(found.preview);
        }
        const repoName = payload.repo?.trim() || null;
        if (repoName && !isRepoFullName(repoName)) {
          return yield* badRequest("repo must be owner/name");
        }
        const preview = yield* prCheckCall(refusals, async () => {
          const repository = repoName
            ? ((await listPrCheckRepositories(organizationId)).find(
                (r) => r.repo.toLowerCase() === repoName.toLowerCase(),
              ) ?? null)
            : null;
          return previewFilesCheck(organizationId, payload.files, repository, repoName);
        });
        return yield* respond(PrCheckPreview)(preview);
      }),
    ),
);

export const prChecksDomain = makeDomain("pr-checks", PrChecksApi, PrChecksHandlers);
