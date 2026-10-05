CREATE TABLE "cost_canvases" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"spec" jsonb NOT NULL,
	"prompt" text,
	"created_by_user_id" text,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "report_notifications" DROP CONSTRAINT "report_notifications_one_target";--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "cost_canvas_id" text;--> statement-breakpoint
ALTER TABLE "chat_pending_actions" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "report_notifications" ADD COLUMN "cost_canvas_id" text;--> statement-breakpoint
ALTER TABLE "cost_canvases" ADD CONSTRAINT "cost_canvases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_canvases" ADD CONSTRAINT "cost_canvases_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cost_canvases_org_idx" ON "cost_canvases" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_cost_canvas_id_cost_canvases_id_fk" FOREIGN KEY ("cost_canvas_id") REFERENCES "public"."cost_canvases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_notifications" ADD CONSTRAINT "report_notifications_cost_canvas_id_cost_canvases_id_fk" FOREIGN KEY ("cost_canvas_id") REFERENCES "public"."cost_canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_conversations_canvas_idx" ON "chat_conversations" USING btree ("cost_canvas_id");--> statement-breakpoint
CREATE INDEX "report_notifications_canvas_idx" ON "report_notifications" USING btree ("cost_canvas_id");--> statement-breakpoint
ALTER TABLE "report_notifications" ADD CONSTRAINT "report_notifications_one_target" CHECK (num_nonnulls("report_notifications"."cost_report_id", "report_notifications"."dashboard_id", "report_notifications"."cost_canvas_id") = 1);