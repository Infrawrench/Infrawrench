/**
 * Saved cost filters: `/api/org/:orgId/saved-cost-filters`, the handlers.
 *
 * The logic lives in services/saved-cost-filters.ts so the MCP/chat tools
 * drive exactly the same code path; these handlers are transport only. The
 * write path's refusals keep the answers they always had: a name collision
 * is a 409, a query that does not parse a 400 carrying the offset (the same
 * shape `POST /costs/query` sends, so a client can underline the mistake),
 * and any other error the service throws a 400 with its message.
 */
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { CostQueryParseError } from "@infrawrench/client-core";
import {
  BadRequest,
  notFound,
  ok,
  SavedCostFilter,
  SavedCostFilterNameTaken,
  SavedCostFilterReferents,
  SavedCostFiltersApi,
} from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import {
  SavedCostFilterInUseError,
  SavedCostFilterNameConflictError,
  createSavedCostFilter,
  getSavedCostFilter,
  listSavedCostFilterReferents,
  listSavedCostFilters,
  softDeleteSavedCostFilter,
  updateSavedCostFilter,
} from "../../../services/saved-cost-filters";
import { makeDomain } from "../../domain";
import { HttpFailure } from "../../errors";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

/** A write, its refusals mapped as the Hono route's `writeError` did. */
const savedFilterWrite = <A>(fn: () => Promise<A>) =>
  legacyTry(
    async () => {
      try {
        return await fn();
      } catch (error) {
        // The extra `queryError` rides an already-shaped response.
        if (error instanceof CostQueryParseError) {
          throw new HttpFailure(400, {
            error: `Invalid query at offset ${error.offset}: ${error.message}`,
            queryError: {
              offset: error.offset,
              length: error.length,
              expected: [...error.expected],
            },
          });
        }
        throw error;
      }
    },
    (error) => {
      if (error instanceof SavedCostFilterNameConflictError) {
        return new SavedCostFilterNameTaken({ error: error.message });
      }
      if (error instanceof HttpFailure) return undefined;
      // The input rules (filters XOR query, non-empty, tag keys) throw plain errors.
      if (error instanceof Error) return new BadRequest({ error: error.message });
      return undefined;
    },
  );

const SavedCostFiltersHandlers = HttpApiBuilder.group(
  SavedCostFiltersApi,
  "savedCostFilters",
  (handlers) =>
    handlers
      .handle("list", () =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const filters = yield* legacy(() => listSavedCostFilters(organizationId));
          return yield* respond(Schema.Array(SavedCostFilter))(filters);
        }),
      )
      .handle("create", ({ payload }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const created = yield* savedFilterWrite(() =>
            createSavedCostFilter(organizationId, payload, session.userId ?? null),
          );
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "saved_cost_filter.create",
              entityType: "saved_cost_filter",
              entityId: created.id,
              metadata: { name: created.name, query: created.query },
            }),
          );
          return yield* respond(SavedCostFilter)(created);
        }),
      )
      .handle("get", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const filter = yield* legacy(() => getSavedCostFilter(organizationId, params.id));
          if (!filter) return yield* notFound();
          return yield* respond(SavedCostFilter)(filter);
        }),
      )
      /**
       * The high-leverage write: every graph, report and budget referencing
       * the filter runs the new terms on its next query. The audit entry
       * records the new query text for that reason: "who re-scoped every prod
       * budget" must be answerable.
       */
      .handle("update", ({ params, payload }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const updated = yield* savedFilterWrite(() =>
            updateSavedCostFilter(organizationId, params.id, payload),
          );
          if (!updated) return yield* notFound();
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "saved_cost_filter.update",
              entityType: "saved_cost_filter",
              entityId: updated.id,
              metadata: { name: updated.name, query: updated.query },
            }),
          );
          return yield* respond(SavedCostFilter)(updated);
        }),
      )
      /**
       * Refused with a 409 while any budget, report or dashboard graph
       * references the filter; the body lists the referents so the client
       * can name them. Deleting a referenced filter would silently widen
       * every referent to all spend, so detachment is deliberate.
       */
      .handle("delete", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const deleted = yield* legacy(async () => {
            try {
              return await softDeleteSavedCostFilter(organizationId, params.id);
            } catch (error) {
              if (error instanceof SavedCostFilterInUseError) {
                throw new HttpFailure(409, { error: error.message, referents: error.referents });
              }
              throw error;
            }
          });
          if (!deleted) return yield* notFound();
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "saved_cost_filter.delete",
              entityType: "saved_cost_filter",
              entityId: params.id,
              metadata: {},
            }),
          );
          return ok;
        }),
      )
      .handle("referents", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const filter = yield* legacy(() => getSavedCostFilter(organizationId, params.id));
          if (!filter) return yield* notFound();
          const referents = yield* legacy(() =>
            listSavedCostFilterReferents(organizationId, params.id),
          );
          return yield* respond(SavedCostFilterReferents)({ referents });
        }),
      ),
);

export const savedFiltersDomain = makeDomain(
  "saved-filters",
  SavedCostFiltersApi,
  SavedCostFiltersHandlers,
);
