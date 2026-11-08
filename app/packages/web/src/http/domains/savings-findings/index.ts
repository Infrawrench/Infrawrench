/**
 * The savings findings workflow, the handlers. The logic lives in
 * `services/savings-findings.ts`, `services/savings-views.ts` and server-core's
 * `savings/findings.ts`; this is transport only. Every status change is
 * audited per finding (`savings_finding.status_changed`) and published as a
 * `savings.finding.status_changed` event.
 */
import { Effect, Layer, Schema } from "effect";
import { HttpServerResponse, type HttpServerRequest } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import {
  matchesSavingsFindingFilter,
  matchesSavingsFindingStatus,
  normalizeSavingsFindingStatusInput,
  normalizeSavingsViewInput,
  parseSavingsFindingsQuery,
  sortSavingsFindings,
  type SavingsFindingFilter,
  type SavingsFindingSort,
  type SavingsFindingStatusFilter,
} from "@infrawrench/client-core";
import { orgAppUrl } from "@infrawrench/server-core/app-url";
import { strictlyVisibleAccountIds } from "@infrawrench/server-core/cost/visibility-context";
import { setFindingStatus } from "@infrawrench/server-core/savings/findings";
import { logAudit } from "../../../services/audit";
import { listSavingsFindings } from "../../../services/savings-findings";
import {
  createSavingsView,
  deleteSavingsView,
  findSavingsView,
  getSavingsView,
  listSavingsViews,
  SavingsViewNameConflictError,
  updateSavingsView,
} from "../../../services/savings-views";
import { makeDomain } from "../../domain";
import { Conflict, notFound, badRequest } from "../../errors";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { readObjectBody } from "../../request-body";
import { holdsPermission, OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { ok } from "../../schemas/common";
import {
  SavingsFindingsApi,
  SavingsFindingsResponse,
  SavingsFindingStatusResult,
  SavingsView,
} from "./api";

/** Run a client-core normalizer; what it throws is the 400's sentence. */
const refusing = <A>(normalize: () => A) =>
  Effect.try({
    try: normalize,
    catch: (e) => badRequest(e instanceof Error ? e.message : String(e)),
  });

/**
 * The query as the route has always read it: a parameter at its first value,
 * and `tag` at every value it was sent with.
 */
function searchParams(request: HttpServerRequest.HttpServerRequest): URLSearchParams {
  return new URL(request.url, "http://localhost").searchParams;
}

const nameConflict = (error: unknown) =>
  error instanceof SavingsViewNameConflictError
    ? new Conflict({ error: error.message })
    : undefined;

/** The body as a view input, or the sentence the route has always refused it with. */
const readViewInput = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
  const read = yield* readObjectBody(request);
  if (!read.ok) return yield* badRequest(read.error);
  return yield* refusing(() => normalizeSavingsViewInput(read.body));
});

