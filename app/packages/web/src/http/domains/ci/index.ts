/**
 * `/api/org/:orgId/ci`: CI on the organization's GitHub repositories. The
 * logic lives in `server-core/src/ci/`; these handlers gate on the
 * organization's `ci` feature, map its errors and audit the decisions.
 */
import { Effect, Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import {
  CiAccessOverviewSchema,
  CiAccountSchema,
  CiApi,
  CiConnectionAccessSchema,
  CiResourceGrantSchema,
  CiResourceOutputsSchema,
  CiSshKeyLendingSchema,
  CiCacheClearedSchema,
  CiCachesSchema,
  CiDownloadLinkSchema,
  CiRunDetailSchema,
  CiRunSchema,
  CiSchedulesSchema,
  CiStatusSchema,
  CiUsageSchema,
  CiValuesSchema,
  badRequest,
  notFound,
  Ok,
} from "@infrawrench/api-contract";
import { CI_RUN_STATUSES } from "@infrawrench/client-core";
import { ciStatus, setCiAccount } from "@infrawrench/server-core/ci/accounts";
import {
  ciAccessOverview,
  createGrant,
  deleteGrant,
  preflightConnection,
  resourceOutputs,
  revokeSshKeyLending,
  setConnectionAccess,
  setSshKeyLending,
  updateGrant,
} from "@infrawrench/server-core/ci/access";
import { ciUsage } from "@infrawrench/server-core/ci/billing";
import { clearCiCache, listCiCaches } from "@infrawrench/server-core/ci/caches";
import {
  approveRun,
  CiInputError,
  dispatchRun,
  getDownloadLink,
  getRun,
  listRuns,
  openRunLogs,
  cancelRun,
  rejectRun,
  retryRun,
} from "@infrawrench/server-core/ci/runs";
import { listCiSchedules } from "@infrawrench/server-core/ci/schedules";
import { deleteCiValue, listCiValues, setCiValue } from "@infrawrench/server-core/ci/values";
import { orgHasFeature } from "@infrawrench/server-core/features";
import { keepAlive } from "@infrawrench/server-core/runtime/request-scope";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { inputRefusal } from "../../refusals";
import { respond } from "../../response";

const refusal = (error: unknown) =>
  error instanceof CiInputError ? inputRefusal(error) : undefined;

/** Everything but the status is a 404 until CI is turned on for the org. */
const requireCi = Effect.gen(function* () {
  const principal = yield* OrgPrincipal;
  const enabled = yield* legacy(() => orgHasFeature(principal.organizationId, "ci"));
  if (!enabled) return yield* notFound("CI is not turned on for this organization.");
  return principal;
});

/** A grant as the audit log records it: what was granted, never a value. */
const grantAudit = (grant: {
  ciName: string;
  resourceId: string;
  resourceName: string;
  outputs: readonly string[];
  secretVersion: string | null;
  repos: readonly string[] | null;
  branchPattern: string | null;
}) => ({
  ciName: grant.ciName,
  resourceId: grant.resourceId,
  resourceName: grant.resourceName,
  outputs: grant.outputs,
  secretVersion: grant.secretVersion,
  repos: grant.repos,
  branchPattern: grant.branchPattern,
});

/** A values scope as sent: an installation id, and a repository or none. */
const valueScope = (query: { installationId: string; repo?: string }) =>
  Effect.gen(function* () {
    const installationId = Number(query.installationId);
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      return yield* badRequest("installationId must be a GitHub App installation id");
    }
    return { installationId, repo: query.repo ? query.repo : null };
  });

/**
 * A running run's live log as a response body, relayed from the CI proxy.
 * The stream outlives the handler, which returns at once, so it is tied to
 * its reader rather than to an Effect scope: the client going away cancels
 * the body, which aborts the proxy's stream and with it the runner's
 * follower. The proxy going away ends it; the client then re-reads the run.
 */
