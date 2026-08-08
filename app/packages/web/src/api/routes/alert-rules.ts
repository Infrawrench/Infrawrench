/**
 * Alert routing rules: `/api/org/:orgId/alert-rules` and the delivery queue
 * beside it.
 *
 * Gated on `org:settings:write` throughout, like the Slack, Teams and digest
 * settings it replaced — a routing rule decides who in the org hears about an
 * incident, which is an admin decision rather than a personal one. (Personal
 * mutes live on `/push/preferences` and need no permission at all.)
 */
import { Hono } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import {
  ALERT_RULE_LIMITS,
  isAlertTrigger,
  validateAlertRule,
  type AlertCondition,
  type AlertDestination,
  type AlertRule,
  type AlertRulesResponse,
  type EscalationPolicy,
  type QuietHours,
} from "@infrawrench/client-core";
import {
  listAlertRules,
  replaceAlertRules,
  resolveRoutingRules,
} from "@infrawrench/server-core/alerts/rules";
import {
  acknowledgeAlert,
  cancelAlertDeliveries,
  listAlertDeliveries,
} from "@infrawrench/server-core/alerts/ack";

import { db } from "../../db/client";
import { accounts, msteamsWebhooks, slackChannels, slackInstallations } from "../../db/schema";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";

const app = new Hono();

/**
 * The rules, plus everything the editor needs to render a destination as a
 * name rather than a uuid.
 *
 * Bundled into one response on purpose: the editor cannot draw a single row
 * without all four lists, and three extra round trips on a settings page that
 * is already behind a permission check buys nothing.
 */
app.get("/", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");

  const [{ rules, usingDefaults }, channels, webhooks, accountRows] = await Promise.all([
    resolveRoutingRules(organizationId),
    db
      .select({
        id: slackChannels.id,
        name: slackChannels.channelName,
        isPrivate: slackChannels.isPrivate,
      })
      .from(slackChannels)
      .innerJoin(slackInstallations, eq(slackInstallations.id, slackChannels.installationId))
      // Disconnected installations are filtered out, exactly as
      // `resolveSlackChannels` does at delivery time. Offering a channel the
      // sender can no longer reach would let the editor build a rule that
      // silently routes nowhere.
      .where(
        and(eq(slackChannels.organizationId, organizationId), isNull(slackInstallations.deletedAt)),
      ),
    db
      .select({ id: msteamsWebhooks.id, label: msteamsWebhooks.label })
      .from(msteamsWebhooks)
      .where(eq(msteamsWebhooks.organizationId, organizationId)),
    db
      .select({
        id: accounts.id,
        displayName: accounts.displayName,
        pluginId: accounts.pluginId,
      })
      .from(accounts)
      .where(eq(accounts.organizationId, organizationId)),
  ]);

  const payload: AlertRulesResponse = {
    rules,
    usingDefaults,
    slackChannels: channels,
    msTeamsWebhooks: webhooks,
    accounts: accountRows,
  };
  return c.json(payload);
});

