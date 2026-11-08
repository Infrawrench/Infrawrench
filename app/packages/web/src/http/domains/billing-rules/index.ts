/**
 * Billing rules: `/api/org/:orgId/billing-rules`, the handlers. The logic
 * lives in server-core's `cost/billing-rules` and `cost/pricing-preview`, run
 * through `legacy` inside the request's scopes.
 *
 * Every mutation is audit-logged. A markup nobody can trace back to a person
 * and a date is the failure mode this feature would otherwise introduce.
 */
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { COST_SCOPE_RESTRICTED_CODE } from "@infrawrench/client-core";
import {
  BillingRuleError,
  BillingRuleNameConflictError,
  createBillingRule,
  deleteBillingRule,
  getBillingRule,
  listBillingRules,
  reorderBillingRules,
  updateBillingRule,
} from "@infrawrench/server-core/cost/billing-rules";
import { previewPricing } from "@infrawrench/server-core/cost/pricing-preview";
import {
  BadRequest,
  BillingRule,
  BillingRulesApi,
  Conflict,
  notFound,
  ok,
  PricingPreviewResult,
} from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { HttpFailure } from "../../errors";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { isCostScoped, OrgPrincipal, requirePermission } from "../../principal";
import { respond } from "../../response";

/** A write, its refusals mapped as the Hono route's `writeError` did. */
const billingRuleWrite = <A>(fn: () => PromiseLike<A>) =>
  legacyTry(fn, (error) => {
    if (error instanceof BillingRuleNameConflictError)
      return new Conflict({ error: error.message });
    if (error instanceof BillingRuleError) return new BadRequest({ error: error.message });
    return undefined;
  });

const BillingRulesHandlers = HttpApiBuilder.group(BillingRulesApi, "billingRules", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const rules = yield* legacy(() => listBillingRules(organizationId));
        return yield* respond(Schema.Array(BillingRule))(rules);
      }),
    )
    /**
     * Price one month with a candidate rule or candidate customer settings
     * swapped in, and say what changed. A POST because the candidate is a
     * body, not because anything is written: nothing is. Naming a customer
     * also needs `invoices:read`, since the answer is that customer's priced
     * spend.
     */
    .handle("preview", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        if (payload.managedAccountId) {
          yield* requirePermission("invoices:read");
          // A customer preview is that customer's invoice, and `/invoices` and
          // `/managed-accounts` are refused outright for scoped cost access
          // (COST_SCOPE_DENY_RULES). The org-wide preview stays open: its cost
          // reads are narrowed to the caller's slice like any other.
          if (yield* isCostScoped) {
            return yield* Effect.die(
              new HttpFailure(403, {
                error:
                  "Previewing a managed account's pricing uses the whole organization's spend and is not available with scoped cost access.",
                code: COST_SCOPE_RESTRICTED_CODE,
              }),
            );
          }
        }
        const preview = yield* billingRuleWrite(() => previewPricing(organizationId, payload));
        return yield* respond(PricingPreviewResult)(preview);
      }),
    )
    /**
     * Put every rule in a new evaluation order. One audited act, rather than
     * one PUT per rule whose intermediate states would each be a different,
     * unintended order.
     */
    .handle("reorder", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const rules = yield* billingRuleWrite(() =>
          reorderBillingRules(organizationId, payload.ids),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "billing_rule.reorder",
            entityType: "billing_rule",
            entityId: "order",
            metadata: {
              order: rules.map((r) => ({ id: r.id, name: r.name, priority: r.priority })),
            },
          }),
        );
        return yield* respond(Schema.Array(BillingRule))(rules);
      }),
    )
    .handle("get", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const rule = yield* legacy(() => getBillingRule(organizationId, params.id));
        if (!rule) return yield* notFound();
        return yield* respond(BillingRule)(rule);
      }),
    )
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const rule = yield* billingRuleWrite(() =>
          createBillingRule(organizationId, payload, session.userId),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "billing_rule.create",
            entityType: "billing_rule",
            entityId: rule.id,
            metadata: {
              name: rule.name,
              match: rule.match,
              adjustment: rule.adjustment,
              managedAccountIds: rule.managedAccountIds,
            },
          }),
        );
        return yield* respond(BillingRule)(rule);
      }),
    )
    /**
     * A full replace, including `enabled`: switching a markup off for a
     * quarter is an edit of the rule, not a separate verb, so there is one
     * audited action for "this rule changed" rather than two that a reader
     * has to correlate.
     */
    .handle("update", ({ params, payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const rule = yield* billingRuleWrite(() =>
          updateBillingRule(organizationId, params.id, payload),
        );
        if (!rule) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "billing_rule.update",
            entityType: "billing_rule",
            entityId: rule.id,
            metadata: {
              name: rule.name,
              enabled: rule.enabled,
              match: rule.match,
              adjustment: rule.adjustment,
              managedAccountIds: rule.managedAccountIds,
            },
          }),
        );
        return yield* respond(BillingRule)(rule);
      }),
    )
    /**
     * Nothing cascades and nothing is restated: no adjustment was ever
     * written into `cost_daily`, so deleting a rule simply means the next
     * read computes without it. A budget measuring adjusted spend keeps
     * working with one fewer rule.
     */
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const deleted = yield* legacy(() => deleteBillingRule(organizationId, params.id));
        if (!deleted) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "billing_rule.delete",
            entityType: "billing_rule",
            entityId: params.id,
          }),
        );
        return ok;
      }),
    ),
);

export const billingRulesDomain = makeDomain(
  "billing-rules",
  BillingRulesApi,
  BillingRulesHandlers,
);
