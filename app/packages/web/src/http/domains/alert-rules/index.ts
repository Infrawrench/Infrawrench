/**
 * Alert routing rules and the delivery queue, the handlers.
 */
import { Effect, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { eq } from "drizzle-orm";
import {
  ALERT_RULE_LIMITS,
  isAlertTrigger,
  validateAlertRule,
  type AlertCondition,
  type AlertDestination,
  type AlertRule,
  type AlertRulesResponse as AlertRulesPayload,
  type EscalationPolicy,
  type QuietHours,
} from "@infrawrench/client-core";
import {
  listAlertRules,
  replaceAlertRules,
  resolveRoutingRules,
  type SaveAlertRuleInput,
} from "@infrawrench/server-core/alerts/rules";
import {
  canonicalDestination,
  destinationShapeError,
  foreignDestinationError,
  loadDestinationCatalog,
  loadOwnedDestinations,
} from "@infrawrench/server-core/alerts/destinations";
import {
  acknowledgeAlert,
  cancelAlertDeliveries,
  listAlertDeliveries,
} from "@infrawrench/server-core/alerts/ack";
import {
  AcknowledgeResult,
  AdoptDefaultsResult,
  AlertDeliveries,
  AlertRuleList,
  AlertRulesApi,
  AlertRulesResponse,
  badRequest,
  CancelResult,
  notFound,
  Unauthorized,
} from "@infrawrench/api-contract";
import { db } from "../../../db/client";
import { accounts } from "../../../db/schema";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { fieldsOf, readJson } from "../../request-body";
import { legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

/** A rule as it arrives, once {@link structuralError} has passed it. */
interface RuleBody {
  id?: string;
  name: string;
  enabled?: boolean;
  conditions?: AlertCondition[];
  destinations?: AlertDestination[];
  continueOnMatch?: boolean;
  quietHours?: QuietHours | null;
  escalation?: EscalationPolicy | null;
}

const CONDITION_FIELDS = new Set([
  "trigger",
  "severity",
  "accountId",
  "pluginId",
  "resourceTypeId",
  "amountCents",
  "key",
  "text",
]);

/** `value?.[key]` on anything: undefined when `value` is not an object holding `key`. */
const propOf = (value: unknown, key: string): unknown =>
  Predicate.hasProperty(value, key) ? value[key] : undefined;

/** A string read out of a stored payload, `""` when it has none. */
const payloadText = (payload: unknown, key: string): string => {
  const value = propOf(payload, key);
  return Predicate.isString(value) ? value : "";
};

/**
 * An object handed to {@link destinationShapeError}, which checks the kind
 * and each kind's identifier itself: the predicate claims only what that
 * check then proves.
 */
const isDestinationObject = (dest: unknown): dest is AlertDestination => Predicate.isObject(dest);

/** `destinationShapeError` over a value that may not even be an object. */
function destinationError(dest: unknown, what: string): string | null {
  if (!isDestinationObject(dest)) return `Unknown ${what} "?"`;
  return destinationShapeError(dest, what);
}

/**
 * Structural check before the semantic one.
 *
 * `validateAlertRule` (shared with the editor) enforces limits and coherence,
 * but it trusts the discriminants and the field types: it is written against
 * typed input, and this body is `unknown` JSON. So both halves are checked
 * here:
 *
 *   * **Tags.** A condition with a bogus `field` would fall through every
 *     `case` in `conditionMatches` and silently never match, which reads to
 *     the user as "the rule I saved does nothing".
 *   * **Shapes.** `{ conditions: [{ field: "trigger" }] }` would throw inside
 *     `values.filter`, and a numeric `name` would throw inside `.trim()`: a
 *     500 where the honest answer is a 400 naming the bad field.
 *
 * Destination *identifiers* are checked too, not just kinds: a `slack`
 * destination with no `channelId` saves cleanly and then routes nowhere.
 * Ownership of a real id is a separate check (`foreignDestinationError`)
 * because it needs a database round trip.
 */
function structuralError(rule: unknown): string | null {
  if (!Predicate.isObject(rule)) return "each rule must be an object";
  if (!Predicate.isString(propOf(rule, "name"))) return "name is required";
  const conditions = propOf(rule, "conditions");
  if (conditions !== undefined && !Array.isArray(conditions)) return "conditions must be an array";
  const conditionList: readonly unknown[] = Array.isArray(conditions) ? conditions : [];
  for (const cond of conditionList) {
    const field = propOf(cond, "field");
    if (!Predicate.isObject(cond) || !Predicate.isString(field) || !CONDITION_FIELDS.has(field)) {
      return `Unknown condition field "${String(field ?? "?")}"`;
    }
    if (field === "trigger") {
      const values = propOf(cond, "values");
      if (!Array.isArray(values)) return "A trigger condition needs a values array";
      const valueList: readonly unknown[] = values;
      const bad = valueList.filter((v) => !(Predicate.isString(v) && isAlertTrigger(v)));
      if (bad.length > 0) return `Unknown trigger(s): ${bad.join(", ")}`;
    }
  }
  const destinations = propOf(rule, "destinations");
  if (destinations !== undefined && !Array.isArray(destinations)) {
    return "destinations must be an array";
  }
  const destinationList: readonly unknown[] = Array.isArray(destinations) ? destinations : [];
  for (const dest of destinationList) {
    const err = destinationError(dest, "destination");
    if (err) return err;
  }
  const escalation = propOf(rule, "escalation");
  if (escalation != null) {
    if (!Predicate.isObject(escalation)) return "escalation must be an object";
    const escalationDestinations = propOf(escalation, "destinations");
    if (!Array.isArray(escalationDestinations)) {
      return "escalation destinations must be an array";
    }
    const list: readonly unknown[] = escalationDestinations;
    for (const dest of list) {
      const err = destinationError(dest, "escalation destination");
      if (err) return err;
    }
  }
  return null;
}

/**
 * True once {@link structuralError} passes. What it proves is what the route
 * always proved; the rest (quiet hours, escalation timing, condition values)
 * is `validateAlertRule`'s to refuse.
 */
const isRuleBody = (rule: unknown): rule is RuleBody => structuralError(rule) === null;

function normalizeRule(rule: RuleBody, position: number): SaveAlertRuleInput {
  return {
    ...(rule.id ? { id: rule.id } : {}),
    name: rule.name.trim(),
    enabled: rule.enabled !== false,
    position,
    conditions: rule.conditions ?? [],
    destinations: (rule.destinations ?? []).map(canonicalDestination),
    continueOnMatch: rule.continueOnMatch === true,
    quietHours: rule.quietHours ?? null,
    escalation: rule.escalation
      ? {
          ...rule.escalation,
          destinations: rule.escalation.destinations.map(canonicalDestination),
        }
      : null,
  };
}

const AlertRulesHandlers = HttpApiBuilder.group(AlertRulesApi, "alertRules", (handlers) =>
  handlers
    // The rules plus everything the editor needs to render a destination as
    // a name: bundled, since the editor cannot draw one row without all of it.
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const [{ rules, usingDefaults }, accountRows, catalog] = yield* legacy(() =>
          Promise.all([
            resolveRoutingRules(organizationId),
            db
              .select({
                id: accounts.id,
                displayName: accounts.displayName,
                pluginId: accounts.pluginId,
              })
              .from(accounts)
              .where(eq(accounts.organizationId, organizationId)),
            // Channels, webhooks, rotations, members and the address policy:
            // the same picker data report anomaly alerts use.
            loadDestinationCatalog(organizationId),
          ]),
        );
        const payload: AlertRulesPayload = {
          rules,
          usingDefaults,
          accounts: accountRows,
          ...catalog,
        };
        return yield* respond(AlertRulesResponse)(payload);
      }),
    )
    // Whole-list replacement: the order is part of the meaning, so a reorder
    // as two requests would leave a window in which alerts route somewhere
    // nobody asked for. Destinations must be this org's own: the only thing
    // between this endpoint and using someone else's connection as a target.
    .handleRaw("replace", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const input = (yield* fieldsOf(yield* readJson(request)))["rules"];
        if (!Array.isArray(input)) return yield* badRequest("rules must be an array");
        const rules: readonly unknown[] = input;
        if (rules.length > ALERT_RULE_LIMITS.maxRulesPerOrg) {
          return yield* badRequest(`At most ${ALERT_RULE_LIMITS.maxRulesPerOrg} rules per org`);
        }

        const [owned, ownRules] = yield* legacy(() =>
          Promise.all([loadOwnedDestinations(organizationId), listAlertRules(organizationId)]),
        );
        const ownRuleIds = new Set(ownRules.map((r) => r.id));

        // An id the caller did not get from this org's own list is refused
        // rather than ignored: the org-scoped upsert would drop the rule, and
        // a rule that vanishes on save is worse than an error.
        const unknownId = rules
          .map((r) => propOf(r, "id"))
          .find((id) => {
            if (!id) return false;
            return !Predicate.isString(id) || !ownRuleIds.has(id);
          });
        if (unknownId !== undefined) {
          return yield* badRequest(`Unknown rule id "${String(unknownId)}"`);
        }

        const foreignDestination = (dests: readonly AlertDestination[]) =>
          foreignDestinationError(owned, dests);

        const prepared: SaveAlertRuleInput[] = [];
        for (const [i, rule] of rules.entries()) {
          const structural = structuralError(rule);
          if (structural || !isRuleBody(rule)) {
            return yield* badRequest(`Rule ${i + 1}: ${structural ?? "invalid rule"}`);
          }
          const normalized = normalizeRule(rule, i);
          const semantic = validateAlertRule(normalized);
          if (semantic) return yield* badRequest(`Rule ${i + 1}: ${semantic}`);
          const foreign =
            foreignDestination(normalized.destinations) ??
            foreignDestination(normalized.escalation?.destinations ?? []);
          if (foreign) return yield* badRequest(`Rule ${i + 1}: ${foreign}`);
          prepared.push(normalized);
        }

        const userId = session.userId ?? null;
        const saved = yield* legacy(() => replaceAlertRules(organizationId, userId, prepared));
        yield* legacy(() =>
          logAudit({
            organizationId,
            userId,
            action: "alert_rules.replace",
            entityType: "alert_rules",
            entityId: organizationId,
            metadata: {
              ruleCount: saved.length,
              // The names are what makes an audit entry readable a month
              // later; the full rule bodies would bury it.
              names: saved.map((r: AlertRule) => r.name),
            },
          }),
        );
        return yield* respond(AlertRuleList)({ rules: saved });
      }),
    )
    // "Start from the defaults": persist the synthesized rule so it can be edited.
    .handle("adoptDefaults", () =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const existing = yield* legacy(() => listAlertRules(organizationId));
        if (existing.length > 0) {
          return yield* respond(AdoptDefaultsResult)({ rules: existing, adopted: false });
        }
        const { rules } = yield* legacy(() => resolveRoutingRules(organizationId));
        const saved = yield* legacy(() =>
          replaceAlertRules(
            organizationId,
            session.userId ?? null,
            rules.map((r) => ({
              name: r.name,
              enabled: r.enabled,
              position: r.position,
              conditions: r.conditions,
              destinations: r.destinations,
              continueOnMatch: r.continueOnMatch,
              quietHours: r.quietHours,
              escalation: r.escalation,
            })),
          ),
        );
        return yield* respond(AdoptDefaultsResult)({ rules: saved, adopted: true });
      }),
    )
    // What is held for quiet hours, waiting on an acknowledgement, escalated:
    // the evidence that a rule did what it said.
    .handle("deliveries", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const limit = query.limit ?? 50;
        const rows = yield* legacy(() =>
          listAlertDeliveries(organizationId, Number.isFinite(limit) ? limit : 50),
        );
        return yield* respond(AlertDeliveries)(
          rows.map((r) => ({
            id: r.id,
            trigger: r.trigger,
            severity: r.severity,
            title: payloadText(r.payload, "title"),
            body: payloadText(r.payload, "body"),
            ruleName: r.ruleName,
            state: r.state,
            createdAt: r.createdAt.toISOString(),
            deliverAfter: r.deliverAfter?.toISOString() ?? null,
            escalateAt: r.escalateAt?.toISOString() ?? null,
            acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
            acknowledgedByUserId: r.acknowledgedByUserId,
          })),
        );
      }),
    )
    // From the app: the same conditional UPDATE the Slack button uses.
    .handle("acknowledge", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const userId = session.userId;
        if (!userId) return yield* new Unauthorized({ error: "Sign in to acknowledge" });
        const result = yield* legacy(() =>
          acknowledgeAlert({ deliveryId: params.id, organizationId, userId, via: "web" }),
        );
        if (!result.acknowledged && result.reason === "not_found") {
          return yield* notFound("Alert not found");
        }
        return yield* respond(AcknowledgeResult)(result);
      }),
    )
    // "I have dealt with this, stop the queue."
    .handleRaw("cancel", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const ids = (yield* fieldsOf(yield* readJson(request)))["ids"];
        if (!Array.isArray(ids)) return yield* badRequest("ids must be an array");
        const list: readonly unknown[] = ids;
        const strings = list.filter(Predicate.isString);
        if (strings.length !== list.length) return yield* badRequest("ids must be an array");
        const cancelled = yield* legacy(() => cancelAlertDeliveries(organizationId, strings));
        return yield* respond(CancelResult)({ cancelled });
      }),
    ),
);

export const alertRulesDomain = makeDomain("alert-rules", AlertRulesApi, AlertRulesHandlers);