const SavingsFindingsHandlers = HttpApiBuilder.group(
  SavingsFindingsApi,
  "savingsFindings",
  (handlers) =>
    handlers
      /**
       * `view` applies a saved view (by id or name); explicit params override
       * its status and sort, and replace its filter field by field. With
       * neither, the status is `all` and the sort is savings, largest first.
       * `summary` always covers every finding the caller can see.
       */
      .handle("list", ({ request }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const params = searchParams(request);
          const query = yield* refusing(() =>
            parseSavingsFindingsQuery(
              (name) => params.get(name) ?? undefined,
              (name) => params.getAll(name),
            ),
          );

          let status: SavingsFindingStatusFilter = "all";
          let filter: SavingsFindingFilter = {};
          let sort: SavingsFindingSort = { field: "savings", direction: "desc" };
          if (query.viewId) {
            const viewId = query.viewId;
            const view = yield* legacy(() => findSavingsView(organizationId, viewId));
            if (!view) return yield* notFound(`No savings view "${viewId}"`);
            status = view.status;
            filter = view.filter;
            sort = view.sort;
          }
          if (query.status) status = query.status;
          if (query.sort) sort = query.sort;
          filter = { ...filter, ...query.filter };

          const canReadCosts = yield* holdsPermission("costs:read");
          const refresh = params.get("refresh") === "true";
          const response = yield* legacy(() =>
            listSavingsFindings(organizationId, { canReadCosts, refresh }),
          );
          return yield* respond(SavingsFindingsResponse)({
            ...response,
            findings: sortSavingsFindings(
              response.findings.filter(
                (f) =>
                  matchesSavingsFindingStatus(f, status) && matchesSavingsFindingFilter(f, filter),
              ),
              sort,
            ),
          });
        }),
      )
      /**
       * `{keys, status, note?}`: move up to 500 findings at once. Completed by
       * hand records `resolution: "manual"`. Keys the caller cannot see come
       * back in `missing`; when none matched it is a 404.
       */
      .handleRaw("setStatus", ({ request }) =>
        Effect.gen(function* () {
          const read = yield* readObjectBody(request);
          if (!read.ok) return yield* badRequest(read.error);
          const input = yield* refusing(() => normalizeSavingsFindingStatusInput(read.body));

          const { organizationId, session } = yield* OrgPrincipal;
          // `strictlyVisibleAccountIds` reads the caller's cost visibility,
          // so it runs inside the request's scopes, with the store call.
          const result = yield* legacy(() =>
            setFindingStatus(
              organizationId,
              { keys: input.keys, status: input.status, note: input.note ?? null },
              { userId: session.userId ?? null },
              strictlyVisibleAccountIds(organizationId),
              { url: orgAppUrl(organizationId, "costs") },
            ),
          );
          if (result.updated.length === 0) {
            // The documented 404, with the keys beside the sentence as it always had.
            return HttpServerResponse.jsonUnsafe(
              { error: "No such savings finding", missing: result.missing },
              { status: 404 },
            );
          }
          for (const change of result.updated) {
            const finding = result.findings.get(change.key);
            yield* fireAndForget(() =>
              logAudit({
                organizationId,
                userId: session.userId,
                action: "savings_finding.status_changed",
                entityType: "savings_finding",
                entityId: change.key,
                metadata: {
                  from: result.previous.get(change.key) ?? null,
                  to: change.status,
                  note: change.statusNote,
                  title: finding?.title ?? null,
                  ...(result.updated.length > 1 ? { bulk: true } : {}),
                },
              }),
            );
          }
          return yield* respond(SavingsFindingStatusResult)({
            updated: result.updated,
            missing: result.missing,
          });
        }),
      ),
);

const SavingsViewsHandlers = HttpApiBuilder.group(SavingsFindingsApi, "savingsViews", (handlers) =>
  handlers
    /** The views the caller can see, alphabetically. */
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const views = yield* legacy(() => listSavingsViews(organizationId));
        return yield* respond(Schema.Array(SavingsView))(views);
      }),
    )
    /** Create; the creator owns it. */
    .handleRaw("create", ({ request }) =>
      Effect.gen(function* () {
        const input = yield* readViewInput(request);
        const { organizationId, session } = yield* OrgPrincipal;
        const created = yield* legacyTry(
          () => createSavingsView(organizationId, input, session.userId ?? null),
          nameConflict,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "savings_view.create",
            entityType: "savings_view",
            entityId: created.id,
            metadata: { name: created.name },
          }),
        );
        return yield* respond(SavingsView)(created);
      }),
    )
    .handle("get", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const view = yield* legacy(() => getSavingsView(organizationId, params.id));
        if (!view) return yield* notFound();
        return yield* respond(SavingsView)(view);
      }),
    )
    /** Full replace; editor on the view. */
    .handleRaw("update", ({ params, request }) =>
      Effect.gen(function* () {
        const input = yield* readViewInput(request);
        const { organizationId, session } = yield* OrgPrincipal;
        const updated = yield* legacyTry(
          () => updateSavingsView(organizationId, params.id, input),
          nameConflict,
        );
        if (!updated) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "savings_view.update",
            entityType: "savings_view",
            entityId: updated.id,
            metadata: { name: updated.name },
          }),
        );
        return yield* respond(SavingsView)(updated);
      }),
    )
    /** Soft delete; owner, or editor when nobody owns it. */
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const id = params.id;
        const deleted = yield* legacy(() => deleteSavingsView(organizationId, id));
        if (!deleted) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "savings_view.delete",
            entityType: "savings_view",
            entityId: id,
            metadata: {},
          }),
        );
        return ok;
      }),
    ),
);

export const savingsFindingsDomain = makeDomain(
  "savings-findings",
  SavingsFindingsApi,
  Layer.mergeAll(SavingsFindingsHandlers, SavingsViewsHandlers),
);
