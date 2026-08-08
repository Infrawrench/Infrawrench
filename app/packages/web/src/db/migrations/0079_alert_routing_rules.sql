-- Alert routing rules.
--
-- Replaces the boolean-per-trigger-per-channel matrix with an ordered rules
-- table. The migration's whole job is that no org's behaviour changes on
-- deploy: every channel's existing opt-ins are translated into rules that route
-- exactly what they routed before.
--
-- Ordering matters below. The rules are generated from the boolean columns, so
-- they must be read here before anything drops them.
--
-- This is the **expand** half of an expand/contract split. The legacy trigger
-- columns are deliberately left in place: Drizzle's `select()` names every
-- column in the schema, so an old replica mid-rollout still asks for them, and
-- dropping them here would break every read of `slack_channels`,
-- `msteams_webhooks` and `push_preferences` until the rollout finished. Drop
-- those 35 columns in a later release only after this expand is fully rolled
-- out — never in the same deploy wave as this migration.

--> statement-breakpoint
CREATE TABLE "alert_rules" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "destinations" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "continue_on_match" boolean DEFAULT false NOT NULL,
  "quiet_hours" jsonb,
  "escalation" jsonb,
  "created_by_user_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "alert_rules_org_position_idx" ON "alert_rules" ("organization_id", "position");

--> statement-breakpoint
CREATE TABLE "alert_deliveries" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "rule_id" text REFERENCES "alert_rules"("id") ON DELETE SET NULL,
  "rule_name" text,
  "trigger" text NOT NULL,
  "severity" text NOT NULL,
  "state" text NOT NULL,
  "payload" jsonb NOT NULL,
  "destinations" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "escalation" jsonb,
  "deliver_after" timestamp,
  "escalate_at" timestamp,
  "acknowledged_at" timestamp,
  "acknowledged_by_user_id" text,
  "acknowledged_via" text,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "alert_deliveries_org_idx" ON "alert_deliveries" ("organization_id", "created_at");
--> statement-breakpoint
CREATE INDEX "alert_deliveries_due_idx" ON "alert_deliveries" ("state", "deliver_after");
--> statement-breakpoint
CREATE INDEX "alert_deliveries_escalate_idx" ON "alert_deliveries" ("state", "escalate_at");

--> statement-breakpoint
-- Translate the existing matrix into rules.
--
-- One rule per (org, distinct opt-in set), not one per channel: orgs typically
-- have a handful of channels with two or three distinct configurations, and a
-- rule per channel would turn "we send budgets to #finance" into a list nobody
-- wants to read. Channels sharing an opt-in set share a rule and appear
-- together in its destination list, which is also how somebody would have
-- written it by hand.
--
-- `continue_on_match` is true on every generated rule. The old matrix had no
-- notion of order — a channel either took a trigger or it did not, and two
-- channels taking the same trigger both got it — so every generated rule must
-- be a tee rather than a first-match-wins branch, or the second rule would
-- stop receiving alerts the first one claimed. First-match-wins is what new,
-- hand-written rules are for.
WITH channel_triggers AS (
  SELECT
    c."organization_id",
    c."id" AS destination_id,
    'slack' AS kind,
    ARRAY(
      SELECT t FROM unnest(ARRAY[
        CASE WHEN c."sync_incidents"     THEN 'syncIncidents'     END,
        CASE WHEN c."budget_alerts"      THEN 'budgetAlerts'      END,
        CASE WHEN c."anomaly_alerts"     THEN 'anomalyAlerts'     END,
        CASE WHEN c."metric_alerts"      THEN 'metricAlerts'      END,
        CASE WHEN c."resource_drift"     THEN 'resourceDrift'     END,
        CASE WHEN c."workflow_pages"     THEN 'workflowPages'     END,
        CASE WHEN c."provider_incidents" THEN 'providerIncidents' END,
        CASE WHEN c."expiry_alerts"      THEN 'expiryAlerts'      END,
        CASE WHEN c."log_match_alerts"   THEN 'logMatchAlerts'    END,
        CASE WHEN c."posture_alerts"     THEN 'postureAlerts'     END,
        CASE WHEN c."probe_alerts"       THEN 'probeAlerts'       END,
        CASE WHEN c."weekly_digest"      THEN 'weeklyDigest'      END
      ]) AS t WHERE t IS NOT NULL
    ) AS triggers
  FROM "slack_channels" c

  UNION ALL

  SELECT
    w."organization_id",
    w."id" AS destination_id,
    'msteams' AS kind,
    ARRAY(
      SELECT t FROM unnest(ARRAY[
        CASE WHEN w."sync_incidents"     THEN 'syncIncidents'     END,
        CASE WHEN w."budget_alerts"      THEN 'budgetAlerts'      END,
        CASE WHEN w."anomaly_alerts"     THEN 'anomalyAlerts'     END,
        CASE WHEN w."metric_alerts"      THEN 'metricAlerts'      END,
        CASE WHEN w."resource_drift"     THEN 'resourceDrift'     END,
        CASE WHEN w."workflow_pages"     THEN 'workflowPages'     END,
        CASE WHEN w."provider_incidents" THEN 'providerIncidents' END,
        CASE WHEN w."expiry_alerts"      THEN 'expiryAlerts'      END,
        CASE WHEN w."log_match_alerts"   THEN 'logMatchAlerts'    END,
        CASE WHEN w."posture_alerts"     THEN 'postureAlerts'     END,
        CASE WHEN w."probe_alerts"       THEN 'probeAlerts'       END,
        CASE WHEN w."weekly_digest"      THEN 'weeklyDigest'      END
      ]) AS t WHERE t IS NOT NULL
    ) AS triggers
  FROM "msteams_webhooks" w
),
-- A channel opted into nothing routed nothing; it must not become a rule with
-- an empty trigger list, which would match *everything*.
grouped AS (
  SELECT
    "organization_id",
    triggers,
    jsonb_agg(
      CASE
        WHEN kind = 'slack' THEN jsonb_build_object('kind', 'slack', 'channelId', destination_id)
        ELSE jsonb_build_object('kind', 'msteams', 'webhookId', destination_id)
      END
      ORDER BY destination_id
    ) AS destinations
  FROM channel_triggers
  WHERE cardinality(triggers) > 0
  GROUP BY "organization_id", triggers
)
INSERT INTO "alert_rules" (
  "id", "organization_id", "name", "enabled", "position",
  "conditions", "destinations", "continue_on_match"
)
SELECT
  gen_random_uuid()::text,
  g."organization_id",
  'Channel alerts ' || row_number() OVER (PARTITION BY g."organization_id" ORDER BY g.triggers),
  true,
  (row_number() OVER (PARTITION BY g."organization_id" ORDER BY g.triggers))::int - 1,
  jsonb_build_array(
    jsonb_build_object('field', 'trigger', 'op', 'in', 'values', to_jsonb(g.triggers))
  ),
  g.destinations,
  true