async function relayRunLogs(
  organizationId: string,
  runId: string,
): Promise<ReadableStream<Uint8Array>> {
  const abort = new AbortController();
  const upstream = await openRunLogs(organizationId, runId, abort.signal);
  const reader = upstream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch {
        controller.close();
      }
    },
    cancel() {
      abort.abort();
      return reader.cancel().catch(() => {});
    },
  });
}

const CiHandlers = HttpApiBuilder.group(CiApi, "ci", (handlers) =>
  handlers
    .handle("status", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const status = yield* legacy(() => ciStatus(organizationId));
        return yield* respond(CiStatusSchema)(status);
      }),
    )
    .handle("setAccount", ({ params, payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* requireCi;
        const account = yield* legacyTry(
          () =>
            setCiAccount(
              organizationId,
              params.installationId,
              payload.enabled,
              session.userId ?? "",
            ),
          refusal,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: payload.enabled ? "ci.account.enable" : "ci.account.disable",
            entityType: "ci_account",
            entityId: String(params.installationId),
            metadata: { accountLogin: account.accountLogin },
          }),
        );
        return yield* respond(CiAccountSchema)(account);
      }),
    )
    .handle("listRuns", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* requireCi;
        // Read as sent: a limit that is not a number is the default, and a
        // status that is not one lists every run.
        const asked = Number(query.limit);
        const limit = Number.isInteger(asked) ? Math.min(Math.max(asked, 1), 200) : 50;
        const status = CI_RUN_STATUSES.find((s) => s === query.status);
        const runs = yield* legacy(() =>
          listRuns(organizationId, { limit, ...(status ? { status } : {}) }),
        );
        return yield* respond(Schema.Struct({ runs: Schema.Array(CiRunSchema) }))({ runs });
      }),
    )
    .handle("getRun", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* requireCi;
        const detail = yield* legacyTry(() => getRun(organizationId, params.runId), refusal);
        return yield* respond(CiRunDetailSchema)(detail);
      }),
    )
    .handle("downloadLink", ({ params, query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* requireCi;
        const link = yield* legacyTry(
          () => getDownloadLink(organizationId, params.runId, query.job, query.path),
          refusal,
        );
        return yield* respond(CiDownloadLinkSchema)(link);
      }),
    )
    .handle("runLogs", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* requireCi;
        const body = yield* legacyTry(() => relayRunLogs(organizationId, params.runId), refusal);
        return HttpServerResponse.raw(
          new Response(body, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          }),
        );
      }),
    )
    .handle("approveRun", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* requireCi;
        yield* legacyTry(
          () => approveRun(organizationId, params.runId, session.userId ?? ""),
          refusal,
        );
        // `keepAlive`: on the edge the dispatch outlives the response.
        yield* fireAndForget(() => keepAlive(dispatchRun(params.runId)));
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "ci.run.approve",
            entityType: "ci_run",
            entityId: params.runId,
          }),
        );
        return yield* respond(Ok)({ ok: true });
      }),
    )
    .handle("rejectRun", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* requireCi;
        yield* legacyTry(
          () => rejectRun(organizationId, params.runId, session.userId ?? ""),
          refusal,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "ci.run.reject",
            entityType: "ci_run",
            entityId: params.runId,
          }),
        );
        return yield* respond(Ok)({ ok: true });
      }),
    )
    .handle("retryRun", ({ params, payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* requireCi;
        const noTaskCache = payload.noTaskCache === true;
        const run = yield* legacyTry(
          () => retryRun(organizationId, params.runId, session.userId ?? "", { noTaskCache }),
          refusal,
        );
        // `keepAlive`: on the edge the dispatch outlives the response.
        yield* fireAndForget(() => keepAlive(dispatchRun(run.id)));
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "ci.run.retry",
            entityType: "ci_run",
            entityId: run.id,
            metadata: { retryOf: params.runId, repo: run.repoFullName, noTaskCache },
          }),
        );
        return yield* respond(CiRunSchema)(run);
      }),
    )
    .handle("cancelRun", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* requireCi;
        const run = yield* legacyTry(() => cancelRun(organizationId, params.runId), refusal);
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "ci.run.cancel",
            entityType: "ci_run",
            entityId: params.runId,
            metadata: { repo: run.repoFullName, status: run.status },
          }),
        );
        return yield* respond(CiRunSchema)(run);
      }),
    )
    .handle("listCaches", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* requireCi;
        const caches = yield* legacy(() => listCiCaches(organizationId));
        return yield* respond(CiCachesSchema)(caches);
      }),
    )
    .handle("listSchedules", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* requireCi;
        const schedules = yield* legacy(() => listCiSchedules(organizationId));
        return yield* respond(CiSchedulesSchema)(schedules);
      }),
    )
    .handle("clearCache", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* requireCi;
        const cleared = yield* legacyTry(
          () => clearCiCache(organizationId, params.installationId, params.repo),
          refusal,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "ci.cache.clear",
            entityType: "ci_cache",
            entityId: `${params.installationId}/${cleared.repo}`,
            metadata: {
              installationId: params.installationId,
              repo: cleared.repo,
              deletedEntries: cleared.deletedEntries,
              deletedBytes: cleared.deletedBytes,
            },
          }),
        );
        return yield* respond(CiCacheClearedSchema)(cleared);
      }),
    )
    .handle("listValues", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* requireCi;
        const scope = yield* valueScope(query);
        const values = yield* legacyTry(
          () => listCiValues(organizationId, scope.installationId, scope.repo),
          refusal,
        );
        return yield* respond(CiValuesSchema)(values);
      }),
    )
    .handle("setValue", ({ params, query, payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* requireCi;
        const scope = yield* valueScope(query);
        yield* legacyTry(
          () =>
            setCiValue(
              organizationId,
              scope.installationId,
              scope.repo,
              params.kind,
              params.name,
              payload.value,
            ),
          refusal,
        );
        // The name and scope only: a secret's value never reaches the log.
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: params.kind === "secrets" ? "ci.secret.set" : "ci.variable.set",
            entityType: "ci_value",
            entityId: params.name,
            metadata: { installationId: scope.installationId, repo: scope.repo },
          }),
        );
        return yield* respond(Ok)({ ok: true });
      }),
    )
    .handle("deleteValue", ({ params, query }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* requireCi;
        const scope = yield* valueScope(query);
        yield* legacyTry(
          () =>
            deleteCiValue(
              organizationId,
              scope.installationId,
              scope.repo,
              params.kind,
              params.name,
            ),
          refusal,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: params.kind === "secrets" ? "ci.secret.delete" : "ci.variable.delete",
            entityType: "ci_value",
            entityId: params.name,
            metadata: { installationId: scope.installationId, repo: scope.repo },
          }),
        );
        return yield* respond(Ok)({ ok: true });
      }),
    )
    .handle("access", () =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* requireCi;
        const overview = yield* legacy(() =>
          ciAccessOverview(organizationId, session.userId ?? null),
        );
        return yield* respond(CiAccessOverviewSchema)(overview);
      }),
    )
    .handle("setConnectionAccess", ({ params, payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* requireCi;
        const access = yield* legacyTry(
          () =>
            setConnectionAccess(
              organizationId,
              params.accountId,
              {
                ...payload,
                jobKinds: [...payload.jobKinds],
                jobRepos: payload.jobRepos ? [...payload.jobRepos] : null,
                lendRepos: payload.lendRepos ? [...payload.lendRepos] : null,
              },
              session.userId ?? null,
            ),
          refusal,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "ci.access.update",
            entityType: "account",
            entityId: params.accountId,
            metadata: { accountName: access.accountName, ...access.settings },
          }),
        );
        return yield* respond(CiConnectionAccessSchema)(access);
      }),
    )
    .handle("preflightConnection", ({ params, payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* requireCi;
        // One `legacy` call around the plugin call, so the egress scope covers it.
        const access = yield* legacyTry(
          () => preflightConnection(organizationId, params.accountId, payload.kind, payload.region),
          refusal,
        );
        const record = access.preflight[payload.kind];
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "ci.access.preflight",
            entityType: "account",
            entityId: params.accountId,
            metadata: {
              kind: payload.kind,
              ok: record?.ok ?? false,
              missing: record?.missing.map((m) => m.permission) ?? [],
            },
          }),
        );
        return yield* respond(CiConnectionAccessSchema)(access);
      }),
    )
    .handle("resourceOutputs", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* requireCi;
        if (!query.resourceId) return yield* badRequest("resourceId is required");
        const outputs = yield* legacyTry(
          () => resourceOutputs(organizationId, query.resourceId),
          refusal,
        );
        return yield* respond(CiResourceOutputsSchema)(outputs);
      }),
    )
    .handle("createGrant", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* requireCi;
        const grant = yield* legacyTry(
          () =>
            createGrant(
              organizationId,
              {
                ...payload,
                outputs: [...payload.outputs],
                repos: payload.repos ? [...payload.repos] : null,
              },
              session.userId ?? null,
            ),
          refusal,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "ci.grant.create",
            entityType: "ci_resource_grant",
            entityId: grant.id,
            metadata: grantAudit(grant),
          }),
        );
        return yield* respond(CiResourceGrantSchema)(grant);
      }),
    )
    .handle("updateGrant", ({ params, payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* requireCi;
        const grant = yield* legacyTry(
          () =>
            updateGrant(
              organizationId,
              params.grantId,
              {
                ...payload,
                outputs: [...payload.outputs],
                repos: payload.repos ? [...payload.repos] : null,
              },
              session.userId ?? null,
            ),
          refusal,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "ci.grant.update",
            entityType: "ci_resource_grant",
            entityId: grant.id,
            metadata: grantAudit(grant),
          }),
        );
        return yield* respond(CiResourceGrantSchema)(grant);
      }),
    )
    .handle("deleteGrant", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* requireCi;
        const grant = yield* legacyTry(() => deleteGrant(organizationId, params.grantId), refusal);
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "ci.grant.delete",
            entityType: "ci_resource_grant",
            entityId: grant.id,
            metadata: grantAudit(grant),
          }),
        );
        return yield* respond(Ok)({ ok: true });
      }),
    )
    .handle("setSshKeyLending", ({ params, payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* requireCi;
        if (!session.userId) return yield* notFound("Only a person can lend their SSH key.");
        const userId = session.userId;
        const lending = yield* legacyTry(
          () =>
            setSshKeyLending(organizationId, userId, params.sshKeyId, {
              enabled: payload.enabled,
              ciName: payload.ciName,
              repos: payload.repos ? [...payload.repos] : null,
              branchPattern: payload.branchPattern,
            }),
          refusal,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId,
            action: payload.enabled ? "ci.ssh_key.lend" : "ci.ssh_key.unlend",
            entityType: "ssh_key",
            entityId: params.sshKeyId,
            metadata: lending
              ? {
                  ciName: lending.ciName,
                  repos: lending.repos,
                  branchPattern: lending.branchPattern,
                }
              : {},
          }),
        );
        return yield* respond(Schema.Struct({ lending: Schema.NullOr(CiSshKeyLendingSchema) }))({
          lending,
        });
      }),
    )
    .handle("revokeSshKeyLending", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* requireCi;
        const revoked = yield* legacyTry(
          () => revokeSshKeyLending(organizationId, params.sshKeyId),
          refusal,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "ci.ssh_key.revoke",
            entityType: "ssh_key",
            entityId: params.sshKeyId,
            metadata: { ciName: revoked?.ciName, ownerUserId: revoked?.ownerUserId },
          }),
        );
        return yield* respond(Ok)({ ok: true });
      }),
    )
    .handle("usage", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* requireCi;
        const usage = yield* legacy(() => ciUsage(organizationId, query.month));
        return yield* respond(CiUsageSchema)(usage);
      }),
    ),
);

export const ciDomain = makeDomain("ci", CiApi, CiHandlers);
