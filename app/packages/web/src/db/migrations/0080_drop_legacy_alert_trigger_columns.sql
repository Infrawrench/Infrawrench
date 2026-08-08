-- Contract half of the alert-routing expand/contract split.
--
-- 0079 did the expand: it created `alert_rules` / `alert_deliveries`, backfilled
-- them from the per-channel trigger booleans, and added
-- `push_preferences.muted_triggers`. It deliberately left the 35 legacy columns
-- in place, because Drizzle's `select()` builds a full column list from the
-- schema — so during a rolling deploy every *old* replica still names those
-- columns, and dropping them in the same migration makes every read of
-- `slack_channels`, `msteams_webhooks` and `push_preferences` fail with
-- "column does not exist" until the rollout finishes.
--
-- This migration is the contract half. Apply it only once no running build
-- references the columns below — i.e. after 0079's release is fully rolled out.
-- Nothing reads them by then: the routing decision moved into `alert_rules` and
-- the personal mutes into `muted_triggers`, both backfilled by 0079.

ALTER TABLE "push_preferences" DROP COLUMN "sync_incidents";
--> statement-breakpoint
ALTER TABLE "push_preferences" DROP COLUMN "budget_alerts";
--> statement-breakpoint
ALTER TABLE "push_preferences" DROP COLUMN "anomaly_alerts";
--> statement-breakpoint
ALTER TABLE "push_preferences" DROP COLUMN "metric_alerts";
--> statement-breakpoint
ALTER TABLE "push_preferences" DROP COLUMN "resource_drift";
--> statement-breakpoint
ALTER TABLE "push_preferences" DROP COLUMN "workflow_pages";
--> statement-breakpoint
ALTER TABLE "push_preferences" DROP COLUMN "provider_incidents";
--> statement-breakpoint
ALTER TABLE "push_preferences" DROP COLUMN "expiry_alerts";
--> statement-breakpoint
ALTER TABLE "push_preferences" DROP COLUMN "log_match_alerts";
--> statement-breakpoint
ALTER TABLE "push_preferences" DROP COLUMN "posture_alerts";
--> statement-breakpoint
ALTER TABLE "push_preferences" DROP COLUMN "probe_alerts";

--> statement-breakpoint
ALTER TABLE "slack_channels" DROP COLUMN "sync_incidents";
--> statement-breakpoint
ALTER TABLE "slack_channels" DROP COLUMN "budget_alerts";
--> statement-breakpoint
ALTER TABLE "slack_channels" DROP COLUMN "anomaly_alerts";
--> statement-breakpoint
ALTER TABLE "slack_channels" DROP COLUMN "metric_alerts";
--> statement-breakpoint
ALTER TABLE "slack_channels" DROP COLUMN "resource_drift";
--> statement-breakpoint
ALTER TABLE "slack_channels" DROP COLUMN "workflow_pages";
--> statement-breakpoint
ALTER TABLE "slack_channels" DROP COLUMN "provider_incidents";
--> statement-breakpoint
ALTER TABLE "slack_channels" DROP COLUMN "expiry_alerts";
--> statement-breakpoint
ALTER TABLE "slack_channels" DROP COLUMN "log_match_alerts";
--> statement-breakpoint
ALTER TABLE "slack_channels" DROP COLUMN "posture_alerts";
--> statement-breakpoint
ALTER TABLE "slack_channels" DROP COLUMN "probe_alerts";
--> statement-breakpoint
ALTER TABLE "slack_channels" DROP COLUMN "weekly_digest";

--> statement-breakpoint
ALTER TABLE "msteams_webhooks" DROP COLUMN "sync_incidents";
--> statement-breakpoint
ALTER TABLE "msteams_webhooks" DROP COLUMN "budget_alerts";
--> statement-breakpoint
ALTER TABLE "msteams_webhooks" DROP COLUMN "anomaly_alerts";
--> statement-breakpoint
ALTER TABLE "msteams_webhooks" DROP COLUMN "metric_alerts";
--> statement-breakpoint
ALTER TABLE "msteams_webhooks" DROP COLUMN "resource_drift";
--> statement-breakpoint
ALTER TABLE "msteams_webhooks" DROP COLUMN "workflow_pages";
--> statement-breakpoint
ALTER TABLE "msteams_webhooks" DROP COLUMN "provider_incidents";
--> statement-breakpoint
ALTER TABLE "msteams_webhooks" DROP COLUMN "expiry_alerts";
--> statement-breakpoint
ALTER TABLE "msteams_webhooks" DROP COLUMN "log_match_alerts";
--> statement-breakpoint
ALTER TABLE "msteams_webhooks" DROP COLUMN "posture_alerts";
--> statement-breakpoint
ALTER TABLE "msteams_webhooks" DROP COLUMN "probe_alerts";
--> statement-breakpoint
ALTER TABLE "msteams_webhooks" DROP COLUMN "weekly_digest";
