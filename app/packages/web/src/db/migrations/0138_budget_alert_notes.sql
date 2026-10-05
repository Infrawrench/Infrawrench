ALTER TABLE "budget_alert_events" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "budget_alert_events" ADD COLUMN "noted_at" timestamp;--> statement-breakpoint
ALTER TABLE "budget_alert_events" ADD COLUMN "noted_by_user_id" text;--> statement-breakpoint
ALTER TABLE "budget_alert_events" ADD COLUMN "annotation_id" text;--> statement-breakpoint
ALTER TABLE "budget_alert_events" ADD COLUMN "slack_messages" jsonb;--> statement-breakpoint
ALTER TABLE "budget_alert_events" ADD COLUMN "ms_teams_webhook_ids" jsonb;--> statement-breakpoint
ALTER TABLE "budget_alert_events" ADD CONSTRAINT "budget_alert_events_noted_by_user_id_users_id_fk" FOREIGN KEY ("noted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_alert_events" ADD CONSTRAINT "budget_alert_events_annotation_id_cost_annotations_id_fk" FOREIGN KEY ("annotation_id") REFERENCES "public"."cost_annotations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_alert_events_annotation_unique" ON "budget_alert_events" USING btree ("annotation_id") WHERE annotation_id is not null;