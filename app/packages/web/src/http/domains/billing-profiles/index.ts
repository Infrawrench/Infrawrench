/**
 * Billing profiles: `/api/org/:orgId/billing-profiles`, the handlers.
 *
 * Every write is audit-logged field by field, with account numbers masked to
 * their last four characters and the logo reduced to whether there is one:
 * the audit log is read by more people than the invoice is.
 */
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { billingProfileAuditChanges } from "@infrawrench/client-core";
import {
  BillingProfileError,
  BillingProfileInUseError,
  BillingProfileNameConflictError,
  createBillingProfile,
  deleteBillingProfile,
  getBillingProfile,
  listBillingProfiles,
  updateBillingProfile,
} from "@infrawrench/server-core/cost/billing-profiles";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { BadRequest, Conflict, HttpFailure, notFound } from "../../errors";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { ok } from "../../schemas/common";
import { BillingProfile, BillingProfilesApi } from "./api";

/**
 * The service's write refusals, as the route always answered them. A profile
 * in use rides an already-shaped 409 naming the customers on it.
 */
const writeCall = <A>(fn: () => PromiseLike<A>) =>
  legacyTry(
    async () => {
      try {
        return await fn();
      } catch (error) {
        if (error instanceof BillingProfileInUseError) {
          throw new HttpFailure(409, { error: error.message, customers: error.customers });
        }
        throw error;
      }
    },
    (error) => {
      if (error instanceof BillingProfileNameConflictError) {
        return new Conflict({ error: error.message });
      }
      if (error instanceof BillingProfileError) return new BadRequest({ error: error.message });
      return undefined;
    },
  );

const BillingProfilesHandlers = HttpApiBuilder.group(
  BillingProfilesApi,
  "billingProfiles",
  (handlers) =>
    handlers
      .handle("list", () =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const profiles = yield* legacy(() => listBillingProfiles(organizationId));
          return yield* respond(Schema.Array(BillingProfile))(profiles);
        }),
      )
      .handle("get", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const profile = yield* legacy(() => getBillingProfile(organizationId, params.id));
          if (!profile) return yield* notFound();
          return yield* respond(BillingProfile)(profile);
        }),
      )
      .handle("create", ({ payload }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const profile = yield* writeCall(() =>
            createBillingProfile(organizationId, payload, session.userId),
          );
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "billing_profile.create",
              entityType: "billing_profile",
              entityId: profile.id,
              metadata: { name: profile.name, changes: billingProfileAuditChanges(null, profile) },
            }),
          );
          return yield* respond(BillingProfile)(profile);
        }),
      )
      /** A full replace, except the logo, which is left as saved when absent and removed by null. */
      .handle("update", ({ params, payload }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const result = yield* writeCall(() =>
            updateBillingProfile(organizationId, params.id, payload),
          );
          if (!result) return yield* notFound();
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "billing_profile.update",
              entityType: "billing_profile",
              entityId: result.after.id,
              metadata: {
                name: result.after.name,
                changes: billingProfileAuditChanges(result.before, result.after),
                // Who the change reaches: their drafts follow it, their issued invoices do not.
                managedAccountIds: result.after.managedAccountIds,
              },
            }),
          );
          return yield* respond(BillingProfile)(result.after);
        }),
      )
      /** Refused while customers use it. */
      .handle("delete", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const deleted = yield* writeCall(() => deleteBillingProfile(organizationId, params.id));
          if (!deleted) return yield* notFound();
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "billing_profile.delete",
              entityType: "billing_profile",
              entityId: deleted.id,
              metadata: { name: deleted.name },
            }),
          );
          return ok;
        }),
      ),
);

export const billingProfilesDomain = makeDomain(
  "billing-profiles",
  BillingProfilesApi,
  BillingProfilesHandlers,
);