/** Shapes accepted on the wire, before `validateAlertRule` sees them. */
interface RuleBody {
  id?: string;
  name?: string;
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

const DESTINATION_KINDS = new Set(["push", "slack", "msteams"]);

/**
 * Structural check before the semantic one.
 *
 * `validateAlertRule` (shared with the editor) enforces limits and coherence,
 * but it trusts the discriminants and the field types — it is written against
 * typed input. `c.req.json<T>()` validates nothing at runtime, so this request
 * is `unknown` JSON wearing a type, and both halves of that have to be checked
 * here:
 *
 *   * **Tags.** A condition with a bogus `field` would fall through every
 *     `case` in `conditionMatches` and silently never match, which reads to the
 *     user as "the rule I saved does nothing".
 *   * **Shapes.** `{ conditions: [{ field: "trigger" }] }` would throw inside
 *     `values.filter`, and a numeric `name` would throw inside `.trim()` — a
 *     500 where the honest answer is a 400 naming the bad field.
 *
 * Destination *identifiers* are checked here too, not just kinds: a `slack`
 * destination with no `channelId` saves cleanly and then routes nowhere, since
 * `resolveSlackChannels` has nothing to look up. Ownership of a real id is a
 * separate check (`foreignDestination`) because it needs a database round trip.
 */
function destinationError(dest: AlertDestination | null | undefined, what: string): string | null {
  if (!dest || typeof dest !== "object" || !DESTINATION_KINDS.has(dest.kind)) {
    return `Unknown ${what} "${(dest as { kind?: string } | null)?.kind ?? "?"}"`;
  }
  if (dest.kind === "slack" && (typeof dest.channelId !== "string" || !dest.channelId)) {
    return `A Slack ${what} needs a channelId`;
  }
  if (dest.kind === "msteams" && (typeof dest.webhookId !== "string" || !dest.webhookId)) {
    return `A Teams ${what} needs a webhookId`;
  }
  return null;
}

function structuralError(rule: RuleBody): string | null {
  if (!rule || typeof rule !== "object") return "each rule must be an object";
  if (typeof rule.name !== "string") return "name is required";
  if (rule.conditions !== undefined && !Array.isArray(rule.conditions)) {
    return "conditions must be an array";
  }
  for (const cond of rule.conditions ?? []) {
    if (!cond || typeof cond !== "object" || !CONDITION_FIELDS.has(cond.field)) {
      return `Unknown condition field "${(cond as { field?: string } | null)?.field ?? "?"}"`;
    }
    if (cond.field === "trigger") {
      if (!Array.isArray(cond.values)) return "A trigger condition needs a values array";
      const bad = cond.values.filter((v) => !isAlertTrigger(v));
      if (bad.length > 0) return `Unknown trigger(s): ${bad.join(", ")}`;
    }
  }
  if (rule.destinations !== undefined && !Array.isArray(rule.destinations)) {
    return "destinations must be an array";
  }
  for (const dest of rule.destinations ?? []) {
    const err = destinationError(dest, "destination");
    if (err) return err;
  }
  if (rule.escalation != null) {
    if (typeof rule.escalation !== "object") return "escalation must be an object";
    if (!Array.isArray(rule.escalation.destinations)) {
      return "escalation destinations must be an array";
    }
  }
  for (const dest of rule.escalation?.destinations ?? []) {
    const err = destinationError(dest, "escalation destination");
    if (err) return err;
  }
  return null;
}

/**
 * Replace the whole rule list.
 *
 * Whole-list rather than per-rule because the order is part of the meaning: a
 * rule is only correct relative to the ones above it, so applying a reorder as
 * two independent PATCHes would leave a window in which alerts route somewhere
 * nobody asked for. One request, one transaction, no window.
 *
 * Destinations are checked against the org's own channels — a rule may not name
 * a Slack channel or Teams webhook belonging to another org, which is the only
 * thing standing between this endpoint and using someone else's connection as a
 * send target.
 */
app.put("/", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const body = await c.req.json<{ rules?: RuleBody[] }>();

  const input = body.rules;
  if (!Array.isArray(input)) return c.json({ error: "rules must be an array" }, 400);
  if (input.length > ALERT_RULE_LIMITS.maxRulesPerOrg) {
    return c.json({ error: `At most ${ALERT_RULE_LIMITS.maxRulesPerOrg} rules per org` }, 400);
  }

  const [ownChannels, ownWebhooks, ownRules] = await Promise.all([
    // Live installations only, matching the GET list and `resolveSlackChannels`.
    // A channel whose install was disconnected is still a row in this org's
    // table, so ownership alone would accept it — and it would then be dropped
    // at delivery time, turning a first-match rule into silence.
    db
      .select({ id: slackChannels.id })
      .from(slackChannels)
      .innerJoin(slackInstallations, eq(slackInstallations.id, slackChannels.installationId))
      .where(
        and(eq(slackChannels.organizationId, organizationId), isNull(slackInstallations.deletedAt)),
      ),
    db
      .select({ id: msteamsWebhooks.id })
      .from(msteamsWebhooks)
      .where(eq(msteamsWebhooks.organizationId, organizationId)),
    listAlertRules(organizationId),
  ]);
  const channelIds = new Set(ownChannels.map((r) => r.id));
  const webhookIds = new Set(ownWebhooks.map((r) => r.id));
  const ownRuleIds = new Set(ownRules.map((r) => r.id));

  // An id the caller did not get from this org's own list is rejected rather
  // than silently ignored. The writer's upsert is org-scoped so it could not
  // have overwritten anything, but it would have dropped the rule instead of
  // saving it — and a rule that vanishes on save is worse than an error.
  const unknownId = input.find((r) => r.id && !ownRuleIds.has(r.id));
  if (unknownId) {
    return c.json({ error: `Unknown rule id "${unknownId.id}"` }, 400);
  }

  function foreignDestination(dests: AlertDestination[]): string | null {
    for (const d of dests) {
      if (d.kind === "slack" && !channelIds.has(d.channelId)) {
        return "That Slack channel is not connected to this organization";
      }
      if (d.kind === "msteams" && !webhookIds.has(d.webhookId)) {
        return "That Teams channel is not connected to this organization";
      }
    }
    return null;
  }

  const prepared = [];
  for (const [i, rule] of input.entries()) {
    const structural = structuralError(rule);
    if (structural) return c.json({ error: `Rule ${i + 1}: ${structural}` }, 400);

    const normalized = {
      ...(rule.id ? { id: rule.id } : {}),
      name: String(rule.name).trim(),
      enabled: rule.enabled !== false,
      position: i,
      conditions: rule.conditions ?? [],
      destinations: rule.destinations ?? [],
      continueOnMatch: rule.continueOnMatch === true,
      quietHours: rule.quietHours ?? null,
      escalation: rule.escalation ?? null,
    };

    const semantic = validateAlertRule(normalized);
    if (semantic) return c.json({ error: `Rule ${i + 1}: ${semantic}` }, 400);

    const foreign =
      foreignDestination(normalized.destinations) ??
      foreignDestination(normalized.escalation?.destinations ?? []);
    if (foreign) return c.json({ error: `Rule ${i + 1}: ${foreign}` }, 400);

    prepared.push(normalized);
  }

  const saved = await replaceAlertRules(organizationId, session?.userId ?? null, prepared);

  await logAudit({
    organizationId,
    userId: session?.userId ?? null,
    action: "alert_rules.replace",
    entityType: "alert_rules",
    entityId: organizationId,
    metadata: {
      ruleCount: saved.length,
      // The names are what makes an audit entry readable a month later; the
      // full rule bodies would bury it.
      names: saved.map((r: AlertRule) => r.name),
    },
  });

  return c.json({ rules: saved });
});