FROM grouped g;

--> statement-breakpoint
-- Mobile push, for every org that has a channel connected.
--
-- The source is "has a channel", not "got a rule above", and the difference is
-- the org whose channels were all opted out of everything. That org generates
-- no channel rules, so without a row here it would have *no* rules at all —
-- which means the synthesized default, which sends everything everywhere. An
-- org that had deliberately silenced every channel would start being paged by
-- the migration that was supposed to preserve its behaviour.
--
-- An org with no channels at all needs nothing: no rules means the default,
-- and the default is push plus zero channels, which is what it had.
--
-- Every trigger a phone can receive, at the end of the list. Per-member mutes
-- still apply on top; this rule only says the org's phones are in scope.
--
-- The position is derived from the org's own highest channel rule rather than
-- pinned to a constant. A constant would have to be larger than any possible
-- channel-rule count, and "larger than any possible" is exactly the kind of
-- assumption that is true until it is not — the channel rules take positions
-- 0..N-1 from `row_number()`, one per distinct opt-in set. `COALESCE` covers
-- the org that has channels but produced no channel rule.
INSERT INTO "alert_rules" (
  "id", "organization_id", "name", "enabled", "position",
  "conditions", "destinations", "continue_on_match"
)
SELECT
  gen_random_uuid()::text,
  o."organization_id",
  'Mobile push',
  true,
  COALESCE(
    (
      SELECT MAX(r."position") + 1
      FROM "alert_rules" r
      WHERE r."organization_id" = o."organization_id"
    ),
    0
  ),
  jsonb_build_array(
    jsonb_build_object(
      'field', 'trigger', 'op', 'notIn', 'values', jsonb_build_array('weeklyDigest')
    )
  ),
  jsonb_build_array(jsonb_build_object('kind', 'push')),
  true
FROM (
  SELECT "organization_id" FROM "slack_channels"
  UNION
  SELECT "organization_id" FROM "msteams_webhooks"
) o;

--> statement-breakpoint
-- Personal push mutes: eleven booleans become one array of what is turned off.
-- A row with everything on becomes an empty array, which is exactly right —
-- "muted nothing".
ALTER TABLE "push_preferences" ADD COLUMN "muted_triggers" text[] DEFAULT ARRAY[]::text[] NOT NULL;
--> statement-breakpoint
UPDATE "push_preferences" SET "muted_triggers" = ARRAY(
  SELECT t FROM unnest(ARRAY[
    CASE WHEN NOT "sync_incidents"     THEN 'syncIncidents'     END,
    CASE WHEN NOT "budget_alerts"      THEN 'budgetAlerts'      END,
    CASE WHEN NOT "anomaly_alerts"     THEN 'anomalyAlerts'     END,
    CASE WHEN NOT "metric_alerts"      THEN 'metricAlerts'      END,
    CASE WHEN NOT "resource_drift"     THEN 'resourceDrift'     END,
    CASE WHEN NOT "workflow_pages"     THEN 'workflowPages'     END,
    CASE WHEN NOT "provider_incidents" THEN 'providerIncidents' END,
    CASE WHEN NOT "expiry_alerts"      THEN 'expiryAlerts'      END,
    CASE WHEN NOT "log_match_alerts"   THEN 'logMatchAlerts'    END,
    CASE WHEN NOT "posture_alerts"     THEN 'postureAlerts'     END,
    CASE WHEN NOT "probe_alerts"       THEN 'probeAlerts'       END
  ]) AS t WHERE t IS NOT NULL
);