/**
 * "Start from the defaults" — persist the synthesized default rule so it can be
 * edited. A no-op if the org already has rules.
 */
app.post("/adopt-defaults", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const existing = await listAlertRules(organizationId);
  if (existing.length > 0) return c.json({ rules: existing, adopted: false });

  const { rules } = await resolveRoutingRules(organizationId);
  const saved = await replaceAlertRules(
    organizationId,
    session?.userId ?? null,
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
  );
  return c.json({ rules: saved, adopted: true });
});

/* ---------------------------- Delivery queue ---------------------------- */

/**
 * Recent deliveries: what is held for quiet hours, what is waiting on an
 * acknowledgement, what escalated. The evidence that a rule did what it said.
 */
app.get("/deliveries", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const limit = Number(c.req.query("limit") ?? 50);
  const rows = await listAlertDeliveries(organizationId, Number.isFinite(limit) ? limit : 50);
  return c.json(
    rows.map((r) => {
      const payload = r.payload as { title?: string; body?: string } | null;
      return {
        id: r.id,
        trigger: r.trigger,
        severity: r.severity,
        title: payload?.title ?? "",
        body: payload?.body ?? "",
        ruleName: r.ruleName,
        state: r.state,
        createdAt: r.createdAt.toISOString(),
        deliverAfter: r.deliverAfter?.toISOString() ?? null,
        escalateAt: r.escalateAt?.toISOString() ?? null,
        acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
        acknowledgedByUserId: r.acknowledgedByUserId,
      };
    }),
  );
});

/** Acknowledge from the app, the same conditional UPDATE the Slack button uses. */
app.post("/deliveries/:id/ack", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  if (!session?.userId) return c.json({ error: "Sign in to acknowledge" }, 401);

  const result = await acknowledgeAlert({
    deliveryId: c.req.param("id"),
    organizationId,
    userId: session.userId,
    via: "web",
  });
  if (!result.acknowledged && result.reason === "not_found") {
    return c.json({ error: "Alert not found" }, 404);
  }
  return c.json(result);
});

/** Drop held or awaiting-ack rows — "I have dealt with this, stop the queue". */
app.post("/deliveries/cancel", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const body = await c.req.json<{ ids?: string[] }>();
  if (!Array.isArray(body.ids)) return c.json({ error: "ids must be an array" }, 400);
  const cancelled = await cancelAlertDeliveries(organizationId, body.ids);
  return c.json({ cancelled });
});

export default app;
